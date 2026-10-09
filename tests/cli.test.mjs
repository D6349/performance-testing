import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, parseEnvFile, loadLocalEnv, buildChildEnv, redact, summaryPassed, runK6 } from '../scripts/cli.mjs';
import { createResultRun } from '../src/lib/results.js';
import { createMockServer } from '../scripts/mock-server.mjs';

test('CLI rejects arbitrary k6 overrides and path traversal selectors', () => {
  assert.throws(() => parseArgs(['run', '--insecure-skip-tls-verify']), /Unknown command option/);
  assert.throws(() => parseArgs(['run', '--env', '../prod']), /Configuration names/);
  assert.throws(() => parseArgs(['run', '--profile', 'smoke', '--profile', 'load']), /Duplicate/);
  assert.throws(() => parseArgs(['validate', '--dry-run']), /only with run/);
  assert.deepEqual(parseArgs(['run', '--env', 'stage', '--dry-run']), { command: 'run', environment: 'stage', api: 'example', suite: 'crud', profile: 'smoke', dryRun: true, allowProduction: false });
});

test('dotenv parser is literal, supports comments, and rejects ambiguous syntax', () => {
  const parsed = parseEnvFile("# ignored\nexport TOKEN='literal$" + "{VALUE}' # note\nPATH_VALUE=\"C:\\work\\local\"\nEMPTY=\nVALUE=hello # comment\nHASH=a#b");
  assert.equal(parsed.TOKEN, 'literal$' + '{VALUE}');
  assert.equal(parsed.PATH_VALUE, 'C:\\work\\local');
  assert.equal(parsed.EMPTY, '');
  assert.equal(parsed.VALUE, 'hello');
  assert.equal(parsed.HASH, 'a#b');
  assert.throws(() => parseEnvFile('TOKEN="unterminated'), /quoted/);
  assert.throws(() => parseEnvFile('TOKEN=one\nTOKEN=two'), /Duplicate/);
  assert.throws(() => parseEnvFile('no assignment'), /syntax/);
});

test('local environment files load in order and ambient variables win', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'perf-env-'));
  try {
    await writeFile(path.join(root, '.env'), 'TOKEN=base\nLITERAL=$TOKEN');
    await writeFile(path.join(root, '.env.local.local'), 'TOKEN=local\nONLY_LOCAL=present');
    const env = await loadLocalEnv(root, 'local', { TOKEN: 'ambient' });
    assert.equal(env.TOKEN, 'ambient');
    assert.equal(env.LITERAL, '$TOKEN');
    assert.equal(env.ONLY_LOCAL, 'present');
  } finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('k6 receives only explicit secrets and OS necessities', () => {
  const child = buildChildEnv({ Path: 'tools', SystemRoot: 'windows', HOME: 'home', API_TOKEN: 'secret', UNRELATED_SECRET: 'do-not-send', K6_INSECURE_SKIP_TLS_VERIFY: 'true', K6_OUT: 'cloud', K6_NO_USAGE_REPORT: 'false', HTTPS_PROXY: 'exfiltrate', PERF_MANIFEST: 'untrusted' }, ['API_TOKEN'], '/safe/manifest.json');
  assert.equal(child.API_TOKEN, 'secret');
  assert.equal(child.Path, 'tools');
  assert.equal(child.PERF_MANIFEST, '/safe/manifest.json');
  assert.equal(child.K6_NO_USAGE_REPORT, 'true');
  for (const name of ['K6_INSECURE_SKIP_TLS_VERIFY', 'K6_OUT', 'UNRELATED_SECRET', 'HTTPS_PROXY']) assert.equal(child[name], undefined);
  assert.throws(() => buildChildEnv({}, ['API_TOKEN'], 'manifest'), /missing/);
  assert.throws(() => buildChildEnv({ K6_OUT: 'cloud' }, ['K6_OUT'], 'manifest'), /Reserved/);
});

test('engine output removes referenced secrets, encoded secrets and request URLs', () => {
  assert.equal(redact('token=a b encoded=a%20b url=https://api.example/items?token=x', ['a b']), 'token=[REDACTED] encoded=[REDACTED] url=[REDACTED_URL]');
});

test('synthetic API supports create, read, update and delete with validation', async () => {
  const mock = await createMockServer();
  try {
    const health = await fetch(mock.baseUrl + '/health');
    assert.equal(health.status, 200);
    const created = await fetch(mock.baseUrl + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'sample', quantity: 2, reference: 'synthetic' }) });
    assert.equal(created.status, 201);
    const item = await created.json();
    assert.equal((await fetch(mock.baseUrl + '/items/' + item.id)).status, 200);
    const updated = await fetch(mock.baseUrl + '/items/' + item.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: 3 }) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).quantity, 3);
    assert.equal((await fetch(mock.baseUrl + '/items/' + item.id, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(mock.baseUrl + '/items/' + item.id)).status, 404);
    const invalid = await fetch(mock.baseUrl + '/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'invalid', quantity: '2' }) });
    assert.equal(invalid.status, 400);
  } finally { await mock.close(); }
});

test('successful engine exit requires a complete passing summary for this run', () => {
  const summary = { schemaVersion: 1, run: { id: 'test-run' }, status: 'passed', summaryFormat: 'metrics-map', thresholds: [{ metric: 'checks', expression: 'rate==1', ok: true }], errors: [] };
  assert.equal(summaryPassed(summary, 'test-run'), true);
  for (const mutation of [{ status: 'failed' }, { summaryFormat: 'unsupported' }, { errors: ['Unknown summary format'] }, { thresholds: [] }, { thresholds: [{ ok: false }] }, { thresholds: [null] }, { run: { id: 'another-run' } }]) assert.equal(summaryPassed({ ...summary, ...mutation }, 'test-run'), false);
  assert.equal(summaryPassed(undefined, 'test-run'), false);
});


async function executionFixture(work) {
  const tempParent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempParent, 'perf-run-lifecycle-'));
  try {
    await mkdir(path.join(root, 'src', 'k6'), { recursive: true });
    await writeFile(path.join(root, 'src', 'k6', 'runner.js'), '// Controlled fixture runner\n');
    const run = await createResultRun({ root, run: { id: '2026-10-08T10-40-33-945Z-83e03154', environment: 'local', api: 'example', suite: 'crud', profile: 'smoke' } });
    const manifest = { run };
    await writeFile(run.files.manifest, JSON.stringify(manifest), 'utf8');
    const prepared = { manifest, env: { ...process.env }, names: [], manifestPath: run.files.manifest };
    await work({ root, run, prepared });
  } finally {
    assert.ok(path.resolve(root).startsWith(tempParent + path.sep));
    await rm(root, { recursive: true, force: true });
  }
}

test('engine launch failure finalizes the run as ERROR without leaving a running folder', async () => {
  await executionFixture(async ({ root, run, prepared }) => {
    const exitCode = await runK6(prepared, { root, binary: path.join(root, 'k6-does-not-exist.exe') });
    assert.equal(exitCode, 1);
    const metadata = JSON.parse(await readFile(run.files.metadata, 'utf8'));
    assert.equal(metadata.status, 'ERROR');
    assert.ok(path.basename(run.reportDir).includes('__ERROR__'));
    assert.ok(!path.basename(run.reportDir).includes('__RUNNING__'));
    assert.equal(prepared.manifestPath, run.files.manifest);
  });
});

test('zero engine exit without a summary is reported as ERROR', async () => {
  await executionFixture(async ({ root, run, prepared }) => {
    await writeFile(path.join(root, 'run'), 'process.exit(0);\n', 'utf8');
    const exitCode = await runK6(prepared, { root, binary: process.execPath });
    assert.equal(exitCode, 1);
    assert.equal(JSON.parse(await readFile(run.files.metadata, 'utf8')).status, 'ERROR');
    assert.ok(path.basename(run.reportDir).includes('__ERROR__'));
  });
});

test('failed gates produce an Excel report and FAIL folder even with a zero engine exit', async () => {
  await executionFixture(async ({ root, run, prepared }) => {
    await writeFile(path.join(root, 'run'), 'process.exit(0);\n', 'utf8');
    const summary = {
      schemaVersion: 1,
      run: { id: run.id, environment: 'local', api: 'example', suite: 'crud', profile: 'smoke' },
      status: 'failed', summaryFormat: 'metrics-map', durationMs: 1000, errors: [],
      thresholds: [{ metric: 'checks', expression: 'rate==1', ok: false }],
      metrics: {
        http_reqs: { type: 'counter', contains: 'default', values: { count: 1, rate: 1 } },
        http_req_failed: { type: 'rate', contains: 'default', values: { rate: 0, passes: 0, fails: 1 } },
        checks: { type: 'rate', contains: 'default', values: { rate: 0, passes: 0, fails: 1 } },
        http_req_duration: { type: 'trend', contains: 'time', values: { avg: 10, min: 10, max: 10, med: 10, 'p(90)': 10, 'p(95)': 10, 'p(99)': 10 } },
      },
    };
    await writeFile(run.files.summary, JSON.stringify(summary), 'utf8');
    const exitCode = await runK6(prepared, { root, binary: process.execPath });
    assert.equal(exitCode, 1);
    assert.equal(JSON.parse(await readFile(run.files.metadata, 'utf8')).status, 'FAIL');
    assert.ok(path.basename(run.reportDir).includes('__FAIL__'));
    const workbook = await readFile(run.files.excel);
    assert.equal(workbook.readUInt32LE(0), 0x04034b50);
  });
});
