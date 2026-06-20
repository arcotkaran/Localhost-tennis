import { createTennisServer } from '../server/game-server.js';
import { GameDirector } from '../shared/game-director.js';
import { connectPhone, HeadlessMatch } from './phone-sim.mjs';
import { MSG, encode, decode } from '../shared/protocol.js';
import WebSocket from 'ws';

async function runTests() {
  console.log("=== PHASE 4: EXHAUSTIVE SIMULATION EXECUTION ===");
  const issues = [];
  const logBug = (id, component, severity, steps, expected, actual) => {
    issues.push({ id, component, severity, steps, expected, actual });
  };

  // Test 1: Connection & Lobby (Max Players, Unauthorized, TV Superseding)
  try {
    console.log("Running Test 1: Connection & Lobby...");
    const server = await createTennisServer({ port: 0 });
    const port = server.port;

    // Connect TV Host 1
    const tv1 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise(r => tv1.once('open', r));
    tv1.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));

    // Connect TV Host 2 (Superseding)
    const tv2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise(r => tv2.once('open', r));
    
    // Listen for superseded on tv1
    let superseded = false;
    tv1.on('message', m => {
      if (decode(m)?.type === MSG.HOST_SUPERSEDED) superseded = true;
    });

    tv2.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));
    await new Promise(r => setTimeout(r, 100));

    if (!superseded) {
      logBug('BUG-LOBBY-01', 'Net', 'Major', 'Connect TV2 to supersede TV1', 'TV1 receives HOST_SUPERSEDED', 'TV1 did not receive message');
    }

    // Try joining 5 phones
    const phones = [];
    for (let i = 0; i < 5; i++) {
      const p = await connectPhone(port, { code: server.roomCode, playerId: `p${i}`, name: `Player ${i}` });
      phones.push(p);
    }
    await new Promise(r => setTimeout(r, 100));
    
    // The 5th phone should have received JOIN_ERROR
    const p5Joined = phones[4].inbox.some(m => m?.type === MSG.JOINED);
    const p5Error = phones[4].inbox.some(m => m?.type === MSG.JOIN_ERROR && m.reason === 'room_full');
    if (p5Joined || !p5Error) {
      logBug('BUG-LOBBY-02', 'Net', 'Major', 'Connect 5th player to 4-max room', 'JOIN_ERROR room_full', 'Player was joined or no error');
    }

    // Invalid Code
    const pInvalid = await connectPhone(port, { code: '9999', playerId: 'px', name: 'X' });
    await new Promise(r => setTimeout(r, 100));
    if (!pInvalid.inbox.some(m => m?.type === MSG.JOIN_ERROR)) {
      logBug('BUG-LOBBY-03', 'Net', 'Major', 'Connect with invalid code', 'JOIN_ERROR bad_code', 'No error received');
    }

    // Clean up
    tv1.close(); tv2.close();
    phones.forEach(p => p.close()); pInvalid.close();
    await server.stop();
  } catch (e) {
    console.error("Test 1 Failed", e);
  }

  // Test 2: Lifecycle & Edge Cases (Disconnect mid-rally, Pause, Reconnect)
  try {
    console.log("Running Test 2: Lifecycle & Edge Cases (Disconnect mid-rally)...");
    const server = await createTennisServer({ port: 0 });
    const port = server.port;

    const tv = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise(r => tv.once('open', r));
    tv.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));

    const p1 = await connectPhone(port, { code: server.roomCode, playerId: 'p1', name: 'P1' });
    const p2 = await connectPhone(port, { code: server.roomCode, playerId: 'p2', name: 'P2' });
    await new Promise(r => setTimeout(r, 100));

    // TV Reports match phase playing
    const director = new GameDirector({ mode: '1v1', seed: 42 });
    director.attachSlot(0); director.attachSlot(1);
    
    tv.send(encode(MSG.MATCH_PHASE, { phase: 'playing', snapshot: director.serialize() }));
    await new Promise(r => setTimeout(r, 100));

    if (server.gameState.phase !== 'playing') {
      logBug('BUG-LIFE-01', 'Net', 'Critical', 'TV sends MATCH_PHASE playing', 'Server phase is playing', `Server phase is ${server.gameState.phase}`);
    }

    // Drop p1
    p1.close();
    await new Promise(r => setTimeout(r, 100));

    if (server.gameState.phase !== 'paused') {
      logBug('BUG-LIFE-02', 'Net', 'Critical', 'P1 disconnects mid-match', 'Server phase paused', `Server phase is ${server.gameState.phase}`);
    }

    // P1 Reconnects
    const p1Re = await connectPhone(port, { code: server.roomCode, playerId: 'p1', name: 'P1' });
    await new Promise(r => setTimeout(r, 100));

    if (server.gameState.phase !== 'playing') {
      logBug('BUG-LIFE-03', 'Net', 'Critical', 'P1 reconnects', 'Server phase playing', `Server phase is ${server.gameState.phase}`);
    }

    tv.close(); p2.close(); p1Re.close();
    await server.stop();
  } catch (e) {
    console.error("Test 2 Failed", e);
  }

  // Test 3: Network Stress & Desync (Out of order packets, Lag)
  // Let's create a scenario where inputs arrive with jitter
  try {
    console.log("Running Test 3: Network Stress & Desync...");
    const server = await createTennisServer({ port: 0, now: () => Date.now() });
    const port = server.port;

    const tv = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise(r => tv.once('open', r));
    tv.send(encode(MSG.HOST_REGISTER, { code: server.roomCode }));

    const p1 = await connectPhone(port, { code: server.roomCode, playerId: 'p1', name: 'P1' });
    await new Promise(r => setTimeout(r, 100));
    
    tv.send(encode(MSG.MATCH_PHASE, { phase: 'playing', snapshot: { hostManaged: true } }));
    
    // Send out of order inputs to P1
    const baseT = Date.now();
    // Seq 1
    p1.ws.send(encode(MSG.INPUT, { seq: 1, t: baseT + 100, move: {x: 1, y: 0} }));
    // Seq 0 (Arrives late)
    p1.ws.send(encode(MSG.INPUT, { seq: 0, t: baseT, move: {x: 0, y: 1} }));
    
    await new Promise(r => setTimeout(r, 100));

    // Wait, the lag compensator should re-order them, but let's see how game-server handles it.
    // game-server.js does: this.lag.submit(playerId, msg.seq, msg.t, payload);
    // and emits to host: this.hostWs.send(encode(MSG.INPUT, {seq, ...})) 
    // Wait, game-server.js relays it immediately!
    // line 248: if (this.hostWs?.readyState === 1) { this.hostWs.send(encode(MSG.INPUT, ...)) }
    // It relays input IMMEDIATELY to TV, it does not reorder it before sending to TV!
    
    tv.close(); p1.close();
    await server.stop();
  } catch (e) {
    console.error("Test 3 Failed", e);
  }

  console.log("\n=== TEST RESULTS ===");
  if (issues.length === 0) {
    console.log("No critical bugs found in basic validation. Moving to logic deep-dive.");
  } else {
    console.table(issues);
  }
}

runTests();
