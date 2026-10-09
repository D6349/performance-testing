#!/usr/bin/env node
import path from 'node:path';
import { createMockServer } from './mock-server.mjs';
import { prepareRun, projectRoot, runK6, parseArgs } from './cli.mjs';

const mock = await createMockServer();
try {
  const options = parseArgs(['run', '--env', 'local', '--api', 'example', '--suite', 'crud', '--profile', 'smoke']);
  const prepared = await prepareRun(options, { root: projectRoot, ambient: { ...process.env, BASE_URL: mock.baseUrl }, persist: true });
  console.log('Running a smoke journey against the local synthetic API.');
  console.log('Working results: ' + path.relative(projectRoot, prepared.manifest.run.reportDir));
  process.exitCode = await runK6(prepared);
} catch {
  console.error('Demo failed. Run npm run doctor and npm run validate to check the installation and configuration.');
  process.exitCode = 1;
} finally {
  await mock.close();
}
