import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contribution = await readFile(new URL("../.github/workflows/contribution-checks.yml", import.meta.url), "utf8");
const release = await readFile(new URL("../.github/workflows/merge-release.yml", import.meta.url), "utf8");

test("shared contribution checks are reusable and terminal", () => {
  assert.match(contribution, /workflow_call:/);
  for (const context of ["PR title", "PR must be raised via no-mistakes", "Generated files must not be hand-edited"]) {
    assert.ok(contribution.includes(context), `missing required check ${context}`);
  }
  assert.match(contribution, /if: \$\{\{ always\(\) \}\}/);
  assert.match(contribution, /release-bot-login/);
});

test("weekly release merge is scoped, guarded, and safe on schedules", () => {
  assert.match(release, /workflow_call:/);
  assert.match(release, /name=\$\{GITHUB_REPOSITORY#\*\/\}/);
  assert.match(release, /repositories: \$\{\{ steps\.repository\.outputs\.name \}\}/);
  assert.match(release, /DRY_RUN !== 'false'/);
  assert.match(release, /current\.head\.sha !== sha/);
  assert.match(release, /merge_method: 'squash'/);
});
