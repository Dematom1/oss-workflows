# oss-workflows

Shared GitHub Actions workflows and presets for Dematom1 open-source repositories.
Callers outside Dematom1, including `dematom-labs/workflows`, use the same interface.

## Contribution checks interface

Reusable workflow: `.github/workflows/contribution-checks.yml`. Call it from a thin caller workflow that owns `pull_request` events and concurrency. Include `opened`, `synchronize`, `reopened`, and `edited` so title/body edits rerun checks. Pin `uses` to this repository's full 40-character commit SHA. Pass `release-bot-login` as the exact release App bot login; leave it empty when no release-PR exemption is configured. The workflow emits terminal checks for PR title, no-mistakes attestation, and generated-file protection. It uses read-only permissions and does not check out caller code. The caller must grant at least `contents: read` and `pull-requests: read`.

## Weekly release merge interface

Reusable workflow: `.github/workflows/merge-release.yml`. Pin `uses` to this repository's full 40-character commit SHA. Pass `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` explicitly as secrets, and grant the caller `contents: read`, `pull-requests: read`, `checks: read`, and `statuses: read` permissions. `dry-run` defaults to `true`; set it to `false` only for a scheduled release caller authorized to merge. The workflow scopes its App token to the calling repository and only merges the single eligible, fully green release-please PR after rechecking its identity and head SHA.

## Dependency verification interface

Reusable workflow: `.github/workflows/dependency-verify.yml`.
Renovate presets: `github>Dematom1/oss-workflows//renovate/axi#<SHA>` for npm, or `github>Dematom1/oss-workflows//renovate/go#<SHA>` for Go.
Renovate appends `.json` to the preset path. Both references use the same immutable commit SHA.

The preset waits three days after a release and schedules one non-major batch before 06:00 UTC on Monday.
Non-major updates share the batch. Major and replacement updates remain separate and require review.
Automerge depends on the caller repository's required checks and branch protection.
The preset does not change rulesets or add bypass actors.

The workflow accepts these inputs:

- `ecosystem`: `npm` by default, or `go`. Other values fail scope validation. Go uses the repository-root `go.mod` and `go.sum`.
- `shared-script-ref`: required 40-character immutable SHA for this shared repository; use the same SHA as the reusable workflow and Renovate preset.
- `install-command`, `build-command`, `test-command`, `smoke-command`: required shell commands. Smoke tests must use real binaries without writes to external systems.
- `axi-verify-command`: defaults to empty with a visible not-yet-shipped placeholder. Set it when axi-verify is available.
- `provenance-command`: npm only, defaults to `npm audit signatures`. Invalid signatures fail verification. The workflow compares registry provenance for each changed package version: if the prior version had provenance, the new version must also; missing or unavailable metadata fails that comparison. When the prior version had no provenance, the package is named in a warning.
- `lockfile-path`: npm only, defaults to `package-lock.json`, relative to the repository root.
- `node-version`: defaults to `22`.
- `bisect-max-rounds`: defaults to `8`, allowed range 1 to 32 trials, including baseline and reduced-batch checks.
- `bisect-timeout-minutes`: defaults to `20`, allowed range 1 to 60 minutes.
- `diagnostic-command`: defaults to empty for the built-in npm bisect. The workflow header documents the custom adapter's environment and report format.
Command inputs are fixed by the caller's reviewed workflow and are never taken from PR metadata; dependency PRs cannot modify that workflow because scope rejects every other file. Execution jobs run only on `pull_request`, have read-only tokens, receive no secrets, and do not persist checkout credentials.
The reporting job has `contents: read` and `pull-requests: write`; it checks out only the trusted shared-tools repository at `shared-script-ref`, never caller code, and runs no dependency code.

Verification rejects authors other than `renovate[bot]`, forks, non-default targets, and incomplete file lists.
For npm, only `package.json`, `renovate.json`, and `lockfile-path` may change. For Go, only root `go.mod`, `go.sum`, and `renovate.json` may change.
Previous filenames on renames receive the same scope check.
The caller uses `pull_request`, never `pull_request_target`, with no paths filter.

The built-in adapter supports npm lockfile version 3, including added and removed dependency paths, but not workspace links. Lockfile v2 requires a custom diagnostic command.
The npm provenance policy requires npm lockfile v3; package managers other than npm and Go need a dedicated provenance adapter before this workflow can verify them. Provenance comparisons apply to version changes at paths present in both locks. The signature command still checks the installed dependencies, including additions.
The bounded npm diff appears in the sticky PR comment. Provenance downgrades and signature failures fail verification; packages never previously carrying provenance are named in the verification summary. Raw npm diff output is labeled untrusted, escaped as text, and capped at 30,000 characters with the omitted-character count reported.

Only npm `renovate/weekly-non-major` branches run automatic bounded bisect diagnosis.
Bisect restores exact base lock entries, reproduces the original failure, checks the baseline, isolates failures, and checks the reduced batch.
Interactions, prerequisite failures, unsupported locks, timeouts, and trial limits report an inconclusive result without splitting.
Bisect reports culprit package names but does not modify the PR. Automatic splitting is deferred until a dedicated split App is provisioned and the split lifecycle is implemented. Diagnosis never waives the failure; the PR must pass full verification.

### Go module verification

With `ecosystem: go`, the workflow sets up Go from the caller's `go.mod` without a shared dependency cache.
The trusted Go adapter uses Go's own parser to summarize requirement and replacement version changes from the base and head `go.mod`.
The summary appears in the diff artifact and the sticky PR comment, labeled as untrusted diagnostic text.

Before any caller command runs, the adapter downloads all modules into a fresh cache through `https://proxy.golang.org` with `GOSUMDB=sum.golang.org`.
This independent download omits the PR's `go.sum`, so a supplied checksum cannot bypass the checksum database.
The adapter then checks the downloaded modules against the caller's `go.sum` and runs `go mod verify`.
Private-module bypasses, direct fallback, workspace overrides, insecure hosts, and ambient Go configuration are disabled for these checks.
Versioned replacements use the same checks. Local replacements fail because the public checksum database cannot verify them.
The adapter installs `golang.org/x/vuln/cmd/govulncheck@v1.9.0` and runs `govulncheck ./...` in source mode.
Scanner installation permits Go's automatic toolchain download through the same verified proxy when the scanner requires a newer Go version.
Reachable vulnerabilities and scanner errors fail verification. Imported but unreachable vulnerabilities do not fail it.
Module verification and scanning use the caller's Go toolchain. Go bisect is not supported.

## Caller configuration

A caller workflow can use the following shape after replacing `<SHA>` with a published immutable commit:

```yaml
name: Dependency verification
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
jobs:
  dependencies:
    if: github.event.pull_request.user.login == 'renovate[bot]'
    uses: Dematom1/oss-workflows/.github/workflows/dependency-verify.yml@<SHA>
    with:
      shared-script-ref: <SHA>
      install-command: npm ci
      build-command: npm run build
      test-command: npm test
      smoke-command: npm run test:real
```

The caller's `renovate.json` extends the shared preset:

```json
{
  "extends": ["github>Dematom1/oss-workflows//renovate/axi#<SHA>"],
  "enabledManagers": ["npm"]
}
```

For a Go caller, use the same event, permissions, and immutable SHA with these inputs:

```yaml
with:
  shared-script-ref: <SHA>
  ecosystem: go
  install-command: go mod download
  build-command: go build ./...
  test-command: go test ./...
  smoke-command: go run ./cmd/example --help
```

Replace the smoke command with a read-only invocation of the caller's real binary.
The Go caller's `renovate.json` uses the Go preset:

```json
{
  "extends": ["github>Dematom1/oss-workflows//renovate/go#<SHA>"]
}
```

The Go preset limits updates to the `gomod` manager and sets `postUpdateOptions: ["gomodTidy"]`.
It uses the same release age, weekly schedule, grouping, and major-update review policy as the npm preset.

The npm manager restriction keeps the pilot within the dependency-file allowlist.
The generic preset alone does not authorize Action or workflow updates through a dependency-only gate.

The caller's existing "PR must be raised via no-mistakes" check remains required.
Its dependency-only Renovate path must check the entire caller workflow's successful `pull_request` run on the current PR head SHA, repository, and workflow identity.
Skipped, stale, failed, cancelled, missing, or timed-out runs fail the gate. Other authors retain the signed no-mistakes path.
Ruleset changes belong to operations through Terraform on main, without a new bypass actor.

Adoption is limited to one pilot until its PR and first real Renovate result receive approval for rollout.

## Local checks

```sh
node --test test/dependency-*.check.mjs
actionlint .github/workflows/dependency-verify.yml
```

Tests use Node's standard library and temporary fixture repositories. Go tests also need Go for native `go.mod` parsing.
Downloads and vulnerability checks use offline command fixtures. No npm install or network access is needed.
