// Player interaction & cinematic sequencer. Produces declarative animation
// timelines the renderer plays back — testable without a GPU.

export const CLIPS = {
  WALK_ON: 'walk_on', WAVE: 'wave', HANDSHAKE: 'handshake',
  RACKET_TAP: 'racket_tap', NET_HANDSHAKE: 'net_handshake',
  TROPHY_LIFT: 'trophy_lift', IDLE: 'idle',
};

// Cinematic entry: players walk onto the court one by one, wave, then meet
// at the net for the pre-match handshake.
export function entrySequence(players) {
  const timeline = [];
  let t = 0;
  for (const p of players) {
    timeline.push({ at: t, duration: 3.0, actor: p.id, clip: CLIPS.WALK_ON, from: 'tunnel', to: `baseline_${p.team}` });
    timeline.push({ at: t + 3.0, duration: 1.5, actor: p.id, clip: CLIPS.WAVE });
    t += 1.2; // staggered entrances
  }
  const meetAt = t + 4.5;
  for (const p of players) {
    timeline.push({ at: meetAt, duration: 2.0, actor: p.id, clip: CLIPS.HANDSHAKE, at_location: 'net' });
  }
  return { name: 'entry', timeline, totalDuration: meetAt + 2.0 };
}

// After a point in doubles: partners tap rackets.
export function postPointInteraction(mode, winningTeamPlayers) {
  if (mode !== '2v2' || winningTeamPlayers.length !== 2) return null;
  return {
    name: 'racket_tap',
    timeline: winningTeamPlayers.map(p => ({
      at: 0.3, duration: 1.0, actor: p.id, clip: CLIPS.RACKET_TAP, with: winningTeamPlayers.find(q => q !== p).id,
    })),
    totalDuration: 1.3,
  };
}

// After the match: all players meet at the net to shake hands, then the
// winner celebrates.
export function postMatchSequence(players, winnerTeam) {
  const timeline = [];
  for (const p of players) {
    timeline.push({ at: 0, duration: 2.5, actor: p.id, clip: CLIPS.NET_HANDSHAKE, at_location: 'net' });
  }
  for (const p of players.filter(p => p.team === winnerTeam)) {
    timeline.push({ at: 2.8, duration: 3.0, actor: p.id, clip: CLIPS.TROPHY_LIFT });
  }
  return { name: 'post_match', timeline, totalDuration: 5.8 };
}

// Sample a timeline at time t — what should each actor be doing right now?
export function sampleTimeline(seq, t) {
  const active = {};
  for (const item of seq.timeline) {
    if (t >= item.at && t < item.at + item.duration) active[item.actor] = item;
  }
  return active;
}
