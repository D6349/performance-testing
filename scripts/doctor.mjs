#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const nodeMajor = Number(process.versions.node.split('.')[0]);
console.log('Node.js: ' + process.versions.node);
if (nodeMajor < 22) { console.error('Node.js 22 or newer is required.'); failed = true; }

await new Promise(resolve => {
  const child = spawn('k6', ['version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.on('error', () => { console.error('k6: not found. Install Grafana k6 and ensure it is on PATH.'); failed = true; resolve(); });
  child.on('close', code => {
    if (code === null) return;
    const version = /k6(?:\.exe)? v?(\d+)\.(\d+)\.(\d+)/.exec(output);
    if (code !== 0 || !version) { console.error('k6 version could not be verified.'); failed = true; }
    else {
      console.log('k6: ' + version[1] + '.' + version[2] + '.' + version[3]);
      if (Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 3)) { console.error('k6 1.3 or newer is required.'); failed = true; }
    }
    resolve();
  });
});

for (const relative of ['config/k6-defaults.json', 'config/environments/local.json', 'config/apis/example.json', 'config/suites/crud.json', 'config/profiles/smoke.json', 'src/k6/runner.js']) {
  try { await readFile(path.join(root, relative)); }
  catch { console.error('Required project file missing: ' + relative); failed = true; }
}
if (!failed) console.log('Installation is ready. Run npm run demo for a local smoke test.');
process.exitCode = failed ? 1 : 0;
