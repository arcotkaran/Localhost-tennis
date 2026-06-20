# Playing Local Tennis 🎾

A couch multiplayer tennis game. One machine (a laptop or mini-PC plugged
into your TV) runs the game; everyone uses their phone as a controller over
your local Wi-Fi. **No internet required** — everything is served from the
host machine.

## Setup (one minute)

1. On **any one machine** on your Wi-Fi (it doesn't have to be the one wired to
   the TV):
   ```bash
   npm install      # first time only
   npm start
   ```
2. The console prints a panel like:
   ```
   ROOM CODE:   4821
   TV / Host:   http://192.168.0.83:7777/host   (open on ANY device on the Wi-Fi)
   On this PC:  http://localhost:7777/host
   Phones:      http://192.168.0.83:7777/        (same Wi-Fi)
   ```
3. Open the **TV / Host** URL on whatever screen you want to play on — the
   laptop on the TV, a smart-TV browser, a spare tablet — and make it
   fullscreen (F11). **The first device to open it becomes the TV**; opening it
   on another device moves the TV there (the old one shows a "reload to take it
   back" notice). You'll see the menu with a **QR code**.
4. Each player opens their phone camera and **scans the QR code** (or types
   the `Phones:` address), then enters the 4-digit **join code** shown on the
   TV. Hold the phone sideways.

> The host URL stays the same across restarts (the launcher prefers stable
> ports). To pin it, run `PORT=7777 npm start` with a port you know is free.

That's it. Up to 4 phones. Any empty seat is played by the AI, so you can
start a match solo or with a full doubles lineup.

## Controls (also on the TV "How to Play" and the phone "?" button)

- **Move** (left side of the phone): touch and drag anywhere — a joystick
  appears under your thumb and you run that way. On clay you slide.
- **Hit** (right side of the phone): swipe — no buttons, so you never look down.
  - **Tap** = a **lob** over a net-rusher.
  - **Swipe up** = a **drive**: a slower swipe is heavy **topspin**, a faster
    one a flat **bullet**.
  - **Swipe down** = a **slice** / drop shot.
  - The swipe's **left/right angle aims** the ball and its **speed sets the
    power** — so a diagonal up-right swipe is a drive placed to the right, a
    down-left swipe a slice placed left.
  - **Smash** (high ball) and **volley** (at the net) happen automatically.
  - Swipe *as the ball arrives* — the timing window is about half a second.
- **Serve**: when it's your serve, the TV prompts you and your phone buzzes.
  **Tap to toss** the ball up, then **swipe to strike** it — the strike swipe
  aims, paces, and shapes the serve.

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
