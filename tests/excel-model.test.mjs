import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExcelModel } from '../src/lib/excel-model.js';

const metric = (type, values) => ({ type, contains: type === 'trend' ? 'time' : 'default', values });
const gate = (metricName, expression, ok = true) => ({ metric: metricName, expression, ok, source: 'k6' });
function report() {
  return {
    schemaVersion: 1,
    run: { id: '2026-10-08T10-40-33-945Z-83e03154', environment: 'local', profile: 'smoke', suite: 'journey' },
    status: 'passed', summaryFormat: 'metrics-map', durationMs: 10000, errors: [],
    metrics: {
      http_reqs: metric('counter', { count: 100, rate: 10 }),
      http_req_failed: metric('rate', { rate: 0.02, passes: 2, fails: 98 }),
      http_req_duration: metric('trend', { avg: 100, med: 80, min: 5, max: 200, 'p(90)': 150, 'p(95)': 180, 'p(99)': 198 }),
      checks: metric('rate', { rate: 0.98, passes: 196, fails: 4 }),
      workflow_failed: metric('rate', { rate: 0.05, passes: 1, fails: 19 }),
      iterations: metric('counter', { count: 20 }),
      vus: metric('gauge', { value: 0, min: 0, max: 5 }),
      vus_max: metric('gauge', { value: 20, min: 20, max: 20 }),
      dropped_iterations: metric('counter', { count: 0 }),
      'workflow_requests{endpoint:create}': metric('counter', { count: 40, rate: 4 }),
      'http_req_duration{endpoint:create}': metric('trend', { avg: 90, med: 70, min: 5, max: 180, 'p(90)': 140, 'p(95)': 160, 'p(99)': 175 }),
      'http_req_failed{endpoint:create}': metric('rate', { rate: 0, passes: 0, fails: 40 }),
    },
    thresholds: [
      gate('http_req_duration', 'p(95)<200'),
      gate('http_req_failed', 'rate<0.05'),
      gate('http_req_duration{endpoint:create}', 'p(95)<175'),
      gate('http_req_failed{endpoint:create}', 'rate<0.01'),
    ],
  };
}

test('clear KPIs preserve milliseconds, ratio values, actual counts, and India time', () => {
  const model = buildExcelModel(report());
  assert.equal(model.run.status, 'passed');
  assert.equal(model.run.durationSeconds, 10);
  assert.match(model.run.startedAtIst, /08 Oct 2026.*16:10:33 IST/);
  assert.equal(model.kpis.requests, 100);
  assert.equal(model.kpis.httpErrors, 2);
  assert.equal(model.kpis.httpSuccesses, 98);
  assert.equal(model.kpis.httpErrorRate, 0.02);
  assert.equal(model.kpis.checkPassRate, 0.98);
  assert.equal(model.kpis.checksPassed, 196);
  assert.equal(model.kpis.checksFailed, 4);
  assert.equal(model.kpis.workflowFailureRate, 0.05);
  assert.equal(model.kpis.peakVus, 5);
  assert.equal(model.kpis.p95Ms, 180);
  assert.equal(model.kpis.p99Ms, 198);
  assert.equal(model.endpoints[0].status, 'PASS');
  assert.equal(model.endpoints[0].requests, 40);
  assert.equal(model.endpoints[0].p90Ms, 140);
  assert.equal(model.thresholds[0].actual, 180);
  assert.equal(model.thresholds[0].unit, 'ms');
  assert.equal(model.thresholds[1].actual, 0.02);
  assert.equal(model.thresholds[1].unit, 'ratio');
  assert.deepEqual(model.checks[1], { name: 'Journey failures', passed: 19, failed: 1, rate: 0.05, rateMeaning: 'Failure rate' });
  assert.ok(model.notes.some((entry) => entry.topic === 'Local sample'));
});

test('modern matches and total retain failure counts rather than reverse them', () => {
  const input = report();
  input.metrics.http_req_failed = metric('rate', { matches: 3, total: 100, rate: 0.03 });
  input.metrics.workflow_failed = metric('rate', { matches: 2, total: 20, rate: 0.1 });
  delete input.metrics.checks;
  input.metrics.checks_succeeded = metric('rate', { matches: 190, total: 200, rate: 0.95 });
  const model = buildExcelModel(input);
  assert.equal(model.kpis.httpErrors, 3);
  assert.equal(model.kpis.httpSuccesses, 97);
  assert.equal(model.kpis.checksPassed, 190);
  assert.equal(model.kpis.checksFailed, 10);
  assert.equal(model.kpis.checkPassRate, 0.95);
  assert.equal(model.checks[1].failed, 2);
  assert.equal(model.checks[1].passed, 18);
});

test('missing counts stay blank, while known rates remain usable', () => {
  const input = report();
  input.metrics.http_req_failed = metric('rate', { rate: 0.02 });
  delete input.metrics.checks;
  input.metrics.checks_succeeded = metric('rate', { rate: 1 });
  delete input.metrics.vus;
  delete input.metrics.dropped_iterations;
  delete input.metrics['workflow_requests{endpoint:create}'];
  input.metrics['http_req_failed{endpoint:create}'] = metric('rate', { rate: 0 });
  const model = buildExcelModel(input);
  assert.equal(model.kpis.httpErrors, null);
  assert.equal(model.kpis.httpSuccesses, null);
  assert.equal(model.kpis.checksPassed, null);
  assert.equal(model.kpis.checksFailed, null);
  assert.equal(model.kpis.checkPassRate, 1);
  assert.equal(model.kpis.peakVus, null);
  assert.equal(model.kpis.droppedIterations, null);
  assert.equal(model.endpoints[0].requests, null);
  assert.equal(model.endpoints[0].requestsPerSecond, null);
  assert.equal(model.endpoints[0].p95Ms, 160);
  assert.ok(model.notes.some((entry) => entry.topic === 'Endpoint request counts'));
});

test('missing required percentiles never produce a passing threshold', () => {
  const input = report();
  delete input.metrics.http_req_duration.values['p(99)'];
  input.thresholds.push(gate('http_req_duration', 'p(99)<250'));
  const model = buildExcelModel(input);
  const requirement = model.thresholds.find((entry) => entry.expression === 'p(99)<250');
  assert.equal(requirement.actual, null);
  assert.equal(requirement.status, 'NOT COLLECTED');
  assert.equal(model.kpis.p99Ms, null);
  assert.equal(model.run.status, 'failed');
});

test('zero-sample rates and skipped endpoint latency are not collected', () => {
  const input = report();
  input.metrics['workflow_requests{endpoint:skipped}'] = metric('counter', { count: 0 });
  input.metrics['http_req_duration{endpoint:skipped}'] = metric('trend', { avg: 0, 'p(95)': 0 });
  input.metrics['http_req_failed{endpoint:skipped}'] = metric('rate', { rate: 0, passes: 0, fails: 0 });
  input.thresholds.push(gate('http_req_duration{endpoint:skipped}', 'p(95)<100'));
  input.thresholds.push(gate('http_req_failed{endpoint:skipped}', 'rate==0'));
  const model = buildExcelModel(input);
  const skipped = model.endpoints.find((entry) => entry.name === 'skipped');
  assert.equal(skipped.status, 'NO DATA');
  assert.equal(skipped.requests, 0);
  assert.equal(skipped.p95Ms, null);
  assert.equal(skipped.errorRate, null);
  assert.ok(model.thresholds.filter((entry) => entry.scope === 'skipped').every((entry) => entry.status === 'NOT COLLECTED' && entry.actual === null));
  assert.equal(model.run.status, 'failed');
});

test('endpoint traffic without thresholds is visibly NO GATES', () => {
  const input = report();
  input.metrics['workflow_requests{endpoint:health}'] = metric('counter', { count: 10 });
  const model = buildExcelModel(input);
  const endpoint = model.endpoints.find((entry) => entry.name === 'health');
  assert.equal(endpoint.status, 'NO GATES');
  assert.equal(endpoint.requestsPerSecond, 1);
  assert.equal(endpoint.thresholdsTotal, 0);
});

test('zero overall traffic and absent gates cannot pass', () => {
  const input = report();
  input.metrics.http_reqs.values.count = 0;
  input.thresholds = [gate('http_reqs', 'count>=0')];
  const model = buildExcelModel(input);
  assert.equal(model.run.status, 'failed');
  assert.equal(model.kpis.p95Ms, null);
  assert.equal(model.thresholds[0].actual, 0);
  input.metrics.http_reqs.values.count = 1;
  input.thresholds = [];
  assert.equal(buildExcelModel(input).run.status, 'failed');
});

test('negative error counts and invalid fractions remain blank', () => {
  const input = report();
  input.metrics.http_req_failed = metric('rate', { rate: 1.2, passes: -2, fails: -98 });
  input.metrics.checks = metric('rate', { rate: -0.4, passes: -1, fails: -2 });
  const model = buildExcelModel(input);
  assert.equal(model.kpis.httpErrors, null);
  assert.equal(model.kpis.httpSuccesses, null);
  assert.equal(model.kpis.httpErrorRate, null);
  assert.equal(model.kpis.checksPassed, null);
  assert.equal(model.kpis.checksFailed, null);
  assert.equal(model.kpis.checkPassRate, null);
  assert.equal(model.thresholds[1].status, 'NOT COLLECTED');
  assert.equal(model.run.status, 'failed');
});

test('recorded threshold failures and mismatched measurements both fail', () => {
  const input = report();
  input.thresholds[0].ok = false;
  const model = buildExcelModel(input);
  assert.equal(model.thresholds[0].status, 'FAIL');
  assert.equal(model.run.status, 'failed');
  input.thresholds[0].ok = true;
  input.metrics.http_req_duration.values['p(95)'] = 250;
  assert.equal(buildExcelModel(input).thresholds[0].status, 'FAIL');
});

test('unsupported metric names, expressions, and extra secret fields are excluded', () => {
  const input = report();
  input.config = { url: 'secret-config-url' };
  input.raw = { token: 'secret-token' };
  input.metrics.secret_metric = metric('counter', { count: 7 });
  input.metrics['http_req_duration{url:secret-url}'] = metric('trend', { avg: 7 });
  input.metrics['http_req_duration{endpoint:health,token:secret-tag}'] = metric('trend', { avg: 7 });
  input.metrics.http_reqs.values.payload = 'secret-payload';
  input.metrics.http_reqs.values.avg = Infinity;
  input.thresholds.push(gate('secret-threshold', 'count>0'));
  input.thresholds.push(gate('http_reqs', 'secret-expression()'));
  input.thresholds[0].source = 'secret-source';
  input.errors.push('secret-error');
  const model = buildExcelModel(input);
  assert.doesNotMatch(JSON.stringify(model), /secret-|Infinity|config-url/);
  assert.equal(model.thresholds[0].source, 'Not recorded');
  assert.equal(model.run.status, 'failed');
  assert.equal(model.thresholds.length, 4);
});

test('labels remain literal display text with bounded control-free content', () => {
  const input = report();
  input.run.id = 'unparseable';
  input.run.suite = '=HYPERLINK("https://example.test")\u0000\u001f' + 'x'.repeat(400);
  const model = buildExcelModel(input);
  assert.ok(model.run.suite.startsWith('=HYPERLINK'));
  assert.equal(model.run.suite.length, 256);
  assert.doesNotMatch(model.run.suite, /[\u0000-\u001f\u007f]/);
  assert.equal(model.run.startedAtIst, 'Not recorded');
});

test('rate throughput and byte metrics use meaningful units', () => {
  const input = report();
  input.metrics.data_received = { type: 'counter', contains: 'data', values: { count: 2048, rate: 204.8 } };
  input.thresholds.push(gate('http_reqs', 'rate>=1'));
  const model = buildExcelModel(input);
  assert.equal(model.thresholds.at(-1).unit, 'per second');
  assert.equal(model.metrics.find((entry) => entry.metric === 'data_received' && entry.statistic === 'count').unit, 'bytes');
  assert.equal(model.metrics.find((entry) => entry.metric === 'data_received' && entry.statistic === 'rate').unit, 'bytes per second');
});

test('raw or incompatible reports cannot bypass normalized input contract', () => {
  assert.throws(() => buildExcelModel({ metrics: {} }), /normalized schemaVersion 1/);
  assert.throws(() => buildExcelModel({ schemaVersion: 2 }), /normalized schemaVersion 1/);
  assert.throws(() => buildExcelModel(null), /normalized schemaVersion 1/);
});


test('weighted endpoint request counts come from exact legacy Boolean samples', () => {
  const input = report();
  delete input.metrics['workflow_requests{endpoint:create}'];
  input.metrics['http_req_failed{endpoint:create}'] = metric('rate', { passes: 3, fails: 37 });
  input.thresholds[3] = gate('http_req_failed{endpoint:create}', 'rate<0.1');
  const model = buildExcelModel(input);
  assert.equal(model.endpoints[0].requests, 40);
  assert.equal(model.endpoints[0].requestsPerSecond, 4);
  assert.equal(model.endpoints[0].errorCount, 3);
  assert.equal(model.endpoints[0].successCount, 37);
  assert.equal(model.endpoints[0].errorRate, 0.075);
  assert.equal(model.run.status, 'passed');
  assert.ok(model.notes.some((entry) => entry.topic === 'Endpoint request count source'));
});

test('weighted modern Boolean totals provide exact request counts without estimating errors', () => {
  const input = report();
  delete input.metrics['workflow_requests{endpoint:create}'];
  input.metrics['http_req_failed{endpoint:create}'] = metric('rate', { matches: 3, total: 40, rate: 0.075 });
  input.thresholds[3] = gate('http_req_failed{endpoint:create}', 'rate<0.1');
  const model = buildExcelModel(input);
  assert.equal(model.endpoints[0].requests, 40);
  assert.equal(model.endpoints[0].requestsPerSecond, 4);
  assert.equal(model.endpoints[0].errorCount, 3);
  assert.equal(model.endpoints[0].successCount, 37);
  input.metrics['http_req_failed{endpoint:create}'] = metric('rate', { total: 40, rate: 0.075 });
  const totalOnly = buildExcelModel(input);
  assert.equal(totalOnly.endpoints[0].requests, 40);
  assert.equal(totalOnly.endpoints[0].errorCount, null);
  assert.equal(totalOnly.endpoints[0].successCount, null);
});

test('endpoint counter precedence remains workflow, HTTP, then Boolean samples', () => {
  const input = report();
  input.metrics['http_reqs{endpoint:create}'] = metric('counter', { count: 45 });
  assert.equal(buildExcelModel(input).endpoints[0].requests, 40);
  delete input.metrics['workflow_requests{endpoint:create}'];
  assert.equal(buildExcelModel(input).endpoints[0].requests, 45);
  delete input.metrics['http_reqs{endpoint:create}'];
  assert.equal(buildExcelModel(input).endpoints[0].requests, 40);
});

test('a partial legacy Boolean count never invents a request total', () => {
  const input = report();
  delete input.metrics['workflow_requests{endpoint:create}'];
  input.metrics['http_req_failed{endpoint:create}'] = metric('rate', { passes: 0, rate: 0 });
  const model = buildExcelModel(input);
  assert.equal(model.endpoints[0].requests, null);
  assert.equal(model.endpoints[0].requestsPerSecond, null);
  assert.equal(model.endpoints[0].errorCount, 0);
  assert.equal(model.endpoints[0].successCount, null);
});

test('contradictory endpoint ratios keep exact counts but cannot pass a rate requirement', () => {
  const input = report();
  delete input.metrics['workflow_requests{endpoint:create}'];
  input.metrics['http_req_failed{endpoint:create}'] = metric('rate', { passes: 0, fails: 40, rate: 0.9 });
  input.thresholds[3] = gate('http_req_failed{endpoint:create}', 'rate<1');
  const model = buildExcelModel(input);
  assert.equal(model.endpoints[0].requests, 40);
  assert.equal(model.endpoints[0].errorCount, 0);
  assert.equal(model.endpoints[0].successCount, 40);
  assert.equal(model.endpoints[0].errorRate, null);
  assert.equal(model.thresholds[3].actual, null);
  assert.equal(model.thresholds[3].status, 'NOT COLLECTED');
  assert.equal(model.run.status, 'failed');
  assert.ok(model.notes.some((entry) => entry.topic === 'Report validation' && entry.detail.includes('Rate data is inconsistent')));
});

test('contradictory check ratios stay unavailable even if counts could supply a ratio', () => {
  const input = report();
  input.metrics.checks.values.rate = 1;
  const model = buildExcelModel(input);
  assert.equal(model.kpis.checksPassed, 196);
  assert.equal(model.kpis.checksFailed, 4);
  assert.equal(model.kpis.checkPassRate, null);
  assert.equal(model.checks[0].rate, null);
  assert.equal(model.run.status, 'failed');
});

test('impossible modern totals and fractional samples are invalid rather than estimated', () => {
  const input = report();
  delete input.metrics['workflow_requests{endpoint:create}'];
  input.metrics['http_req_failed{endpoint:create}'] = metric('rate', { matches: 13, total: 10, rate: 0.1 });
  const impossible = buildExcelModel(input);
  assert.equal(impossible.endpoints[0].requests, null);
  assert.equal(impossible.endpoints[0].errorCount, null);
  assert.equal(impossible.endpoints[0].errorRate, null);
  assert.equal(impossible.run.status, 'failed');
  input.metrics['http_req_failed{endpoint:create}'] = metric('rate', { passes: 1.5, fails: 38.5, rate: 0.0375 });
  const fractional = buildExcelModel(input);
  assert.equal(fractional.endpoints[0].requests, null);
  assert.equal(fractional.endpoints[0].errorCount, null);
  assert.equal(fractional.run.status, 'failed');
});

test('ordinary floating-point ratio rounding remains consistent', () => {
  const input = report();
  input.metrics.http_req_failed.values.rate = 0.02 + 5e-11;
  const model = buildExcelModel(input);
  assert.equal(model.run.status, 'passed');
  assert.notEqual(model.kpis.httpErrorRate, null);
  assert.equal(model.notes.filter((entry) => entry.detail.includes('Rate data is inconsistent')).length, 0);
});

test('zero Boolean samples mark a skipped weighted endpoint without a consistency error', () => {
  const input = report();
  delete input.metrics['workflow_requests{endpoint:create}'];
  input.metrics['http_req_failed{endpoint:create}'] = metric('rate', { matches: 0, total: 0, rate: 0 });
  input.metrics['http_req_duration{endpoint:create}'] = metric('trend', { avg: 0, 'p(95)': 0 });
  const model = buildExcelModel(input);
  assert.equal(model.endpoints[0].requests, 0);
  assert.equal(model.endpoints[0].status, 'NO DATA');
  assert.equal(model.endpoints[0].p95Ms, null);
  assert.equal(model.endpoints[0].errorRate, null);
  assert.equal(model.notes.filter((entry) => entry.detail.includes('Rate data is inconsistent')).length, 0);
});
