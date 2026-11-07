import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = new URL("..", import.meta.url);
const parse = file => JSON.parse(execFileSync("ruby", ["-rpsych", "-rjson", "-e", "puts JSON.generate(Psych.load_file(ARGV[0], permitted_classes: [], aliases: false))", new URL(file, root).pathname], { encoding: "utf8" }));
const contribution = parse(".github/workflows/contribution-checks.yml");
const release = parse(".github/workflows/merge-release.yml");

test("shared workflows expose their caller contracts", () => {
  assert.ok(contribution["on"]?.workflow_call ?? contribution[true]?.workflow_call);
  assert.equal((contribution["on"] ?? contribution[true]).workflow_call.inputs["release-bot-login"].type, "string");
  assert.equal(contribution.permissions["pull-requests"], "read");
  assert.deepEqual(Object.keys(contribution.jobs).sort(), ["classify", "generated-files", "no-mistakes", "title"]);
  assert.ok(release["on"]?.workflow_call ?? release[true]?.workflow_call);
  assert.equal((release["on"] ?? release[true]).workflow_call.inputs["dry-run"].default, true);
  assert.deepEqual((release["on"] ?? release[true]).workflow_call.secrets, { RELEASE_APP_ID: { required: true }, RELEASE_APP_PRIVATE_KEY: { required: true } });
  assert.equal(release.permissions.contents, "read");
});

test("scheduled token scope resolves to the fixture repository", () => {
  const step = release.jobs.merge.steps.find(step => step.id === "repository");
  const output = execFileSync("bash", ["-c", step.run], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_REPOSITORY: "fixture-owner/fixture-repository", GITHUB_OUTPUT: "/dev/stdout" },
  });
  const name = output.match(/^name=(.+)$/m)?.[1];
  assert.equal(name, "fixture-repository");
  assert.notEqual(name, "");
  assert.notEqual(name, "*");
  assert.equal(release.jobs.merge.steps.find(step => step.id === "app").with.repositories, "${{ steps.repository.outputs.name }}");
});
