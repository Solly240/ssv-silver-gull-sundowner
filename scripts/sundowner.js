/**
 * SSV Silver Gull — Sundowner Net : Foundry wiring.
 *
 * All UI, all market maths and every payout table live in sundowner-render.js
 * (globalThis.SSVSUN); this file only does Foundry: settings, the ctx contract,
 * dialogs, the socket, and the GM-side handlers.
 *
 * Two rules run through everything here:
 *
 *  1. PLAYERS NEVER WRITE. Every mutation is emitted to the active GM, who
 *     re-derives it from live state and commits it through one promise chain.
 *  2. THE MODEL IS NOT PUBLIC. World settings replicate to every client, and
 *     Foundry sends every world document to every client regardless of
 *     ownership — a GM-only journal entry is not a secret. The latent market
 *     state, the event schedule and every unsettled bet therefore live in a
 *     `client`-scope setting (localStorage, which never leaves the GM's
 *     browser), backed up to an encrypted blob so a cleared cache is
 *     recoverable. Only `publish()` output is ever written to a world setting.
 */
const MODULE_ID = "ssv-silver-gull-sundowner";
const SOCKET = `module.${MODULE_ID}`;
const SHOP_ID = "ssv-silver-gull-shop";
const POLITICS_ID = "ssv-silver-gull-politics";

const SET_STATE = "state";
const SET_WIRE = "wire";
const SET_LEDGER = "ledger";
const SET_CONFIG = "config";
const SET_SECRET = "secret";          // client scope — the GM's browser only
const SET_VAULT = "secretVault";      // world scope — ciphertext only
const SET_PASS = "vaultPass";         // client scope — never written anywhere else
const SET_BANDS = "bands";            // client scope — what *I* have read
const SET_TESTMOD = "testMod";        // client scope — the GM's pretend ability modifier

const S = () => globalThis.SSVSUN;
const D2 = () => foundry.applications?.api?.DialogV2;
const isActiveGM = () =>
  game.user.isGM && (game.users?.activeGM?.id ?? game.user.id) === game.user.id;
const anyGM = () => !!game.users?.activeGM || game.user.isGM;

let CONTENT = null;
let _root = null;
let _crashTimer = null;
let _tickTimer = null;

/* ------------------------------------------------------------- content */
async function loadContent() {
  if (CONTENT) return CONTENT;
  const res = await fetch(`modules/${MODULE_ID}/data/sundowner-content.json`);
  CONTENT = await res.json();
  return CONTENT;
}

/* ------------------------------------------------------------ settings */
// Re-normalising on every read costs real time when the exchange redraws, and
// the stored value can only change through a settings write, which always fires
// onChange. So cache, and clear it there.
let _cState = null, _cWire = null, _cLedger = null, _cConfig = null;
function invalidate() { _cState = _cWire = _cLedger = _cConfig = null; }

const DEFAULT_CONFIG = {
  netOpen: true,
  tradesPerDay: 5,
  gamblesPerDay: 10,
  buyCpPer100: 1000,
  sellCpPer100: 980,
  driveShopRestock: true,
  playerAccess: true,
  burnInDays: 90,
};

const getState = () => (_cState ??= normalizeState(game.settings.get(MODULE_ID, SET_STATE)));
const getWire = () => (_cWire ??= normalizeWire(game.settings.get(MODULE_ID, SET_WIRE)));
const getLedger = () => (_cLedger ??= normalizeLedger(game.settings.get(MODULE_ID, SET_LEDGER)));
const getConfig = () => (_cConfig ??= ({ ...DEFAULT_CONFIG, ...(game.settings.get(MODULE_ID, SET_CONFIG) || {}) }));

// Merge stored data onto defaults so a new field never needs a world reset.
function normalizeState(stored) {
  const s = stored || {};
  return {
    v: 1, day: s.day || 0,
    market: s.market || { day: 0, listings: [], indices: {}, standingKnown: false, ipoQueue: [] },
    dead: s.dead || [],
    gmLog: s.gmLog || [],
    started: !!s.started,
  };
}
function normalizeWire(stored) {
  const w = stored || {};
  return { v: 1, items: w.items || [], sources: w.sources || {} };
}
function normalizeLedger(stored) {
  const l = stored || {};
  const users = {};
  for (const [uid, u] of Object.entries(l.users || {})) {
    users[uid] = {
      ob: 0, pos: {}, orders: [], day: -1, trades: 0, gambles: 0,
      insightDay: -1, heat: 0, log: [], cashedOutToday: 0, ...u,
    };
  }
  return { v: 1, users, house: { feesOb: 0, edgeOb: 0, ...(l.house || {}) }, settled: l.settled || {} };
}
function userRec(led, uid) {
  return (led.users[uid] ||= {
    ob: 0, pos: {}, orders: [], day: -1, trades: 0, gambles: 0,
    insightDay: -1, heat: 0, log: [], cashedOutToday: 0,
  });
}
/** Counters carry the day they belong to, so a missed reset can never hand out
 *  free actions and the day-advance does not have to walk every user. */
function rollDay(u, day) {
  if (u.day !== day) { u.day = day; u.trades = 0; u.gambles = 0; u.cashedOutToday = 0; }
  return u;
}

async function writeState(patch) {
  if (!game.user.isGM) return;
  await game.settings.set(MODULE_ID, SET_STATE, { ...getState(), ...patch });
}
async function writeWire(patch) {
  if (!game.user.isGM) return;
  await game.settings.set(MODULE_ID, SET_WIRE, { ...getWire(), ...patch });
}
async function writeLedger(led) {
  if (!game.user.isGM) return;
  await game.settings.set(MODULE_ID, SET_LEDGER, led);
}
async function setConfig(patch) {
  if (!game.user.isGM) return;
  await game.settings.set(MODULE_ID, SET_CONFIG, { ...getConfig(), ...patch });
}

/* ================================================================ SECRET */
/**
 * The hidden half of the world. `client` scope is the only genuine per-browser
 * boundary Foundry offers — it is localStorage, so it never reaches the server
 * and therefore never reaches another player. Everything here would ruin the
 * game if a player could read it.
 */
const getSecret = () => game.settings.get(MODULE_ID, SET_SECRET) || {};
const setSecret = (v) => game.settings.set(MODULE_ID, SET_SECRET, v);

const canEncrypt = () => !!(globalThis.isSecureContext && globalThis.crypto?.subtle);

async function deriveKey(pass, salt) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Back the secret up as ciphertext in a world setting. The blob replicates to
 *  everyone; without the passphrase it is noise, and the passphrase lives only
 *  in the GM's own localStorage. */
async function vaultSave() {
  if (!isActiveGM() || !canEncrypt()) return;
  const pass = game.settings.get(MODULE_ID, SET_PASS);
  if (!pass) return;
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
      new TextEncoder().encode(JSON.stringify(getSecret())));
    await game.settings.set(MODULE_ID, SET_VAULT,
      { salt: b64(salt), iv: b64(iv), ct: b64(ct), at: Date.now() });
  } catch (e) { console.warn(`${MODULE_ID} | could not seal the vault`, e); }
}
async function vaultLoad(pass) {
  const v = game.settings.get(MODULE_ID, SET_VAULT);
  if (!v?.ct) throw new Error("There is nothing in the vault yet.");
  if (!canEncrypt()) throw new Error("This connection is not secure enough to open the vault.");
  const key = await deriveKey(pass, unb64(v.salt));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(v.iv) }, key, unb64(v.ct));
  const obj = JSON.parse(new TextDecoder().decode(pt));
  await setSecret(obj);
  await game.settings.set(MODULE_ID, SET_PASS, pass);
  return obj;
}

/* ---------------------------------------------------------- randomness */
/** Real randomness for anything a player must not be able to predict. Note the
 *  deliberate split: the MARKET is seeded (so the GM can preview a day and
 *  re-roll it), but every BET is drawn here, at the moment it is validated. */
function rand() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 4294967296;
}
const randInt = (n) => Math.floor(rand() * n) % n;
const newId = () => `${Date.now().toString(36)}${randInt(1e6).toString(36)}`;

/* ------------------------------------------------------------- standing */
function partyStanding() {
  try {
    const api = game.modules.get(POLITICS_ID)?.api;
    if (!api?.getData) return null;
    const d = api.getData() || {};
    const out = {};
    for (const k of Object.keys(d)) out[k] = Number(d[k]?.standing) || 0;
    return out;
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------- money */
const myActor = () => game.user.character || canvas?.tokens?.controlled?.[0]?.actor || null;
function actorFor(uid) {
  const u = game.users.get(uid);
  return u?.character || null;
}
const purseOf = (actor) => ({ pp: 0, gp: 0, ep: 0, sp: 0, cp: 0, ...(actor?.system?.currency || {}) });

/* ---------------------------------------------------------------- panel */
function ensureRoot() {
  if (_root?.isConnected) return _root;
  _root = document.createElement("div");
  _root.id = "ssvsun-panel";
  _root.style.display = "none";
  document.body.appendChild(_root);
  return _root;
}
const isOpen = () => _root?.isConnected && _root.style.display !== "none";

function openNet() {
  const root = ensureRoot();
  root.style.display = "";
  draw();
}
function closeNet() {
  if (_root) _root.style.display = "none";
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

let _queued = false;
function refresh() {
  if (_queued || !isOpen()) return;
  _queued = true;
  queueMicrotask(() => { _queued = false; if (isOpen()) draw(); });
}

/** Ability modifiers for the games, so the panel can quote honest odds. */
const testMod = () => {
  const v = Number(game.settings.get(MODULE_ID, SET_TESTMOD));
  return Number.isFinite(v) ? v : null;
};
/** A GM testing without a character rolls against a pretend modifier instead. */
const gmTestMod = () => (game.user.isGM && !myActor() ? testMod() : null);

function myMods() {
  const a = myActor();
  const out = {};
  if (!a) {
    const t = gmTestMod();
    if (t != null) for (const ab of ["int", "wis", "cha", "dex", "str", "con"]) out[ab] = t;
    return out;
  }
  const SKILL_FOR = { int: "inv", wis: "prc", cha: "dec", dex: "slt" };
  for (const abil of ["int", "wis", "cha", "dex", "str", "con"]) {
    const mod = Number(a.system?.abilities?.[abil]?.mod);
    const sk = Number(a.system?.skills?.[SKILL_FOR[abil]]?.total);
    out[abil] = Number.isFinite(sk) ? sk : (Number.isFinite(mod) ? mod : null);
  }
  return out;
}

function draw() {
  const st = getState();
  const cfg = getConfig();
  const led = getLedger();
  const uid = game.user.id;
  const me = rollDay({ ...userRec(structuredClone(led), uid) }, st.day);
  S().renderPanel(ensureRoot(), {
    isGM: game.user.isGM,
    userId: uid,
    day: st.day,
    netOpen: !!cfg.netOpen,
    cfg,
    market: st.market,
    dead: st.dead,
    wire: { ...getWire(), bands: game.settings.get(MODULE_ID, SET_BANDS) || {} },
    me,
    mods: myMods(),
    purseCp: S().toCp(purseOf(myActor())),
    purseLabel: myActor()?.name || "no character assigned",
    users: game.users.filter((u) => u.active || !u.isGM).map((u) => ({ id: u.id, name: u.name })),
    fightCard: st.fightCard || null,
    testMod: testMod(),
    actions: ACTIONS,
  });
}

/* --------------------------------------------------------------- socket */
function emit(msg, recipients) {
  if (recipients) game.socket.emit(SOCKET, msg, { recipients });
  else game.socket.emit(SOCKET, msg);
}
function notify(uid, text, kind = "warn") {
  if (uid === game.user.id) return ui.notifications?.[kind]?.(text);
  emit({ type: "notify", text, kind }, [uid]);
}
function ask(msg) {
  // The GM does not round-trip through the socket to talk to itself.
  const payload = { ...msg, userId: game.user.id };
  if (isActiveGM()) return tx(() => handle(payload));
  if (!anyGM()) return ui.notifications?.warn?.("The Net cannot find a node — nobody is holding the other end.");
  emit(payload);
}

function onSocket(msg, senderId) {
  if (!msg || typeof msg !== "object") return;
  // The second argument is the SERVER's view of who sent this, and it cannot be
  // spoofed. Since this module moves money on player-submitted dice, we use it
  // rather than trusting the id in the payload.
  if (senderId && msg.userId && senderId !== msg.userId) {
    return console.warn(`${MODULE_ID} | dropped a message claiming to be from someone else`, msg);
  }
  if (senderId) msg.userId = senderId;
  if (msg.type === "notify") return ui.notifications?.[msg.kind || "warn"]?.(msg.text);
  if (msg.type === "refresh") return refresh();
  if (msg.type === "live") { S()._live = msg.live; return refresh(); }
  if (msg.type === "band") return storeBand(msg.rid, msg.band);
  if (msg.type === "crashOpen") return clientCrashOpen(msg);
  if (msg.type === "crashBlown") return clientCrashBlown(msg);
  if (!isActiveGM()) return;
  return tx(() => handle(msg));
}

/* ================================================================ GM side */
// Foundry has no transactions, so every mutation runs through one promise chain
// on the active GM's client. Without it two players buying the last of a thin
// listing both read the same price and both succeed.
let _txChain = Promise.resolve();
const tx = (fn) => (_txChain = _txChain.then(fn, fn).catch((e) =>
  console.error(`${MODULE_ID} | transaction failed`, e)));

function logLine(u, day, text, ob) {
  u.log = (u.log || []).concat([{ day, text, ob, ts: Date.now() }]).slice(-50);
}
function chat(text, alias, rolls) {
  return ChatMessage.create({
    speaker: { alias: alias || "Sundowner Net" },
    content: `<div style="font-family:'Courier New',monospace;font-size:12px">${text}</div>`,
    rolls: rolls || undefined,
  });
}

/** Heat, in one place, so the UI and the validator can never disagree. */
async function addHeat(led, uid, amount, reason) {
  const u = userRec(led, uid);
  const before = S().heatTier(u.heat).label;
  u.heat = Math.max(0, Math.min(100, (u.heat || 0) + amount));
  const after = S().heatTier(u.heat).label;
  if (after !== before && amount > 0) {
    notify(uid, `The house has re-rated you: ${after}.`, "warn");
    chat(`<b>${game.users.get(uid)?.name || "Someone"}</b> is now <b>${after}</b> on the Net. ` +
         `<i>${reason || ""}</i>`, "The Cage");
  }
}

/* ------------------------------------------------------- roll plumbing */
const SKILL_FOR = { int: "inv", wis: "prc", cha: "dec", dex: "slt" };

async function promptNumber(label) {
  const content = `<p>${label}</p><input type="number" name="v" style="width:100%" autofocus>`;
  const V = D2();
  if (V) {
    return V.prompt({
      window: { title: "Sundowner Net" }, content,
      ok: { label: "Send", callback: (_e, b) => Number(b.form.elements.v.value) },
    }).catch(() => null);
  }
  return new Promise((res) => new Dialog({
    title: "Sundowner Net", content,
    buttons: { ok: { label: "Send", callback: (h) => res(Number(h[0].querySelector("[name=v]").value)) } },
    close: () => res(null),
  }).render(true));
}

/**
 * The player rolls their own dice so Dice So Nice fires and the table sees it;
 * the GM checks the arithmetic afterwards. Deliberately NOT rolled GM-side —
 * that would eat the animation, which is the whole reason the player rolls.
 */
async function rollCheck(abil, label) {
  const actor = myActor();
  const skillKey = SKILL_FOR[abil];
  let total = null, nat = null, roll = null;
  if (actor) {
    const sk = Number(actor.system?.skills?.[skillKey]?.total);
    const mod = Number(actor.system?.abilities?.[abil]?.mod);
    const bonus = Number.isFinite(sk) ? sk : (Number.isFinite(mod) ? mod : 0);
    try {
      roll = await (new Roll(`1d20 + ${bonus}`)).evaluate();
      total = roll.total;
      const dice = roll.dice?.[0]?.results || [];
      nat = (dice.find((r) => r.active) ?? dice[0])?.result ?? null;
      await chat(`<b>${label}</b> — ${abil.toUpperCase()} check: <b>${total}</b>`, actor.name, [roll]);
    } catch (e) { roll = null; total = null; }
  }
  if (total == null) {
    const t = gmTestMod();
    if (t != null) {
      const roll = await (new Roll(`1d20 + ${t}`)).evaluate();
      total = roll.total;
      const dice = roll.dice?.[0]?.results || [];
      nat = (dice.find((r) => r.active) ?? dice[0])?.result ?? null;
      await chat(`<b>${label}</b> — test roll at ${t >= 0 ? "+" : ""}${t}: <b>${total}</b>`,
                 "GM (testing)", [roll]);
    } else {
      const v = await promptNumber(`${label} — no character sheet to roll from. Enter your total:`);
      if (!Number.isFinite(v)) return null;
      total = Math.round(v);
    }
  }
  return { total, nat };
}

/** The player is trusted for the die, never for the arithmetic. */
function checkBounds(actor, abil, total) {
  if (!actor) return { ok: true, bonus: 0, unverified: true };
  const sk = Number(actor.system?.skills?.[SKILL_FOR[abil]]?.total);
  const mod = Number(actor.system?.abilities?.[abil]?.mod);
  const bonus = Number.isFinite(sk) ? sk : (Number.isFinite(mod) ? mod : 0);
  const SLACK = 12;    // Guidance, Bless, Bardic, items — things we cannot see
  if (!Number.isInteger(total) || total < 1 + bonus - SLACK || total > 20 + bonus + SLACK) {
    return { ok: false, bonus };
  }
  return { ok: true, bonus };
}

function rejectRoll(uid, total, bonus) {
  const name = game.users.get(uid)?.name || "A player";
  // Whispered, not announced: nine times in ten this is a Guidance the module
  // could not see, and a public accusation over a die roll is a bad trade.
  ChatMessage.create({
    whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
    speaker: { alias: "Sundowner Net" },
    content: `<b>${name}</b> submitted a total of <b>${total}</b>, which is outside the ` +
      `range their sheet allows (bonus ${bonus >= 0 ? "+" : ""}${bonus}, +/-12 slack). ` +
      `The bet was refused and nothing was taken. Usually this is a bonus the module cannot see.`,
  });
  notify(uid, "The house could not reconcile that roll. Nothing was taken — try again, or ask the GM.", "warn");
}

/* ------------------------------------------------------- live bet state */
function liveOf(uid) { return (getSecret().bets || {})[uid] || null; }
async function setLive(uid, live) {
  const sec = getSecret();
  sec.bets = sec.bets || {};
  if (live) sec.bets[uid] = live; else delete sec.bets[uid];
  await setSecret(sec);
  // The client only ever receives what it may see.
  const pub = live ? { ...live } : null;
  if (pub) { delete pub.crashAt; delete pub.secret; }
  if (uid === game.user.id) { S()._live = pub; refresh(); }
  else emit({ type: "live", live: pub }, [uid]);
}

/* ------------------------------------------------------------ handlers */
async function handle(msg) {
  const uid = msg.userId;
  const cfg = getConfig();
  if (!cfg.netOpen && !game.users.get(uid)?.isGM) return notify(uid, "The Net is down.");
  switch (msg.type) {
    case "buyIn": return gmBuyIn(uid, msg);
    case "cashOut": return gmCashOut(uid, msg);
    case "trade": return gmTrade(uid, msg);
    case "order": return gmOrder(uid, msg);
    case "cancelOrder": return gmCancelOrder(uid, msg);
    case "play": return gmPlay(uid, msg);
    case "read": return gmRead(uid, msg);
    case "gm": return gmTool(uid, msg);
  }
}

/* --------------------------------------------------------------- wallet */
async function gmBuyIn(uid, msg) {
  const cfg = getConfig(), st = getState(), led = getLedger();
  const u = rollDay(userRec(led, uid), st.day);
  const n = Math.max(0, Math.round(msg.obols || 0));
  if (n < S().OBOL.minLot) return notify(uid, `The house does not deal below ${S().OBOL.minLot} ØB.`);
  const actor = actorFor(uid);
  if (!actor) {
    return notify(uid, game.users.get(uid)?.isGM
      ? "No character assigned. Use the wallet cog to pay yourself Obols for testing."
      : "You have no character assigned, so there is no purse to draw on.");
  }
  const cp = S().cpForObols(n, cfg);
  const next = S().spendCp(purseOf(actor), cp);
  if (!next) return notify(uid, `That is ${S().fmtCp(cp)} and you do not have it.`);
  await actor.update({ "system.currency": next });
  u.ob = (u.ob || 0) + n;
  logLine(u, st.day, `Bought in with ${S().fmtCp(cp)}`, n);
  await writeLedger(led);
  chat(`<b>${actor.name}</b> converts ${S().fmtCp(cp)} into <b>${n.toLocaleString()} ØB</b>.`, "The Cage");
  broadcastRefresh();
}

async function gmCashOut(uid, msg) {
  const cfg = getConfig(), st = getState(), led = getLedger();
  const u = rollDay(userRec(led, uid), st.day);
  const lim = S().heatLimits(u.heat);
  const n = Math.max(0, Math.round(msg.obols || 0));
  if (lim.walletFrozen) return notify(uid, "Your account is frozen. This is no longer a financial conversation.");
  if (n < S().OBOL.minLot) return notify(uid, `The house does not deal below ${S().OBOL.minLot} ØB.`);
  if (n > (u.ob || 0)) return notify(uid, "You do not have that on deposit.");
  if ((u.cashedOutToday || 0) + n > lim.maxCashOutOb) {
    return notify(uid, `While you are ${S().heatTier(u.heat).label}, the house will only let ` +
      `${lim.maxCashOutOb.toLocaleString()} ØB a day out of the door.`);
  }
  const actor = actorFor(uid);
  if (!actor) return notify(uid, "You have no character assigned, so there is nowhere to put it.");
  const cp = S().cashOutCp(n, u.heat, cfg);
  await actor.update({ "system.currency": S().gainCp(purseOf(actor), cp) });
  u.ob -= n;
  u.cashedOutToday = (u.cashedOutToday || 0) + n;
  logLine(u, st.day, `Withdrew ${S().fmtCp(cp)}`, -n);
  if (n >= 5000) await addHeat(led, uid, S().HEAT_EVENTS.bigCashOut, "moved a lot of money out at once");
  await writeLedger(led);
  chat(`<b>${actor.name}</b> takes <b>${n.toLocaleString()} ØB</b> off the Net for ${S().fmtCp(cp)}.`, "The Cage");
  broadcastRefresh();
}

/* -------------------------------------------------------------- trading */
function listingById(id) { return (getState().market.listings || []).find((l) => l.id === id) || null; }

async function commitPriceImpact(id, q) {
  const st = getState();
  const market = structuredClone(st.market);
  const l = (market.listings || []).find((x) => x.id === id);
  if (!l) return;
  l.price = S().applyImpact(l, q);
  const h = l.hist || [];
  h[h.length - 1] = l.price;
  l.hist = h;
  await writeState({ market });
}

async function gmTrade(uid, msg) {
  const cfg = getConfig(), st = getState(), led = getLedger();
  const u = rollDay(userRec(led, uid), st.day);
  const l = listingById(msg.id);
  if (!l) return notify(uid, "That listing is not on the board any more.");
  const qty = Math.max(1, Math.round(msg.qty || 0));
  if ((u.trades || 0) >= cfg.tradesPerDay) return notify(uid, "You are out of trades for today.");
  const q = S().quote(l, msg.side, qty, cfg);
  // Re-derived from the LIVE listing, so two players cannot both get the price
  // that existed before the first of them moved it.
  if (msg.quoteOb != null && Math.abs(msg.quoteOb - q.netOb) > Math.max(1, q.netOb * 0.001)) {
    return notify(uid, "The book moved — reopen the terminal and look again.");
  }
  if (msg.side === "buy") {
    if (q.netOb > (u.ob || 0)) return notify(uid, "You do not have the Obols for that.");
    u.ob -= q.netOb;
    u.pos[l.id] = S().applyBuy(u.pos[l.id], qty, q.netOb);
    logLine(u, st.day, `Bought ${qty.toLocaleString()} ${l.ticker} at ${q.unitOb}`, -q.netOb);
  } else {
    const res = S().applySell(u.pos[l.id], qty, q.netOb);
    if (!res) return notify(uid, "You do not hold that many.");
    u.pos[l.id] = res.pos;
    u.ob = (u.ob || 0) + q.netOb;
    logLine(u, st.day, `Sold ${qty.toLocaleString()} ${l.ticker} at ${q.unitOb} ` +
      `(${res.realisedOb >= 0 ? "+" : ""}${res.realisedOb})`, q.netOb);
  }
  u.trades = (u.trades || 0) + 1;
  led.house.feesOb = (led.house.feesOb || 0) + q.feeOb;
  await insiderCheck(led, uid, l, st);
  await writeLedger(led);
  await commitPriceImpact(l.id, q);
  chat(`<b>${game.users.get(uid)?.name}</b> ${msg.side === "buy" ? "buys" : "sells"} ` +
    `<b>${qty.toLocaleString()} ${l.ticker}</b> at ${q.unitOb.toLocaleString()} ØB` +
    `${q.slipPct >= 0.5 ? ` <i>(slippage ${q.slipPct}%)</i>` : ""}.`, "The Exchange");
  broadcastRefresh();
}

/** Trading a name a day before something moves it is exactly what the house
 *  watches for. Reading the wire too well is its own risk, which is the point. */
async function insiderCheck(led, uid, listing, st) {
  const sec = getSecret();
  const sched = sec.latent?.sched || [];
  const soon = sched.find((e) => (e.targets || []).includes(listing.id) && e.day - st.day <= 1 && e.mag >= 0.15);
  if (soon) await addHeat(led, uid, S().HEAT_EVENTS.insiderTiming, "traded a name the day before it moved");
}

async function gmOrder(uid, msg) {
  const st = getState(), led = getLedger();
  const u = rollDay(userRec(led, uid), st.day);
  const l = listingById(msg.id);
  if (!l) return notify(uid, "That listing is not on the board.");
  const qty = Math.max(1, Math.round(msg.qty || 0));
  const priceOb = Math.max(1, Math.round(msg.priceOb || 0));
  if ((u.orders || []).length >= 6) return notify(uid, "You have too many orders resting already.");
  if (msg.side === "buy") {
    // Escrow, or a resting order and a live trade could spend the same Obols.
    const need = priceOb * qty;
    if (need > (u.ob || 0)) return notify(uid, "You cannot cover that order.");
    u.ob -= need;
    u.orders.push({ oid: newId(), id: l.id, side: "buy", kind: msg.kind, priceOb, qty, escrowOb: need, day: st.day });
  } else {
    const held = u.pos[l.id]?.qty || 0;
    const reserved = (u.orders || []).filter((o) => o.id === l.id && o.side === "sell")
      .reduce((a, o) => a + o.qty, 0);
    if (qty > held - reserved) return notify(uid, "You do not have that many free to sell.");
    u.orders.push({ oid: newId(), id: l.id, side: "sell", kind: msg.kind, priceOb, qty, day: st.day });
  }
  logLine(u, st.day, `Rested a ${msg.kind} ${msg.side} on ${l.ticker} at ${priceOb}`, 0);
  await writeLedger(led);
  notify(uid, "Order resting. It is checked when the day turns.", "info");
  broadcastRefresh();
}

async function gmCancelOrder(uid, msg) {
  const led = getLedger();
  const u = userRec(led, uid);
  const i = (u.orders || []).findIndex((o) => o.oid === msg.oid);
  if (i < 0) return;
  const o = u.orders[i];
  if (o.side === "buy") u.ob = (u.ob || 0) + (o.escrowOb || 0);
  u.orders.splice(i, 1);
  await writeLedger(led);
  broadcastRefresh();
}

function broadcastRefresh() { refresh(); emit({ type: "refresh" }); }

/* ============================================================== the pit */
function stakeOk(u, stake) {
  const lim = S().heatLimits(u.heat);
  if (lim.maxStakeOb <= 0) return "The house will not take your action at all.";
  if (stake > lim.maxStakeOb) return `Your ceiling is ${lim.maxStakeOb.toLocaleString()} ØB right now.`;
  if (stake < 1) return "Stake something.";
  if (stake > (u.ob || 0)) return "You do not have it.";
  return null;
}

async function gmPlay(uid, msg) {
  const cfg = getConfig(), st = getState(), led = getLedger();
  const u = rollDay(userRec(led, uid), st.day);
  const raw = liveOf(uid);
  const live = raw && !raw.outcome ? raw : null;   // a settled hand is not a live one
  const g = msg.game;
  const actor = actorFor(uid);
  const abil = (S().GAMES.find((x) => x.id === g) || {}).abil;
  const bounds = abil ? checkBounds(actor, abil, msg.total) : { ok: true, bonus: 0 };
  // A GM testing without a character told us what to pretend their modifier is.
  // Only honoured for a GM, who can set any of this by hand anyway.
  if (!actor && game.users.get(uid)?.isGM && Number.isFinite(msg.testMod)) {
    bounds.bonus = msg.testMod;
    bounds.ok = true;
  }
  const isRollStep = abil && ["climb", "hand", "crack", null].includes(msg.step ?? null) &&
                     !["start", "walk"].includes(msg.step);
  if (isRollStep && msg.total != null && !bounds.ok) { rejectRoll(uid, msg.total, bounds.bonus); return; }

  const newBet = !live && !["out"].includes(msg.step);
  if (newBet) {
    if ((u.gambles || 0) >= cfg.gamblesPerDay) return notify(uid, "The Cage is done with you for today.");
  }

  const stake = Math.max(1, Math.round(msg.stakeOb || 0));
  const takeStake = async (amount) => {
    const bad = stakeOk(u, amount);
    if (bad) { notify(uid, bad); return false; }
    u.ob -= amount; u.gambles = (u.gambles || 0) + 1;
    return true;
  };
  const payOut = async (amount, text) => {
    u.ob = (u.ob || 0) + amount;
    logLine(u, st.day, text, amount);
    if (amount >= 2000) await addHeat(led, uid, S().HEAT_EVENTS.bigWin, "won more than the room liked");
  };
  const who = game.users.get(uid)?.name || "Someone";

  /* ---- Voidfall -------------------------------------------------------- */
  // This dispatch was missing: gmCrashJoin/gmCrashOut existed but nothing ever
  // called them, so pressing the button did nothing at all.
  if (g === "voidfall") {
    if (msg.step === "out") return gmCrashOut(uid);
    return gmCrashJoin(uid, stake);
  }

  /* ---- The Ladder ------------------------------------------------------ */
  if (g === "ladder") {
    if (msg.step === "start") {
      if (!await takeStake(stake)) return writeLedger(led);
      logLine(u, st.day, "Stepped onto the Ladder", -stake);
      await writeLedger(led);
      await setLive(uid, { game: "ladder", stake, rung: 0 });
      chat(`<b>${who}</b> steps onto the Ladder for ${stake.toLocaleString()} ØB.`, "The Cage");
      return broadcastRefresh();
    }
    if (!live) return;
    if (msg.step === "bank") {
      const mult = S().LADDER.mult[live.rung - 1] || 0;
      const won = Math.floor(live.stake * mult);
      await payOut(won, `Came off the Ladder at rung ${live.rung} (x${mult})`);
      await writeLedger(led);
      await setLive(uid, { game: "ladder", outcome: "won", rung: live.rung, stake: live.stake,
        headline: `TOOK ${won.toLocaleString()} ØB`, sub: `off at rung ${live.rung}, ×${mult}` });
      chat(`<b>${who}</b> comes off the Ladder at rung ${live.rung} with <b>${won.toLocaleString()} ØB</b>.`, "The Cage");
      return broadcastRefresh();
    }
    if (msg.step === "climb") {
      const dc = S().effDC(S().LADDER.dc[live.rung], bounds.bonus);
      const win = msg.nat === 20 ? true : msg.nat === 1 ? false : msg.total >= dc;
      if (!win) {
        logLine(u, st.day, `Fell off the Ladder at rung ${live.rung + 1}`, 0);
        await writeLedger(led);
        await setLive(uid, { game: "ladder", outcome: "lost", rung: live.rung, stake: live.stake,
          headline: "FELL", sub: `missed DC ${dc} on rung ${live.rung + 1} — ${live.stake.toLocaleString()} ØB gone` });
        chat(`<b>${who}</b> misses DC ${dc} on rung ${live.rung + 1} and the Ladder takes ` +
             `<b>${live.stake.toLocaleString()} ØB</b>.`, "The Cage");
        return broadcastRefresh();
      }
      const rung = live.rung + 1;
      if (rung >= S().LADDER.mult.length) {
        const won = Math.floor(live.stake * S().LADDER.mult[rung - 1]);
        await payOut(won, "Topped out the Ladder");
        await writeLedger(led);
        await setLive(uid, { game: "ladder", outcome: "won", rung, stake: live.stake,
          headline: `TOPPED OUT — ${won.toLocaleString()} ØB`, sub: "the room goes quiet" });
        chat(`<b>${who}</b> <b>tops out the Ladder</b> and takes ${won.toLocaleString()} ØB. ` +
             `The room goes quiet.`, "The Cage");
        return broadcastRefresh();
      }
      await setLive(uid, { ...live, rung });
      chat(`<b>${who}</b> clears rung ${rung} (DC ${dc}) — now worth ` +
        `${Math.floor(live.stake * S().LADDER.mult[rung - 1]).toLocaleString()} ØB.`, "The Cage");
      return broadcastRefresh();
    }
    return;
  }

  /* ---- Signal Skim ----------------------------------------------------- */
  if (g === "skim") {
    const tier = S().SKIM.find((t) => t.dc === Number(msg.dc));
    if (!tier) return;
    if (msg.total == null) return;
    if (!await takeStake(stake)) return writeLedger(led);
    const dc = S().effDC(tier.dc, bounds.bonus);
    const win = msg.nat === 20 ? true : msg.nat === 1 ? false : msg.total >= dc;
    const won = win ? Math.floor(stake * tier.mult) : 0;
    if (win) await payOut(won, `${tier.label} on the Skim (x${tier.mult})`);
    else logLine(u, st.day, `Lost the ${tier.label}`, -stake);
    await writeLedger(led);
    await setLive(uid, { game: "skim", outcome: win ? "won" : "lost", total: msg.total,
      headline: win ? `PAYLOAD — ${won.toLocaleString()} ØB` : "NOTHING IN THE TRAFFIC",
      sub: `rolled ${msg.total} against DC ${dc}` });
    chat(`<b>${who}</b> runs a ${tier.label} against DC ${dc} — ` +
      (win ? `<b>clean</b>, ${won.toLocaleString()} ØB.` : `<b>nothing</b>.`), "The Cage");
    return broadcastRefresh();
  }

  /* ---- Cold Read ------------------------------------------------------- */
  if (g === "coldread") {
    if (msg.step === "start") {
      if (!await takeStake(stake)) return writeLedger(led);
      logLine(u, st.day, "Sat down for a Cold Read", -stake);
      await writeLedger(led);
      await setLive(uid, { game: "coldread", stake, pot: stake, round: 0 });
      return broadcastRefresh();
    }
    if (!live) return;
    if (msg.step === "walk") {
      await payOut(live.pot, `Walked away from the Cold Read after ${live.round} hand(s)`);
      await writeLedger(led);
      await setLive(uid, { game: "coldread", outcome: "won", round: live.round,
        you: live.you, house: live.house,
        headline: `WALKED WITH ${live.pot.toLocaleString()} ØB`, sub: "the machine says nothing" });
      chat(`<b>${who}</b> stands up with <b>${live.pot.toLocaleString()} ØB</b>. The machine says nothing.`, "The Cage");
      return broadcastRefresh();
    }
    if (msg.step === "hand") {
      if (msg.total == null) return;
      const house = S().coldReadHouse(live.round, bounds.bonus);
      const hRoll = await new Roll(`1d20 + ${house}`).evaluate();
      const win = msg.total > hRoll.total;
      await chat(`The house reads at <b>${hRoll.total}</b> against <b>${msg.total}</b>.`, "The Cage", [hRoll]);
      if (!win) {
        if (msg.nat === 1) await addHeat(led, uid, S().HEAT_EVENTS.coldReadCaught, "was caught bluffing badly");
        logLine(u, st.day, `Lost the Cold Read on hand ${live.round + 1}`, 0);
        await writeLedger(led);
        await setLive(uid, { game: "coldread", outcome: "lost", round: live.round,
          you: msg.total, house: hRoll.total,
          headline: "READ", sub: `it had ${hRoll.total} against your ${msg.total} — ${live.pot.toLocaleString()} ØB stays put` });
        chat(`<b>${who}</b> is read, and the pot of ${live.pot.toLocaleString()} ØB stays where it is.`, "The Cage");
        return broadcastRefresh();
      }
      const round = live.round + 1;
      const pot = Math.floor(live.pot * S().COLD_READ.potMult);
      if (round >= S().COLD_READ.rounds) {
        await payOut(pot, "Took all three hands of the Cold Read");
        await writeLedger(led);
        await setLive(uid, { game: "coldread", outcome: "won", round, you: msg.total, house: hRoll.total,
          headline: `ALL THREE — ${pot.toLocaleString()} ØB`, sub: "you read it better than it read you" });
        chat(`<b>${who}</b> takes <b>all three hands</b> and ${pot.toLocaleString()} ØB with them.`, "The Cage");
        return broadcastRefresh();
      }
      await writeLedger(led);
      await setLive(uid, { ...live, round, pot, you: msg.total, house: hRoll.total });
      return broadcastRefresh();
    }
    return;
  }

  /* ---- Ice Run --------------------------------------------------------- */
  if (g === "icerun") {
    const lim = S().heatLimits(u.heat);
    if (msg.step === "start") {
      if (lim.iceRunBlocked) return notify(uid, "The house will not sell you a ticket. You are too warm.");
      if (!await takeStake(stake)) return writeLedger(led);
      logLine(u, st.day, "Bought an Ice Run ticket", -stake);
      await writeLedger(led);
      await setLive(uid, { game: "icerun", stake, layer: 0 });
      return broadcastRefresh();
    }
    if (!live || msg.step !== "crack" || msg.total == null) return;
    const dc = S().effDC(S().ICE_RUN.layers[live.layer], bounds.bonus);
    const win = msg.nat === 20 ? true : msg.nat === 1 ? false : msg.total >= dc;
    if (!win) {
      await addHeat(led, uid, S().HEAT_EVENTS.iceRunFail, "tripped something on the way in");
      logLine(u, st.day, `Tripped the ice on layer ${live.layer + 1}`, 0);
      await writeLedger(led);
      await setLive(uid, { game: "icerun", outcome: "lost", layer: live.layer, stake: live.stake,
        headline: "TRIPPED", sub: `layer ${live.layer + 1} at DC ${dc} — the ticket and your anonymity` });
      chat(`<b>${who}</b> trips layer ${live.layer + 1} (DC ${dc}). The ticket is gone and so is ` +
           `the anonymity.`, "The Cage");
      return broadcastRefresh();
    }
    const layer = live.layer + 1;
    if (layer >= S().ICE_RUN.layers.length) {
      const won = live.stake * S().ICE_RUN.mult;
      await payOut(won, `Cracked the vault (x${S().ICE_RUN.mult})`);
      await writeLedger(led);
      await setLive(uid, { game: "icerun", outcome: "won", layer, stake: live.stake,
        headline: `THROUGH — ${won.toLocaleString()} ØB`, sub: "and nobody saw a thing" });
      chat(`<b>${who}</b> is through all three layers. <b>${won.toLocaleString()} ØB</b>, and nobody ` +
           `saw a thing.`, "The Cage");
      return broadcastRefresh();
    }
    await setLive(uid, { ...live, layer });
    return broadcastRefresh();
  }

  /* ---- Hollow Roulette ------------------------------------------------- */
  if (g === "roulette") {
    if (!msg.bet?.key) return notify(uid, "Pick a bet first.");
    if (!await takeStake(stake)) return writeLedger(led);
    const pocket = randInt(S().ROULETTE.pockets);
    const res = S().rouletteResolve(pocket, msg.bet.key, msg.bet.arg, stake);
    if (res.win) await payOut(res.payoutOb, `Roulette: ${pocket} paid ${res.pays}:1`);
    else logLine(u, st.day, res.hollow ? "The Hollow took it" : `Roulette: ${pocket}, nothing`, -stake);
    await writeLedger(led);
    await setLive(uid, { game: "roulette", pocket, win: res.win, payoutOb: res.payoutOb });
    chat(res.hollow
      ? `The wheel lands on <b>the Hollow</b>. <b>${who}</b>'s ${stake.toLocaleString()} ØB is simply gone.`
      : `The wheel lands on <b>${pocket}</b>. <b>${who}</b> ` +
        (res.win ? `takes ${res.payoutOb.toLocaleString()} ØB.` : `takes nothing.`), "The Cage");
    return broadcastRefresh();
  }

  /* ---- Pit Wagers ------------------------------------------------------ */
  if (g === "pitwager") {
    const card = st.fightCard;
    if (!card) return notify(uid, "There is no card today.");
    if (!["a", "b"].includes(msg.fighter)) return notify(uid, "Back somebody first.");
    if (!await takeStake(stake)) return writeLedger(led);
    const seed = (randInt(2 ** 30)) >>> 0;
    const out = S().simulateFight(card.a, card.b, seed, true);
    const won = out.winner === msg.fighter
      ? Math.floor(stake * (msg.fighter === "a" ? card.oddsA : card.oddsB)) : 0;
    if (won) await payOut(won, `Backed ${card[msg.fighter].name} and was right`);
    else logLine(u, st.day, `Backed ${card[msg.fighter].name} and was not`, -stake);
    await writeLedger(led);
    await setLive(uid, { game: "pitwager", log: out.log.slice(0, 14), winner: out.winner,
      outcome: won ? "won" : "lost",
      headline: won ? `PAID ${won.toLocaleString()} ØB` : "NOTHING",
      sub: `${card[out.winner].name} took it in ${out.log.length} rounds` });
    chat(`<b>${card[out.winner].name}</b> takes it after ${out.log.length} rounds. ` +
      `<b>${who}</b> ${won ? `collects ${won.toLocaleString()} ØB` : "collects nothing"}.`, "The Pit");
    return broadcastRefresh();
  }

  /* ---- Salvage Chits --------------------------------------------------- */
  if (g === "chits") {
    const tier = S().CHIT_TIERS.find((t) => t.id === msg.tier);
    if (!tier) return;
    if (!await takeStake(tier.costOb)) return writeLedger(led);
    const rows = S().CHIT_TABLE[tier.id];
    const total = rows.reduce((a, r) => a + r[1], 0);
    let roll = rand() * total, picked = rows[rows.length - 1];
    for (const r of rows) { roll -= r[1]; if (roll <= 0) { picked = r; break; } }
    const [kind, , mult] = picked;
    let text = "";
    if (kind === "obols" || kind === "junk") {
      const won = Math.max(0, Math.floor(tier.costOb * mult * (0.75 + rand() * 0.5)));
      if (won) await payOut(won, `${tier.name}: ${kind === "junk" ? "mostly junk" : "a decent lot"}`);
      else logLine(u, st.day, `${tier.name}: junk`, 0);
      text = kind === "junk"
        ? `Junk, mostly. Scrap value <b>${won.toLocaleString()} ØB</b>.`
        : `A decent lot — <b>${won.toLocaleString()} ØB</b>.`;
    } else if (kind === "item") {
      const granted = await grantChitItem(uid, tier);
      if (granted) text = `Sealed and intact: <b>${granted}</b>.`;
      else {
        const won = Math.floor(tier.costOb * 1.2);
        await payOut(won, `${tier.name}: sold the contents on`);
        text = `Something worth having, and a buyer standing right there — <b>${won.toLocaleString()} ØB</b>.`;
      }
    } else {
      const tip = await mintTip(uid, st);
      text = tip ? `Not cargo. A name, a date and a hull number: <i>${tip}</i>` : `Paper. Worthless.`;
    }
    await writeLedger(led);
    await setLive(uid, { game: "chits", result: text });
    chat(`<b>${who}</b> cracks a ${tier.name}. ${text}`, "The Back Shed");
    return broadcastRefresh();
  }
}

/**
 * Items come out of the shop module's granter, never a hand-rolled
 * createEmbeddedDocuments: grantItem shares itemDataFor() with the buy path, and
 * that is what stamps the ship-combat resource flags onto fuel and power cells.
 * With the shop disabled we pay Obols instead and say so.
 */
async function grantChitItem(uid, tier) {
  try {
    const api = game.modules.get(SHOP_ID)?.api;
    if (!api?.grantItem || !api?.getCatalogue) return null;
    const cat = api.getCatalogue();
    const pool = (cat?.items || []).filter((i) =>
      (i.categories || []).some((c) => ["salvage", "relic", "contraband", "valuable", "material", "ore", "gear"].includes(c)));
    if (!pool.length) return null;
    const budget = tier.costOb * 1.4 / 10;                 // Obols -> gp, roughly
    const afford = pool.filter((i) => (i.basePriceGp || 0) <= budget * 3 && (i.basePriceGp || 0) >= budget * 0.4);
    const item = (afford.length ? afford : pool)[randInt((afford.length ? afford : pool).length)];
    const actor = actorFor(uid);
    if (!actor) return null;
    await api.grantItem({ catId: item.id, qty: 1, actor });
    return item.name;
  } catch (e) { console.warn(`${MODULE_ID} | chit item grant failed`, e); return null; }
}

/** A tip is a rumour that is simply true, minted for one player. */
async function mintTip(uid, st) {
  const sec = getSecret();
  const sched = sec.latent?.sched || [];
  if (!sched.length) return null;
  const ev = sched[randInt(sched.length)];
  const l = (st.market.listings || []).find((x) => x.id === (ev.targets || [])[0]);
  const text = `${l ? l.ticker : "Something"} — ${ev.dir > 0 ? "up" : "down"}, inside ` +
    `${Math.max(1, ev.day - st.day)} day(s). Whoever wrote this was in the room.`;
  emit({ type: "notify", text: `Chit tip: ${text}`, kind: "info" }, [uid]);
  return text;
}

/* ============================================================ VOIDFALL */
/**
 * The only real-time game here, and the only one where latency could rob a
 * player. Three rules make it fair:
 *   - the crash point is drawn GM-side before the round and is NEVER sent;
 *   - the client's claimed multiplier is DISPLAYED, never trusted;
 *   - the GM's own receipt clock decides, credited half the player's measured
 *     round trip (capped), so a laggy player is not punished and inflating your
 *     own ping is worth about 1%.
 */
let _crashLocal = null;

function paintCrash() {
  if (!_root) return;
  S().paintCrash(_root, S()._live);
}

function clientCrashOpen(msg) {
  const skew = msg.serverNow - Date.now();
  _crashLocal = { roundId: msg.roundId, startAtMs: msg.startAtMs, skew };
  const prev = S()._live;
  S()._vfCurve = [];                      // a new run draws a new curve
  S()._live = {
    game: "voidfall", state: "open", mult: 1,
    in: !!(prev && prev.game === "voidfall" && prev.in), stake: prev?.stake || 0,
    countdown: Math.max(0, Math.ceil((msg.startAtMs - (Date.now() + skew)) / 1000)),
  };
  if (_tickTimer) clearInterval(_tickTimer);
  _tickTimer = setInterval(() => {
    const live = S()._live;
    if (!live || live.game !== "voidfall" || !_crashLocal) return;
    const now = Date.now() + _crashLocal.skew;
    if (now < _crashLocal.startAtMs) {
      const c = Math.max(0, Math.ceil((_crashLocal.startAtMs - now) / 1000));
      if (c !== live.countdown) { live.countdown = c; refresh(); }
    } else {
      if (live.state !== "run") { live.state = "run"; refresh(); }
      live.mult = S().crashMultAt(now - _crashLocal.startAtMs);
      paintCrash();
    }
  }, 110);
  refresh();
}

function clientCrashBlown(msg) {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
  const live = S()._live;
  if (live && live.game === "voidfall") { live.blown = true; live.mult = msg.crashAt; live.in = false; }
  paintCrash();
  setTimeout(() => { if (S()._live?.game === "voidfall" && S()._live.blown) { S()._live = null; refresh(); } }, 2600);
}

async function gmCrashJoin(uid, stakeOb) {
  const cfg = getConfig(), st = getState(), led = getLedger();
  const u = rollDay(userRec(led, uid), st.day);
  if ((u.gambles || 0) >= cfg.gamblesPerDay) return notify(uid, "The Cage is done with you for today.");
  const bad = stakeOk(u, stakeOb);
  if (bad) return notify(uid, bad);
  const sec = getSecret();
  let round = sec.crash;
  const now = Date.now();
  if (!round || now > round.startAtMs) {
    round = {
      roundId: newId(), crashAt: S().crashPoint(rand()),
      startAtMs: now + 5000, players: {},
    };
    sec.crash = round;
    await setSecret(sec);
    emit({ type: "crashOpen", roundId: round.roundId, startAtMs: round.startAtMs, serverNow: Date.now() });
    clientCrashOpen({ roundId: round.roundId, startAtMs: round.startAtMs, serverNow: Date.now() });
    if (_crashTimer) clearTimeout(_crashTimer);
    const blowIn = (round.startAtMs - now) + S().crashMsFor(round.crashAt);
    _crashTimer = setTimeout(() => tx(() => gmCrashBlow(round.roundId)), blowIn);
    chat(`A Voidfall round opens. Five seconds.`, "The Cage");
  }
  if (now > round.startAtMs) return notify(uid, "That round has already started.");
  if (round.players[uid]) return notify(uid, "You are already in.");
  u.ob -= stakeOb; u.gambles = (u.gambles || 0) + 1;
  logLine(u, st.day, "Into a Voidfall round", -stakeOb);
  round.players[uid] = { stake: stakeOb, joinedAt: now };
  sec.crash = round; await setSecret(sec);
  await writeLedger(led);
  const pub = { game: "voidfall", state: "open", mult: 1, in: true, stake: stakeOb };
  if (uid === game.user.id) { S()._live = { ...S()._live, ...pub }; refresh(); }
  else emit({ type: "live", live: pub }, [uid]);
  broadcastRefresh();
}

async function gmCrashOut(uid) {
  const sec = getSecret();
  const round = sec.crash;
  if (!round || !round.players[uid]) return;
  const p = round.players[uid];
  const tGm = Date.now();
  const rtt = Math.min(p.rtt || 0, 400) / 2;              // half the round trip, capped
  const mult = S().crashMultAt(tGm - rtt - round.startAtMs);
  delete round.players[uid];
  sec.crash = round; await setSecret(sec);
  const led = getLedger(), st = getState();
  const u = userRec(led, uid);
  const who = game.users.get(uid)?.name || "Someone";
  if (mult >= round.crashAt) {
    logLine(u, st.day, "Left it too late in Voidfall", 0);
    await writeLedger(led);
    notify(uid, "Too late.", "warn");
  } else {
    const won = Math.floor(p.stake * mult);
    u.ob = (u.ob || 0) + won;
    logLine(u, st.day, `Out of Voidfall at x${mult.toFixed(2)}`, won - p.stake);
    if (won >= 2000) await addHeat(led, uid, S().HEAT_EVENTS.bigWin, "took a large Voidfall run");
    await writeLedger(led);
    chat(`<b>${who}</b> gets out at <b>×${mult.toFixed(2)}</b> for ${won.toLocaleString()} ØB.`, "The Cage");
    const pub = { game: "voidfall", state: "run", in: false, stake: 0, mult };
    if (uid === game.user.id) { S()._live = { ...S()._live, ...pub }; refresh(); }
    else emit({ type: "live", live: pub }, [uid]);
  }
  broadcastRefresh();
}

async function gmCrashBlow(roundId) {
  const sec = getSecret();
  const round = sec.crash;
  if (!round || round.roundId !== roundId) return;
  const led = getLedger(), st = getState();
  const lost = [];
  for (const [uid, p] of Object.entries(round.players)) {
    logLine(userRec(led, uid), st.day, "Voidfall blew with them still in it", 0);
    lost.push(`${game.users.get(uid)?.name || "someone"} (${p.stake.toLocaleString()} ØB)`);
  }
  sec.crash = null; await setSecret(sec);
  await writeLedger(led);
  emit({ type: "crashBlown", crashAt: round.crashAt });
  clientCrashBlown({ crashAt: round.crashAt });
  chat(`Voidfall blows at <b>×${round.crashAt.toFixed(2)}</b>.` +
    (lost.length ? ` Still aboard: ${lost.join(", ")}.` : " Nobody was aboard."), "The Cage");
  broadcastRefresh();
}

/* ======================================================== READING THE WIRE */
async function gmRead(uid, msg) {
  const st = getState(), led = getLedger();
  const u = rollDay(userRec(led, uid), st.day);
  if (u.insightDay === st.day) return notify(uid, "You have already leaned on one story today.");
  const sec = getSecret();
  const rum = (sec.latent?.rum || {})[msg.rid];
  if (!rum) return notify(uid, "That one has already gone cold.");
  const actor = actorFor(uid);
  const bounds = checkBounds(actor, "wis", msg.total);
  if (msg.total != null && !bounds.ok) return rejectRoll(uid, msg.total, bounds.bonus);
  const dc = S().readDC(rum.slippery);
  const srcAcc = (sec.latent.srcAcc || {})[rum.srcId] ?? 0.5;
  const band = S().confidenceBand(msg.total ?? dc, dc, rum.truth, srcAcc, () => rand());
  u.insightDay = st.day;
  await writeLedger(led);
  // Delivered to that player alone, and stored in THEIR browser — another player
  // must not be able to read what this one worked out.
  if (uid === game.user.id) storeBand(msg.rid, band);
  else emit({ type: "band", rid: msg.rid, band }, [uid]);
  chat(`<b>${game.users.get(uid)?.name}</b> leans on a story (DC ${dc}) and comes away ` +
    `reading it as <b>${band.label}</b>.`, "The Wire");
  broadcastRefresh();
}

function storeBand(rid, band) {
  const all = { ...(game.settings.get(MODULE_ID, SET_BANDS) || {}) };
  all[rid] = band;
  game.settings.set(MODULE_ID, SET_BANDS, all);
  refresh();
}

/* =========================================================== DAY ADVANCE */
/**
 * Two-step on purpose. A one-click irreversible day is exactly what you regret
 * on the session the tick kills the company the party was about to sell.
 */
async function previewDay() {
  if (!isActiveGM()) return;
  await loadContent();
  const sec = getSecret();
  if (!sec.latent) {
    // No hidden model in THIS browser. Reseed it from the published board
    // rather than from scratch, or advancing the day from a second GM seat
    // would republish eight brand-new prices and the party's positions would
    // be marked against a board that had silently jumped.
    const st0 = getState();
    sec.latent = st0.started && st0.market?.listings?.length
      ? S().latentFromPublished(st0.market, CONTENT, (rand() * 2 ** 31) >>> 0)
      : S().initLatent(CONTENT, (rand() * 2 ** 31) >>> 0);
    await setSecret(sec);
    if (st0.started) {
      ui.notifications?.info?.("Rebuilt the market model from the live board — prices carried over.");
    }
  }
  let seed = (rand() * 2 ** 31) >>> 0;
  const show = async () => {
    const out = S().tickDay(sec.latent, CONTENT, seed, { standing: partyStanding() });
    const r = out.report;
    const body =
      `<div style="font-family:'Courier New',monospace;font-size:12px;line-height:1.6">` +
      `<p><b>DAY ${r.day}</b> — nothing is committed yet.</p>` +
      (r.fired.length ? `<p><b>Happens today:</b><br>${r.fired.map((e) => "· " + e.headline).join("<br>")}</p>` : "") +
      (r.deaths.length ? `<p style="color:#a33"><b>Delisted:</b><br>${r.deaths.map((d) =>
        `· ${d.name} (${d.ticker}) — holders paid ${Math.round(d.payoutFrac * 100)}/100`).join("<br>")}</p>` : "") +
      (r.listed.length ? `<p><b>Lists:</b><br>${r.listed.map((l) => `· ${l.name} (${l.ticker}) at ${l.openPx}`).join("<br>")}</p>` : "") +
      `<p><b>Movers:</b> ${r.movers.map((m) => `${m.ticker} ${m.pct > 0 ? "+" : ""}${m.pct}%`).join(" · ") || "quiet"}</p>` +
      (r.pending.length ? `<p style="opacity:.75"><b>Coming (players cannot see this):</b><br>${
        r.pending.map((e) => `· D${e.day}: ${e.headline}`).join("<br>")}</p>` : "") +
      (r.pump ? `<p style="opacity:.75"><b>The Syndicate is running ${r.pump.name || r.pump.target}</b> until day ${r.pump.endDay}.</p>` : "") +
      `</div>`;
    const V = D2();
    let choice = "cancel";
    if (V) {
      choice = await V.wait({
        window: { title: "Advance the day", width: 620 }, content: body,
        buttons: [
          { action: "commit", label: "Commit", default: true },
          { action: "reroll", label: "Roll a different day" },
          { action: "cancel", label: "Not yet" },
        ],
      }).catch(() => "cancel");
    } else {
      choice = await new Promise((res) => new Dialog({
        title: "Advance the day", content: body,
        buttons: {
          commit: { label: "Commit", callback: () => res("commit") },
          reroll: { label: "Roll a different day", callback: () => res("reroll") },
          cancel: { label: "Not yet", callback: () => res("cancel") },
        }, close: () => res("cancel"),
      }).render(true));
    }
    if (choice === "reroll") { seed = (rand() * 2 ** 31) >>> 0; return show(); }
    if (choice === "commit") return tx(() => commitDay(out));
  };
  return show();
}

async function commitDay(out) {
  const st = getState(), led = getLedger(), wire = getWire();
  const day = out.published.day;

  /* --- delistings pay out before anything else ----------------------- */
  const dead = st.dead.slice();
  for (const d of out.report.deaths) {
    dead.unshift({ id: d.id, ticker: d.ticker, name: d.name, day: d.day,
                   lastClose: d.lastClose, payoutFrac: d.payoutFrac, epitaph: d.epitaph });
    for (const [uid, u] of Object.entries(led.users)) {
      const pos = u.pos?.[d.id];
      if (!pos?.qty) continue;
      const paid = Math.floor(pos.qty * d.lastClose * d.payoutFrac);
      const res = S().applySell(pos, pos.qty, paid);
      u.pos[d.id] = res ? res.pos : S().emptyPos();
      u.ob = (u.ob || 0) + paid;
      logLine(u, day, `${d.ticker} delisted — paid ${paid.toLocaleString()} ØB on ${pos.qty.toLocaleString()} shares`, paid);
      notify(uid, `${d.name} has been delisted. You were paid ${paid.toLocaleString()} ØB.`, "warn");
    }
    // Refund anything resting against a listing that no longer exists.
    for (const u of Object.values(led.users)) {
      u.orders = (u.orders || []).filter((o) => {
        if (o.id !== d.id) return true;
        if (o.side === "buy") u.ob = (u.ob || 0) + (o.escrowOb || 0);
        return false;
      });
    }
  }
  const trimmed = dead.filter((d) => day - d.day <= S().M.deadOnScreenDays * 2).slice(0, 24);

  /* --- the tape ------------------------------------------------------- */
  const market = out.published;

  /* --- resting orders, against the post-tick price --------------------- */
  const cfg = getConfig();
  for (const [uid, u] of Object.entries(led.users)) {
    rollDay(u, day);
    const keep = [];
    for (const o of u.orders || []) {
      const l = (market.listings || []).find((x) => x.id === o.id);
      if (!l) { if (o.side === "buy") u.ob = (u.ob || 0) + (o.escrowOb || 0); continue; }
      if (!S().orderTriggers(o, l.price)) { keep.push(o); continue; }
      if ((u.trades || 0) >= cfg.tradesPerDay) { keep.push(o); continue; }   // rests another day
      const q = S().quote(l, o.side, o.qty, cfg);
      if (o.side === "buy") {
        if (q.netOb > (o.escrowOb || 0) + (u.ob || 0)) { keep.push(o); continue; }
        u.ob = (u.ob || 0) + (o.escrowOb || 0) - q.netOb;
        u.pos[l.id] = S().applyBuy(u.pos[l.id], o.qty, q.netOb);
      } else {
        const res = S().applySell(u.pos[l.id], o.qty, q.netOb);
        if (!res) continue;
        u.pos[l.id] = res.pos;
        u.ob = (u.ob || 0) + q.netOb;
      }
      u.trades = (u.trades || 0) + 1;
      logLine(u, day, `${o.kind === "stop" ? "Stop" : "Limit"} ${o.side} filled: ` +
        `${o.qty.toLocaleString()} ${l.ticker} at ${q.unitOb}`, o.side === "buy" ? -q.netOb : q.netOb);
      notify(uid, `${o.kind === "stop" ? "Stop" : "Limit"} order filled on ${l.ticker}.`, "info");
    }
    u.orders = keep;
    u.heat = Math.max(0, (u.heat || 0) - S().HEAT_DECAY);
  }

  /* --- the wire -------------------------------------------------------- */
  const sources = { ...wire.sources };
  for (const s of CONTENT.sources) {
    sources[s.id] ||= { name: s.name, role: s.role, seen: 0, hits: 0, misses: 0 };
  }
  sources["the-net"] ||= { name: "The Net", role: "wire service", seen: 0, hits: 0, misses: 0 };
  for (const r of out.resolved) {
    const s = sources[r.srcId];
    if (!s) continue;
    s.seen = (s.seen || 0) + 1;
    if (r.hit) s.hits = (s.hits || 0) + 1; else s.misses = (s.misses || 0) + 1;
  }
  const items = out.wire.concat(wire.items || []).slice(0, 60);
  for (const it of items) {
    const r = out.resolved.find((x) => x.id === it.id);
    if (r) { it.resolved = true; it.hit = r.hit; }
  }

  /* --- the fight card -------------------------------------------------- */
  const fightCard = makeFightCard();

  const sec = getSecret();
  sec.latent = out.latent;
  await setSecret(sec);
  await writeLedger(led);
  await writeWire({ items, sources });
  await writeState({ day, market, dead: trimmed, fightCard, started: true });
  await vaultSave();

  chat(`<b>DAY ${day}</b> on the Net. ` +
    (out.report.movers.length
      ? out.report.movers.map((m) => `${m.ticker} ${m.pct > 0 ? "+" : ""}${m.pct}%`).join(" · ")
      : "A quiet session."), "The Exchange");
  // Other modules can hang their own in-fiction clock off this.
  Hooks.callAll(`${MODULE_ID}.dayAdvanced`, { day });
  if (getConfig().driveShopRestock) nudgeShopRestock(day);
  broadcastRefresh();
}

/** Two fighters whose simulated odds are an actual contest. */
function makeFightCard() {
  const F = CONTENT.fighters;
  let best = null;
  for (let i = 0; i < 12; i++) {
    const a = F[randInt(F.length)];
    let b = F[randInt(F.length)];
    if (a.id === b.id) continue;
    const seed = (rand() * 2 ** 30) >>> 0;
    const o = S().fightOdds(a, b, seed, 500);
    const skew = Math.abs(o.pA - 0.5);
    if (!best || skew < best.skew) best = { a, b, ...o, skew, seed };
    if (skew < 0.22) break;
  }
  if (!best) return null;
  return { a: best.a, b: best.b, oddsA: best.oddsA, oddsB: best.oddsB,
           venue: CONTENT.venues[randInt(CONTENT.venues.length)] };
}

/**
 * The shop's restock still runs on wall-clock days, which its own docs flag as
 * an open question. Rather than reach into its state, we fire a hook and let it
 * opt in; if it has an API for this later, use that instead.
 */
function nudgeShopRestock(day) {
  try {
    const api = game.modules.get(SHOP_ID)?.api;
    if (api?.restockAll) api.restockAll(`Sundowner day ${day}`);
  } catch (e) { /* the shop simply is not listening yet */ }
}

/* ============================================================== GM tools */
async function gmTool(uid, msg) {
  if (!game.users.get(uid)?.isGM) return;
  const st = getState(), led = getLedger();
  const note = (text) => writeState({ gmLog: [{ day: st.day, text, ts: Date.now() }].concat(st.gmLog || []).slice(0, 40) });
  switch (msg.tool) {
    case "grant": {
      const u = userRec(led, msg.target);
      u.ob = Math.max(0, (u.ob || 0) + Math.round(msg.n || 0));
      logLine(u, st.day, `The house adjusted the account by ${msg.n}`, Math.round(msg.n || 0));
      await writeLedger(led);
      notify(msg.target, `Your balance was adjusted by ${Math.round(msg.n).toLocaleString()} ØB.`, "info");
      break;
    }
    case "setHeat": {
      const u = userRec(led, msg.target);
      u.heat = Math.max(0, Math.min(100, Math.round(msg.n || 0)));
      await writeLedger(led);
      notify(msg.target, `The house has re-rated you: ${S().heatTier(u.heat).label}.`, "warn");
      break;
    }
    case "resetCounters": {
      for (const u of Object.values(led.users)) { u.trades = 0; u.gambles = 0; u.cashedOutToday = 0; u.insightDay = -1; }
      await writeLedger(led);
      break;
    }
    case "wipeUser": {
      // Everything one account has done, gone. For clearing up after testing.
      delete led.users[msg.target];
      await writeLedger(led);
      const sec = getSecret();
      if (sec.bets) { delete sec.bets[msg.target]; await setSecret(sec); }
      notify(msg.target, "The house has closed and reopened your account. You are starting over.", "warn");
      await note(`Wiped ${game.users.get(msg.target)?.name || msg.target}'s account`);
      break;
    }
    case "wipeAll": {
      await writeLedger({ v: 1, users: {}, house: { feesOb: 0, edgeOb: 0 }, settled: {} });
      const sec2 = getSecret();
      sec2.bets = {}; sec2.crash = null; await setSecret(sec2);
      await note("Wiped every account");
      break;
    }
    case "reseedBoard": {
      // Positions have to go: they are shares in companies that will not exist
      // on the new board, and leaving them would show a portfolio of ghosts.
      for (const u of Object.values(led.users)) {
        for (const o of u.orders || []) if (o.side === "buy") u.ob = (u.ob || 0) + (o.escrowOb || 0);
        u.pos = {}; u.orders = [];
        logLine(u, 0, "The board was reseeded — positions closed", 0);
      }
      await writeLedger(led);
      await openTheBoard(true);
      await note("Reseeded the board");
      break;
    }
    case "shock": {
      const market = structuredClone(st.market);
      const l = (market.listings || []).find((x) => x.id === msg.id);
      if (!l) return;
      const pctMove = Math.max(-90, Math.min(400, Number(msg.n) || 0));
      l.prev = l.price;
      l.price = Math.max(1, Math.round(l.price * (1 + pctMove / 100)));
      l.hist = (l.hist || []).concat([l.price]).slice(-S().M.histCap);
      const sec = getSecret();
      if (sec.latent?.lst?.[l.id]) { sec.latent.lst[l.id].price = l.price; await setSecret(sec); }
      await writeState({ market });
      await pushWire({
        id: `g${st.day}-${newId()}`, day: st.day, kind: "headline", src: "the-net",
        text: `${l.name} (${l.ticker}) moves ${pctMove > 0 ? "+" : ""}${pctMove}% on the session.`,
        tags: [l.id], dir: pctMove >= 0 ? 1 : -1, resolved: true, hit: true,
      });
      await note(`Shocked ${l.ticker} by ${pctMove}%`);
      break;
    }
    case "kill": {
      const market = structuredClone(st.market);
      const i = (market.listings || []).findIndex((x) => x.id === msg.id);
      if (i < 0) return;
      const l = market.listings[i];
      const frac = 0.05;
      market.listings.splice(i, 1);
      const dead = [{ id: l.id, ticker: l.ticker, name: l.name, day: st.day, lastClose: l.price,
                      payoutFrac: frac, epitaph: "The house pulled the listing without explanation." }]
                   .concat(st.dead);
      for (const [tuid, u] of Object.entries(led.users)) {
        const pos = u.pos?.[l.id];
        if (!pos?.qty) continue;
        const paid = Math.floor(pos.qty * l.price * frac);
        const res = S().applySell(pos, pos.qty, paid);
        u.pos[l.id] = res ? res.pos : S().emptyPos();
        u.ob = (u.ob || 0) + paid;
        logLine(u, st.day, `${l.ticker} pulled — paid ${paid.toLocaleString()} ØB`, paid);
        notify(tuid, `${l.name} has been pulled off the board. You were paid ${paid.toLocaleString()} ØB.`, "warn");
      }
      const sec = getSecret();
      if (sec.latent?.lst?.[l.id]) { delete sec.latent.lst[l.id]; await setSecret(sec); }
      await writeLedger(led);
      await writeState({ market, dead });
      await pushWire({ id: `o${st.day}-${l.id}`, day: st.day, kind: "obituary", src: "the-net",
        text: `${l.name} (${l.ticker}) delisted. Holders paid 5 on the hundred.`,
        tags: [l.id], dir: -1, resolved: true, hit: true });
      await note(`Killed ${l.ticker}`);
      break;
    }
    case "headline": {
      if (!msg.text) return;
      await pushWire({ id: `g${st.day}-${newId()}`, day: st.day, kind: "headline", src: "the-net",
        text: String(msg.text).slice(0, 400), tags: [], dir: 1, resolved: true, hit: true });
      break;
    }
    case "plant": {
      if (!msg.text) return;
      const src = CONTENT.sources.find((s) => s.id === msg.src) || CONTENT.sources[0];
      const rid = `g${st.day}-${newId()}`;
      const voiced = String(src.voice || "{text}").replace("{text}", String(msg.text).slice(0, 400));
      await pushWire({ id: rid, day: st.day, kind: "rumour", src: src.id, text: voiced,
        tags: [], dir: 1, resolved: false, hit: null });
      const sec = getSecret();
      sec.latent.rum = sec.latent.rum || {};
      sec.latent.rum[rid] = { truth: msg.truth ? 1 : 0, srcId: src.id, day: st.day,
                              resolvesOn: st.day + 4, slippery: 0, resolved: false };
      await setSecret(sec);
      await note(`Planted a ${msg.truth ? "true" : "false"} rumour via ${src.name}`);
      break;
    }
    case "newCard": {
      await writeState({ fightCard: makeFightCard() });
      break;
    }
    case "say": {
      const it = (getWire().items || []).find((x) => x.id === msg.rid);
      if (!it) return;
      const src = CONTENT.sources.find((s) => s.id === it.src);
      await chat(it.text, src?.name || "The Net");
      break;
    }
  }
  broadcastRefresh();
}

async function pushWire(item) {
  const w = getWire();
  await writeWire({ items: [item].concat(w.items || []).slice(0, 60) });
}

/* ============================================================== ACTIONS */
// The contract the renderer is handed. Everything here either redraws locally
// or asks the GM; nothing writes a world setting from a player's client.
const NEEDS_ROLL = { ladder: ["climb"], coldread: ["hand"], icerun: ["crack"], skim: [null] };

const ACTIONS = {
  rerender: () => refresh(),
  close: () => closeNet(),
  advanceDay: () => previewDay(),
  buyIn: (obols) => ask({ type: "buyIn", obols }),
  cashOut: (obols) => ask({ type: "cashOut", obols }),
  cancelOrder: (oid) => ask({ type: "cancelOrder", oid }),
  trade: (id, side, qty) => {
    const l = listingById(id);
    if (!l) return;
    const q = S().quote(l, side, qty, getConfig());
    ask({ type: "trade", id, side, qty, quoteOb: q.netOb });
  },
  orderDialog: async (id) => {
    const l = listingById(id);
    if (!l) return;
    const content =
      `<p style="font-family:'Courier New',monospace;font-size:12px">` +
      `<b>${l.ticker}</b> is ${l.price.toLocaleString()} ØB. A resting order is checked when the ` +
      `day turns, and the fill costs a trade slot then.</p>` +
      `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">` +
      `<label>Kind<select name="kind"><option value="limit">Limit</option><option value="stop">Stop</option></select></label>` +
      `<label>Side<select name="side"><option value="buy">Buy</option><option value="sell">Sell</option></select></label>` +
      `<label>Price ØB<input type="number" name="priceOb" value="${l.price}"></label>` +
      `<label>Shares<input type="number" name="qty" value="10" min="1"></label></div>` +
      `<p style="font-size:11px;opacity:.8">A <b>limit buy</b> fills at or below your price; a ` +
      `<b>stop sell</b> fires at or below it, which is how you leave a stop-loss behind you.</p>`;
    const read = (form) => ({
      kind: form.elements.kind.value, side: form.elements.side.value,
      priceOb: Number(form.elements.priceOb.value), qty: Number(form.elements.qty.value),
    });
    const V = D2();
    let res = null;
    if (V) {
      res = await V.prompt({ window: { title: `Rest an order — ${l.ticker}` }, content,
        ok: { label: "Rest it", callback: (_e, b) => read(b.form) } }).catch(() => null);
    } else {
      res = await new Promise((r) => new Dialog({ title: `Rest an order — ${l.ticker}`, content,
        buttons: { ok: { label: "Rest it", callback: (h) => r(read(h[0].querySelector("form") || h[0])) } },
        close: () => r(null) }).render(true));
    }
    if (res) ask({ type: "order", id, ...res });
  },
  play: async (gameId, payload) => {
    const g = S().GAMES.find((x) => x.id === gameId);
    if (!g) return;
    if (gameId === "voidfall") {
      if (payload.step === "out") return ask({ type: "play", game: gameId, step: "out" });
      return ask({ type: "play", game: gameId, step: "join", stakeOb: payload.stakeOb });
    }
    const steps = NEEDS_ROLL[gameId];
    const wants = steps && steps.includes(payload.step ?? null);
    const tm = gmTestMod();
    if (!wants) return ask({ type: "play", game: gameId, ...payload, testMod: tm });
    const r = await rollCheck(g.abil, g.name);
    if (!r) return;
    ask({ type: "play", game: gameId, ...payload, total: r.total, nat: r.nat, testMod: tm });
  },
  readRumour: async (rid) => {
    const r = await rollCheck("wis", "Reading the wire");
    if (!r) return;
    ask({ type: "read", rid, total: r.total, nat: r.nat });
  },
  sayRumour: (rid) => ask({ type: "gm", tool: "say", rid }),
  gm: {
    grant: (target, n) => ask({ type: "gm", tool: "grant", target, n }),
    setHeat: (target, n) => ask({ type: "gm", tool: "setHeat", target, n }),
    resetCounters: () => ask({ type: "gm", tool: "resetCounters" }),
    wipeUser: (target) => ask({ type: "gm", tool: "wipeUser", target }),
    wipeAll: () => ask({ type: "gm", tool: "wipeAll" }),
    reseedBoard: () => ask({ type: "gm", tool: "reseedBoard" }),
    setTestMod: async (n) => { await game.settings.set(MODULE_ID, SET_TESTMOD, n); refresh(); },
    shock: (id, n) => ask({ type: "gm", tool: "shock", id, n }),
    kill: (id) => ask({ type: "gm", tool: "kill", id }),
    headline: (text) => ask({ type: "gm", tool: "headline", text }),
    plant: (text, src, truth) => ask({ type: "gm", tool: "plant", text, src, truth }),
    newCard: () => ask({ type: "gm", tool: "newCard" }),
  },
};

/* ============================================================ lifecycle */
const canOpen = () => game.user.isGM || !!getConfig().playerAccess;

/**
 * Copied from the settlements module: a keybinding that loses a precedence
 * fight simply stops working, with nothing in the log to say why.
 */
function warnAboutKeyConflicts() {
  try {
    const mine = game.keybindings.actions.get(`${MODULE_ID}.open`);
    const myKey = mine?.editable?.[0]?.key || "KeyB";
    for (const [id, action] of game.keybindings.actions.entries()) {
      if (id === `${MODULE_ID}.open`) continue;
      const bindings = game.keybindings.bindings?.get(id) || action.editable || [];
      for (const b of bindings) {
        if (b.key !== myKey) continue;
        console.warn(`${MODULE_ID} | ${myKey} is also bound by "${id}" ` +
          `(precedence ${action.precedence ?? 0} vs ours ${mine?.precedence ?? 0}). ` +
          `If B stops opening the Net, this is why.`);
      }
    }
  } catch (e) { /* diagnostics must never break boot */ }
}

Hooks.once("init", () => {
  const refreshAll = () => { invalidate(); refresh(); };
  for (const [key, dflt] of [[SET_STATE, {}], [SET_WIRE, {}], [SET_LEDGER, {}], [SET_CONFIG, {}]]) {
    game.settings.register(MODULE_ID, key, {
      scope: "world", config: false, type: Object, default: dflt, onChange: refreshAll,
    });
  }
  // World scope, but ciphertext only — see vaultSave().
  game.settings.register(MODULE_ID, SET_VAULT, { scope: "world", config: false, type: Object, default: {} });
  // Client scope is the ONLY per-browser boundary Foundry has. The latent market
  // model, the event schedule and the passphrase live here and nowhere else.
  game.settings.register(MODULE_ID, SET_SECRET, { scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, SET_PASS, { scope: "client", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, SET_BANDS, { scope: "client", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, SET_TESTMOD, { scope: "client", config: false, type: Number, default: null });

  const cfgBool = (key, dflt) => game.settings.register(MODULE_ID, key, {
    name: game.i18n.localize(`${MODULE_ID}.settings.${key}.name`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.${key}.hint`),
    scope: "world", config: true, type: Boolean, default: dflt,
    onChange: (v) => setConfig({ [key]: v }),
  });
  const cfgNum = (key, dflt, range) => game.settings.register(MODULE_ID, key, {
    name: game.i18n.localize(`${MODULE_ID}.settings.${key}.name`),
    hint: game.i18n.localize(`${MODULE_ID}.settings.${key}.hint`),
    scope: "world", config: true, type: Number, default: dflt, range,
    onChange: (v) => setConfig({ [key]: v }),
  });
  cfgBool("netOpen", true);
  cfgBool("playerAccess", true);
  cfgNum("tradesPerDay", 5, { min: 0, max: 30, step: 1 });
  cfgNum("gamblesPerDay", 10, { min: 0, max: 50, step: 1 });
  cfgBool("driveShopRestock", true);
  cfgNum("burnInDays", 90, { min: 0, max: 240, step: 10 });

  game.keybindings.register(MODULE_ID, "open", {
    name: game.i18n.localize(`${MODULE_ID}.keybind.open.name`),
    hint: game.i18n.localize(`${MODULE_ID}.keybind.open.hint`),
    editable: [{ key: "KeyB" }],
    onDown: () => {
      if (!canOpen()) return true;
      if (isOpen()) closeNet(); else openNet();
      return true;
    },
  });
});

// The scene-control shape changed at v13: arrays of controls with array tools
// became keyed objects with keyed tools. Handle both.
Hooks.on("getSceneControlButtons", (controls) => {
  const tool = {
    name: "ssv-sundowner", title: game.i18n.localize(`${MODULE_ID}.control.title`),
    icon: "fa-solid fa-chart-line", button: true, visible: canOpen(),
    onClick: () => { if (canOpen()) openNet(); },
    onChange: () => { if (canOpen()) openNet(); }, order: 98,
  };
  try {
    if (Array.isArray(controls)) {
      const t = controls.find((c) => c.name === "token" || c.name === "tokens");
      if (t?.tools && !t.tools.some((x) => x.name === tool.name)) t.tools.push(tool);
    } else {
      const t = controls.tokens ?? controls.token;
      if (t?.tools) t.tools[tool.name] = tool;
    }
  } catch (e) { console.warn(`${MODULE_ID} | could not add the scene control`, e); }
});

Hooks.once("ready", async () => {
  await loadContent();
  game.socket.on(SOCKET, onSocket);
  warnAboutKeyConflicts();

  if (game.user.isGM) {
    await setConfig({
      netOpen: game.settings.get(MODULE_ID, "netOpen"),
      playerAccess: game.settings.get(MODULE_ID, "playerAccess"),
      tradesPerDay: game.settings.get(MODULE_ID, "tradesPerDay"),
      gamblesPerDay: game.settings.get(MODULE_ID, "gamblesPerDay"),
      driveShopRestock: game.settings.get(MODULE_ID, "driveShopRestock"),
      burnInDays: game.settings.get(MODULE_ID, "burnInDays"),
    });
  }
  if (isActiveGM() && !getState().started) await openTheBoard();

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isOpen()) return;
    if (e.target?.closest?.(".application, .window-app, .dialog, dialog")) return;
    if (document.querySelector(".dialog, dialog.application[open], .application.dialog")) return;
    e.preventDefault(); e.stopImmediatePropagation();
    closeNet();
  }, true);

  // Prices move when standing does — the shop does exactly this for the same reason.
  Hooks.on(`${POLITICS_ID}.updated`, () => refresh());
  Hooks.on("updateActor", (a) => { if (isOpen() && a === myActor()) refresh(); });

  const api = {
    open: openNet, close: closeNet,
    getState, getLedger, getWire, getConfig,
    advanceDay: previewDay,
    grantObols: (userId, n) => tx(() => gmTool(game.user.id, { tool: "grant", target: userId, n })),
    setHeat: (userId, n) => tx(() => gmTool(game.user.id, { tool: "setHeat", target: userId, n })),
    unlockVault: (pass) => vaultLoad(pass),
    reseed: () => tx(() => openTheBoard(true)),
  };
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
  globalThis.SilverGullSundowner = api;
  console.log(`${MODULE_ID} | ready — press B`);
});

/** First light: build the hidden model and publish day 0 so the board exists
 *  before anybody advances anything. */
async function openTheBoard(force) {
  if (!isActiveGM()) return;
  await loadContent();
  const sec = getSecret();
  if (!sec.latent || force) {
    /**
     * These companies did not come into existence the day the crew found the
     * terminal. Run the model forward in private first so the board arrives
     * with a real past to chart, then wind the campaign clock back to zero: the
     * history is theirs to read, the story starts now.
     */
    const burn = Math.max(0, Math.round(Number(getConfig().burnInDays) || 0));
    let latent = S().initLatent(CONTENT, (rand() * 2 ** 31) >>> 0);
    const standing = partyStanding();
    for (let i = 0; i < burn; i++) {
      latent = S().tickDay(latent, CONTENT, (rand() * 2 ** 31) >>> 0, { standing }).latent;
    }
    latent.day = 0;
    latent.sched = [];        // nothing is already in flight on day one
    latent.rum = {};
    latent.pump = null;
    latent.lastDeathAt = 0;   // not -999, or the drought bleed fires immediately
    latent.lastPumpAt = 0;
    latent.ipoQueue = [];
    sec.latent = latent;
    await setSecret(sec);
    if (burn) console.log(`${MODULE_ID} | ran ${burn} days of history before opening the board`);
  }
  const published = S().publish(sec.latent, CONTENT, { standingKnown: !!partyStanding() });
  const sources = {};
  for (const s of CONTENT.sources) sources[s.id] = { name: s.name, role: s.role, seen: 0, hits: 0, misses: 0 };
  sources["the-net"] = { name: "The Net", role: "wire service", seen: 0, hits: 0, misses: 0 };
  await writeWire({ items: [{
    id: "boot", day: 0, kind: "headline", src: "the-net",
    text: "Board open. Eight listings, no history, and everybody pretending they know something.",
    tags: [], dir: 1, resolved: true, hit: true,
  }], sources });
  await writeState({ day: 0, market: published, dead: [], started: true, fightCard: makeFightCard() });
  await vaultSave();
  console.log(`${MODULE_ID} | opened the board with ${published.listings.length} listings`);
}
