// Wire protocol shared by server, host renderer and mobile controllers.
// All messages are JSON: { type, ...payload }

export const MSG = {
  // client -> server
  JOIN: 'join',                 // { code, playerId, name }
  INPUT: 'input',               // { seq, t, move:{x,y}, action }
  PING: 'ping',                 // { t }
  HOST_REGISTER: 'host',       // { code } — the TV renderer attaches itself
  MATCH_PHASE: 'match_phase',   // { phase: 'playing'|'lobby', snapshot? } — host → server
  LAUNCH: 'launch',             // phone → server → host: { config:{mode,surface,format,difficulty} }
  SET_NAME: 'set_name',         // phone → server: { name } — change my display name; server re-broadcasts PLAYER_JOINED
  END_MATCH: 'end_match',        // phone → server → host: quit the current match back to the menu

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
  LOBBY_STATE: 'lobby_state',   // host → server → phones: { atMenu } — TV at menu vs in a match
};

export const ACTIONS = ['flat', 'topspin', 'slice', 'lob', 'smash', 'volley'];

// ----- launch-from-phone config -----
// A phone can start a Quick Match from its own "Start Game" panel; these are
// the legal choices the TV will honor. Kept here (next to the wire) so the
// phone, the TV, and the tests agree on exactly one source of truth.
export const LAUNCH_MODES = ['single', '1v1', '2v2'];
export const LAUNCH_SURFACES = ['hard', 'clay', 'grass'];
export const LAUNCH_FORMATS = ['short', 'oneSet', 'bestOf3'];
export const DIFFICULTIES = { easy: 0.5, normal: 0.72, hard: 0.92 };

// Clamp a config that arrived over the wire to known-good values so a stale or
// malformed phone payload can never crash the host start path — anything
// unrecognized falls back to the menu's own defaults.
export function sanitizeLaunchConfig(config = {}) {
  const pick = (val, allowed, fallback) => (allowed.includes(val) ? val : fallback);
  let difficulty = Number(config?.difficulty);
  if (!Number.isFinite(difficulty) || difficulty <= 0 || difficulty > 1) difficulty = DIFFICULTIES.normal;
  return {
    mode: pick(config?.mode, LAUNCH_MODES, 'single'),
    surface: pick(config?.surface, LAUNCH_SURFACES, 'hard'),
    format: pick(config?.format, LAUNCH_FORMATS, 'short'),
    difficulty,
  };
}

export const HAPTIC_PATTERNS = {
  standardHit: [50],                       // short, crisp
  powerSmash: [200],                       // heavy, sustained
  crowdRoar: [40, 80, 40, 80, 40, 80],     // gentle rhythmic pulsing
};

export const MAX_PLAYERS = 4;

// Player display names typed on the phone. Keep them short so they fit the TV
// scoreboard and banners; null means "no name given" (caller substitutes a
// default like "Player 2").
export const MAX_NAME_LEN = 14;
export function cleanName(name) {
  if (typeof name !== 'string') return null;
  const t = name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LEN);
  return t.length ? t : null;
}

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
