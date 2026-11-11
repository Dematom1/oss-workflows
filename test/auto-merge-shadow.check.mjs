import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const { evaluatePolicy, parseSnapshot } = require("../scripts/auto-merge-policy.cjs");
const source = fs.readFileSync(new URL("../scripts/auto-merge-policy.cjs", import.meta.url), "utf8");
const blobSHA = createHash("sha1").update(`blob ${Buffer.byteLength(source)}\0${source}`).digest("hex");
const workflow = JSON.parse(execFileSync("ruby", ["-rpsych", "-rjson", "-e", "puts JSON.generate(Psych.load_file(ARGV[0], permitted_classes: [], aliases: false))", new URL("../.github/workflows/auto-merge-shadow.yml", import.meta.url).pathname], { encoding: "utf8" }));
const input = {
  repo: { owner: "example", repo: "project" },
  pr: {
    head: { sha: "1".repeat(40), repo: { full_name: "example/project" } },
    base: { sha: "2".repeat(40) },
    author_association: "OWNER", changed_files: 1, additions: 2, deletions: 0,
    body: `<!-- no-mistakes-pipeline-attestation:v1 ${JSON.stringify({
      head_sha: "1".repeat(40),
      steps: ["review", "test", "document"].map(step => ({ step, status: "completed" })),
      live_validation: { verdict: "go" },
    })} -->`,
  },
  files: [{ filename: "ordinary.txt" }],
};

async function execute({ number = 0, snapshot = JSON.stringify(input), changed = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-check-"));
  const outputs = {};
  const summary = [];
  let reads = 0;
  const github = {
    rest: {
      pulls: {
        get: async args => {
          assert.equal(args.pull_number, number);
          reads++;
          return { data: changed && reads > 1 ? { ...input.pr, head: { sha: "3".repeat(40) } } : input.pr };
        },
        listFiles: "files",
      },
      git: { getBlob: async args => {
        assert.equal(args.file_sha, blobSHA, "workflow must pin the current module blob");
        return { data: { content: Buffer.from(source).toString("base64") } };
      } },
    },
    paginate: async (endpoint, args) => {
      assert.equal(endpoint, "files");
      assert.equal(args.per_page, 100);
      return input.files;
    },
  };
  const core = {
    setOutput(key, value) { outputs[key] = value; }, info() {},
    summary: { addHeading() { return this; }, addRaw(value) { summary.push(value); return this; }, async write() {} },
  };
  try {
    for (const step of workflow.jobs.shadow.steps) {
      const env = { RUNNER_TEMP: directory, PR_NUMBER: String(number), SNAPSHOT: snapshot, SNAPSHOT_FILE: outputs.file };
      await runInNewContext(`(async () => { ${step.with.script}\n })()`, {
        github, core, context: { repo: input.repo }, require, Buffer, process: { env },
      });
    }
    assert.equal(fs.existsSync(outputs.file), false, "snapshot is removed after evaluation");
    return { result: JSON.parse(outputs.result), summary: summary.join(""), reads };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("snapshot path runs without a PR event or PR API calls and returns advisory structured output", async () => {
  assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "read" });
  const actual = await execute();
  assert.equal(actual.reads, 0);
  assert.deepEqual(actual.result, evaluatePolicy(input));
  assert.match(actual.summary, /F-07–F-09 and infra eligibility are not evaluated/);
  assert.deepEqual(actual.result.notEvaluated, ["F-07", "F-08", "F-09", "infra eligibility"]);
});

test("PR number path fetches independently of event payload and matches snapshot", async () => {
  const actual = await execute({ number: 7, snapshot: "" });
  assert.equal(actual.reads, 2);
  assert.deepEqual(actual.result, evaluatePolicy(input));
});

test("rejects ambiguous input, invalid snapshots, foreign repo, and moving PR", async () => {
  for (const options of [
    { snapshot: "" }, { number: 7 }, { number: -1 }, { number: 1.5 },
    { snapshot: "{" }, { snapshot: "null" }, { snapshot: "{}" },
    { snapshot: JSON.stringify({ ...input, repo: { owner: "other", repo: "project" } }) },
    { number: 7, snapshot: "", changed: true },
  ]) await assert.rejects(execute(options));
});

test("snapshot requires immutable identity and typed policy fields, without hiding count or rename flags", () => {
  for (const change of [
    { head: { ...input.pr.head, sha: "main" } }, { changed_files: "1" },
    { additions: -1 }, { author_association: null }, { body: {} },
  ]) assert.throws(() => parseSnapshot(JSON.stringify({ ...input, pr: { ...input.pr, ...change } })));
  for (const files of [null, [{}], [{ filename: "x", previous_filename: 1 }]]) {
    assert.throws(() => parseSnapshot(JSON.stringify({ ...input, files })));
  }
  for (const files of [[], [{ filename: "ordinary.txt", previous_filename: ".github/workflows/old.yml" }]]) {
    const result = evaluatePolicy(parseSnapshot(JSON.stringify({ ...input, files })));
    assert.equal(result.flags[0].id, "F-02");
  }
});
