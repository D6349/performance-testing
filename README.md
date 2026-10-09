# API performance testing framework

A configuration-driven API performance testing framework using **k6** for load generation and **Node.js** for validation, secure execution, and a local mock API. Change endpoints, request bodies, environments, test data, suites, or load profiles through JSON files. The shared runner stays the same.

## Start here

Requirements: Node.js 22 or newer and a maintained k6 release. Use k6 2.3 for new setups; k6 1.3 is exercised for migration compatibility. Prefer a supported Node.js LTS release; CI exercises Node.js 22/24 and k6 1.3/2.3. The JavaScript framework has no third-party runtime dependencies.

Run these commands in this folder:

```powershell
npm ci
npm run doctor
npm run check
npm test
npm run demo
npm run integration
```

The demo starts a temporary API on loopback, runs five complete create/read/update/delete journeys, writes reports, then stops the server. It uses synthetic data and needs no credentials. A demo proves the framework works; measuring your API requires its real target, contract, authentication, workload, and service objectives.

If k6 is missing, follow the [official installation instructions](https://grafana.com/docs/k6/latest/set-up/install-k6/). Windows users can run `winget install k6 --source winget`, then open a new terminal. Add the trusted executable to your `PATH`; `doctor` reports its version.

## Project layout

```text
api-performance-testing/
├── config/
│   ├── environments/       # Target origin, exact host allowlist, authentication
│   ├── apis/               # Methods, paths, assertions, extraction, endpoint SLOs
│   ├── suites/             # Ordered journeys or independent weighted requests
│   ├── profiles/           # Smoke, load, stress, spike, soak, capacity
│   ├── schemas/            # Editor schemas; runtime validation lives in src/lib
│   └── k6-defaults.json    # Explicit clean k6 config
├── payloads/items/         # Reusable request body templates
├── data/                   # Synthetic datasets
├── src/lib/                # Validation, templates, request building, reporting
├── src/k6/                 # Generic k6 workflow runner
├── scripts/                # CLI, diagnostics, demo, mock API, source checks
├── tests/                  # Framework regression tests
├── docs/                   # Configuration, execution, and security guides
├── .github/workflows/      # Local CI and manually triggered staging smoke
├── .env.example            # Credential variable names, never real values
└── results/                # Ignored, year/month/date/run folders and report history
```

## Run manually against the local API

Use two terminals. Start the included mock server:

```powershell
npm run mock
```

Then validate and run:

```powershell
npm run validate -- --env local --api example --suite crud --profile smoke
npm run perf -- --env local --api example --suite crud --profile smoke
npm run perf -- --env local --api example --suite health --profile load
```

Stop the mock server with Ctrl+C when finished. Validation resolves files and checks configuration without sending API requests.

## Connect your API

1. Update [staging.json](config/environments/staging.json) with the HTTPS base URL and **exact** approved hostname in `allowedHosts`.
2. Edit [example.json](config/apis/example.json) or add a named API catalog for your endpoint methods, relative paths, expected statuses, JSON checks, and extracted IDs.
3. Update [payloads](payloads/items/create.json), [synthetic data](data/items.json), and [suite steps](config/suites/crud.json) to match your API.
4. Put test credentials in your process environment or an ignored `.env.staging.local` file. Start from [.env.example](.env.example).
5. Validate, then run a smoke test against the target you intend to test.

```powershell
Copy-Item .env.example .env.staging.local
# Edit the ignored file with your test credentials.
npm run validate -- --env staging --api example --suite health --profile smoke
npm run perf -- --env staging --api example --suite health --profile smoke
```

The supplied staging and production URLs use `.invalid` placeholders. Replace them before running. `BASE_URL` may override the configured URL, but the replacement still has to match that environment's allowlist.

## Endpoint and payload changes

If `POST /items` changes to `POST /v2/items`, edit `endpoints.createItem.path` in the catalog. If its JSON contract changes, edit `payloads/items/create.json`, the dataset, and the response assertions. Re-run validation and smoke. No runner changes are needed for ordinary HTTP contract changes.

The create body currently contains:

```json
{
  "name": "{{data.name}}",
  "quantity": "{{data.quantity}}",
  "reference": "{{runtime.uuid}}"
}
```

Exact placeholders preserve types: a numeric dataset quantity becomes a JSON number. Response extraction stores `itemId` for `/items/{{vars.itemId}}` in later steps. Path and query substitutions are URL encoded. Missing variables fail instead of silently sending an incomplete request.

See [the configuration guide](docs/configuration.md) for complete examples and [the execution guide](docs/running.md) for profile selection and interpreting results.

## Reports and gates

Each run is organized by its start date and time in **IST (`Asia/Kolkata`)**. The folder name identifies the environment, API, suite, profile, outcome, and unique suffix:

```text
results/
├── index.html                   # Browse all dates and runs; open this first
├── latest.json                  # Most recently completed run and report links
├── latest-success.json          # Most recently completed passing run
└── 2026/10/2026-10-08/
    ├── index.html               # This date's run history
    └── 16-10-33-945__local__example__crud__smoke__PASS__83e03154/
        ├── reports/
        │   ├── api-performance-report.xlsx
        │   └── report.html
        ├── metrics/summary.json
        ├── checks/junit.xml
        └── metadata/
            ├── run.json         # Run identity, status, timing, and artifact links
            └── manifest.json    # Private configuration and test data
```

Open `results/index.html` to find a run and its Excel or HTML report. A running folder contains `RUNNING`; completion changes it to `PASS`, `FAIL`, `ERROR`, or `INTERRUPTED`. The CLI prints the final location. Folder labels longer than 16 characters are shortened; run metadata and the history retain the full configuration names. Unique suffixes keep repeated runs separate. The history lists runs by start time; latest pointers select by completion time.

Reports include aggregate metrics, per-endpoint measurements, checks, and pass/fail thresholds. Request bodies, response bodies, and credentials are excluded. Keep `metadata/manifest.json` private.

Open `api-performance-report.xlsx` for the Excel workbook: an overview dashboard, endpoint results, threshold targets and actuals, functional checks, detailed metrics, and a reading guide. Latencies and throughput remain numeric, error/check rates use percentage formatting, and pass/fail results are highlighted. Endpoint latency and request-volume charts make slow or busy operations easy to compare. Missing measurements are marked **Not collected**, never replaced with zero.

Export the latest existing result without running the API again:

```powershell
npm run report:excel
# Choose a particular run instead:
$run = 'results/2026/10/2026-10-08/<run-folder>'
npm run report:excel -- --input "$run/metrics/summary.json"
```


The Overview dashboard prints on one portrait page; detail sheets use landscape layout with frozen headers and filters.
The exporter writes `reports/api-performance-report.xlsx` inside the selected run. Use `--output "$run/reports/custom-name.xlsx"` for a custom filename. Failed completed runs also receive a workbook.

To reorganize existing flat `reports/<run-id>/` results, use `npm run results:migrate`. Preview with `npm run results:migrate -- --dry-run`. Migration preserves the original folders in ignored `.tools/legacy-results-backup/`, verifies copied file hashes, and rebuilds the dated history. It sends no API requests. `npm run results:index` rebuilds the history pages and latest pointers from saved run metadata.

A failed threshold makes the command fail so CI can gate changes. The example profile gates include p95 below 500 ms, p99 below 1,000 ms, less than 1% HTTP errors, all checks passing, and no workflow failures. These are **sample targets**; set endpoint-specific objectives and workload levels from your service requirements.

## Security and automation

HTTPS and certificate validation are required for remote environments. Plain HTTP is restricted to explicitly configured loopback testing. Exact host allowlists, relative endpoint paths, disabled redirects, secret references, bounded profiles, and an explicit `--allow-production` flag reduce accidental target or credential exposure.

Pull-request CI runs tests and a local demo only. Real staging traffic is a separate manual workflow intended for a protected GitHub environment. Production tests are never automatic. See [security](docs/security.md) and [CI setup](docs/running.md#github-actions).

The included features cover configurable HTTP API testing. Protocol-specific gRPC/WebSocket runners, OAuth token refresh, distributed execution, and live external metric exporters require deliberate extensions; they are not silently enabled.
