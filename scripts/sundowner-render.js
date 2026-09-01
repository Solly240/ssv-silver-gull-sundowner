/**
 * SSV Silver Gull — Sundowner Net : renderer + market core.
 *
 * This file is deliberately FOUNDRY-AGNOSTIC: it must never reference `game`,
 * `ui`, `Hooks`, `canvas` or any Foundry document class. Everything it needs
 * arrives in a `ctx` object built by sundowner.js (in Foundry) or by
 * preview.html (in a plain browser), so the standalone preview exercises the
 * real renderer, the real market simulation and the real payout tables.
 * Exposed as globalThis.SSVSUN.
 *
 * The market model lives here on purpose. What ships to every client is the
 * MODEL; what never leaves the GM's browser is the latent state and the event
 * schedule that drives it. A player reading this file learns how the market
 * works — which is the point, because that is what makes the wire worth
 * reading — but learns nothing about what happens tomorrow.
 */
(function () {
  "use strict";
  const S = {};
  globalThis.SSVSUN = S;

  /* ---------------------------------------------------------------- utils */
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const r2 = (n) => Math.round(n * 100) / 100;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  S.esc = esc; S.clamp = clamp;

  /* ------------------------------------------------------------------ rng */
  // Copied from the shop module rather than depended on: same maths, own copy,
  // so neither module can break the other (shop-render.js:111).
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  /**
   * One RNG stream per purpose. Without this, adding a ninth listing would
   * reshuffle every index draw and throw away every tuning result we had.
   */
  const stream = (seed, tag) => mulberry32(((seed >>> 0) ^ hashStr(tag)) >>> 0);
  /** Box-Muller. Rejects exact zeroes so log() never blows up. */
  function gauss(rnd) {
    let u = 0, v = 0;
    while (!u) u = rnd();
    while (!v) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
  function weightedPick(rnd, arr, wf) {
    const w = arr.map((x) => Math.max(0, wf(x)));
    const total = sum(w);
    if (total <= 0) return arr.length ? arr[0] : null;
    let r = rnd() * total;
    for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  }
  S.mulberry32 = mulberry32; S.hashStr = hashStr; S.stream = stream; S.gauss = gauss;

  /* ------------------------------------------------------------- currency */
  // dnd5e coin, as integer copper. gp is only ever a display unit.
  const CP = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
  const DENOMS = ["pp", "gp", "ep", "sp", "cp"];
  S.CP = CP;

  const toCp = (c) => Math.round((c?.pp || 0) * 1000 + (c?.gp || 0) * 100 +
                                 (c?.ep || 0) * 50 + (c?.sp || 0) * 10 + (c?.cp || 0));
  S.toCp = toCp;

  function fmtCp(cp) {
    cp = Math.round(cp || 0);
    if (cp <= 0) return "0 gp";
    const gp = Math.floor(cp / 100), sp = Math.floor((cp % 100) / 10), c = cp % 10;
    if (gp >= 1000) return `${gp.toLocaleString()} gp`;
    const parts = [];
    if (gp) parts.push(`${gp} gp`);
    if (sp) parts.push(`${sp} sp`);
    if (c) parts.push(`${c} cp`);
    return parts.slice(0, 2).join(" ") || "0 gp";
  }
  S.fmtCp = fmtCp;

  /** Spend copper keeping coin shape; null when the purse cannot cover it. */
  function spendCp(cur, cost) {
    cost = Math.round(cost);
    if (cost <= 0) return { ...cur };
    if (toCp(cur) < cost) return null;
    const out = {}; for (const d of DENOMS) out[d] = Math.max(0, Math.round(cur?.[d] || 0));
    let left = cost;
    for (const d of ["cp", "sp", "ep", "gp", "pp"]) {
      const take = Math.min(out[d], Math.floor(left / CP[d]));
      out[d] -= take; left -= take * CP[d];
    }
    if (left > 0) {
      for (const d of ["sp", "ep", "gp", "pp"]) {
        while (left > 0 && out[d] > 0) { out[d]--; left -= CP[d]; }
        if (left <= 0) break;
      }
    }
    if (left > 0) return null;
    if (left < 0) {
      let change = -left;
      for (const d of ["gp", "sp", "cp"]) {
        const n = Math.floor(change / CP[d]); out[d] += n; change -= n * CP[d];
      }
    }
    return out;
  }
  function gainCp(cur, cp) {
    const out = {}; for (const d of DENOMS) out[d] = Math.max(0, Math.round(cur?.[d] || 0));
    let r = Math.round(cp);
    for (const d of ["gp", "sp", "cp"]) { const n = Math.floor(r / CP[d]); out[d] += n; r -= n * CP[d]; }
    return out;
  }
  S.spendCp = spendCp; S.gainCp = gainCp;

  /* ---------------------------------------------------------------- obols */
  /**
   * The house token. 100 ØB costs 10 gp (1000 cp) and returns 9.80 gp (980 cp).
   * Rounding goes the house's way in both directions — which INVERTS the edge
   * at tiny sizes, so a minimum lot is not decoration. See selftest().
   */
  const OBOL = { buyCpPer100: 1000, sellCpPer100: 980, minLot: 10 };
  S.OBOL = OBOL;
  const cpForObols  = (n, cfg) => Math.ceil (n * (cfg?.buyCpPer100  ?? OBOL.buyCpPer100)  / 100);
  const cpFromObols = (n, cfg) => Math.floor(n * (cfg?.sellCpPer100 ?? OBOL.sellCpPer100) / 100);
  S.cpForObols = cpForObols; S.cpFromObols = cpFromObols;

  /** Heat widens the cash-out spread; it never touches the buy-in. */
  function cashOutCp(obols, heat, cfg) {
    const tier = heatTier(heat).idx;                      // 0..4
    const per100 = (cfg?.sellCpPer100 ?? OBOL.sellCpPer100) - tier * 5;   // -0.5% per tier
    return Math.floor(obols * per100 / 100);
  }
  S.cashOutCp = cashOutCp;

  const fmtOb = (n) => `${Math.round(n || 0).toLocaleString()} ØB`;
  const fmtSigned = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(Math.round(n || 0)).toLocaleString();
  S.fmtOb = fmtOb; S.fmtSigned = fmtSigned;

  /* ----------------------------------------------------------------- heat */
  const HEAT_TIERS = [
    { idx: 0, min: 0,  label: "CLEAN",   color: "#57d38c" },
    { idx: 1, min: 20, label: "NOTICED", color: "#38e1c4" },
    { idx: 2, min: 40, label: "MARKED",  color: "#f2b03d" },
    { idx: 3, min: 60, label: "HUNTED",  color: "#ff8a4d" },
    { idx: 4, min: 80, label: "BURNED",  color: "#e0454d" },
  ];
  function heatTier(heat) {
    const h = clamp(Number(heat) || 0, 0, 100);
    let out = HEAT_TIERS[0];
    for (const t of HEAT_TIERS) if (h >= t.min) out = t;
    return out;
  }
  S.HEAT_TIERS = HEAT_TIERS; S.heatTier = heatTier;

  /** What Heat forbids. Pure, so both the UI and the GM validator use one copy. */
  function heatLimits(heat) {
    const t = heatTier(heat).idx;
    return {
      tier: t,
      maxStakeOb: [100000, 50000, 20000, 8000, 0][t],
      maxCashOutOb: [Infinity, Infinity, Infinity, 1000, 0][t],
      iceRunBlocked: t >= 2,
      walletFrozen: t >= 4,
    };
  }
  S.heatLimits = heatLimits;

  /* =================================================================== */
  /* ======================= MARKET SIMULATION ========================= */
  /* =================================================================== */

  /**
   * Every tunable in one object so the preview's MARKET MATH tab can sweep
   * them and the selftest can assert what they produce.
   */
  const M = {
    drift: 0.0004,          // ~+10% over 250 days: being long should just about pay
    idxLoad: 0.032,
    idxLevel: 0.003,
    levelCap: 0.010,   // hard ceiling on the sustained tilt, per day         // a 1-sigma index day moves a beta-1 listing ~2%
    sectLoad: 0.020,
    mom: 0.10,              // trend readable, not free
    momLambda: 0.75,
    mrev: 0.020,            // ~20-day half-life back to fair
    jumpP: 0.004,           // per listing per day -> ~1 board-wide swan a month
    jumpBase: 0.12,
    jumpScale: 0.25,
    fairDrift: 0.0003,
    fairIdxLoad: 0.016,
    fairIdxLevel: 0.012,
    fairNoise: 0.020,
    sectKappa: 0.15,
    sectSigma: 0.90,
    facKappa: 0.08,
    facSigma: 0.30,
    facFavour: 0.15,
    aggrKappa: 0.12,
    aggrSigma: 0.35,
    idxClamp: 3.5,
    muClamp: 2.0,
    priceMin: 1,
    priceMax: 5000000,
    // solvency
    healKappa: 0.030,
    healR20: 0.030,
    healSect: 0.008,
    healDeadBelow: 0.04,
    healDeadDays: 2,
    liqMax: 0.15,
    // death cadence policing
    droughtDays: 20,
    droughtBleed: 0.045,
    clusterDays: 5,
    ipoLagMin: 1, ipoLagMax: 3,
    minLive: 8,
    deadOnScreenDays: 30,
    // events
    eventP: 0.35,
    leadMin: 3, leadMax: 8,
    noiseRumoursPerDay: 0.45,
    // the Syndicate
    pumpEveryDays: 12,
    pumpRunMin: 3, pumpRunMax: 5,
    pumpDrift: 0.010,
    pumpDumpMin: 0.10, pumpDumpMax: 0.22,
    histCap: 120,
  };
  S.M = M;

  const dot = (beta, d) => {
    let t = 0;
    for (const k in beta) t += (beta[k] || 0) * (d[k] || 0);
    return t;
  };

  /* ---------------------------------------------------------- latent init */
  /** Build the hidden model state for day 0 from the generated content file. */
  function initLatent(content, seed) {
    const rnd = stream(seed, "init");
    const sect = {};
    for (const s of content.sectors) sect[s.id] = 0.30 * gauss(rnd);
    const fac = {};
    for (const f of content.factions) {
      fac[f.id] = { power: f.basePower || 0, aggression: f.baseAggression || 0, favour: 0 };
    }
    const mu = indexTargets(fac, {});
    const idx = {};
    for (const m of content.indices) idx[m.id] = (mu[m.id] || 0) + 0.35 * gauss(rnd);
    // Baseline conditions, with the party at neutral standing everywhere. The
    // level tilt is measured against THIS, so a permanently belligerent galaxy
    // is priced in and only real change moves fair value.
    const baseMu = { ...mu };
    const lst = {};
    const live = content.companies.filter((c) => c.start);
    for (const c of live) {
      lst[c.id] = {
        price: c.open,
        logFair: Math.log(c.open),
        mom: 0,
        health: c.health ?? 0.7,
        frail: 0,
        hist: [c.open],
        listedDay: 0,
      };
    }
    return {
      day: 0, idx, sect, fac, lst, baseMu,
      sched: [], rum: {}, srcAcc: initSourceAccuracy(content, seed),
      pump: null, lastDeath: 0, lastDeathAt: -999,
      ipoQueue: [], usedCompanies: live.map((c) => c.id),
      rumSeq: 0, evSeq: 0,
    };
  }
  S.initLatent = initLatent;

  function initSourceAccuracy(content, seed) {
    const out = {};
    for (const s of content.sources) {
      const rnd = stream(seed, "src:" + s.id);
      out[s.id] = clamp((s.accLo ?? 0.30) + rnd() * ((s.accHi ?? 0.85) - (s.accLo ?? 0.30)), 0.05, 0.95);
    }
    return out;
  }

  /* --------------------------------------------------------- index drivers */
  /**
   * Where each index is being PULLED. This is the join between the campaign and
   * the market: faction favour tracks the party's real standing, so angering
   * the Directorate really does lift war risk, which really does lift arms.
   */
  function indexTargets(fac, idx) {
    const g = (id, k) => (fac[id] && fac[id][k]) || 0;
    const war = 0.9 * g("iron-directorate", "aggression")
              + 0.5 * g("apostles-threshold", "aggression")
              - 0.6 * g("sovereign-horizon", "power");
    const law = 0.8 * g("iron-directorate", "power")
              + 0.5 * g("frostwatch", "power")
              - 0.7 * g("syndicate", "power");
    const rift = 1.1 * g("apostles-threshold", "favour");
    const trade = 0.7 * g("sovereign-horizon", "power") - 0.5 * war - 0.4 * law;
    const relic = 0.6 * (idx.rift || 0) + 0.5 * g("apostles-threshold", "favour");
    const c = (x) => clamp(x, -M.muClamp, M.muClamp);
    return { war: c(war), rift: c(rift), trade: c(trade), law: c(law), relic: c(relic) };
  }
  S.indexTargets = indexTargets;

  /**
   * Faction standing arrives as -10..+10 from the politics module, or null when
   * that module is disabled — in which case every faction sits at zero and the
   * caller is told, so the terminal can say so instead of drawing a confidently
   * wrong chart.
   */
  function tickFactions(latent, content, seed, standing) {
    const out = {};
    for (const f of content.factions) {
      const rnd = stream(seed, "fac:" + f.id);
      const cur = latent.fac[f.id] || { power: 0, aggression: 0, favour: 0 };
      const st = (standing && Number(standing[f.id])) || 0;
      const favour = cur.favour + M.facFavour * (st / 10 - cur.favour);
      const aggression = clamp(
        cur.aggression + M.aggrKappa * ((f.baseAggression || 0) - cur.aggression)
        + M.aggrSigma * gauss(rnd) + 0.25 * Math.max(0, -favour), -3, 3);
      const power = clamp(
        cur.power + M.facKappa * ((f.basePower || 0) - cur.power) + M.facSigma * gauss(rnd), -3, 3);
      out[f.id] = { power, aggression, favour };
    }
    return out;
  }

  function tickIndices(latent, content, seed, fac) {
    const mu = indexTargets(fac, latent.idx);
    const out = {};
    for (const m of content.indices) {
      const rnd = stream(seed, "idx:" + m.id);
      const x = latent.idx[m.id] || 0;
      const jump = rnd() < m.pJump ? m.jumpSigma * gauss(rnd) : 0;
      out[m.id] = clamp(x + m.kappa * ((mu[m.id] || 0) - x) + m.sigma * gauss(rnd) + jump,
                        -M.idxClamp, M.idxClamp);
    }
    return out;
  }

  function tickSectors(latent, content, seed) {
    const out = {};
    for (const s of content.sectors) {
      const rnd = stream(seed, "sect:" + s.id);
      const x = latent.sect[s.id] || 0;
      out[s.id] = clamp(x + M.sectKappa * (0 - x) + M.sectSigma * gauss(rnd), -3, 3);
    }
    return out;
  }

  /* ------------------------------------------------------------ the tick */
  /**
   * One in-fiction day. Pure and deterministic in (latent, seed), so the GM can
   * preview a day, re-roll it once, and only then commit.
   *
   * Returns { latent, published, report } — `published` is the ONLY thing that
   * may be written to a world setting. `report` is for the GM's preview panel.
   */
  function tickDay(latent, content, seed, opts) {
    const o = opts || {};
    const standing = o.standing || null;
    const L = JSON.parse(JSON.stringify(latent));
    const day = L.day + 1;
    const byId = indexContent(content);

    const fac = tickFactions(L, content, seed, standing);
    const idx = tickIndices(L, content, seed, fac);
    const sect = tickSectors(L, content, seed);
    const dIdx = {}; for (const k in idx) dIdx[k] = idx[k] - (L.idx[k] || 0);
    const dSect = {}; for (const k in sect) dSect[k] = sect[k] - (L.sect[k] || 0);

    /* --- events: fire what is due today ------------------------------- */
    const fired = [];
    const shockPx = {}, shockHealth = {};
    const stillPending = [];
    for (const ev of L.sched) {
      if (ev.day > day) { stillPending.push(ev); continue; }
      if (ev.day < day) continue;                       // stale; drop
      fired.push(ev);
      for (const t of ev.targets || []) {
        shockPx[t] = (shockPx[t] || 0) + ev.mag * (ev.dir || 1);
        shockHealth[t] = (shockHealth[t] || 0) + (ev.damage || 0);
      }
      if (ev.sector) for (const c of content.companies) {
        if (c.sector === ev.sector && L.lst[c.id] && !(ev.targets || []).includes(c.id)) {
          shockPx[c.id] = (shockPx[c.id] || 0) + ev.mag * (ev.dir || 1) * 0.35;
        }
      }
      if (ev.indexDelta) for (const k in ev.indexDelta) {
        if (idx[k] != null) idx[k] = clamp(idx[k] + ev.indexDelta[k], -M.idxClamp, M.idxClamp);
      }
    }
    L.sched = stillPending;

    /* --- the Syndicate ------------------------------------------------ */
    const pumpRnd = stream(seed, "pump");
    let pumpBias = {}, pumpDump = {};
    if (L.pump) {
      if (day <= L.pump.endDay) pumpBias[L.pump.target] = M.pumpDrift;
      if (day === L.pump.endDay + 1) {
        pumpDump[L.pump.target] = -(M.pumpDumpMin + pumpRnd() * (M.pumpDumpMax - M.pumpDumpMin));
        L.pump = null;
      }
    }
    if (!L.pump && day - (L.lastPumpAt || -99) >= M.pumpEveryDays && pumpRnd() < 0.35) {
      const liveIds = Object.keys(L.lst);
      if (liveIds.length) {
        const target = pick(pumpRnd, liveIds);
        const run = M.pumpRunMin + Math.floor(pumpRnd() * (M.pumpRunMax - M.pumpRunMin + 1));
        L.pump = { target, startDay: day, endDay: day + run };
        L.lastPumpAt = day;
        pumpBias[target] = M.pumpDrift;
      }
    }

    /* --- prices ------------------------------------------------------- */
    for (const id of Object.keys(L.lst)) {
      const c = byId.company[id];
      const ln = L.lst[id];
      if (!c) continue;
      const rnd = stream(seed, "px:" + id + ":" + day);
      const beta = byId.sector[c.sector]?.beta || {};
      const bDot = dot(beta, dIdx);

      // Two index terms, doing different jobs: the CHANGE gives the day its
      // news, and the LEVEL gives a persistently dangerous galaxy a persistent
      // tilt. The second one is what makes faction standing worth caring about.
      const dev = {};
      for (const k in idx) dev[k] = idx[k] - ((L.baseMu || {})[k] || 0);
      // Capped. Uncapped, a high-beta listing in a sector whose index parked far
      // from baseline compounded ~3%/day for months and finished 22x the board.
      const bLevel = clamp(dot(beta, dev), -M.levelCap / M.idxLevel, M.levelCap / M.idxLevel);
      ln.logFair += M.fairDrift + M.fairIdxLoad * bDot + M.fairIdxLevel * bLevel
                  + M.fairNoise * gauss(rnd);

      let r = M.drift
            + M.idxLoad * bDot
            + M.idxLevel * bLevel
            + M.sectLoad * (dSect[c.sector] || 0)
            + M.mom * ln.mom
            + M.mrev * (ln.logFair - Math.log(ln.price))
            + (c.idio || 0.030) * gauss(rnd);
      if (rnd() < M.jumpP) {
        r += (rnd() < 0.5 ? -1 : 1) * (M.jumpBase + M.jumpScale * Math.abs(gauss(rnd)));
      }
      r += shockPx[id] || 0;
      r += pumpBias[id] || 0;
      r += pumpDump[id] || 0;

      const prev = ln.price;
      ln.price = clamp(Math.round(prev * Math.exp(r)), M.priceMin, M.priceMax);
      ln.mom = M.momLambda * ln.mom + (1 - M.momLambda) * r;
      ln.hist = (ln.hist || []).concat([ln.price]).slice(-M.histCap);

      const back = ln.hist.length > 20 ? ln.hist[ln.hist.length - 21] : ln.hist[0];
      const r20 = Math.log(ln.price / Math.max(1, back));
      // Health mean-reverts to a leverage-dependent equilibrium. Without the
      // reversion term the overlapping 20-day window made health a near-random
      // walk and half the board died every year.
      const equil = clamp(0.88 - 0.30 * (c.leverage || 0.5), 0.20, 0.95);
      ln.health = clamp(ln.health + M.healKappa * (equil - ln.health)
                        + M.healR20 * r20
                        + M.healSect * (sect[c.sector] || 0)
                        - (shockHealth[id] || 0), 0, 1);
    }

    /* --- death cadence policing --------------------------------------- */
    // A market where nothing ever dies is a savings account; one where three die
    // in a week is a joke. Both ends are policed rather than hoped for.
    if (day - (L.lastDeathAt || 0) > M.droughtDays) {
      let weakest = null;
      for (const id of Object.keys(L.lst)) {
        if (!weakest || L.lst[id].health < L.lst[weakest].health) weakest = id;
      }
      if (weakest) L.lst[weakest].health = Math.max(0, L.lst[weakest].health - M.droughtBleed);
    }

    /* --- delisting ---------------------------------------------------- */
    const deaths = [];
    for (const id of Object.keys(L.lst)) {
      // Recomputed inside the loop on purpose: two listings dying on the SAME
      // day both saw a stale flag when this was hoisted, and the board emptied.
      const clustered = day - (L.lastDeathAt || -999) < M.clusterDays;
      const ln = L.lst[id];
      const catastrophic = (shockHealth[id] || 0) >= 0.5;
      if (ln.health < M.healDeadBelow) ln.frail = (ln.frail || 0) + 1; else ln.frail = 0;
      const doomed = catastrophic || ln.frail >= M.healDeadDays;
      if (!doomed) continue;
      if (clustered && !catastrophic) { ln.health = M.healDeadBelow + 0.02; ln.frail = 0; continue; }
      const rnd = stream(seed, "die:" + id + ":" + day);
      const frac = clamp(M.liqMax * (ln.health / M.healDeadBelow) + 0.02 * gauss(rnd), 0, M.liqMax);
      deaths.push({
        id, ticker: byId.company[id]?.ticker || id, name: byId.company[id]?.name || id,
        day, lastClose: ln.price, payoutFrac: r2(frac),
        epitaph: epitaphFor(byId.company[id], content, ln, stream(seed, "epi:" + id)),
        median60: median((ln.hist || []).slice(-60)),
      });
      delete L.lst[id];
      L.lastDeathAt = day;
    }

    /* --- IPOs --------------------------------------------------------- */
    for (const d of deaths) {
      const rnd = stream(seed, "ipo:" + d.id);
      const heir = pickSuccessor(byId.company[d.id], content, L, rnd);
      if (!heir) continue;
      L.ipoQueue.push({
        companyId: heir.id, day: day + M.ipoLagMin + Math.floor(rnd() * (M.ipoLagMax - M.ipoLagMin + 1)),
        bornFrom: d.id, bornFromName: d.name, openPx: Math.max(1, Math.round(d.median60 || d.lastClose)),
      });
      L.usedCompanies.push(heir.id);
    }
    const listed = [];
    L.ipoQueue = L.ipoQueue.filter((q) => {
      if (q.day > day) return true;
      const c = byId.company[q.companyId];
      if (!c) return false;
      L.lst[c.id] = {
        price: q.openPx, logFair: Math.log(q.openPx), mom: 0,
        health: 0.75, frail: 0, hist: [q.openPx], listedDay: day,
      };
      listed.push({ id: c.id, ticker: c.ticker, name: c.name, openPx: q.openPx,
                    bornFrom: q.bornFrom, bornFromName: q.bornFromName });
      return false;
    });
    // Never let the board fall below the minimum: an eight-line exchange with
    // five lines on it reads as broken, not as dramatic.
    while (Object.keys(L.lst).length < M.minLive) {
      const rnd = stream(seed, "fill:" + Object.keys(L.lst).length + ":" + day);
      const heir = pickSuccessor(null, content, L, rnd);
      if (!heir) break;
      const open = Math.max(1, Math.round(heir.open || 300));
      L.lst[heir.id] = { price: open, logFair: Math.log(open), mom: 0, health: 0.75,
                         frail: 0, hist: [open], listedDay: day };
      L.usedCompanies.push(heir.id);
      listed.push({ id: heir.id, ticker: heir.ticker, name: heir.name, openPx: open,
                    bornFrom: null, bornFromName: null });
    }

    /* --- schedule tomorrow's trouble ---------------------------------- */
    const schedRnd = stream(seed, "sched:" + day);
    if (schedRnd() < M.eventP) {
      const ev = rollEvent(content, L, idx, schedRnd, day);
      if (ev) L.sched.push(ev);
    }

    /* --- rumours ------------------------------------------------------ */
    const wire = [];
    const rumRnd = stream(seed, "rum:" + day);
    for (const ev of L.sched) {
      const lead = ev.day - day;
      if (lead < 1 || lead > 3) continue;
      if (ev.rumoursOut >= 3) continue;
      if (rumRnd() > 0.75) continue;
      const src = weightedPick(rumRnd, content.sources, (s) => (s.weight ?? 1));
      const item = makeRumour(L, content, ev, src, day, rumRnd, true);
      wire.push(item.pub); L.rum[item.pub.id] = item.sec;
      ev.rumoursOut = (ev.rumoursOut || 0) + 1;
    }
    let noise = M.noiseRumoursPerDay;
    while (noise > 0) {
      if (noise < 1 && rumRnd() > noise) break;
      noise -= 1;
      const src = weightedPick(rumRnd, content.sources, (s) => (s.weight ?? 1));
      const item = makeRumour(L, content, null, src, day, rumRnd, false);
      if (item) { wire.push(item.pub); L.rum[item.pub.id] = item.sec; }
    }
    if (L.pump) {
      // Plants go through a HIGH-reputation source on purpose. It is the only
      // thing in the model that punishes trusting a track record blindly.
      const good = content.sources.filter((s) => (L.srcAcc[s.id] || 0) >= 0.6);
      if (good.length && rumRnd() < 0.7) {
        const src = pick(rumRnd, good);
        const item = makePumpRumour(L, content, src, day, rumRnd);
        if (item) { wire.push(item.pub); L.rum[item.pub.id] = item.sec; }
      }
    }

    /* --- resolve rumours whose moment has passed ---------------------- */
    const resolved = [];
    for (const [rid, sec] of Object.entries(L.rum)) {
      if (sec.resolved || day < sec.resolvesOn) continue;
      sec.resolved = true;
      resolved.push({ id: rid, srcId: sec.srcId, hit: !!sec.truth });
    }
    // Forget rumours nobody can act on any more; the wire is capped anyway.
    for (const [rid, sec] of Object.entries(L.rum)) {
      if (sec.resolved && day - sec.day > 45) delete L.rum[rid];
    }

    /* --- headlines for what actually happened ------------------------- */
    for (const ev of fired) {
      wire.push({
        id: `h${day}-${ev.id}`, day, kind: "headline", src: "the-net",
        text: ev.headline, tags: ev.targets || [], dir: ev.dir || 1, resolved: true, hit: true,
      });
    }
    for (const d of deaths) {
      wire.push({
        id: `o${day}-${d.id}`, day, kind: "obituary", src: "the-net",
        text: `${d.name} (${d.ticker}) delisted. ${d.epitaph} Holders paid ${Math.round(d.payoutFrac * 100)} on the hundred.`,
        tags: [d.id], dir: -1, resolved: true, hit: true,
      });
    }
    for (const l of listed) {
      wire.push({
        id: `i${day}-${l.id}`, day, kind: "headline", src: "the-net",
        text: l.bornFromName
          ? `${l.name} (${l.ticker}) lists at ${l.openPx} ØB on the back of the ${l.bornFromName} receivership.`
          : `${l.name} (${l.ticker}) opens on the board at ${l.openPx} ØB.`,
        tags: [l.id], dir: 1, resolved: true, hit: true,
      });
    }

    L.day = day; L.idx = idx; L.sect = sect; L.fac = fac;

    return {
      latent: L,
      published: publish(L, content, { standingKnown: !!standing }),
      wire,
      resolved,
      report: {
        day, fired: fired.map((e) => ({ id: e.id, headline: e.headline, targets: e.targets })),
        deaths, listed,
        pending: L.sched.map((e) => ({ id: e.id, day: e.day, headline: e.headline })),
        pump: L.pump ? { ...L.pump, name: byId.company[L.pump.target]?.name } : null,
        movers: topMovers(L, byId),
      },
    };
  }
  S.tickDay = tickDay;

  /* ------------------------------------------------------------ helpers */
  function indexContent(content) {
    const company = {}, sector = {}, source = {};
    for (const c of content.companies) company[c.id] = c;
    for (const s of content.sectors) sector[s.id] = s;
    for (const s of content.sources) source[s.id] = s;
    return { company, sector, source };
  }
  S.indexContent = indexContent;

  function median(a) {
    if (!a || !a.length) return 0;
    const b = a.slice().sort((x, y) => x - y);
    const m = Math.floor(b.length / 2);
    return b.length % 2 ? b[m] : Math.round((b[m - 1] + b[m]) / 2);
  }

  function topMovers(L, byId) {
    const out = [];
    for (const [id, ln] of Object.entries(L.lst)) {
      const h = ln.hist || [];
      if (h.length < 2) continue;
      const pct = (h[h.length - 1] / h[h.length - 2] - 1) * 100;
      out.push({ id, ticker: byId.company[id]?.ticker || id, pct: r2(pct) });
    }
    return out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 4);
  }

  /** Coarse solvency band. A hint, never an oracle. */
  const HEALTH_BANDS = [
    { min: 0.55, label: "SOLID",       color: "#57d38c" },
    { min: 0.30, label: "STRAINED",    color: "#f2b03d" },
    { min: 0.12, label: "DISTRESSED",  color: "#ff8a4d" },
    { min: 0,    label: "TERMINAL",    color: "#e0454d" },
  ];
  function healthBand(h) {
    for (const b of HEALTH_BANDS) if (h >= b.min) return b;
    return HEALTH_BANDS[HEALTH_BANDS.length - 1];
  }
  S.healthBand = healthBand; S.HEALTH_BANDS = HEALTH_BANDS;

  /**
   * The public projection. Anything not built here never reaches a player, and
   * check_sundowner.js asserts exactly that against an allowlist.
   */
  function publish(L, content, meta) {
    const byId = indexContent(content);
    const listings = [];
    for (const [id, ln] of Object.entries(L.lst)) {
      const c = byId.company[id];
      if (!c) continue;
      const h = ln.hist || [ln.price];
      listings.push({
        id, ticker: c.ticker, name: c.name, sector: c.sector,
        sectorName: byId.sector[c.sector]?.name || c.sector,
        blurb: c.blurb || "",
        price: ln.price,
        prev: h.length > 1 ? h[h.length - 2] : ln.price,
        band: healthBand(ln.health).label,
        depth: c.depth || 800,
        hist: h.slice(-M.histCap),
        listedDay: ln.listedDay || 0,
      });
    }
    listings.sort((a, b) => a.ticker.localeCompare(b.ticker));
    const indices = {};
    for (const m of content.indices) {
      indices[m.id] = Math.round(clamp((L.idx[m.id] + M.idxClamp) / (2 * M.idxClamp), 0, 1) * 100);
    }
    return {
      day: L.day, listings, indices,
      standingKnown: !!(meta && meta.standingKnown),
      ipoQueue: L.ipoQueue.map((q) => ({ day: q.day })),   // the WHEN is public, the WHO is not
    };
  }
  S.publish = publish;

  function epitaphFor(company, content, ln, rnd) {
    const pool = (content.epitaphs || []).filter(
      (e) => e.sector === "*" || e.sector === (company && company.sector));
    if (!pool.length) return "Receivers appointed. The book was sold for scrap.";
    const t = pick(rnd, pool);
    return String(t.text || "").replace(/\{name\}/g, company?.name || "The company");
  }

  /**
   * Who inherits. Preference order: an explicit `bornFrom` link, then a sector
   * match, then anything unused — so a death usually produces a successor the
   * table can see the logic of.
   */
  function pickSuccessor(dead, content, L, rnd) {
    const used = new Set(L.usedCompanies || []);
    // Prefer a name the table has never seen; fall back to anything not
    // currently listed, so a long campaign recycles rather than starving.
    let free = content.companies.filter((c) => !c.start && !used.has(c.id));
    if (!free.length) free = content.companies.filter((c) => !L.lst[c.id]);
    if (!free.length) return null;
    if (dead) {
      const linked = free.filter((c) => (c.bornFrom || []).includes(dead.id));
      if (linked.length) return pick(rnd, linked);
      const sameSector = free.filter((c) => c.sector === dead.sector);
      if (sameSector.length) return pick(rnd, sameSector);
    }
    return pick(rnd, free);
  }

  function rollEvent(content, L, idx, rnd, day) {
    const liveIds = Object.keys(L.lst);
    if (!liveIds.length) return null;
    const usable = (content.events || []).filter((e) => eventAllowed(e, idx));
    if (!usable.length) return null;
    const t = weightedPick(rnd, usable, (e) => eventWeight(e, idx));
    if (!t) return null;
    const byId = indexContent(content);
    let targets = liveIds;
    if (t.sector) targets = liveIds.filter((id) => byId.company[id]?.sector === t.sector);
    if (!targets.length) targets = liveIds;
    const target = pick(rnd, targets);
    const c = byId.company[target];
    const mag = (t.magMin ?? 0.06) + rnd() * ((t.magMax ?? 0.35) - (t.magMin ?? 0.06));
    const fill = (s) => String(s || "")
      .replace(/\{name\}/g, c?.name || "")
      .replace(/\{ticker\}/g, c?.ticker || "")
      .replace(/\{sector\}/g, byId.sector[c?.sector]?.name || "")
      .replace(/\{place\}/g, c?.place || "the Expanse");
    L.evSeq = (L.evSeq || 0) + 1;
    return {
      id: `e${day}-${L.evSeq}`, tid: t.id, kind: t.kind || "shock",
      day: day + M.leadMin + Math.floor(rnd() * (M.leadMax - M.leadMin + 1)),
      targets: [target], sector: t.spillsToSector ? c?.sector : null,
      mag, dir: t.dir ?? (rnd() < 0.5 ? -1 : 1),
      damage: t.damage || 0,
      indexDelta: t.indexDelta || null,
      headline: fill(t.headline),
      rumourTemplates: (t.rumours || []).map(fill),
      rumoursOut: 0,
    };
  }
  function eventAllowed(t, idx) {
    for (const [k, cond] of Object.entries(t.requires || {})) {
      const v = idx[k];
      if (v == null) return false;
      const m = String(cond).match(/^([<>]=?)\s*(-?[\d.]+)$/);
      if (!m) continue;
      const n = Number(m[2]);
      if (m[1] === ">" && !(v > n)) return false;
      if (m[1] === ">=" && !(v >= n)) return false;
      if (m[1] === "<" && !(v < n)) return false;
      if (m[1] === "<=" && !(v <= n)) return false;
    }
    return true;
  }
  function eventWeight(t, idx) {
    let w = t.weight ?? 1;
    for (const [k, mult] of Object.entries(t.favours || {})) {
      w *= 1 + (mult || 0) * clamp(idx[k] || 0, -3, 3);
    }
    return Math.max(0.01, w);
  }

  function makeRumour(L, content, ev, src, day, rnd, truthy) {
    const byId = indexContent(content);
    L.rumSeq = (L.rumSeq || 0) + 1;
    const id = `r${day}-${L.rumSeq}`;
    let text, tags, dir;
    if (truthy && ev) {
      text = ev.rumourTemplates.length ? pick(rnd, ev.rumourTemplates) : ev.headline;
      tags = ev.targets.slice();
      dir = ev.dir;
    } else {
      const liveIds = Object.keys(L.lst);
      if (!liveIds.length) return null;
      const target = pick(rnd, liveIds);
      const c = byId.company[target];
      const tpl = pick(rnd, content.noiseRumours || ["Word going round about {name}."]);
      text = String(tpl)
        .replace(/\{name\}/g, c?.name || "")
        .replace(/\{ticker\}/g, c?.ticker || "")
        .replace(/\{sector\}/g, byId.sector[c?.sector]?.name || "")
        .replace(/\{place\}/g, c?.place || "the Expanse");
      tags = [target];
      dir = rnd() < 0.5 ? -1 : 1;
    }
    const voice = src?.voice ? String(src.voice).replace(/\{text\}/g, text) : text;
    return {
      pub: { id, day, kind: "rumour", src: src.id, text: voice, tags, dir, resolved: false, hit: null },
      sec: { truth: truthy ? 1 : 0, eventId: ev ? ev.id : null, srcId: src.id, day,
             resolvesOn: ev ? ev.day + 1 : day + 4, tags, dir,
             slippery: truthy ? (rnd() < 0.3 ? 1 : 0) : (rnd() < 0.5 ? 1 : 0), resolved: false },
    };
  }

  function makePumpRumour(L, content, src, day, rnd) {
    const byId = indexContent(content);
    const c = byId.company[L.pump.target];
    if (!c) return null;
    L.rumSeq = (L.rumSeq || 0) + 1;
    const id = `r${day}-${L.rumSeq}`;
    const tpl = pick(rnd, content.pumpRumours || ["Serious money is moving into {name}."]);
    const text = String(tpl).replace(/\{name\}/g, c.name).replace(/\{ticker\}/g, c.ticker);
    const voice = src?.voice ? String(src.voice).replace(/\{text\}/g, text) : text;
    return {
      pub: { id, day, kind: "rumour", src: src.id, text: voice, tags: [c.id], dir: 1,
             resolved: false, hit: null },
      sec: { truth: 0, eventId: null, srcId: src.id, day, resolvesOn: L.pump.endDay + 2,
             tags: [c.id], dir: 1, slippery: 1, resolved: false, pump: true },
    };
  }

  /* --------------------------------------------------- reading the wire */
  /**
   * An Insight/Investigation check against a rumour. A FAILED check returns a
   * near-uninformative band, never a systematically wrong one: a mechanic that
   * lies on a fail teaches players to distrust the mechanic rather than the
   * source, and that would destroy the wire.
   */
  const BANDS = [
    { min: 80, label: "CORROBORATED", color: "#57d38c" },
    { min: 60, label: "PLAUSIBLE",    color: "#38e1c4" },
    { min: 40, label: "UNREADABLE",   color: "#6f97a6" },
    { min: 20, label: "DOUBTFUL",     color: "#f2b03d" },
    { min: 0,  label: "FABRICATED",   color: "#e0454d" },
  ];
  function bandOf(pct) {
    for (const b of BANDS) if (pct >= b.min) return b;
    return BANDS[BANDS.length - 1];
  }
  function confidenceBand(total, dc, truth, srcAcc, rnd) {
    const margin = total - dc;
    const clarity = clamp(0.15 + 0.075 * margin, 0, 0.95);
    const post = truth ? 0.5 + 0.5 * srcAcc : 0.5 - 0.5 * srcAcc;
    const shown = clamp(0.5 + (post - 0.5) * clarity + (1 - clarity) * 0.16 * gauss(rnd), 0.02, 0.98);
    const pct = Math.round(shown * 100);
    return { pct, ...bandOf(pct) };
  }
  S.confidenceBand = confidenceBand; S.BANDS = BANDS;
  S.readDC = (slippery) => (slippery ? 15 : 12);

  /* =================================================================== */
  /* ============================ TRADING ============================== */
  /* =================================================================== */

  const HOUSE = {
    spreadBps: 120,      // 1.2% each way
    feeBps: 75,          // 0.75%
    feeMinOb: 5,         // floor: kills one-share churn
    slipK: 0.9,
    slipExp: 1.25,       // superlinear, so size genuinely hurts
    impact: 0.35,        // fraction of your own slippage left in the price
  };
  S.HOUSE = HOUSE;

  /**
   * A quote for `qty` shares. `depth` is per-listing: 200 shares for a junk
   * line, 4,000 for a blue chip. Buying 2,000 of a 200-depth listing costs
   * about +16%, and the confirm dialog says so — nobody gets ambushed.
   */
  function quote(listing, side, qty, cfg) {
    const h = { ...HOUSE, ...(cfg || {}) };
    const mid = Math.max(1, listing.price);
    const depth = Math.max(1, listing.depth || 800);
    const half = mid * h.spreadBps / 20000;
    const slip = mid * h.slipK * Math.pow(Math.max(0, qty) / depth, h.slipExp) / 100;
    const unit = Math.max(1, Math.round(side === "buy" ? mid + half + slip : mid - half - slip));
    const gross = unit * qty;
    const fee = Math.max(h.feeMinOb, Math.round(gross * h.feeBps / 10000));
    return {
      side, qty, unitOb: unit, grossOb: gross, feeOb: fee,
      netOb: side === "buy" ? gross + fee : gross - fee,
      slipPct: r2(slip / mid * 100),
      spreadPct: r2(half / mid * 100),
      impactOb: Math.round((side === "buy" ? 1 : -1) * slip * h.impact),
    };
  }
  S.quote = quote;

  /** What a fill leaves behind in the price. Ten lines, and it is the best
   *  gambling mechanic in the exchange: a thin line you can move is a thin
   *  line you cannot get out of. */
  function applyImpact(listing, q) {
    const next = clamp(Math.round(listing.price + q.impactOb), M.priceMin, M.priceMax);
    return Math.max(1, next);
  }
  S.applyImpact = applyImpact;

  const emptyPos = () => ({ qty: 0, costCc: 0, realisedOb: 0 });
  S.emptyPos = emptyPos;

  /** Average cost is carried in hundredths of an obol so rounding cannot drift. */
  function applyBuy(pos, qty, netOb) {
    const p = { ...emptyPos(), ...(pos || {}) };
    p.qty += qty; p.costCc += Math.round(netOb * 100);
    return p;
  }
  function applySell(pos, qty, netOb) {
    const p = { ...emptyPos(), ...(pos || {}) };
    if (qty > p.qty) return null;
    const avgCc = p.qty > 0 ? Math.round(p.costCc / p.qty) : 0;
    const realised = Math.round((netOb * 100 - avgCc * qty) / 100);
    p.realisedOb += realised;
    p.costCc -= avgCc * qty;
    p.qty -= qty;
    if (p.qty === 0) p.costCc = 0;          // absorb the rounding residue at flat
    return { pos: p, realisedOb: realised };
  }
  S.applyBuy = applyBuy; S.applySell = applySell;

  const avgCostOb = (pos) => (pos && pos.qty > 0 ? pos.costCc / pos.qty / 100 : 0);
  const unrealisedOb = (pos, price) =>
    (pos && pos.qty > 0 ? pos.qty * price - Math.round(pos.costCc / 100) : 0);
  S.avgCostOb = avgCostOb; S.unrealisedOb = unrealisedOb;

  /** Whole-portfolio P/L for the header. */
  function portfolio(user, listings) {
    const byId = {}; for (const l of listings) byId[l.id] = l;
    let value = 0, unreal = 0, real = 0, cost = 0;
    for (const [id, pos] of Object.entries(user?.pos || {})) {
      real += pos.realisedOb || 0;
      const l = byId[id];
      if (!l || !pos.qty) continue;
      value += pos.qty * l.price;
      cost += Math.round(pos.costCc / 100);
      unreal += unrealisedOb(pos, l.price);
    }
    return { valueOb: value, costOb: cost, unrealisedOb: unreal, realisedOb: real, totalOb: real + unreal };
  }
  S.portfolio = portfolio;

  /**
   * Resting orders, evaluated after the tick. A limit buy fills at or below its
   * price, a stop sell fires at or below its trigger — the stop-loss being the
   * single most useful thing to hand a player who will not be at the table for
   * a fortnight.
   */
  function orderTriggers(order, price) {
    if (order.kind === "limit") {
      return order.side === "buy" ? price <= order.priceOb : price >= order.priceOb;
    }
    if (order.kind === "stop") {
      return order.side === "buy" ? price >= order.priceOb : price <= order.priceOb;
    }
    return false;
  }
  S.orderTriggers = orderTriggers;

  /* =================================================================== */
  /* ============================== THE PIT ============================ */
  /* =================================================================== */

  /**
   * THE HANDICAP. Every check game reads your rating off the deck and prices
   * itself against it: effective DC = base + modifier - edge, where edge is
   * round(0.15 x modifier) capped at 2.
   *
   * This exists because the alternative does not work. With a flat DC, a game
   * tuned to be fair for a +2 character is a money printer for a +11 one, and
   * one tuned against +11 is unplayable for anybody else. Handicapping keeps
   * every game a losing proposition at every modifier, while still conceding a
   * real 2 points to somebody who is genuinely good at it -- which is why the
   * wizard owns the Ladder and the rogue owns the Ice Run. Payouts below are
   * priced off the BEST case (edge 2), so that is where EV peaks, at ~0.94.
   */
  const MAX_EDGE = 2;
  S.MAX_EDGE = MAX_EDGE;
  /** How many points of margin the house concedes to your rating. Capped, or a
   *  high-level specialist walks off with the building. */
  const edgeFor = (mod) => clamp(Math.round(0.15 * (Number(mod) || 0)), 0, MAX_EDGE);
  S.edgeFor = edgeFor;
  const effDC = (base, mod) => base + (Number(mod) || 0) - edgeFor(mod);
  S.effDC = effDC;

  /** Chance a d20 + mod clears an effective DC. Nat 1 always fails, nat 20 always lands. */
  function passChance(base, mod) {
    const need = effDC(base, mod) - (Number(mod) || 0);
    return clamp((21 - clamp(need, 2, 20)) / 20, 0.05, 0.95);
  }
  S.passChance = passChance;

  /* --------------------------------------------------------- the ladder */
  // Multipliers are priced off the BEST realistic case (+15), so the ceiling is
  // ~0.93 per rung for a specialist and about 0.75 for someone out of their
  // depth. Climbing is always slightly worse than banking, which is the tension.
  const LADDER = {
    mult: [1.25, 1.8, 3.1, 5.8, 13.5, 42, 195],
    dc:   [8, 10, 12, 13, 15, 17, 19],
  };
  S.LADDER = LADDER;
  function ladderOdds(mod) {
    const out = []; let cum = 1;
    for (let i = 0; i < LADDER.dc.length; i++) {
      const pass = passChance(LADDER.dc[i], mod);
      cum *= pass;
      const prevMult = i ? LADDER.mult[i - 1] : 1;
      out.push({
        rung: i + 1, mult: LADDER.mult[i], dc: effDC(LADDER.dc[i], mod),
        pass: r2(pass), cum: r2(cum),
        stepEV: r2(pass * (LADDER.mult[i] / prevMult)),
        coldEV: r2(cum * LADDER.mult[i]),
      });
    }
    return out;
  }
  S.ladderOdds = ladderOdds;

  /* ---------------------------------------------------- signal skim (WIS) */
  // Name your own difficulty. One roll, one answer.
  const SKIM = [
    { dc: 12, mult: 1.70, label: "SKIM" },
    { dc: 16, mult: 2.70, label: "DEEP READ" },
    { dc: 19, mult: 4.70, label: "FULL TRACE" },
  ];
  S.SKIM = SKIM;
  const skimEV = (dc, mult, mod) => r2(passChance(dc, mod) * mult);
  S.skimEV = skimEV;

  /* ------------------------------------------------------ cold read (CHA) */
  // Contested against the house intelligence, which is handicapped the same way.
  // The pot grows 1.8x per hand rather than doubling: at even odds, doubling is
  // a fair game, and the house does not run fair games.
  const COLD_READ = { houseBase: [1, 4, 7], potMult: 1.8, rounds: 3 };
  S.COLD_READ = COLD_READ;
  /** Exact P(d20 + mod > d20 + house) over all 400 pairs. */
  function contestChance(mod, house) {
    const d = (Number(mod) || 0) - (Number(house) || 0);
    let wins = 0;
    for (let a = 1; a <= 20; a++) wins += clamp(a + d - 1, 0, 20);
    return wins / 400;
  }
  S.contestChance = contestChance;
  /** What the machine is reading at, this hand. Handicapped like everything else. */
  const coldReadHouse = (round, mod) =>
    (COLD_READ.houseBase[round] ?? 7) + (Number(mod) || 0) - edgeFor(mod);
  S.coldReadHouse = coldReadHouse;

  /* --------------------------------------------------------- ice run (DEX) */
  // Three layers, all or nothing, and the loss is measured in Heat rather than
  // Obols -- which is the only reason the payout can be this big.
  const ICE_RUN = { layers: [11, 14, 17], mult: 11, heatOnFail: 8 };
  S.ICE_RUN = ICE_RUN;
  const iceRunOdds = (mod) => {
    let cum = 1;
    const rows = ICE_RUN.layers.map((b, i) => {
      const p = passChance(b, mod); cum *= p;
      return { layer: i + 1, dc: effDC(b, mod), pass: r2(p), cum: r2(cum) };
    });
    return { rows, ev: r2(cum * ICE_RUN.mult) };
  };
  S.iceRunOdds = iceRunOdds;

  /* --------------------------------------------------------------- voidfall */
  /**
   * The crash curve. 3% instant bust, then 0.97/(1-u): a ~3% house edge at every
   * cash-out target, a median around 1.94x, and a one-in-a-hundred run past 97x.
   */
  function crashPoint(u) {
    if (u < 0.03) return 1.00;
    return Math.max(1.01, Math.floor(100 * 0.97 / (1 - u)) / 100);
  }
  S.crashPoint = crashPoint;
  const CRASH_GROWTH = 1.06;                 // per second: 2x at ~12s, 10x at ~40s
  S.CRASH_GROWTH = CRASH_GROWTH;
  const crashMultAt = (ms) => Math.pow(CRASH_GROWTH, Math.max(0, ms) / 1000);
  const crashMsFor = (mult) => Math.log(Math.max(1, mult)) / Math.log(CRASH_GROWTH) * 1000;
  S.crashMultAt = crashMultAt; S.crashMsFor = crashMsFor;

  /* -------------------------------------------------------- hollow roulette */
  // 37 pockets. Pocket 0 is The Hollow and it takes everything on the table --
  // which is exactly the 2.7% house edge a real single-zero wheel runs on.
  const ROULETTE = {
    pockets: 37,
    bets: {
      single: { pays: 35, test: (p, arg) => p === Number(arg) },
      rift:   { pays: 1,  test: (p) => p > 0 && p % 2 === 1 },
      voidc:  { pays: 1,  test: (p) => p > 0 && p % 2 === 0 },
      low:    { pays: 1,  test: (p) => p >= 1 && p <= 18 },
      high:   { pays: 1,  test: (p) => p >= 19 && p <= 36 },
      dozen1: { pays: 2,  test: (p) => p >= 1 && p <= 12 },
      dozen2: { pays: 2,  test: (p) => p >= 13 && p <= 24 },
      dozen3: { pays: 2,  test: (p) => p >= 25 && p <= 36 },
    },
  };
  S.ROULETTE = ROULETTE;
  function rouletteResolve(pocket, betKey, arg, stakeOb) {
    const b = ROULETTE.bets[betKey];
    if (!b) return { win: false, payoutOb: 0, hollow: pocket === 0 };
    const win = pocket !== 0 && b.test(pocket, arg);
    return { win, payoutOb: win ? stakeOb * (b.pays + 1) : 0, hollow: pocket === 0, pays: b.pays };
  }
  S.rouletteResolve = rouletteResolve;
  /** Analytic EV of a roulette bet, for the self-test. */
  function rouletteEV(betKey) {
    const b = ROULETTE.bets[betKey];
    if (!b) return 0;
    let wins = 0;
    for (let p = 1; p <= 36; p++) if (b.test(p, 7)) wins++;
    if (betKey === "single") wins = 1;
    return r2(wins / ROULETTE.pockets * (b.pays + 1));
  }
  S.rouletteEV = rouletteEV;

  /* --------------------------------------------------------------- pit wagers */
  /**
   * Two fighters, resolved round by round. Odds come from simulating the bout
   * many times with the SAME pure function that later narrates the real one, so
   * the published odds are honest before the house takes its shade.
   */
  function fightRound(a, b, rnd) {
    const hit = (atk, def) => {
      const roll = Math.floor(rnd() * 20) + 1;
      if (roll === 1) return 0;
      if (roll === 20) return Math.round(atk.dmg * 2);
      return roll + atk.atk >= def.ac ? Math.max(1, Math.round(atk.dmg * (0.6 + rnd() * 0.8))) : 0;
    };
    return { aDmg: hit(a, b), bDmg: hit(b, a) };
  }
  function simulateFight(a, b, seed, narrate) {
    const rnd = mulberry32(seed >>> 0);
    let ah = a.hp, bh = b.hp;
    const log = [];
    for (let round = 1; round <= 30; round++) {
      const { aDmg, bDmg } = fightRound(a, b, rnd);
      bh -= aDmg; ah -= bDmg;
      if (narrate) {
        log.push({ round, a: aDmg, b: bDmg, ah: Math.max(0, ah), bh: Math.max(0, bh) });
      }
      if (ah <= 0 || bh <= 0) break;
    }
    const winner = bh <= 0 && ah > 0 ? "a" : ah <= 0 && bh > 0 ? "b" : (ah >= bh ? "a" : "b");
    return { winner, log, ah: Math.max(0, ah), bh: Math.max(0, bh) };
  }
  S.simulateFight = simulateFight;

  /** True win probability, then the published decimal odds with the house shade. */
  function fightOdds(a, b, seed, runs) {
    const n = runs || 1500;
    let aWins = 0;
    for (let i = 0; i < n; i++) if (simulateFight(a, b, (seed ^ (i * 2654435761)) >>> 0, false).winner === "a") aWins++;
    const pa = clamp(aWins / n, 0.02, 0.98);
    const shade = 0.95;
    return {
      pA: r2(pa), pB: r2(1 - pa),
      oddsA: r2(Math.max(1.02, shade / pa)),
      oddsB: r2(Math.max(1.02, shade / (1 - pa))),
    };
  }
  S.fightOdds = fightOdds;

  /* ------------------------------------------------------------ salvage chits */
  const CHIT_TIERS = [
    { id: "scrap",  name: "Scrap Chit",  costOb: 150,  label: "SCRAP" },
    { id: "bonded", name: "Bonded Chit", costOb: 600,  label: "BONDED" },
    { id: "deep",   name: "Deep Chit",   costOb: 2200, label: "DEEP" },
  ];
  S.CHIT_TIERS = CHIT_TIERS;
  /**
   * Weighted table per tier. `kind` is resolved GM-side: `item` hands off to the
   * shop module's grantItem, `tip` mints a guaranteed-true wire tip.
   */
  const CHIT_TABLE = {
    scrap:  [["junk", 40, 0.25], ["obols", 36, 1.00], ["obols", 16, 2.00], ["item", 6, 0], ["tip", 2, 0]],
    bonded: [["junk", 36, 0.28], ["obols", 34, 1.00], ["obols", 18, 1.90], ["item", 9, 0], ["tip", 3, 0]],
    deep:   [["junk", 34, 0.30], ["obols", 30, 1.00], ["obols", 18, 1.80], ["item", 14, 0], ["tip", 4, 0]],
  };
  S.CHIT_TABLE = CHIT_TABLE;
  function chitEV(tierId) {
    const rows = CHIT_TABLE[tierId] || [];
    const total = sum(rows.map((r) => r[1]));
    // `item` is valued at 1.1x the chit for EV purposes; the real prize comes
    // from the shop catalogue and varies, but the table must not be a printer.
    let ev = 0;
    for (const [kind, w, mult] of rows) {
      const m = kind === "item" ? 1.2 : kind === "tip" ? 1.2 : mult;
      ev += (w / total) * m;
    }
    return r2(ev);
  }
  S.chitEV = chitEV;

  /* ------------------------------------------------------------------- heat */
  const HEAT_EVENTS = {
    iceRunFail: 8, coldReadCaught: 4, bigWin: 5, bigCashOut: 6, insiderTiming: 7,
  };
  S.HEAT_EVENTS = HEAT_EVENTS;
  const HEAT_DECAY = 2;
  S.HEAT_DECAY = HEAT_DECAY;

  /* =================================================================== */
  /* ================================ CSS ============================== */
  /* =================================================================== */
  // A copy of the house console styling, not a dependency on it: same palette
  // and tiles as the shop and the ship HUD, but its own style id and root class
  // so neither module can break the other.
  const CSS = `
.sgsun{position:fixed;inset:0;z-index:64;display:flex;flex-direction:column;
  background:radial-gradient(1100px 640px at 78% -12%,rgba(155,74,190,.20),transparent 62%),
             radial-gradient(900px 620px at 12% 8%,rgba(29,106,134,.20),transparent 60%),#03060c;
  font-family:'Courier New',monospace;color:#cfeef0;overflow:hidden;}
.sgsun *{box-sizing:border-box;}
.sgsun .sun-top{display:flex;align-items:center;gap:12px;padding:12px 18px 10px;border-bottom:1px solid #12455a;
  background:rgba(6,14,22,.65);flex:0 0 auto;flex-wrap:wrap;}
.sgsun .sun-brand{font-size:16px;font-weight:700;letter-spacing:3px;color:#c98bff;
  text-shadow:0 0 12px rgba(201,139,255,.45);white-space:nowrap;}
.sgsun .sun-sub{font-size:11px;letter-spacing:1px;color:#6f97a6;white-space:nowrap;}
.sgsun .sun-spacer{flex:1 1 auto;min-width:8px;}
.sgsun .sun-chip{flex:0 0 auto;font-size:11px;letter-spacing:1px;color:#cfeef0;background:#0a1c26;
  border:1px solid #1d6a86;border-radius:7px;padding:5px 9px;white-space:nowrap;}
.sgsun .sun-chip b{color:#38e1c4;}
.sgsun .sun-chip.warn{border-color:#f2b03d;color:#f2b03d;}
.sgsun .sun-chip.bad{border-color:#e0454d;color:#e0454d;}
.sgsun .sun-x{flex:0 0 auto;cursor:pointer;background:#0a1c26;border:1px solid #1d6a86;color:#cfeef0;
  border-radius:7px;width:30px;height:30px;font-weight:700;font-family:inherit;}
.sgsun .sun-x:hover{border-color:#f2b03d;color:#f2b03d;}
.sgsun .sun-tabs{display:flex;gap:6px;padding:8px 18px 0;flex:0 0 auto;flex-wrap:wrap;}
.sgsun .sun-tab{font-family:inherit;font-size:12px;font-weight:700;letter-spacing:2px;cursor:pointer;
  background:#08161f;border:1px solid #12455a;border-bottom:none;color:#6f97a6;
  border-radius:8px 8px 0 0;padding:8px 16px;transition:color .12s,border-color .12s;}
.sgsun .sun-tab:hover{color:#cfeef0;border-color:#1d6a86;}
.sgsun .sun-tab.active{color:#38e1c4;border-color:#1d6a86;background:#0b1f2b;
  box-shadow:inset 0 2px 0 #38e1c4;}
.sgsun .sun-tab .dot{color:#f2b03d;}
.sgsun .sun-body{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 22px;
  border-top:1px solid #1d6a86;background:rgba(4,10,16,.5);}
.sgsun .sun-h{font-size:11px;letter-spacing:2px;color:#7fa6b4;border-bottom:1px solid #12455a;
  padding-bottom:4px;margin:2px 0 10px;}
.sgsun .sun-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;}
.sgsun .sun-col{display:flex;flex-direction:column;gap:12px;min-width:0;}
.sgsun .sun-card{background:rgba(10,26,38,.62);border:1px solid #163b4e;border-radius:11px;padding:12px 14px;
  display:flex;flex-direction:column;gap:9px;min-width:0;}
.sgsun .sun-card.accent{border-color:#5c2f7a;box-shadow:0 0 18px rgba(155,74,190,.14) inset;}
.sgsun .sun-note{font-size:11px;color:#6f97a6;letter-spacing:1px;line-height:1.5;}
.sgsun .sun-warn{font-size:12px;color:#f2b03d;letter-spacing:1px;}
.sgsun .sun-bad{color:#e0454d;}
.sgsun .sun-good{color:#57d38c;}
.sgsun .sun-btn{font-family:inherit;font-size:12px;font-weight:700;letter-spacing:1px;color:#cfeef0;
  background:#0a1c26;border:1px solid #1d6a86;border-radius:8px;padding:8px 12px;cursor:pointer;
  transition:border-color .12s,box-shadow .12s,color .12s;flex:0 0 auto;height:auto;min-height:0;
  line-height:1.2;white-space:nowrap;text-align:center;}
.sgsun .sun-btn:hover{border-color:#38e1c4;color:#38e1c4;box-shadow:0 0 12px rgba(56,225,196,.3);}
.sgsun .sun-btn.buy:hover{border-color:#57d38c;color:#57d38c;box-shadow:0 0 12px rgba(87,211,140,.3);}
.sgsun .sun-btn.sell:hover{border-color:#e0454d;color:#e0454d;box-shadow:0 0 12px rgba(224,69,77,.3);}
.sgsun .sun-btn.hot{border-color:#c98bff;color:#c98bff;}
.sgsun .sun-btn[disabled],.sgsun .sun-btn.off{opacity:.38;cursor:not-allowed;border-style:dashed;box-shadow:none;}
.sgsun .sun-in{font-family:inherit;font-size:12px;color:#cfeef0;background:#061019;border:1px solid #1d6a86;
  border-radius:7px;padding:7px 9px;min-width:0;width:110px;height:auto;}
.sgsun .sun-in:focus{outline:none;border-color:#38e1c4;}
.sgsun .sun-gauge{display:flex;flex-direction:column;gap:4px;min-width:120px;flex:1 1 130px;}
.sgsun .sun-gauge .g-l{display:flex;justify-content:space-between;font-size:10px;letter-spacing:1px;color:#6f97a6;}
.sgsun .sun-gauge .g-b{height:7px;border-radius:4px;background:#061019;border:1px solid #163b4e;overflow:hidden;}
.sgsun .sun-gauge .g-f{height:100%;background:linear-gradient(90deg,#1d6a86,#38e1c4);}
/* ---- big number header ---- */
.sgsun .sun-pl{display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;}
.sgsun .sun-pl .big{font-size:30px;font-weight:700;letter-spacing:1px;line-height:1;}
.sgsun .sun-pl .lbl{font-size:10px;letter-spacing:2px;color:#6f97a6;display:block;margin-bottom:3px;}
.sgsun .sun-pl .cell{min-width:110px;}
/* ---- listings table ---- */
.sgsun table.sun-t{width:100%;border-collapse:collapse;font-size:12px;}
.sgsun table.sun-t th{text-align:left;font-size:10px;letter-spacing:2px;color:#6f97a6;font-weight:400;
  border-bottom:1px solid #12455a;padding:5px 7px;white-space:nowrap;}
.sgsun table.sun-t td{padding:7px;border-bottom:1px solid rgba(18,69,90,.45);vertical-align:middle;}
.sgsun table.sun-t tr.pick:hover td{background:rgba(29,106,134,.16);cursor:pointer;}
.sgsun table.sun-t tr.on td{background:rgba(56,225,196,.10);}
.sgsun .tick{font-weight:700;letter-spacing:1px;color:#38e1c4;}
.sgsun .co{font-size:11px;color:#9db8c4;}
.sgsun .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
.sgsun .up{color:#57d38c;}.sgsun .dn{color:#e0454d;}.sgsun .flat{color:#6f97a6;}
.sgsun .band{font-size:10px;letter-spacing:1px;padding:2px 6px;border-radius:5px;border:1px solid currentColor;}
.sgsun .spark{display:block;}
.sgsun tr.dead td{opacity:.5;}
.sgsun tr.dead .tick{color:#6f97a6;text-decoration:line-through;}
/* ---- wire ---- */
.sgsun .wi{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid rgba(18,69,90,.45);}
.sgsun .wi .k{flex:0 0 auto;font-size:10px;letter-spacing:1px;color:#6f97a6;width:52px;padding-top:2px;}
.sgsun .wi .m{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;}
.sgsun .wi .tx{font-size:12px;line-height:1.55;color:#dbeef2;}
.sgsun .wi .me{font-size:10px;letter-spacing:1px;color:#6f97a6;display:flex;gap:10px;flex-wrap:wrap;align-items:center;}
.sgsun .wi.headline .tx{color:#f2b03d;}
.sgsun .wi.obituary .tx{color:#e0454d;}
.sgsun .src-rec{font-size:10px;letter-spacing:1px;}
/* ---- pit ---- */
.sgsun .pit-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;}
.sgsun .pit-card{background:rgba(10,26,38,.62);border:1px solid #163b4e;border-radius:11px;padding:12px;
  display:flex;flex-direction:column;gap:8px;cursor:pointer;transition:border-color .12s,box-shadow .12s;}
.sgsun .pit-card:hover{border-color:#c98bff;box-shadow:0 0 16px rgba(201,139,255,.25);}
.sgsun .pit-card.on{border-color:#38e1c4;box-shadow:0 0 16px rgba(56,225,196,.28);}
.sgsun .pit-card .ic{font-size:26px;line-height:1;}
.sgsun .pit-card .nm{font-size:13px;font-weight:700;letter-spacing:1px;color:#cfeef0;}
.sgsun .pit-card .ab{font-size:10px;letter-spacing:2px;color:#c98bff;}
.sgsun .pit-card .bl{font-size:11px;color:#7fa6b4;line-height:1.5;}
.sgsun .rung{display:flex;align-items:center;gap:10px;padding:6px 9px;border-radius:7px;
  border:1px solid #163b4e;background:#061019;font-size:12px;}
.sgsun .rung.done{border-color:#57d38c;color:#57d38c;}
.sgsun .rung.now{border-color:#f2b03d;color:#f2b03d;box-shadow:0 0 12px rgba(242,176,61,.3);}
.sgsun .crash{font-size:52px;font-weight:700;letter-spacing:2px;text-align:center;padding:14px 0;
  color:#38e1c4;text-shadow:0 0 22px rgba(56,225,196,.5);font-variant-numeric:tabular-nums;}
.sgsun .crash.blown{color:#e0454d;text-shadow:0 0 22px rgba(224,69,77,.55);}
.sgsun .wheel{display:grid;grid-template-columns:repeat(auto-fill,minmax(34px,1fr));gap:4px;}
.sgsun .pk{font-size:11px;text-align:center;padding:5px 0;border-radius:5px;border:1px solid #163b4e;
  background:#061019;cursor:pointer;}
.sgsun .pk:hover{border-color:#38e1c4;}
.sgsun .pk.on{border-color:#f2b03d;color:#f2b03d;}
.sgsun .pk.hollow{border-color:#9b4abe;color:#c98bff;}
.sgsun .fight{display:flex;gap:12px;align-items:stretch;flex-wrap:wrap;}
.sgsun .fighter{flex:1 1 180px;min-width:0;border:1px solid #163b4e;border-radius:9px;padding:10px;
  background:#061019;display:flex;flex-direction:column;gap:5px;}
.sgsun .fighter.on{border-color:#38e1c4;}
.sgsun .pbp{font-size:11px;line-height:1.6;max-height:190px;overflow:auto;color:#9db8c4;
  border:1px solid #163b4e;border-radius:7px;padding:8px;background:#040a10;}
/* ---- gm ---- */
.sgsun .gm{border-color:#f2b03d;}
.sgsun .gm .sun-h{color:#f2b03d;border-color:#5c4416;}
.sgsun .cog{cursor:pointer;background:#0a1c26;border:1px solid #5c4416;color:#f2b03d;border-radius:7px;
  padding:5px 9px;font-family:inherit;font-size:11px;font-weight:700;letter-spacing:1px;}
.sgsun .cog:hover{border-color:#f2b03d;box-shadow:0 0 10px rgba(242,176,61,.3);}
@media (max-width:900px){
  .sgsun .sun-body{padding:12px 10px 20px;}
  .sgsun .sun-top{padding:10px 10px 8px;}
  .sgsun .sun-tabs{padding:8px 10px 0;}
  .sgsun .sun-pl .big{font-size:22px;}
}
`;

  S.ensureStyles = function ensureStyles(doc) {
    const d = doc || globalThis.document;
    if (!d || d.getElementById("ssvsun-styles")) return;
    const el = d.createElement("style");
    el.id = "ssvsun-styles";
    el.textContent = CSS;
    d.head.appendChild(el);
  };

  /* =================================================================== */
  /* ============================ RENDERERS ============================ */
  /* =================================================================== */
  // Transient UI state lives here so it survives a re-render, the way the
  // journal module keeps its scroll and open-item state.
  S._tab = "wallet";
  S._sel = null;         // selected ticker on the exchange
  S._pit = null;         // open game
  S._gm = {};            // which tab's cog is open

  const pct = (a, b) => (b ? (a / b - 1) * 100 : 0);
  const cls = (n) => (n > 0.001 ? "up" : n < -0.001 ? "dn" : "flat");
  const arrow = (n) => (n > 0.001 ? "▲" : n < -0.001 ? "▼" : "■");

  /** Inline sparkline. No library, no external fetch, two themes' worth of contrast. */
  function sparkline(hist, w, h, colour) {
    const a = (hist || []).slice(-60);
    if (a.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
    const lo = Math.min(...a), hi = Math.max(...a), span = hi - lo || 1;
    const step = w / (a.length - 1);
    const pts = a.map((v, i) => `${r2(i * step)},${r2(h - ((v - lo) / span) * (h - 2) - 1)}`).join(" ");
    const c = colour || (a[a.length - 1] >= a[0] ? "#57d38c" : "#e0454d");
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
           `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.5" ` +
           `stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  S.sparkline = sparkline;

  function gauge(label, value, colour) {
    const v = clamp(Number(value) || 0, 0, 100);
    return `<div class="sun-gauge"><div class="g-l"><span>${esc(label)}</span><span>${Math.round(v)}</span></div>` +
      `<div class="g-b"><div class="g-f" style="width:${v}%;${colour ? `background:${colour};` : ""}"></div></div></div>`;
  }
  S.gauge = gauge;

  const TABS = [
    { id: "wallet",   label: "WALLET",   icon: "◈" },
    { id: "exchange", label: "EXCHANGE", icon: "▤" },
    { id: "pit",      label: "PIT",      icon: "◐" },
    { id: "wire",     label: "WIRE",     icon: "≋" },
  ];
  S.TABS = TABS;

  /* -------------------------------------------------------------- shell */
  function renderPanel(root, ctx) {
    S.ensureStyles(root.ownerDocument);
    root.className = "sgsun";
    const me = ctx.me || {};
    const cfg = ctx.cfg || {};
    const heat = heatTier(me.heat);
    const lim = heatLimits(me.heat);
    const tradesLeft = Math.max(0, (cfg.tradesPerDay ?? 5) - (me.trades || 0));
    const gamblesLeft = Math.max(0, (cfg.gamblesPerDay ?? 10) - (me.gambles || 0));

    let body;
    if (!ctx.netOpen && !ctx.isGM) {
      body = `<div class="sun-card"><div class="sun-h">NO CARRIER</div>` +
        `<div class="sun-note">The deck cannot find a node. Nothing on this band but the ring of Vorrn-7 ` +
        `chewing up the signal.<br><br>Somebody has pulled the plug, or you are simply too far out.</div></div>`;
    } else if (lim.walletFrozen && S._tab !== "wire") {
      body = `<div class="sun-card"><div class="sun-h" style="color:#e0454d;border-color:#5c1b1f">ACCOUNT FROZEN</div>` +
        `<div class="sun-note">The house has stopped taking your action. Your balance of ` +
        `<b>${fmtOb(me.ob)}</b> is still on their books, and they are still very interested in where you are.` +
        `<br><br>Somebody will have to talk to somebody.</div></div>`;
    } else {
      const fn = { wallet: renderWallet, exchange: renderExchange, pit: renderPit, wire: renderWire }[S._tab];
      body = (fn || renderWallet)(ctx);
    }

    root.innerHTML =
      `<div class="sun-top">` +
        `<div class="sun-brand">SUNDOWNER NET</div>` +
        `<div class="sun-sub">// ${ctx.netOpen ? "NODE LIVE" : "NO CARRIER"} // DAY ${ctx.day ?? 0}</div>` +
        `<div class="sun-spacer"></div>` +
        `<div class="sun-chip">◈ <b>${fmtOb(me.ob)}</b></div>` +
        `<div class="sun-chip">TRADES <b>${tradesLeft}</b>/${cfg.tradesPerDay ?? 5}</div>` +
        `<div class="sun-chip">PLAYS <b>${gamblesLeft}</b>/${cfg.gamblesPerDay ?? 10}</div>` +
        `<div class="sun-chip${heat.idx >= 3 ? " bad" : heat.idx >= 2 ? " warn" : ""}" title="Heat ${Math.round(me.heat || 0)}/100">` +
          `HEAT <b style="color:${heat.color}">${heat.label}</b></div>` +
        (ctx.isGM ? `<button class="cog" data-act="advance">⏭ ADVANCE DAY</button>` : "") +
        `<button class="sun-x" data-act="close" title="Close">✕</button>` +
      `</div>` +
      `<div class="sun-tabs">` +
        TABS.map((t) => `<button class="sun-tab${S._tab === t.id ? " active" : ""}" data-tab="${t.id}">` +
          `${t.icon} ${t.label}${t.id === "wire" && ctx.wireUnread ? ` <span class="dot">●</span>` : ""}</button>`).join("") +
      `</div>` +
      `<div class="sun-body">${body}</div>`;

    bind(root, ctx);
  }
  S.renderPanel = renderPanel;

  /* ------------------------------------------------------------- wallet */
  function renderWallet(ctx) {
    const me = ctx.me || {};
    const cfg = ctx.cfg || {};
    const lim = heatLimits(me.heat);
    const heat = heatTier(me.heat);
    const port = portfolio(me, ctx.market?.listings || []);
    const buyPer100 = cfg.buyCpPer100 ?? OBOL.buyCpPer100;
    const sellPer100 = cashOutCp(100, me.heat, cfg);

    const log = (me.log || []).slice().reverse().slice(0, 14);

    return `<div class="sun-row">` +
      `<div class="sun-col" style="flex:1 1 340px">` +
        `<div class="sun-card accent">` +
          `<div class="sun-h">THE HOUSE FLOAT</div>` +
          `<div class="sun-pl">` +
            `<div class="cell"><span class="lbl">ON DEPOSIT</span><span class="big" style="color:#c98bff">${fmtOb(me.ob)}</span></div>` +
            `<div class="cell"><span class="lbl">POSITIONS</span><span class="big">${fmtOb(port.valueOb)}</span></div>` +
            `<div class="cell"><span class="lbl">TOTAL P/L</span><span class="big ${cls(port.totalOb)}">${fmtSigned(port.totalOb)}</span></div>` +
          `</div>` +
          `<div class="sun-note">The Net does not take coin. It takes <b>Obols</b> — ØB — and it takes ` +
          `a bite on the way back out. 100 ØB in costs <b>${fmtCp(buyPer100)}</b>; 100 ØB out returns ` +
          `<b>${fmtCp(sellPer100)}</b>${heat.idx ? ` <span class="sun-warn">(widened: ${heat.label})</span>` : ""}.</div>` +
        `</div>` +
        `<div class="sun-card">` +
          `<div class="sun-h">BUY IN</div>` +
          `<div class="sun-row" style="align-items:center">` +
            `<span class="sun-note">Your purse: <b>${fmtCp(ctx.purseCp || 0)}</b>${ctx.purseLabel ? ` — ${esc(ctx.purseLabel)}` : ""}</span>` +
          `</div>` +
          `<div class="sun-row" style="align-items:center">` +
            `<input class="sun-in" type="number" min="${OBOL.minLot}" step="10" value="100" data-in="buyin">` +
            `<button class="sun-btn buy" data-act="buyin">CONVERT →</button>` +
            `<span class="sun-note" data-out="buyin"></span>` +
          `</div>` +
          `<div class="sun-note">Minimum ${OBOL.minLot} ØB. Converting is not a trade — it does not cost you a slot.</div>` +
        `</div>` +
        `<div class="sun-card">` +
          `<div class="sun-h">CASH OUT</div>` +
          `<div class="sun-row" style="align-items:center">` +
            `<input class="sun-in" type="number" min="${OBOL.minLot}" step="10" value="100" data-in="cashout">` +
            `<button class="sun-btn sell${lim.maxCashOutOb <= 0 ? " off" : ""}" data-act="cashout"` +
              `${lim.maxCashOutOb <= 0 ? " disabled" : ""}>← WITHDRAW</button>` +
            `<span class="sun-note" data-out="cashout"></span>` +
          `</div>` +
          (Number.isFinite(lim.maxCashOutOb)
            ? `<div class="sun-warn">Withdrawals capped at ${fmtOb(lim.maxCashOutOb)} a day while you are ${heat.label}.</div>`
            : `<div class="sun-note">Withdraw whenever you like. That is the whole appeal.</div>`) +
        `</div>` +
      `</div>` +
      `<div class="sun-col" style="flex:1 1 300px">` +
        `<div class="sun-card">` +
          `<div class="sun-h">HEAT — ${heat.label}</div>` +
          gauge("EXPOSURE", me.heat || 0, heat.color) +
          `<div class="sun-note">${heatBlurb(heat.idx)}</div>` +
        `</div>` +
        `<div class="sun-card">` +
          `<div class="sun-h">LEDGER</div>` +
          (log.length
            ? log.map((e) => `<div class="wi"><div class="k">D${e.day ?? "—"}</div><div class="m">` +
                `<div class="tx">${esc(e.text || e.k || "")}</div>` +
                `<div class="me"><span class="${cls(e.ob || 0)}">${fmtSigned(e.ob || 0)} ØB</span></div>` +
              `</div></div>`).join("")
            : `<div class="sun-note">Nothing on the books yet.</div>`) +
        `</div>` +
      `</div>` +
    `</div>` + (ctx.isGM ? gmWallet(ctx) : "");
  }

  function heatBlurb(t) {
    return [
      "Nobody is looking at you. Keep it that way.",
      "You have been noticed. A name written down somewhere, nothing more.",
      "Marked. The spreads have quietly turned against you and the vault work is closed to you.",
      "Hunted. Withdrawals are capped and somebody is being paid to find out where you sleep.",
      "Burned. The account is frozen and the conversation is no longer financial.",
    ][t] || "";
  }

  /* ------------------------------------------------------------ exchange */
  function renderExchange(ctx) {
    const mk = ctx.market || { listings: [], indices: {} };
    const me = ctx.me || {};
    const cfg = ctx.cfg || {};
    const port = portfolio(me, mk.listings);
    const dead = (ctx.dead || []).filter((d) => (ctx.day - d.day) <= M.deadOnScreenDays);
    const sel = mk.listings.find((l) => l.id === S._sel) || null;
    const tradesLeft = Math.max(0, (cfg.tradesPerDay ?? 5) - (me.trades || 0));

    const idxRow = Object.entries(mk.indices || {}).map(([k, v]) =>
      gauge(INDEX_LABEL[k] || k, v, INDEX_COLOUR[k])).join("");

    const rows = mk.listings.map((l) => {
      const d = pct(l.price, l.prev);
      const pos = me.pos?.[l.id];
      const band = HEALTH_BANDS.find((b) => b.label === l.band) || HEALTH_BANDS[0];
      return `<tr class="pick${S._sel === l.id ? " on" : ""}" data-pick="${esc(l.id)}">` +
        `<td><span class="tick">${esc(l.ticker)}</span><div class="co">${esc(l.name)}</div></td>` +
        `<td>${sparkline(l.hist, 96, 26)}</td>` +
        `<td class="num"><b>${l.price.toLocaleString()}</b></td>` +
        `<td class="num ${cls(d)}">${arrow(d)} ${r2(Math.abs(d))}%</td>` +
        `<td><span class="band" style="color:${band.color}">${esc(l.band)}</span></td>` +
        `<td class="num">${pos?.qty ? `${pos.qty.toLocaleString()}<div class="co ${cls(unrealisedOb(pos, l.price))}">` +
          `${fmtSigned(unrealisedOb(pos, l.price))}</div>` : `<span class="flat">—</span>`}</td>` +
      `</tr>`;
    }).join("");

    const deadRows = dead.map((d) => `<tr class="dead">` +
      `<td><span class="tick">${esc(d.ticker)}</span><div class="co">${esc(d.name)}</div></td>` +
      `<td colspan="3" class="co">${esc(d.epitaph || "")}</td>` +
      `<td class="co">DIED D${d.day}</td>` +
      `<td class="num co">${Math.round((d.payoutFrac || 0) * 100)}/100</td>` +
    `</tr>`).join("");

    return `<div class="sun-card">` +
        `<div class="sun-pl">` +
          `<div class="cell"><span class="lbl">TOTAL P/L</span>` +
            `<span class="big ${cls(port.totalOb)}">${fmtSigned(port.totalOb)}</span></div>` +
          `<div class="cell"><span class="lbl">REALISED</span>` +
            `<span class="big ${cls(port.realisedOb)}" style="font-size:20px">${fmtSigned(port.realisedOb)}</span></div>` +
          `<div class="cell"><span class="lbl">OPEN</span>` +
            `<span class="big ${cls(port.unrealisedOb)}" style="font-size:20px">${fmtSigned(port.unrealisedOb)}</span></div>` +
          `<div class="cell"><span class="lbl">AT MARKET</span>` +
            `<span class="big" style="font-size:20px">${fmtOb(port.valueOb)}</span></div>` +
          `<div class="cell"><span class="lbl">CASH</span>` +
            `<span class="big" style="font-size:20px;color:#c98bff">${fmtOb(me.ob)}</span></div>` +
        `</div>` +
      `</div>` +
      `<div class="sun-row" style="margin-top:12px">` +
        `<div class="sun-col" style="flex:2 1 460px">` +
          `<div class="sun-card">` +
            `<div class="sun-h">THE BOARD — DAY ${mk.day ?? ctx.day}</div>` +
            `<table class="sun-t"><thead><tr>` +
              `<th>LISTING</th><th>60 DAYS</th><th class="num">LAST</th><th class="num">CHG</th>` +
              `<th>SOLVENCY</th><th class="num">YOU</th>` +
            `</tr></thead><tbody>${rows || `<tr><td colspan="6" class="sun-note">No listings.</td></tr>`}` +
            (deadRows ? `<tr><td colspan="6" class="sun-h" style="padding-top:14px">DELISTED</td></tr>${deadRows}` : "") +
            `</tbody></table>` +
          `</div>` +
        `</div>` +
        `<div class="sun-col" style="flex:1 1 280px">` +
          (sel ? tradeTicket(sel, ctx, tradesLeft) : `<div class="sun-card"><div class="sun-h">TICKET</div>` +
            `<div class="sun-note">Pick a listing to trade it.</div></div>`) +
          `<div class="sun-card"><div class="sun-h">CONDITIONS` +
            (mk.standingKnown ? "" : ` <span class="sun-warn">— FACTION TELEMETRY OFFLINE</span>`) + `</div>` +
            idxRow +
            `<div class="sun-note">What the Net thinks is happening out there. It is usually about right, ` +
            `and it is never early.</div>` +
          `</div>` +
          (me.orders?.length ? orderBook(me, mk) : "") +
        `</div>` +
      `</div>` + (ctx.isGM ? gmExchange(ctx) : "");
  }

  const INDEX_LABEL = { war: "WAR RISK", rift: "RIFT", trade: "TRADE FLOW", law: "ENFORCEMENT", relic: "RELIC FEVER" };
  const INDEX_COLOUR = { war: "linear-gradient(90deg,#5c1b1f,#e0454d)", rift: "linear-gradient(90deg,#3d1b5c,#c98bff)",
    trade: "linear-gradient(90deg,#1d6a86,#38e1c4)", law: "linear-gradient(90deg,#5c4416,#f2b03d)",
    relic: "linear-gradient(90deg,#1b5c3d,#57d38c)" };
  S.INDEX_LABEL = INDEX_LABEL;

  function tradeTicket(l, ctx, tradesLeft) {
    const me = ctx.me || {};
    const pos = me.pos?.[l.id] || emptyPos();
    const band = HEALTH_BANDS.find((b) => b.label === l.band) || HEALTH_BANDS[0];
    const qty = S._qty || 10;
    const qb = quote(l, "buy", qty, ctx.cfg);
    const qs = quote(l, "sell", Math.min(qty, pos.qty || qty), ctx.cfg);
    const canAfford = Math.floor((me.ob || 0) / Math.max(1, qb.unitOb));
    return `<div class="sun-card accent">` +
      `<div class="sun-h">${esc(l.ticker)} — ${esc(l.name)}</div>` +
      `<div class="sun-note">${esc(l.blurb || "")}</div>` +
      `<div class="sun-row" style="align-items:center;gap:8px">` +
        `<span class="sun-note">${esc(l.sectorName)}</span>` +
        `<span class="band" style="color:${band.color}">${esc(l.band)}</span>` +
        `<span class="sun-note">DEPTH ${l.depth.toLocaleString()}</span>` +
      `</div>` +
      (pos.qty ? `<div class="sun-note">Holding <b>${pos.qty.toLocaleString()}</b> at ` +
        `<b>${r2(avgCostOb(pos))}</b> — <span class="${cls(unrealisedOb(pos, l.price))}">` +
        `${fmtSigned(unrealisedOb(pos, l.price))} ØB</span></div>` : "") +
      `<div class="sun-row" style="align-items:center;gap:8px">` +
        `<input class="sun-in" type="number" min="1" step="1" value="${qty}" data-in="qty" style="width:88px">` +
        `<button class="sun-btn" data-act="qmax">MAX ${canAfford.toLocaleString()}</button>` +
      `</div>` +
      `<div class="sun-note">` +
        `BUY ${qty.toLocaleString()} @ <b>${qb.unitOb.toLocaleString()}</b> = <b>${fmtOb(qb.netOb)}</b>` +
        ` <span class="co">(fee ${qb.feeOb}${qb.slipPct >= 0.5 ? `, <span class="sun-warn">slippage +${qb.slipPct}%</span>` : ""})</span>` +
      `</div>` +
      (pos.qty ? `<div class="sun-note">SELL ${Math.min(qty, pos.qty).toLocaleString()} @ ` +
        `<b>${qs.unitOb.toLocaleString()}</b> = <b>${fmtOb(qs.netOb)}</b>` +
        ` <span class="co">(fee ${qs.feeOb}${qs.slipPct >= 0.5 ? `, <span class="sun-warn">slippage −${qs.slipPct}%</span>` : ""})</span></div>` : "") +
      `<div class="sun-row">` +
        `<button class="sun-btn buy${tradesLeft <= 0 ? " off" : ""}" data-act="buy"${tradesLeft <= 0 ? " disabled" : ""}>BUY</button>` +
        `<button class="sun-btn sell${tradesLeft <= 0 || !pos.qty ? " off" : ""}" data-act="sell"` +
          `${tradesLeft <= 0 || !pos.qty ? " disabled" : ""}>SELL</button>` +
        `<button class="sun-btn" data-act="order">REST AN ORDER…</button>` +
      `</div>` +
      (tradesLeft <= 0 ? `<div class="sun-warn">No trades left today. The GM moves the clock.</div>` : "") +
    `</div>`;
  }

  function orderBook(me, mk) {
    const byId = {}; for (const l of mk.listings) byId[l.id] = l;
    return `<div class="sun-card"><div class="sun-h">RESTING ORDERS</div>` +
      me.orders.map((o) => {
        const l = byId[o.id];
        return `<div class="sun-row" style="align-items:center;justify-content:space-between;gap:8px">` +
          `<span class="sun-note"><b class="tick">${esc(l?.ticker || o.id)}</b> ` +
          `${o.kind === "stop" ? "STOP" : "LIMIT"} ${o.side.toUpperCase()} ${o.qty.toLocaleString()} @ ${o.priceOb.toLocaleString()}</span>` +
          `<button class="sun-btn" data-act="cancel" data-oid="${esc(o.oid)}">✕</button></div>`;
      }).join("") +
      `<div class="sun-note">Resting orders are checked when the day turns. A fill costs a trade slot then, ` +
      `not now.</div></div>`;
  }

  /* ---------------------------------------------------------------- pit */
  const GAMES = [
    { id: "ladder",   name: "The Ladder",      icon: "⛓", abil: "int", ability: "INT",
      blurb: "Climb. Every rung multiplies, every rung is harder, and a slip costs you everything on it." },
    { id: "skim",     name: "Signal Skim",     icon: "≋", abil: "wis", ability: "WIS",
      blurb: "Name your own difficulty and get paid for it. One read of the traffic, one answer." },
    { id: "coldread", name: "Cold Read",       icon: "☰", abil: "cha", ability: "CHA",
      blurb: "Three hands against the house intelligence. Lie well, and walk whenever you like." },
    { id: "icerun",   name: "Ice Run",         icon: "❄", abil: "dex", ability: "DEX",
      blurb: "Three layers of somebody else's vault. Pays eight to one. Failure is not measured in Obols." },
    { id: "voidfall", name: "Voidfall",        icon: "◢", abil: null, ability: "NERVE",
      blurb: "The number climbs until it doesn't. Get out first." },
    { id: "roulette", name: "Hollow Roulette", icon: "◉", abil: null, ability: "LUCK",
      blurb: "Thirty-seven pockets. One of them is not a number." },
    { id: "pitwager", name: "Pit Wagers",      icon: "⚔", abil: null, ability: "ODDS",
      blurb: "Somebody else bleeds on Ossuary and you take a view on which one." },
    { id: "chits",    name: "Salvage Chits",   icon: "▩", abil: null, ability: "CHANCE",
      blurb: "Sealed lots off a dead ship. Mostly junk. Not always junk." },
  ];
  S.GAMES = GAMES;

  function renderPit(ctx) {
    const me = ctx.me || {};
    const cfg = ctx.cfg || {};
    const left = Math.max(0, (cfg.gamblesPerDay ?? 10) - (me.gambles || 0));
    const lim = heatLimits(me.heat);
    const open = GAMES.find((g) => g.id === S._pit);

    const grid = `<div class="pit-grid">` + GAMES.map((g) => {
      const blocked = g.id === "icerun" && lim.iceRunBlocked;
      return `<div class="pit-card${S._pit === g.id ? " on" : ""}${blocked ? " off" : ""}" data-game="${g.id}">` +
        `<div class="ic">${g.icon}</div>` +
        `<div class="nm">${esc(g.name)}</div>` +
        `<div class="ab">${g.ability}${g.abil ? " CHECK" : ""}</div>` +
        `<div class="bl">${esc(g.blurb)}</div>` +
        (blocked ? `<div class="sun-warn">The house will not deal you in.</div>` : "") +
      `</div>`;
    }).join("") + `</div>`;

    return `<div class="sun-row" style="align-items:center;margin-bottom:10px">` +
        `<div class="sun-note">The Cage takes <b>${left}</b> more plays from you today. ` +
        `Maximum stake at ${heatTier(me.heat).label}: <b>${lim.maxStakeOb ? fmtOb(lim.maxStakeOb) : "nothing"}</b>.</div>` +
      `</div>` + grid +
      (open ? `<div style="margin-top:14px">${gamePanel(open, ctx, left, lim)}</div>` : "") +
      (ctx.isGM ? gmPit(ctx) : "");
  }

  function stakeBox(defaultOb, left, lim) {
    const off = left <= 0 || lim.maxStakeOb <= 0;
    return `<div class="sun-row" style="align-items:center">` +
      `<span class="sun-note">STAKE</span>` +
      `<input class="sun-in" type="number" min="1" step="10" value="${defaultOb}" data-in="stake">` +
      (off ? `<span class="sun-warn">${left <= 0 ? "No plays left today." : "The house has cut you off."}</span>` : "") +
    `</div>`;
  }

  function gamePanel(g, ctx, left, lim) {
    const live = S._live && S._live.game === g.id ? S._live : null;
    const me = ctx.me || {};
    const mod = ctx.mods?.[g.abil];
    const head = `<div class="sun-h">${g.icon} ${esc(g.name).toUpperCase()}` +
      (g.abil ? ` — ${g.ability}${Number.isFinite(mod) ? ` ${mod >= 0 ? "+" : ""}${mod}` : " (no character assigned)"}` : "") +
      `</div>`;

    if (g.id === "ladder") {
      const odds = Number.isFinite(mod) ? ladderOdds(mod) : ladderOdds(0);
      const rung = live?.rung ?? 0;
      return `<div class="sun-card accent">${head}` +
        (live
          ? `<div class="sun-note">On the ladder for <b>${fmtOb(live.stake)}</b>. Banked value right now: ` +
            `<b class="up">${fmtOb(Math.floor(live.stake * (rung ? LADDER.mult[rung - 1] : 1)))}</b>.</div>`
          : stakeBox(200, left, lim)) +
        LADDER.mult.map((m, i) => {
          const o = odds[i];
          const state = live && i < rung ? "done" : live && i === rung ? "now" : "";
          return `<div class="rung ${state}"><span style="width:26px">${i + 1}</span>` +
            `<b style="width:60px">×${m}</b><span style="width:62px">DC ${o.dc}</span>` +
            `<span class="sun-note">${Math.round(o.pass * 100)}% this rung · ${Math.round(o.cum * 100)}% from cold</span></div>`;
        }).join("") +
        `<div class="sun-row">` +
          (live
            ? `<button class="sun-btn hot" data-act="play" data-g="ladder" data-step="climb">CLIMB — DC ${effDC(LADDER.dc[rung], mod || 0)}</button>` +
              (rung > 0 ? `<button class="sun-btn buy" data-act="play" data-g="ladder" data-step="bank">TAKE ${fmtOb(Math.floor(live.stake * LADDER.mult[rung - 1]))}</button>` : "")
            : `<button class="sun-btn hot" data-act="play" data-g="ladder" data-step="start"${left <= 0 ? " disabled" : ""}>STEP ON</button>`) +
        `</div></div>`;
    }

    if (g.id === "skim") {
      return `<div class="sun-card accent">${head}` +
        `<div class="sun-note">Set your own difficulty against the traffic. Harder read, better money. ` +
        `One roll, no second look.</div>` +
        stakeBox(200, left, lim) +
        `<div class="sun-row">` + SKIM.map((t) =>
          `<button class="sun-btn hot" data-act="play" data-g="skim" data-dc="${t.dc}"${left <= 0 ? " disabled" : ""}>` +
          `${esc(t.label)} — ×${t.mult}<br><span class="sun-note">DC ${effDC(t.dc, mod || 0)} · ` +
          `${Number.isFinite(mod) ? `${Math.round(passChance(t.dc, mod) * 100)}%` : "—"}` +
          `</span></button>`).join("") + `</div></div>`;
    }

    if (g.id === "coldread") {
      const rd = live?.round ?? 0;
      return `<div class="sun-card accent">${head}` +
        `<div class="sun-note">Three hands against the house intelligence. Deception against its read. ` +
        `The pot doubles each hand you take; walk after any of them, lose one and it keeps the lot.</div>` +
        (live
          ? `<div class="sun-note">Hand <b>${rd + 1}</b> of 3. Pot: <b class="up">${fmtOb(live.pot)}</b>. ` +
            `It reads at <b>+${coldReadHouse(rd, mod || 0)}</b>.</div>`
          : stakeBox(200, left, lim)) +
        `<div class="sun-row">` +
          (live
            ? `<button class="sun-btn hot" data-act="play" data-g="coldread" data-step="hand">PLAY THE HAND</button>` +
              `<button class="sun-btn buy" data-act="play" data-g="coldread" data-step="walk">WALK WITH ${fmtOb(live.pot)}</button>`
            : `<button class="sun-btn hot" data-act="play" data-g="coldread" data-step="start"${left <= 0 ? " disabled" : ""}>SIT DOWN</button>`) +
        `</div></div>`;
    }

    if (g.id === "icerun") {
      const layer = live?.layer ?? 0;
      return `<div class="sun-card accent">${head}` +
        `<div class="sun-note">The house sells tickets to somebody else's vault. Three layers. ` +
        `Clear all three and it pays <b>×${ICE_RUN.mult}</b>. Fail any of them and you lose the ticket ` +
        `<span class="sun-warn">and pick up ${ICE_RUN.heatOnFail} Heat</span> — which is the real stake.</div>` +
        (live ? `<div class="sun-note">Ticket <b>${fmtOb(live.stake)}</b>. Layer <b>${layer + 1}</b> of 3, DC ${effDC(ICE_RUN.layers[layer], mod || 0)}.</div>`
              : stakeBox(400, left, lim)) +
        iceRunOdds(mod || 0).rows.map((r, i) =>
          `<div class="rung ${live && i < layer ? "done" : live && i === layer ? "now" : ""}">` +
          `<span style="width:26px">${i + 1}</span><span style="width:62px">DC ${r.dc}</span>` +
          `<span class="sun-note">${Math.round(r.pass * 100)}% · ${Math.round(r.cum * 100)}% clean so far</span></div>`).join("") +
        `<div class="sun-row">` +
          (live
            ? `<button class="sun-btn hot" data-act="play" data-g="icerun" data-step="crack">CUT THE LAYER</button>`
            : `<button class="sun-btn hot" data-act="play" data-g="icerun" data-step="start"` +
              `${left <= 0 || lim.iceRunBlocked ? " disabled" : ""}>BUY A TICKET</button>`) +
        `</div></div>`;
    }

    if (g.id === "voidfall") {
      const mult = live?.mult ?? 1;
      const blown = live?.blown;
      return `<div class="sun-card accent">${head}` +
        `<div class="crash${blown ? " blown" : ""}">${blown ? "GONE" : "×" + mult.toFixed(2)}</div>` +
        (live?.state === "open"
          ? `<div class="sun-note">Buy-in closes in <b>${live.countdown ?? 0}</b>…</div>`
          : "") +
        (live?.in
          ? `<div class="sun-row"><button class="sun-btn buy" data-act="play" data-g="voidfall" data-step="out">` +
            `TAKE ${fmtOb(Math.floor((live.stake || 0) * mult))}</button></div>`
          : `${stakeBox(200, left, lim)}<div class="sun-row">` +
            `<button class="sun-btn hot" data-act="play" data-g="voidfall" data-step="join"${left <= 0 ? " disabled" : ""}>` +
            `${live?.state === "open" ? "GET IN" : "OPEN A ROUND"}</button></div>`) +
        `<div class="sun-note">The number is the house's, not yours — your terminal only draws it. ` +
        `Whatever your connection is doing, the moment you press is the moment that counts.</div>` +
      `</div>`;
    }

    if (g.id === "roulette") {
      const bet = S._roul || { key: "rift", arg: null };
      const nums = Array.from({ length: 37 }, (_, i) => i);
      return `<div class="sun-card accent">${head}` +
        `<div class="sun-note">Thirty-seven pockets. <b style="color:#c98bff">Pocket 0 is the Hollow</b>, and ` +
        `the Hollow does not pay — it takes the table.</div>` +
        stakeBox(100, left, lim) +
        `<div class="sun-row">` + [
          ["rift", "RIFT (odd) 1:1"], ["voidc", "VOID (even) 1:1"], ["low", "1–18"], ["high", "19–36"],
          ["dozen1", "1st 12 · 2:1"], ["dozen2", "2nd 12 · 2:1"], ["dozen3", "3rd 12 · 2:1"],
        ].map(([k, l]) => `<button class="sun-btn${bet.key === k ? " hot" : ""}" data-act="roulbet" data-k="${k}">${l}</button>`).join("") +
        `</div>` +
        `<div class="wheel">` + nums.map((n) =>
          `<div class="pk${n === 0 ? " hollow" : ""}${bet.key === "single" && Number(bet.arg) === n ? " on" : ""}" ` +
          `data-act="roulnum" data-n="${n}">${n === 0 ? "☒" : n}</div>`).join("") + `</div>` +
        `<div class="sun-note">Single number pays 35:1.</div>` +
        `<div class="sun-row"><button class="sun-btn hot" data-act="play" data-g="roulette"${left <= 0 ? " disabled" : ""}>SPIN</button></div>` +
        (live?.pocket != null ? `<div class="sun-note">Landed: <b>${live.pocket === 0 ? "THE HOLLOW" : live.pocket}</b> — ` +
          `${live.win ? `<span class="up">paid ${fmtOb(live.payoutOb)}</span>` : `<span class="dn">nothing</span>`}</div>` : "") +
      `</div>`;
    }

    if (g.id === "pitwager") {
      const card = ctx.fightCard;
      if (!card) return `<div class="sun-card accent">${head}<div class="sun-note">No card today. ` +
        `The pits run when the pits run.</div></div>`;
      const on = S._fighter;
      return `<div class="sun-card accent">${head}` +
        `<div class="sun-note">${esc(card.venue || "Ossuary, under the gantries")} — today's card.</div>` +
        `<div class="fight">` + ["a", "b"].map((k) => {
          const f = card[k];
          return `<div class="fighter${on === k ? " on" : ""}" data-act="pickfighter" data-k="${k}">` +
            `<div class="nm" style="font-weight:700;color:#38e1c4">${esc(f.name)}</div>` +
            `<div class="sun-note">${esc(f.gimmick || "")}</div>` +
            `<div class="sun-note">HP ${f.hp} · ATK +${f.atk} · AC ${f.ac} · DMG ${f.dmg}</div>` +
            `<div class="sun-pl"><div class="cell"><span class="lbl">PAYS</span>` +
            `<span class="big" style="font-size:20px">×${k === "a" ? card.oddsA : card.oddsB}</span></div></div>` +
          `</div>`;
        }).join("") + `</div>` +
        stakeBox(200, left, lim) +
        `<div class="sun-row"><button class="sun-btn hot" data-act="play" data-g="pitwager"` +
          `${left <= 0 || !on ? " disabled" : ""}>PUT IT ON ${on ? esc(card[on].name).toUpperCase() : "…"}</button></div>` +
        (live?.log ? `<div class="pbp">` + live.log.map((r) =>
          `ROUND ${r.round} — ${esc(card.a.name)} ${r.a ? `lands ${r.a}` : "misses"}, ` +
          `${esc(card.b.name)} ${r.b ? `lands ${r.b}` : "misses"} · ${r.ah}/${r.bh}`).join("<br>") +
          `<br><b>${esc(card[live.winner].name)} takes it.</b></div>` : "") +
      `</div>`;
    }

    if (g.id === "chits") {
      return `<div class="sun-card accent">${head}` +
        `<div class="sun-note">Sealed lots, sold unopened, off ships nobody filed a loss for.</div>` +
        `<div class="sun-row">` + CHIT_TIERS.map((t) =>
          `<button class="sun-btn hot" data-act="play" data-g="chits" data-tier="${t.id}"${left <= 0 ? " disabled" : ""}>` +
          `${esc(t.name)}<br><span class="sun-note">${fmtOb(t.costOb)}</span></button>`).join("") + `</div>` +
        (live?.result ? `<div class="sun-note" style="margin-top:8px">${esc(live.result)}</div>` : "") +
      `</div>`;
    }
    return `<div class="sun-card">${head}<div class="sun-note">Not on this terminal.</div></div>`;
  }

  /* --------------------------------------------------------------- wire */
  function renderWire(ctx) {
    const w = ctx.wire || { items: [], sources: {}, bands: {} };
    const me = ctx.me || {};
    const byTicker = {};
    for (const l of (ctx.market?.listings || [])) byTicker[l.id] = l.ticker;
    for (const d of (ctx.dead || [])) byTicker[d.id] = d.ticker;
    const usedToday = me.insightDay === ctx.day;
    const items = (w.items || []).slice().sort((a, b) => b.day - a.day || String(b.id).localeCompare(String(a.id)));

    const srcRows = Object.entries(w.sources || {})
      .filter(([, s]) => (s.seen || 0) > 0)
      .sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0))
      .map(([id, s]) => {
        const rate = s.seen ? Math.round((s.hits / s.seen) * 100) : null;
        const c = rate == null ? "#6f97a6" : rate >= 65 ? "#57d38c" : rate >= 45 ? "#f2b03d" : "#e0454d";
        return `<div class="sun-row" style="justify-content:space-between;gap:8px">` +
          `<span class="sun-note">${esc(s.name || id)}</span>` +
          `<span class="src-rec" style="color:${c}">${rate == null ? "—" : rate + "%"} ` +
          `<span class="co">(${s.hits}/${s.seen})</span></span></div>`;
      }).join("");

    return `<div class="sun-row">` +
      `<div class="sun-col" style="flex:2 1 440px">` +
        `<div class="sun-card"><div class="sun-h">THE WIRE</div>` +
          (items.length ? items.slice(0, 60).map((it) => {
            const src = (w.sources || {})[it.src] || { name: it.src === "the-net" ? "The Net" : it.src };
            const band = (w.bands || {})[it.id];
            const tags = (it.tags || []).map((t) => byTicker[t]).filter(Boolean);
            const canRead = it.kind === "rumour" && !it.resolved && !band && !usedToday;
            return `<div class="wi ${esc(it.kind)}"><div class="k">D${it.day}</div><div class="m">` +
              `<div class="tx">${esc(it.text)}</div>` +
              `<div class="me">` +
                `<span>${esc(src.name || it.src)}</span>` +
                (tags.length ? `<span class="tick">${tags.map(esc).join(" ")}</span>` : "") +
                (it.kind === "rumour" ? `<span>${it.dir > 0 ? "↑ bullish" : "↓ bearish"}</span>` : "") +
                (band ? `<span class="src-rec" style="color:${bandOf(band.pct).color}">${esc(band.label)}</span>` : "") +
                (it.resolved && it.kind === "rumour"
                  ? `<span class="${it.hit ? "up" : "dn"}">${it.hit ? "CAME TRUE" : "NOTHING IN IT"}</span>` : "") +
                (canRead ? `<button class="sun-btn" data-act="read" data-rid="${esc(it.id)}" ` +
                  `style="padding:3px 8px">READ IT</button>` : "") +
                (ctx.isGM ? `<button class="cog" data-act="say" data-rid="${esc(it.id)}" ` +
                  `style="padding:3px 8px">SAY THIS</button>` : "") +
              `</div>` +
            `</div></div>`;
          }).join("") : `<div class="sun-note">The wire is quiet. That is rarely good.</div>`) +
        `</div>` +
      `</div>` +
      `<div class="sun-col" style="flex:1 1 250px">` +
        `<div class="sun-card"><div class="sun-h">WHO TO BELIEVE</div>` +
          (srcRows || `<div class="sun-note">No track record yet. Give it a fortnight.</div>`) +
          `<div class="sun-note">Hit rate on rumours that have since resolved. The Net does not vouch ` +
          `for anyone; it just keeps count.</div>` +
        `</div>` +
        `<div class="sun-card"><div class="sun-h">READING THE ROOM</div>` +
          `<div class="sun-note">${usedToday
            ? "You have already leaned on one story today. Anything else you take at face value."
            : "You can lean on <b>one</b> rumour today — an Insight or Investigation check to see whether it smells right. It costs you nothing but the day's read."}</div>` +
        `</div>` +
      `</div>` +
    `</div>` + (ctx.isGM ? gmWire(ctx) : "");
  }

  /* ------------------------------------------------------------ GM cogs */
  const cog = (key, title, inner) =>
    `<div class="sun-card gm" style="margin-top:14px">` +
      `<div class="sun-row" style="justify-content:space-between;align-items:center">` +
        `<div class="sun-h" style="margin:0;border:none">⚙ ${esc(title)}</div>` +
        `<button class="cog" data-cog="${key}">${S._gm[key] ? "HIDE" : "SHOW"}</button>` +
      `</div>` + (S._gm[key] ? inner : "") +
    `</div>`;

  function gmWallet(ctx) {
    return cog("wallet", "GM — ACCOUNTS",
      `<div class="sun-row" style="align-items:center">` +
        `<select class="sun-in" data-in="gmuser" style="width:170px">` +
          (ctx.users || []).map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join("") +
        `</select>` +
        `<input class="sun-in" type="number" value="1000" data-in="gmob" style="width:96px">` +
        `<button class="cog" data-act="gmgrant">GRANT ØB</button>` +
        `<input class="sun-in" type="number" value="0" min="0" max="100" data-in="gmheat" style="width:74px">` +
        `<button class="cog" data-act="gmheat">SET HEAT</button>` +
        `<button class="cog" data-act="gmresetcounters">RESET TODAY'S SLOTS</button>` +
      `</div>` +
      `<div class="sun-note">Grants and Heat are absolute, not offers. The player is told.</div>`);
  }

  function gmExchange(ctx) {
    const ls = ctx.market?.listings || [];
    return cog("exchange", "GM — THE BOARD",
      `<div class="sun-row" style="align-items:center">` +
        `<select class="sun-in" data-in="gmticker" style="width:150px">` +
          ls.map((l) => `<option value="${esc(l.id)}">${esc(l.ticker)} — ${esc(l.name)}</option>`).join("") +
        `</select>` +
        `<input class="sun-in" type="number" value="0" data-in="gmshock" style="width:86px" title="percent">` +
        `<button class="cog" data-act="gmshock">SHOCK %</button>` +
        `<button class="cog" data-act="gmkill">KILL LISTING</button>` +
      `</div>` +
      `<div class="sun-row" style="align-items:center">` +
        `<input class="sun-in" data-in="gmheadline" style="width:260px" placeholder="Headline to put on the wire…">` +
        `<button class="cog" data-act="gmheadline">POST</button>` +
      `</div>` +
      `<div class="sun-note">A shock moves the price today and shows on the wire. Killing a listing pays ` +
      `holders the usual liquidation and queues a successor.</div>`);
  }

  function gmWire(ctx) {
    return cog("wire", "GM — THE WIRE",
      `<div class="sun-note">Every rumour has a <b>SAY THIS</b> button. It posts the line to chat in the ` +
      `voice of whoever is supposed to have said it, so you can drop a tip mid-scene without opening this.</div>` +
      `<div class="sun-row" style="align-items:center">` +
        `<input class="sun-in" data-in="gmrumour" style="width:260px" placeholder="Plant your own rumour…">` +
        `<select class="sun-in" data-in="gmrumsrc" style="width:140px">` +
          Object.entries(ctx.wire?.sources || {}).map(([id, s]) =>
            `<option value="${esc(id)}">${esc(s.name || id)}</option>`).join("") +
        `</select>` +
        `<select class="sun-in" data-in="gmrumtruth" style="width:100px">` +
          `<option value="1">True</option><option value="0">A lie</option></select>` +
        `<button class="cog" data-act="gmrumour">PLANT</button>` +
      `</div>`);
  }

  function gmPit(ctx) {
    return cog("pit", "GM — THE CAGE",
      `<div class="sun-note">Payout tables are fixed in the module so nobody can argue with them mid-hand. ` +
      `If you want a game to go a particular way, say so out loud and skip the roll — that always beats ` +
      `quietly rigging a number the players can see.</div>` +
      `<div class="sun-row"><button class="cog" data-act="gmnewcard">NEW FIGHT CARD</button></div>`);
  }

  /* ------------------------------------------------------------- events */
  function bind(root, ctx) {
    const A = ctx.actions || {};
    const num = (sel, dflt) => {
      const el = root.querySelector(`[data-in="${sel}"]`);
      const v = Math.floor(Number(el?.value));
      return Number.isFinite(v) ? v : dflt;
    };
    const str = (sel) => root.querySelector(`[data-in="${sel}"]`)?.value ?? "";

    root.querySelectorAll("[data-tab]").forEach((el) => el.addEventListener("click", () => {
      S._tab = el.dataset.tab; A.rerender?.();
    }));
    root.querySelectorAll("[data-pick]").forEach((el) => el.addEventListener("click", () => {
      S._sel = S._sel === el.dataset.pick ? null : el.dataset.pick; A.rerender?.();
    }));
    root.querySelectorAll("[data-game]").forEach((el) => el.addEventListener("click", () => {
      S._pit = S._pit === el.dataset.game ? null : el.dataset.game; S._live = null; A.rerender?.();
    }));
    root.querySelectorAll("[data-cog]").forEach((el) => el.addEventListener("click", () => {
      const k = el.dataset.cog; S._gm[k] = !S._gm[k]; A.rerender?.();
    }));
    const qtyEl = root.querySelector('[data-in="qty"]');
    if (qtyEl) qtyEl.addEventListener("change", () => { S._qty = Math.max(1, num("qty", 10)); A.rerender?.(); });

    root.querySelectorAll("[data-act]").forEach((el) => el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const act = el.dataset.act;
      switch (act) {
        case "close": return A.close?.();
        case "advance": return A.advanceDay?.();
        case "buyin": return A.buyIn?.(Math.max(OBOL.minLot, num("buyin", 100)));
        case "cashout": return A.cashOut?.(Math.max(OBOL.minLot, num("cashout", 100)));
        case "qmax": { const l = (ctx.market?.listings || []).find((x) => x.id === S._sel);
          if (l) { S._qty = Math.max(1, Math.floor((ctx.me?.ob || 0) / Math.max(1, quote(l, "buy", 1, ctx.cfg).unitOb))); }
          return A.rerender?.(); }
        case "buy": return A.trade?.(S._sel, "buy", Math.max(1, S._qty || num("qty", 10)));
        case "sell": return A.trade?.(S._sel, "sell", Math.max(1, S._qty || num("qty", 10)));
        case "order": return A.orderDialog?.(S._sel);
        case "cancel": return A.cancelOrder?.(el.dataset.oid);
        case "read": return A.readRumour?.(el.dataset.rid);
        case "say": return A.sayRumour?.(el.dataset.rid);
        case "roulbet": S._roul = { key: el.dataset.k, arg: null }; return A.rerender?.();
        case "roulnum": S._roul = { key: "single", arg: Number(el.dataset.n) }; return A.rerender?.();
        case "pickfighter": S._fighter = el.dataset.k; return A.rerender?.();
        case "play": return A.play?.(el.dataset.g, {
          stakeOb: Math.max(1, num("stake", 100)),
          step: el.dataset.step || null,
          dc: el.dataset.dc ? Number(el.dataset.dc) : null,
          tier: el.dataset.tier || null,
          bet: S._roul || null,
          fighter: S._fighter || null,
        });
        case "gmgrant": return A.gm?.grant?.(str("gmuser"), num("gmob", 0));
        case "gmheat": return A.gm?.setHeat?.(str("gmuser"), num("gmheat", 0));
        case "gmresetcounters": return A.gm?.resetCounters?.();
        case "gmshock": return A.gm?.shock?.(str("gmticker"), num("gmshock", 0));
        case "gmkill": return A.gm?.kill?.(str("gmticker"));
        case "gmheadline": return A.gm?.headline?.(str("gmheadline"));
        case "gmrumour": return A.gm?.plant?.(str("gmrumour"), str("gmrumsrc"), num("gmrumtruth", 1));
        case "gmnewcard": return A.gm?.newCard?.();
      }
    }));
  }

  /* =================================================================== */
  /* ========================= TEST FIXTURE ============================ */
  /* =================================================================== */
  /**
   * A miniature content file so --selftest can exercise the real simulation
   * without the generated data. tools/check_sundowner.js runs the same
   * assertions against the REAL data/sundowner-content.json — this is the
   * fast, dependency-free version, the way settle-render.js keeps an ASCII
   * floorplan fixture.
   */
  function fixtureContent() {
    const idx = (id, kappa, sigma, pJump, jumpSigma) => ({ id, name: id, kappa, sigma, pJump, jumpSigma });
    const sec = (id, beta) => ({ id, name: id, beta });
    const co = (id, ticker, sector, open, idio, depth, leverage, start) =>
      ({ id, ticker, name: ticker + " Co", sector, open, idio, depth, leverage, start, blurb: "", place: "the Expanse" });
    return {
      version: 0,
      indices: [
        idx("war", 0.06, 0.55, 0.010, 1.8), idx("rift", 0.04, 0.70, 0.015, 2.4),
        idx("trade", 0.10, 0.45, 0.008, 1.4), idx("law", 0.12, 0.40, 0.006, 1.2),
        idx("relic", 0.05, 0.80, 0.020, 2.0),
      ],
      sectors: [
        sec("arms",     { war: 1.20, rift: 0.20, trade: -0.10, law: 0.30, relic: 0 }),
        sec("hauling",  { war: -0.70, rift: -0.40, trade: 1.30, law: 0.20, relic: 0 }),
        sec("fuel",     { war: 0.40, rift: 0.10, trade: 0.80, law: 0, relic: 0 }),
        sec("salvage",  { war: 0.30, rift: 0.90, trade: 0.20, law: -0.40, relic: 0.50 }),
        sec("relicorp", { war: 0, rift: 0.60, trade: 0, law: -0.30, relic: 1.40 }),
        sec("medical",  { war: 0.60, rift: 0.30, trade: 0.40, law: 0.20, relic: 0 }),
        sec("synth",    { war: -0.20, rift: 0, trade: 0.90, law: 0.10, relic: 0 }),
        sec("vice",     { war: -0.30, rift: 0, trade: 0.50, law: -1.10, relic: 0 }),
        sec("secops",   { war: 0.90, rift: 0.40, trade: -0.20, law: -0.80, relic: 0 }),
      ],
      factions: [
        { id: "iron-directorate", basePower: 0.8, baseAggression: 0.5 },
        { id: "apostles-threshold", basePower: 0.2, baseAggression: 0.9 },
        { id: "sovereign-horizon", basePower: 0.3, baseAggression: -0.2 },
        { id: "frostwatch", basePower: 0.4, baseAggression: 0 },
        { id: "syndicate", basePower: 0.5, baseAggression: 0 },
      ],
      companies: [
        co("c-fuel", "AAA", "fuel", 420, 0.030, 2400, 0.5, true),
        co("c-haul", "BBB", "hauling", 610, 0.028, 3000, 0.7, true),
        co("c-arms", "CCC", "arms", 380, 0.035, 1600, 0.9, true),
        co("c-salv", "DDD", "salvage", 260, 0.045, 900, 0.6, true),
        co("c-rel", "EEE", "relicorp", 190, 0.055, 400, 1.1, true),
        co("c-med", "FFF", "medical", 520, 0.026, 2000, 0.4, true),
        co("c-syn", "GGG", "synth", 340, 0.024, 2600, 0.3, true),
        co("c-vice", "HHH", "vice", 470, 0.032, 1400, 0.8, true),
        co("r-1", "R01", "fuel", 400, 0.032, 1800, 0.6, false),
        co("r-2", "R02", "hauling", 500, 0.030, 2000, 0.7, false),
        co("r-3", "R03", "arms", 350, 0.038, 1200, 1.0, false),
        co("r-4", "R04", "salvage", 240, 0.048, 800, 0.7, false),
        co("r-5", "R05", "relicorp", 210, 0.055, 380, 1.2, false),
        co("r-6", "R06", "vice", 430, 0.034, 1300, 0.9, false),
        co("r-7", "R07", "secops", 300, 0.036, 1100, 0.8, false),
        co("r-8", "R08", "synth", 360, 0.026, 2400, 0.4, false),
        co("r-9", "R09", "medical", 480, 0.028, 1900, 0.5, false),
        co("r-10", "R10", "fuel", 390, 0.033, 1700, 0.6, false),
        co("r-11", "R11", "hauling", 540, 0.029, 2100, 0.7, false),
        co("r-12", "R12", "salvage", 250, 0.046, 850, 0.7, false),
      ],
      sources: [
        { id: "s-good", name: "Good Source", accLo: 0.70, accHi: 0.85, weight: 1, voice: "{text}" },
        { id: "s-mid", name: "Mid Source", accLo: 0.45, accHi: 0.60, weight: 1.5, voice: "{text}" },
        { id: "s-bad", name: "Bad Source", accLo: 0.30, accHi: 0.42, weight: 1.5, voice: "{text}" },
      ],
      events: [
        { id: "contract", weight: 4, kind: "contract", dir: 1, magMin: 0.06, magMax: 0.22,
          headline: "{name} lands a hauling contract.", rumours: ["Somebody says {ticker} is about to sign."] },
        { id: "blockade", weight: 4, kind: "blockade", dir: -1, magMin: 0.08, magMax: 0.30,
          favours: { war: 0.4 }, spillsToSector: true, damage: 0.10,
          headline: "Lanes closed around {place}; {name} is caught out.",
          rumours: ["Hulls forming up near {place}. {ticker} will feel it."] },
        { id: "wipeout", weight: 0.3, kind: "disaster", dir: -1, magMin: 0.30, magMax: 0.45, damage: 0.55,
          headline: "{name} loses the yard and most of the book.",
          rumours: ["Nobody has heard from the {ticker} yard in two days."] },
      ],
      noiseRumours: ["Word going round about {name}.", "Somebody swears {ticker} is finished."],
      pumpRumours: ["Serious money is moving into {name}.", "{ticker} is the only trade worth making."],
      epitaphs: [{ id: "receivers", sector: "*", text: "Receivers appointed; the book went for scrap." }],
    };
  }
  S.fixtureContent = fixtureContent;

  /* =================================================================== */
  /* ============================ SELFTEST ============================= */
  /* =================================================================== */
  /**
   * Everything the economy promises, asserted. Run with
   *   node scripts/sundowner-render.js --selftest
   */
  function selftest(opts) {
    const fails = [];
    const notes = [];
    const ok = (cond, msg) => { if (!cond) fails.push(msg); };
    const days = (opts && opts.days) || 500;
    const content = (opts && opts.content) || fixtureContent();

    /* --- currency: the house edge must not invert at any legal size ---- */
    for (let n = OBOL.minLot; n <= 100000; n += (n < 200 ? 1 : 977)) {
      if (!(cpFromObols(n) < cpForObols(n))) {
        fails.push(`obol spread inverts at ${n} ØB (in ${cpForObols(n)}cp, out ${cpFromObols(n)}cp)`);
        break;
      }
    }
    ok(cpForObols(100) === 1000, `100 ØB should cost 1000cp, got ${cpForObols(100)}`);
    ok(cpFromObols(100) === 980, `100 ØB should return 980cp, got ${cpFromObols(100)}`);
    ok(cashOutCp(100, 95) < cashOutCp(100, 0), "Heat should widen the cash-out spread");

    /* --- coin helpers -------------------------------------------------- */
    ok(spendCp({ gp: 1 }, 150) === null, "1gp should not cover 150cp");
    ok(toCp(spendCp({ gp: 2 }, 150)) === 50, "2gp less 150cp should leave 50cp");
    ok(toCp(gainCp({}, 1234)) === 1234, "gainCp must be exact");

    /* --- every pit game must be a losing proposition ------------------- */
    for (let mod = 0; mod <= 20; mod++) {
      const lo = ladderOdds(mod);
      for (const r of lo) {
        ok(r.stepEV <= 0.99, `ladder rung ${r.rung} EV ${r.stepEV} at +${mod} is a printer`);
      }
      for (const t of SKIM) {
        const ev = skimEV(t.dc, t.mult, mod);
        ok(ev <= 0.99, `skim DC${t.dc} EV ${ev} at +${mod} is a printer`);
      }
      for (let rd = 0; rd < COLD_READ.rounds; rd++) {
        const ev = r2(contestChance(mod, coldReadHouse(rd, mod)) * COLD_READ.potMult);
        ok(ev <= 0.99, `cold read hand ${rd + 1} EV ${ev} at +${mod} is a printer`);
      }
      ok(iceRunOdds(mod).ev <= 0.99, `ice run EV ${iceRunOdds(mod).ev} at +${mod} is a printer`);
    }
    // ...and playable for somebody who is actually good at it.
    ok(ladderOdds(9)[0].stepEV >= 0.80, `ladder should be near-fair for a specialist, got ${ladderOdds(9)[0].stepEV}`);
    ok(skimEV(SKIM[0].dc, SKIM[0].mult, 9) >= 0.80, "skim should be near-fair for a specialist");
    notes.push(`ladder rung1 EV  +0:${ladderOdds(0)[0].stepEV}  +9:${ladderOdds(9)[0].stepEV}  +15:${ladderOdds(15)[0].stepEV}`);
    notes.push(`ice run EV       +0:${iceRunOdds(0).ev}  +9:${iceRunOdds(9).ev}  +15:${iceRunOdds(15).ev}`);

    for (const k of Object.keys(ROULETTE.bets)) {
      const ev = rouletteEV(k);
      ok(ev > 0.90 && ev < 1.0, `roulette ${k} EV ${ev} out of range`);
    }
    for (const t of CHIT_TIERS) {
      const ev = chitEV(t.id);
      ok(ev > 0.70 && ev < 1.0, `chit ${t.id} EV ${ev} out of range`);
    }
    // crash: cashing out at ANY target must lose the same few percent
    for (const target of [1.2, 1.5, 2, 3, 5, 10, 25]) {
      let ev = 0; const N = 20000;
      for (let i = 0; i < N; i++) if (crashPoint(i / N) >= target) ev += target / N;
      ok(ev > 0.90 && ev < 1.0, `voidfall EV at x${target} is ${r2(ev)}`);
    }

    /* --- trading -------------------------------------------------------- */
    const L0 = { id: "x", price: 1000, depth: 1000 };
    ok(quote(L0, "sell", 10).netOb < quote(L0, "buy", 10).netOb, "sell must never beat buy");
    ok(quote(L0, "buy", 2000).unitOb > quote(L0, "buy", 10).unitOb, "size must cost more");
    let pos = applyBuy(emptyPos(), 100, 100000);
    const sold = applySell(pos, 100, 110000);
    ok(sold && sold.realisedOb === 10000, `realised P/L should be 10000, got ${sold && sold.realisedOb}`);
    ok(sold.pos.qty === 0 && sold.pos.costCc === 0, "a flat position must carry no residual cost");
    ok(applySell(applyBuy(emptyPos(), 5, 500), 6, 600) === null, "cannot sell more than held");
    // partial sells must not drift the average cost
    let p2 = applyBuy(emptyPos(), 300, 99991);
    for (let i = 0; i < 3; i++) p2 = applySell(p2, 100, 33330).pos;
    ok(p2.qty === 0 && p2.costCc === 0, "three partial sells must land exactly flat");

    /* --- the wire ------------------------------------------------------- */
    const rnd = mulberry32(7);
    let trueHi = 0, falseHi = 0;
    for (let i = 0; i < 4000; i++) {
      if (confidenceBand(25, 12, 1, 0.8, rnd).pct >= 60) trueHi++;
      if (confidenceBand(25, 12, 0, 0.8, rnd).pct >= 60) falseHi++;
    }
    ok(trueHi > falseHi * 2, "a good read must separate true rumours from plants");
    let failSpread = 0;
    for (let i = 0; i < 4000; i++) {
      const b = confidenceBand(2, 12, 0, 0.8, rnd);        // a badly failed check
      if (b.pct >= 40 && b.pct <= 60) failSpread++;
    }
    ok(failSpread > 1200, `a failed read must be uninformative, not wrong (${failSpread}/4000 landed neutral)`);

    /* --- the market: a long sweep -------------------------------------- */
    const sweep = sweepMarket(content, 1234, days);
    ok(sweep.medAbsRet >= 0.020 && sweep.medAbsRet <= 0.040,
       `median daily move ${r2(sweep.medAbsRet * 100)}% is outside 2.0-4.0%`);
    ok(sweep.deaths >= 1, "nothing died in the whole sweep");
    ok(sweep.deathGapMean >= 15 && sweep.deathGapMean <= 60,
       `mean gap between delistings is ${Math.round(sweep.deathGapMean)} days`);
    // Mean SIGNED correlation sits near zero by design — the sector betas are
    // built with opposing signs so a crackdown helps hauling and guts vice. What
    // must be true is that the links are real and that both directions exist.
    ok(sweep.meanAbsCorr >= 0.04 && sweep.meanAbsCorr <= 0.40,
       `mean |correlation| ${r2(sweep.meanAbsCorr)} is outside 0.04-0.40`);
    ok(sweep.maxCorr >= 0.15, `no two listings move together (max corr ${r2(sweep.maxCorr)})`);
    ok(sweep.minCorr <= -0.15, `nothing on the board moves against anything else (min corr ${r2(sweep.minCorr)})`);
    ok(sweep.bigMovers30 >= 3,
       `in a typical 30-day window only ${sweep.bigMovers30} of the listings moved more than 20% — ` +
       `the board is too tame to be worth watching`);
    ok(sweep.spread100 <= 12,
       `upper quartile is ${r2(sweep.spread100)}x the lower over 100 days — the board is incoherent`);
    // The ceiling is deliberately generous: the junk tier (idio 0.055) is MEANT
    // to be able to ten-bag or die inside a quarter, and does. What this catches
    // is the different failure it replaced, where a compounding index tilt sent
    // a listing to 50x systematically rather than as a tail.
    ok(sweep.maxRun100 <= 20,
       `one listing ran ${r2(sweep.maxRun100)}x in 100 days — something is compounding without a brake`);
    ok(!sweep.pinned, "a listing hit the price clamp");
    ok(!sweep.nan, "the model produced a NaN or a non-positive price");
    ok(sweep.minLive >= M.minLive, `the board fell to ${sweep.minLive} listings`);
    ok(sweep.rumourTrueFrac > 0.35 && sweep.rumourTrueFrac < 0.75,
       `${Math.round(sweep.rumourTrueFrac * 100)}% of rumours were true`);
    ok(sweep.maxStateBytes < 250000, `the public blob reached ${sweep.maxStateBytes} bytes`);
    notes.push(`sweep ${days}d: median move ${r2(sweep.medAbsRet * 100)}%, ${sweep.deaths} deaths ` +
      `(mean gap ${Math.round(sweep.deathGapMean)}d), |corr| ${r2(sweep.meanAbsCorr)} ` +
      `[${r2(sweep.minCorr)}..${r2(sweep.maxCorr)}], ` +
      `${Math.round(sweep.rumourTrueFrac * 100)}% of resolved rumours true, ` +
      `blob ${Math.round(sweep.maxStateBytes / 1024)}KB`);
    notes.push(`${sweep.bigMovers30} of 8 listings move >20% in a typical month; ` +
      `over 100 days the best ran ${r2(sweep.maxRun100)}x and the worst fell to ${r2(sweep.worstRun100)}x`);

    /* --- the leak audit: this is the test that protects the model ------ */
    ok(sweep.leaks.length === 0, `published state leaked private keys: ${sweep.leaks.join(", ")}`);

    return { fails, notes };
  }
  S.selftest = selftest;

  /** The public projection may only ever contain these keys. */
  const PUBLIC_KEYS = new Set([
    "day", "listings", "indices", "standingKnown", "ipoQueue",
    "id", "ticker", "name", "sector", "sectorName", "blurb", "price", "prev", "band",
    "depth", "hist", "listedDay",
    // the five index gauges are deliberately public — players should be able to
    // see that war risk is up, they just cannot see what it is about to do
    "war", "rift", "trade", "law", "relic",
  ]);
  S.PUBLIC_KEYS = PUBLIC_KEYS;
  function auditPublished(pub) {
    const bad = [];
    const walk = (o) => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (!o || typeof o !== "object") return;
      for (const k of Object.keys(o)) {
        if (!PUBLIC_KEYS.has(k)) bad.push(k);
        walk(o[k]);
      }
    };
    walk(pub);
    return [...new Set(bad)];
  }
  S.auditPublished = auditPublished;

  /** Run the market forward and measure it. Used by the selftest, the preview's
   *  MARKET MATH tab, and tools/check_sundowner.js. */
  function sweepMarket(content, seed, days, standing) {
    let latent = initLatent(content, seed);
    const rets = [];
    const series = {};
    let deaths = 0, nan = false, pinned = false, minLive = 99;
    let rumours = 0, resolvedN = 0, resolvedTrue = 0, maxStateBytes = 0;
    const deathDays = [];
    const leaks = new Set();
    const first100 = {}, at100 = {}, px = {};
    for (let d = 1; d <= days; d++) {
      const out = tickDay(latent, content, (seed + d * 7919) >>> 0, { standing });
      latent = out.latent;
      for (const k of auditPublished(out.published)) leaks.add(k);
      const bytes = JSON.stringify(out.published).length;
      if (bytes > maxStateBytes) maxStateBytes = bytes;
      minLive = Math.min(minLive, out.published.listings.length);
      for (const l of out.published.listings) {
        if (!Number.isFinite(l.price) || l.price <= 0) nan = true;
        if (l.price <= M.priceMin || l.price >= M.priceMax) pinned = true;
        if (l.prev > 0) {
          const r = Math.log(l.price / l.prev);
          rets.push(Math.abs(r));
          (series[l.id] ||= []).push(r);
        }
        if (d === 1) first100[l.id] = l.price;
        if (d === 100) at100[l.id] = l.price;
        (px[l.id] ||= {})[d] = l.price;
      }
      for (const w of out.wire) if (w.kind === "rumour") rumours++;
      for (const r of out.resolved) { resolvedN++; if (r.hit) resolvedTrue++; }
      if (out.report.deaths.length) { deaths += out.report.deaths.length; deathDays.push(d); }
    }
    rets.sort((a, b) => a - b);
    const medAbsRet = rets.length ? rets[Math.floor(rets.length / 2)] : 0;
    // mean pairwise correlation of daily returns
    const ids = Object.keys(series).filter((k) => series[k].length > 60);
    let cs = 0, cn = 0, cAbs = 0, cMax = -2, cMin = 2;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const c = corr(series[ids[i]], series[ids[j]]);
      if (Number.isFinite(c)) {
        cs += c; cAbs += Math.abs(c); cn++;
        if (c > cMax) cMax = c;
        if (c < cMin) cMin = c;
      }
    }
    // "All over the place", measured properly: in a typical 30-day window, how
    // many of the eight listings moved more than 20%? Quartile dispersion was a
    // poor proxy -- it read 1.16x on a world where the top listing had run 8x
    // and the bottom had fallen to a third, simply because the middle clustered.
    const bigCounts = [];
    for (let d = 31; d <= days; d += 10) {
      let n = 0;
      for (const id of Object.keys(px)) {
        const a = px[id][d - 30], b = px[id][d];
        if (!a || !b) continue;
        if (Math.abs(b / a - 1) > 0.20) n++;
      }
      bigCounts.push(n);
    }
    bigCounts.sort((a, b) => a - b);
    const bigMovers30 = bigCounts.length ? bigCounts[Math.floor(bigCounts.length / 2)] : 0;

    const gaps = [];
    for (let i = 1; i < deathDays.length; i++) gaps.push(deathDays[i] - deathDays[i - 1]);
    // Robust dispersion. max/min was the obvious choice and the wrong one: a
    // single company collapsing 95% on its way to being delisted swamped it,
    // so the number said "runaway" when the board was behaving. Compare the
    // upper quartile to the lower one instead, and track the biggest single
    // run separately.
    const rel = Object.keys(at100).filter((k) => first100[k]).map((k) => at100[k] / first100[k])
                      .sort((a, b) => a - b);
    const q = (p) => (rel.length ? rel[Math.min(rel.length - 1, Math.floor(p * rel.length))] : 1);
    const spread100 = rel.length ? q(0.75) / Math.max(1e-6, q(0.25)) : 1;
    const maxRun100 = rel.length ? rel[rel.length - 1] : 1;
    const worstRun100 = rel.length ? rel[0] : 1;
    return {
      medAbsRet, deaths, nan, pinned, minLive, maxStateBytes,
      deathGapMean: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : (days / Math.max(1, deaths)),
      meanCorr: cn ? cs / cn : 0,
      meanAbsCorr: cn ? cAbs / cn : 0,
      maxCorr: cn ? cMax : 0, minCorr: cn ? cMin : 0, corrPairs: cn,
      rumourTrueFrac: resolvedN ? resolvedTrue / resolvedN : 0,
      spread100, maxRun100, worstRun100, bigMovers30, leaks: [...leaks], latent,
    };
  }
  S.sweepMarket = sweepMarket;

  function corr(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 10) return NaN;
    let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
    const ma = sa / n, mb = sb / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return num / Math.sqrt(da * db);
  }

  /* -------------------------------------------------------------- exports */
  if (typeof module !== "undefined" && module.exports) module.exports = S;
})();

if (typeof process !== "undefined" && process.argv && process.argv.includes("--selftest")) {
  const S = globalThis.SSVSUN;
  const { fails, notes } = S.selftest();
  for (const n of notes) console.log("  · " + n);
  if (fails.length) {
    console.error("SELFTEST FAILED:");
    for (const f of fails) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log("sundowner selftest: all assertions passed");
}
