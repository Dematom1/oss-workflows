import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import test from "node:test";

const root = new URL("..", import.meta.url);
const parse = file => JSON.parse(execFileSync("ruby", ["-rpsych", "-rjson", "-e", "puts JSON.generate(Psych.load_file(ARGV[0], permitted_classes: [], aliases: false))", new URL(file, root).pathname], { encoding: "utf8" }));
const contribution = parse(".github/workflows/contribution-checks.yml");
const release = parse(".github/workflows/merge-release.yml");
const on = workflow => workflow.on ?? workflow[true];
const script = release.jobs.merge.steps.find(step => step.with?.script).with.script;

const pr = {
  number: 7,
  html_url: "https://github.com/example/project/pull/7",
  state: "open",
  draft: false,
  title: "chore(main): release project 1.2.3",
  user: { type: "Bot", login: "release-app[bot]" },
  base: { ref: "main" },
  head: {
    ref: "release-please--branches--main",
    sha: "reviewed-head",
    repo: { full_name: "example/project" },
  },
};

async function execute(mergeability) {
  let pullFetches = 0;
  const reports = [];
  const delays = [];
  let mergeCalls = 0;
  const github = {
    rest: {
      pulls: { list: "pulls", get: async () => ({ data: mergeability[pullFetches++] ?? pr }) },
      checks: { listForRef: "checks" },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [], total_count: 0 } }) },
    },
    paginate: async endpoint => endpoint === "pulls" ? [pr] : [{ status: "completed", conclusion: "success" }],
  };
  const core = {
    info() {},
    setFailed(message) { throw new Error(message); },
    summary: { addHeading() { return this; }, addRaw(message) { reports.push(message); return this; }, async write() {} },
  };
  await runInNewContext(`(async () => { ${script}\n })()`, {
    github,
    core,
    context: { repo: { owner: "example", repo: "project" } },
    fetch() { mergeCalls++; throw new Error("dry run must not call merge API"); },
    process: { env: { RELEASE_AUTHOR: "release-app[bot]", DRY_RUN: "true", GITHUB_API_URL: "https://api.github.com", RELEASE_TOKEN: "fixture" } },
    setTimeout(callback, milliseconds) { delays.push(milliseconds); callback(); return 0; },
  });
  return { pullFetches, reports: reports.join("\n"), delays, mergeCalls };
}

test("shared workflows expose caller contracts", () => {
  assert.ok(on(contribution)?.workflow_call);
  assert.equal(on(contribution).workflow_call.inputs["release-bot-login"].type, "string");
  assert.equal(contribution.permissions["pull-requests"], "read");
  assert.deepEqual(Object.keys(contribution.jobs).sort(), ["classify", "generated-files", "no-mistakes", "title"]);
  assert.ok(on(release)?.workflow_call);
  assert.equal(on(release).workflow_call.inputs["dry-run"].default, true);
  assert.deepEqual(on(release).workflow_call.secrets, { RELEASE_APP_ID: { required: true }, RELEASE_APP_PRIVATE_KEY: { required: true } });
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

test("re-polls mergeability, then dry-runs only after it resolves", async () => {
  const result = await execute([pr, { ...pr, mergeable: null }, { ...pr, mergeable: null }, { ...pr, mergeable: true, mergeable_state: "clean" }]);
  assert.equal(result.pullFetches, 4);
  assert.deepEqual(result.delays, [3000, 3000]);
  assert.match(result.reports, /Dry run: would squash/);
  assert.equal(result.mergeCalls, 0);
});

test("leaves unresolved mergeability inconclusive without attempting a merge", async () => {
  const result = await execute([pr, ...Array.from({ length: 5 }, () => ({ ...pr, mergeable: null }))]);
  assert.equal(result.pullFetches, 6);
  assert.deepEqual(result.delays, [3000, 3000, 3000, 3000]);
  assert.match(result.reports, /has not finished computing mergeability/);
  assert.doesNotMatch(result.reports, /mergeable=null/);
  assert.equal(result.mergeCalls, 0);
});
