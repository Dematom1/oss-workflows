# oss-workflows

Shared GitHub Actions workflows and presets for Dematom1 open-source repositories.
Callers outside Dematom1, including `dematom-labs/workflows`, use the same interface.

## Dependency verification interface

Reusable workflow: `.github/workflows/dependency-verify.yml`.
Renovate preset: `github>Dematom1/oss-workflows//renovate/axi#<SHA>`.
Renovate appends `.json` to the preset path. Both references use the same immutable commit SHA.

The preset waits three days after a release and schedules one non-major batch before 06:00 UTC on Monday.
All packages share the batch. Majors remain separate and require review.
Automerge depends on the caller repository's required checks and branch protection.
The preset does not change rulesets or add bypass actors.

The workflow accepts these inputs:

- `install-command`, `build-command`, `test-command`, `smoke-command`: required shell commands. Smoke tests must use real binaries without writes to external systems.
- `axi-verify-command`: defaults to empty with a visible not-yet-shipped placeholder. Set it when axi-verify is available.
- `provenance-command`: defaults to `npm audit signatures`. Invalid signatures or available provenance fail verification. Missing provenance produces warnings, not a claim of verified provenance.
- `lockfile-path`: defaults to `package-lock.json`, relative to the repository root.
- `node-version`: defaults to `22`.
- `bisect-max-rounds`: defaults to `8`, allowed range 1 to 32 trials, including baseline and reduced-batch checks.
- `bisect-timeout-minutes`: defaults to `20`, allowed range 1 to 60 minutes.
- `diagnostic-command`: defaults to empty for the built-in npm bisect. The workflow header documents the custom adapter's environment and report format.
- `auto-split`: defaults to `false`. Diagnosis still runs, but no split commit occurs.

The optional secret `RENOVATE_TOKEN` accepts an existing authorized automation App token or PAT with contents write permission.
When `auto-split` is true, an absent secret fails the reporting job with a clear error.
A `GITHUB_TOKEN` split commit cannot trigger fresh CI, so it is not a substitute.
The caller chooses the source secret and maps it to `RENOVATE_TOKEN`.

Execution jobs have read-only tokens and do not persist checkout credentials.
Only the reporting job has write permissions and access to `RENOVATE_TOKEN`. It has no checkout and runs no dependency code.
The caller grants `contents: write` and `pull-requests: write` for reporting and optional splitting.

Verification rejects authors other than `renovate[bot]`, forks, non-default targets, incomplete file lists, and changes outside `package.json`, `renovate.json`, and `lockfile-path`.
Previous filenames on renames receive the same scope check.
The caller uses `pull_request`, never `pull_request_target`, with no paths filter.

The built-in adapter supports npm lockfile versions 2 and 3, including transitive packages, but not workspace links.
Other lock formats require a custom diagnostic command and an appropriate provenance command.
A bounded npm diff and provenance report appear in the job summary and a sticky PR comment.

Only `renovate/weekly-non-major` branches can split automatically.
Bisect restores exact base lock entries, reproduces the original failure, checks the baseline, isolates failures, and checks the reduced batch.
Interactions, prerequisite failures, unsupported locks, timeouts, and trial limits report an inconclusive result without splitting.
A split changes only dependency files and adds Renovate rules that keep culprit packages separate with automerge disabled.
These rules take effect after the reduced batch merges. Fresh full verification on the split commit is required; diagnosis never waives the original failure.

## Caller configuration

A caller workflow can use the following shape after replacing `<SHA>` with a published immutable commit:

```yaml
name: Dependency verification
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: write
  pull-requests: write
jobs:
  dependencies:
    if: github.event.pull_request.user.login == 'renovate[bot]'
    uses: Dematom1/oss-workflows/.github/workflows/dependency-verify.yml@<SHA>
    with:
      install-command: npm ci
      build-command: npm run build
      test-command: npm test
      smoke-command: npm run test:real
      # auto-split remains false until an authorized token is selected.
    # To enable splitting, set auto-split: true above and map the chosen secret:
    # secrets:
    #   RENOVATE_TOKEN: ${{ secrets.EXISTING_AUTOMATION_TOKEN }}
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
