import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExcelWorkbook, writeExcelReport } from '../src/lib/excel-report.js';

function sample() {
  return { schemaVersion: 1, run: { id: '2026-10-08T10-40-33-945Z-test', environment: 'local', profile: 'smoke', suite: 'crud' }, status: 'passed', summaryFormat: 'metrics-map', durationMs: 2000, metrics: {
    http_reqs: { type: 'counter', values: { count: 25, rate: 12.5 } },
    http_req_failed: { type: 'rate', values: { rate: 0, passes: 0, fails: 25 } },
    http_req_duration: { type: 'trend', values: { avg: 12, 'p(95)': 20, 'p(99)': 25 } },
    checks: { type: 'rate', values: { rate: 1, passes: 75, fails: 0 } },
    workflow_failed: { type: 'rate', values: { rate: 0, passes: 0, fails: 5 } },
    iterations: { type: 'counter', values: { count: 5 } },
    vus: { type: 'gauge', values: { max: 1 } },
    'workflow_requests{endpoint:health}': { type: 'counter', values: { count: 5, rate: 2.5 } },
    'http_req_duration{endpoint:health}': { type: 'trend', values: { avg: 10, med: 9, min: 5, max: 20, 'p(90)': 17, 'p(95)': 19, 'p(99)': 20 } },
    'http_req_failed{endpoint:health}': { type: 'rate', values: { rate: 0, passes: 0, fails: 5 } },
  }, thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500', ok: true, source: 'k6' }, { metric: 'http_req_failed', expression: 'rate<0.01', ok: true, source: 'k6' }, { metric: 'http_req_duration{endpoint:health}', expression: 'p(95)<500', ok: true, source: 'k6' }], errors: [] };
}
export function storedEntries(bytes) {
  const entries = {};
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'Expected independently readable stored ZIP entries');
    const length = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    entries[name] = bytes.subarray(start, start + length).toString('utf8');
    offset = start + length;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'ZIP central directory must follow entries');
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50, 'ZIP must have end of central directory');
  return entries;
}
function cell(document, reference) { return document.match(new RegExp('<c r="' + reference + '"[^>]*>([\\s\\S]*?)</c>'))?.[1] ?? ''; }

test('Excel workbook is a real XLSX with six styled sheets, two native charts and local relationships', () => {
  const entries = storedEntries(createExcelWorkbook(sample()));
  const workbook = entries['xl/workbook.xml'];
  for (const name of ['Overview','Endpoints','Thresholds','Checks','Metrics','Guide']) assert.ok(workbook.includes('name="' + name + '"'));
  assert.equal((workbook.match(/<sheet /g) ?? []).length, 6);
  assert.ok(entries['xl/charts/chart1.xml'].includes("'Endpoints'!$H$6:$H$6"));
  assert.ok(entries['xl/charts/chart2.xml'].includes("'Endpoints'!$C$6:$C$6"));
  assert.match(entries['xl/worksheets/sheet2.xml'], /<autoFilter ref="A5:P6"/);
  assert.match(entries['xl/worksheets/sheet2.xml'], /state="frozen"/);
  assert.match(entries['xl/worksheets/sheet2.xml'], /showGridLines="0"/);
  assert.match(entries['xl/worksheets/sheet2.xml'], /type="dataBar"/);
  assert.match(entries['xl/styles.xml'], /formatCode="0.00%"/);
  for (const [name, body] of Object.entries(entries)) if (name.endsWith('.rels')) assert.doesNotMatch(body, /TargetMode="External"/);
  assert.ok(!Object.keys(entries).some(name => /vba|externalLink/i.test(name)));
});
test('Excel dashboard retains numeric requests, percentage ratios and correct HTTP failure counts', () => {
  const entries = storedEntries(createExcelWorkbook(sample()));
  const overview = entries['xl/worksheets/sheet1.xml'];
  assert.equal(cell(overview,'D6'), '<v>25</v>');
  assert.equal(cell(overview,'J6'), '<v>0</v>');
  assert.equal(cell(overview,'G10'), '<v>1</v>');
  assert.match(cell(overview,'D20'), /<v>0<\/v>/);
  assert.match(cell(overview,'J20'), /<v>25<\/v>/);
  assert.match(cell(entries['xl/worksheets/sheet4.xml'],'B6'), /<v>75<\/v>/);
  assert.match(cell(entries['xl/worksheets/sheet4.xml'],'C6'), /<v>0<\/v>/);
});
test('Excel missing data stays explicit and failed runs produce a readable failed dashboard', () => {
  const report = sample();
  report.status = 'failed';
  delete report.metrics.http_req_failed;
  report.metrics['workflow_requests{endpoint:health}'].values = { count: 0, rate: 0 };
  const entries = storedEntries(createExcelWorkbook(report));
  assert.match(cell(entries['xl/worksheets/sheet1.xml'],'A6'), /FAILED/);
  assert.match(cell(entries['xl/worksheets/sheet1.xml'],'J6'), /Not collected/);
  assert.match(cell(entries['xl/worksheets/sheet2.xml'],'B6'), /NO DATA/);
  assert.match(cell(entries['xl/worksheets/sheet2.xml'],'H6'), /Not collected/);
  assert.doesNotMatch(cell(entries['xl/worksheets/sheet2.xml'],'H6'), /<v>0<\/v>/);
});
test('Excel treats formula-like text as inert strings and omits unexpected secret-bearing data', () => {
  const report = sample();
  report.run.id = '=HYPERLINK("https://example.invalid","click")<&';
  report.run.privateToken = 'unexpected-secret-sentinel';
  report.privatePayload = { password: 'unexpected-secret-sentinel' };
  report.metrics.privateUrl = { type: 'gauge', values: { value: 'unexpected-secret-sentinel' } };
  const entries = storedEntries(createExcelWorkbook(report));
  assert.match(cell(entries['xl/worksheets/sheet1.xml'],'D21'), /=HYPERLINK/);
  assert.match(cell(entries['xl/worksheets/sheet1.xml'],'D21'), /&quot;|&lt;/);
  for (const [name, body] of Object.entries(entries)) {
    assert.doesNotMatch(body, /unexpected-secret-sentinel/);
    if (/xl\/worksheets\/sheet\d+\.xml$/.test(name)) assert.doesNotMatch(body, /<f[ >]/);
  }
});
test('Excel atomic writes publish an XLSX without leaving temporary files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(),'perf-xlsx-'));
  t.after(() => rm(directory,{ recursive:true, force:true }));
  const output = path.join(directory,'report.xlsx');
  assert.equal(await writeExcelReport(sample(),output),output);
  assert.equal((await readFile(output)).readUInt32LE(0),0x04034b50);
  assert.deepEqual(await readdir(directory),['report.xlsx']);
  await assert.rejects(writeExcelReport(sample(),path.join(directory,'report.csv')),/XLSX/);
});
