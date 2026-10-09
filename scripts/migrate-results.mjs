#!/usr/bin/env node
import { readdir, readFile, mkdir, lstat, rename, copyFile, rmdir } from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertResultPath, createResultRun, finalizeResultRun, resultLayout, startTimeFromRunId, writeResultJson, rebuildResultIndexes, MAX_MANIFEST_BYTES } from '../src/lib/results.js';
import { writeExcelReport } from '../src/lib/excel-report.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/i;
const KNOWN = { 'manifest.json': 'manifest', 'summary.json': 'summary', 'report.html': 'html', 'junit.xml': 'junit', 'api-performance-report.xlsx': 'excel' };

async function readJson(root, filename, limit = 2 * 1024 * 1024) {
  try {
    await assertResultPath(root, filename, { allowMissing: false });
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid legacy metadata.');
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Legacy metadata could not be read safely.'); }
}
async function hashFile(root, filename) {
  await assertResultPath(root, filename, { allowMissing: false });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function inventory(root, directory, prefix = '', output = []) {
  await assertResultPath(root, directory, { allowMissing: false });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    await assertResultPath(root, filename, { allowMissing: false });
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) await inventory(root, filename, relative, output);
    else if (entry.isFile()) output.push({ path: relative.split(path.sep).join('/'), sha256: await hashFile(root, filename) });
    else throw new Error('Legacy results contain unsupported file types.');
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}
async function unused(root, target) {
  await assertResultPath(root, target);
  try { await lstat(target); throw new Error('A migration destination already exists; no files were overwritten.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function legacyStatus(summary, id) {
  if (!summary || summary.run?.id !== id || summary.schemaVersion !== 1 ||
      !['metrics-map', 'machine-v1', 'grouped-metrics'].includes(summary.summaryFormat) ||
      !Array.isArray(summary.errors) || !Array.isArray(summary.thresholds) || !summary.thresholds.length ||
      !summary.thresholds.every(item => item && typeof item.ok === 'boolean')) return 'ERROR';
  if (summary.status === 'passed' && !summary.errors.length && summary.thresholds.every(item => item.ok)) return 'PASS';
  if (summary.status === 'failed' && !summary.errors.length && summary.thresholds.some(item => item.ok === false)) return 'FAIL';
  return 'ERROR';
}

/** Original directories move to a private backup only after verified copies exist. */
export async function migrateLegacyResults(root, { dryRun = false } = {}) {
  const legacyRoot = path.join(path.resolve(root), 'reports');
  try { await assertResultPath(root, legacyRoot, { allowMissing: false }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const plans = [];
  for (const entry of await readdir(legacyRoot, { withFileTypes: true })) {
    if (!RUN_ID.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Linked legacy result directories are unsupported.');
    const source = path.join(legacyRoot, entry.name);
    const manifest = await readJson(root, path.join(source, 'manifest.json'), MAX_MANIFEST_BYTES);
    const summary = await readJson(root, path.join(source, 'summary.json'));
    const run = { id: entry.name, startedAt: startTimeFromRunId(entry.name),
      environment: manifest?.run?.environment ?? summary?.run?.environment ?? 'unknown',
      api: manifest?.run?.api ?? manifest?.api?.name ?? 'unknown',
      suite: manifest?.run?.suite ?? summary?.run?.suite ?? 'unknown',
      profile: manifest?.run?.profile ?? summary?.run?.profile ?? 'unknown' };
    const status = legacyStatus(summary, run.id);
    const finalLayout = resultLayout(root, run, status);
    const backup = path.join(root, '.tools', 'legacy-results-backup', run.id);
    await unused(root, finalLayout.reportDir);
    await unused(root, resultLayout(root, run).reportDir);
    await unused(root, backup);
    const files = await inventory(root, source);
    const completedAt = (await lstat(path.join(source, summary ? 'summary.json' : 'manifest.json')).catch(() => lstat(source))).mtime.toISOString();
    plans.push({ run, status, source, backup, summary, completedAt, files, destination: finalLayout.reportDir });
  }
  plans.sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt));
  if (dryRun) return plans.map(plan => ({ id: plan.run.id, status: plan.status, source: plan.source, destination: plan.destination, backup: plan.backup, fileCount: plan.files.length }));
  const completed = [];
  for (const plan of plans) {
    const run = await createResultRun({ root, run: plan.run });
    try {
      for (const item of plan.files) {
        const source = path.join(plan.source, item.path);
        const target = KNOWN[item.path] ? run.files[KNOWN[item.path]] : path.join(run.reportDir, 'metadata', 'legacy-artifacts', item.path);
        await assertResultPath(root, source, { allowMissing: false });
        await assertResultPath(root, target);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(source, target, constants.COPYFILE_EXCL);
        if (await hashFile(root, target) !== item.sha256) throw new Error('Artifact verification failed; original results were retained.');
      }
      if (plan.summary && !plan.files.some(item => item.path === 'api-performance-report.xlsx')) await writeExcelReport(plan.summary, run.files.excel);
      const current = await inventory(root, plan.source);
      if (JSON.stringify(current) !== JSON.stringify(plan.files)) throw new Error('Original results changed during migration; the original folder was retained.');
      await finalizeResultRun(run, { root, status: plan.status, exitCode: plan.status === 'PASS' ? 0 : null, summary: plan.summary, completedAt: plan.completedAt });
      await assertResultPath(root, plan.source, { allowMissing: false });
      await unused(root, plan.backup);
      await mkdir(path.dirname(plan.backup), { recursive: true, mode: 0o700 });
      await rename(plan.source, plan.backup);
      const preserved = await inventory(root, plan.backup);
      if (JSON.stringify(preserved) !== JSON.stringify(plan.files)) throw new Error('Backup verification failed.');
      const audit = { schemaVersion: 1, migratedAt: new Date().toISOString(), id: run.id, status: run.status,
        source: path.relative(root, plan.source).split(path.sep).join('/'), destination: path.relative(root, run.reportDir).split(path.sep).join('/'),
        backup: path.relative(root, plan.backup).split(path.sep).join('/'), originalsVerified: true, originalFiles: plan.files };
      await writeResultJson(root, path.join(run.reportDir, 'metadata', 'migration.json'), audit);
      completed.push({ id: run.id, status: run.status, destination: run.reportDir, backup: plan.backup, fileCount: plan.files.length });
    } catch {
      if (run.status === 'RUNNING') await finalizeResultRun(run, { root, status: 'ERROR', exitCode: 1, summary: plan.summary }).catch(() => {});
      throw new Error('Migration stopped. Original files remain in reports/ or the verified private backup; existing files were not overwritten.');
    }
  }
  await rebuildResultIndexes(root);
  if ((await readdir(legacyRoot)).length === 0) {
    await assertResultPath(root, legacyRoot, { allowMissing: false });
    await rmdir(legacyRoot).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  }
  return completed;
}

export async function main(argv = process.argv.slice(2), root = projectRoot) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('npm run results:migrate [-- --dry-run]\nPreserves original reports in .tools/legacy-results-backup/ after hash-verified migration.');
    return 0;
  }
  if (argv.some(value => value !== '--dry-run') || argv.length > 1) throw new Error('Only --dry-run is supported.');
  const dryRun = argv.includes('--dry-run');
  const runs = await migrateLegacyResults(root, { dryRun });
  console.log((dryRun ? 'Planned' : 'Migrated') + ' ' + runs.length + ' legacy result folders.');
  for (const run of runs) console.log(run.status + ' | ' + path.relative(root, run.destination));
  if (!dryRun && runs.length) console.log('Original files verified and preserved in .tools/legacy-results-backup/. Open results/index.html for report history.');
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error('Error: ' + error.message); process.exitCode = 1; });
}
