import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, rm, link, symlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createResultRun, finalizeResultRun, rebuildResultIndexes, resultLayout, assertResultPath } from '../src/lib/results.js';
import { migrateLegacyResults } from '../scripts/migrate-results.mjs';

const selection = { environment: 'local', api: 'example', suite: 'crud', profile: 'smoke' };
const makeId = (iso, suffix = '1234abcd') => iso.replace(/[:.]/g, '-') + '-' + suffix;
async function fixture(body) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'perf-results-'));
  try { return await body(root); }
  finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(resolved, { recursive: true, force: true });
  }
}
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
function summary(run, failed = false) {
  return { schemaVersion: 1, run: { id: run.id, environment: run.environment, suite: run.suite, profile: run.profile },
    status: failed ? 'failed' : 'passed', summaryFormat: 'metrics-map', durationMs: 1000, errors: [],
    metrics: { http_reqs: { type: 'counter', contains: 'default', values: { count: 10, rate: 10 } },
      http_req_duration: { type: 'trend', contains: 'time', values: { avg: 8, min: 2, max: 15, med: 7, 'p(95)': 12 } },
      http_req_failed: { type: 'rate', contains: 'default', values: { rate: 0, passes: 0, fails: 10 } } },
    thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<100', ok: !failed, source: 'k6' }] };
}
async function artifacts(run) {
  await writeFile(run.files.manifest, JSON.stringify({ run, privateData: 'private-payload-sentinel' }));
  await writeFile(run.files.summary, JSON.stringify(summary(run)));
  await writeFile(run.files.html, '<!doctype html><title>Test report</title>');
  await writeFile(run.files.junit, '<testsuites tests="1" failures="0"/>');
  await writeFile(run.files.excel, Buffer.from([0x50, 0x4b, 3, 4]));
}

test('IST date folders roll over at midnight, month, and year boundaries', () => {
  const root = path.resolve(os.tmpdir(), 'date-preview');
  const cases = [
    ['2026-10-08T18:29:59.999Z', '2026/10/2026-10-08', '23-59-59-999'],
    ['2026-10-08T18:30:00.000Z', '2026/10/2026-10-09', '00-00-00-000'],
    ['2026-12-31T18:30:00.000Z', '2027/01/2027-01-01', '00-00-00-000'],
  ];
  for (const [time, datePath, clock] of cases) {
    const run = resultLayout(root, { ...selection, id: makeId(time) });
    assert.ok(run.reportDir.includes(datePath.split('/').join(path.sep)));
    assert.equal(run.localTime, clock);
    assert.equal(run.startedAt, time);
  }
});

test('long configuration names stay complete in metadata and compact in folder names', async () => fixture(async root => {
  const name = 'a'.repeat(64);
  const run = await createResultRun({ root, run: { ...selection, suite: name, id: makeId('2026-10-08T10:00:00.000Z') } });
  assert.ok(path.basename(run.reportDir).includes('a'.repeat(12) + '-cut'));
  assert.equal((await json(run.files.metadata)).suite, name);
  await assert.rejects(createResultRun({ root, run: { ...selection, id: '../invalid' } }), /identifier/);
}));

test('finalizing a run moves all categories together and updates manifest paths', async () => fixture(async root => {
  const run = await createResultRun({ root, run: { ...selection, id: makeId('2026-10-08T10:00:00.000Z') } });
  const originalDirectory = run.reportDir;
  await artifacts(run);
  const oldExcel = await readFile(run.files.excel);
  await finalizeResultRun(run, { root, status: 'PASS', exitCode: 0, summary: summary(run), completedAt: '2026-10-08T10:01:00.000Z' });
  assert.match(path.basename(run.reportDir), /__PASS__/);
  await assert.rejects(lstat(originalDirectory), { code: 'ENOENT' });
  assert.deepEqual(await readFile(run.files.excel), oldExcel);
  const manifest = await json(run.files.manifest);
  assert.equal(manifest.run.files.summary, run.files.summary);
  assert.equal(manifest.privateData, 'private-payload-sentinel');
  const metadata = await json(run.files.metadata);
  assert.equal(metadata.status, 'PASS');
  assert.equal(metadata.performance.requests, 10);
  assert.equal(metadata.artifacts.manifest, undefined);
  const index = await readFile(path.join(root, 'results', 'index.html'), 'utf8');
  assert.match(index, /Excel report/);
  assert.doesNotMatch(index, /private-payload-sentinel|manifest\.json/);
  const hrefs = [...index.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  for (const href of hrefs) assert.ok((await lstat(path.resolve(root, 'results', href))).isFile());
}));

test('latest pointers use completion time and preserve latest success after a failed run', async () => fixture(async root => {
  const earlier = await createResultRun({ root, run: { ...selection, id: makeId('2026-10-08T10:00:00.000Z', '11111111') } });
  const later = await createResultRun({ root, run: { ...selection, id: makeId('2026-10-08T10:02:00.000Z', '22222222') } });
  await finalizeResultRun(later, { root, status: 'PASS', completedAt: '2026-10-08T10:03:00.000Z' });
  await finalizeResultRun(earlier, { root, status: 'PASS', completedAt: '2026-10-08T10:05:00.000Z' });
  const latestFile = path.join(root, 'results', 'latest.json');
  const successFile = path.join(root, 'results', 'latest-success.json');
  assert.equal((await json(latestFile)).id, earlier.id);
  const failed = await createResultRun({ root, run: { ...selection, id: makeId('2026-10-08T10:04:00.000Z', '33333333') } });
  await finalizeResultRun(failed, { root, status: 'FAIL', completedAt: '2026-10-08T10:06:00.000Z', summary: summary(failed, true) });
  await createResultRun({ root, run: { ...selection, id: makeId('2026-10-08T10:07:00.000Z', '44444444') } });
  assert.equal((await json(latestFile)).id, failed.id);
  assert.equal((await json(successFile)).id, earlier.id);
}));

test('concurrent run creation and completion cannot leave stale directory references', async () => fixture(async root => {
  const created = await Promise.allSettled(['11111111', '22222222', '33333333', '44444444'].map(suffix =>
    createResultRun({ root, run: { ...selection, id: makeId('2026-10-08T10:00:00.000Z', suffix) } })));
  for(const result of created) if(result.status==='rejected') throw result.reason;
  const runs=created.map(result=>result.value);
  const finished=await Promise.allSettled(runs.map((run, index) => finalizeResultRun(run, { root, status: ['PASS', 'FAIL', 'ERROR', 'INTERRUPTED'][index], completedAt: '2026-10-08T10:01:00.000Z' })));
  for(const result of finished) if(result.status==='rejected') throw result.reason;
  const rows = await rebuildResultIndexes(root);
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.status !== 'RUNNING'));
  for (const run of runs) assert.equal((await json(run.files.metadata)).status, run.status);
  await assert.rejects(lstat(path.join(root, 'results', '.index.lock')), { code: 'ENOENT' });
}));

test('invalid private provenance fails before the final folder rename and retains a usable index', async () => fixture(async root => {
  const run = await createResultRun({ root, run: { ...selection, id: makeId('2026-10-08T10:00:00.000Z') } });
  const originalDirectory = run.reportDir;
  await writeFile(run.files.manifest, '{invalid-private-secret');
  await assert.rejects(finalizeResultRun(run, { root, status: 'PASS' }), /could not be validated/);
  assert.equal(run.reportDir, originalDirectory);
  assert.equal((await json(run.files.metadata)).status, 'RUNNING');
  assert.equal((await rebuildResultIndexes(root)).length, 1);
}));

test('empty date pages clear old rows when a run is deliberately removed', async () => fixture(async root => {
  const run = await createResultRun({ root, run: { ...selection, id: makeId('2026-10-08T10:00:00.000Z') } });
  const dateIndex = path.join(path.dirname(run.reportDir), 'index.html');
  const target = path.resolve(run.reportDir);
  assert.ok(target.startsWith(path.resolve(root, 'results') + path.sep));
  await rm(target, { recursive: true });
  await rebuildResultIndexes(root);
  assert.match(await readFile(dateIndex, 'utf8'), /Total runs<strong>0<\/strong>/);
  assert.equal(await json(path.join(root, 'results', 'latest.json')), null);
}));

test('result paths reject traversal, directory junctions and file hard links', async () => fixture(async root => {
  await assert.rejects(assertResultPath(root, path.resolve(root, '..', 'escape')), /inside the project/);
  await mkdir(path.join(root, 'outside'));
  await mkdir(path.join(root, 'results'));
  await symlink(path.join(root, 'outside'), path.join(root, 'results', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertResultPath(root, path.join(root, 'results', 'linked', 'report.json')), /Linked/);
  await writeFile(path.join(root, 'outside', 'secret.json'), 'synthetic-secret');
  await link(path.join(root, 'outside', 'secret.json'), path.join(root, 'results', 'aliased.json'));
  await assert.rejects(assertResultPath(root, path.join(root, 'results', 'aliased.json')), /Linked/);
}));

test('a live writer is not evicted merely because its lock is old', async () => fixture(async root => {
  await mkdir(path.join(root, 'results'));
  const lock = path.join(root, 'results', '.index.lock');
  const owner = JSON.stringify({ pid: process.pid, token: 'live-test-owner' });
  await writeFile(lock, owner);
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  let preserved = false;
  const release = new Promise((resolve, reject) => setTimeout(async () => {
    try { preserved = await readFile(lock, 'utf8') === owner; await rm(lock); resolve(); } catch (error) { reject(error); }
  }, 250));
  await rebuildResultIndexes(root);
  await release;
  assert.equal(preserved, true);
}));

test('legacy migration is verified, preserves original bytes, creates Excel and is idempotent', async () => fixture(async root => {
  const id = makeId('2026-10-08T10:00:00.000Z');
  const source = path.join(root, 'reports', id);
  await mkdir(source, { recursive: true });
  const original = { run: { ...selection, id, reportDir: source }, privateData: 'private-payload-sentinel' };
  const files = { 'manifest.json': JSON.stringify(original), 'summary.json': JSON.stringify(summary(original.run)),
    'report.html': '<title>Legacy report</title>', 'junit.xml': '<testsuites/>', 'extra.txt': 'preserve-extra' };
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(source, name), content);
  const dryRun = await migrateLegacyResults(root, { dryRun: true });
  assert.equal(dryRun.length, 1);
  assert.equal(dryRun[0].status, 'PASS');
  await assert.rejects(lstat(path.join(root, 'results')), { code: 'ENOENT' });
  const migrated = await migrateLegacyResults(root);
  assert.equal(migrated.length, 1);
  await assert.rejects(lstat(source), { code: 'ENOENT' });
  for (const [name, content] of Object.entries(files)) assert.equal(await readFile(path.join(migrated[0].backup, name), 'utf8'), content);
  const runDir = migrated[0].destination;
  assert.equal((await json(path.join(runDir, 'metadata', 'migration.json'))).originalsVerified, true);
  assert.equal(await readFile(path.join(runDir, 'metadata', 'legacy-artifacts', 'extra.txt'), 'utf8'), 'preserve-extra');
  assert.equal((await readFile(path.join(runDir, 'reports', 'api-performance-report.xlsx'))).readUInt32LE(0), 0x04034b50);
  assert.equal((await json(path.join(runDir, 'metadata', 'manifest.json'))).run.reportDir, runDir);
  assert.deepEqual(await migrateLegacyResults(root), []);
}));

test('migration refuses an existing destination and leaves original folders intact', async () => fixture(async root => {
  const id = makeId('2026-10-08T10:00:00.000Z');
  const source = path.join(root, 'reports', id);
  await mkdir(source, { recursive: true });
  const run = { ...selection, id };
  await writeFile(path.join(source, 'manifest.json'), JSON.stringify({ run }));
  await writeFile(path.join(source, 'summary.json'), JSON.stringify(summary(run)));
  await mkdir(resultLayout(root, run, 'PASS').reportDir, { recursive: true });
  await assert.rejects(migrateLegacyResults(root), /already exists/);
  assert.equal((await json(path.join(source, 'summary.json'))).run.id, id);
}));

test('migration classifies unverifiable summary data as ERROR rather than a failed gate', async () => fixture(async root => {
  const id = makeId('2026-10-08T10:00:00.000Z');
  const source = path.join(root, 'reports', id);
  await mkdir(source, { recursive: true });
  const run = { ...selection, id };
  const data = { ...summary(run, true), errors: ['No HTTP requests were completed.'] };
  await writeFile(path.join(source, 'manifest.json'), JSON.stringify({ run }));
  await writeFile(path.join(source, 'summary.json'), JSON.stringify(data));
  assert.equal((await migrateLegacyResults(root, { dryRun: true }))[0].status, 'ERROR');
}));
