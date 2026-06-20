# Building "Local Tennis" — a zero-internet, phones-as-controllers party game

*A technical project report. The first section is a ready-to-adapt LinkedIn
post; everything below it is the full engineering writeup.*

---

## 📣 LinkedIn post draft (copy, trim, ship)

I built a couch-multiplayer tennis game that needs **zero internet**. 🎾

The setup is the whole pitch: plug a laptop into your TV, and up to four
people point their phone cameras at a QR code on the screen. No app install,
no account, no router config, no cloud. Phones become swipe controllers; the
TV becomes Centre Court. Everything — the 3D engine, the QR generator, the
physics, the audio — is served from the laptop itself, so it runs on a Wi-Fi
island with no connection at all.

What made it fun to build was that "simple party game" hides a stack of real
engineering problems:

• **Real ball physics** — true gravity, quadratic aerodynamic drag, and the
  Magnus effect, so topspin dives and slices float. Net clearance and
  keep-it-in are solved by *forward-simulating each shot* before it's struck,
  not by faking it.

• **Phones as low-latency controllers** — a swipe's *direction* aims, its
  *speed* powers, its *shape* picks the shot. Clock-sync + input reordering
  keep it crisp on jittery Wi-Fi.

• **The bugs that teach you things** — a Windows service silently
  share-binding our port; a virtual network adapter handing phones an
  unreachable URL; background browser tabs throttling the game loop to 1 Hz;
  a server relay quietly dropping two fields and breaking every swipe.

The whole thing was built **test-first**: 167 automated tests across 15
phased gates, ~4,200 lines of application code, all the game logic in pure,
headless modules so a match can be simulated and asserted without a GPU.

Sometimes the most "throwaway" project is the one that makes you solve
aerodynamics, distributed clocks, and Windows networking in the same weekend.

`#gamedev` `#javascript` `#threejs` `#webdev` `#physics`

---

# The full writeup

## 1. The challenge

The brief was deceptively casual: *"I want a tennis game we can all play in
the living room in under a minute, using our phones, with nothing to install
and no internet."*

Unpacking that one sentence produces a surprisingly strict set of
constraints:

- **Instant setup.** From "npm start" to "serving" should be under a minute,
  for non-technical players. That rules out app stores, sign-ups, and pairing
  dances.
- **Phones as controllers, TV as display.** Two completely different clients
  with different jobs, talking in real time.
- **Strictly local.** No internet matchmaking, no accounts, nothing leaves
  the room. This is a privacy and reliability feature — but it also means
  *every asset must be self-hosted*, including the 3D engine.
- **It has to feel like tennis.** Not an arcade approximation — real scoring,
  real shot shapes, surfaces that play differently.

The result is a host (`server/index.js`) that boots a local WebSocket + HTTP
server, prints a room code and a LAN URL, renders the match in a browser on
the TV, and accepts up to four phone controllers that join by scanning a QR
code.

## 2. Architecture at a glance

The project is organized around one hard rule: **all game logic lives in
pure, headless modules, and the renderer is thin glue.** This is what makes
the game testable — a full match can be simulated and asserted in Node with
no browser and no GPU.

| Layer | What lives there |
|---|---|
| `shared/` | The brain. Physics, scoring, AI, the per-match `GameDirector`, the top-level `SessionController`, swipe→shot gestures, roster, tournament bracket, and the wire protocol. **All node-testable.** |
| `server/` | The nervous system. WebSocket host, 4-digit room codes, pause/resume snapshotting, the input relay, lag compensation (clock sync + input reordering), and LAN address discovery. |
| `client_host/` | The TV. A three.js renderer plus glue: audio director, reactive crowd AI, an emotion/body-language engine, and the interaction sequencer for cinematics. |
| `client_mobile/` | The phone. A multitouch controller — floating joystick on the left, swipe-to-hit on the right — with orientation handling and haptics. |
| `vendor/` | three.js and a QR generator, **vendored locally** so the game runs with no internet. |
| `tests/` | 15 phased gates, 167 tests, run via `node --test`. |

Rough size: **~4,200 lines of application code** (11 shared modules, 4 server
modules, two HTML clients with their JS), plus **167 tests across ~2,900 test
lines**, plus the vendored engine.

The data flow for a single swing:

```
phone swipe ─▶ gesture→shot ─▶ WS INPUT {action, aim, power, sens}
            ─▶ server relay (+ lag comp) ─▶ TV
            ─▶ GameDirector.handleInput ─▶ physics step ─▶ events
            ─▶ renderer draws + audio/crowd/emotion react
```

The two authoritative objects are `SessionController` (menu → match →
tournament → trophy → menu) and `GameDirector` (the per-match loop: serve
flow, rally physics, swing-timing windows for humans, AI fallback for empty
seats, point/score resolution). The TV only ever *draws what the director
says and forwards phone input into it*.

## 3. The phased, test-first approach

The game was built in **15 phases**, each gated by an automated test suite
that had to pass 100% before the next phase began. The phases roughly tracked
risk: networking first (phase 1), then the controller, then physics, then the
game loop, presentation, tournament, integration, session flow, polish, and
finally several rounds of "real match" hardening driven by actually playing
it on phones.

This ordering matters. Networking and physics are the two places where bugs
are *expensive to discover late* — one because it's hard to reproduce, the
other because it quietly corrupts feel. Putting them under test first meant
every later phase built on a foundation that was already pinned down.

Because the logic is headless, the tests are real tests, not smoke tests. A
few examples of what's actually asserted:

- A full AI-vs-AI match plays to completion **on every surface**, every time.
- Energy is conserved across a ball's flight (a physics correctness check).
- Tournaments produce *varied* outcomes across seeds (no rigged bracket).
- An armed swipe within the timing window produces *exactly* that shot; no
  press = a whiff and a lost point.
- The serve lands in the diagonally-correct service box.
- Network: 4 phones, disconnects, latency spikes, and lossless resume.

## 4. The hard problems, and how they were solved

### 4.1 Aerodynamic ball physics with the Magnus effect

The ball isn't on rails. Each step integrates three forces:

- **Gravity**, straightforward.
- **Quadratic aerodynamic drag**: `F = -½·ρ·Cd·A·|v|·v`, using the measured
  drag coefficient and frontal area of a regulation ball. Drag scales with
  the *square* of speed, which is why a hard flat drive decelerates so much
  more than a soft slice.
- **The Magnus force**: `F ∝ ω × v`. Because it's a cross product, it's always
  perpendicular to velocity — it can *redirect* the ball but never add energy.
  Topspin (spin axis set so `ω × v` points down) makes the ball dive; backspin
  and slice make it float. This is what gives each shot its real-world shape
  instead of a generic parabola.

Integration is semi-implicit Euler at a fixed 120 Hz, which is stable for
this regime and keeps the simulation deterministic. Surfaces then change the
bounce: restitution sets bounce height, grip retention sets how much pace
survives the bounce, and a small spin-kick term lets topspin grip and kick
forward while slice checks up. Clay even gives players controlled momentum
slides via a low player-friction model.

### 4.2 Net clearance and keep-it-in via forward simulation

This is the problem I'm proudest of solving honestly.

Early versions used kinematic estimates — "given this launch angle, will the
ball clear the net?" — and they were *wrong*, because drag and the Magnus dip
change the trajectory in ways a closed-form parabola doesn't capture. Topspin
shots that "should" clear were diving into the net; slices that "should" land
in were sailing long.

The fix was to stop guessing and **forward-simulate the actual shot**:

- `heightAtNet()` clones the ball and steps the real physics to the net plane
  (z = 0), returning the height there. Net clearance then becomes a tiny loop:
  while the simulated height at the net is too low, nudge vertical velocity up
  and re-simulate, until it clears by a margin. (And for a deliberate AI error
  — a "net dump" — push it *down* until it's guaranteed to fail.)
- `landingPoint()` clones the ball and steps it to its first bounce, returning
  where it lands. `keepLandingWithin()` then eases the shot's *horizontal*
  pace (preserving the vertical arc, so net clearance is untouched) until the
  ball lands inside the singles court with a safety margin — depth *and* width.

So a human's shot is guaranteed to clear the net and stay in, not by clamping
outputs arbitrarily, but by running the same physics the game will run and
adjusting until the predicted outcome is legal. It's a mini model-predictive
controller, and it's the reason the game stopped feeling broken.

The serve uses the same trick in reverse: it eases pace until the ball lands
in the diagonal **service box** — past the net, inside the service line, on
the correct side.

### 4.3 The swipe-vector control scheme

Players can't look down at their phone mid-rally, so there are no buttons to
hunt for. The right half of the screen is a swipe surface, and the swipe
*vector* does everything at once:

- **Shape picks the shot**: a tap = lob (over a net-rusher), swipe up = a drive
  (a slower swipe is heavy topspin, a faster one a flat bullet), swipe down =
  slice (a soft drop shot).
- **Horizontal component aims**: left/right placement.
- **Speed sets power**: a fast swipe hits harder.

So a quick diagonal flick down-and-right is "a slice, placed to the right," and
an up-and-right swipe is "a drive, placed to the right." A tap lobs up the
middle. Smash and volley are applied
automatically by the engine (a high sitter is smashed; a ball met at the net
is volleyed), because the phone has no ball-height information and shouldn't.
The left half is a *floating* joystick — touch anywhere and it appears under
your thumb — and both halves work simultaneously via per-touch identifiers.

`gestureToShot()` (the pure mapping) and `InputMapper` (the wire encoder) are
both headless and tested; the DOM glue just feeds them touch coordinates.

### 4.4 Camera-relative control inversion for the far player

A subtle one that produced "the controls are backwards" complaints. The two
ends of the court are filmed by cameras facing opposite directions. For the
near team (team 0), the camera faces −z, so the player's screen-relative
joystick matches world space. For the far team (team 1), the camera faces
+z — so "push up to run toward the net" is the *opposite* world direction,
on *both* axes, and "swipe right" is the opposite world-x.

The director negates a team-1 *human's* movement (both axes) and their
shot/serve aim, so every human's controls are screen-relative and correct.
Crucially, **AI input is computed in world space and must NOT be flipped** —
mixing those up makes the AI run away from the ball. There are dedicated
tests asserting that the same swipe maps to opposite world-x for the two
teams, and that AI movement is untouched.

### 4.5 The silent server bug that dropped swipe fields

This one cost real debugging time and is a good cautionary tale. On real
phones, every swipe's placement and power were being ignored — shots flew
out, aim fell back to the movement stick. The director was correct. The
gesture mapping was correct. The phone was sending the right data.

The culprit was the **server's INPUT relay**. It forwarded `move` and
`action` to the TV but silently dropped `aim`, `power`, and `sens`. Because
those fields just became `undefined` downstream, nothing errored — the game
quietly used fallback behavior. It was invisible to any test that called the
director directly, because the director was never the problem.

The fix was one line (forward all five fields), but the *lesson* was
durable: **when a phone-driven behavior can't be reproduced by calling the
logic directly, suspect the relay.** There's now a test that runs over real
WebSockets and asserts a swipe's `aim`/`power`/`sens` actually arrive at the
host — so this class of bug can't come back silently.

### 4.6 Lag compensation with clock synchronization

Local Wi-Fi is low-latency but *jittery*, and phones have unsynchronized
clocks. To keep swing timing fair:

- **Clock sync** estimates each phone's clock offset from ping/pong samples,
  assuming symmetric latency (`offset = serverT − clientT − rtt/2`). The key
  refinement: it takes the **median offset of the lowest-RTT half** of
  samples. A latency spike inflates RTT and corrupts the symmetric-latency
  assumption, so clean samples are trusted and spikes are rejected.
- **Input reordering** buffers inputs and drains them ordered by their
  *server-time-adjusted* timestamps, with a per-player monotonic sequence
  guard so a spike can never let swing #5 apply before #4, and a
  dedup/replay guard.

### 4.7 The Windows "haunted port 8080"

On the development machine, `svchost.exe` share-binds `0.0.0.0:8080`. Node's
`listen(8080)` *succeeds* — no error — but incoming HTTP connections are
silently reset by the service. "Server started" was a lie.

The fix is a **self-probe on launch**: after binding, the launcher fetches
one of its own endpoints over loopback. If its own server isn't the thing
answering, it tears down and falls back to an OS-assigned ephemeral port,
then prints whatever port actually works. A `PORT` env var overrides. The
takeaway baked into the code: *a "listening" log line is not proof of
reachability.*

### 4.8 Virtual-adapter LAN discovery

A sibling networking gremlin. On Windows, Hyper-V/WSL create virtual NICs
with non-internal IPv4 addresses (typically 172.16–31.x) that phones can
*never* reach — and these often enumerate *before* the real home-LAN NIC.
Naively picking "the first non-internal IPv4" handed players a dead URL
(`ERR_NETWORK_ACCESS_DENIED`).

`rankLanAddresses()` scores every candidate: home-router subnets
(192.168.x / 10.x) score high, the 172.16–31.x NAT range scores low,
adapter-name hints ("Wi-Fi") add points, and known-virtual names
(vEthernet, WSL, Docker, VMware, Tailscale…) and APIPA (169.254.x)
addresses are penalized hard. The highest-scoring address is the one printed
for phones, with the rest offered as fallbacks.

### 4.9 The background-tab `setInterval` throttle

The TV runs the simulation on `setInterval`, **not** `requestAnimationFrame`
— deliberately, so the match and the pause/reconnect machinery keep running
even if the host window is hidden or backgrounded for the phones' sake. rAF
only *draws*.

But browsers throttle background-tab timers to ~1 Hz. That bites
*automation*: an unfocused preview/automation tab makes the match crawl and
screenshots time out. The workaround is a debug hook —
`window.__tennis.forceRender()` renders exactly one frame synchronously, and
a loopback-only `POST /api/debug/frame` endpoint writes the canvas to disk so
an automated check can inspect real pixels without depending on rAF.

### 4.10 QR join and lossless pause/resume

Joining is "point your camera at the TV." The TV fetches the room code from a
**loopback-only** `/api/info` endpoint (so the code is only readable on the
host machine, not by anyone on the LAN), generates a QR for the LAN URL with
the vendored generator, and shows it on the menu.

If a phone drops *mid-match*, the server snapshots the exact game state (a
deep clone, so later mutation can't corrupt it), pauses, and tells everyone.
The same player reopens the page — the phone remembers the room — reconnects
to the *same slot*, and play resumes from the snapshot. A drop *between*
matches instead frees the seat so a different phone can take it. This
host↔server "match phase" handshake (the TV announces `playing` on match
start and `lobby` on match end) is what arms the pause-on-disconnect
machinery; without it, a mid-match disconnect wouldn't pause at all.

### 4.11 Vendoring three.js for offline use

"No internet" is absolute, so there can be no CDN. three.js and the QR
generator are committed to `vendor/` and served by the host. An import map
maps `"three"` to the local module; the QR library is a classic script that
exposes a global before the modules run. A crawler test in the phase-1 gate
walks every asset the pages reference and asserts each one loads — so a
stray CDN link or a broken relative path fails the build instead of failing
in someone's living room.

## 5. The 167-test suite

Testing isn't a phase here; it's the substrate. Highlights of what the
suite locks down:

- **Physics** — 50 launch combinations × 3 surfaces, Magnus behavior,
  energy conservation.
- **Scoring** — 15/30/40, deuce, advantage, tiebreaks, sets, best-of-N,
  server rotation including tiebreak order.
- **Game loop** — serve flow, swing windows, the no-press whiff, doubles
  "nearest partner takes it," AI fallback, headless full matches.
- **Network** — 4 phones, disconnects, latency spikes, lossless
  reconnection, and the relay-carries-swipe-fields regression test.
- **Hardening** — the match-phase handshake end to end, lobby seat
  recycling, mid-match seat holding, post-match cleanup — all over real
  WebSockets.
- **Presentation** — crowd state machine, a per-frame budget, audio synth
  recipes, player-model specs, and animation curves (rest at the endpoints,
  peak mid-swing, smash overhead).

Because the model is pure, these run in a couple of seconds and give the
confidence to keep refactoring the feel of the game without fear.

## 6. What I'd take to the next project

- **Forward-simulate instead of approximating.** When the system already has
  an accurate model (the physics step), running it to predict an outcome and
  adjusting beats any closed-form shortcut — and it stays correct when you
  change the model.
- **Put the logic where you can test it.** A headless core turned "is the
  game fun and correct?" into assertions, not vibes.
- **Distrust the boundaries.** The nastiest bugs lived in the seams — the
  server relay, the network adapter list, the browser's tab throttling — not
  in the algorithms. Test the seams over the real transport.
- **A green log line is not proof.** Bind succeeded; the port was still
  haunted. Verify reachability, not just absence of errors.

---

*Stack: Node.js, vanilla ES modules, the `ws` WebSocket library, and
three.js (vendored). No build step, no framework, no internet.*
