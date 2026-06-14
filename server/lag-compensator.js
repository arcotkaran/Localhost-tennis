// Network lag compensation for phone controllers on local Wi-Fi.
//
// Local Wi-Fi latency is low (1-20ms) but jittery; phones also have
// unsynchronized clocks. We estimate each client's clock offset from
// ping/pong samples (median filter rejects spike outliers), then re-order
// buffered inputs by their *server-time-adjusted* timestamps so a lag
// spike cannot reorder a player's swings.

export class ClockSync {
  constructor(maxSamples = 31) {
    this.samples = [];
    this.maxSamples = maxSamples;
  }

  // clientT: client clock when ping sent; serverT: server clock when received;
  // rtt: measured round trip. Offset estimate assumes symmetric latency.
  addSample(clientT, serverT, rtt) {
    this.samples.push({ offset: serverT - clientT - rtt / 2, rtt });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  // Median offset of the lowest-RTT half of samples — spikes inflate RTT and
  // corrupt the symmetric-latency assumption, so prefer clean samples.
  get offset() {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
    const offs = best.map(s => s.offset).sort((a, b) => a - b);
    return offs[Math.floor(offs.length / 2)];
  }

  toServerTime(clientT) {
    return clientT + this.offset;
  }
}

export class LagCompensator {
  constructor() {
    this.clocks = new Map();   // playerId -> ClockSync
    this.buffer = [];          // { playerId, seq, serverEventT, input }
    this.lastSeq = new Map();  // playerId -> highest seq applied (dup/replay guard)
  }

  clockFor(playerId) {
    if (!this.clocks.has(playerId)) this.clocks.set(playerId, new ClockSync());
    return this.clocks.get(playerId);
  }

  addPingSample(playerId, clientT, serverT, rtt) {
    this.clockFor(playerId).addSample(clientT, serverT, rtt);
  }

  // Buffer an input that may have arrived late/out of order.
  submit(playerId, seq, clientT, input) {
    const last = this.lastSeq.get(playerId) ?? -1;
    if (seq <= last && this.buffer.every(b => !(b.playerId === playerId && b.seq === seq))) {
      // Already consumed or duplicate in flight — drop.
      if (seq <= last) return false;
    }
    if (this.buffer.some(b => b.playerId === playerId && b.seq === seq)) return false;
    const serverEventT = this.clockFor(playerId).toServerTime(clientT);
    this.buffer.push({ playerId, seq, serverEventT, input });
    return true;
  }

  // Drain all inputs whose adjusted event time is at or before `serverNow`,
  // globally ordered by when they actually happened on the players' devices.
  // Per-player seq order is enforced as a tiebreaker/correctness guard.
  drain(serverNow) {
    const ready = this.buffer.filter(b => b.serverEventT <= serverNow);
    this.buffer = this.buffer.filter(b => b.serverEventT > serverNow);
    ready.sort((a, b) =>
      a.serverEventT - b.serverEventT ||
      (a.playerId === b.playerId ? a.seq - b.seq : 0)
    );
    // Enforce per-player monotonic seq: a spike must not let seq 5 apply before 4.
    const out = [];
    const pending = new Map(); // playerId -> sorted queue
    for (const ev of ready) {
      if (!pending.has(ev.playerId)) pending.set(ev.playerId, []);
      pending.get(ev.playerId).push(ev);
    }
    for (const q of pending.values()) q.sort((a, b) => a.seq - b.seq);
    // Merge back preserving global time order but per-player seq order.
    const cursors = new Map([...pending.entries()].map(([p, q]) => [p, 0]));
    const total = ready.length;
    while (out.length < total) {
      let bestPlayer = null;
      let bestT = Infinity;
      for (const [p, q] of pending) {
        const i = cursors.get(p);
        if (i < q.length && q[i].serverEventT < bestT) {
          bestT = q[i].serverEventT;
          bestPlayer = p;
        }
      }
      const q = pending.get(bestPlayer);
      const ev = q[cursors.get(bestPlayer)];
      cursors.set(bestPlayer, cursors.get(bestPlayer) + 1);
      out.push(ev);
      this.lastSeq.set(ev.playerId, Math.max(this.lastSeq.get(ev.playerId) ?? -1, ev.seq));
    }
    return out;
  }
}
