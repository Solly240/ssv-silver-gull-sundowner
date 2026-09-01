# Maintaining the Sundowner Net

Read §1 and §2 before changing anything.

---

## 1. The two-file split

| File | Rule |
|---|---|
| `scripts/sundowner-render.js` | **Pure.** All CSS, all renderers, the entire market simulation, every payout table. Never references `game`, `ui`, `Hooks`, `canvas` or a Foundry document class. Exposed as `globalThis.SSVSUN` and via `module.exports`. |
| `scripts/sundowner.js` | Foundry wiring only: settings, the ctx contract, dialogs, the socket, the GM-side handlers. |

Enforced in the release checklist:

```bash
grep -nE '\b(game|ui|Hooks|canvas)\.' scripts/sundowner-render.js   # must be empty
```

That grep also catches prose — a comment ending "…that is the game." trips it. Reword rather than
weaken the grep.

This split is what makes `../preview.html` possible, and the preview is where the economy is
actually tuned. If maths leaks into `sundowner.js`, the preview stops telling the truth and you
are tuning a stock market by rebooting Foundry.

## 2. Content vs. state, and the third store

| Store | Overwritten by a release? | Holds |
|---|---|---|
| `data/sundowner-content.json` | **YES** | Companies, sectors, events, sources, epitaphs, fighters. Generated — never hand-edit. |
| world settings `state` / `wire` / `ledger` / `config` | no | The live board, the published wire, everyone's money and positions. |
| **client setting `secret`** | no, and **never leaves your browser** | The latent model, the schedule of events that have not happened yet, per-rumour truth, unsettled bets. |
| world setting `secretVault` | no | AES-GCM ciphertext of `secret`. Opaque without the passphrase. |

Every read goes through a `normalize*()` that merges stored data onto defaults, so adding a field
never needs a world reset.

**Never put a price, a position or a balance in the content file.** A release would reset the
party's economy.

## 3. Why the secret store exists, verified

Checked against the installed Foundry source, not assumed:

- The world payload handler calls `Actor.dump()`, `JournalEntry.dump()`, `Setting.dump()` and so
  on **with no user argument and no ownership predicate**. Every world document goes to every
  client. Ownership is a client-side UI filter. **A GM-only journal entry is not a secret**, and
  neither is a whisper, and neither is a `scope: "user"` setting.
- `scope: "client"` is `window.localStorage`. It never reaches the server, so it cannot reach
  another client. That is the only real boundary available, and it is where the model lives.
- `game.socket.emit(chan, payload, { recipients: [userId] })` is filtered **by the server**, and
  the handler's second argument is the server's view of the sender and cannot be spoofed. This
  module moves money on player-submitted dice, so `onSocket` uses it and drops anything claiming
  to be from somebody else.

The consequence for you: **only `publish()` output may be written to a world setting.**
`tools/check_sundowner.js` asserts exactly that over a simulated run, comparing every key ever
written against `S.PUBLIC_KEYS`. It runs last before a release. If you add a field to the tape,
add it to the allowlist deliberately, having thought about whether a player should see it.

## 4. Tuning the market

Everything tunable is in the `M` object at the top of the simulation section, and every claim the
model makes is asserted:

```bash
node scripts/sundowner-render.js --selftest      # fixture, fast
node ../tools/check_sundowner.js 700 20          # real content, 20 worlds
python3 ../tools/serve.py                        # then the MARKET MATH tab
```

What the numbers should say, and why:

| Target | Why that band |
|---|---|
| median daily move **2–4%** | Under 2% the board looks dead at a weekly cadence; over 4% it is noise and the wire stops paying. |
| **≥3 of 8** listings move >20% in a typical month | This is "all over the place", measured. Do not swap it back for a dispersion ratio — max/min read 1.16x on a world where the top listing had run 8x, because the middle clustered. |
| best 100-day run **≤20×** | Deliberately generous: the junk tier is meant to ten-bag or die inside a quarter. What this catches is the failure it replaced, where a compounding index tilt sent a listing to 50× *systematically*. |
| one delisting every **15–60 days** | About one every two or three sessions. |
| **35–75%** of resolved rumours true | Under half and the wire is correctly ignored; over two thirds and it is a free lunch. |
| a full −10…+10 standing swing moves the exposed sectors **20–400%** over 60 days | The single most important claim the module makes. If this collapses, the politics module is not reaching the board and the premise is decoration. |
| `arms` **falls** as the party befriends the Apostles | Sign check on the faction coupling. |

### The board opens with a past

`openTheBoard()` runs `burnInDays` (default 90) of the simulation privately, then winds
`latent.day` back to zero and clears the schedule, rumours and IPO queue. The charts therefore
arrive with real history to read and a couple of companies have already been and gone, while the
campaign clock still starts at day 0. Without it the exchange opens as eight flat lines, which
tells a player nothing and looks broken.

### Four traps this model has already fallen into

- **Start the indices at their targets.** They used to start near zero and settle towards a
  non-zero `μ`, so every fresh world spent its first month sliding in the same predictable
  direction — arms and hauling down, synth up — regardless of anything anyone did.
- **Count queued successors in the board top-up.** The emergency "never fall below eight" loop used
  to fire on the same day a death queued its heir, so two listed where one had died and the board
  crept to nine and beyond over a campaign. The invariant is not "always exactly eight" — it is
  "never more than eight, and never short with nothing queued", which is what `starvedDays` asserts.
- **Delist a collapsed listing before it reaches the price clamp.** A dying company kept decaying
  until it pinned at 1 ØB with a spread that rounds to nothing. Anything under `delistBelowPx` is
  now delisted outright and pays holders pennies.
- **Measure the level tilt against a baseline.** `fairIdxLevel`/`idxLevel` apply to how far an
  index is from `latent.baseMu`, not from zero. Against zero, a setting whose factions are
  permanently belligerent hands arms a permanent bull market that has nothing to do with the party.
  The tilt is also capped at `M.levelCap` per day; uncapped it compounded to 22× the board.

## 4b. Testing it yourself

The GM has no purse and usually no character, so the wallet and the check games are unplayable
without help. Two controls exist for that, both on the ⚙ panels:

- **WALLET ⚙** — `PAY ME 5,000 ØB`, plus `WIPE THE SELECTED ACCOUNT` / `WIPE EVERY ACCOUNT` to clear
  up after a test run, and `RESEED THE WHOLE BOARD` to throw the market away and generate a fresh
  one with fresh history. Reseeding also closes everyone's positions, because they would otherwise
  be holdings in companies that no longer exist.
- **PIT ⚙** — a **pretend ability modifier**. With no character assigned there is nothing to roll
  against; set this and the terminal rolls `1d20 + n` for every check, and the odds, handicapped DCs
  and payouts all behave exactly as they would for a player with that modifier. It is a
  `client`-scope setting, so it is yours alone, and it is only honoured for a user who is a GM.

## 4c. Animation

Outcomes are decided GM-side before the player sees anything, so nothing in the renderer *chooses*
a result — it plays one out. Three rules keep that honest and un-janky:

- **Detect a new outcome at the top of `renderPanel()`, not in `bind()`.** `bind()` runs after the
  markup is built, so the panel had already drawn itself settled and the wheel jumped to its final
  pocket instead of spinning to it.
- **Guard every reveal timer on the outcome key.** A timer left over from the previous spin was
  firing mid-spin and settling the wheel a second after it started.
- **Kick transitions with a forced reflow, never `requestAnimationFrame`.** A CSS transition will
  not run on a freshly inserted element that already carries its final value, and rAF is throttled
  to a complete stop in a background tab — the wheel would silently never turn. `void
  el.getBoundingClientRect()` then set the target.

The settled wheel renders with `transition:none` and its final rotation inline, so the redraw that
reveals the result does not re-spin it.

Terminal outcomes send `{outcome, headline, sub}` rather than clearing the live state, so a loss
gets a verdict banner instead of the panel silently blanking. `gmPlay` treats a live record that
carries an `outcome` as *not* an active hand, and the player dismisses it with PLAY AGAIN.

## 5. Payout tables

Every check game is handicapped: `effDC = base + modifier − edge`, where `edge` is
`round(0.15 × modifier)` capped at `MAX_EDGE = 2`.

This is not decoration. With a flat DC, a game tuned to be fair at +2 is a money printer at +11,
and one tuned against +11 is unplayable for anybody else. Handicapping keeps every game a losing
proposition at every modifier while still conceding two real points to a specialist, which is why
the wizard owns the Ladder and the rogue owns the Ice Run.

**Multipliers are priced off the best case (edge 2), not the average one.** If you change a DC,
re-price the multiplier or the PIT MATH tab will go red. The selftest asserts every game's EV
stays ≤0.99 at every modifier from +0 to +20, and that the Ladder and the Skim are still worth
playing (≥0.80) for somebody good at them.

The no-check games sit where they should: roulette 0.970 on every bet (a real single-zero wheel),
Voidfall 0.970 at every cash-out target, chits 0.88–0.94, the fight card 0.95 after the house
shade.

## 6. Editing content

Edit `../tools/sundowner_parts.py`, then:

```bash
python3 ../tools/build_sundowner.py --check     # validate only
python3 ../tools/build_sundowner.py             # validate and write
```

The builder refuses to write on: an unknown sector, a beta on an index that does not exist, a
missing beta, a duplicate id or ticker, a non-positive open price or depth, an idio or leverage
outside its band, a `bornFrom` pointing at nothing, a company with no blurb, a sector on the
opening board with no reserve company behind it, an event with no rumours (it would fire with no
warning at all), a template slot that is not defined, a source whose voice has no `{text}`, and a
missing catch-all epitaph.

Keep at least 20 reserve companies. At one death every 25 days, fewer than that and successors
start repeating inside a year.

## 7. Things that will bite you

- **Do not reimplement item granting.** Salvage Chits route through the shop module's
  `grantItem`, which shares `itemDataFor()` with the buy path and is what stamps the ship-combat
  resource flags onto fuel and power cells. A separate copy looks correct and quietly stops fuel
  reaching the ship gauges.
- **Do not use the shop's `setTreasury` to pay anything out.** It is a merge-set, not an adder.
- **Escrow resting orders.** A limit buy holds its Obols and a limit sell reserves its shares, or
  the same money gets spent twice between the order and the fill.
- **Recompute the cluster guard inside the death loop.** Hoisted out of it, two listings dying on
  the same day both saw a stale flag and the board emptied.
- **The preview must hide the panel with `style.display`, not the `hidden` attribute.**
  `renderPanel()` puts `.sgsun` on the element it is given, and that class carries `display:flex`,
  which outranks `[hidden]`.
- **A second GM seat has no hidden model.** The latent state is per-browser, so advancing the day
  from a different browser or GM user finds nothing. It reseeds from the published board via
  `latentFromPublished()` so prices carry over exactly; only fair value, momentum, health and the
  event schedule regenerate. Building a fresh latent instead would republish eight brand-new prices
  and the party's positions would be marked against a board that had silently jumped. The selftest
  asserts the reseed is price-identical.
- **`game.settings.get` for `scope: "client"` is per-browser.** If the GM plays from a different
  machine without the vault passphrase, the pending schedule rerolls. Harmless, but say so rather
  than letting it look like a bug.

## 8. Release

```bash
node --check scripts/sundowner-render.js && node --check scripts/sundowner.js
node scripts/sundowner-render.js --selftest
grep -nE '\b(game|ui|Hooks|canvas)\.' scripts/sundowner-render.js     # must be empty
python3 ../tools/build_sundowner.py --check
node ../tools/check_sundowner.js 700 20                               # LAST — carries the leak audit
python3 -c "import json;json.load(open('data/sundowner-content.json'))"
```

Then, in Foundry: a non-GM converts, trades and gambles with a clean player console; two players
race the last shares of a thin listing; a delisting pays holders; a limit order fills on ADVANCE
DAY; a Voidfall cash-out on a throttled client is honoured; and the module still works with the
shop and politics modules disabled.

```bash
# bump "version" in module.json first
git add -A && git commit -m "vX.Y.Z — what changed"
git push origin main
rm -f module.zip && zip -qr module.zip module.json scripts data lang README.md
gh release create vX.Y.Z module.json module.zip --title "vX.Y.Z" --notes "..."
```

`MAINTAINING.md`, `../tools/` and `../preview.html` never ship. Update in Foundry from the
`releases/latest/download/module.json` URL and hard-refresh — browsers cache esmodules.

## 9. API for sibling modules

```js
const api = game.modules.get("ssv-silver-gull-sundowner")?.api;
api?.open();
api?.advanceDay();
api?.grantObols(userId, 1000);
api?.setHeat(userId, 40);
api?.getState();            // { day, market, dead, gmLog }
```

Advancing the day fires `Hooks.callAll("ssv-silver-gull-sundowner.dayAdvanced", { day })`. That is
the in-fiction clock this campaign never had; anything that wants one should listen for it rather
than reaching into this module's settings.
