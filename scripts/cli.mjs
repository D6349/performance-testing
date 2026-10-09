#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadManifest, requiredEnvNames } from '../src/lib/config.js';
import { isRuntimeControlEnvName } from '../src/lib/env.js';
import { writeExcelReport } from '../src/lib/excel-report.js';
import { createResultRun, finalizeResultRun } from '../src/lib/results.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELECTORS = new Map([['--env', 'environment'], ['--api', 'api'], ['--suite', 'suite'], ['--profile', 'profile']]);
const SAFE_NAME = /^[a-z][a-z0-9_-]{0,63}$/i;
const USAGE = [
  'API performance testing', '',
  '  npm run validate -- --env local --api example --suite crud --profile smoke',
  '  npm run perf -- --env local --api example --suite crud --profile smoke',
  '  npm run perf -- --dry-run',
  '  npm run list',
  '  npm run demo', '',
  'Selectors: --env, --api, --suite, --profile',
  'Run options: --dry-run, --allow-production',
  'Endpoint, payload and load settings belong in configuration files.',
  'Secrets belong in environment variables or ignored local .env files.',
].join('\n');

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? 'help';
  if (['run', 'validate'].includes(command) && args.length === 1 && ['--help', '-h'].includes(args[0])) return { command: 'help' };
  if (command === '--help' || command === '-h' || command === 'help') {
    if (args.length) throw new Error('Help does not accept options.');
    return { command: 'help' };
  }
  if (!['run', 'validate', 'list'].includes(command)) throw new Error('Unknown command. Use run, validate or list.');
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { command: 'help' };
  const options = { command, environment: 'local', api: 'example', suite: 'crud', profile: 'smoke', dryRun: false, allowProduction: false };
  const seen = new Set();
  while (args.length) {
    const arg = args.shift();
    if (seen.has(arg)) throw new Error('Duplicate command option.');
    seen.add(arg);
    if (SELECTORS.has(arg)) {
      const value = args.shift();
      if (!value || !SAFE_NAME.test(value)) throw new Error('Configuration names must start with a letter and contain only letters, numbers, hyphens or underscores.');
      options[SELECTORS.get(arg)] = value;
    } else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-production') options.allowProduction = true;
    else throw new Error('Unknown command option. Arbitrary k6 flags are intentionally unsupported.');
  }
  if (command !== 'run' && options.dryRun) throw new Error('--dry-run is available only with run.');
  if (command === 'list' && seen.size) throw new Error('list does not accept selectors or run options.');
  return options;
}

// Deliberately no interpolation, shell evaluation or multiline values.
export function parseEnvFile(source) {
  const result = Object.create(null);
  for (const [index, raw] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error('Invalid environment-file syntax on line ' + (index + 1) + '.');
    const [, key, rawValue] = match;
    if (Object.hasOwn(result, key)) throw new Error('Duplicate environment-file key on line ' + (index + 1) + '.');
    let value;
    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      const quote = rawValue[0];
      const end = rawValue.lastIndexOf(quote);
      if (end === 0 || !/^\s*(?:#.*)?$/.test(rawValue.slice(end + 1))) throw new Error('Invalid quoted environment value on line ' + (index + 1) + '.');
      value = rawValue.slice(1, end);
      // Backslashes are literal, preserving Windows paths.
      if (value.includes(quote)) throw new Error('Embedded quotes are unsupported on environment-file line ' + (index + 1) + '.');
    } else value = rawValue.replace(/\s+#.*$/, '').trim();
    if (value.includes('\0')) throw new Error('Invalid environment value on line ' + (index + 1) + '.');
    result[key] = value;
  }
  return result;
}

export async function loadLocalEnv(root, environment, ambient = process.env) {
  if (!SAFE_NAME.test(environment)) throw new Error('Invalid environment name.');
  const fileValues = Object.create(null);
  for (const name of ['.env', '.env.' + environment + '.local']) {
    try {
      const values = parseEnvFile(await readFile(path.join(root, name), 'utf8'));
      if (Object.keys(values).some(isRuntimeControlEnvName)) throw new Error('Environment files cannot configure reserved runtime or OS variables.');
      Object.assign(fileValues, values);
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { ...fileValues, ...ambient };
}

const OS_ENV_NAMES = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'home', 'userprofile', 'homedrive', 'homepath', 'tmp', 'temp', 'tmpdir', 'lang', 'lc_all', 'lc_ctype', 'term', 'colorterm', 'no_color', 'force_color']);
export function buildChildEnv(env, referencedNames, manifestPath) {
  const child = Object.create(null);
  for (const [name, value] of Object.entries(env)) {
    if (OS_ENV_NAMES.has(name.toLowerCase()) && value !== undefined) child[name] = String(value);
  }
  for (const name of referencedNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || isRuntimeControlEnvName(name)) throw new Error('Reserved or invalid environment variable reference.');
    if (env[name] === undefined || env[name] === '') throw new Error('Required environment variable is missing: ' + name);
    child[name] = String(env[name]);
  }
  child.PERF_MANIFEST = manifestPath;
  child.K6_NO_USAGE_REPORT = 'true';
  return child;
}

export function redact(text, values = []) {
  let safe = String(text);
  const variants = new Set();
  for (const value of values) {
    if (!value) continue;
    variants.add(String(value));
    variants.add(encodeURIComponent(String(value)));
  }
  for (const value of [...variants].sort((a, b) => b.length - a.length)) safe = safe.split(value).join('[REDACTED]');
  return safe.replace(/https?:\/\/[^\s\x1b"'<>]+/gi, '[REDACTED_URL]');
}

export async function prepareRun(options, { root = projectRoot, ambient = process.env, persist = false } = {}) {
  const env = await loadLocalEnv(root, options.environment, ambient);
  const manifest = await loadManifest({ root, environment: options.environment, api: options.api, suite: options.suite, profile: options.profile, env });
  if (manifest.environment.production && !options.allowProduction) throw new Error('Production is protected. Supply --allow-production only after approving this test load.');
  const names = requiredEnvNames(manifest);
  buildChildEnv(env, names, 'validation-only');
  let manifestPath;
  if (persist) {
    if (Buffer.byteLength(JSON.stringify(manifest, null, 2), 'utf8') > 64 * 1024 * 1024 - 64 * 1024) throw new Error('The combined execution manifest exceeds the 64 MiB limit.');
    const startedAt = new Date();
    const id = startedAt.toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
    manifest.run = await createResultRun({ root, startedAt, run: { id, environment: options.environment, api: options.api, suite: options.suite, profile: options.profile } });
    manifestPath = manifest.run.files.manifest;
    try {
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      await finalizeResultRun(manifest.run, { root, status: 'ERROR', exitCode: 1 });
      throw error;
    }
  }
  return { manifest, env, names, manifestPath };
}

function printSelection(manifest) {
  console.log(JSON.stringify({ environment: manifest.environment.name, api: manifest.api.name, suite: manifest.suite.name, profile: manifest.profile.name, mode: manifest.suite.mode, steps: manifest.suite.steps.length, scenario: manifest.profile.scenario, production: manifest.environment.production }, null, 2));
}

async function listConfigurations(root) {
  for (const [label, directory] of [['Environments', 'config/environments'], ['APIs', 'config/apis'], ['Suites', 'config/suites'], ['Profiles', 'config/profiles']]) {
    const names = (await readdir(path.join(root, directory))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).sort();
    console.log(label + ': ' + (names.join(', ') || '(none)'));
  }
}

function pipeSanitized(stream, destination, secrets) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      destination.write(redact(pending.slice(0, newline), secrets) + '\n');
      pending = pending.slice(newline + 1);
    }
    if (pending.length > 262_144) pending = '[Oversized engine output suppressed]';
  });
  stream.on('end', () => { if (pending) destination.write(redact(pending, secrets)); });
}

export async function runK6(prepared, { root = projectRoot, binary = 'k6' } = {}) {
  const { env, names, manifestPath } = prepared;
  const run = prepared.manifest.run;
  let exitCode = 1;
  let interrupted = false;
  let summary;
  let excelCreated = false;
  let engineFinished = false;
  try {
    await access(path.join(root, 'src', 'k6', 'runner.js'), constants.R_OK);
    const args = ['run', '--config', path.join(root, 'config', 'k6-defaults.json'), '--no-usage-report', '--address', '127.0.0.1:0', '--log-output', 'none', path.join(root, 'src', 'k6', 'runner.js')];
    exitCode = await new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: buildChildEnv(env, names, manifestPath) });
      const secrets = names.map(name => env[name]);
      pipeSanitized(child.stdout, process.stdout, secrets);
      pipeSanitized(child.stderr, process.stderr, secrets);
      let interruptionCode;
      const onInterrupt = () => { interruptionCode = 130; interrupted = true; child.kill('SIGINT'); };
      const onTerminate = () => { interruptionCode = 143; interrupted = true; child.kill('SIGTERM'); };
      const removeHandlers = () => {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
      };
      process.on('SIGINT', onInterrupt);
      process.on('SIGTERM', onTerminate);
      child.once('error', error => {
        removeHandlers();
        reject(new Error(error.code === 'ENOENT' ? 'k6 was not found. Install k6 and run npm run doctor.' : 'The k6 process could not be started.'));
      });
      child.once('close', (code, signal) => {
        removeHandlers();
        interrupted ||= signal !== null || code === 130 || code === 143;
        resolve(interruptionCode ?? code ?? (signal === 'SIGTERM' ? 143 : signal ? 130 : 1));
      });
    });
    engineFinished = true;
  } catch (error) {
    console.error('Run failed: ' + redact(error.code ? 'The k6 runner could not be read or started.' : error.message, names.map(name => env[name])));
  }
  if (engineFinished) {
    try { summary = JSON.parse(await readFile(run.files.summary, 'utf8')); }
    catch { console.error('Run failed: the normalized summary report is missing or invalid.'); }
    if (summary) {
      try {
        await writeExcelReport(summary, run.files.excel);
        excelCreated = true;
      } catch { console.error('Run failed: the Excel report could not be created.'); }
    }
  }
  const passed = summaryPassed(summary, run.id);
  const failed = Boolean(summary && summary.schemaVersion === 1 && summary.status === 'failed' && summary.run?.id === run.id && ['metrics-map', 'machine-v1', 'grouped-metrics'].includes(summary.summaryFormat) && Array.isArray(summary.errors) && summary.errors.length === 0 && Array.isArray(summary.thresholds) && summary.thresholds.length > 0 && summary.thresholds.every(threshold => typeof threshold?.ok === 'boolean') && summary.thresholds.some(threshold => threshold?.ok === false));
  const status = interrupted ? 'INTERRUPTED' : engineFinished && excelCreated && exitCode === 0 && passed ? 'PASS' : engineFinished && excelCreated && failed ? 'FAIL' : 'ERROR';
  const finalExitCode = status === 'PASS' ? 0 : exitCode || 1;
  if (engineFinished && summary && !passed && !interrupted) console.error('Run failed: performance gates failed or the summary report is incomplete.');
  try {
    await finalizeResultRun(run, { root, status, exitCode: finalExitCode, summary });
    prepared.manifestPath = run.files.manifest;
    console.log('Result: ' + status + ' | ' + path.relative(root, run.reportDir));
    if (excelCreated) console.log('Excel report: ' + path.relative(root, run.files.excel));
  } catch {
    console.error('Run failed: result folders or the results index could not be finalized.');
    return finalExitCode || 1;
  }
  return finalExitCode;
}
export function summaryPassed(summary, runId) {
  return Boolean(summary && summary.schemaVersion === 1 && summary.status === 'passed' && summary.run?.id === runId && ['metrics-map', 'machine-v1', 'grouped-metrics'].includes(summary.summaryFormat) && Array.isArray(summary.errors) && summary.errors.length === 0 && Array.isArray(summary.thresholds) && summary.thresholds.length > 0 && summary.thresholds.every(threshold => threshold?.ok === true));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'help') { console.log(USAGE); return 0; }
  if (options.command === 'list') { await listConfigurations(projectRoot); return 0; }
  const prepared = await prepareRun(options, { persist: options.command === 'run' && !options.dryRun });
  printSelection(prepared.manifest);
  if (options.command === 'validate') { console.log('Configuration is valid. No HTTP requests were sent.'); return 0; }
  if (options.dryRun) { console.log('Dry run passed. No HTTP requests were sent and no report was created.'); return 0; }
  console.log('Working results: ' + path.relative(projectRoot, prepared.manifest.run.reportDir));
  return runK6(prepared);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error('Error: ' + redact(error.message));
    process.exitCode = 1;
  });
}
