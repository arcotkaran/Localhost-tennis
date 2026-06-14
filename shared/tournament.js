// Classic Tournament Mode: bracket-style cup tracking match wins locally
// across a session of players/teams, crowning an ultimate session champion.

export class Tournament {
  // entrants: [{ id, name, ... }] — 2, 4, or 8 players or doubles teams.
  constructor(entrants, { bestOf = 3 } = {}) {
    if (![2, 4, 8].includes(entrants.length)) {
      throw new Error('tournament needs 2, 4, or 8 entrants');
    }
    const ids = new Set(entrants.map(e => e.id));
    if (ids.size !== entrants.length) throw new Error('duplicate entrants');
    this.entrants = [...entrants];
    this.bestOf = bestOf;
    this.rounds = [this.pairUp(this.entrants)];
    this.sessionWins = new Map(entrants.map(e => [e.id, 0]));
    this.champion = null;
  }

  pairUp(list) {
    const matches = [];
    for (let i = 0; i < list.length; i += 2) {
      matches.push({ a: list[i], b: list[i + 1], winner: null, score: null });
    }
    return matches;
  }

  get currentRound() {
    return this.rounds[this.rounds.length - 1];
  }

  get roundName() {
    const n = this.currentRound.length;
    return n === 1 ? 'Final' : n === 2 ? 'Semifinals' : 'Quarterfinals';
  }

  nextMatch() {
    return this.currentRound.find(m => m.winner === null) ?? null;
  }

  // Record a finished match. `winnerId` must be one of the two entrants.
  reportResult(match, winnerId, score = null) {
    if (match.winner) throw new Error('match already decided');
    if (winnerId !== match.a.id && winnerId !== match.b.id) {
      throw new Error(`${winnerId} is not in this match`);
    }
    match.winner = winnerId === match.a.id ? match.a : match.b;
    match.score = score;
    this.sessionWins.set(winnerId, this.sessionWins.get(winnerId) + 1);

    if (this.currentRound.every(m => m.winner)) {
      if (this.currentRound.length === 1) {
        this.champion = this.currentRound[0].winner;
        return { type: 'champion', entrant: this.champion };
      }
      this.rounds.push(this.pairUp(this.currentRound.map(m => m.winner)));
      return { type: 'round_complete', nextRound: this.roundName };
    }
    return { type: 'match_recorded' };
  }

  // Bracket snapshot for the TV menu.
  bracket() {
    return this.rounds.map((round, i) => ({
      round: i,
      matches: round.map(m => ({
        a: m.a.name, b: m.b.name,
        winner: m.winner?.name ?? null,
        score: m.score,
      })),
    }));
  }

  standings() {
    return [...this.sessionWins.entries()]
      .map(([id, wins]) => ({ id, wins }))
      .sort((x, y) => y.wins - x.wins);
  }
}
