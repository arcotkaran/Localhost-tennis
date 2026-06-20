// Log sinks — consume GameLog entries and put them somewhere useful.
// Node-side: a JSONL file writer and a pretty console printer. (The browser
// lab has its own on-screen sink + an optional POST to /api/debug/log.)

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const COLOR = { warn: '\x1b[33m', error: '\x1b[31m', info: '\x1b[90m', reset: '\x1b[0m' };

// One trace entry → a compact human line. Used by the console printer and the
// BUGREPORT trace slices.
export function prettyEntry(e) {
  const head = `${String(e.seq).padStart(4)} f${String(e.frame ?? 0).padStart(4)} ${e.type}`;
  let detail = '';
  switch (e.type) {
    case 'state': detail = `${e.from} → ${e.to}${e.reason ? ` (${e.reason})` : ''}`; break;
    case 'input': detail = `slot ${e.slot}${e.action ? ` action=${e.action}` : ''}${e.move ? ` move=(${e.move.x},${e.move.y})` : ''}${e.aim != null ? ` aim=${e.aim}` : ''}${e.power != null ? ` pow=${e.power}` : ''}${e.accepted === false ? ` IGNORED:${e.reason}` : ''}`; break;
    case 'serve_strike': detail = `${e.side} #${e.serveNumber} aim=${e.intendedAim} pow=${e.intendedPower} → predict (${e.predictedLanding.x},${e.predictedLanding.z}) inBox=${e.predictedInBox}`; break;
    case 'serve_result': detail = `#${e.serveNumber} landing (${e.landing.x},${e.landing.z}) inBox=${e.inBox}`; break;
    case 'fault': detail = `team ${e.team} #${e.serveNumber} ${e.reason}/${e.detail}`; break;
    case 'shot': detail = `p${e.player} ${e.action} aim=${e.intendedAim} → land (${e.predictedLanding.x},${e.predictedLanding.z})${e.aiError ? ` ai:${e.aiError}` : ''}`; break;
    case 'hit': detail = `p${e.player} ${e.action} rally=${e.rallyLength ?? '-'}`; break;
    case 'bounce': detail = `(${e.pos.x.toFixed(2)},${e.pos.z.toFixed(2)})`; break;
    case 'point': detail = `team ${e.team} ${e.reason} rally=${e.rallyLength}`; break;
    case 'contradiction': detail = `⚠ ${e.what} detail=${e.detail} landing (${e.landing.x},${e.landing.z})`; break;
    default: detail = JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['seq', 'frame', 'type', 'level', 't'].includes(k))));
  }
  return `${head}  ${detail}`;
}

// A sink that prints entries to the console (optionally only warn/error).
export function consoleSink({ minLevel = 'info' } = {}) {
  const rank = { info: 0, warn: 1, error: 2 };
  return e => {
    if (rank[e.level] < rank[minLevel]) return;
    const c = COLOR[e.level] ?? '';
    console.log(`${c}${prettyEntry(e)}${COLOR.reset}`);
  };
}

// A sink that appends each entry to a JSONL file. Returns the sink fn; the file
// is created (with its dir) lazily on first write.
export function jsonlFileSink(path) {
  let ready = null;
  const ensure = () => (ready ??= mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, '')));
  return async e => { await ensure(); await appendFile(path, JSON.stringify(e) + '\n'); };
}

// Write a whole array of entries to a JSONL file in one go (used by the runner
// to dump per-case traces). Each line may be tagged with extra fields.
export async function writeJSONL(path, entries, tag = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, entries.map(e => JSON.stringify({ ...tag, ...e })).join('\n') + '\n');
}
