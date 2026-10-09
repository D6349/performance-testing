import { mkdir, lstat, realpath, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const RESULTS_TIMEZONE = 'Asia/Kolkata';
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const FINAL_STATUSES = new Set(['PASS', 'FAIL', 'ERROR', 'INTERRUPTED']);
const STATUSES = new Set(['RUNNING', ...FINAL_STATUSES]);
const NAME = /^[a-z][a-z0-9_-]{0,63}$/i;
const RUN_ID = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([a-f0-9]{8})$/i;
const FILES = { manifest: 'metadata/manifest.json', metadata: 'metadata/run.json', summary: 'metrics/summary.json', html: 'reports/report.html', excel: 'reports/api-performance-report.xlsx', junit: 'checks/junit.xml' };
const iso = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid run start time is required.');
  return date.toISOString();
};
const relative = (root, target) => path.relative(root, target).split(path.sep).join('/');
const contains = (root, target) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};

/** Check every existing component before creating, replacing, or moving files. */
export async function assertResultPath(root, target, { allowMissing = true } = {}) {
  const base = path.resolve(root);
  const absolute = path.resolve(target);
  if (!contains(base, absolute) || /[\u0000-\u001f\u007f]/.test(path.relative(base, absolute)) ||
      path.relative(base, absolute).split(path.sep).some(part => part.includes(':'))) {
    throw new Error('Result paths must stay inside the project.');
  }
  const rootStat = await lstat(base);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The project root must be a regular directory.');
  const canonicalRoot = await realpath(base);
  let current = base;
  const parts = path.relative(base, absolute).split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await lstat(current); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('Linked result paths are unsupported.');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Invalid result directory.');
    const canonical = await realpath(current);
    if (!contains(canonicalRoot, canonical)) throw new Error('Result paths must stay inside the project.');
  }
  return absolute;
}

export function startTimeFromRunId(id) {
  const match = typeof id === 'string' && RUN_ID.exec(id);
  if (!match) throw new Error('Invalid run identifier.');
  return iso(match[1] + 'T' + match[2] + ':' + match[3] + ':' + match[4] + '.' + match[5] + 'Z');
}

function localParts(startedAt) {
  const date = new Date(iso(startedAt));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: RESULTS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { year: parts.year, month: parts.month, date: parts.year + '-' + parts.month + '-' + parts.day,
    time: parts.hour + '-' + parts.minute + '-' + parts.second + '-' + String(date.getUTCMilliseconds()).padStart(3, '0') };
}

function selector(value) {
  if (typeof value !== 'string' || !NAME.test(value)) throw new Error('Invalid run selection.');
  return value.length <= 16 ? value : value.slice(0, 12) + '-cut';
}

export function resultLayout(root, run, status = 'RUNNING') {
  if (!STATUSES.has(status)) throw new Error('Invalid result status.');
  const startedAt = iso(run.startedAt ?? startTimeFromRunId(run.id));
  const id = RUN_ID.exec(run.id);
  if (!id) throw new Error('Invalid run identifier.');
  const local = localParts(startedAt);
  const labels = ['environment', 'api', 'suite', 'profile'].map(key => selector(run[key]));
  const folder = [local.time, ...labels, status, id[6].toLowerCase()].join('__');
  const reportDir = path.join(path.resolve(root), 'results', local.year, local.month, local.date, folder);
  return { ...run, startedAt, timezone: RESULTS_TIMEZONE, localDate: local.date, localTime: local.time,
    status, reportDir, files: Object.fromEntries(Object.entries(FILES).map(([key, name]) => [key, path.join(reportDir, name)])) };
}

async function writeResultBytes(root, destination, content) {
  const target = await assertResultPath(root, destination);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = target + '.' + randomUUID() + '.tmp';
  await assertResultPath(root, temporary);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function writeResultJson(root, destination, value) {
  return writeResultBytes(root, destination, JSON.stringify(value, null, 2) + '\n');
}

async function artifactLinks(root, run) {
  const artifacts = {};
  for (const [key, filename] of Object.entries(run.files)) {
    if (key === 'metadata' || key === 'manifest') continue;
    try {
      await assertResultPath(root, filename, { allowMissing: false });
      if ((await lstat(filename)).isFile()) artifacts[key] = relative(root, filename);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return artifacts;
}

async function saveMetadata(root, run, { exitCode = null, summary = null, completedAt = null, destination = run.files.metadata, artifactRun = run } = {}) {
  const stats = summary && summary.run?.id === run.id ? summary : null;
  // Explicit allowlist: configuration, payloads, headers and credentials never enter the history.
  const data = {
    schemaVersion: 1, id: run.id, environment: run.environment, api: run.api, suite: run.suite, profile: run.profile,
    startedAt: run.startedAt, completedAt, timezone: RESULTS_TIMEZONE, localDate: run.localDate, localTime: run.localTime,
    status: run.status, exitCode, folder: relative(root, run.reportDir),
    artifacts: Object.fromEntries(Object.keys(await artifactLinks(root, artifactRun)).map(key => [key, relative(root, run.files[key])])),
    performance: {
      status: stats?.status === 'passed' || stats?.status === 'failed' ? stats.status : 'unavailable',
      durationMs: numeric(stats?.durationMs),
      requests: numeric(stats?.metrics?.http_reqs?.values?.count),
      p95Ms: numeric(stats?.metrics?.http_req_duration?.values?.['p(95)']),
      failedRequestRate: numeric(stats?.metrics?.http_req_failed?.values?.rate),
      thresholdsPassed: Array.isArray(stats?.thresholds) ? stats.thresholds.filter(item => item?.ok === true).length : null,
      thresholdsTotal: Array.isArray(stats?.thresholds) ? stats.thresholds.length : null,
    },
  };
  await writeResultJson(root, destination, data);
  return data;
}
function numeric(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }

export async function createResultRun({ root, run, startedAt } = {}) {
  const layout = resultLayout(root, { ...run, ...(startedAt ? { startedAt: iso(startedAt) } : {}) });
  const resultRoot = path.join(path.resolve(root), 'results');
  await assertResultPath(root, resultRoot);
  await mkdir(resultRoot, { recursive: true, mode: 0o700 });
  return withIndexLock(root, async () => {
    await assertResultPath(root, layout.reportDir);
    await mkdir(path.dirname(layout.reportDir), { recursive: true, mode: 0o700 });
    await mkdir(layout.reportDir, { mode: 0o700 });
    for (const folder of ['reports', 'metrics', 'checks', 'metadata']) {
      await mkdir(path.join(layout.reportDir, folder), { mode: 0o700 });
    }
    await saveMetadata(root, layout);
    await rebuildUnlocked(root);
    return layout;
  });
}

/** Final folder rename exposes matching metadata and provenance together. */
export async function finalizeResultRun(run, { root, status, exitCode = null, summary = null, completedAt } = {}) {
  if (!FINAL_STATUSES.has(status)) throw new Error('A final run status is required.');
  return withIndexLock(root, async () => {
    const previous = { ...run, files: { ...run.files } };
    const next = resultLayout(root, run, status);
    const finishedAt = iso(completedAt ?? new Date());
    await assertResultPath(root, previous.reportDir, { allowMissing: false });
    await assertResultPath(root, next.reportDir);
    const moving = path.resolve(next.reportDir) !== path.resolve(previous.reportDir);
    if (moving) {
      try { await lstat(next.reportDir); throw new Error('The result destination already exists.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Validate before changing directory names; a malformed provenance file must
    // not strand RUNNING metadata inside a folder claiming completion.
    let manifestBytes = null;
    let manifest = null;
    try {
      await assertResultPath(root, previous.files.manifest, { allowMissing: false });
      const info = await lstat(previous.files.manifest);
      if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new Error('Invalid execution manifest.');
      manifestBytes = await readFile(previous.files.manifest);
      manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid execution manifest.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Execution provenance could not be validated; the result folder was retained.');
    }
    await assertResultPath(root, previous.files.metadata, { allowMissing: false });
    if ((await lstat(previous.files.metadata)).size > 64 * 1024) throw new Error('Invalid result metadata.');
    const metadataBytes = await readFile(previous.files.metadata);
    try {
      if (manifest) await writeResultJson(root, previous.files.manifest, { ...manifest, run: { ...next } });
      await saveMetadata(root, next, { exitCode, summary, completedAt: finishedAt, destination: previous.files.metadata, artifactRun: previous });
      if (moving) await rename(previous.reportDir, next.reportDir);
    } catch {
      if (manifestBytes) await writeResultBytes(root, previous.files.manifest, manifestBytes);
      await writeResultBytes(root, previous.files.metadata, metadataBytes);
      throw new Error('Result finalization failed; the original folder was retained.');
    }
    Object.assign(run, next);
    await rebuildUnlocked(root);
    return run;
  });
}

async function readIndexMetadata(root, filename) {
  await assertResultPath(root, filename, { allowMissing: false });
  const info = await lstat(filename);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('Invalid result metadata.');
  const raw = JSON.parse(await readFile(filename, 'utf8'));
  if (raw.schemaVersion !== 1 || !STATUSES.has(raw.status)) throw new Error('Invalid result metadata.');
  const run = resultLayout(root, raw, raw.status);
  if (path.resolve(filename) !== path.resolve(run.files.metadata)) throw new Error('Result metadata does not match its directory.');
  const artifacts = await artifactLinks(root, run);
  // Never link to execution manifests from a browsable or CI-uploaded history.
  delete artifacts.manifest;
  return {
    schemaVersion: 1, id: run.id, environment: run.environment, api: run.api, suite: run.suite, profile: run.profile,
    startedAt: run.startedAt, completedAt: raw.completedAt ? iso(raw.completedAt) : null,
    timezone: RESULTS_TIMEZONE, localDate: run.localDate, localTime: run.localTime,
    status: run.status, exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
    folder: relative(root, run.reportDir), artifacts,
    performance: {
      status: ['passed', 'failed'].includes(raw.performance?.status) ? raw.performance.status : 'unavailable',
      ...Object.fromEntries(['durationMs', 'requests', 'p95Ms', 'failedRequestRate', 'thresholdsPassed', 'thresholdsTotal'].map(key => [key, numeric(raw.performance?.[key])])),
    },
  };
}

async function discoverMetadata(root, directory, depth = 0, counter = { value: 0 }) {
  if (depth > 5) return [];
  await assertResultPath(root, directory, { allowMissing: false });
  const entries = await readdir(directory, { withFileTypes: true });
  if (depth === 3 && /^\d{4}-\d{2}-\d{2}$/.test(path.basename(directory))) counter.dates?.add(directory);
  const output = [];
  for (const entry of entries) {
    if (++counter.value > 100_000) throw new Error('Result history is too large to index.');
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Linked result paths are unsupported.');
    if (entry.isDirectory()) output.push(...await discoverMetadata(root, target, depth + 1, counter));
    else if (entry.name === 'run.json' && path.basename(directory) === 'metadata') output.push(target);
  }
  return output;
}
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

const clockLabel = value => value.replaceAll('-', ':').replace(/:(\d{3})$/, '.$1');

function indexHtml(rows, root, destination, title) {
  const link = (row, key, label) => {
    const target = row.artifacts[key];
    if (!target) return '<span class="muted">' + label + ' unavailable</span>';
    const href = relative(path.dirname(destination), path.join(root, target));
    return '<a href="' + escapeHtml(href) + '">' + label + '</a>';
  };
  const totals = Object.fromEntries([...STATUSES].map(status => [status, rows.filter(row => row.status === status).length]));
  const body = rows.map(row => '<tr><td><strong>' + escapeHtml(row.localDate) + '</strong><br>' + escapeHtml(clockLabel(row.localTime)) +
    ' IST<br><small>' + escapeHtml(row.id.slice(-8)) + '</small></td><td><span class="badge ' + row.status.toLowerCase() + '">' + row.status +
    '</span></td><td>' + escapeHtml(row.environment) + '</td><td>' + escapeHtml(row.api) + '</td><td>' + escapeHtml(row.suite) + '</td><td>' + escapeHtml(row.profile) +
    '</td><td>' + (row.performance.requests === null ? '—' : row.performance.requests) + '</td><td>' + (row.performance.p95Ms === null ? '—' : row.performance.p95Ms.toFixed(2) + ' ms') +
    '</td><td class="links">' + link(row, 'excel', 'Excel') + ' ' + link(row, 'html', 'HTML') + ' ' + link(row, 'summary', 'Metrics') + ' ' + link(row, 'junit', 'JUnit') + '</td></tr>').join('\n');
  const latest = latestCompleted(rows);
  const success = latestCompleted(rows, row => row.status === 'PASS');
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
    '<title>' + escapeHtml(title) + '</title><style>:root{font:15px system-ui,sans-serif;color:#172b46;background:#f2f6fa}body{max-width:1440px;margin:36px auto;padding:0 24px}' +
    'h1{font-size:30px;margin-bottom:8px}p{color:#53657c}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}.card{background:white;border:1px solid #dae2ed;border-radius:8px;padding:14px 22px;min-width:85px}' +
    '.card strong{display:block;font-size:25px}.table{overflow:auto;border:1px solid #dae2ed;border-radius:8px;background:white}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{text-align:left;padding:14px 12px;border-bottom:1px solid #e3e9f0}' +
    'th{background:#142e50;color:white;font-size:12px;text-transform:uppercase;letter-spacing:.6px}.badge{font-size:12px;font-weight:700;border-radius:4px;padding:5px 8px}.pass{color:#147343;background:#dff4e8}.fail,.error{color:#a42d35;background:#ffe5e7}' +
    '.running{color:#856013;background:#fff2cf}.interrupted{color:#6c497e;background:#efe5f5}a{color:#006e86;text-decoration:none;font-weight:600}a:hover{text-decoration:underline}.links a,.links span{margin-right:10px}.muted,small{color:#7b8798;font-size:12px}.quick{background:white;padding:16px;border-radius:8px;margin-bottom:20px}.quick p{margin:6px 0}footer{font-size:12px;color:#6b7c92;margin-top:20px}</style></head><body>' +
    '<h1>' + escapeHtml(title) + '</h1><p>Dates and times are in India Standard Time (Asia/Kolkata, UTC+05:30). Newest runs appear first.</p>' +
    '<div class="cards"><div class="card">Total runs<strong>' + rows.length + '</strong></div>' +
    [...STATUSES].filter(status => totals[status]).map(status => '<div class="card">' + status + '<strong>' + totals[status] + '</strong></div>').join('') + '</div>' +
    '<div class="quick"><p>Latest completed run: ' + (latest ? escapeHtml(latest.localDate + ' ' + clockLabel(latest.localTime) + ' IST | ' + latest.status) + ' · ' + link(latest, 'excel', 'Excel report') : 'No completed run') +
    '</p><p>Latest successful run: ' + (success ? escapeHtml(success.localDate + ' ' + clockLabel(success.localTime) + ' IST') + ' · ' + link(success, 'excel', 'Excel report') : 'No successful run') + '</p></div>' +
    '<div class="table"><table><thead><tr><th>Started (IST)</th><th>Result</th><th>Environment</th><th>API</th><th>Suite</th><th>Profile</th><th>Requests</th><th>P95 latency</th><th>Reports</th></tr></thead><tbody>' +
    (body || '<tr><td colspan="9">Run npm run demo to create your first report.</td></tr>') +
    '</tbody></table></div><footer>PASS: completed run with passing gates and generated Excel report. FAIL: performance or functional gate failed. ERROR: engine or reporting could not complete. INTERRUPTED: test stopped. RUNNING: completion has not been recorded. Raw configuration and payloads are excluded from this page.</footer></body></html>\n';
}

async function writeIndex(root, filename, content) {
  const target = await assertResultPath(root, filename);
  const temporary = target + '.' + randomUUID() + '.tmp';
  await assertResultPath(root, temporary);
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, target); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function withIndexLock(root, body) {
  const lock = path.join(root, 'results', '.index.lock');
  await assertResultPath(root, path.dirname(lock), { allowMissing: false });
  const owner = { pid: process.pid, token: randomUUID() };
  let acquired = false;
  for (let attempt = 0; attempt < 300 && !acquired; attempt++) {
    try {
      await writeFile(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        await assertResultPath(root, lock, { allowMissing: false });
        const stat = await lstat(lock);
        if (stat.size > 1024) throw new Error('Invalid result index lock.');
        const observed = await readFile(lock, 'utf8');
        let holder;
        try { holder = JSON.parse(observed); } catch { holder = null; }
        let alive = false;
        if (Number.isInteger(holder?.pid) && holder.pid > 0) {
          try { process.kill(holder.pid, 0); alive = true; }
          catch (probe) { if (probe.code !== 'ESRCH') alive = true; }
        }
        if (!alive && Date.now() - stat.mtimeMs > 1000) {
          // Recheck owner before reclaiming a dead writer's lock.
          const current = await readFile(lock, 'utf8');
          if (current === observed) {
            await unlink(lock).catch(err => { if (err.code !== 'ENOENT') throw err; });
          }
        } else await new Promise(resolve => setTimeout(resolve, 100));
      } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
    }
  }
  if (!acquired) throw new Error('The results index is busy. Retry after the active run completes.');
  try { return await body(); }
  finally {
    try {
      const current = JSON.parse(await readFile(lock, 'utf8'));
      if (current.token === owner.token) await unlink(lock);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function latestCompleted(rows, predicate = () => true) {
  return rows.filter(row => FINAL_STATUSES.has(row.status) && predicate(row))
    .sort((a, b) => (b.completedAt ?? b.startedAt).localeCompare(a.completedAt ?? a.startedAt) || b.id.localeCompare(a.id))[0] ?? null;
}

async function rebuildUnlocked(root) {
  const resultRoot = path.join(path.resolve(root), 'results');
  const rows = [];
  const scan = { value: 0, dates: new Set() };
  for (const filename of await discoverMetadata(root, resultRoot, 0, scan)) rows.push(await readIndexMetadata(root, filename));
  rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  const homepage = path.join(resultRoot, 'index.html');
  await writeIndex(root, homepage, indexHtml(rows, root, homepage, 'API performance results'));
  const dates = new Map([...scan.dates].map(directory => [directory, []]));
  for (const row of rows) {
    const directory = path.dirname(path.join(root, row.folder));
    if (!dates.has(directory)) dates.set(directory, []);
    dates.get(directory).push(row);
  }
  for (const [directory, dayRows] of dates) {
    const filename = path.join(directory, 'index.html');
    await writeIndex(root, filename, indexHtml(dayRows, root, filename, 'API performance — ' + path.basename(directory)));
  }
  await writeResultJson(root, path.join(resultRoot, 'latest.json'), latestCompleted(rows));
  await writeResultJson(root, path.join(resultRoot, 'latest-success.json'), latestCompleted(rows, row => row.status === 'PASS'));
  return rows;
}

export async function rebuildResultIndexes(root) {
  const resultRoot = path.join(path.resolve(root), 'results');
  await assertResultPath(root, resultRoot);
  await mkdir(resultRoot, { recursive: true, mode: 0o700 });
  return withIndexLock(root, () => rebuildUnlocked(root));
}
