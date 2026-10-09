#!/usr/bin/env node
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeExcelReport } from '../src/lib/excel-report.js';
import { rebuildResultIndexes } from '../src/lib/results.js';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_DISCOVERY_ENTRIES = 50000;
const USAGE = [
  'Export an existing API performance result to Excel.', '',
  '  npm run report:excel',
  '  npm run report:excel -- --input results/<year>/<month>/<date>/<run>/metrics/summary.json',
  '  npm run report:excel -- --input results/<year>/<month>/<date>/<run>/metrics/summary.json --output results/<year>/<month>/<date>/<run>/reports/review.xlsx', '',
  'Without --input, select the newest dated run that contains summary.json.',
  'The default workbook belongs in that run\'s reports directory.',
  'Input and output must stay inside this project\'s results directory.',
  'Existing legacy reports directories are supported for compatibility.',
  'Export reads aggregate results only and sends no API requests.',
].join('\n');

class ExcelExportError extends Error {}

export function parseExcelArgs(argv) {
  const options = {};
  const args = [...argv];
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    if (!['--input', '--output'].includes(flag)) throw new ExcelExportError('Use --input, --output, or --help.');
    if (seen.has(flag)) throw new ExcelExportError('Duplicate export option.');
    seen.add(flag);
    const value = args.shift();
    if (!value || value.startsWith('--') || value.includes('\0')) throw new ExcelExportError('Each export option requires a file path.');
    options[flag.slice(2)] = value;
  }
  return options;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

async function reportRoots(root) {
  const actualRoot = await realpath(root);
  const directories = [];
  for (const name of ['results', 'reports']) {
    const directory = path.resolve(root, name);
    let info;
    try { info = await lstat(directory); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new ExcelExportError('The result directories are unavailable.');
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ExcelExportError('Result directories must be regular project directories.');
    const actualDirectory = await realpath(directory);
    if (!contained(actualRoot, actualDirectory)) throw new ExcelExportError('Report paths must stay inside the project.');
    directories.push({ directory, actualDirectory, legacy: name === 'reports' });
  }
  if (!directories.length) throw new ExcelExportError('No readable results directory exists. Complete a test run first.');
  return directories;
}

async function checkComponents(directory, target, { allowMissing = false } = {}) {
  if (!contained(directory, target)) throw new ExcelExportError('Input and output must stay inside the project result directories.');
  const segments = path.relative(directory, target).split(path.sep);
  if (segments.some(segment => /[\x00-\x1f:]/.test(segment) || /[. ]$/.test(segment) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) {
    throw new ExcelExportError('Report paths cannot contain control characters, device names, or alternate data streams.');
  }
  let current = directory;
  let info;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    try {
      info = await lstat(current);
      if (info.isSymbolicLink()) throw new ExcelExportError('Symbolic links are not supported for report export paths.');
      if (info.isFile() && info.nlink > 1) throw new ExcelExportError('Hard links are not supported for report export files.');
      if (index < segments.length - 1 && !info.isDirectory()) throw new ExcelExportError('Report path components must be regular directories.');
    } catch (error) {
      if (error instanceof ExcelExportError) throw error;
      if (allowMissing && error.code === 'ENOENT') return undefined;
      throw new ExcelExportError('The selected report path is unavailable.');
    }
  }
  return info;
}

async function readBoundedFile(input, limit) {
  const before = await lstat(input);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink > 1) throw new ExcelExportError('Report input must be a regular file without links.');
  const handle = await open(input, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1 || info.dev !== before.dev || info.ino !== before.ino) throw new ExcelExportError('The report input changed while it was opened.');
    if (info.size > limit) throw new ExcelExportError('Summary must be a regular file no larger than 2 MiB.');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new ExcelExportError('Summary must be no larger than 2 MiB.');
    return buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/, '');
  } finally { await handle.close(); }
}

function isoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed.getTime() : undefined;
}

function runDirectoryFor(input) {
  const parent = path.dirname(input);
  return path.basename(parent).toLowerCase() === 'metrics' ? path.dirname(parent) : parent;
}

function fallbackTime(directory, input) {
  const relative = path.relative(directory, input).split(path.sep);
  const runName = path.basename(runDirectoryFor(input));
  const utc = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-|$)/.exec(runName);
  if (utc) return isoTime(utc[1] + 'T' + utc[2] + ':' + utc[3] + ':' + utc[4] + '.' + utc[5] + 'Z');
  // The dated hierarchy and display time are IST; run metadata stores UTC.
  const time = /^(\d{2})-(\d{2})-(\d{2})-(\d{3})__/.exec(runName);
  const date = relative.find(segment => /^\d{4}-\d{2}-\d{2}$/.test(segment));
  if (!time || !date) return undefined;
  const localAsUtc = isoTime(date + 'T' + time[1] + ':' + time[2] + ':' + time[3] + '.' + time[4] + 'Z');
  return localAsUtc === undefined ? undefined : localAsUtc - 330 * 60 * 1000;
}

async function candidateOrder(directory, input) {
  const runDirectory = runDirectoryFor(input);
  let startedAt = fallbackTime(directory, input);
  let id = path.basename(runDirectory);
  const metadataPath = path.join(runDirectory, 'metadata', 'run.json');
  try {
    await checkComponents(directory, metadataPath);
    const metadata = JSON.parse(await readBoundedFile(metadataPath, MAX_METADATA_BYTES));
    if (metadata?.schemaVersion === 1) {
      startedAt = isoTime(metadata.startedAt) ?? startedAt;
      if (typeof metadata.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(metadata.id)) id = metadata.id;
    }
  } catch {
    // Missing or invalid metadata cannot hide a collected summary.
  }
  return { input, startedAt: startedAt ?? -Infinity, id };
}

async function discoverSummaries(directory, { legacy = path.basename(directory).toLowerCase() === 'reports' } = {}) {
  const candidates = [];
  let entriesSeen = 0;
  async function visit(current, depth) {
    const entries = await readdir(current, { withFileTypes: true });
    entriesSeen += entries.length;
    if (entriesSeen > MAX_DISCOVERY_ENTRIES) throw new ExcelExportError('Too many result entries to search. Select a summary with --input.');
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const filename = path.join(current, entry.name);
      const summaryHere = entry.name.toLowerCase() === 'summary.json' &&
        (legacy ? depth === 1 : path.basename(current).toLowerCase() === 'metrics');
      if (summaryHere) {
        candidates.push(await candidateOrder(directory, filename));
      } else if (entry.isDirectory() && !entry.isSymbolicLink() && depth < (legacy ? 1 : 6)) {
        await visit(filename, depth + 1);
      }
    }
  }
  await visit(directory, 0);
  return candidates;
}

function newest(candidates) {
  candidates.sort((left, right) => right.startedAt - left.startedAt ||
    right.id.localeCompare(left.id) || right.input.localeCompare(left.input));
  if (!candidates.length) throw new ExcelExportError('No summary.json report was found. Complete a test run first.');
  return candidates[0].input;
}

export async function findLatestSummary(directory) {
  return newest(await discoverSummaries(directory));
}

export async function resolveReportPaths(options, root = projectRoot) {
  const directories = await reportRoots(root);
  const input = options.input ? path.resolve(root, options.input) :
    newest((await Promise.all(directories.map(item => discoverSummaries(item.directory, { legacy: item.legacy })))).flat());
  if (path.basename(input).toLowerCase() !== 'summary.json') throw new ExcelExportError('Input must be a normalized summary.json report.');
  const inputRoot = directories.find(item => contained(item.directory, input));
  if (!inputRoot) throw new ExcelExportError('Input must stay inside the project result directories.');
  const inputInfo = await checkComponents(inputRoot.directory, input);
  if (!inputInfo.isFile()) throw new ExcelExportError('The selected summary is not a regular report file.');
  const actualInput = await realpath(input);
  if (!contained(inputRoot.actualDirectory, actualInput)) throw new ExcelExportError('Input must stay inside the project result directories.');
  const defaultOutput = !inputRoot.legacy && path.basename(path.dirname(input)).toLowerCase() === 'metrics' ?
    path.join(path.dirname(path.dirname(input)), 'reports', 'api-performance-report.xlsx') :
    path.join(path.dirname(input), 'api-performance-report.xlsx');
  const output = options.output ? path.resolve(root, options.output) : defaultOutput;
  if (path.extname(output).toLowerCase() !== '.xlsx') throw new ExcelExportError('Output must use the .xlsx extension.');
  const outputRoot = directories.find(item => contained(item.directory, output));
  if (!outputRoot) throw new ExcelExportError('Output must stay inside the project result directories.');
  const outputInfo = await checkComponents(outputRoot.directory, output, { allowMissing: true });
  if (outputInfo && !outputInfo.isFile()) throw new ExcelExportError('The workbook destination must be a regular file.');
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const actualParent = await realpath(path.dirname(output));
  if (actualParent !== outputRoot.actualDirectory && !contained(outputRoot.actualDirectory, actualParent)) throw new ExcelExportError('Output must stay inside the project result directories.');
  await checkComponents(outputRoot.directory, output, { allowMissing: true });
  return { input: actualInput, output };
}

export async function readSummary(input) {
  const content = await readBoundedFile(input, MAX_SUMMARY_BYTES);
  try { return JSON.parse(content); }
  catch { throw new ExcelExportError('The selected summary is invalid JSON. The latest report was not replaced with an older result.'); }
}

export async function main(argv = process.argv.slice(2), { root = projectRoot, stdout = console.log, stderr = console.error } = {}) {
  try {
    const options = parseExcelArgs(argv);
    if (options.help) { stdout(USAGE); return 0; }
    const { input, output } = await resolveReportPaths(options, root);
    await writeExcelReport(await readSummary(input), output);
    if (contained(path.resolve(root, 'results'), output)) {
      try { await rebuildResultIndexes(root); }
      catch { throw new ExcelExportError('Workbook was created, but the result indexes could not be refreshed.'); }
    }
    const relative = path.relative(root, output).split(path.sep).join('/');
    stdout(/^[a-zA-Z0-9_./~-]+$/.test(relative) ? 'Excel report created: ' + relative : 'Excel report created in the result folders.');
    return 0;
  } catch (error) {
    stderr(error instanceof ExcelExportError ? 'Excel export failed: ' + error.message : 'Excel export failed: the normalized summary or workbook could not be processed.');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; });
}
