// Flight recorder for the game loop. A pure, bounded, structured trace of
// everything the GameDirector does — every event, state change, input, and the
// intended-vs-actual outcome of each shot/serve — so a bug ("looks in but says
// fault", "can't change direction") is diagnosable from the record instead of
// guesswork.
//
// Pure: no I/O. The director PUSHES entries; sinks (file, console, on-screen
// panel) SUBSCRIBE and consume them. Off by default in the director, so normal
// play pays nothing.
//
// Each entry: { seq, t, frame, type, level, ...fields }
//   seq   — monotonic, total order regardless of frame timing
//   t     — sim seconds elapsed; frame — sim frame index
//   type  — 'state' | 'input' | 'serve' | 'serve_strike' | 'serve_result' |
//           'hit' | 'shot' | 'bounce' | 'net' | 'fault' | 'point' | 'contradiction' | …
//   level — 'info' | 'warn' (a contradiction/error worth surfacing)

export const LEVELS = ['info', 'warn', 'error'];

export class GameLog {
  constructor({ capacity = 20000 } = {}) {
    this.capacity = capacity;
    this._entries = [];
    this._seq = 0;
    this._sinks = [];
  }

  // Record one entry. Returns the stored entry (with seq filled in).
  push(entry) {
    const e = { seq: this._seq++, level: 'info', ...entry };
    this._entries.push(e);
    if (this._entries.length > this.capacity) {
      // Trim the oldest in a batch so a long live session stays bounded without
      // an O(n) shift on every push.
      this._entries.splice(0, this._entries.length - this.capacity);
    }
    for (const s of this._sinks) { try { s(e); } catch { /* a bad sink must not break the sim */ } }
    return e;
  }

  // Subscribe to live entries (file writer, console printer, on-screen panel).
  // Returns an unsubscribe fn.
  addSink(fn) {
    this._sinks.push(fn);
    return () => { const i = this._sinks.indexOf(fn); if (i >= 0) this._sinks.splice(i, 1); };
  }

  // All entries, or those matching a filter: { type, level, since } where
  // `type` is a string or array, `since` is a seq cutoff (inclusive).
  entries(filter = null) {
    if (!filter) return this._entries.slice();
    const types = filter.type == null ? null : (Array.isArray(filter.type) ? filter.type : [filter.type]);
    return this._entries.filter(e =>
      (!types || types.includes(e.type)) &&
      (!filter.level || e.level === filter.level) &&
      (filter.since == null || e.seq >= filter.since));
  }

  // The latest `n` entries (for a tail view / a failing case's trace slice).
  tail(n = 50) { return this._entries.slice(-n); }

  // Entries in [fromSeq, toSeq] — the slice that explains one test case.
  slice(fromSeq, toSeq = Infinity) {
    return this._entries.filter(e => e.seq >= fromSeq && e.seq <= toSeq);
  }

  // The current high-water seq, so a caller can mark a window: capture `mark()`
  // before an action and `slice(mark)` after to get exactly that action's trace.
  mark() { return this._seq; }

  clear() { this._entries = []; }

  get size() { return this._entries.length; }

  toJSONL() { return this._entries.map(e => JSON.stringify(e)).join('\n'); }
}
