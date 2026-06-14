// Launcher: starts the local host instantly and prints the room code +
// the LAN URL phones should open. Strictly local — no internet anything.

import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTennisServer } from './game-server.js';
import { rankLanAddresses } from './lan.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// On Windows another service can share-bind our port and swallow the
// traffic without listen() ever failing. Self-probe after launch and fall
// back to an OS-assigned port if our own server isn't the one answering.
const candidates = rankLanAddresses(networkInterfaces());
const ip = candidates[0]?.address ?? 'localhost';

async function startVerified(preferredPort) {
  for (const port of [preferredPort, 0]) {
    const server = await createTennisServer({ port, staticRoot: root, lanHost: ip });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/shared/protocol.js`);
      if (res.ok) return server;
    } catch { /* probe failed — port is haunted */ }
    await server.stop();
  }
  throw new Error('could not bind a working port');
}

const server = await startVerified(Number(process.env.PORT) || 8080);

console.log('');
console.log('  ┌──────────────────────────────────────────────┐');
console.log('  │            LOCAL TENNIS — READY              │');
console.log('  ├──────────────────────────────────────────────┤');
console.log(`  │  ROOM CODE:   ${server.roomCode}                           │`);
console.log(`  │  TV view:     http://localhost:${server.port}/client_host/index.html`);
console.log(`  │  Phones:      http://${ip}:${server.port}/  (same Wi-Fi)`);
console.log('  └──────────────────────────────────────────────┘');
if (candidates.length > 1) {
  console.log('  If phones cannot connect, try these addresses instead:');
  for (const c of candidates.slice(1)) {
    console.log(`    http://${c.address}:${server.port}/  (${c.name})`);
  }
}
console.log('');
