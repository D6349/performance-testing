# Running and interpreting tests

Run all commands from the repository root. `npm run perf -- --help` prints CLI usage.

## Installation and local verification

Install a supported Node.js LTS release and a maintained k6 release. The workflows use k6 2.3; k6 1.3 is covered only for migration compatibility. CI pins k6 versions so framework upgrades are reviewable; do the same for a team load generator. Use [Grafana's install guide](https://grafana.com/docs/k6/latest/set-up/install-k6/) and its official release binaries.

```powershell
npm ci
npm run doctor
npm run check
npm test
npm run demo
npm run integration
```

`npm ci` installs from the lockfile; this framework has no npm runtime dependencies. `check` verifies source syntax and repository fixture consistency. Tests cover framework behavior and security controls. The demo exercises real HTTP requests against the loopback mock, including response correlation and report writing.

## Commands

| Task | Command |
| --- | --- |
| Inspect tool installation | `npm run doctor` |
| Validate configuration | `npm run validate -- --env local --api example --suite crud --profile smoke` |
| Start persistent local mock | `npm run mock` |
| Run selected configuration | `npm run perf -- --env local --api example --suite crud --profile smoke` |
| Verify failure gates and credential isolation | `npm run integration` |
| List available configurations | `npm run list` |
| Run all-in-one demo | `npm run demo` |
| Verify source and fixtures | `npm run check` |
| Run regression tests | `npm test` |
| Export latest existing result to Excel | `npm run report:excel` |
| Export a selected result to Excel | `npm run report:excel -- --input results/<year>/<month>/<date>/<run-folder>/metrics/summary.json` |
| Preview migration of older flat results | `npm run results:migrate -- --dry-run` |
| Migrate older flat results | `npm run results:migrate` |
| Rebuild result history and latest pointers | `npm run results:index` |

Validation sends no API traffic. A real run may mutate data according to its selected suite. Use the `health` suite for a public health endpoint and `crud` for the included mock contract.

## Pick a workload

| Profile | Included sample | Purpose |
| --- | --- | --- |
| smoke | 1 VU, 5 iterations | Check configuration, authentication, assertions, and correlation |
| load | 5 VUs, 30 seconds | Illustrate steady concurrency |
| stress | Ramp 0 → 5 → 10 → 0 VUs | Illustrate stepped pressure and recovery |
| spike | Ramp 1 → 15 → 1 VUs quickly | Illustrate sudden traffic change |
| soak | 3 VUs, 5 minutes | Short demonstration of sustained traffic |
| capacity | 5 iterations/second, 30 seconds, up to 15 VUs | Illustrate a fixed arrival rate |

Replace these small samples with realistic workload definitions derived from traffic and service objectives. Five minutes is a demonstration, not a sufficient soak test for long-term memory leaks. A fixed-rate capacity profile is an input workload, not an automated search for maximum sustainable capacity.

VU executors create a closed model: slower responses reduce throughput. Arrival-rate execution schedules iterations independently of their duration; it needs enough VUs to maintain that schedule. For a five-request journey, rate and requests/second differ. See [open and closed models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/).

## Read the reports

Open `results/index.html` for the complete run history, or the `index.html` inside a date folder for that day's runs. Results use the run's **start date and time in IST (`Asia/Kolkata`)**, including when a run finishes after midnight. The run ID itself remains a UTC timestamp with a unique suffix.

```text
results/<year>/<month>/<YYYY-MM-DD>/
  <HH-mm-ss-SSS>__<environment>__<api>__<suite>__<profile>__<status>__<suffix>/
    reports/api-performance-report.xlsx
    reports/report.html
    metrics/summary.json
    checks/junit.xml
    metadata/run.json
    metadata/manifest.json
```

The CLI prints the final folder. Open `reports/api-performance-report.xlsx` for Excel, `reports/report.html` for a browser view, `metrics/summary.json` for aggregate results, and `checks/junit.xml` for CI integration. `metadata/run.json` identifies the run and its artifacts. The manifest contains private configuration and dataset material and should stay local.

| Folder status | Meaning |
| --- | --- |
| RUNNING | The run has started and has not been finalized |
| PASS | Execution and report generation completed with all verified gates passing |
| FAIL | A completed test failed a performance or correctness gate |
| ERROR | Execution or required report generation could not complete correctly |
| INTERRUPTED | The runner observed that the process was stopped |

The history lists runs by start time, newest first. `latest.json` points to the most recently completed run; `latest-success.json` points to the most recently completed passing run when one exists. This preserves completion order even when concurrent tests finish in a different order from their start times. The history keeps every run separate, including failures. Very long selector names are shortened to 16 characters in folder names; full names remain in run metadata and the history. Hard process termination or power loss may leave a folder marked `RUNNING`.

Completed tests generate Excel before the CLI returns the pass/fail result, so failed runs remain available for investigation. Runs that fail before a summary is generated still keep their run metadata, but cannot provide measured performance reports.

The Excel workbook has six sheets:

| Sheet | Read it for |
| --- | --- |
| Overview | Run identity, final status, request count, latency, errors, throughput, and charts |
| Endpoints | Per-operation counts, response-time percentiles, error rates, and associated gate results |
| Thresholds | Every configured target, measured value, unit, and pass/fail outcome |
| Checks | Functional check pass/fail counts and pass rates |
| Metrics | All collected aggregate metric values with units |
| Guide | Metric definitions, missing-data handling, and interpretation limits |

The workbook uses numeric values for measurements, milliseconds for latency, percentages for rates, frozen table headers, filters, and highlighted outcomes. **Not collected** means the source summary has no measurement; it does not mean zero. Endpoint names are stable configured IDs rather than target URLs. Thresholds show the normalized test targets, measured values, and verified outcomes. The Overview charts compare up to 15 endpoints sorted by highest p95; the request-volume chart uses the same operations. The Endpoints sheet includes every collected operation.


The Overview dashboard prints on one portrait page; detail sheets use landscape layout with frozen headers and filters.
`npm run report:excel` converts the latest available `summary.json` by run start time, without loading credentials, reading a manifest, or sending API requests. For a specific run or file name:

```powershell
$run = 'results/2026/10/2026-10-08/<run-folder>'
npm run report:excel -- --input "$run/metrics/summary.json" --output "$run/reports/custom-name.xlsx"
npm run report:excel -- --help
```

Inputs and outputs stay inside the project's generated result roots; symlink paths are rejected. Input must be a normalized `summary.json` no larger than 2 MiB, and output must use `.xlsx`. The exporter finds the latest available summary across dated run folders. An invalid latest summary causes an error instead of silently exporting an older result. Select an earlier valid run explicitly when needed. The default output is the selected run's `reports/api-performance-report.xlsx`. Existing output workbooks are replaced; close the file in Excel before exporting again.

To migrate older `reports/<run-id>/` folders, run `npm run results:migrate -- --dry-run` to preview, then `npm run results:migrate` to apply. Migration checks copied file hashes and preserves the original folders in ignored `.tools/legacy-results-backup/`. It rebuilds the date indexes and latest pointers without sending API traffic. The backup includes private manifests and must remain local.

Use `npm run results:index` to rebuild the root/date history pages and latest pointers from the saved run metadata without running a test or changing measured results.

Read functional checks and errors before latency. A low p95 does not prove correct responses. Compare:

- HTTP error rate, expected-status handling, and JSON/header checks.
- `workflow_failed` across complete journeys, including correlation failures.
- `workflow_requests` and actual HTTP throughput.
- Endpoint-specific p95/p99 and global duration metrics.
- Dropped iterations for arrival-rate execution.
- Your application's CPU, memory, queues, database latency, saturation, and recovery.

A threshold failure produces a failing exit status. It is a performance or correctness result, not necessarily a framework failure. Report artifacts may be absent if validation or k6 startup fails before summary generation.

Tiny smoke samples do not support reliable percentile estimates. Compare runs with matching target build, infrastructure, dataset, profile, duration, and generator resources. Endpoint IDs and aggregate metric tags stay stable when URL versions or resource IDs change.

## GitHub Actions

[Local CI](../.github/workflows/ci.yml) runs on pull requests and pushes to main/master. It runs checks and unit tests on Node.js 22/24, then runs a localhost demo and integration checks with k6 1.3/2.3. No real endpoint or API credentials are used. Actions are pinned by commit; Dependabot proposes version updates.

[Staging smoke](../.github/workflows/staging-smoke.yml) is a separate manual workflow:

1. Replace the staging placeholder origin and its exact allowlist entry in `config/environments/staging.json`.
2. Adapt the health endpoint and assertions in the API catalog to your staging API.
3. Create a GitHub environment named `staging`, add required reviewers, and restrict deployment branches to the repository default branch.
4. Add the environment secret `API_TOKEN` and optional environment variable `BASE_URL`.
5. Push the reviewed configuration to the default branch and choose **Run workflow** for the staging smoke workflow.

`BASE_URL` still has to match the reviewed staging allowlist. The workflow uses a fixed, low smoke profile and health suite. Changing it to load or mutation suites requires a reviewed workflow change. Workflows upload aggregate report files, public run metadata, history indexes, and latest pointers with seven-day retention. Private manifests and backup folders are excluded.

Production traffic is never scheduled by the supplied workflows. An intentional production run requires a reviewed production configuration and an explicit invocation such as:

```powershell
npm run perf -- --env production --api example --suite health --profile smoke --allow-production
```

Obtain suitable credentials and coordinate production testing before running that command.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| k6 executable missing | Run doctor; install a maintained k6 version and add its trusted executable to `PATH` |
| Host rejected | Update the reviewed environment's exact `allowedHosts`; check `BASE_URL` overrides |
| HTTP rejected | Use HTTPS remotely; only loopback environments can explicitly allow HTTP |
| Missing credential | Check the `auth` variable name and dotenv precedence |
| Placeholder missing | Check dataset keys, suite/step variables, and preceding extraction in the journey |
| Unexpected response | Check method, path, payload, status expectations, and the API contract |
| Capacity drops iterations | Check server saturation, VU allocation, journey time, and generator resources |
| No measured reports | Open the result history and check `ERROR`/`INTERRUPTED` run metadata; summaries require k6 execution |
| Excel export fails | Check the summary schema, generated-result path, 2 MiB input limit, and whether Excel has the destination file open |
| CRUD leaves data | Cleanup needs the extracted ID and a running process; use independent test-tenant cleanup |
