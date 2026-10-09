# Security and operational controls

The framework defaults to localhost. Remote targets require HTTPS with certificate verification and an exact environment host allowlist. It resolves credentials at runtime by variable name. These controls reduce accidental exposure; your operating system, CI environment, API access controls, and network rules remain part of the security boundary.

## Credentials and files

Use scoped, short-lived credentials for a dedicated test account or tenant. Inject secrets through the process environment or a secret manager in CI. Ignored `.env.<environment>.local` and `.env` files are convenient locally; they remain plaintext files and need appropriate local permissions.

Never put tokens, passwords, private keys, session cookies, or production personal data in tracked configuration, fixtures, datasets, screenshots, or issue comments. The example files contain no real credentials. The ignore rules cover dotenv files, common private-key formats, generated inputs, reports, and downloaded tools. Ignore rules do not remove files that were previously tracked; check repository changes before publishing.

Authentication configuration stores only credential environment-variable names. The runner does not print request or response bodies or authentication values. Reports, including the Excel workbook, contain aggregate measurements and stable operation names. Check and threshold labels should remain static and free of secrets.

The ignored `results/<year>/<month>/<date>/<run-folder>/metadata/manifest.json` run input contains configuration and dataset material. Treat it as private, keep datasets synthetic, and do not upload generated bundles. Run history indexes, latest pointers, and `metadata/run.json` contain run identity, timing, status, and aggregate report links rather than request data or credentials. Reports can reveal endpoint naming and timing; limit artifact access and retention. Individual JSON configuration, payload, and dataset inputs are limited to 2 MiB; the combined execution manifest has a 64 MiB limit checked before the run starts.

Migration preserves older flat result folders under ignored `.tools/legacy-results-backup/`. These original folders may contain private manifests and dataset material. Keep them local and apply the same access controls as the live manifests.

The standalone Excel exporter reads normalized aggregate summaries and public run metadata for result discovery. It does not load dotenv files or generated manifests. Export paths must remain inside the project's generated result roots, symbolic links are rejected, and inputs are bounded to 2 MiB. Workbook labels are written as text, not formulas; the workbook contains no macros or external connections. Keep static endpoint, check, and threshold labels free of sensitive values because aggregate artifacts still reveal operation names and test outcomes.

## Target and request controls

- HTTPS is required for remote hosts; insecure TLS verification is not available.
- HTTP is allowed only for explicitly opted-in loopback environments.
- Targets must match exact `allowedHosts` entries.
- Endpoint URLs are relative paths; redirects are disabled so credentials cannot follow a redirect to another origin.
- Request timeouts and validated workload profiles bound routine runs.
- Production environments require `production: true` and the CLI's explicit `--allow-production` flag.
- The CLI passes only referenced API environment values and OS necessities to k6 and uses an explicit clean k6 configuration. Proxy, certificate, runtime, and k6 option variables cannot be referenced as credentials; dotenv files cannot replace OS settings.
- HTTP body/debug logging and arbitrary ambient k6 option overrides are disabled by the controlled execution path.
- Load requests are not automatically retried. Retrying a write could duplicate data and distort error rates.

The production flag is an operational guard, not host classification. Mark every production configuration correctly and keep production credentials out of staging environments. Host allowlists are not a DNS or network firewall; administrators should restrict outbound traffic when testing requires a stricter boundary.

Run through `npm run perf -- ...` to apply these controls. Calling k6 directly with custom scripts or editing the framework can bypass them, so protect changes to `src/`, `scripts/`, config, and workflows in code review.

## Test data and cleanup

The sample CRUD workflow includes a best-effort cleanup phase that attempts to delete its created item even after a later main-step failure. A missing extracted ID, failed deletion, or forcibly interrupted process may leave an item behind. Use a test namespace, unique references, quotas, and cleanup owned by your API team. Do not interpret a cleanup step as a transactional rollback.

Before staging stress, spike, soak, or capacity tests, agree on the target, maximum load, duration, observability, and stop conditions with its operator. Begin with smoke; increase load using evidence from application and generator metrics. This project does not contact a real API during setup.

## GitHub Actions

The local CI workflow uses read-only repository permissions and never needs API secrets. It runs against a temporary loopback mock. The real staging workflow is manually triggered, restricted to the repository default branch, and references the GitHub `staging` environment. Configure required reviewers and deployment-branch restrictions in your repository settings before using it.

Workflow actions use full verified commit hashes. Dependabot proposes updates; review action changes and update the tested k6 version deliberately. Checkout avoids persisting Git credentials. Artifact uploads include only report Excel, HTML, summary JSON, JUnit XML, public `metadata/run.json`, history indexes, and latest pointers, with seven-day retention. Credentials, private `metadata/manifest.json`, and legacy backup folders are never selected for upload.

The workflow definition cannot create GitHub environment protections or guarantee your API's test authorization. Those controls must be configured by the repository and service owners. See [GitHub's secure use reference](https://docs.github.com/en/actions/reference/security/secure-use).
