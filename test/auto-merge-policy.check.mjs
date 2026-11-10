import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import test from "node:test";

const workflow = JSON.parse(execFileSync("ruby", ["-rpsych", "-rjson", "-e", "puts JSON.generate(Psych.load_file(ARGV[0], permitted_classes: [], aliases: false))", new URL("../.github/workflows/contribution-checks.yml", import.meta.url).pathname], { encoding: "utf8" }));
const attestation = {
  head_sha: "current-head",
  steps: ["review", "test", "document"].map(step => ({ step, status: "completed" })),
  live_validation: { verdict: "go", live: 1, total: 1 },
};
const body = value => `<!-- no-mistakes-pipeline-attestation:v1 ${JSON.stringify(value)} -->`;
const pr = {
  head: { sha: "current-head", repo: { full_name: "example/project" } },
  author_association: "OWNER", changed_files: 1, additions: 250, deletions: 250,
  body: body(attestation),
};

async function execute(overrides = {}, files = [{ filename: "src/main.go" }]) {
  const job = workflow.jobs["auto-merge-policy"];
  assert.ok(job, "shadow auto-merge policy job must exist");
  const reports = [];
  const live = { ...pr, ...overrides };
  const github = {
    rest: { pulls: { get: async () => ({ data: live }), listFiles: "files" } },
    paginate: async (endpoint, args) => {
      assert.equal(endpoint, "files");
      assert.equal(args.per_page, 100);
      return files;
    },
  };
  const core = {
    info() {},
    setFailed() { assert.fail("shadow verdict must never fail the PR"); },
    summary: { addHeading() { return this; }, addRaw(value) { reports.push(value); return this; }, async write() {} },
  };
  await runInNewContext(`(async () => { ${job.steps[0].with.script}\n })()`, {
    github, core, context: { repo: { owner: "example", repo: "project" }, payload: { pull_request: { number: 7, body: "stale event" } } },
  });
  return reports.join("\n");
}

test("clear PR at the size cap is advisory yes with read-only permissions", async () => {
  assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "read" });
  assert.match(await execute(), /would merge itself: yes, because no flags/);
  const job = workflow.jobs["auto-merge-policy"];
  assert.equal(job.needs, undefined);
  assert.equal(job.steps.length, 1);
  assert.match(job.steps[0].uses, /^actions\/github-script@[a-f0-9]{40}$/);
});

test("F-01: fork, deleted head repository, or untrusted association", async () => {
  for (const overrides of [
    { head: { ...pr.head, repo: { full_name: "outsider/project" } } },
    { head: { ...pr.head, repo: null } },
    { author_association: "CONTRIBUTOR" },
  ]) assert.match(await execute(overrides), /would merge itself: no, because F-01/);
  for (const author_association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.match(await execute({ author_association }), /would merge itself: yes/);
  }
});

test("F-02: sensitive paths, including old rename paths, and incomplete file lists", async () => {
  for (const filename of [".github/workflows/ci.yml", "release-please-config.json", ".release-please-manifest.json", "renovate.json", "renovate.json5", ".renovaterc", ".renovaterc.json", "renovate/axi.json", "package-lock.json", "nested/yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "go.sum", "Cargo.lock", "Gemfile.lock", "poetry.lock", "uv.lock", "composer.lock", "Pipfile.lock"]) {
    assert.match(await execute({}, [{ filename }]), /would merge itself: no, because F-02/, filename);
    assert.match(await execute({}, [{ filename: "ordinary.txt", previous_filename: filename }]), /because F-02/, filename);
  }
  assert.match(await execute({ changed_files: 2 }), /because F-02/);
});

test("F-03: added plus deleted lines exceeds 500", async () => {
  assert.match(await execute({ additions: 251 }), /would merge itself: no, because F-03/);
});

test("F-04: missing, malformed, stale, or incomplete attestation", async () => {
  for (const value of [null, [], {}, { ...attestation, head_sha: "old-head" }, { ...attestation, steps: null }, { ...attestation, steps: [null] }, { ...attestation, steps: [] }]) {
    assert.match(await execute({ body: body(value) }), /would merge itself: no, because .*F-04/);
  }
  for (const value of [null, "", "<!-- no-mistakes-pipeline-attestation:v1 broken -->", "<!-- no-mistakes-pipeline-attestation:v1 {}"])
    assert.match(await execute({ body: value }), /because .*F-04/);
});

test("F-05: test override is flagged even with repository opt-in", async () => {
  const steps = attestation.steps.map(step => step.step === "test" ? { ...step, override_reason: "approved failure" } : step);
  assert.match(await execute({ body: body({ ...attestation, steps, allow_test_command_override: "opted in" }) }), /because F-05/);
});

test("F-06: live validation must explicitly say go", async () => {
  for (const live_validation of [undefined, null, {}, { verdict: "no-go" }, { verdict: "GO" }]) {
    assert.match(await execute({ body: body({ ...attestation, live_validation }) }), /because F-06/);
  }
});

test("reports multiple flags without failing", async () => {
  assert.match(await execute({ author_association: "NONE", additions: 501, body: null }, [{ filename: ".github/action.yml" }]), /because F-01.*F-02.*F-03.*F-04.*F-06/);
});
