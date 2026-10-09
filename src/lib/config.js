import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { collectEnvNames, getPath } from './template.js';
import { validateRequestPath } from './request.js';
import { isRuntimeControlEnvName } from './env.js';

const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const envPattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|password|passwd|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret)$/i;
const durationPattern = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/;
const placeholders = /\{\{\s*((?:env|vars|data|runtime)\.[\w-]+(?:\.[\w-]+|\[\d+\])*)\s*\}\}/g;
const runtimeNames = new Set(['uuid', 'timestamp', 'vu', 'iteration', 'runId']);
const knownMetrics = new Set(['http_req_duration', 'http_req_failed', 'checks', 'workflow_failed', 'workflow_requests', 'dropped_iterations']);

function ensure(condition, message) { if (!condition) throw new Error(message); }
function object(value, label) {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), label + ' must be an object');
}
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) ensure(allowed.includes(key), 'Unknown field in ' + label + ': ' + key);
}
function identifier(value, label) { ensure(typeof value === 'string' && idPattern.test(value), 'Invalid ' + label); }
function envName(value) {
  ensure(typeof value === 'string' && envPattern.test(value) && !isRuntimeControlEnvName(value), 'Invalid or reserved environment variable reference');
}
function safeTree(value, depth = 0) {
  ensure(depth <= 32, 'Configuration nesting exceeds 32 levels');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      ensure(!forbidden.has(key), 'Unsafe configuration object key');
      safeTree(child, depth + 1);
    }
  }
}
function secretReferences(value, label) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitive.test(key) && child !== null && child !== '') {
      const reference = /^\{\{\s*(?:env\.[A-Z][A-Z0-9_]*|vars\.[\w-]+)\s*\}\}$/;
      const authorization = /^(?:Bearer|Basic|Token|ApiKey) \{\{\s*(?:env\.[A-Z][A-Z0-9_]*|vars\.[\w-]+)\s*\}\}$/;
      ensure(typeof child === 'string' && (reference.test(child) || key.toLowerCase() === 'authorization' && authorization.test(child)), 'Sensitive ' + label + ' values must use a complete environment or correlation reference');
    }
    secretReferences(child, label);
  }
}
function duration(value, label, limit = 86400000) {
  ensure(typeof value === 'string' && durationPattern.test(value), label + ' must be a duration such as 30s or 2m');
  const milliseconds = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)]
    .reduce((sum, match) => sum + Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]], 0);
  ensure(milliseconds > 0 && milliseconds <= limit, label + ' is outside the supported duration range');
  return milliseconds;
}
function positiveInteger(value, label, max = 1000000) {
  ensure(Number.isSafeInteger(value) && value > 0 && value <= max, label + ' must be a positive integer within limits');
}
function auth(value, label) {
  keys(value, ['type', 'tokenEnv', 'keyEnv', 'header', 'usernameEnv', 'passwordEnv'], label);
  ensure(['none', 'bearer', 'api-key', 'basic'].includes(value.type), 'Unsupported authentication type');
  const fields = { none: [], bearer: ['tokenEnv'], 'api-key': ['keyEnv', 'header'], basic: ['usernameEnv', 'passwordEnv'] }[value.type];
  ensure(Object.keys(value).every(key => key === 'type' || fields.includes(key)), 'Unexpected authentication field');
  if (value.type === 'bearer') envName(value.tokenEnv);
  if (value.type === 'api-key') {
    envName(value.keyEnv);
    if (value.header !== undefined) ensure(typeof value.header === 'string' && /^[\w-]+$/.test(value.header) && !/^(host|content-length|proxy-authorization)$/i.test(value.header), 'Invalid API key header');
  }
  if (value.type === 'basic') { envName(value.usernameEnv); envName(value.passwordEnv); }
}
function headers(value, label) {
  object(value, label);
  secretReferences(value, label);
  for (const [key, child] of Object.entries(value)) {
    ensure(/^[!#$%&'*+.^_`|~\w-]+$/.test(key) && !/^(host|content-length|proxy-authorization)$/i.test(key), 'Invalid or managed request header');
    ensure(typeof child === 'string' && !/[\r\n\u0000]/.test(child), 'Invalid header value');
  }
}
function scalarFields(value, label) {
  object(value, label);
  secretReferences(value, label);
  for (const child of Object.values(value)) {
    const values = Array.isArray(child) ? child : [child];
    ensure(values.every(item => item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)), label + ' fields must be scalar values or arrays of scalars');
  }
}
function dottedPath(value) {
  ensure(typeof value === 'string' && /^(?:\$|\$\.?[\w-]+(?:\.[\w-]+|\[\d+\])*|[\w-]+(?:\.[\w-]+|\[\d+\])*)$/.test(value), 'Invalid response JSON path');
  ensure(!value.replace(/\[(\d+)\]/g, '.$1').split('.').some(part => forbidden.has(part)), 'Unsafe response JSON path');
}
function thresholds(value, kind) {
  ensure(Array.isArray(value) && value.length > 0 && value.length <= 20, 'Thresholds must be a nonempty array');
  for (const entry of value) {
    let expression = entry;
    if (typeof entry === 'object') {
      keys(entry, ['threshold', 'abortOnFail', 'delayAbortEval'], 'threshold');
      ensure(typeof entry.abortOnFail === 'boolean', 'abortOnFail must be boolean');
      if (entry.delayAbortEval !== undefined) duration(entry.delayAbortEval, 'delayAbortEval', 600000);
      expression = entry.threshold;
    }
    ensure(typeof expression === 'string' && /^(?:avg|min|max|med|count|rate|p\((?:\d+(?:\.\d+)?)\))\s*(?:<=|>=|==|<|>)\s*\d+(?:\.\d+)?$/.test(expression), 'Invalid threshold expression');
    const aggregate = expression.match(/^[\w]+(?:\([\d.]+\))?/)[0];
    const expected = kind === 'duration' ? ['avg', 'min', 'max', 'med'] : kind === 'rate' ? ['rate'] : ['count', 'rate'];
    ensure(expected.includes(aggregate) || kind === 'duration' && /^p\([\d.]+\)$/.test(aggregate) && Number(aggregate.slice(2, -1)) <= 100, 'Invalid aggregate for metric threshold');
    if (kind === 'rate') ensure(Number(expression.match(/\d+(?:\.\d+)?$/)[0]) <= 1, 'Rate thresholds must be between zero and one');
  }
}

async function readProjectFile(root, relative, requiredPrefix) {
  ensure(typeof relative === 'string' && !relative.includes('\\') && !path.isAbsolute(relative) && !relative.split('/').some(part => part === '.' || part === '..'), 'File paths must stay inside the project');
  if (requiredPrefix) ensure(relative.startsWith(requiredPrefix + '/'), 'File reference must be under ' + requiredPrefix);
  const absolute = path.resolve(root, relative);
  const realRoot = await realpath(root);
  let resolved;
  try { resolved = await realpath(absolute); } catch { throw new Error('Project file was not found: ' + relative); }
  const difference = path.relative(realRoot, resolved);
  ensure(difference && !difference.startsWith('..') && !path.isAbsolute(difference), 'File reference leaves the project');
  const metadata = await stat(resolved);
  ensure(metadata.isFile() && metadata.size <= 2 * 1024 * 1024, 'Project file must be a regular file smaller than 2 MiB');
  return readFile(resolved, 'utf8');
}
async function readJson(root, relative, prefix) {
  const content = await readProjectFile(root, relative, prefix);
  let value;
  try { value = JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw new Error('Invalid JSON in ' + relative); }
  safeTree(value);
  return value;
}

export function validateBaseUrl(environment, override) {
  const value = override === undefined ? environment.baseUrl : override;
  ensure(typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\s\\\u0000-\u001f]/.test(value), 'Invalid API base URL');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid API base URL'); }
  ensure(['https:', 'http:'].includes(url.protocol), 'Only HTTP and HTTPS API URLs are supported');
  ensure(!url.username && !url.password && !url.search && !url.hash, 'Base URL cannot contain credentials, query, or fragment');
  ensure(Array.isArray(environment.allowedHosts) && environment.allowedHosts.length > 0 &&
    environment.allowedHosts.every(host => typeof host === 'string' && /^[a-z0-9.[\]:-]+$/i.test(host) && host === host.toLowerCase()), 'allowedHosts must list exact lowercase hostnames');
  ensure(environment.allowedHosts.includes(url.hostname.toLowerCase()), 'API host is outside the environment allowlist');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  ensure(url.protocol === 'https:' || environment.allowHttp === true && loopback && !environment.production, 'HTTPS is required outside the local loopback environment');
  return url.href.replace(/\/$/, '');
}

function validateEnvironment(environment, requested, env) {
  keys(environment, ['name', 'baseUrl', 'allowedHosts', 'allowHttp', 'production', 'headers', 'auth', 'timeout', 'variables'], 'environment');
  ensure(environment.name === requested, 'Environment name must match its file name');
  ensure(typeof environment.production === 'boolean' && typeof environment.allowHttp === 'boolean', 'production and allowHttp must be booleans');
  // A file named production cannot silently disable the production execution guard.
  ensure(requested !== 'production' || environment.production, 'The production environment must enable its production guard');
  environment.baseUrl = validateBaseUrl(environment, env.BASE_URL || undefined);
  headers(environment.headers || {}, 'environment headers');
  auth(environment.auth || { type: 'none' }, 'environment auth');
  duration(environment.timeout === undefined ? '10s' : environment.timeout, 'Request timeout', 120000);
  object(environment.variables || {}, 'environment variables');
  secretReferences(environment.variables, 'variables');
}
function validateEndpoint(endpoint, id) {
  keys(endpoint, ['method', 'path', 'query', 'headers', 'body', 'bodyFile', 'bodyType', 'auth', 'timeout', 'expect', 'extract', 'weight', 'enabled', 'thresholds'], 'endpoint ' + id);
  ensure(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(endpoint.method), 'Unsupported HTTP method in endpoint ' + id);
  ensure(typeof endpoint.path === 'string', 'Endpoint requires a path');
  validateRequestPath(endpoint.path.replace(placeholders, 'template'));
  if (endpoint.query !== undefined) scalarFields(endpoint.query, 'endpoint query');
  if (endpoint.headers !== undefined) headers(endpoint.headers, 'endpoint headers');
  if (endpoint.auth !== undefined) auth(endpoint.auth, 'endpoint auth');
  if (endpoint.timeout !== undefined) duration(endpoint.timeout, 'Request timeout', 120000);
  if (endpoint.enabled !== undefined) ensure(typeof endpoint.enabled === 'boolean', 'enabled must be boolean');
  if (endpoint.weight !== undefined) positiveInteger(endpoint.weight, 'Endpoint weight');
  if (endpoint.bodyType !== undefined) ensure(['json', 'form', 'text'].includes(endpoint.bodyType), 'Unsupported bodyType');
  ensure(!(endpoint.body !== undefined && endpoint.bodyFile !== undefined), 'Use body or bodyFile for an endpoint');
  if (endpoint.body !== undefined || endpoint.bodyFile !== undefined) ensure(!['GET', 'HEAD'].includes(endpoint.method), 'GET and HEAD endpoints cannot have request bodies');
  if (endpoint.body !== undefined) {
    secretReferences(endpoint.body, 'payload');
    if (endpoint.bodyType === 'text') ensure(typeof endpoint.body === 'string', 'Text payload must be a string');
    if (endpoint.bodyType === 'form') scalarFields(endpoint.body, 'Form payload');
  }
  keys(endpoint.expect, ['statuses', 'json', 'headers'], 'endpoint expectations');
  ensure(Array.isArray(endpoint.expect.statuses) && endpoint.expect.statuses.length > 0 &&
    endpoint.expect.statuses.every(status => Number.isInteger(status) && status >= 100 && status <= 599), 'Expected statuses must be HTTP status codes');
  if (endpoint.expect.json !== undefined) {
    ensure(Array.isArray(endpoint.expect.json), 'JSON expectations must be an array');
    for (const assertion of endpoint.expect.json) {
      keys(assertion, ['path', 'exists', 'equals'], 'JSON assertion');
      dottedPath(assertion.path);
      ensure(Object.hasOwn(assertion, 'equals') || typeof assertion.exists === 'boolean', 'JSON assertion requires equals or exists');
      if (assertion.exists !== undefined) ensure(typeof assertion.exists === 'boolean', 'exists must be boolean');
    }
  }
  if (endpoint.expect.headers !== undefined) {
    object(endpoint.expect.headers, 'expected headers');
    ensure(Object.values(endpoint.expect.headers).every(value => typeof value === 'string'), 'Expected headers must be strings');
  }
  if (endpoint.extract !== undefined) {
    object(endpoint.extract, 'response extraction');
    for (const [key, jsonPath] of Object.entries(endpoint.extract)) { identifier(key, 'extracted variable name'); dottedPath(jsonPath); }
  }
  if (endpoint.thresholds !== undefined) {
    keys(endpoint.thresholds, ['duration', 'failed'], 'endpoint thresholds');
    if (endpoint.thresholds.duration !== undefined) thresholds(endpoint.thresholds.duration, 'duration');
    if (endpoint.thresholds.failed !== undefined) thresholds(endpoint.thresholds.failed, 'rate');
  }
}
function validateSuite(suite, requested, api) {
  keys(suite, ['name', 'mode', 'steps', 'cleanup', 'variables', 'dataset', 'datasetFile', 'thinkTime'], 'suite');
  ensure(suite.name === requested, 'Suite name must match its file name');
  ensure(['journey', 'weighted'].includes(suite.mode), 'Suite mode must be journey or weighted');
  ensure(Array.isArray(suite.steps) && suite.steps.length > 0 && suite.steps.length <= 100, 'Suite requires between 1 and 100 steps');
  if (suite.cleanup !== undefined) ensure(suite.mode === 'journey' && Array.isArray(suite.cleanup) && suite.cleanup.length <= 100, 'Cleanup requires a journey suite and an array of steps');
  for (const step of [...suite.steps, ...(suite.cleanup || [])]) {
    keys(step, ['endpoint', 'variables', 'weight'], 'suite step');
    identifier(step.endpoint, 'step endpoint');
    ensure(api.endpoints[step.endpoint] && api.endpoints[step.endpoint].enabled !== false, 'Suite references missing or disabled endpoint: ' + step.endpoint);
    if (step.weight !== undefined) positiveInteger(step.weight, 'Step weight');
    object(step.variables || {}, 'step variables');
    secretReferences(step.variables, 'step variables');
    if (suite.mode === 'weighted') ensure(!Object.keys(api.endpoints[step.endpoint].extract || {}).length, 'Weighted endpoints must be independent and cannot extract journey variables');
  }
  object(suite.variables || {}, 'suite variables');
  secretReferences(suite.variables, 'suite variables');
  if (suite.thinkTime !== undefined) ensure(Number.isFinite(suite.thinkTime) && suite.thinkTime >= 0 && suite.thinkTime <= 60, 'thinkTime must be seconds between zero and 60');
  ensure(!(suite.dataset !== undefined && suite.datasetFile !== undefined), 'Use dataset or datasetFile');
}
function validateProfile(profile, requested) {
  keys(profile, ['name', 'scenario', 'thresholds'], 'profile');
  ensure(profile.name === requested, 'Profile name must match its file name');
  const scenario = profile.scenario;
  const common = ['executor', 'gracefulStop'];
  const extras = {
    'shared-iterations': ['vus', 'iterations', 'maxDuration'],
    'constant-vus': ['vus', 'duration'],
    'ramping-vus': ['startVUs', 'stages', 'gracefulRampDown'],
    'constant-arrival-rate': ['rate', 'timeUnit', 'duration', 'preAllocatedVUs', 'maxVUs'],
    'ramping-arrival-rate': ['startRate', 'timeUnit', 'stages', 'preAllocatedVUs', 'maxVUs']
  };
  object(scenario, 'load scenario');
  ensure(Object.hasOwn(extras, scenario.executor), 'Unsupported load executor');
  keys(scenario, [...common, ...extras[scenario.executor]], 'load scenario');
  if (scenario.gracefulStop !== undefined) duration(scenario.gracefulStop, 'gracefulStop', 600000);
  for (const key of ['vus', 'iterations', 'rate', 'preAllocatedVUs', 'maxVUs']) if (scenario[key] !== undefined) positiveInteger(scenario[key], key, key.toLowerCase().includes('vu') ? 1000 : 10000000);
  for (const key of ['startVUs', 'startRate']) if (scenario[key] !== undefined) ensure(Number.isSafeInteger(scenario[key]) && scenario[key] >= 0 && scenario[key] <= 1000, 'Invalid ' + key);
  for (const key of ['duration', 'maxDuration', 'timeUnit', 'gracefulRampDown']) if (scenario[key] !== undefined) duration(scenario[key], key, key === 'timeUnit' ? 3600000 : 86400000);
  if (scenario.executor === 'shared-iterations') { positiveInteger(scenario.vus, 'vus', 1000); positiveInteger(scenario.iterations, 'iterations', 10000000); ensure(scenario.iterations >= scenario.vus, 'iterations must be at least vus'); duration(scenario.maxDuration, 'maxDuration'); }
  if (scenario.executor === 'constant-vus') { positiveInteger(scenario.vus, 'vus', 1000); duration(scenario.duration, 'duration'); }
  if (scenario.executor.includes('arrival-rate')) {
    positiveInteger(scenario.preAllocatedVUs, 'preAllocatedVUs', 1000);
    positiveInteger(scenario.maxVUs, 'maxVUs', 1000);
    ensure(scenario.maxVUs >= scenario.preAllocatedVUs, 'maxVUs must be at least preAllocatedVUs');
    duration(scenario.timeUnit, 'timeUnit', 3600000);
    if (scenario.executor === 'constant-arrival-rate') { positiveInteger(scenario.rate, 'rate', 10000000); duration(scenario.duration, 'duration'); }
    else ensure(Number.isSafeInteger(scenario.startRate) && scenario.startRate >= 0, 'startRate is required');
  }
  if (scenario.executor.startsWith('ramping-')) {
    ensure(Array.isArray(scenario.stages) && scenario.stages.length > 0 && scenario.stages.length <= 100, 'Ramping scenarios require stages');
    let total = 0;
    for (const stage of scenario.stages) {
      keys(stage, ['duration', 'target'], 'load stage');
      total += duration(stage.duration, 'Stage duration');
      ensure(Number.isSafeInteger(stage.target) && stage.target >= 0 && stage.target <= (scenario.executor === 'ramping-vus' ? 1000 : 10000000), 'Invalid stage target');
    }
    ensure(total <= 86400000, 'Total stage duration cannot exceed 24 hours');
  }
  object(profile.thresholds, 'profile thresholds');
  for (const [metric, expressions] of Object.entries(profile.thresholds)) {
    ensure(knownMetrics.has(metric), 'Unsupported threshold metric');
    thresholds(expressions, metric === 'http_req_duration' ? 'duration' : ['http_req_failed', 'checks', 'workflow_failed'].includes(metric) ? 'rate' : 'counter');
  }
  for (const required of ['http_req_duration', 'http_req_failed', 'checks', 'workflow_failed', 'workflow_requests']) ensure(profile.thresholds[required], 'Missing required threshold: ' + required);
  if (scenario.executor.includes('arrival-rate')) ensure(profile.thresholds.dropped_iterations, 'Arrival rate profiles must check dropped_iterations');
  else ensure(!profile.thresholds.dropped_iterations, 'dropped_iterations threshold requires an arrival rate executor');
}
function scanTemplates(value, visit) {
  if (typeof value === 'string') {
    const remainder = value.replace(placeholders, (_, reference) => { visit(reference); return ''; });
    ensure(!remainder.includes('{{') && !remainder.includes('}}'), 'Malformed or unsupported template reference');
  } else if (value && typeof value === 'object') Object.values(value).forEach(child => scanTemplates(child, visit));
}
function validateTemplates(manifest, env) {
  const initial = { ...(manifest.environment.variables || {}), ...(manifest.suite.variables || {}) };
  const rows = manifest.suite.dataset || [{}];
  const visit = available => reference => {
    const [namespace, ...parts] = reference.split('.');
    const field = parts.join('.');
    if (namespace === 'env') { envName(field); ensure(typeof env[field] === 'string' && env[field].length > 0, 'Missing required environment variable: ' + field); }
    if (namespace === 'runtime') ensure(runtimeNames.has(field), 'Unknown runtime template field');
    if (namespace === 'vars') ensure(getPath(available, field) !== undefined, 'Template uses a variable before it is defined: ' + field);
    if (namespace === 'data') ensure(rows.every(row => getPath(row, field) !== undefined && getPath(row, field) !== null), 'Dataset row is missing a template field: ' + field);
  };
  // Environment variables are request defaults; inspect only request-related fields.
  scanTemplates(initial, reference => {
    ensure(!reference.startsWith('vars.'), 'Initial variables must use env, data, or runtime references');
    visit(initial)(reference);
  });
  scanTemplates(manifest.environment.headers || {}, visit(initial));
  let available = { ...initial };
  for (const step of [...manifest.suite.steps, ...(manifest.suite.cleanup || [])]) {
    if (manifest.suite.mode === 'weighted') available = { ...initial };
    scanTemplates(step.variables || {}, visit(available));
    available = { ...available, ...(step.variables || {}) };
    const endpoint = manifest.api.endpoints[step.endpoint];
    scanTemplates(endpoint, visit(available));
    for (const key of Object.keys(endpoint.extract || {})) available[key] = true;
  }
}
export function requiredEnvNames(manifest) {
  const names = collectEnvNames({ environment: manifest.environment, suite: manifest.suite });
  for (const step of [...manifest.suite.steps, ...(manifest.suite.cleanup || [])]) {
    const endpoint = manifest.api.endpoints[step.endpoint];
    collectEnvNames(endpoint, names);
    const chosen = endpoint.auth || manifest.environment.auth;
    for (const key of ['tokenEnv', 'keyEnv', 'usernameEnv', 'passwordEnv']) if (chosen?.[key]) names.add(chosen[key]);
  }
  for (const name of names) envName(name);
  return [...names].sort();
}

export async function loadManifest({ root, environment = 'local', api = 'example', suite = 'crud', profile = 'smoke', env = process.env }) {
  for (const [label, selected] of Object.entries({ environment, api, suite, profile })) identifier(selected, label + ' selector');
  const [environmentConfig, apiConfig, suiteConfig, profileConfig] = await Promise.all([
    readJson(root, 'config/environments/' + environment + '.json'),
    readJson(root, 'config/apis/' + api + '.json'),
    readJson(root, 'config/suites/' + suite + '.json'),
    readJson(root, 'config/profiles/' + profile + '.json')
  ]);
  validateEnvironment(environmentConfig, environment, env);
  keys(apiConfig, ['name', 'endpoints'], 'API');
  ensure(apiConfig.name === api, 'API name must match its file name');
  object(apiConfig.endpoints, 'API endpoints');
  ensure(Object.keys(apiConfig.endpoints).length > 0 && Object.keys(apiConfig.endpoints).length <= 500, 'API requires between 1 and 500 endpoints');
  for (const [id, endpoint] of Object.entries(apiConfig.endpoints)) {
    identifier(id, 'endpoint identifier');
    validateEndpoint(endpoint, id);
    if (endpoint.bodyFile !== undefined) {
      endpoint.body = endpoint.bodyType === 'text'
        ? await readProjectFile(root, endpoint.bodyFile, 'payloads')
        : await readJson(root, endpoint.bodyFile, 'payloads');
      delete endpoint.bodyFile;
      secretReferences(endpoint.body, 'payload');
      if (endpoint.bodyType === 'form') scalarFields(endpoint.body, 'Form payload');
    }
  }
  validateSuite(suiteConfig, suite, apiConfig);
  if (suiteConfig.datasetFile !== undefined) {
    suiteConfig.dataset = await readJson(root, suiteConfig.datasetFile, 'data');
    delete suiteConfig.datasetFile;
  }
  if (suiteConfig.dataset !== undefined) {
    ensure(Array.isArray(suiteConfig.dataset) && suiteConfig.dataset.length > 0 && suiteConfig.dataset.length <= 100000, 'Dataset must be a nonempty bounded JSON array');
    for (const row of suiteConfig.dataset) { object(row, 'Dataset row'); secretReferences(row, 'dataset'); }
  }
  validateProfile(profileConfig, profile);
  const selected = new Set([...suiteConfig.steps, ...(suiteConfig.cleanup || [])].map(step => step.endpoint));
  // Only selected endpoint definitions enter the execution manifest.
  apiConfig.endpoints = Object.fromEntries(Object.entries(apiConfig.endpoints).filter(([id]) => selected.has(id)));
  const manifest = { schemaVersion: 1, environment: environmentConfig, api: apiConfig, suite: suiteConfig, profile: profileConfig };
  validateTemplates(manifest, env);
  for (const name of requiredEnvNames(manifest)) ensure(typeof env[name] === 'string' && env[name].length > 0, 'Missing required environment variable: ' + name);
  return manifest;
}
