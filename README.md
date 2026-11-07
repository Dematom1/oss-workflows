# oss-workflows

Shared GitHub Actions workflows and presets for Dematom1 open-source repositories.
Callers outside Dematom1, including `dematom-labs/workflows`, use the same interface.

## Contribution checks interface

Reusable workflow: `.github/workflows/contribution-checks.yml`. Call it from a thin caller workflow that owns `pull_request` events and concurrency. Pin `uses` to this repository's full 40-character commit SHA. Pass `release-bot-login` as the exact release App bot login; leave it empty when no release-PR exemption is configured. The workflow emits terminal checks for PR title, no-mistakes attestation, and generated-file protection. It uses read-only permissions and does not check out caller code.

## Weekly release merge interface

Reusable workflow: `.github/workflows/merge-release.yml`. Pin `uses` to this repository's full 40-character commit SHA. Pass `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` explicitly as secrets. `dry-run` defaults to `true`; set it to `false` only for a scheduled release caller authorized to merge. The workflow scopes its App token to the calling repository and only merges the single eligible, fully green release-please PR after rechecking its identity and head SHA.

## Dependency verification interface

Reusable workflow: `.github/workflows/dependency-verify.yml`.
Renovate preset: `github>Dematom1/oss-workflows//renovate/axi#<SHA>`.
Renovate appends `.json` to the preset path. Both references use the same immutable commit SHA.

The preset waits three days after a release and schedules one non-major batch before 06:00 UTC on Monday.
Non-major updates share the batch. Major and replacement updates remain separate and require review.
Automerge depends on the caller repository's required checks and branch protection.
The preset does not change rulesets or add bypass actors.

The workflow accepts these inputs:

- `shared-script-ref`: required 40-character immutable SHA for this shared repository; use the same SHA as the reusable workflow and Renovate preset.
- `install-command`, `build-command`, `test-command`, `smoke-command`: required shell commands. Smoke tests must use real binaries without writes to external systems.
- `axi-verify-command`: defaults to empty with a visible not-yet-shipped placeholder. Set it when axi-verify is available.
- `provenance-command`: defaults to `npm audit signatures`. Invalid signatures fail verification. The workflow compares registry provenance for each changed package version: if the prior version had provenance, the new version must also; missing or unavailable metadata fails that comparison. When the prior version had no provenance, the package is named in a warning.
- `lockfile-path`: defaults to `package-lock.json`, relative to the repository root.
- `node-version`: defaults to `22`.
- `bisect-max-rounds`: defaults to `8`, allowed range 1 to 32 trials, including baseline and reduced-batch checks.
- `bisect-timeout-minutes`: defaults to `20`, allowed range 1 to 60 minutes.
- `diagnostic-command`: defaults to empty for the built-in npm bisect. The workflow header documents the custom adapter's environment and report format.
Command inputs are fixed by the caller's reviewed workflow and are never taken from PR metadata; dependency PRs cannot modify that workflow because scope rejects every other file. Execution jobs run only on `pull_request`, have read-only tokens, receive no secrets, and do not persist checkout credentials.
The reporting job has `contents: read` and `pull-requests: write`; it checks out only the trusted shared-tools repository at `shared-script-ref`, never caller code, and runs no dependency code.

Verification rejects authors other than `renovate[bot]`, forks, non-default targets, incomplete file lists, and changes outside `package.json`, `renovate.json`, and `lockfile-path`.
Previous filenames on renames receive the same scope check.
The caller uses `pull_request`, never `pull_request_target`, with no paths filter.

The built-in adapter supports npm lockfile version 3, including added and removed dependency paths, but not workspace links. Lockfile v2 requires a custom diagnostic command.
The built-in provenance policy currently requires npm lockfile v3; other package managers need a dedicated provenance adapter before this workflow can verify them. Provenance comparisons apply to version changes at paths present in both locks. The signature command still checks the installed dependencies, including additions.
The bounded npm diff appears in the sticky PR comment. Provenance downgrades and signature failures fail verification; packages never previously carrying provenance are named in the verification summary. Raw npm diff output is labeled untrusted, escaped as text, and capped at 30,000 characters with the omitted-character count reported.

Only `renovate/weekly-non-major` branches run automatic bounded bisect diagnosis.
Bisect restores exact base lock entries, reproduces the original failure, checks the baseline, isolates failures, and checks the reduced batch.
Interactions, prerequisite failures, unsupported locks, timeouts, and trial limits report an inconclusive result without splitting.
Bisect reports culprit package names but does not modify the PR. Automatic splitting is deferred until a dedicated split App is provisioned and the split lifecycle is implemented. Diagnosis never waives the failure; the PR must pass full verification.

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

The npm manager restriction keeps the pilot within the dependency-file allowlist.
The generic preset alone does not authorize Action or workflow updates through a dependency-only gate.

The caller's existing "PR must be raised via no-mistakes" check remains required.
Its dependency-only Renovate path must check the entire caller workflow's successful `pull_request` run on the current PR head SHA, repository, and workflow identity.
Skipped, stale, failed, cancelled, missing, or timed-out runs fail the gate. Other authors retain the signed no-mistakes path.
Ruleset changes belong to operations through Terraform on main, without a new bypass actor.

Adoption is limited to one pilot until its PR and first real Renovate result receive approval for rollout.

## Local checks

```sh
node --test test/dependency-workflow.check.mjs
actionlint .github/workflows/dependency-verify.yml
```

Tests use Node's standard library and temporary fixture repositories. No npm install is needed.
