// A strict, aggregate-only view model for Excel. Never read raw k6 data or configuration.
const METRICS = new Set([
  'http_reqs', 'http_req_failed', 'http_req_duration', 'http_req_blocked',
  'http_req_connecting', 'http_req_tls_handshaking', 'http_req_sending',
  'http_req_waiting', 'http_req_receiving', 'iterations', 'iteration_duration',
  'dropped_iterations', 'vus', 'vus_max', 'data_sent', 'data_received',
  'checks', 'checks_total', 'checks_succeeded', 'checks_failed',
  'workflow_failed', 'workflow_requests',
]);
const SAMPLE_KEYS = new Set(['passes', 'fails', 'matches', 'total']);
const COUNT_KEYS = new Set(['count', ...SAMPLE_KEYS]);
const VALUE_KEYS = new Set(['count', 'rate', 'min', 'max', 'value', 'avg', 'med', 'passes', 'fails', 'matches', 'total']);
const TIME_METRICS = new Set(['http_req_duration', 'http_req_blocked', 'http_req_connecting', 'http_req_tls_handshaking', 'http_req_sending', 'http_req_waiting', 'http_req_receiving', 'iteration_duration']);
const ERRORS = new Set([
  'Unrecognized threshold definition.', 'Unsupported k6 summary format.',
  'No supported aggregate metrics were collected.', 'No HTTP requests were completed.',
  'No verifiable performance thresholds were supplied.',
]);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const label = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256) : '';

function metricName(name) {
  if (typeof name !== 'string' || name.length > 512) return null;
  const match = /^([a-z_]+)(?:\{((?:endpoint:[A-Za-z0-9_.-]+|expected_response:(?:true|false))(?:,(?:endpoint:[A-Za-z0-9_.-]+|expected_response:(?:true|false)))*)\})?$/.exec(name);
  if (!match || !METRICS.has(match[1])) return null;
  const tags = match[2] ? match[2].split(',') : [];
  if (new Set(tags.map((tag) => tag.split(':')[0])).size !== tags.length) return null;
  return { base: match[1], endpoint: tags.find((tag) => tag.startsWith('endpoint:'))?.slice(9) ?? null };
}

function cleanMetric(metric) {
  const values = {};
  let invalidSamples = false;
  let invalidRatio = false;
  for (const [key, value] of Object.entries(record(metric.values) ? metric.values : {})) {
    if (VALUE_KEYS.has(key) || /^p\((?:100|\d{1,2})(?:\.\d+)?\)$/.test(key)) {
      const measured = number(value);
      if (SAMPLE_KEYS.has(key) && (measured === null || !Number.isInteger(measured))) invalidSamples = true;
      if (key === 'rate' && metric.type === 'rate' && (measured === null || measured > 1)) invalidRatio = true;
      if (measured !== null && (!COUNT_KEYS.has(key) || Number.isInteger(measured))) values[key] = measured;
    }
  }
  return { type: ['counter', 'rate', 'gauge', 'trend'].includes(metric.type) ? metric.type : 'unknown', values, invalidSamples, invalidRatio };
}

function statistic(metric, name) {
  const measured = number(metric?.values?.[name]);
  if (name === 'rate' && metric?.type !== 'counter' && measured !== null && measured > 1) return null;
  return measured;
}

// k6 Rate.passes counts true samples. True means failure for *_failed metrics.
function rateSamples(metric) {
  let trueCount = statistic(metric, 'passes');
  let falseCount = statistic(metric, 'fails');
  const matches = statistic(metric, 'matches');
  const total = statistic(metric, 'total');
  let invalidSamples = metric?.invalidSamples === true;
  if (matches !== null && total !== null && matches > total) invalidSamples = true;
  if (trueCount !== null && matches !== null && trueCount !== matches) invalidSamples = true;
  if (trueCount === null && matches !== null && (total === null || matches <= total)) trueCount = matches;
  if (trueCount !== null && total !== null && trueCount > total) invalidSamples = true;
  if (falseCount !== null && total !== null && falseCount > total) invalidSamples = true;
  if (trueCount !== null && falseCount !== null && total !== null && trueCount + falseCount !== total) invalidSamples = true;
  if (falseCount === null && total !== null && trueCount !== null && trueCount <= total) falseCount = total - trueCount;
  const observations = invalidSamples ? null : trueCount !== null && falseCount !== null ? trueCount + falseCount : total;
  let rate = metric?.type === 'counter' ? null : statistic(metric, 'rate');
  let invalid = invalidSamples || metric?.invalidRatio === true;
  if (observations === 0) {
    // A default zero ratio without samples is not an observed success.
    if (rate !== null && rate !== 0) invalid = true;
    rate = null;
  } else if (observations !== null && observations > 0 && trueCount !== null) {
    const observedRate = trueCount / observations;
    if (rate !== null && Math.abs(rate - observedRate) > 1e-10) invalid = true;
    else if (rate === null && !invalid) rate = observedRate;
  }
  if (invalid) rate = null;
  return {
    trueCount: invalidSamples ? null : trueCount,
    falseCount: invalidSamples ? null : falseCount,
    observations, rate, invalid, samplesValid: !invalidSamples,
  };
}

function unit(name, aggregate, metric, threshold = false) {
  if (!threshold && ['data_sent', 'data_received'].includes(name)) return aggregate === 'rate' ? 'bytes per second' : 'bytes';
  if (['count', 'passes', 'fails', 'matches', 'total'].includes(aggregate)) return 'count';
  if (aggregate === 'rate') return metric?.type === 'counter' || ['http_reqs', 'workflow_requests', 'iterations', 'dropped_iterations', 'checks_total'].includes(name) ? 'per second' : 'ratio';
  if (TIME_METRICS.has(name)) return 'ms';
  if (!threshold && ['data_sent', 'data_received'].includes(name)) return 'bytes';
  return 'count';
}

function parseExpression(expression) {
  if (typeof expression !== 'string' || expression.length > 128) return null;
  const match = /^(count|rate|min|max|value|avg|med|p\((?:100|\d{1,2})(?:\.\d+)?\))\s*(<=|>=|===|!==|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)$/.exec(expression);
  return match ? { aggregate: match[1], operator: match[2], expected: Number(match[3]) } : null;
}

function compare(actual, operator, expected) {
  switch (operator) {
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    case '==': case '===': return actual === expected;
    case '!=': case '!==': return actual !== expected;
    default: return false;
  }
}

function startedAt(id) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})[-:](\d{2})[-:](\d{2})(?:[-.](\d{3}))?Z/.exec(id);
  if (!match) return 'Not recorded';
  const iso = match[1] + 'T' + match[2] + ':' + match[3] + ':' + match[4] + '.' + (match[5] ?? '000') + 'Z';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso) return 'Not recorded';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(date) + ' IST';
}

/** Produce a safe view model from schemaVersion 1 summary.json only. */
export function buildExcelModel(report) {
  if (!record(report) || report.schemaVersion !== 1) throw new TypeError('Excel reporting requires a normalized schemaVersion 1 summary.');
  const metrics = new Map();
  const names = new Set();
  for (const [name, metric] of Object.entries(record(report.metrics) ? report.metrics : {})) {
    const parsed = metricName(name);
    if (!parsed || !record(metric)) continue;
    metrics.set(name, { ...cleanMetric(metric), ...parsed });
    if (parsed.endpoint) names.add(parsed.endpoint);
  }
  const get = (base, endpoint = null) => metrics.get(endpoint === null ? base : base + '{endpoint:' + endpoint + '}');
  const value = (base, aggregate, endpoint = null) => statistic(get(base, endpoint), aggregate);
  const requests = value('http_reqs', 'count');
  const durationSeconds = number(report.durationMs) === null ? null : report.durationMs / 1000;
  const sampleRequestCount = (endpoint) => {
    const metric = get('http_req_failed', endpoint);
    const samples = rateSamples(metric);
    return metric?.type === 'rate' && samples.samplesValid && samples.observations !== null && Number.isInteger(samples.observations) ? samples.observations : null;
  };
  const requestCount = (endpoint) => value('workflow_requests', 'count', endpoint) ?? value('http_reqs', 'count', endpoint) ?? sampleRequestCount(endpoint);
  const requestsPerSecond = (endpoint, count) => value(endpoint === null ? 'http_reqs' : 'workflow_requests', 'rate', endpoint) ?? (endpoint !== null ? value('http_reqs', 'rate', endpoint) : null) ?? (count !== null && durationSeconds !== null && durationSeconds > 0 ? count / durationSeconds : null);
  const safeThresholds = [];
  let invalidThresholds = false;
  for (const threshold of Array.isArray(report.thresholds) ? report.thresholds : []) {
    if (!record(threshold)) { invalidThresholds = true; continue; }
    const parsed = metricName(threshold.metric);
    const expression = parseExpression(threshold.expression);
    if (!parsed || !expression) { invalidThresholds = true; continue; }
    if (parsed.endpoint) names.add(parsed.endpoint);
    safeThresholds.push({ parsed, expression, definition: threshold });
  }
  const thresholds = safeThresholds.map(({ parsed, expression, definition }) => {
    const metric = metrics.get(definition.metric);
    let actual = expression.aggregate === 'rate' && metric?.type === 'rate' ? rateSamples(metric).rate : statistic(metric, expression.aggregate);
    // k6 can emit zero-valued latency summaries for skipped endpoints.
    if (parsed.endpoint && requestCount(parsed.endpoint) === 0 && expression.aggregate !== 'count') actual = null;
    if (parsed.endpoint === null && parsed.base.startsWith('http_req_') && requests === 0 && expression.aggregate !== 'count') actual = null;
    return {
      scope: parsed.endpoint ?? 'Overall', metric: definition.metric,
      expression: definition.expression, actual, unit: unit(parsed.base, expression.aggregate, metric, true),
      status: actual === null ? 'NOT COLLECTED' : definition.ok === true && compare(actual, expression.operator, expression.expected) ? 'PASS' : 'FAIL',
      source: ['k6', 'evaluated'].includes(definition.source) ? definition.source : 'Not recorded',
    };
  });
  const http = rateSamples(get('http_req_failed'));
  const workflow = rateSamples(get('workflow_failed'));
  const responseChecks = rateSamples(get('checks'));
  const succeeded = get('checks_succeeded');
  const failed = get('checks_failed');
  let checksPassed = responseChecks.trueCount ?? statistic(succeeded, 'count') ?? rateSamples(succeeded).trueCount ?? rateSamples(failed).falseCount;
  let checksFailed = responseChecks.falseCount ?? statistic(failed, 'count') ?? rateSamples(failed).trueCount ?? rateSamples(succeeded).falseCount;
  const checksTotal = value('checks_total', 'count');
  if (checksPassed === null && checksTotal !== null && checksFailed !== null && checksFailed <= checksTotal) checksPassed = checksTotal - checksFailed;
  if (checksFailed === null && checksTotal !== null && checksPassed !== null && checksPassed <= checksTotal) checksFailed = checksTotal - checksPassed;
  const observedChecks = checksPassed !== null && checksFailed !== null ? checksPassed + checksFailed : checksTotal;
  const invalidCheckRates = responseChecks.invalid || rateSamples(succeeded).invalid || rateSamples(failed).invalid;
  const checkPassRate = observedChecks === 0 || invalidCheckRates ? null : responseChecks.rate ?? rateSamples(succeeded).rate ?? (observedChecks !== null && observedChecks > 0 ? checksPassed / observedChecks : null);
  const httpErrors = http.trueCount;
  const httpSuccesses = http.falseCount ?? (requests !== null && httpErrors !== null && httpErrors <= requests ? requests - httpErrors : null);
  const kpis = {
    requests, requestsPerSecond: requestsPerSecond(null, requests),
    httpErrors, httpSuccesses, httpErrorRate: requests === 0 ? null : http.rate,
    checkPassRate, checksPassed, checksFailed, workflowFailureRate: workflow.rate,
    iterations: value('iterations', 'count'),
    peakVus: value('vus', 'max'),
    droppedIterations: value('dropped_iterations', 'count'),
    p95Ms: requests === 0 ? null : value('http_req_duration', 'p(95)'),
    p99Ms: requests === 0 ? null : value('http_req_duration', 'p(99)'),
    avgMs: requests === 0 ? null : value('http_req_duration', 'avg'),
    thresholdsPassed: thresholds.filter((entry) => entry.status === 'PASS').length,
    thresholdsTotal: thresholds.length,
  };
  const endpoints = [...names].sort().map((name) => {
    const count = requestCount(name);
    const gates = thresholds.filter((entry) => entry.scope === name);
    const timing = get('http_req_duration', name);
    const failure = rateSamples(get('http_req_failed', name));
    const hasData = count === null ? Boolean(timing && Object.keys(timing.values).length > 0) || (failure.observations !== null && failure.observations > 0) : count > 0;
    const latency = (aggregate) => hasData ? statistic(timing, aggregate) : null;
    return {
      name, requests: count, requestsPerSecond: requestsPerSecond(name, count),
      avgMs: latency('avg'), medianMs: latency('med'), p90Ms: latency('p(90)'),
      p95Ms: latency('p(95)'), p99Ms: latency('p(99)'), minMs: latency('min'), maxMs: latency('max'),
      errorRate: hasData ? failure.rate : null, errorCount: failure.trueCount, successCount: failure.falseCount,
      status: !hasData ? 'NO DATA' : gates.length === 0 ? 'NO GATES' : gates.every((entry) => entry.status === 'PASS') ? 'PASS' : 'FAIL',
      thresholdsPassed: gates.filter((entry) => entry.status === 'PASS').length, thresholdsTotal: gates.length,
    };
  });
  const rows = [];
  for (const [name, metric] of [...metrics.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const aggregate of Object.keys(metric.values).sort()) {
      const measured = aggregate === 'rate' && metric.type === 'rate' ? rateSamples(metric).rate : statistic(metric, aggregate);
      if (measured !== null) rows.push({ metric: name, statistic: aggregate, value: measured, unit: unit(metric.base, aggregate, metric) });
    }
  }
  const invalidRateMetrics = [...metrics.entries()].filter(([, metric]) => metric.type === 'rate' && rateSamples(metric).invalid).map(([name]) => name);
  const notes = [
    { topic: 'Data handling', detail: 'Aggregate metrics only. Request URLs, headers, credentials, payloads, response bodies, and raw check names are excluded.' },
    { topic: 'Missing measurements', detail: 'Not collected marks unavailable measurements. A zero is a measured value. NO DATA marks an endpoint without observed requests; NO GATES means it has data but no endpoint thresholds.' },
    { topic: 'Latency percentiles', detail: 'Latency is in milliseconds. P95 is the duration at or below which 95% of measured requests fall; P99 uses 99%. These are sample percentiles.' },
    { topic: 'HTTP duration', detail: 'http_req_duration covers sending, waiting, and receiving. It excludes connection setup. See blocked, connecting, and TLS metrics in Metrics for setup timing.' },
    { topic: 'HTTP failures', detail: 'HTTP error rate reflects k6 expected-response classification. Response checks validate assertions separately. For failure Rate metrics, k6 passes/matches count true failure events.' },
    { topic: 'Endpoint request count source', detail: 'Endpoint request counts use workflow_requests or http_reqs counters when collected. Otherwise the exact endpoint http_req_failed Boolean sample total supplies the count: legacy passes plus fails, or modern total. A missing total is never estimated from a ratio.' },
    { topic: 'Endpoint identity', detail: 'Endpoint rows use stable configured operation IDs rather than request URLs. Endpoint request rates use recorded counter rates or request count divided by run duration.' },
    { topic: 'Time and scope', detail: 'Run start is derived from the UTC run ID and displayed in India Standard Time (Asia/Kolkata). This aggregate report contains no time series and cannot show when spikes occurred.' },
    { topic: 'Threshold decisions', detail: 'PASS requires an observed measurement, a satisfied expression, and a passing recorded threshold. Missing required measurements are NOT COLLECTED and prevent an overall pass.' },
  ];
  const runSource = record(report.run) ? report.run : {};
  if (label(runSource.environment).toLowerCase() === 'local') notes.push({ topic: 'Local sample', detail: 'Synthetic local test results verify framework behavior. A short smoke test and small sample do not establish production capacity.' });
  else if (label(runSource.profile).toLowerCase() === 'smoke') notes.push({ topic: 'Smoke sample', detail: 'A short smoke test and small sample verify basic behavior; they do not establish production capacity.' });
  if (endpoints.some((entry) => entry.requests === null)) notes.push({ topic: 'Endpoint request counts', detail: 'Some endpoints have neither a collected request counter nor a valid HTTP Boolean sample total. Their request counts and derived throughput are marked Not collected; latency measurements are shown where available.' });
  for (const metric of invalidRateMetrics) notes.push({ topic: 'Report validation', detail: 'Rate data is inconsistent for ' + metric + '. The rate is marked Not collected and the run cannot pass.' });
  if (invalidThresholds) notes.push({ topic: 'Report validation', detail: 'Unrecognized threshold definitions were omitted and prevent an overall pass.' });
  if (requests === null || requests === 0) notes.push({ topic: 'Report validation', detail: 'A positive completed HTTP request count was not recorded. The run cannot be marked passed.' });
  if (thresholds.length === 0) notes.push({ topic: 'Report validation', detail: 'No verifiable performance thresholds were supplied. The run cannot be marked passed.' });
  const suppliedErrors = Array.isArray(report.errors) ? report.errors : [];
  if (report.status !== 'passed' && suppliedErrors.length === 0 && thresholds.every((entry) => entry.status === 'PASS')) notes.push({ topic: 'Report validation', detail: 'The normalized summary did not record a passing run status.' });
  for (const error of [...new Set(suppliedErrors.filter((entry) => ERRORS.has(entry)))]) notes.push({ topic: 'Report validation', detail: error });
  if (suppliedErrors.some((entry) => !ERRORS.has(entry))) notes.push({ topic: 'Report validation', detail: 'The normalized report contains additional validation errors. Their unrecognized text is excluded.' });
  const status = report.status === 'passed' && requests !== null && requests > 0 && thresholds.length > 0 && thresholds.every((entry) => entry.status === 'PASS') && !invalidThresholds && invalidRateMetrics.length === 0 && suppliedErrors.length === 0 ? 'passed' : 'failed';
  return {
    run: {
      id: label(runSource.id), environment: label(runSource.environment), profile: label(runSource.profile),
      suite: label(runSource.suite), status, durationSeconds,
      startedAtIst: startedAt(label(runSource.id)), format: ['machine-v1', 'grouped-metrics', 'metrics-map', 'unsupported'].includes(report.summaryFormat) ? report.summaryFormat : 'Not recorded',
    },
    kpis, endpoints, thresholds,
    checks: [
      { name: 'Response checks', passed: checksPassed, failed: checksFailed, rate: checkPassRate, rateMeaning: 'Pass rate' },
      { name: 'Journey failures', passed: workflow.falseCount, failed: workflow.trueCount, rate: workflow.rate, rateMeaning: 'Failure rate' },
    ],
    metrics: rows, notes,
  };
}
