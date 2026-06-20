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

async function startVerified(ports) {
  for (const port of ports) {
    const server = await createTennisServer({ port, staticRoot: root, lanHost: ip });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/shared/protocol.js`);
      if (res.ok) return server;
    } catch { /* probe failed — port is haunted */ }
    await server.stop();
  }
  throw new Error('could not bind a working port');
}

// Try stable, friendly ports in order before giving up to an OS-assigned one,
// so the URL stays the SAME across restarts (key for a bookmarkable host URL).
// An explicit PORT= always wins; 8080 is conventional but is share-bound on
// some Windows boxes, so a couple of high ports back it up. Set PORT to pin it.
const preferred = Number(process.env.PORT) || 8080;
const server = await startVerified([preferred, 7777, 51123, 0]);

const hostUrl = `http://${ip}:${server.port}/host`;
console.log('');
console.log('  ┌──────────────────────────────────────────────┐');
console.log('  │            LOCAL TENNIS — READY              │');
console.log('  ├──────────────────────────────────────────────┤');
console.log(`  │  ROOM CODE:   ${server.roomCode}                           │`);
console.log(`  │  TV / Host:   ${hostUrl}  (open on ANY device on the Wi-Fi)`);
console.log(`  │  On this PC:  http://localhost:${server.port}/host`);
console.log(`  │  Phones:      http://${ip}:${server.port}/  (same Wi-Fi)`);
console.log('  └──────────────────────────────────────────────┘');
console.log('  The first device to open the TV/Host URL becomes the TV; opening it');
console.log('  on another device moves the TV there. Phones just open the Phones URL.');
if (candidates.length > 1) {
  console.log('  If a device cannot connect, try these addresses instead:');
  for (const c of candidates.slice(1)) {
    console.log(`    http://${c.address}:${server.port}/  (phones)  ·  /host (TV)   (${c.name})`);
  }
}
console.log('');
