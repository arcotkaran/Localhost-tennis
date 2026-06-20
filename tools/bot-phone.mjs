// Opt-in bot-phone(s) — drive the REAL game over the REAL WebSocket path
// (server relay + lag compensation), so you can WATCH a phone-controlled player
// on the actual 3D TV renderer. This is the "see it live, on the real game"
// companion to the headless testbed and the 2D Test Lab.
//
//   node tools/bot-phone.mjs [--port 8080] [--count 1] [--name BOT] [--code 1234]
//
// Start the server (npm start) and open the TV (/host) first, then run this.
// Each bot joins as an ordinary phone, two-step-serves when cued, and keeps the
// avatar busy with movement + periodic swings. It plays "blind" (phones aren't
// sent ball state over the wire — by design), so it's a liveness/visual demo,
// not a skilled opponent. For a skilled hands-free 3D match instead, just open
// /host?bot (the in-page auto-player reads the live sim directly).

import { connectPhone, GESTURES } from './phone-sim.mjs';
import { MSG } from '../shared/protocol.js';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT = Number(arg('port', process.env.PORT || 8080));
const COUNT = Number(arg('count', 1));
const BASE_NAME = arg('name', 'BOT');

async function resolveCode(explicit) {
  if (explicit) return explicit;
  const res = await fetch(`http://127.0.0.1:${PORT}/api/info`).then(r => r.json());
  return res.roomCode;
}

async function spawnBot(code, n) {
  const name = COUNT > 1 ? `${BASE_NAME}${n + 1}` : BASE_NAME;
  const bot = await connectPhone(PORT, { code, playerId: `bot-phone-${n}`, name });
  console.log(`  ${name} joined room ${code}`);

  let processed = 0;
  let dir = 1;            // movement oscillation direction
  let tick = 0;

  const loop = setInterval(() => {
    // React to serve cues the TV relays to the serving phone (two-step serve).
    for (; processed < bot.inbox.length; processed++) {
      const m = bot.inbox[processed];
      if (m?.type === MSG.SERVE_CUE && m.on) {
        bot.tap();                                  // toss
        setTimeout(() => bot.swipe(GESTURES.flat), 320); // strike near the apex
      }
    }
    // Keep the avatar alive: sweep side to side, occasionally take a swing.
    tick++;
    if (tick % 16 === 0) dir *= -1;
    bot.move(dir, 0);
    if (tick % 22 === 0) bot.swipe(tick % 44 === 0 ? GESTURES.topspin : GESTURES.flat);
  }, 90);

  return { bot, stop: () => { clearInterval(loop); bot.close(); } };
}

const code = await resolveCode(arg('code', null));
console.log(`Connecting ${COUNT} bot-phone(s) to ws://127.0.0.1:${PORT} (room ${code})…`);
const bots = [];
for (let i = 0; i < COUNT; i++) bots.push(await spawnBot(code, i));
console.log('Bots are live. Open the TV at /host to watch. Ctrl+C to stop.');

process.on('SIGINT', () => { for (const b of bots) b.stop(); process.exit(0); });
