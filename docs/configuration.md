# Configuration guide

The CLI selects one environment, API catalog, suite, and workload profile. Names map to files in `config/environments`, `config/apis`, `config/suites`, and `config/profiles`. JSON schemas provide editor help; `npm run validate` performs the authoritative runtime checks, including file paths, target safety, authentication references, and supported workload options.

## Environments

```json
{
  "name": "staging",
  "baseUrl": "https://api.staging.example.invalid",
  "allowedHosts": ["api.staging.example.invalid"],
  "allowHttp": false,
  "production": false,
  "headers": {"Accept": "application/json"},
  "auth": {"type": "bearer", "tokenEnv": "API_TOKEN"},
  "timeout": "10s",
  "variables": {"tenant": "performance"}
}
```

Keep hostnames exact. Do not include a scheme, wildcard, or URL path in `allowedHosts`. `baseUrl` may contain an API path prefix. Endpoint paths are appended beneath it. Credentials never belong in URL user information, committed headers, or JSON fixtures.

`BASE_URL` is an optional process or dotenv override. It cannot bypass HTTPS, host checks, or production controls. Set `production: true` for each production environment, even when you choose a different filename.

Environment variables resolve in this order:

1. Existing process environment.
2. Ignored `.env.<environment>.local`.
3. Ignored `.env`.

Dotenv files hold literal key/value settings; shell commands are never evaluated. Restrict their file permissions and keep them out of source control. Use these files for API credential names and `BASE_URL`. Runtime and OS control keys such as `PATH`, `K6_*`, proxy settings, certificate overrides, and Go runtime options are rejected.

## Authentication

Authentication reads credentials by variable name. Configure the environment default, then optionally override `auth` for an individual endpoint.

| Type | Configuration |
| --- | --- |
| Public endpoint | `{"type":"none"}` |
| Bearer token | `{"type":"bearer","tokenEnv":"API_TOKEN"}` |
| API key | `{"type":"api-key","keyEnv":"API_KEY","header":"X-API-Key"}` |
| Basic | `{"type":"basic","usernameEnv":"API_USERNAME","passwordEnv":"API_PASSWORD"}` |

Sensitive payload fields and variables must use one complete `{{env.NAME}}` or `{{vars.name}}` reference. Do not append literal credential fragments. Explicit Authorization headers can add a supported `Bearer`, `Basic`, `Token`, or `ApiKey` prefix to one complete reference; put complete cookie strings in a referenced environment value.

If `header` is omitted for API-key authentication, the default is `X-API-Key`. Use HTTPS and credentials scoped to your test tenant. Obtain or rotate short-lived bearer tokens outside the load runner, or configure an API-specific login endpoint in a journey. Built-in OAuth grant negotiation and periodic token refresh are not provided.

## API catalogs

Catalog endpoint keys are stable names used by suites and metric tags. They should describe an operation, such as `createItem`, so a path version change does not split your historical series.

```json
{
  "name": "example",
  "endpoints": {
    "createItem": {
      "method": "POST",
      "path": "/v2/items",
      "bodyType": "json",
      "bodyFile": "payloads/items/create.json",
      "expect": {
        "statuses": [201],
        "json": [
          {"path": "id", "exists": true},
          {"path": "name", "equals": "{{data.name}}"}
        ]
      },
      "extract": {"itemId": "id"},
      "thresholds": {
        "duration": ["p(95)<300", "p(99)<800"],
        "failed": ["rate<0.01"]
      }
    },
    "readItem": {
      "method": "GET",
      "path": "/v2/items/{{vars.itemId}}",
      "query": {"include": "details"},
      "expect": {"statuses": [200]}
    }
  }
}
```

Supported methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS. Each endpoint has a leading-slash relative `path`; absolute URLs and protocol-relative paths are rejected. Put query parameters in `query`, where values are encoded separately. Do not put credentials or personal data in query strings.

Endpoints support an optional timeout, non-secret headers, per-endpoint authentication, inline `body` or workspace-relative `bodyFile`, expectations, extraction, and latency/error thresholds. Use one body source. Choose `bodyType` deliberately; JSON is the normal API case.

`expect.statuses` defines successful HTTP statuses, including expected 4xx responses for negative tests. `expect.json` can assert that a dot-separated JSON path exists or equals a templated value. `expect.headers` can check expected response headers. `extract` maps workflow variable names to dot-separated response paths, for example `{"accessId":"data.id"}`.

Assertions verify API behavior, while profile and endpoint thresholds define performance gates. A fast response with an incorrect body still fails the workflow.

## Login and response-correlated authentication

A journey can call your login API and use its response token for later requests. Adapt the request fields and response path to your contract:

```json
{
  "login": {
    "method": "POST",
    "path": "/auth/login",
    "auth": {"type": "none"},
    "bodyType": "json",
    "body": {
      "username": "{{env.API_USERNAME}}",
      "password": "{{env.API_PASSWORD}}"
    },
    "expect": {"statuses": [200]},
    "extract": {"accessToken": "access_token"}
  },
  "account": {
    "method": "GET",
    "path": "/account",
    "auth": {"type": "none"},
    "headers": {"Authorization": "Bearer {{vars.accessToken}}"},
    "expect": {"statuses": [200]}
  }
}
```

Place these definitions inside a catalog's `endpoints` object and put `login` before `account` in a journey suite. `auth: none` suppresses inherited automatic authentication; an explicitly configured endpoint header still applies. Tokens remain in that iteration's memory, and credentials enter through environment references. A login every iteration increases authentication traffic and changes the workload: choose this only when it represents the flow you intend to measure.

Initial environment/suite variables may reference environment values, dataset fields, and runtime values. Use step variables or extraction for values defined by earlier requests; initial variable definitions cannot depend circularly on other initial variables.

## Payload templates and test data

The included payload template is:

```json
{
  "name": "{{data.name}}",
  "quantity": "{{data.quantity}}",
  "reference": "{{runtime.uuid}}"
}
```

A dataset file contains a nonempty JSON array of records:

```json
[
  {"name": "Performance sample A", "quantity": 1},
  {"name": "Performance sample B", "quantity": 3}
]
```

Records are reused across iterations; they are not a one-time pool of reserved users. Use a generated UUID or run marker for values that must be unique. The included records are synthetic; use your test tenant's own synthetic data for real APIs.

| Placeholder | Source |
| --- | --- |
| `{{env.NAME}}` | Approved, referenced environment variable |
| `{{vars.name}}` | Environment, suite, step, or extracted workflow variable |
| `{{data.name}}` | Selected dataset record |
| `{{runtime.uuid}}` | Unique identifier for the iteration |
| `{{runtime.timestamp}}` | Runtime timestamp |
| `{{runtime.vu}}` | k6 virtual-user identifier |
| `{{runtime.iteration}}` | Current iteration identifier |
| `{{runtime.runId}}` | Current run identifier |

A string containing only one placeholder retains the source value's scalar type. Thus `"{{data.quantity}}"` becomes `1`, not `"1"`. A placeholder embedded in a larger string becomes text. Avoid encoding substitutions yourself: request path/query interpolation handles encoding.

Missing placeholder values fail immediately. Successful response extraction applies only to the current journey iteration, preventing IDs from leaking between virtual users or later journeys.

## Journey suites

A journey sends ordered requests and shares extracted values within that iteration:

```json
{
  "name": "crud",
  "mode": "journey",
  "steps": [
    {"endpoint": "health"},
    {"endpoint": "createItem"},
    {"endpoint": "readItem"},
    {"endpoint": "updateItem"}
  ],
  "cleanup": [{"endpoint": "deleteItem"}],
  "datasetFile": "data/items.json",
  "variables": {},
  "thinkTime": 0.1
}
```

`thinkTime` is seconds after successful main requests. Step-specific `variables` can override named values for a request. A failure ends the main journey. Optional `cleanup` steps run in a best-effort final phase, including after a main-step failure when the required extracted IDs are available. Cleanup cannot recover an unknown server-created ID or run after the process is forcibly stopped. Use a dedicated test tenant and an independent cleanup process for data that persists in your API.

## Weighted suites

Weighted mode selects one independent endpoint per iteration:

```json
{
  "name": "read_mix",
  "mode": "weighted",
  "steps": [
    {"endpoint": "health", "weight": 1},
    {"endpoint": "searchItems", "weight": 9}
  ],
  "variables": {},
  "thinkTime": 0.1
}
```

This example requires a `searchItems` endpoint in your catalog. Its weights mean approximately 10% health and 90% search over many iterations. Weighted operations cannot depend on another operation's extracted response variable; use a journey for create/read/update/delete chains.

## Workload profiles and thresholds

Profiles contain a named `scenario` and `thresholds`, using the framework's supported k6 executors. Arbitrary k6 options are rejected so runtime overrides cannot silently change load or disable controls.

A fixed arrival-rate profile looks like:

```json
{
  "name": "capacity",
  "scenario": {
    "executor": "constant-arrival-rate",
    "rate": 5,
    "timeUnit": "1s",
    "duration": "30s",
    "preAllocatedVUs": 5,
    "maxVUs": 15,
    "gracefulStop": "5s"
  },
  "thresholds": {
    "http_req_failed": ["rate<0.01"],
    "http_req_duration": ["p(95)<500", "p(99)<1000"],
    "checks": ["rate==1"],
    "workflow_failed": ["rate==0"],
    "workflow_requests": ["count>0"],
    "dropped_iterations": ["count==0"]
  }
}
```

Rate counts **iterations per time unit**. For the five-request CRUD journey, 5 completed journeys/second implies roughly 25 API requests/second when every step executes. Early failures change that ratio. Monitor actual request throughput and dropped iterations; do not equate VUs or scheduled iteration rate with successful request throughput.

Keep `dropped_iterations` thresholds on arrival-rate profiles. Set enough virtual users for the measured journey duration and monitor the load generator. The shipped defaults are low examples, not a capacity estimate or universal service objective. See [Grafana's executor models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/) and [threshold documentation](https://grafana.com/docs/k6/latest/using-k6/thresholds/).
