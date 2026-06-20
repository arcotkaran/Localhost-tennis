// Headless test runner — `npm run testbed`.
// Runs the canonical shared plan (tools/testbed/plan.mjs) with the flight
// recorder ON, prints a live ▶/✓/✗ ticker, writes the full traces of any
// failing case to logs/, and generates BUGREPORT.md (severity + expected vs
// measured + the trace slice that explains each failure).
//
// This is a DIAGNOSTIC, not a CI gate (the assertions live in tests/). It exits
// non-zero only if a HIGH-severity case fails, so it's still CI-friendly.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPlan, AREAS } from './plan.mjs';
import { prettyEntry, writeJSONL } from './sinks.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const LOGS = join(ROOT, 'logs');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const MARK = { HIGH: '🔴', MED: '🟠', LOW: '🟡' };

// The handful of entry types that actually explain a verdict — used for the
// report's trace slice so it stays readable.
const KEY_TYPES = new Set(['state', 'serve_strike', 'serve_result', 'fault', 'double_fault', 'shot', 'point', 'contradiction']);
function traceSlice(log, n = 16) {
  if (!log) return [];
  const key = log.filter(e => KEY_TYPES.has(e.type) || e.level === 'warn');
  return (key.length ? key : log).slice(-n);
}

console.log('=== Local Tennis — testbed sweep (flight recorder on) ===\n');
const t0 = Date.now();

let current = '';
const { results, summary } = runPlan({
  onCase: r => {
    const tag = r.pass ? '\x1b[32m ✓ \x1b[0m' : `\x1b[31m ✗ \x1b[0m${MARK[r.severity] ?? ''}`;
    if (r.area !== current) { current = r.area; console.log(`\n# ${current}`); }
    console.log(`${tag} ${r.id.padEnd(30)} ${r.pass ? r.measured : `expected ${r.expected}; got ${r.measured}`}`);
  },
});

// ---- persist traces for failing cases (full) + a couple of demos (reference) ----
await mkdir(LOGS, { recursive: true });
const traced = [];
for (const r of results) {
  if (!r.log) continue;
  const interesting = !r.pass || ['serve.deuce_in', 'serve.wide', 'serve.long', 'shot.angle_right'].includes(r.id);
  if (!interesting) continue;
  const path = join(LOGS, `trace-${stamp}-${r.id.replace(/[^\w]/g, '_')}.jsonl`);
  await writeJSONL(path, r.log.slice(0, 600), { case: r.id });
  traced.push({ id: r.id, path });
}

// ---- BUGREPORT.md ----
const failed = results.filter(r => !r.pass);
const lines = [];
lines.push('# Local Tennis — Bug Report');
lines.push('');
lines.push(`_Generated ${new Date().toISOString()} by \`npm run testbed\` — the shared plan in \`tools/testbed/plan.mjs\`, run against the real \`GameDirector\` through the phone gesture→input contract, with the flight recorder on._`);
lines.push('');
lines.push(`**${summary.passed}/${summary.total} cases pass.** Failures by severity: 🔴 ${summary.bySeverity.HIGH} · 🟠 ${summary.bySeverity.MED} · 🟡 ${summary.bySeverity.LOW}.`);
lines.push('');

if (!failed.length) {
  lines.push('✅ **No bugs found.** Every shot, serve, movement and full-match flow behaved as expected, and the flight recorder logged no contradictions (e.g. no "bounced in the box but ruled fault").');
} else {
  lines.push('## Findings');
  lines.push('');
  for (const r of failed.sort((a, b) => ({ HIGH: 0, MED: 1, LOW: 2 }[a.severity] - { HIGH: 0, MED: 1, LOW: 2 }[b.severity]))) {
    lines.push(`### ${MARK[r.severity]} [${r.severity}] ${r.area} — ${r.title}`);
    lines.push('');
    lines.push(`- **Case:** \`${r.id}\``);
    lines.push(`- **Expected:** ${r.expected}`);
    lines.push(`- **Measured:** ${r.measured}`);
    if (r.error) { lines.push('- **Error:**'); lines.push('```'); lines.push(r.error.split('\n').slice(0, 6).join('\n')); lines.push('```'); }
    const slice = traceSlice(r.log);
    if (slice.length) {
      lines.push('- **Trace (what the recorder saw):**');
      lines.push('```');
      for (const e of slice) lines.push(prettyEntry(e));
      lines.push('```');
    }
    lines.push('');
  }
}

lines.push('');
lines.push('## Coverage');
lines.push('');
for (const area of AREAS) {
  const inArea = results.filter(r => r.area === area);
  const pass = inArea.filter(r => r.pass).length;
  lines.push(`- **${area}** — ${pass}/${inArea.length}: ` + inArea.map(r => `${r.pass ? '✓' : '✗'} ${r.id.split('.')[1] ?? r.id}`).join(', '));
}
lines.push('');
lines.push('## How to dig deeper');
lines.push('');
lines.push('- **Watch it live:** `npm start`, open `/lab` on the host → click **Run all** to see every case animate on a 2D court, or use **Manual** to fire any single shot/serve/move. Filter the live log by type/level.');
lines.push('- **Full traces:** failing cases are dumped to `logs/trace-*.jsonl` (one structured entry per line). ' + (traced.length ? `This run wrote: ${traced.map(t => '`' + t.path.replace(ROOT + '\\', '').replace(/\\/g, '/') + '`').join(', ')}.` : ''));
lines.push('- **Contradictions** (level `warn`, e.g. a serve that bounced in the box yet faulted) are flagged automatically by the recorder — search the trace for `contradiction`.');
lines.push('');

await writeFile(join(ROOT, 'BUGREPORT.md'), lines.join('\n'));

console.log('\n=== SUMMARY ===');
console.log(`${summary.passed}/${summary.total} pass · 🔴 ${summary.bySeverity.HIGH} 🟠 ${summary.bySeverity.MED} 🟡 ${summary.bySeverity.LOW} failed · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`Report: BUGREPORT.md${traced.length ? ` · ${traced.length} trace file(s) in logs/` : ''}`);

process.exit(summary.bySeverity.HIGH > 0 ? 1 : 0);
