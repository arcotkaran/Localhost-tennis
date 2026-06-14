# Playing Local Tennis 🎾

A couch multiplayer tennis game. One machine (a laptop or mini-PC plugged
into your TV) runs the game; everyone uses their phone as a controller over
your local Wi-Fi. **No internet required** — everything is served from the
host machine.

## Setup (one minute)

1. On the host machine (the one connected to the TV):
   ```bash
   npm install      # first time only
   npm start
   ```
2. The console prints a panel like:
   ```
   ROOM CODE:   4821
   TV view:     http://localhost:54493/client_host/index.html
   Phones:      http://192.168.0.83:54493/   (same Wi-Fi)
   ```
3. Open the **TV view** link in a browser on the host and make it fullscreen
   (F11). You'll see the menu with a **QR code**.
4. Each player opens their phone camera and **scans the QR code** (or types
   the `Phones:` address), then enters the 4-digit **join code** shown on the
   TV. Hold the phone sideways.

That's it. Up to 4 phones. Any empty seat is played by the AI, so you can
start a match solo or with a full doubles lineup.

## Controls (also on the TV "How to Play" and the phone "?" button)

- **Joystick** (left side of the phone): run around your half of the court.
  The joystick direction also **aims** your shot — hold left/right as you hit.
- **Serve**: when it's your serve, the TV prompts you and your phone buzzes.
  Tap any shot button to serve.
- **Shot buttons**: FLAT (fast), TOPSPIN (heavy, dips in), SLICE (low skid),
  LOB (over a net-rusher), SMASH (overhead kill), VOLLEY (quick net punch).
  Press one *as the ball arrives* — the timing window is about half a second.

## Modes

- **Quick Match** — vs AI, 1v1 local, or 2v2 doubles. Pick the surface
  (hard / clay / grass — they really play differently), format (short set,
  one set, or best of 3), AI level (easy / normal / hard), and characters.
- **Tournament** — 4 entrants, semifinals to a final, with a trophy ceremony
  for the champion.

## If a phone disconnects

The game pauses and saves the exact moment. Reopen the page on that phone
(it remembers the room) and play resumes right where it stopped.

## Troubleshooting

- **Phone can't reach the address?** Make sure the phone is on the *same*
  Wi-Fi as the host. If the host has several network adapters, the console
  lists alternate addresses to try under "If phones cannot connect…".
- **TV view is blank?** It needs WebGL — use a recent Chrome/Edge/Firefox.
  No internet is needed; all assets (3D engine, QR generator) are local.
- **Port looks unusual?** On some machines port 8080 is taken, so the game
  picks a free one automatically and prints it. Always use the printed link.
