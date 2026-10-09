import test from 'node:test';
import assert from 'node:assert/strict';
import { createSummary, summarize } from '../src/lib/report.js';

const metric = (type, values, thresholds) => ({ type, contains: type === 'trend' ? 'time' : 'default', values, ...(thresholds ? { thresholds } : {}) });
const run = { id: 'run-1', environment: 'local', profile: 'smoke', suite: 'journey', reportDir: 'reports/run-1' };
function legacy() {
  return { state: { testRunDurationMs: 1234 }, metrics: {
    http_reqs: metric('counter', { count: 4, rate: 3.2 }),
    http_req_duration: metric('trend', { avg: 12, 'p(95)': 22 }, { 'p(95)<100': { ok: true } }),
    workflow_failed: metric('rate', { rate: 0, passes: 0, fails: 2 }, { 'rate==0': { ok: true } }),
  } };
}

test('legacy summaries retain aggregate values, thresholds and duration', () => {
  const report = summarize(legacy(), run);
  assert.equal(report.status, 'passed');
  assert.equal(report.durationMs, 1234);
  assert.equal(report.metrics.http_reqs.values.count, 4);
  assert.equal(report.thresholds.length, 2);
});

test('failed thresholds create failing console and JUnit results', () => {
  const data = legacy();
  data.metrics.http_req_duration.thresholds['p(95)<100'].ok = false;
  const outputs = createSummary(data, run);
  assert.match(outputs.stdout, /API performance: FAILED/);
  assert.match(outputs['reports/run-1/junit.xml'], /failures="1"/);
  assert.match(outputs['reports/run-1/junit.xml'], /p\(95\)&lt;100/);
});

test('reports exclude raw checks, setup data, secret tags and unknown values', () => {
  const data = legacy();
  data.root_group = { checks: [{ name: 'secret-in-check-name' }] };
  data.setup_data = { token: 'secret-token' };
  data.metrics['http_req_duration{url:https://api.test?token=secret-url}'] = metric('trend', { avg: 5 });
  data.metrics.secret_metric = metric('counter', { count: 9 });
  data.metrics.http_reqs.values.payload = 'secret-payload';
  data.metrics.http_reqs.values.avg = Infinity;
  assert.doesNotMatch(Object.values(createSummary(data, run)).join('\n'), /secret-|setup_data|root_group|Infinity/);
});

test('HTML escapes labels and XML escapes threshold operators', () => {
  const outputs = createSummary(legacy(), { ...run, suite: '</p><script>alert("x")</script>&' });
  const html = outputs['reports/run-1/report.html'];
  assert.doesNotMatch(html, /<script>|<\/p><script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(outputs['reports/run-1/junit.xml'], /p\(95\)&lt;100/);
});

test('machine v1 summaries normalize percentile aliases and verify configured requirements', () => {
  const data = { version: '1.0.0', metadata: { k6_version: '2.3.0' }, config: { duration: 2 }, results: { metrics: [
    { name: 'http_reqs', ...metric('counter', { count: 8 }) },
    { name: 'http_req_duration', ...metric('trend', { avg: 7, p95: 16 }) },
    { name: 'workflow_failed', ...metric('rate', { rate: 0, matches: 0, total: 8 }) },
  ], checks: { metrics: [{ name: 'checks_succeeded', ...metric('rate', { rate: 1 }) }], results: [{ name: 'secret-raw-check' }] } } };
  const report = summarize(data, { ...run, thresholds: { http_req_duration: ['p(95)<20'], workflow_failed: ['rate==0'] } });
  assert.equal(report.status, 'passed');
  assert.equal(report.durationMs, 2000);
  assert.equal(report.metrics.http_req_duration.values['p(95)'], 16);
  assert.equal(report.thresholds[0].source, 'evaluated');
  assert.doesNotMatch(JSON.stringify(report), /secret-raw-check/);
});

test('missing configured metrics or percentiles fail closed', () => {
  const report = summarize(legacy(), { ...run, thresholds: { http_req_duration: ['p(99)<100'], workflow_requests: ['count>0'] } });
  assert.equal(report.status, 'failed');
  assert.equal(report.thresholds.filter((entry) => !entry.ok).length, 2);
});

test('unknown formats, empty traffic and absent thresholds cannot pass', () => {
  assert.equal(summarize({ version: '99.0.0', metrics: legacy().metrics }, run).status, 'failed');
  assert.equal(summarize({}, run).status, 'failed');
  assert.equal(summarize({ metrics: { http_reqs: metric('counter', { count: 1 }) } }, run).status, 'failed');
  const data = legacy();
  data.metrics.http_reqs.values.count = 0;
  assert.equal(summarize(data, run).status, 'failed');
});

test('configured aggregates cannot override an explicit failed k6 threshold', () => {
  const data = legacy();
  data.metrics.http_req_duration.thresholds['p(95)<100'].ok = false;
  const report = summarize(data, { ...run, thresholds: { http_req_duration: ['p(95)<100'] } });
  assert.equal(report.status, 'failed');
  assert.equal(report.thresholds.filter((entry) => entry.metric === 'http_req_duration').length, 1);
});

test('current grouped metrics preserve threshold metric values and source outcomes', () => {
  const data = { metrics: { http: { http_reqs: metric('counter', { count: 4 }), http_req_duration: metric('trend', { avg: 9, 'p(95)': 13 }) }, custom: { workflow_failed: metric('rate', { rate: 0 }) } }, checks: { metrics: { checks_succeeded: metric('rate', { rate: 1 }) }, ordered_checks: [{ name: 'secret-check' }] }, thresholds: { 'http_req_duration{endpoint:health}': { metric: metric('trend', { 'p(95)': 11 }), thresholds: [{ source: 'p(95)<100', ok: true }] }, checks: { metric: metric('rate', { rate: 1 }), thresholds: [{ source: 'rate==1', ok: true }] } } };
  const report = summarize(data, run);
  assert.equal(report.status, 'passed');
  assert.equal(report.metrics['http_req_duration{endpoint:health}'].values['p(95)'], 11);
  assert.equal(report.metrics.checks.values.rate, 1);
  assert.doesNotMatch(JSON.stringify(report), /secret-check/);
});
