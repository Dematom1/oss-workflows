import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { evaluatePolicy, parseSnapshot } = require("../scripts/auto-merge-policy.cjs");
const source = readFileSync(new URL("../scripts/auto-merge-policy.cjs", import.meta.url), "utf8");
const legacy = readFileSync(new URL("fixtures/auto-merge-policy-legacy.txt", import.meta.url), "utf8");
const blobSHA = createHash("sha1").update(`blob ${Buffer.byteLength(source)}\0${source}`).digest("hex");
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
    rest: {
      pulls: { get: async () => ({ data: live }), listFiles: "files" },
      git: { getBlob: async args => {
        assert.deepEqual(JSON.parse(JSON.stringify(args)), { owner: "Dematom1", repo: "oss-workflows", file_sha: blobSHA });
        return { data: { content: Buffer.from(source).toString("base64") } };
      } },
    },
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
  const context = { repo: { owner: "example", repo: "project" }, payload: { pull_request: { number: 7, body: "stale event" } } };
  await runInNewContext(`(async () => { ${job.steps[0].with.script}\n })()`, { github, core, context, Buffer });
  const actual = reports.join("\n");
  reports.length = 0;
  await runInNewContext(`(async () => { ${legacy}\n })()`, { github, core, context });
  assert.equal(actual, reports.join("\n"), "existing callers retain the legacy summary exactly");
  const result = evaluatePolicy({ repo: context.repo, pr: live, files });
  assert.equal(actual.split("\n")[0], result.verdict);
  assert.equal(result.wouldMerge, result.flags.length === 0);
  assert.ok(result.flags.every(flag => /^F-0[1-6]$/.test(flag.id) && flag.reason));
  return actual;
}

test("clear PR at the size cap is advisory yes with read-only permissions", async () => {
  assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "read" });
  assert.match(await execute(), /would merge itself: yes, because no flags/);
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
  for (const filename of [".github/workflows/ci.yml", "release-please-config.json", ".release-please-manifest.json", "renovate.json", "renovate.json5", ".renovaterc", ".renovaterc.json", ".renovaterc.yml", ".renovaterc.yaml", "renovate/axi.json", "package-lock.json", "nested/yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "go.sum", "Cargo.lock", "Gemfile.lock", "poetry.lock", "uv.lock", "composer.lock", "Pipfile.lock"]) {
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

test("F-05: any nonempty test override representation is flagged", async () => {
  for (const override_reason of ["approved failure", true, { reason: "approved" }]) {
    const steps = attestation.steps.map(step => step.step === "test" ? { ...step, override_reason } : step);
    assert.match(await execute({ body: body({ ...attestation, steps }) }), /because F-05/);
  }
});

test("F-06: live validation must explicitly say go", async () => {
  for (const live_validation of [undefined, null, {}, { verdict: "no-go" }, { verdict: "GO" }]) {
    assert.match(await execute({ body: body({ ...attestation, live_validation }) }), /because F-06/);
  }
});

test("reports multiple flags without failing", async () => {
  assert.match(await execute({ author_association: "NONE", additions: 501, body: null }, [{ filename: ".github/action.yml" }]), /because F-01.*F-02.*F-03.*F-04.*F-06/);
});

test("normalized recorded metadata retains legacy parity and snapshot results", async () => {
  // Three merged upstream cases; prose/identities are removed, paths retain
  // policy categories, and current/stale SHA relationships are preserved.
  const fixtures = JSON.parse(readFileSync(new URL("fixtures/auto-merge-policy-recorded.json", import.meta.url), "utf8"));
  for (const input of fixtures) {
    await execute(input.pr, input.files);
    assert.deepEqual(evaluatePolicy(parseSnapshot(JSON.stringify(input))), evaluatePolicy(input));
  }
});

test("preserves duplicate-step, first-marker, and empty override semantics", async () => {
  for (const override_reason of ["", null]) {
    const steps = attestation.steps.map(step => ({ ...step, override_reason }));
    assert.match(await execute({ body: body({ ...attestation, steps }) }), /would merge itself: yes/);
  }
  for (const override_reason of [false, 0, []]) {
    const steps = attestation.steps.map(step => ({ ...step, override_reason }));
    assert.match(await execute({ body: body({ ...attestation, steps }) }), /because F-05/);
  }
  const steps = [...attestation.steps, { step: "test", status: "failed" }];
  assert.match(await execute({ body: body({ ...attestation, steps }) }), /because F-04/);
  assert.match(await execute({ body: body(null) + body(attestation) }), /because F-04/);
});
