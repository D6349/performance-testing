import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../src/lib/config.js';
import { parseArgs, prepareRun, loadLocalEnv, buildChildEnv } from '../scripts/cli.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = await Promise.all([
  'config/environments/local.json',
  'config/apis/example.json',
  'config/suites/crud.json',
  'config/profiles/smoke.json',
  'payloads/items/create.json',
  'payloads/items/update.json',
  'data/items.json',
].map(async relative => [relative, await readFile(path.join(project, relative), 'utf8')]));

async function fixture(mutate, body, { environment = 'local', env = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'perf-review-'));
  const baseline = Object.fromEntries(sources.map(([relative, content]) => [relative, JSON.parse(content)]));
  const model = {
    environment: baseline['config/environments/local.json'],
    api: baseline['config/apis/example.json'],
    suite: baseline['config/suites/crud.json'],
    profile: baseline['config/profiles/smoke.json'],
  };
  model.environment.name = environment;
  try {
    mutate(model);
    const files = {
      ...Object.fromEntries(sources),
      ['config/environments/' + environment + '.json']: JSON.stringify(model.environment),
      'config/apis/example.json': JSON.stringify(model.api),
      'config/suites/crud.json': JSON.stringify(model.suite),
      'config/profiles/smoke.json': JSON.stringify(model.profile),
    };
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await body({
      root,
      load: () => loadManifest({ root, environment, api: 'example', suite: 'crud', profile: 'smoke', env }),
    });
  } finally {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep), 'Cleanup must stay within the temporary directory.');
    await rm(resolved, { recursive: true, force: true });
  }
}

test('preflight rejects query and form fields that cannot be encoded', async () => {
  for (const field of [{ nested: true }, [{ nested: true }]]) {
    await fixture(model => { model.api.endpoints.readItem.query = { filter: field }; },
      async ({ load }) => { await assert.rejects(load(), /scalar|query|field/i); });
    await fixture(model => {
      const endpoint = model.api.endpoints.createItem;
      delete endpoint.bodyFile;
      endpoint.bodyType = 'form';
      endpoint.body = { filter: field };
    }, async ({ load }) => { await assert.rejects(load(), /scalar|form|field/i); });
  }
  await fixture(model => { model.api.endpoints.readItem.query = { filter: ['sample', 1, true, null] }; },
    async ({ load }) => { await load(); });
});

test('defined invalid optional durations cannot silently become defaults', async () => {
  for (const invalid of ['', false, 0, null]) {
    await fixture(model => { model.environment.timeout = invalid; },
      async ({ load }) => { await assert.rejects(load(), /duration|timeout/i); });
    await fixture(model => { model.profile.scenario.gracefulStop = invalid; },
      async ({ load }) => { await assert.rejects(load(), /duration|gracefulStop/i); });
  }
});

test('defined invalid endpoint SLOs cannot silently fall back to global gates', async () => {
  for (const field of ['duration', 'failed']) {
    for (const invalid of ['', false, 0, null]) {
      await fixture(model => { model.api.endpoints.readItem.thresholds = { [field]: invalid }; },
        async ({ load }) => { await assert.rejects(load(), /threshold|array/i); });
    }
  }
});

test('sensitive payload and variables accept exact references but reject literal credential fragments', async () => {
  for (const value of ['literal-secret{{env.API_PASSWORD}}', '{{env.API_PASSWORD}}literal-secret']) {
    await fixture(model => {
      const endpoint = model.api.endpoints.createItem;
      delete endpoint.bodyFile;
      endpoint.body = { password: value };
    }, async ({ load }) => { await assert.rejects(load(), /sensitive|reference|credential/i); },
    { env: { API_PASSWORD: 'synthetic-password' } });
    await fixture(model => { model.suite.variables = { password: value }; },
      async ({ load }) => { await assert.rejects(load(), /sensitive|reference|credential/i); },
      { env: { API_PASSWORD: 'synthetic-password' } });
  }
  await fixture(model => {
    const endpoint = model.api.endpoints.createItem;
    delete endpoint.bodyFile;
    endpoint.body = { password: '{{env.API_PASSWORD}}' };
  }, async ({ load }) => { await load(); }, { env: { API_PASSWORD: 'synthetic-password' } });
});

test('authorization headers accept approved reference prefixes and reject embedded literals', async () => {
  await fixture(model => {
    model.api.endpoints.readItem.headers = { Authorization: 'Bearer literal-secret{{env.API_TOKEN}}' };
  }, async ({ load }) => { await assert.rejects(load(), /sensitive|reference|credential/i); },
  { env: { API_TOKEN: 'synthetic-token' } });
  await fixture(model => {
    model.api.endpoints.readItem.auth = { type: 'none' };
    model.api.endpoints.readItem.headers = { Authorization: 'Bearer {{vars.itemId}}' };
  }, async ({ load }) => { await load(); });
});

test('referenced engine networking and certificate variables remain forbidden', async () => {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GODEBUG']) {
    await fixture(model => { model.environment.auth = { type: 'bearer', tokenEnv: name }; },
      async ({ load }) => { await assert.rejects(load(), /reserved|runtime|invalid.*environment/i); },
      { env: { [name]: 'synthetic-value' } });
    assert.throws(() => buildChildEnv({ [name]: 'synthetic-value' }, [name], 'manifest.json'), /reserved|runtime|invalid.*environment/i);
  }
});

test('dotenv runtime keys reject PATH hijacking without leaking values', async () => {
  await fixture(() => {}, async ({ root }) => {
    await writeFile(path.join(root, '.env'), 'PATH=synthetic-hijack-path\n');
    try {
      await loadLocalEnv(root, 'local', { Path: 'trusted-process-path' });
      assert.fail('A dotenv PATH override must be rejected.');
    } catch (error) {
      assert.match(error.message, /reserved|runtime|control/i);
      assert.ok(!error.message.includes('synthetic-hijack-path'));
    }
  });
});

test('dotenv cannot disable a production environment execution guard', async () => {
  await fixture(model => {
    model.environment.baseUrl = 'https://api.example.invalid';
    model.environment.allowedHosts = ['api.example.invalid'];
    model.environment.production = true;
    model.environment.allowHttp = false;
    model.environment.auth = { type: 'bearer', tokenEnv: 'API_TOKEN' };
  }, async ({ root }) => {
    await writeFile(path.join(root, '.env'), 'API_TOKEN=synthetic-production-token\nPRODUCTION=false\nALLOW_PRODUCTION=true\n');
    const options = parseArgs(['run', '--env', 'production']);
    await assert.rejects(prepareRun(options, { root, ambient: {}, persist: false }), /production.*protect|allow-production/i);
  }, { environment: 'production' });
});

test('runtime credential values never enter a persisted execution manifest', async () => {
  const secret = 'synthetic-review-token-not-real';
  await fixture(model => { model.environment.auth = { type: 'bearer', tokenEnv: 'API_TOKEN' }; },
    async ({ root }) => {
      const prepared = await prepareRun(parseArgs(['run']), { root, ambient: { API_TOKEN: secret }, persist: true });
      const stored = await readFile(prepared.manifestPath, 'utf8');
      assert.ok(!stored.includes(secret));
      assert.equal(JSON.parse(stored).environment.auth.tokenEnv, 'API_TOKEN');
    });
});
