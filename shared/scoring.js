// Full tennis scoring: 15/30/40, deuce, advantage, games, tiebreaks,
// sets, and best-of-N matches, with server rotation (including tiebreak
// serving order).

const POINT_NAMES = ['0', '15', '30', '40'];

export class MatchScore {
  constructor({ bestOf = 3, gamesPerSet = 6, tiebreakAt = 6, tiebreakTo = 7 } = {}) {
    if (![1, 3, 5].includes(bestOf)) throw new Error('bestOf must be 1, 3 or 5');
    this.bestOf = bestOf;
    this.setsToWin = Math.ceil(bestOf / 2);
    this.gamesPerSet = gamesPerSet;
    this.tiebreakAt = tiebreakAt;
    this.tiebreakTo = tiebreakTo;

    this.points = [0, 0];        // current game points (raw counts)
    this.games = [0, 0];         // current set games
    this.sets = [];              // finished sets: [gamesA, gamesB][]
    this.setsWon = [0, 0];
    this.inTiebreak = false;
    this.tiebreakPoints = [0, 0];
    this.server = 0;             // team serving the current game
    this.tiebreakFirstServer = 0;
    this.completed = false;
    this.winner = null;
    this.log = [];               // event log for tests/replays
  }

  // Award one point to team (0 or 1). Returns events fired by this point.
  pointWon(team) {
    if (this.completed) throw new Error('match is already complete');
    const events = [];
    if (this.inTiebreak) {
      this.tiebreakPoints[team]++;
      const [a, b] = this.tiebreakPoints;
      events.push({ type: 'point', team });
      if (Math.max(a, b) >= this.tiebreakTo && Math.abs(a - b) >= 2) {
        events.push(...this.winGame(team, { tiebreak: true }));
      }
    } else {
      this.points[team]++;
      events.push({ type: 'point', team });
      const [a, b] = this.points;
      const lead = Math.abs(a - b);
      if (Math.max(a, b) >= 4 && lead >= 2) {
        events.push(...this.winGame(team));
      }
    }
    this.log.push({ team, events: events.map(e => e.type) });
    return events;
  }

  winGame(team, { tiebreak = false } = {}) {
    const events = [{ type: 'game', team, tiebreak }];
    this.games[team]++;
    this.points = [0, 0];
    if (tiebreak) {
      this.inTiebreak = false;
      this.tiebreakPoints = [0, 0];
      this.server = 1 - this.tiebreakFirstServer; // receiver of TB's first point serves next set
    } else {
      this.server = 1 - this.server;
    }
    const [a, b] = this.games;
    const setWon =
      tiebreak ||
      (Math.max(a, b) >= this.gamesPerSet && Math.abs(a - b) >= 2);
    if (setWon) {
      events.push(...this.winSet(team));
    } else if (a === this.tiebreakAt && b === this.tiebreakAt) {
      this.inTiebreak = true;
      this.tiebreakFirstServer = this.server;
      events.push({ type: 'tiebreak_start' });
    }
    return events;
  }

  winSet(team) {
    const events = [{ type: 'set', team, games: [...this.games] }];
    this.sets.push([...this.games]);
    this.setsWon[team]++;
    this.games = [0, 0];
    if (this.setsWon[team] >= this.setsToWin) {
      this.completed = true;
      this.winner = team;
      events.push({ type: 'match', team });
    }
    return events;
  }

  // Display string for the current game: "15-30", "Deuce", "Ad A", "7-6"...
  get gameDisplay() {
    if (this.inTiebreak) return `${this.tiebreakPoints[0]}-${this.tiebreakPoints[1]}`;
    const [a, b] = this.points;
    if (a >= 3 && b >= 3) {
      if (a === b) return 'Deuce';
      return a > b ? 'Ad-In' : 'Ad-Out';
    }
    return `${POINT_NAMES[Math.min(a, 3)]}-${POINT_NAMES[Math.min(b, 3)]}`;
  }

  // Whether this point is a "pressure point" (used by crowd dynamics).
  get isPressurePoint() {
    if (this.inTiebreak) {
      const [a, b] = this.tiebreakPoints;
      return Math.max(a, b) >= this.tiebreakTo - 1;
    }
    const [a, b] = this.points;
    return (a >= 3 || b >= 3) && Math.abs(a - b) >= 1;
  }

  snapshot() {
    return structuredClone({
      points: this.points, games: this.games, sets: this.sets,
      setsWon: this.setsWon, inTiebreak: this.inTiebreak,
      tiebreakPoints: this.tiebreakPoints, server: this.server,
      completed: this.completed, winner: this.winner,
    });
  }
}
