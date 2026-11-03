// Standalone: node --test test/dependency-workflow.check.mjs (no npm install needed).
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const enginePath = new URL("../scripts/dependency-engine.cjs", import.meta.url).pathname;
const { inventory, variant, isolate } = require(enginePath);
const scope = require("../scripts/dependency-scope.cjs");
const report = require("../scripts/dependency-report.cjs");
const { verifyTransitions, parseVersionMetadata, registryMetadata } = require("../scripts/dependency-provenance.cjs");

const lock = (versions) => ({
  lockfileVersion: 3,
  packages: {
    "": { dependencies: { alpha: "1.0.0", beta: "1.0.0", gamma: "1.0.0" } },
    ...Object.fromEntries(
      Object.entries(versions).map(([name, version]) => [
        `node_modules/${name}`,
        { version },
      ]),
    ),
  },
});
const fixtures = () => {
  const base = lock({ alpha: "1.0.0", beta: "1.0.0", gamma: "1.0.0" });
  const head = lock({ alpha: "1.1.0", beta: "1.1.0", gamma: "1.1.0" });
  head.packages[""].dependencies = {
    alpha: "1.1.0",
    beta: "1.1.0",
    gamma: "1.1.0",
  };
  return { base, head };
};

test("registry metadata distinguishes attestation absence from malformed or unavailable data", () => {
  const metadata = { name: "widget", version: "1.0.0", dist: { integrity: "sha512-fixture" } };
  assert.deepEqual(parseVersionMetadata(JSON.stringify(metadata), "widget", "1.0.0"), { provenance: null });
  assert.deepEqual(parseVersionMetadata(JSON.stringify({
    ...metadata, dist: { ...metadata.dist, attestations: { provenance: { url: "https://example.invalid" } } },
  }), "widget", "1.0.0"), { provenance: { url: "https://example.invalid" } });
  for (const invalid of ["{}", "null", JSON.stringify({ ...metadata, name: "other" }),
    JSON.stringify({ ...metadata, version: "2.0.0" }), JSON.stringify({ name: "widget", version: "1.0.0" })]) {
    assert.throws(() => parseVersionMetadata(invalid, "widget", "1.0.0"));
  }
  const childProcess = require("node:child_process");
  const original = childProcess.spawnSync;
  try {
    childProcess.spawnSync = () => ({ status: 1, stdout: "", error: new Error("registry unavailable") });
    assert.deepEqual(registryMetadata("widget", "1.0.0"), { error: true });
  } finally {
    childProcess.spawnSync = original;
  }
});

test("registry metadata requests only the fields needed for provenance", () => {
  const cp = require("node:child_process"), original = cp.spawnSync;
  try {
    cp.spawnSync = (_command, args) => {
      assert.deepEqual(args, ["view", "widget@1.0.0", "name", "version", "dist", "--json"]);
      return { status: 0, stdout: JSON.stringify({ name: "widget", version: "1.0.0", dist: { integrity: "sha512-fixture" } }) };
    };
    assert.deepEqual(registryMetadata("widget", "1.0.0"), { provenance: null });
  } finally { cp.spawnSync = original; }
});

test("provenance reuses metadata for repeated package versions in one verification", async () => {
  const entry = { before: { version: "1.0.0" }, after: { version: "2.0.0" } };
  const calls = [];
  await verifyTransitions(new Map([["widget", [entry, entry]]]), async (name, version) => {
    calls.push(`${name}@${version}`);
    return { provenance: {} };
  }, () => {});
  assert.deepEqual(calls, ["widget@1.0.0", "widget@2.0.0"]);
});

test("provenance policy rejects downgrades and unknown metadata, warns by package otherwise", async () => {
  const changes = new Map([["widget", [{
    before: { version: "1.0.0" }, after: { version: "2.0.0" },
  }]]]);
  const retained = await verifyTransitions(changes, async (_name, version) => ({
    provenance: version === "1.0.0" || version === "2.0.0" ? { attestations: [] } : null,
  }), () => {});
  assert.deepEqual(retained, []);

  await assert.rejects(verifyTransitions(changes, async (_name, version) => ({
    provenance: version === "1.0.0" ? { attestations: [] } : null,
  }), () => {}), /Provenance downgrade refused/);

  const warning = await verifyTransitions(changes, async () => ({ provenance: null }), () => {});
  assert.deepEqual(warning, ["widget: neither previously published version is required to have provenance"]);

  await assert.rejects(verifyTransitions(changes, async () => ({ error: true }), () => {}), /metadata unavailable/);
  await assert.rejects(verifyTransitions(changes, async () => ({ provenance: {} }), () => {
    throw new Error("npm audit signatures failed");
  }), /npm audit signatures failed/);
});

test("built-in inventory rejects npm v2 locks rather than changing lockfile format", () => {
  const { base, head } = fixtures();
  base.lockfileVersion = 2;
  assert.throws(() => inventory(base, head), /require npm lockfile v3/);
});

test("scope rejects non-Renovate authors, forbidden paths, renames and incomplete file lists", async () => {
  const pr = {
    number: 1,
    user: { login: "renovate[bot]", type: "Bot" },
    head: { repo: { full_name: "fixture/repo" } },
    base: { ref: "main" },
    changed_files: 1,
  };
  const check = (files, pullRequest = pr) =>
    scope({
      context: {
        eventName: "pull_request",
        repo: { owner: "fixture", repo: "repo" },
        payload: {
          pull_request: pullRequest,
          repository: { default_branch: "main" },
        },
      },
      process: {
        env: {
          LOCKFILE: "package-lock.json",
          MAX_ROUNDS: "8",
          TIMEOUT_MINUTES: "20",
          COMMANDS: JSON.stringify(
            Object.fromEntries(
              ["install", "build", "test", "smoke", "provenance"].map(
                (name) => [`${name}-command`, "true"],
              ),
            ),
          ),
        },
      },
      core: { setOutput: () => {} },
      github: {
        paginate: async () => files,
        rest: { pulls: { listFiles: {} } },
      },
    });
  await check([{ filename: "package-lock.json" }]);
  await assert.rejects(
    check([{ filename: ".github/workflows/ci.yml" }]),
    /dependency-only/,
  );
  await assert.rejects(
    check([{ filename: "package.json", previous_filename: "src/cli.ts" }]),
    /dependency-only/,
  );
  await assert.rejects(check([]), /incomplete/);
  await assert.rejects(
    check([{ filename: "package.json" }], {
      ...pr,
      user: { login: "human", type: "User" },
    }),
    /Renovate/,
  );
  await assert.rejects(
    check([{ filename: "package.json" }], {
      ...pr,
      head: { repo: { full_name: "fork/repo" } },
    }),
    /same-repository/,
  );
});

test("PR report validates culprits against large locks and does not render untrusted bisect messages", async () => {
  const comments = [];
  await report({
    require: (name) => name === "node:fs" ? {
      existsSync: () => true,
      statSync: () => ({ size: 100 }),
      readFileSync: (location) => JSON.stringify(location.includes("dependency-diff")
      ? { message: "<@everyone> malicious diff" }
      : { message: "Isolated beta", culprits: ["beta"], rounds: 4 }),
    } : require(name),
    process: { env: {
      ARTIFACTS: "/fixture", LOCKFILE: "package-lock.json",
      VERIFY_RESULT: "failure", BISECT_RESULT: "success",
    } },
    context: { repo: { owner: "fixture", repo: "repo" }, payload: {
      pull_request: { number: 1, head: { sha: "fixture" }, base: { sha: "base" } },
    } },
    core: { summary: { addRaw: () => ({ write: async () => {} }) } },
    github: {
      paginate: async () => [],
      rest: {
        repos: { getContent: async ({ path, ref }) => {
          assert.equal(path, "package-lock.json");
          return { data: { type: "file", size: 3 * 1024 * 1024, sha: ref, encoding: "none", content: "" } };
        } },
        git: { getBlob: async ({ file_sha }) => {
          const value = lock(file_sha === "base" ? { beta: "1.0.0", gamma: "1.0.0" } : { beta: "1.1.0", delta: "1.0.0" });
          value.padding = "x".repeat(2 * 1024 * 1024);
          const content = JSON.stringify(value);
          return { data: { size: Buffer.byteLength(content), encoding: "base64", content: Buffer.from(content).toString("base64") } };
        } },
        issues: { listComments: {}, createComment: async (comment) => comments.push(comment.body) },
      },
    },
  });
  assert.doesNotMatch(comments[0], /Isolated beta/);
  assert.doesNotMatch(comments[0], /<@everyone>/);
  assert.match(comments[0], /Untrusted npm diff diagnostic/);
  assert.match(comments[0], /isolated beta in 4 trials/);
  assert.match(comments[0], /`delta`: `\(added\) → 1.0.0`/);
  assert.match(comments[0], /`gamma`: `1.0.0 → \(removed\)`/);
});

test("inventory retains added and removed paths; variants and provenance handle them", async () => {
  const { base, head } = fixtures();
  base.packages["node_modules/alpha/node_modules/left-pad"] = { version: "1.0.0" };
  head.packages["node_modules/alpha/node_modules/@scope/left-pad"] = { version: "1.0.0" };
  const changes = inventory(base, head);
  assert.deepEqual(changes.get("left-pad"), [{
    key: "node_modules/alpha/node_modules/left-pad", before: { version: "1.0.0" }, after: undefined,
  }]);
  assert.deepEqual(changes.get("@scope/left-pad"), [{
    key: "node_modules/alpha/node_modules/@scope/left-pad", before: undefined, after: { version: "1.0.0" },
  }]);
  assert.deepEqual(variant(base, head, head.packages[""], base.packages[""], changes, new Set()).lock, base);
  assert.deepEqual(variant(base, head, head.packages[""], base.packages[""], changes, new Set(changes.keys())).lock, head);
  const lookedUp = [];
  let audited = false;
  await verifyTransitions(changes, async (name) => {
    lookedUp.push(name);
    return { provenance: null };
  }, () => { audited = true; });
  assert.equal(audited, true);
  assert.ok(!lookedUp.includes("left-pad") && !lookedUp.includes("@scope/left-pad"));
});

test("reverting a nested package does not alter the root parent's specification", () => {
  const { base, head } = fixtures();
  base.packages[""].dependencies.parent = "1.0.0";
  head.packages[""].dependencies.parent = "1.1.0";
  base.packages["node_modules/parent"] = { version: "1.0.0" };
  head.packages["node_modules/parent"] = { version: "1.1.0" };
  base.packages["node_modules/parent/node_modules/child"] = { version: "1.0.0" };
  head.packages["node_modules/parent/node_modules/child"] = { version: "1.1.0" };
  const changed = inventory(base, head);
  const variantResult = variant(base, head, head.packages[""], base.packages[""], changed, new Set(["parent"]));
  assert.equal(variantResult.lock.packages["node_modules/parent"].version, "1.1.0");
  assert.equal(variantResult.lock.packages["node_modules/parent/node_modules/child"].version, "1.0.0");
  assert.equal(variantResult.pkg.dependencies.parent, "1.1.0");
  assert.equal(variantResult.lock.packages[""].dependencies.parent, "1.1.0");
});

test("variants restore exact base entries, scoped transitives and root specifications", () => {
  const { base, head } = fixtures();
  base.packages["node_modules/alpha/node_modules/@scope/transitive"] = {
    version: "1.0.0",
    integrity: "base",
  };
  head.packages["node_modules/alpha/node_modules/@scope/transitive"] = {
    version: "1.1.0",
    integrity: "head",
  };
  const changes = inventory(base, head);
  const result = variant(
    base,
    head,
    head.packages[""],
    base.packages[""],
    changes,
    new Set(["alpha"]),
  );
  assert.equal(result.lock.packages["node_modules/alpha"].version, "1.1.0");
  assert.deepEqual(
    result.lock.packages["node_modules/beta"],
    base.packages["node_modules/beta"],
  );
  assert.deepEqual(
    result.lock.packages["node_modules/alpha/node_modules/@scope/transitive"],
    base.packages["node_modules/alpha/node_modules/@scope/transitive"],
  );
  assert.deepEqual(result.pkg.dependencies, {
    alpha: "1.1.0",
    beta: "1.0.0",
    gamma: "1.0.0",
  });
  assert.equal(head.packages["node_modules/beta"].version, "1.1.0");
});

test("bisect isolates multiple culprits, verifies the remainder and fails closed", () => {
  const observed = [];
  const result = isolate(
    ["a", "b", "c", "d"],
    (active) => {
      observed.push([...active]);
      return active.includes("b") || active.includes("d") ? "fail" : "pass";
    },
    16,
  );
  assert.equal(JSON.stringify(result.culprits), JSON.stringify(["b", "d"]));
  assert.deepEqual(observed.at(-1), ["a", "c"]);
  assert.throws(
    () => isolate(["a", "b"], () => "inconclusive", 8),
    /earlier verification/,
  );
  assert.throws(() => isolate(["a", "b"], () => "fail", 8), /base dependency/);
  assert.throws(
    () => isolate(["a", "b"], () => "pass", 8),
    /did not reproduce/,
  );
  assert.throws(
    () =>
      isolate(
        ["a", "b"],
        (active) => (active.length === 2 ? "fail" : "pass"),
        8,
      ),
    /interacting/,
  );
  assert.throws(
    () =>
      isolate(
        ["a", "b"],
        (active) => (active.includes("b") ? "fail" : "pass"),
        2,
      ),
    /trial limit/,
  );
});

for (const padding of [0, 2 * 1024 * 1024]) test(`shipped CLI handles topology changes and isolates without renovate.json (padding ${padding})`, () => {
  const root = mkdtempSync(join(tmpdir(), "dependency-bisect-"));
  const repo = join(root, "repo"),
    reports = join(root, "reports"),
    engineFile = enginePath;
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const { base, head } = fixtures();
  for (const value of [base, head]) value.packages[""].description = "x".repeat(padding);
  const write = (value) => {
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify(value));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify(value.packages[""]),
    );
  };
  try {
    git("init", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    write(base);
    git("add", ".");
    git("commit", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
    const topology = structuredClone(base);
    delete topology.packages["node_modules/gamma"];
    topology.packages["node_modules/delta"] = { version: "1.0.0" };
    write(topology);
    const env = { ...process.env, BASE_REF: baseSha, LOCKFILE: "package-lock.json", REPORT_DIR: reports };
    const diff = spawnSync(process.execPath, [engineFile, "diff"], { cwd: repo, encoding: "utf8", env });
    assert.equal(diff.status, 0, diff.stderr);
    const diffMessage = JSON.parse(readFileSync(join(reports, "diff.json"), "utf8")).message;
    assert.match(diffMessage, /delta: \(added\) → 1.0.0/);
    assert.match(diffMessage, /gamma: 1.0.0 → \(removed\)/);
    const provenance = spawnSync(process.execPath, [new URL("../scripts/dependency-provenance.cjs", import.meta.url).pathname], {
      cwd: repo, encoding: "utf8", env: { ...env, PROVENANCE_COMMAND: "printf signature-check-ran" },
    });
    assert.equal(provenance.status, 0, provenance.stderr);
    assert.match(provenance.stdout, /signature-check-ran/);
    write(head);
    git("add", ".");
    git("commit", "-m", "batch");
    const headSha = git("rev-parse", "HEAD");
    const before = readFileSync(join(repo, "package-lock.json"), "utf8");
    const commands = {
      "install-command":
        "node -e \"JSON.parse(require('fs').readFileSync('package-lock.json'))\"",
      "build-command":
        "node -e \"process.exit(JSON.parse(require('fs').readFileSync('package-lock.json')).packages['node_modules/beta'].version === '1.1.0' ? 1 : 0)\"",
    };
    const result = spawnSync(process.execPath, [engineFile, "bisect"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        BASE_REF: baseSha,
        HEAD_REF: headSha,
        LOCKFILE: "package-lock.json",
        FAILED_STEP: "build",
        COMMANDS: JSON.stringify(commands),
        REPORT_DIR: reports,
        MAX_ROUNDS: "12",
        TIMEOUT_MINUTES: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(
      readFileSync(join(reports, "report.json"), "utf8"),
    );
    assert.deepEqual(report.culprits, ["beta"]);
    assert.match(report.message, /Diagnosis only; the PR is unchanged/);
    assert.equal(Object.hasOwn(report, "files"), false);
    assert.deepEqual(Object.keys(report).sort(), ["culprits", "message", "rounds"]);
    assert.equal(readFileSync(join(repo, "package-lock.json"), "utf8"), before);
    assert.equal(git("status", "--porcelain"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
