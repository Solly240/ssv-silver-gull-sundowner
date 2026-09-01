# SSV Silver Gull — Sundowner Net

A black-market terminal for the SSV Silver Gull campaign. **Press `B`.**

The Sundowner Net is a pirate darknet run out of the casino-city on Sundowner, reachable from
any terminal with a bad enough conscience. It gives the crew something to do with money between
scenes that is not shopping.

## For players

Four tabs.

**WALLET** — the Net does not take coin. It takes **Obols (ØB)**. 100 ØB costs 10 gp going in and
returns 9.80 gp coming out, and the house widens that spread if you get interesting. Converting
does not cost you a trade.

**EXCHANGE** — eight listed companies, all of them real places in this galaxy. Buy and sell, or
leave a limit or stop order resting overnight. Big orders move thin listings against you and the
price stays moved, so a stock you can push is a stock you cannot get out of. Companies go under;
holders get a few coins on the hundred and the row drops to the bottom of the board with an
epitaph. Something else lists in its place.

**PIT** — eight games. Four of them run off your character's ability checks — the Ladder (INT),
Signal Skim (WIS), Cold Read (CHA) and the Ice Run (DEX) — so everybody at the table is good at
something. The other four are Voidfall, Hollow Roulette, Pit Wagers and Salvage Chits. The house
reads your rating and prices the game against it: your stat buys you a better losing proposition,
never a winning one. Nothing here has an expected return above 1.

**WIRE** — news and rumours. Some of it is true, some of it is noise, and some of it has been
planted by people who want you to buy something. Every source builds a visible hit rate over time,
so you can learn who to trust — which is exactly what the people planting rumours are counting on.
Once a day you can lean on one story with an Insight or Investigation check to see whether it
smells right.

You get a set number of trades and plays each day. When they run out, the GM moves the clock.

**Heat.** Cheating, huge wins, sudden withdrawals and suspiciously well-timed trades all raise it.
High Heat means worse spreads, smaller ceilings, refused games, and eventually somebody looking
for you.

## For the GM

- **ADVANCE DAY** is top-right, and it is two-step: you see what the day will do, can roll a
  different one, and only then commit. It ticks the market, resolves rumours, fills resting
  orders, resets everyone's slots and decays Heat.
- Each tab has a **⚙** with the controls for that tab: adjust an account, set Heat, shock or kill
  a listing, post a headline, plant your own rumour, deal a new fight card.
- Every rumour on the WIRE has a **SAY THIS** button that posts the line to chat in the voice of
  whoever is supposed to have said it, so you can drop a market tip mid-scene without opening this.
- The market reads the party's **faction standing** out of the politics module. Making peace with
  the Apostles cools the arms trade and lifts salvage; angering them does the reverse. If the
  politics module is off, the terminal says its faction telemetry is offline rather than pretending.
- Settings: master on/off switch for the Net, whether players can open it, trades and plays per
  day, and whether advancing the day also restocks the shops.

### One thing worth knowing

The hidden half of the market — the model state, the schedule of events that have not happened
yet, and which rumours are lies — lives in **your browser's local storage**, because that is the
only thing in Foundry a player genuinely cannot read. It is backed up to the world as encrypted
text. If you clear your cache or move to a new machine, the terminal will ask for your market
passphrase to restore it. If you never set one, the schedule simply rerolls, which costs you
nothing but a few pending rumours.
