# Local Tennis 🎾

A lightweight, zero-lag, instant-setup local multiplayer tennis platform.
The host machine renders the game (browser window on a TV via HDMI); up to
four players use their phones as controllers over local Wi-Fi. Strictly
local — no internet matchmaking, no accounts, nothing leaves the room.

**Zero internet required.** Every asset — the 3D engine and QR generator
included — is served from the host, so it runs on a Wi-Fi island with no
connection. Phones join by **scanning a QR code** on the TV. Player-facing
guide: [PLAYING.md](PLAYING.md).

## Play

```bash
npm install
npm start
```

The console prints a **4-digit room code** and the URLs:

- **TV / Host** — open `http://<lan-ip>:<port>/host` (or `/tv`) on whatever
  screen you want to play on: the laptop wired to the TV, a smart-TV browser, a
  spare tablet. **Any device on the Wi-Fi can be the TV** — the first to open
  the URL becomes it, and opening it on another device moves the TV there (the
  old one shows a "reload to take it back" notice). Fullscreen it (F11). The
  machine running `npm start` does not have to be the TV.
- **Phones** — each player types a name, enters the room code, and gets a
  landscape gamepad: a floating movement joystick on the left, swipe-to-hit
  on the right — tap to lob, swipe up to drive (topspin or flat by speed),
  swipe down to slice, with the swipe angle aiming and its speed setting power
  — plus haptic feedback. Serving is two-step — tap to toss, swipe to strike.
  A phone can even pick the settings and **start the match itself**, so the
  laptop never has to be touched at the menu.

If a phone drops mid-match the game pauses and snapshots the exact state;
reopening the page reconnects to the same slot and resumes losslessly. Player
names show on the TV scoreboard and banners, and either the TV or a phone can
end a match back to the menu.

## Architecture

| Directory | Role |
|---|---|
| `server/` | Local WebSocket host, room codes, pause/resume state manager, lag compensator (clock sync + input reordering) |
| `client_host/` | TV renderer (Three.js), audio director, reactive crowd AI, interaction sequencer |
| `client_mobile/` | Controller UI, anti-shrink viewport, orientation lock + iOS CSS-rotate fallback, haptics, input mapper |
| `shared/` | Physics (gravity, drag, Magnus effect, surface models, clay sliding), tennis scoring, AI, split-screen layouts, roster, tournament, GameDirector (the complete headless game loop: serve flow, swing windows, doubles slot mapping, AI fallback) |
| `tests/` | Per-phase automated gates (see below) |

## Game modes

From the TV menu: **Quick Match** (vs AI, 1v1, or 2v2 doubles) or **Tournament**
(4 entrants, bracket to a champion with a trophy ceremony). Three formats:
short set (first to 4), one set, best of 3. Three surfaces with real physics
differences. Matches open with a walk-on + net handshake cinematic; doubles
partners tap rackets after points; champions lift the trophy.

All sound is synthesized in-browser (racket cracks, surface-tuned bounces,
power-scaled grunts, crowd swells) — no audio assets needed.

Presentation: night-session stadium bowl (tiered stands, instanced crowd,
roofline floodlights), real-time shadows with ACES filmic tone mapping,
articulated player models with walk cycles, per-shot swing animations, and
a body-language engine — fist pumps, slumps, head shakes, and facial
expressions that track the score. 1v1 renders as stacked full-width bands;
2v2 is a team-wise split. Broadcast touches: a **live mini-stats** line (rally
counter + aces) during play, a **slow-mo replay** of the winning shot on
highlight points (match/break points, long rallies, smashes, aces), and an
end-of-match **match-stats card** (aces, winners, unforced errors, double faults,
fastest serve, longest rally). Players can fire **emotes/taunts** from their
phone that pop as floating bubbles on the TV. "How to Play" lives on the TV menu
and behind the "?" button on every phone, rendered from one shared source.

## Testing gates

Every phase has a gate that must pass 100% before the next phase:

```bash
npm test               # all gates
npm run test:phase1    # network: 4 phones, disconnects, latency spikes
npm run test:phase2    # controller: viewport, orientation, haptics, input
npm run test:phase3    # physics: 50 launch combos × 3 surfaces, Magnus, energy
npm run test:phase4    # gameplay: scoring edge cases, headless 5-set AI matches
npm run test:phase5    # presentation: crowd state machine, frame/memory budget
npm run test:phase6    # tournament: end-to-end cup, roster traits, exclusions audit
node --test tests/phase7.integration.test.js  # playable integration: director, swings, haptic relay
npm run test:phase8    # session flow: quick/tournament, cinematics
npm run test:phase9    # audio synthesis + model/animation specs
npm run test:phase10   # emotions, how-to-play, stacked split
npm run test:phase11   # pause sync, slot recycling, controller resilience
npm run test:phase16   # launch a match from a phone (LAUNCH / LOBBY_STATE)
npm run test:phase17   # player names: sanitize, team labels, propagation
npm run test:phase18   # end-game: quit to menu from TV or phone
npm run test:phase19   # serve faults & double faults
npm run test:phase20   # tap-to-toss two-step serve
npm run test:phase21   # flight recorder + shared testbed plan
```

239 tests across 21 gates, all passing (`npm test`).

## Test Lab & flight recorder

The game ships with a built-in test setup that drives the **real** `GameDirector`
through the same gesture → input path a phone uses, with a structured **flight
recorder** you can read to diagnose bugs.

- **Flight recorder** — pass `log: true` to a `GameDirector` (or share a
  `GameLog`) and it captures a timestamped, structured trace of everything: state
  transitions, every input, each shot/serve's *intended vs. actual* outcome, and
  bounces/faults/points. It even **flags contradictions** (e.g. a serve that
  bounced in the box yet was ruled fault) at `warn` level. Off by default — zero
  cost in normal play. Source: [`shared/game-log.js`](shared/game-log.js).
- **`npm run testbed`** — runs the canonical shared plan
  ([`tools/testbed/plan.mjs`](tools/testbed/plan.mjs)) over every shot, serve,
  movement and full-match flow, prints a ✓/✗ ticker, writes `BUGREPORT.md`
  (severity + expected-vs-measured + the trace slice explaining each failure),
  and dumps `logs/trace-*.jsonl` for any failure.
- **Live 2D Test Lab** — `npm start`, then open **`/lab`** on the host. A
  watchable top-down court animates every test case (ball trails, green/red
  in-out markers, the dashed serve-target box) with a live pass/fail list and the
  **live flight-recorder log** streaming alongside. **Run all** for the full
  sweep, or **Manual** to fire any single shot/serve/move with aim/power/
  sensitivity sliders. Runs the same plan as the headless runner.
- **Watch a real 3D match** — open **`/host?bot`** for a hands-free auto-played
  match on the cinematic TV, or run
  [`node tools/bot-phone.mjs`](tools/bot-phone.mjs) to drive bot-phone(s) over the
  real WebSocket path (server relay + lag compensation).

## Design constraints

- Court surfaces: grass (fast/low), clay (slow/high, momentum slides), hard (neutral).
- Pure tennis simulation: no weather, no day/night, no gear stats, no power-ups
  (enforced by an automated source audit in the Phase 6 gate).
