// Wire protocol shared by server, host renderer and mobile controllers.
// All messages are JSON: { type, ...payload }

export const MSG = {
  // client -> server
  JOIN: 'join',                 // { code, playerId, name }
  INPUT: 'input',               // { seq, t, move:{x,y}, action }
  PING: 'ping',                 // { t }
  HOST_REGISTER: 'host',       // { code } — the TV renderer attaches itself
  MATCH_PHASE: 'match_phase',   // { phase: 'playing'|'lobby', snapshot? } — host → server

  // server -> client
  JOINED: 'joined',             // { slot, roomCode, resumed, snapshot? }
  JOIN_ERROR: 'join_error',     // { reason }
  PONG: 'pong',                 // { t, serverT }
  PLAYER_JOINED: 'player_joined',
  PLAYER_LEFT: 'player_left',
  GAME_PAUSED: 'game_paused',   // { reason, snapshot }
  GAME_RESUMED: 'game_resumed', // { snapshot }
  STATE: 'state',               // authoritative state broadcast
  HAPTIC: 'haptic',             // { pattern } — vibration cue for the phone
  SERVE_CUE: 'serve_cue',       // { on } — TV → serving phone: "your serve"
  PAUSE_REQUEST: 'pause_req',   // phone → server → host: toggle user pause
  PAUSE_STATE: 'pause_state',   // host → server → all phones: { paused }
};

export const ACTIONS = ['flat', 'topspin', 'slice', 'lob', 'smash', 'volley'];

export const HAPTIC_PATTERNS = {
  standardHit: [50],                       // short, crisp
  powerSmash: [200],                       // heavy, sustained
  crowdRoar: [40, 80, 40, 80, 40, 80],     // gentle rhythmic pulsing
};

export const MAX_PLAYERS = 4;

export function encode(type, payload = {}) {
  return JSON.stringify({ type, ...payload });
}

export function decode(raw) {
  try {
    const msg = JSON.parse(raw);
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}
