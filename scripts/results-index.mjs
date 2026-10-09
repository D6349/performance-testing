#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildResultIndexes } from '../src/lib/results.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.slice(2).length) {
  console.error('This command does not accept arguments.');
  process.exitCode = 1;
} else {
  try {
    const rows = await rebuildResultIndexes(root);
    console.log('Indexed ' + rows.length + ' runs. Open results/index.html. Dates and times: Asia/Kolkata (IST).');
  } catch {
    console.error('The result index could not be rebuilt. Check result metadata and directory permissions.');
    process.exitCode = 1;
  }
}
