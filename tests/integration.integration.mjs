import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMockServer } from '../scripts/mock-server.mjs';
import { parseArgs, prepareRun, projectRoot, runK6 } from '../scripts/cli.mjs';

const k6Probe = spawnSync('k6', ['version'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
const k6Available = k6Probe.status === 0 && /k6(?:\.exe)? v?\d+\.\d+\.\d+/.test(k6Probe.stdout ?? '');
const integrationOptions = { skip: k6Available ? false : 'Install k6 and run npm run doctor before these local integration tests.', timeout: 45_000 };

async function readJson(filename) {
  return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
}

async function writeJson(filename, value) {
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function resultArtifacts(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await resultArtifacts(directory, next));
    else files.push(next);
  }
  return files;
}

async function runFixture({ failRead = false } = {}) {
  const tempParent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(tempParent, 'perf-k6-integration-'));
  let mock;
  try {
    for (const directory of ['config', 'src', 'payloads', 'data']) {
      await cp(path.join(projectRoot, directory), path.join(root, directory), { recursive: true });
    }
    const environmentPath = path.join(root, 'config/environments/local.json');
    const environment = await readJson(environmentPath);
    environment.auth = { type: 'bearer', tokenEnv: 'INTEGRATION_API_TOKEN' };
    await writeJson(environmentPath, environment);

    const suitePath = path.join(root, 'config/suites/crud.json');
    const suite = await readJson(suitePath);
    suite.thinkTime = 0;
    await writeJson(suitePath, suite);

    const profilePath = path.join(root, 'config/profiles/smoke.json');
    const profile = await readJson(profilePath);
    profile.scenario = { executor: 'shared-iterations', vus: 1, iterations: 5, maxDuration: '10s', gracefulStop: '1s' };
    await writeJson(profilePath, profile);

    if (failRead) {
      const apiPath = path.join(root, 'config/apis/example.json');
      const api = await readJson(apiPath);
      api.endpoints.readItem.expect.json = [{ path: 'id', equals: 'deliberately-incorrect-item-id' }];
      await writeJson(apiPath, api);
    }

    mock = await createMockServer();
    const secret = 'integration-only-' + randomUUID() + '-do-not-persist';
    const observedAuth = [];
    mock.server.on('request', request => { if (request.headers.authorization) observedAuth.push(request.headers.authorization); });
    const options = parseArgs(['run', '--env', 'local', '--api', 'example', '--suite', 'crud', '--profile', 'smoke']);
    const prepared = await prepareRun(options, { root, ambient: { ...process.env, BASE_URL: mock.baseUrl, INTEGRATION_API_TOKEN: secret }, persist: true });
    const exitCode = await runK6(prepared, { root });
    const run = prepared.manifest.run;
    const summary = await readJson(run.files.summary);
    const metadata = await readJson(run.files.metadata);
    assert.equal(metadata.status, failRead ? 'FAIL' : 'PASS', 'Final metadata reports the engine outcome');
    const resultParts = path.relative(root, run.reportDir).split(path.sep);
    assert.equal(resultParts[0], 'results');
    assert.match(resultParts[1], /^\d{4}$/);
    assert.match(resultParts[2], /^\d{2}$/);
    assert.match(resultParts[3], /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(resultParts[4].includes('__' + metadata.status + '__'), 'The folder name displays the final result');
    assert.ok(!resultParts[4].includes('__RUNNING__'), 'Completed results do not remain marked running');
    const persistedManifest = await readJson(run.files.manifest);
    assert.equal(persistedManifest.run.reportDir, run.reportDir, 'Manifest paths follow the finalized directory');
    assert.deepEqual(persistedManifest.run.files, run.files);
    const expectedRequests = failRead ? 20 : 25;
    assert.equal(observedAuth.length, expectedRequests, 'Every journey and cleanup request sends configured authentication');
    assert.ok(observedAuth.every(value => value === 'Bearer ' + secret), 'Authentication reaches the local API in memory');

    const remaining = await fetch(mock.baseUrl + '/items');
    assert.equal(remaining.status, 200);
    assert.deepEqual((await remaining.json()).items, [], 'Cleanup removes synthetic records even after assertions fail');

    const artifactNames = await resultArtifacts(run.reportDir);
    for (const required of ['metadata/manifest.json', 'metadata/run.json', 'metrics/summary.json', 'reports/report.html', 'checks/junit.xml', 'reports/api-performance-report.xlsx']) {
      assert.ok(artifactNames.includes(path.normalize(required)), 'Expected categorized artifact: ' + required);
    }
    const workbook = await readFile(run.files.excel);
    assert.equal(workbook.readUInt32LE(0), 0x04034b50, 'Excel reports must be real ZIP-based XLSX workbooks');
    assert.ok(workbook.includes(Buffer.from('xl/workbook.xml')), 'The Excel package must contain a workbook');
    assert.ok(workbook.includes(Buffer.from('xl/worksheets/sheet1.xml')), 'The Excel package must contain dashboard data');
    for (const artifact of artifactNames) {
      const content = await readFile(path.join(prepared.manifest.run.reportDir, artifact), 'utf8');
      for (const secretForm of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) {
        assert.ok(!content.includes(secretForm), 'Authentication secret must not appear in report artifact: ' + artifact);
      }
      if (path.basename(artifact) !== 'manifest.json') {
        assert.ok(!content.includes('Performance sample'), 'Response and dataset records must not appear in aggregate reports: ' + artifact);
      }
    }
    return { exitCode, summary, metadata };
  } finally {
    if (mock) await mock.close();
    const resolvedRoot = path.resolve(root);
    assert.ok(resolvedRoot.startsWith(tempParent + path.sep), 'Temporary cleanup must remain inside the temporary directory');
    await rm(resolvedRoot, { recursive: true, force: true });
  }
}

test('k6 executes a complete 25-request CRUD journey and keeps authentication out of reports', integrationOptions, async () => {
  const { exitCode, summary } = await runFixture();
  assert.equal(exitCode, 0);
  assert.equal(summary.status, 'passed');
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.metrics.http_reqs.values.count, 25);
  assert.equal(summary.metrics.workflow_failed.values.rate, 0);
  assert.equal(summary.metrics['workflow_requests{endpoint:deleteItem}'].values.count, 5);
  assert.ok(summary.thresholds.every(threshold => threshold.ok));
});

test('k6 exits nonzero on failed response assertions while running deletion cleanup', integrationOptions, async () => {
  const { exitCode, summary } = await runFixture({ failRead: true });
  assert.ok(Number.isInteger(exitCode) && exitCode > 0, 'Failed performance assertions must fail the process');
  assert.equal(summary.status, 'failed');
  assert.equal(summary.metrics.http_reqs.values.count, 20);
  assert.equal(summary.metrics.workflow_failed.values.rate, 1);
  assert.equal(summary.metrics['workflow_requests{endpoint:deleteItem}'].values.count, 5);
  assert.ok(summary.metrics.checks.values.fails > 0);
  assert.ok(summary.thresholds.some(threshold => !threshold.ok));
});
