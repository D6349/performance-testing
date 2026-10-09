import http from 'k6/http';
import { check, sleep } from 'k6';
import execution from 'k6/execution';
import crypto from 'k6/crypto';
import { Rate, Counter } from 'k6/metrics';
import { buildOptions } from '../lib/options.js';
import { buildRequest } from '../lib/request.js';
import { renderTemplate, getPath } from '../lib/template.js';
import { createSummary } from '../lib/report.js';

if (!__ENV.PERF_MANIFEST) throw new Error('Use the framework launcher to provide PERF_MANIFEST.');
const manifest = JSON.parse(open(__ENV.PERF_MANIFEST));
export const options = buildOptions(manifest);
const workflowFailed = new Rate('workflow_failed');
const workflowRequests = new Counter('workflow_requests');
const steps = manifest.suite.steps.filter((step) => manifest.api.endpoints[step.endpoint].enabled !== false);
const cleanup = (manifest.suite.cleanup ?? []).filter((step) => manifest.api.endpoints[step.endpoint].enabled !== false);

function uuid() {
  const bytes = new Uint8Array(crypto.randomBytes(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function equal(actual, expected) {
  if (actual === expected) return true;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const keys = Object.keys(actual);
  return keys.length === Object.keys(expected).length && keys.every((key) => Object.prototype.hasOwnProperty.call(expected, key) && equal(actual[key], expected[key]));
}

function assertResponse(response, endpoint, context) {
  const expectations = endpoint.expect ?? {};
  const tags = { endpoint: context.endpointId };
  let passed = check(response, { 'expected status': (result) => (expectations.statuses ?? [200]).includes(result.status) }, tags);
  let parsed;
  let validJson = true;
  if ((expectations.json?.length ?? 0) > 0 || Object.keys(endpoint.extract ?? {}).length > 0) {
    try { parsed = response.json(); } catch { validJson = false; }
    passed = check(response, { 'valid JSON response': () => validJson }, tags) && passed;
  }
  for (let index = 0; index < (expectations.json?.length ?? 0); index += 1) {
    const assertion = expectations.json[index];
    const actual = validJson ? getPath(parsed, assertion.path) : undefined;
    let ok = validJson;
    if (Object.prototype.hasOwnProperty.call(assertion, 'exists')) ok = ok && (actual !== undefined) === assertion.exists;
    if (Object.prototype.hasOwnProperty.call(assertion, 'equals')) ok = ok && equal(actual, renderTemplate(assertion.equals, context));
    passed = check(response, { [`JSON assertion ${index + 1}`]: () => ok }, tags) && passed;
  }
  for (const [header, expected] of Object.entries(expectations.headers ?? {})) {
    const key = Object.keys(response.headers).find((name) => name.toLowerCase() === header.toLowerCase());
    const actual = key === undefined ? undefined : response.headers[key];
    passed = check(response, { 'expected response header': () => actual === renderTemplate(expected, context) }, tags) && passed;
  }
  const extracted = {};
  for (const [variable, path] of Object.entries(endpoint.extract ?? {})) {
    const value = validJson ? getPath(parsed, path) : undefined;
    const ok = validJson && value !== undefined && value !== null;
    passed = check(response, { 'response correlation available': () => ok }, tags) && passed;
    if (ok) extracted[variable] = value;
  }
  return { passed, extracted };
}

function executeStep(step, context) {
  const endpoint = manifest.api.endpoints[step.endpoint];
  context.endpointId = step.endpoint;
  Object.assign(context.vars, renderTemplate(step.variables ?? {}, context));
  const request = buildRequest(endpoint, manifest.environment, context);
  request.params.responseCallback = http.expectedStatuses(...request.expectedStatuses);
  const response = http.request(request.method, request.url, request.body, request.params);
  workflowRequests.add(1, { endpoint: step.endpoint });
  const result = assertResponse(response, endpoint, context);
  // Keep available correlation values for cleanup even when another assertion
  // failed. Each iteration starts fresh, so prior iterations cannot leak values.
  Object.assign(context.vars, result.extracted);
  return result.passed;
}

function chooseStep() {
  const total = steps.reduce((sum, step) => sum + (step.weight ?? manifest.api.endpoints[step.endpoint].weight ?? 1), 0);
  let position = Math.random() * total;
  for (const step of steps) {
    position -= step.weight ?? manifest.api.endpoints[step.endpoint].weight ?? 1;
    if (position < 0) return step;
  }
  return steps[steps.length - 1];
}

export default function () {
  const iteration = execution.scenario.iterationInTest;
  const dataset = manifest.suite.dataset ?? [];
  const context = {
    env: __ENV,
    vars: { ...(manifest.environment.variables ?? {}), ...(manifest.suite.variables ?? {}) },
    data: dataset.length > 0 ? dataset[iteration % dataset.length] : {},
    runtime: { uuid: uuid(), timestamp: new Date().toISOString(), vu: execution.vu.idInTest, iteration, runId: manifest.run.id },
    endpointId: '',
  };
  let failed = false;
  try {
    context.vars = renderTemplate(context.vars, context);
    const selected = manifest.suite.mode === 'weighted' ? [chooseStep()] : steps;
    for (const step of selected) {
      if (!executeStep(step, context)) { failed = true; break; }
      if (manifest.suite.thinkTime > 0) sleep(manifest.suite.thinkTime);
    }
    if (selected.length === 0) failed = true;
  } catch {
    // Exception text may contain credentials or response content. Record only
    // failure counts; do not write exception messages into logs or artifacts.
    failed = true;
    check(null, { 'request configuration and execution': () => false });
  }
  finally {
    // Execute each cleanup once, even after a failed journey. A missing
    // correlation skips that request safely and records the workflow failure.
    for (const step of cleanup) {
      try { if (!executeStep(step, context)) failed = true; }
      catch { failed = true; check(null, { 'cleanup configuration and execution': () => false }); }
    }
  }
  workflowFailed.add(failed);
  if (failed && manifest.suite.thinkTime > 0) sleep(manifest.suite.thinkTime);
}

export function handleSummary(data) {
  // k6 exposes exported options as Go-backed objects in the summary context.
  // Convert its threshold slices into ordinary JS arrays before validation.
  const thresholds = JSON.parse(JSON.stringify(options.thresholds));
  const aggregates = JSON.parse(JSON.stringify(data));
  return createSummary(aggregates, { ...manifest.run, thresholds });
}
