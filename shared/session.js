// SessionController: the TV's top-level flow.
//   menu → quick match → back to menu
//   menu → tournament → bracket → match → bracket → ... → trophy → menu
//
// Owns match formats, creates a GameDirector per match, reports tournament
// results, and schedules the cinematic sequences (entry walk-on, doubles
// racket taps, post-match handshakes / trophy lift). Pure logic — the
// renderer just draws what this says.

import { GameDirector } from './game-director.js';
import { Tournament } from './tournament.js';
import { entrySequence, postPointInteraction, postMatchSequence } from '../client_host/js/interactions.js';

export const FORMATS = {
  short:    { label: 'Short set (first to 4)', bestOf: 1, gamesPerSet: 4, tiebreakAt: 4 },
  oneSet:   { label: 'One set', bestOf: 1, gamesPerSet: 6, tiebreakAt: 6 },
  bestOf3:  { label: 'Best of 3 sets', bestOf: 3, gamesPerSet: 6, tiebreakAt: 6 },
};

export class SessionController {
  constructor({ seed = 1 } = {}) {
    this.state = 'menu';      // menu | entry | match | bracket | trophy
    this.director = null;
    this.cup = null;
    this.cupConfig = null;
    this.activeMatch = null;  // tournament match being played
    this.sequence = null;     // active cinematic timeline
    this.sequenceT = 0;
    this.seed = seed;
    this.events = [];
  }

  emit(type, data = {}) {
    this.events.push({ type, ...data });
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ----- quick match -----

  startQuickMatch({ mode, surface, format = 'bestOf3', characters = [], difficulty = 0.72 }) {
    if (this.state !== 'menu') throw new Error(`cannot start from ${this.state}`);
    this.mode = 'quick';
    this.createDirector({ mode, surface, format, characters, difficulty });
  }

  // ----- tournament -----

  startTournament({ entrants, surface, format = 'short', difficulty = 0.72 }) {
    if (this.state !== 'menu') throw new Error(`cannot start from ${this.state}`);
    this.mode = 'tournament';
    this.cup = new Tournament(entrants, { bestOf: FORMATS[format].bestOf });
    this.cupConfig = { surface, format, difficulty };
    this.state = 'bracket';
    this.emit('bracket', { round: this.cup.roundName, bracket: this.cup.bracket() });
  }

  // The TV shows the bracket; this begins the next undecided match.
  beginNextTournamentMatch() {
    if (this.state !== 'bracket') throw new Error(`cannot begin a match from ${this.state}`);
    const match = this.cup.nextMatch();
    if (!match) throw new Error('no undecided match — tournament is over');
    this.activeMatch = match;
    this.createDirector({
      mode: '1v1',
      surface: this.cupConfig.surface,
      format: this.cupConfig.format,
      difficulty: this.cupConfig.difficulty,
      characters: [match.a.traits ? match.a : null, match.b.traits ? match.b : null],
      title: `${match.a.name}  vs  ${match.b.name}`,
    });
  }

  // ----- shared match lifecycle -----

  createDirector({ mode, surface, format, characters, difficulty = 0.72, title = null }) {
    const f = FORMATS[format] ?? FORMATS.bestOf3;
    this.director = new GameDirector({
      mode, surface, bestOf: f.bestOf, characters, difficulty, seed: this.seed++,
    });
    this.director.score.gamesPerSet = f.gamesPerSet;
    this.director.score.tiebreakAt = f.tiebreakAt;
    this.matchMode = mode;
    // Cinematic entry: players walk on before play begins.
    const actors = this.director.players.map(p => ({ id: `p${p.index}`, team: p.team }));
    this.sequence = entrySequence(actors);
    this.sequenceT = 0;
    this.state = 'entry';
    this.emit('entry', { sequence: this.sequence, title });
  }

  attachSlot(slot) { return this.director?.attachSlot(slot) ?? null; }
  detachSlot(slot) { this.director?.detachSlot(slot); }
  handleInput(slot, input) {
    if (this.state === 'match') this.director?.handleInput(slot, input);
  }

  update(dt) {
    switch (this.state) {
      case 'entry':
        this.sequenceT += dt;
        if (this.sequenceT >= this.sequence.totalDuration) {
          this.sequence = null;
          this.state = 'match';
          this.emit('match_start');
        }
        break;
      case 'match': {
        this.director.update(dt);
        for (const e of this.director.drainEvents()) {
          this.emit(e.type, e); // pass through for audio/crowd/score
          if (e.type === 'point' && this.matchMode === '2v2') {
            const winners = this.director.players
              .filter(p => p.team === e.team)
              .map(p => ({ id: `p${p.index}`, team: p.team }));
            const tap = postPointInteraction('2v2', winners);
            if (tap) this.emit('interaction', { sequence: tap });
          }
          if (e.type === 'match') this.finishMatch(e.team);
        }
        break;
      }
      case 'trophy':
        this.sequenceT += dt;
        if (this.sequenceT >= this.sequence.totalDuration) {
          this.sequence = null;
          this.cup = null;
          this.state = 'menu';
          this.emit('menu');
        }
        break;
    }
  }

  finishMatch(winningTeam) {
    const actors = this.director.players.map(p => ({ id: `p${p.index}`, team: p.team }));
    if (this.mode === 'tournament') {
      const winner = winningTeam === 0 ? this.activeMatch.a : this.activeMatch.b;
      const score = this.director.score.sets.map(s => s.join('-')).join(' ');
      const result = this.cup.reportResult(this.activeMatch, winner.id, score);
      this.activeMatch = null;
      this.director = null;
      if (result.type === 'champion') {
        this.sequence = postMatchSequence(actors, winningTeam);
        this.sequenceT = 0;
        this.state = 'trophy';
        this.emit('champion', {
          entrant: result.entrant, sequence: this.sequence,
          standings: this.cup.standings(), bracket: this.cup.bracket(),
        });
      } else {
        this.state = 'bracket';
        this.emit('bracket', { round: this.cup.roundName, bracket: this.cup.bracket() });
      }
    } else {
      this.sequence = postMatchSequence(actors, winningTeam);
      this.sequenceT = 0;
      this.director = null;
      this.state = 'trophy'; // same handshake/celebration flow, then menu
      this.emit('quick_match_end', { team: winningTeam, sequence: this.sequence });
    }
  }
}

// ----- cinematic position sampling (renderer helper, pure & testable) -----
//
// Converts an active timeline item into a world position/pose for an actor.
// Walk-ons interpolate from the tunnel to the baseline; net meetings
// converge on the net line.

import { COURT } from './physics.js';

export function actorPose(item, t, actorTeam, homePos) {
  const progress = Math.max(0, Math.min(1, (t - item.at) / item.duration));
  const sign = actorTeam === 0 ? 1 : -1;
  switch (item.clip) {
    case 'walk_on': {
      const from = { x: -COURT.width / 2 - 4, z: sign * (COURT.length / 2 + 4) };
      const to = homePos ?? { x: 0, z: sign * (COURT.length / 2 - 1.5) };
      return {
        x: from.x + (to.x - from.x) * progress,
        z: from.z + (to.z - from.z) * progress,
        pose: 'walk', progress,
      };
    }
    case 'handshake':
    case 'net_handshake': {
      const to = { x: actorTeam === 0 ? 0.7 : -0.7, z: sign * 1.0 };
      const from = homePos ?? { x: 0, z: sign * (COURT.length / 2 - 1.5) };
      const p = Math.min(1, progress * 2); // walk to net in the first half
      return {
        x: from.x + (to.x - from.x) * p,
        z: from.z + (to.z - from.z) * p,
        pose: progress > 0.5 ? 'shake' : 'walk', progress,
      };
    }
    case 'racket_tap': {
      const to = { x: 0, z: sign * (COURT.length / 2 - 3) };
      const from = homePos ?? { x: sign * 2, z: sign * (COURT.length / 2 - 1.5) };
      const out = progress < 0.5 ? progress * 2 : (1 - progress) * 2; // there and back
      return {
        x: from.x + (to.x - from.x) * out,
        z: from.z + (to.z - from.z) * out,
        pose: progress > 0.35 && progress < 0.65 ? 'tap' : 'walk', progress,
      };
    }
    case 'trophy_lift':
      return { x: 0, z: sign * 2.5, pose: 'lift', progress };
    case 'wave':
      return { ...(homePos ?? { x: 0, z: sign * (COURT.length / 2 - 1.5) }), pose: 'wave', progress };
    default:
      return { ...(homePos ?? { x: 0, z: sign * (COURT.length / 2 - 1.5) }), pose: 'idle', progress };
  }
}
