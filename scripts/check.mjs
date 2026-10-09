#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/lib/config.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sources(absolute));
    else if (/\.(mjs|js)$/.test(entry.name)) result.push(absolute);
  }
  return result;
}
let checked = 0;
for (const folder of ['src', 'scripts', 'tests']) {
  for (const source of await sources(path.join(root, folder))) {
    const result = spawnSync(process.execPath, ['--check', source], { shell: false, windowsHide: true, stdio: 'inherit' });
    if (result.status !== 0 || result.error) process.exit(1);
    checked++;
  }
}
for (const profile of ['smoke', 'load', 'stress', 'spike', 'soak', 'capacity']) {
  for (const suite of ['crud', 'health']) await loadManifest({ root, suite, profile, env: {} });
}
for (const environment of ['staging', 'production']) await loadManifest({ root, environment, env: { API_TOKEN: 'validation-placeholder' } });
console.log('Syntax checked ' + checked + ' source files; all bundled suites, profiles, and environments are valid. No API traffic was sent.');
