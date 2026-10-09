import test from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main, MAX_SUMMARY_BYTES, parseExcelArgs, readSummary, resolveReportPaths } from '../scripts/export-excel.mjs';
import { summarize } from '../src/lib/report.js';

function fixture(id = '2026-10-08T12-00-00-000Z-test') {
  return summarize({ state: { testRunDurationMs: 1000 }, metrics: {
    http_reqs: { type: 'counter', contains: 'default', values: { count: 4, rate: 4 } },
    http_req_duration: { type: 'trend', contains: 'time', values: { avg: 12, 'p(95)': 22 }, thresholds: { 'p(95)<100': { ok: true } } },
  } }, { id, environment: 'local', profile: 'smoke', suite: 'health' });
}

async function withRoot(callback) {
  const parent = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'perf-excel-export-'));
  try {
    await mkdir(path.join(root, 'results'));
    await callback(root);
  } finally {
    assert.ok(path.resolve(root).startsWith(parent + path.sep));
    await rm(root, { recursive: true, force: true });
  }
}

function datedRun(date, time = '18-00-00-000', status = 'PASS', suffix = 'new') {
  const [year, month] = date.split('-');
  return [year, month, date, time + '__local__example__health__smoke__' + status + '__' + suffix].join('/');
}

async function addSummary(root, directory, report = fixture()) {
  const destination = path.join(root, 'results', directory);
  await mkdir(path.join(destination, 'metrics'), { recursive: true });
  await writeFile(path.join(destination, 'metrics', 'summary.json'), typeof report === 'string' ? report : JSON.stringify(report));
  return destination;
}

async function addLegacySummary(root, directory, report = fixture(directory)) {
  const destination = path.join(root, 'reports', directory);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'summary.json'), typeof report === 'string' ? report : JSON.stringify(report));
  return destination;
}

async function addMetadata(root, directory, startedAt, id) {
  await mkdir(path.join(directory, 'metadata'), { recursive: true });
  const localDate = directory.split(path.sep).at(-2);
  await writeFile(path.join(directory, 'metadata', 'run.json'), JSON.stringify({
    schemaVersion: 1, id, environment: 'local', api: 'example', suite: 'health', profile: 'smoke',
    startedAt, completedAt: startedAt, timezone: 'Asia/Kolkata', localDate,
    localTime: path.basename(directory).split('__')[0], status: 'PASS', exitCode: 0,
    artifacts: { summary: path.relative(root, path.join(directory, 'metrics', 'summary.json')).split(path.sep).join('/') },
  }));
}

function relative(root, filename) { return path.relative(root, filename).split(path.sep).join('/'); }

async function invoke(root, argv = []) {
  const stdout = [];
  const stderr = [];
  const code = await main(argv, { root, stdout: value => stdout.push(value), stderr: value => stderr.push(value) });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

test('Excel CLI parses file selectors and rejects malformed or duplicate options', () => {
  assert.deepEqual(parseExcelArgs([]), {});
  assert.deepEqual(parseExcelArgs(['--help']), { help: true });
  assert.deepEqual(parseExcelArgs(['--input', 'results/run/metrics/summary.json', '--output', 'results/run/reports/custom.XLSX']), {
    input: 'results/run/metrics/summary.json', output: 'results/run/reports/custom.XLSX',
  });
  for (const args of [['--token', 'secret'], ['--input'], ['--input', '--output'], ['--input', 'one', '--input', 'two'], ['--help', '--input', 'one']]) {
    assert.throws(() => parseExcelArgs(args));
  }
});

test('Excel export chooses newest dated summary across months, skips empty runs, and reads no secrets files', async () => {
  await withRoot(async root => {
    const earlier = await addSummary(root, datedRun('2026-09-30', '23-59-59-000', 'PASS', 'old'));
    const latest = await addSummary(root, datedRun('2026-10-01', '00-00-00-000', 'FAIL', 'new'));
    await mkdir(path.join(root, 'results', datedRun('2026-10-02', '00-00-00-000', 'RUNNING', 'empty')), { recursive: true });
    await mkdir(path.join(latest, 'metadata'));
    await writeFile(path.join(root, '.env'), 'invalid dotenv that export must not read');
    await writeFile(path.join(latest, 'metadata', 'manifest.json'), 'invalid manifest that export must not read');
    const result = await invoke(root);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(relative(root, path.join(latest, 'reports', 'api-performance-report.xlsx'))));
    const workbook = await readFile(path.join(latest, 'reports', 'api-performance-report.xlsx'));
    assert.equal(workbook.readUInt32LE(0), 0x04034b50);
    assert.ok(workbook.includes(Buffer.from('xl/workbook.xml')));
    await assert.rejects(lstat(path.join(latest, 'metrics', 'api-performance-report.xlsx')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(earlier, 'reports', 'api-performance-report.xlsx')), { code: 'ENOENT' });
  });
});

test('Excel discovery uses UTC metadata time instead of the alphabetical selector names', async () => {
  await withRoot(async root => {
    const earlier = await addSummary(root, datedRun('2026-10-08', '18-00-00-000', 'PASS', 'zulu'));
    const latest = await addSummary(root, datedRun('2026-10-08', '18-00-00-000', 'FAIL', 'alpha'));
    await addMetadata(root, earlier, '2026-10-08T12:29:59.000Z', '2026-10-08T12-29-59-000Z-earlier');
    await addMetadata(root, latest, '2026-10-08T12:30:00.000Z', '2026-10-08T12-30-00-000Z-latest');
    const paths = await resolveReportPaths({}, root);
    assert.equal(paths.input, await realpath(path.join(latest, 'metrics', 'summary.json')));
    assert.equal(paths.output, path.join(latest, 'reports', 'api-performance-report.xlsx'));
  });
});

test('Excel discovery falls back to dated folders and index failures do not echo invalid metadata', async () => {
  await withRoot(async root => {
    await addSummary(root, datedRun('2026-10-08', '23-59-59-000', 'PASS', 'earlier'));
    const latest = await addSummary(root, datedRun('2026-10-09', '00-00-00-000', 'FAIL', 'latest'));
    await mkdir(path.join(latest, 'metadata'));
    await writeFile(path.join(latest, 'metadata', 'run.json'), '{"private-credential-do-not-log":');
    const selected = await resolveReportPaths({}, root);
    assert.equal(selected.input, await realpath(path.join(latest, 'metrics', 'summary.json')));
    const result = await invoke(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Workbook was created, but the result indexes could not be refreshed/);
    assert.equal((await readFile(path.join(latest, 'reports', 'api-performance-report.xlsx'))).readUInt32LE(0), 0x04034b50);
    assert.doesNotMatch(result.stdout + result.stderr, /private-credential/);
  });
});

test('Excel export does not silently fall back when the latest summary JSON is invalid', async () => {
  await withRoot(async root => {
    const earlier = await addSummary(root, datedRun('2026-10-08', '18-00-00-000', 'PASS', 'old'));
    const latest = await addSummary(root, datedRun('2026-10-08', '19-00-00-000', 'FAIL', 'new'), '{"private-credential-do-not-log":');
    const result = await invoke(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid JSON/);
    assert.doesNotMatch(result.stderr + result.stdout, /private-credential/);
    await assert.rejects(lstat(path.join(latest, 'reports', 'api-performance-report.xlsx')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(earlier, 'reports', 'api-performance-report.xlsx')), { code: 'ENOENT' });
    const explicit = await invoke(root, ['--input', relative(root, path.join(earlier, 'metrics', 'summary.json'))]);
    assert.equal(explicit.code, 0, explicit.stderr);
  });
});

test('Excel export supports selected failed runs and custom XLSX names', async () => {
  await withRoot(async root => {
    const report = fixture('2026-10-08T12-00-00-000Z-failed');
    report.status = 'failed';
    report.thresholds[0].ok = false;
    const directory = await addSummary(root, datedRun('2026-10-08', '17-30-00-000', 'FAIL', 'failed'), report);
    const output = path.join(directory, 'reports', 'review.XLSX');
    const result = await invoke(root, ['--input', relative(root, path.join(directory, 'metrics', 'summary.json')), '--output', relative(root, output)]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await readFile(output)).readUInt32LE(0), 0x04034b50);
  });
});

test('Legacy flat reports remain exportable and are ordered against new result runs', async () => {
  await withRoot(async root => {
    const legacy = await addLegacySummary(root, '2026-10-08T12-00-00-000Z-old');
    const modern = await addSummary(root, datedRun('2026-10-09', '00-00-00-000', 'PASS', 'new'));
    const implicit = await resolveReportPaths({}, root);
    assert.equal(implicit.output, path.join(modern, 'reports', 'api-performance-report.xlsx'));
    const explicit = await invoke(root, ['--input', relative(root, path.join(legacy, 'summary.json'))]);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal((await readFile(path.join(legacy, 'api-performance-report.xlsx'))).readUInt32LE(0), 0x04034b50);
  });
});

test('A project with only the legacy reports directory still exports its latest result', async () => {
  await withRoot(async root => {
    await rmdir(path.join(root, 'results'));
    const legacy = await addLegacySummary(root, '2026-10-08T12-00-00-000Z-old');
    const result = await invoke(root);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes(relative(root, path.join(legacy, 'api-performance-report.xlsx'))));
  });
});

test('Excel export rejects path escapes, non-summary input, unsafe Windows names, and non-XLSX output', async () => {
  await withRoot(async root => {
    const directory = await addSummary(root, datedRun('2026-10-08'));
    const input = relative(root, path.join(directory, 'metrics', 'summary.json'));
    const invalid = [
      { input: '../summary.json' },
      { input: relative(root, path.join(directory, 'metadata', 'manifest.json')) },
      { input, output: '../outside.xlsx' },
      { input, output: 'results-neighbor/outside.xlsx' },
      { input, output: relative(root, path.join(directory, 'reports', 'result.csv')) },
      { input, output: relative(root, path.join(directory, 'reports', 'result.xlsx:secret')) },
      { input, output: relative(root, path.join(directory, 'reports', 'NUL.xlsx')) },
      { input, output: relative(root, path.join(directory, 'reports', 'new. ', 'result.xlsx')) },
    ];
    for (const options of invalid) await assert.rejects(resolveReportPaths(options, root));
  });
});

test('Excel export rejects linked directories before writing to their destination', async () => {
  await withRoot(async root => {
    const directory = await addSummary(root, datedRun('2026-10-08'));
    const outside = path.join(root, 'private');
    await mkdir(outside);
    await symlink(outside, path.join(root, 'results', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolveReportPaths({
      input: relative(root, path.join(directory, 'metrics', 'summary.json')), output: 'results/linked/result.xlsx',
    }, root), /Symbolic links/);
    await assert.rejects(lstat(path.join(outside, 'result.xlsx')), { code: 'ENOENT' });
  });
});

test('Excel export rejects hard-linked inputs and workbook outputs', async () => {
  await withRoot(async root => {
    const directory = await addSummary(root, datedRun('2026-10-08'));
    const input = path.join(directory, 'metrics', 'summary.json');
    await link(input, path.join(root, 'private-summary-copy.json'));
    await assert.rejects(resolveReportPaths({ input: relative(root, input) }, root), /Hard links/);
    await assert.rejects(readSummary(input), /without links/);
    await rm(path.join(root, 'private-summary-copy.json'));
    await mkdir(path.join(directory, 'reports'));
    const output = path.join(directory, 'reports', 'shared.xlsx');
    await writeFile(output, 'do not overwrite');
    await link(output, path.join(root, 'private-output-copy.xlsx'));
    await assert.rejects(resolveReportPaths({ input: relative(root, input), output: relative(root, output) }, root), /Hard links/);
    assert.equal(await readFile(path.join(root, 'private-output-copy.xlsx'), 'utf8'), 'do not overwrite');
  });
});

test('Excel input is bounded and unknown schema errors do not echo source data', async () => {
  await withRoot(async root => {
    const directory = await addSummary(root, datedRun('2026-10-08'), JSON.stringify({ schemaVersion: 999, privateValue: 'private-credential-do-not-log' }));
    const result = await invoke(root);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr + result.stdout, /private-credential/);
    const input = path.join(directory, 'metrics', 'summary.json');
    await writeFile(input, Buffer.alloc(MAX_SUMMARY_BYTES + 1, 32));
    await assert.rejects(readSummary(input), /2 MiB/);
  });
});

test('Excel help works without result directories and missing results give a clear error', async () => {
  await withRoot(async root => {
    await rmdir(path.join(root, 'results'));
    const help = await invoke(root, ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /sends no API requests/);
    const empty = await invoke(root);
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /Complete a test run first/);
  });
});
