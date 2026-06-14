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

The console prints a **4-digit room code** and two URLs:

- **TV view** — open on the host machine, fullscreen it on the TV.
- **Phones** — each player opens the address on their phone (same Wi-Fi),
  enters the room code, and gets a landscape gamepad: digital joystick +
  FLAT / TOPSPIN / SLICE / LOB / SMASH / VOLLEY, with haptic feedback.

If a phone drops mid-match the game pauses and snapshots the exact state;
reopening the page reconnects to the same slot and resumes losslessly.

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
2v2 is a team-wise split. "How to Play" lives on the TV menu and behind the
"?" button on every phone, rendered from one shared source.

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
```

139 tests across 13 gates, all passing (`npm test`).

## Design constraints

- Court surfaces: grass (fast/low), clay (slow/high, momentum slides), hard (neutral).
- Pure tennis simulation: no weather, no day/night, no gear stats, no power-ups
  (enforced by an automated source audit in the Phase 6 gate).
