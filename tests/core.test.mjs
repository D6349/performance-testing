import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate, getPath, collectEnvNames } from '../src/lib/template.js';
import { buildRequest, validateRequestPath } from '../src/lib/request.js';
import { loadManifest, requiredEnvNames, validateBaseUrl } from '../src/lib/config.js';
import { buildOptions } from '../src/lib/options.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const context = { env: { API_TOKEN: 'synthetic-test-token', USER: 'tést', PASS: 'páss' }, vars: { itemId: 42 }, data: { quantity: 3, name: 'Test & sample' }, runtime: { uuid: 'test-uuid', timestamp: '2026-10-08T00:00:00Z', vu: 1, iteration: 0, runId: 'test' }, endpointId: 'readItem' };
const environment = { name: 'local', baseUrl: 'http://127.0.0.1:3000/api', allowedHosts: ['127.0.0.1'], allowHttp: true, production: false, headers: { Accept: 'application/json' }, auth: { type: 'none' }, timeout: '10s' };
const endpoint = { method: 'GET', path: '/items/{{vars.itemId}}', expect: { statuses: [200] } };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'api-perf-core-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const folder of ['config', 'payloads', 'data']) await cp(path.join(root, folder), path.join(directory, folder), { recursive: true });
  return directory;
}
async function edit(directory, relative, mutate) {
  const file = path.join(directory, relative);
  const value = JSON.parse(await readFile(file, 'utf8'));
  mutate(value);
  await writeFile(file, JSON.stringify(value));
}
test('templates preserve payload types and interpolate nested references', () => {
  assert.deepEqual(renderTemplate({ quantity: '{{data.quantity}}', items: ['{{vars.itemId}}'], label: 'item-{{vars.itemId}}' }, context), { quantity: 3, items: [42], label: 'item-42' });
  assert.equal(getPath({ items: [{ id: 7 }] }, '$.items[0].id'), 7);
  assert.equal(getPath({}, '__proto__.toString'), undefined);
  assert.deepEqual([...collectEnvNames({ a: '{{env.API_TOKEN}}', nested: ['{{env.USER}}'] })], ['API_TOKEN', 'USER']);
  assert.throws(() => renderTemplate('{{env.MISSING}}', context), /Missing template/);
  assert.throws(() => renderTemplate('{{unknown.name}}', context), /Template must use/);
  assert.throws(() => renderTemplate('{{data.name}', context), /Malformed template/);
  assert.throws(() => renderTemplate(JSON.parse('{"__proto__":{}}'), context), /Unsafe object key/);
});
test('requests encode query values and preserve configured base paths without URL metric tags', () => {
  const request = buildRequest({ ...endpoint, query: { q: '{{data.name}}', ids: [1, 2], empty: null } }, environment, context);
  assert.equal(request.url, 'http://127.0.0.1:3000/api/items/42?q=Test%20%26%20sample&ids=1&ids=2');
  assert.equal(request.params.redirects, 0);
  assert.equal(request.params.responseType, 'none');
  assert.deepEqual(request.params.tags, { endpoint: 'readItem', name: 'readItem' });
});
test('JSON and form payloads preserve scalar types and set suitable content types', () => {
  const json = buildRequest({ ...endpoint, method: 'POST', path: '/items', body: { quantity: '{{data.quantity}}' }, expect: { statuses: [201], json: [{ path: 'id', exists: true }] } }, environment, context);
  assert.deepEqual(JSON.parse(json.body), { quantity: 3 });
  assert.equal(json.params.headers['Content-Type'], 'application/json');
  assert.equal(json.params.responseType, 'text');
  const form = buildRequest({ ...endpoint, method: 'POST', path: '/items', bodyType: 'form', body: { name: '{{data.name}}', quantity: '{{data.quantity}}' } }, environment, context);
  assert.equal(form.body, 'name=Test%20%26%20sample&quantity=3');
});
test('authentication resolves only at request time and rejects header injection', () => {
  const request = buildRequest(endpoint, { ...environment, auth: { type: 'bearer', tokenEnv: 'API_TOKEN' } }, context);
  assert.equal(request.params.headers.Authorization, 'Bearer synthetic-test-token');
  const basic = buildRequest(endpoint, { ...environment, auth: { type: 'basic', usernameEnv: 'USER', passwordEnv: 'PASS' } }, context);
  assert.equal(basic.params.headers.Authorization, 'Basic ' + Buffer.from('tést:páss').toString('base64'));
  assert.throws(() => buildRequest(endpoint, { ...environment, auth: { type: 'bearer', tokenEnv: 'MISSING' } }, context), /missing/);
  assert.throws(() => buildRequest({ ...endpoint, headers: { Test: '{{env.API_TOKEN}}' } }, environment, { ...context, env: { API_TOKEN: 'secret\r\nInjected: header' } }), /Invalid request header/);
});
test('endpoint auth opt-out removes inherited credentials and permits explicit correlation headers', () => {
  const request = buildRequest({ ...endpoint, auth: { type: 'none' }, headers: { Authorization: 'Bearer {{vars.accessToken}}' } }, { ...environment, headers: { Authorization: 'inherited', Cookie: 'inherited' }, auth: { type: 'bearer', tokenEnv: 'MISSING' } }, { ...context, vars: { ...context.vars, accessToken: 'runtime-only-token' } });
  assert.equal(request.params.headers.Authorization, 'Bearer runtime-only-token');
  assert.equal(request.params.headers.Cookie, undefined);
});
test('URL policy blocks host escape, insecure external targets, user info and path traversal', () => {
  for (const value of ['http://evil.example', 'https://evil.example', 'http://user:pass@127.0.0.1:3000', 'http://127.0.0.1:3000/?token=secret']) assert.throws(() => validateBaseUrl(environment, value));
  assert.equal(validateBaseUrl(environment, 'http://127.0.0.1:4000/api/'), 'http://127.0.0.1:4000/api');
  assert.throws(() => validateBaseUrl({ ...environment, allowedHosts: ['internal.example'] }, 'http://internal.example'), /HTTPS/);
  for (const value of ['//evil.example', 'https://evil.example', '/../secret', '/%2e%2e/secret', '/items?secret=1', '/items\\..\\secret']) assert.throws(() => validateRequestPath(value));
  assert.throws(() => buildRequest(endpoint, environment, { ...context, vars: { itemId: '../secret' } }), /Unsafe/);
});
test('default configs materialize payloads and dataset with cleanup performance coverage', async () => {
  const manifest = await loadManifest({ root, env: {} });
  assert.equal(manifest.api.endpoints.createItem.body.quantity, '{{data.quantity}}');
  assert.ok(manifest.suite.dataset.length > 0);
  assert.equal(manifest.suite.cleanup[0].endpoint, 'deleteItem');
  assert.deepEqual(requiredEnvNames(manifest), []);
  const options = buildOptions(manifest);
  assert.deepEqual(options.thresholds['workflow_requests{endpoint:deleteItem}'], ['count>0']);
  assert.equal(options.insecureSkipTLSVerify, false);
  assert.equal(options.systemTags.includes('url'), false);
});
test('staging requires credentials yet serialized manifest never materializes them', async () => {
  await assert.rejects(loadManifest({ root, environment: 'staging', env: {} }), /Missing required environment variable/);
  const manifest = await loadManifest({ root, environment: 'staging', env: { API_TOKEN: 'never-persist-this-secret' } });
  assert.deepEqual(requiredEnvNames(manifest), ['API_TOKEN']);
  assert.equal(JSON.stringify(manifest).includes('never-persist-this-secret'), false);
  await assert.rejects(loadManifest({ root, environment: '../staging', env: {} }), /Invalid/);
});
test('all bundled profiles and health suite pass validation', async () => {
  for (const profile of ['smoke', 'load', 'stress', 'spike', 'soak', 'capacity']) {
    const manifest = await loadManifest({ root, profile, suite: 'health', env: {} });
    assert.equal(manifest.profile.name, profile);
  }
});
test('configuration preflight rejects misspelled fields, unsafe file paths and inline secrets', async t => {
  const directory = await fixture(t);
  await edit(directory, 'config/apis/example.json', api => { api.endpoints.health.typo = true; });
  await assert.rejects(loadManifest({ root: directory, env: {} }), /Unknown field/);
  await edit(directory, 'config/apis/example.json', api => { delete api.endpoints.health.typo; api.endpoints.createItem.bodyFile = 'payloads/../../secret.json'; });
  await assert.rejects(loadManifest({ root: directory, env: {} }), /inside the project/);
  await edit(directory, 'config/apis/example.json', api => { api.endpoints.createItem.bodyFile = 'payloads/items/create.json'; api.endpoints.health.headers = { Authorization: 'do-not-print-this-secret' }; });
  await assert.rejects(loadManifest({ root: directory, env: {} }), error => /Sensitive/.test(error.message) && !error.message.includes('do-not-print-this-secret'));
});
test('template preflight rejects unavailable journey variables, incomplete dataset and reserved env names', async t => {
  const directory = await fixture(t);
  await edit(directory, 'config/apis/example.json', api => { api.endpoints.health.path = '/health/{{vars.later}}'; });
  await assert.rejects(loadManifest({ root: directory, env: {} }), /before it is defined/);
  await edit(directory, 'config/apis/example.json', api => { api.endpoints.health.path = '/health'; api.endpoints.createItem.bodyFile = 'payloads/items/create.json'; });
  await edit(directory, 'data/items.json', rows => { delete rows[0].quantity; });
  await assert.rejects(loadManifest({ root: directory, env: {} }), /Dataset row/);
  await edit(directory, 'data/items.json', rows => { rows[0].quantity = 1; });
  await edit(directory, 'config/apis/example.json', api => { api.endpoints.health.headers = { Test: '{{env.K6_INSECURE_SKIP_TLS_VERIFY}}' }; });
  await assert.rejects(loadManifest({ root: directory, env: { K6_INSECURE_SKIP_TLS_VERIFY: 'true' } }), /reserved/);
});
test('initial variables reject self-reference and preflight rejects weighted correlation chains', async t => {
  const directory = await fixture(t);
  await edit(directory, 'config/suites/crud.json', suite => { suite.variables = { self: '{{vars.self}}' }; });
  await assert.rejects(loadManifest({ root: directory, env: {} }), /Initial variables/);
  await edit(directory, 'config/suites/crud.json', suite => { suite.variables = {}; suite.mode = 'weighted'; delete suite.cleanup; });
  await assert.rejects(loadManifest({ root: directory, env: {} }), /independent/);
});
test('invalid load values and SLO aggregate types fail before any network request', async t => {
  const directory = await fixture(t);
  await edit(directory, 'config/profiles/smoke.json', profile => { profile.scenario.vus = -1; });
  await assert.rejects(loadManifest({ root: directory, env: {} }), /positive integer/);
  await edit(directory, 'config/profiles/smoke.json', profile => { profile.scenario.vus = 1; profile.thresholds.http_req_failed = ['rate<5']; });
  await assert.rejects(loadManifest({ root: directory, env: {} }), /between zero and one/);
  await edit(directory, 'config/profiles/smoke.json', profile => { profile.thresholds.http_req_failed = ['rate<0.01']; profile.thresholds.http_req_duration = ['rate<500']; });
  await assert.rejects(loadManifest({ root: directory, env: {} }), /Invalid aggregate/);
});
test('malformed JSON errors cannot echo credential contents', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'payloads/items/create.json'), '{"password":"do-not-print-me", invalid}');
  await assert.rejects(loadManifest({ root: directory, env: {} }), error => error.message === 'Invalid JSON in payloads/items/create.json');
});
