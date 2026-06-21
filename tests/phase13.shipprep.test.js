// Testing Gate 13: ship prep.
// The game must run on a local Wi-Fi island with NO internet: every asset
// served locally (three.js + QR lib vendored), the TV exposes a scannable
// LAN join URL, and the vendored QR encoder actually works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createTennisServer } from '../server/game-server.js';
import { rankLanAddresses } from '../server/lan.js';
import { networkInterfaces } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));

// Load the QR generator exactly as the browser does: a classic script that
// leaves a `qrcode` global (no module/exports/define in scope → UMD falls
// through to the global). This proves the <script src> path works.
function loadQrcodeAsBrowser() {
  const src = readFileSync(new URL('../vendor/qrcode.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.qrcode;
}

// ---------- LAN join URL ----------

test('/api/info exposes a scannable LAN url when the host knows its IP', async () => {
  const s = await createTennisServer({ port: 0, lanHost: '192.168.0.83' });
  try {
    const info = await fetch(`http://127.0.0.1:${s.port}/api/info`).then(r => r.json());
    assert.equal(info.lanUrl, `http://192.168.0.83:${s.port}/`, 'phones get a full LAN url to scan');
    assert.match(info.roomCode, /^\d{4}$/);
  } finally {
    await s.stop();
  }
});

test('/api/info auto-detects the LIVE LAN IP when none is pinned (so the QR never goes stale)', async () => {
  // Regression: a long-running host must follow DHCP changes. With no pinned
  // lanHost the server re-detects the current LAN IP per request, so the QR
  // always points at a reachable address (null only when there is no adapter).
  const s = await createTennisServer({ port: 0 });
  try {
    const info = await fetch(`http://127.0.0.1:${s.port}/api/info`).then(r => r.json());
    const ip = rankLanAddresses(networkInterfaces())[0]?.address;
    assert.equal(info.lanUrl, ip ? `http://${ip}:${s.port}/` : null,
      'with no pin, lanUrl tracks the live-detected LAN IP');
  } finally {
    await s.stop();
  }
});

// ---------- vendored assets served locally ----------

test('three.js and the QR lib are served locally as JavaScript', async () => {
  const s = await createTennisServer({ port: 0, staticRoot: root });
  try {
    for (const path of ['/vendor/three.module.js', '/vendor/qrcode.js']) {
      const res = await fetch(`http://127.0.0.1:${s.port}${path}`);
      assert.equal(res.status, 200, `${path} is served`);
      assert.match(res.headers.get('content-type'), /javascript/, `${path} has a JS content-type`);
      const body = await res.text();
      assert.ok(body.length > 1000, `${path} has real content`);
    }
    const three = await fetch(`http://127.0.0.1:${s.port}/vendor/three.module.js`).then(r => r.text());
    assert.match(three, /REVISION/, 'three.js bundle is intact');
  } finally {
    await s.stop();
  }
});

// ---------- the no-internet guarantee ----------

test('neither entry page depends on any external (CDN/internet) resource', async () => {
  for (const page of ['client_host/index.html', 'client_mobile/index.html']) {
    const html = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    const externals = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(externals, [], `${page} must not reference external URLs (found: ${externals})`);
    // Importmap and module imports must be local too.
    const importmap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1];
    if (importmap) {
      assert.ok(!/https?:\/\//.test(importmap), `${page} importmap must be local`);
    }
  }
});

test('the TV uses the local three.js and loads the local QR generator', async () => {
  const html = await readFile(new URL('../client_host/index.html', import.meta.url), 'utf8');
  assert.match(html, /"three"\s*:\s*"\.\.\/vendor\/three\.module\.js"/, 'three mapped to the vendored copy');
  assert.match(html, /<script src="\.\.\/vendor\/qrcode\.js">/, 'QR generator loaded from vendor');
  assert.match(html, /qr-box/, 'a QR display element exists');
  assert.match(html, /renderJoinQR/, 'the QR is rendered from the LAN url');
});

// ---------- the vendored QR encoder actually works ----------

test('vendored QR encoder produces a valid matrix for a join URL', () => {
  const qrcode = loadQrcodeAsBrowser();
  assert.equal(typeof qrcode, 'function', 'classic-script load exposes the qrcode global');
  const qr = qrcode(0, 'M');
  qr.addData('http://192.168.0.83:8080/');
  qr.make();
  const n = qr.getModuleCount();
  assert.ok(n >= 21, `QR matrix is at least version 1 (21x21), got ${n}`);
  // Finder pattern: the top-left 7x7 must have its corner module dark.
  assert.equal(qr.isDark(0, 0), true, 'finder pattern present');
  const svg = qr.createSvgTag({ cellSize: 4, margin: 0 });
  assert.match(svg, /<svg/, 'can render an SVG for the TV');
});
