import { writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildExcelModel } from './excel-model.js';
import { packWorkbook, columnName, STYLES as S } from './xlsx.js';

const missing = 'Not collected';
function sheet(name, columns) { return { name, columns, rows: [], merges: [], hyperlinks: [], bars: [], freezeRows: 5 }; }
function put(sheet, index, column, value, style = S.text, height = 24) {
  let row = sheet.rows.find(row => row.index === index);
  if (!row) { row = { index, height, cells: [] }; sheet.rows.push(row); }
  row.height = Math.max(row.height, height);
  row.cells.push({ column, value, style });
}
function merged(sheet, top, left, bottom, right, value, style, height = 24) {
  sheet.merges.push(columnName(left) + top + ':' + columnName(right) + bottom);
  for (let row = top; row <= bottom; row++) {
    for (let column = left; column <= right; column++) put(sheet, row, column, row === top && column === left ? value : null, style, height);
  }
}
function measured(sheet, row, column, value, style = S.number, height = 26) {
  put(sheet, row, column, value === null || value === undefined ? missing : value, value === null || value === undefined ? S.missing : style, height);
}
function statusStyle(status) { return status === 'PASS' || status === 'PASSED' ? S.pass : status === 'FAIL' || status === 'FAILED' ? S.fail : S.missing; }
function heading(sheet, title, subtitle, headers) {
  merged(sheet, 1, 1, 2, sheet.columns.length, title, S.title, 24);
  merged(sheet, 3, 1, 3, sheet.columns.length, subtitle, S.subtitle, 28);
  headers.forEach((title, index) => put(sheet, 5, index + 1, title, S.header, 32));
}
function finish(sheet, filter = false) {
  sheet.rows.sort((a,b) => a.index - b.index);
  const last = Math.max(...sheet.rows.map(row => row.index));
  const end = columnName(sheet.columns.length);
  sheet.printArea = '$A$1:$' + end + '$' + last;
  if (filter) sheet.filter = 'A5:' + end + Math.max(5,last);
  return sheet;
}
function card(sheet, row, left, label, value, style) {
  merged(sheet, row, left, row, left + 2, label, S.cardLabel, 20);
  merged(sheet, row + 1, left, row + 2, left + 2, value ?? missing, value === null || value === undefined ? S.missing : style, 24);
}
function overview(model) {
  const { run, kpis: k } = model;
  const result = run.status.toUpperCase();
  const report = sheet('Overview', Array(12).fill(13));
  report.freezeRows = 4;
  report.chart = true;
  merged(report, 1, 1, 2, 12, 'API PERFORMANCE REPORT', S.title, 26);
  merged(report, 3, 1, 3, 12, 'A clear view of API latency, throughput, errors and performance requirements', S.subtitle, 22);
  card(report, 5, 1, 'OVERALL RESULT', result, run.status === 'passed' ? S.cardPass : S.cardFail);
  card(report, 5, 4, 'HTTP REQUESTS', k.requests, S.cardInteger);
  card(report, 5, 7, 'P95 RESPONSE TIME (ms)', k.p95Ms, S.cardNumber);
  card(report, 5, 10, 'HTTP ERROR RATE', k.httpErrorRate, S.cardPercent);
  card(report, 9, 1, 'REQUESTS / SECOND', k.requestsPerSecond, S.cardNumber);
  card(report, 9, 4, 'AVERAGE RESPONSE (ms)', k.avgMs, S.cardNumber);
  card(report, 9, 7, 'RESPONSE CHECK PASS RATE', k.checkPassRate, S.cardPercent);
  card(report, 9, 10, 'THRESHOLDS PASSED', k.thresholdsPassed + ' / ' + k.thresholdsTotal, S.cardText);
  card(report, 13, 1, 'RUN DURATION (seconds)', run.durationSeconds, S.cardNumber);
  card(report, 13, 4, 'JOURNEY FAILURE RATE', k.workflowFailureRate, S.cardPercent);
  card(report, 13, 7, 'COMPLETED ITERATIONS', k.iterations, S.cardInteger);
  card(report, 13, 10, 'PEAK OBSERVED USERS', k.peakVus, S.cardInteger);
  merged(report, 17, 1, 17, 12, 'RUN DETAILS', S.section, 24);
  const pairs = [
    ['Environment', run.environment || missing, 'Profile', run.profile || missing],
    ['Suite', run.suite || missing, 'Run start (IST)', run.startedAtIst],
    ['HTTP failures', k.httpErrors, 'HTTP successes', k.httpSuccesses]
  ];
  pairs.forEach((values,index) => {
    const row = 18 + index;
    merged(report,row,1,row,3,values[0],S.label);
    merged(report,row,4,row,6,values[1] ?? missing,values[1] === null ? S.missing : S.text);
    merged(report,row,7,row,9,values[2],S.label);
    merged(report,row,10,row,12,values[3] ?? missing,values[3] === null ? S.missing : S.text);
  });
  merged(report,21,1,21,3,'Run ID',S.label);
  merged(report,21,4,21,12,run.id || missing,S.text);
  merged(report,22,1,22,3,'Dropped iterations',S.label);
  merged(report,22,4,22,6,k.droppedIterations ?? missing,k.droppedIterations === null ? S.missing : S.integer);
  merged(report,22,7,22,9,'P99 response (ms)',S.label);
  merged(report,22,10,22,12,k.p99Ms ?? missing,k.p99Ms === null ? S.missing : S.number);
  merged(report,24,1,24,12,'ENDPOINT COMPARISON | UP TO 15 ENDPOINTS WITH THE HIGHEST P95',S.section);
  for (let row = 25; row <= 40; row++) if (!report.rows.some(item => item.index === row)) report.rows.push({ index: row, height: 19, cells: [] });
  merged(report,42,1,42,12,'HOW TO READ THIS RESULT',S.section);
  const failedGates = model.thresholds.filter(entry => entry.status === 'FAIL').length;
  const unavailableGates = model.thresholds.filter(entry => entry.status === 'NOT COLLECTED').length;
  const decision = run.status === 'passed'
    ? 'PASSED: every recorded performance requirement has a valid, passing measurement.'
    : 'FAILED: ' + failedGates + ' failed requirements; ' + unavailableGates + ' requirements without a collected measurement. Review Thresholds and Guide for the reason.';
  merged(report,43,1,44,12,decision,run.status === 'passed' ? S.banner : S.note,20);
  const sample = model.notes.find(note => note.topic === 'Local sample' || note.topic === 'Smoke sample');
  merged(report,45,1,46,12,sample?.detail || 'This report shows aggregate results for one run. Compare results using the same workload, target build and infrastructure.',S.note,20);
  merged(report,48,1,48,12,'OPEN A DETAIL SHEET',S.section);
  [['Endpoints',1,4],['Thresholds',5,8],['Checks',9,12]].forEach(([name,left,right]) => {
    merged(report,49,left,49,right,name,S.link);
    report.hyperlinks.push({ ref: columnName(left) + '49', location: "'" + name + "'!A1", display: name });
  });
  [['Metrics',1,6],['Guide',7,12]].forEach(([name,left,right]) => {
    merged(report,50,left,50,right,name,S.link);
    report.hyperlinks.push({ ref: columnName(left) + '50', location: "'" + name + "'!A1", display: name });
  });
  merged(report,52,1,52,12,'Milliseconds = response duration. Percentages are rates. Not collected means unavailable, and is never treated as zero.',S.subtitle,22);
  return finish(report);
}
function endpointSheet(endpoints) {
  const report = sheet('Endpoints', [25,16,13,14,13,13,13,13,13,13,13,18,16,17,14,14]);
  heading(report,'ENDPOINT PERFORMANCE','Stable operation IDs | response times in milliseconds | highest P95 first | orange marks unavailable measurements',[
    'Endpoint / operation','Result','Requests','Requests / sec','Average (ms)','Median (ms)','P90 (ms)','P95 (ms)','P99 (ms)','Minimum (ms)','Maximum (ms)','HTTP error rate','HTTP errors','HTTP successes','Passed gates','Total gates'
  ]);
  endpoints.forEach((entry,index) => {
    const row = index + 6;
    put(report,row,1,entry.name,S.label,28);
    put(report,row,2,entry.status,statusStyle(entry.status),28);
    const fields = ['requests','requestsPerSecond','avgMs','medianMs','p90Ms','p95Ms','p99Ms','minMs','maxMs','errorRate','errorCount','successCount','thresholdsPassed','thresholdsTotal'];
    fields.forEach((key,offset) => {
      const style = key === 'errorRate' ? S.percent : ['requests','errorCount','successCount','thresholdsPassed','thresholdsTotal'].includes(key) ? S.integer : S.number;
      measured(report,row,offset+3,entry[key],style,28);
    });
  });
  if (!endpoints.length) merged(report,6,1,6,16,'No endpoint measurements were collected. Overall results may still be available in Overview.',S.note,30);
  else {
    report.bars.push({ range: 'H6:H' + (endpoints.length+5), color: '0F766E' });
    report.bars.push({ range: 'L6:L' + (endpoints.length+5), color: 'DC2626' });
  }
  return finish(report,true);
}
function thresholdSheet(model) {
  const report = sheet('Thresholds',[25,36,15,17,14,17,18,19,25,17]);
  heading(report,'PERFORMANCE REQUIREMENTS','Observed measurements compared with configured requirements | percentages are shown as percentages | missing measurements never pass',[
    'Scope / endpoint','Metric','Statistic','Observed','Comparison','Target','Unit','Result','Raw requirement','Decision source'
  ]);
  const ordered = [...model.thresholds].sort((a,b) => Number(a.status === 'PASS') - Number(b.status === 'PASS') || a.scope.localeCompare(b.scope) || a.metric.localeCompare(b.metric) || a.expression.localeCompare(b.expression));
  ordered.forEach((entry,index) => {
    const row = index+6;
    const expression = /^(.*?)\s*(<=|>=|===|!==|==|!=|<|>)\s*(-?\d+(?:\.\d+)?)$/.exec(entry.expression);
    const numericStyle = entry.unit === 'ratio' ? S.percent : entry.unit === 'count' ? S.integer : S.number;
    put(report,row,1,entry.scope);
    put(report,row,2,entry.metric.split('{')[0]);
    put(report,row,3,expression[1].trim());
    measured(report,row,4,entry.actual,numericStyle);
    put(report,row,5,expression[2]);
    put(report,row,6,Number(expression[3]),numericStyle);
    put(report,row,7,entry.unit === 'ratio' ? '%' : entry.unit);
    put(report,row,8,entry.status,statusStyle(entry.status));
    put(report,row,9,entry.expression);
    put(report,row,10,entry.source);
  });
  if (!ordered.length) merged(report,6,1,6,10,'No valid performance requirements were collected. The overall result cannot pass.',S.note,30);
  return finish(report,true);
}
function checksSheet(model) {
  const report = sheet('Checks',[28,20,20,22,22,22,80]);
  heading(report,'RESPONSE CHECKS & JOURNEYS','Response checks and complete journeys measure correctness separately from HTTP status classification',[
    'Check group','Passed / successful','Failed','Recorded rate','Rate meaning','Result','Explanation'
  ]);
  model.checks.forEach((entry,index) => {
    const row = index+6;
    const ok = entry.rate === null ? 'NOT COLLECTED' : entry.rateMeaning === 'Pass rate' ? entry.rate === 1 ? 'PASS' : 'FAIL' : entry.rate === 0 ? 'PASS' : 'FAIL';
    put(report,row,1,entry.name,S.label);
    measured(report,row,2,entry.passed,S.integer);
    measured(report,row,3,entry.failed,S.integer);
    measured(report,row,4,entry.rate,S.percent);
    put(report,row,5,entry.rateMeaning);
    put(report,row,6,ok,statusStyle(ok));
    put(report,row,7,entry.name === 'Response checks'
      ? 'Assertions include expected statuses, response JSON, configured headers and correlation. These are assertion counts, not HTTP request counts.'
      : 'A journey fails if any request, assertion, correlation or cleanup fails. Passed/failed counts describe complete iterations.',S.text,45);
  });
  return finish(report,true);
}
function metricSheet(model) {
  const report = sheet('Metrics',[62,24,23,25]);
  heading(report,'ALL COLLECTED AGGREGATE METRICS','A searchable measurement record | percentages are formatted as percentages | no request or response content is retained',[
    'Metric / endpoint','Statistic','Measured value','Unit'
  ]);
  model.metrics.forEach((entry,index) => {
    const row = index+6;
    put(report,row,1,entry.metric);
    const failureMetric = /^(http_req_failed|workflow_failed)(?:\{|$)/.test(entry.metric);
    const statisticLabel = failureMetric && ['passes','matches'].includes(entry.statistic) ? 'Failures (true)' : failureMetric && entry.statistic === 'fails' ? 'Successes (false)' : entry.statistic;
    put(report,row,2,statisticLabel);
    put(report,row,3,entry.value,entry.unit === 'ratio' ? S.percent : entry.unit === 'count' || entry.unit === 'bytes' ? S.integer : S.number);
    put(report,row,4,entry.unit === 'ratio' ? '%' : entry.unit);
  });
  if (!model.metrics.length) merged(report,6,1,6,4,'No supported aggregate metrics were collected.',S.note,30);
  return finish(report,true);
}
function guideSheet(model) {
  const report = sheet('Guide',[31,112]);
  heading(report,'REPORT GUIDE','Interpretation, definitions and limitations | run times displayed in India Standard Time', ['Topic','What it means']);
  const notes = [
    { topic: 'Workbook navigation', detail: 'Start with Overview. Endpoints compares operations. Thresholds shows actual values and requirements. Checks separates response correctness from journey failures. Metrics provides the collected numerical record.' },
    ...model.notes,
    { topic: 'Endpoint charts', detail: 'Charts show up to 15 endpoints ordered by descending P95. Request volume is for the same endpoints, not a time series. Detailed sheets contain all collected endpoints.' },
    { topic: 'Excel safety', detail: 'Workbook cells use literal strings and measured numbers. There are no executable cell formulas, macros, embedded credentials or external data links. Native charts reference only this workbook.' },
    { topic: 'Measured peak users', detail: 'Peak observed users comes from the collected vus maximum. The configured or allocated vus_max does not by itself establish observed concurrency.' }
  ];
  notes.forEach((note,index) => { put(report,index+6,1,note.topic,S.label,44); put(report,index+6,2,note.detail,S.text,44); });
  return finish(report);
}

/** Generate a true .xlsx from sanitized normalized metrics; no Excel installation required. */
export function createExcelWorkbook(report) {
  const model = buildExcelModel(report);
  const endpoints = [...model.endpoints].sort((a,b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1) || a.name.localeCompare(b.name));
  const top = endpoints.slice(0,15);
  const sheets = [overview(model),endpointSheet(endpoints),thresholdSheet(model),checksSheet(model),metricSheet(model),guideSheet(model)];
  const charts = [
    { title: 'P95 response time by endpoint', categories: top.map(item => item.name), values: top.map(item => item.p95Ms), sourceColumn: 'H', color: '0F766E', axisTitle: 'Response duration (ms)' },
    { title: 'Requests for the same endpoints', categories: top.map(item => item.name), values: top.map(item => item.requests), sourceColumn: 'C', color: '2563EB', axisTitle: 'Request count', integer: true }
  ];
  return packWorkbook(sheets,charts);
}

/** Atomically publish the workbook after all XML and measurements are validated. */
export async function writeExcelReport(report, outputPath) {
  if (typeof outputPath !== 'string' || !/\.xlsx$/i.test(outputPath)) throw new Error('An XLSX report destination is required.');
  const bytes = createExcelWorkbook(report);
  const temporary = path.join(path.dirname(outputPath),'.excel-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary,bytes,{ flag: 'wx', mode: 0o600 });
    await rename(temporary,outputPath);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return outputPath;
}
