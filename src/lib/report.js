// Aggregate-only, dependency-free reports; no request/response content retained.
const METRICS = new Set([
  'http_reqs', 'http_req_failed', 'http_req_duration', 'http_req_blocked',
  'http_req_connecting', 'http_req_tls_handshaking', 'http_req_sending',
  'http_req_waiting', 'http_req_receiving', 'iterations', 'iteration_duration',
  'dropped_iterations', 'vus', 'vus_max', 'data_sent', 'data_received',
  'checks', 'checks_total', 'checks_succeeded', 'checks_failed',
  'workflow_failed', 'workflow_requests',
]);
const VALUE_KEYS = new Set(['count', 'rate', 'min', 'max', 'value', 'avg', 'med', 'passes', 'fails', 'matches', 'total']);
const TYPES = new Set(['counter', 'rate', 'gauge', 'trend']);
const CONTAINS = new Set(['default', 'time', 'data']);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function safeMetricName(name) {
  if (typeof name !== 'string') return false;
  const match = /^([a-z_]+)(?:\{((?:endpoint:[A-Za-z0-9_.-]+|expected_response:(?:true|false))(?:,(?:endpoint:[A-Za-z0-9_.-]+|expected_response:(?:true|false)))*)\})?$/.exec(name);
  return Boolean(match && METRICS.has(match[1]));
}

function numericValues(source) {
  const result = {};
  if (!record(source)) return result;
  for (const key of Object.keys(source)) {
    const alias = /^p(\d+(?:\.\d+)?)$/.exec(key);
    const normalized = alias ? `p(${alias[1]})` : key;
    if (!VALUE_KEYS.has(normalized) && !/^p\((?:100|\d{1,2})(?:\.\d+)?\)$/.test(normalized)) continue;
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) result[normalized] = source[key];
  }
  return result;
}

function safeLabel(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256) : '';
}

function cleanMetric(metric) {
  return { type: TYPES.has(metric.type) ? metric.type : 'unknown', contains: CONTAINS.has(metric.contains) ? metric.contains : 'default', values: numericValues(metric.values) };
}

function expressionValid(expression) {
  return typeof expression === 'string' && /^(?:count|rate|min|max|value|avg|med|p\((?:100|\d{1,2})(?:\.\d+)?\))\s*(?:<=|>=|==|===|!=|!==|<|>)\s*-?\d+(?:\.\d+)?$/.test(expression);
}

function evaluate(expression, values) {
  const parts = /^(.*?)\s*(<=|>=|===|!==|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)$/.exec(expression);
  if (!parts || !has(values, parts[1].trim())) return false;
  const actual = values[parts[1].trim()];
  const expected = Number(parts[3]);
  switch (parts[2]) {
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    case '==': case '===': return actual === expected;
    case '!=': case '!==': return actual !== expected;
    default: return false;
  }
}

function metricEntries(data) {
  if (data.version === '1.0.0' && record(data.results) && Array.isArray(data.results.metrics)) {
    return { format: 'machine-v1', entries: data.results.metrics.concat(record(data.results.checks) && Array.isArray(data.results.checks.metrics) ? data.results.checks.metrics : []).filter(record).map((metric) => [metric.name, metric]), durationMs: Number.isFinite(data.config?.duration) ? data.config.duration * 1000 : null };
  }
  if (record(data.metrics) && data.version === undefined) {
    const categories = ['http', 'execution', 'network', 'custom'];
    const grouped = categories.some((category) => record(data.metrics[category]));
    const entries = grouped ? categories.flatMap((category) => record(data.metrics[category]) ? Object.entries(data.metrics[category]) : []) : Object.entries(data.metrics);
    if (record(data.checks?.metrics)) entries.push(...Object.entries(data.checks.metrics));
    if (record(data.thresholds)) for (const [name, threshold] of Object.entries(data.thresholds)) if (record(threshold?.metric)) entries.push([name, threshold.metric]);
    return { format: grouped ? 'grouped-metrics' : 'metrics-map', entries, durationMs: Number.isFinite(data.state?.testRunDurationMs) ? data.state.testRunDurationMs : null };
  }
  return null;
}

/** Stable aggregate-only representation of legacy and current k6 summaries. */
export function summarize(data, run = {}) {
  const errors = [];
  const parsed = record(data) ? metricEntries(data) : null;
  const metrics = {};
  const thresholds = [];
  const seen = new Set();
  const addThreshold = (name, expression, ok, source) => {
    if (!safeMetricName(name) || !expressionValid(expression)) { errors.push('Unrecognized threshold definition.'); return; }
    const key = `${name}\n${expression}`;
    if (seen.has(key)) return;
    seen.add(key);
    thresholds.push({ metric: name, expression, ok: ok === true, source });
  };
  if (!parsed) errors.push('Unsupported k6 summary format.');
  else {
    for (const [name, metric] of parsed.entries) {
      if (!safeMetricName(name) || !record(metric)) continue;
      metrics[name] = cleanMetric(metric);
      if (record(metric.thresholds)) for (const [expression, result] of Object.entries(metric.thresholds)) addThreshold(name, expression, result?.ok, 'k6');
    }
    if (record(data.thresholds)) {
      for (const [name, values] of Object.entries(data.thresholds)) {
        const items = Array.isArray(values) ? values : record(values) && Array.isArray(values.thresholds) ? values.thresholds : null;
        if (items) for (const item of items) addThreshold(name, item.source ?? item.threshold, item.ok ?? (typeof item.last_failed === 'boolean' ? !item.last_failed : undefined), 'k6');
        else if (record(values)) for (const [expression, result] of Object.entries(values)) if (expressionValid(expression)) addThreshold(name, expression, typeof result === 'boolean' ? result : result?.ok, 'k6');
      }
    }
  }
  // Modern machine summaries may omit thresholds. Evaluate every configured
  // requirement and fail if its measurement is missing rather than claim success.
  if (record(run.thresholds)) {
    for (const [name, definitions] of Object.entries(run.thresholds)) {
      if (!Array.isArray(definitions)) { errors.push('Unrecognized threshold definition.'); continue; }
      for (const item of definitions) {
        const expression = typeof item === 'string' ? item : item?.threshold;
        if (!seen.has(`${name}\n${expression}`)) addThreshold(name, expression, evaluate(expression, metrics[name]?.values ?? {}), 'evaluated');
      }
    }
  }
  if (Object.keys(metrics).length === 0) errors.push('No supported aggregate metrics were collected.');
  if (!(metrics.http_reqs?.values.count > 0)) errors.push('No HTTP requests were completed.');
  if (thresholds.length === 0) errors.push('No verifiable performance thresholds were supplied.');
  return {
    schemaVersion: 1,
    run: { id: safeLabel(run.id), environment: safeLabel(run.environment), profile: safeLabel(run.profile), suite: safeLabel(run.suite) },
    status: thresholds.some((threshold) => !threshold.ok) || errors.length > 0 ? 'failed' : 'passed',
    summaryFormat: parsed?.format ?? 'unsupported', durationMs: parsed?.durationMs ?? null,
    metrics, thresholds, errors: [...new Set(errors)],
  };
}

const escapeMarkup = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const formatNumber = (number) => Number.isInteger(number) ? String(number) : number.toFixed(3);

function textReport(report) {
  const requests = report.metrics.http_reqs?.values.count ?? 0;
  const duration = report.metrics.http_req_duration?.values;
  const passed = report.thresholds.filter((threshold) => threshold.ok).length;
  const lines = [`API performance: ${report.status.toUpperCase()}`, `Run ${report.run.id} | ${report.run.environment} | ${report.run.profile} | ${report.run.suite}`, `HTTP requests: ${requests}; thresholds: ${passed}/${report.thresholds.length} passed`];
  if (duration) lines.push(`Latency (ms): avg=${duration.avg === undefined ? 'n/a' : formatNumber(duration.avg)}; p95=${duration['p(95)'] === undefined ? 'n/a' : formatNumber(duration['p(95)'])}; p99=${duration['p(99)'] === undefined ? 'n/a' : formatNumber(duration['p(99)'])}`);
  for (const threshold of report.thresholds) lines.push(`${threshold.ok ? 'PASS' : 'FAIL'} ${threshold.metric} ${threshold.expression}`);
  for (const error of report.errors) lines.push(`FAIL ${error}`);
  return `${lines.join('\n')}\n`;
}

function htmlReport(report) {
  const thresholdRows = report.thresholds.map((threshold) => `<tr><td>${escapeMarkup(threshold.metric)}</td><td><code>${escapeMarkup(threshold.expression)}</code></td><td class="${threshold.ok ? 'pass' : 'fail'}">${threshold.ok ? 'Passed' : 'Failed'}</td></tr>`).join('');
  const metricRows = Object.entries(report.metrics).map(([name, metric]) => `<tr><td>${escapeMarkup(name)}</td><td>${escapeMarkup(metric.contains === 'time' ? 'ms' : metric.contains === 'data' ? 'bytes' : metric.type)}</td><td>${Object.entries(metric.values).map(([key, value]) => `<span>${escapeMarkup(key)}: ${formatNumber(value)}</span>`).join(' ')}</td></tr>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>API performance report</title><style>
:root{color-scheme:light dark;font:16px system-ui,sans-serif}body{max-width:1120px;margin:40px auto;padding:0 24px;line-height:1.5}h1{font-size:2rem}p{color:#64748b}.badge{padding:6px 12px;border-radius:5px;font-weight:700}.pass{color:#168448}.fail{color:#d64545}table{border-collapse:collapse;width:100%;margin:20px 0 36px}th,td{text-align:left;padding:12px;border-bottom:1px solid #64748b44;overflow-wrap:anywhere}td span{display:inline-block;margin-right:14px}code{font-size:.9em}footer{color:#64748b;font-size:.85rem}@media(max-width:600px){body{margin:20px auto;padding:0 12px}th,td{padding:8px;font-size:.8rem}}
</style></head><body><h1>API performance report <span class="badge ${report.status === 'passed' ? 'pass' : 'fail'}">${report.status.toUpperCase()}</span></h1><p>Run ${escapeMarkup(report.run.id)} · ${escapeMarkup(report.run.environment)} · ${escapeMarkup(report.run.profile)} · ${escapeMarkup(report.run.suite)}</p>${report.errors.map((error) => `<p class="fail">${escapeMarkup(error)}</p>`).join('')}<h2>Performance thresholds</h2><table><thead><tr><th>Metric</th><th>Requirement</th><th>Result</th></tr></thead><tbody>${thresholdRows}</tbody></table><h2>Aggregate metrics</h2><table><thead><tr><th>Metric</th><th>Unit</th><th>Statistics</th></tr></thead><tbody>${metricRows}</tbody></table><footer>Aggregate-only report. Request URLs, headers, payloads, raw checks and response content are excluded. Threshold failure controls the k6 exit code.</footer></body></html>\n`;
}

function junitReport(report) {
  const tests = report.thresholds.length + report.errors.length;
  const failures = report.thresholds.filter((threshold) => !threshold.ok).length + report.errors.length;
  const cases = report.thresholds.map((threshold) => `<testcase classname="performance.thresholds" name="${escapeMarkup(`${threshold.metric} ${threshold.expression}`)}">${threshold.ok ? '' : '<failure message="Performance threshold failed"/>'}</testcase>`).concat(report.errors.map((error, index) => `<testcase classname="performance.report" name="report_validation_${index + 1}"><failure message="${escapeMarkup(error)}"/></testcase>`)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${tests}" failures="${failures}"><testsuite name="API performance" tests="${tests}" failures="${failures}">${cases}</testsuite></testsuites>\n`;
}

/** k6 handleSummary destination map. The launcher creates reportDir beforehand. */
export function createSummary(data, run) {
  const report = summarize(data, run);
  if (typeof run?.reportDir !== 'string' || !run.reportDir) throw new Error('Report destination is required.');
  const directory = run.reportDir.replace(/[\\/]+$/, '');
  const output = (key, fallback) => {
    const filename = run.files?.[key] ?? directory + '/' + fallback;
    if (typeof filename !== 'string' || !filename) throw new Error('Report destination is required.');
    return filename.replace(/\\/g, '/');
  };
  return { stdout: textReport(report), [output('summary', 'summary.json')]: JSON.stringify(report, null, 2) + '\n', [output('html', 'report.html')]: htmlReport(report), [output('junit', 'junit.xml')]: junitReport(report) };
}
