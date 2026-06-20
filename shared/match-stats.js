// Broadcast-style match statistics. Pure & node-testable: feed it the same
// events the GameDirector emits (serve / fault / double_fault / point) and it
// accumulates per-team stats the TV shows as an end-of-match summary card —
// aces, winners, unforced errors, double faults, fastest serve, longest rally.
//
// Classification from the point's `reason` (the director already provides it):
//   double_bounce → the winner hit a WINNER the opponent couldn't return
//                   (and if it was the server, rally length 0 → an ACE)
//   out / net      → the LOSER put it out or into the net → an UNFORCED ERROR
//   double_fault   → counted from the double_fault event (server's error)

// Is a finished point worth a slow-mo replay? Match/break-point pressure, a long
// rally, a smash winner, or an ace. Pure so the renderer's replay trigger is
// test-covered. `e` is a director 'point' event.
export function isHighlightPoint(e) {
  if (!e) return false;
  const rally = e.rallyLength ?? 0;
  return !!e.isPressurePoint
    || rally >= 8
    || e.winningShot === 'smash'
    || (e.reason === 'double_bounce' && rally === 0); // ace
}

export class MatchStats {
  constructor() {
    this.serverTeam = null;       // team that struck the most recent serve
    this.longestRally = 0;
    this.totalPoints = 0;
    this.team = [this._blank(), this._blank()];
  }

  _blank() {
    return { pointsWon: 0, aces: 0, winners: 0, unforcedErrors: 0, doubleFaults: 0, faults: 0, serves: 0, fastestServe: 0 };
  }

  consume(e) {
    if (!e) return;
    switch (e.type) {
      case 'serve': {
        const t = this.team[e.team]; if (!t) break;
        this.serverTeam = e.team;
        t.serves++;
        if ((e.speed ?? 0) > t.fastestServe) t.fastestServe = e.speed;
        break;
      }
      case 'fault':        if (this.team[e.team]) this.team[e.team].faults++; break;
      case 'double_fault': if (this.team[e.team]) this.team[e.team].doubleFaults++; break;
      case 'point':        this._point(e); break;
    }
  }

  consumeAll(events = []) { for (const e of events) this.consume(e); return this; }

  _point(e) {
    const w = e.team, l = 1 - w;
    if (!this.team[w]) return;
    this.team[w].pointsWon++;
    this.totalPoints++;
    const rally = e.rallyLength ?? 0;
    if (rally > this.longestRally) this.longestRally = rally;
    switch (e.reason) {
      case 'double_bounce':
        if (rally === 0 && w === this.serverTeam) this.team[w].aces++;   // serve untouched → ace
        else this.team[w].winners++;                                     // clean winner
        break;
      case 'out':
      case 'net':
        this.team[l].unforcedErrors++;                                   // loser's error
        break;
      // double_fault is tallied from its own event
    }
  }

  // A flat, display-ready summary. Speeds are reported in km/h.
  summary() {
    const kmh = mps => Math.round(mps * 3.6);
    return {
      longestRally: this.longestRally,
      totalPoints: this.totalPoints,
      teams: [0, 1].map(t => {
        const s = this.team[t];
        return {
          pointsWon: s.pointsWon, aces: s.aces, winners: s.winners,
          unforcedErrors: s.unforcedErrors, doubleFaults: s.doubleFaults,
          serves: s.serves, fastestServeKmh: kmh(s.fastestServe),
        };
      }),
    };
  }
}
