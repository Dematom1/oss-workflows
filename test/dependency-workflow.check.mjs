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
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const workflowPath = new URL("../.github/workflows/dependency-verify.yml", import.meta.url);
const workflow = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e", `puts JSON.generate(YAML.load_file(ARGV.fetch(0)))`, workflowPath.pathname], { encoding: "utf8" }));
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
const engineStep = steps.find((step) => step.run?.includes("cat > "));
const engine = engineStep.run.split("<<'ENGINE'\n")[1].split("\nENGINE")[0];
const scriptFor = (start, end) => steps.find((step) => step.with?.script?.includes(start))?.with.script;
const engineModule = { exports: {} };
runInNewContext(engine, { require, module: engineModule, structuredClone });
const { inventory, variant, isolate } = engineModule.exports;

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

test("built-in inventory rejects npm v2 locks rather than changing lockfile format", () => {
  const { base, head } = fixtures();
  base.lockfileVersion = 2;
  assert.throws(() => inventory(base, head), /require npm lockfile v3/);
});

test("scope rejects non-Renovate authors, forbidden paths, renames and incomplete file lists", async () => {
  const script = scriptFor("// BEGIN DEPENDENCY SCOPE", "// END DEPENDENCY SCOPE");
  const pr = {
    number: 1,
    user: { login: "renovate[bot]", type: "Bot" },
    head: { repo: { full_name: "fixture/repo" } },
    base: { ref: "main" },
    changed_files: 1,
  };
  const check = (files, pullRequest = pr) =>
    runInNewContext(`(async () => { ${script} })()`, {
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

test("automatic splitting is opt-in and requires dedicated App credentials", async () => {
  const script = scriptFor("// BEGIN DEPENDENCY REPORT", "// END DEPENDENCY REPORT");
  for (const enabled of [false, true]) {
    const failures = [];
    const comments = [];
    await runInNewContext(`(async () => { ${script} })()`, {
      require: (name) => name === "node:fs" ? {
        existsSync: () => true,
        statSync: () => ({ size: 100 }),
        readFileSync: () => JSON.stringify({
          message: "Isolated beta", culprits: ["beta"], rounds: 4,
        }),
      } : require(name),
      process: { env: {
        AUTO_SPLIT: String(enabled), SPLIT_APP_ID: "", SPLIT_APP_PRIVATE_KEY: "", ARTIFACTS: "/fixture",
        VERIFY_RESULT: "failure", BISECT_RESULT: "success",
      } },
      context: { repo: { owner: "fixture", repo: "repo" }, payload: {
        pull_request: { number: 1, head: { sha: "fixture" } },
      } },
      core: {
        setFailed: (message) => failures.push(message),
        summary: { addRaw: () => ({ write: async () => {} }) },
      },
      github: {
        paginate: async () => [],
        rest: { issues: {
          listComments: {},
          createComment: async (comment) => comments.push(comment.body),
        } },
      },
    });
    assert.equal(failures.length, enabled ? 1 : 0);
    assert.match(comments[0], enabled ? /dedicated Renovate-split App/ : /split is disabled/);
    if (enabled) assert.match(failures[0], /split-app-id or split-app-private-key is missing/);
  }
});

test("privileged split rejects forged files and culprit names without writes", async () => {
  const script = scriptFor("// BEGIN DEPENDENCY REPORT", "// END DEPENDENCY REPORT");
  const { base, head } = fixtures();
  for (const payload of [
    { culprits: ["beta"], rounds: 4, message: "x", files: { "package.json": "{}" } },
    { culprits: ["attacker-package"], rounds: 4, message: "x" },
  ]) {
    let writes = 0;
    const apiContent = (object) => ({ data: {
      size: JSON.stringify(object).length,
      encoding: "base64",
      content: Buffer.from(JSON.stringify(object)).toString("base64"),
    } });
    const context = {
      require: (name) => name === "node:fs" ? {
        existsSync: () => true,
        statSync: () => ({ size: 100 }),
        readFileSync: () => JSON.stringify(payload),
      } : require(name),
      process: { env: {
        AUTO_SPLIT: "true", SPLIT_APP_ID: "1", SPLIT_APP_PRIVATE_KEY: "key",
        RENOVATE_TOKEN: "token", ARTIFACTS: "/fixture", VERIFY_RESULT: "failure",
        BISECT_RESULT: "success", LOCKFILE: "package-lock.json",
      } },
      context: { repo: { owner: "fixture", repo: "repo" }, payload: {
        pull_request: { number: 1, head: { sha: "head" }, base: { sha: "base" } },
      } },
      core: { setFailed() {}, summary: { addRaw: () => ({ write: async () => {} }) } },
      github: {
        rest: {
          pulls: { get: async () => ({ data: { head: { sha: "head" }, state: "open", user: { login: "renovate[bot]" }, head: { sha: "head", repo: { full_name: "fixture/repo" } } } }) },
          repos: { getContent: async ({ ref }) => apiContent(ref === "base" ? base : head) },
        },
      },
      fetch: async () => { writes++; throw new Error("unexpected privileged write"); },
      Buffer,
    };
    await assert.rejects(runInNewContext(`(async () => { ${script} })()`, context));
    assert.equal(writes, 0);
  }
});

test("privileged split emits a parseable Renovate-only commit blob", async () => {
  const script = scriptFor("// BEGIN DEPENDENCY REPORT", "// END DEPENDENCY REPORT");
  const { base, head } = fixtures();
  const requests = [];
  const content = (value) => ({ data: {
    size: JSON.stringify(value).length,
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value)).toString("base64"),
  } });
  await runInNewContext(`(async () => { ${script} })()`, {
    require: (name) => name === "node:fs" ? {
      existsSync: () => true,
      statSync: () => ({ size: 100 }),
      readFileSync: () => JSON.stringify({ culprits: ["beta"], rounds: 4, message: "isolated" }),
    } : require(name),
    process: { env: {
      AUTO_SPLIT: "true", SPLIT_APP_ID: "1", SPLIT_APP_PRIVATE_KEY: "key",
      RENOVATE_TOKEN: "token", ARTIFACTS: "/fixture", VERIFY_RESULT: "failure",
      BISECT_RESULT: "success", LOCKFILE: "package-lock.json", GITHUB_API_URL: "https://api.github.test",
    } },
    context: { repo: { owner: "fixture", repo: "repo" }, payload: {
      pull_request: { number: 1, head: { sha: "head", ref: "renovate/weekly-non-major", repo: { full_name: "fixture/repo" } }, base: { sha: "base" } },
    } },
    core: { setFailed() {}, summary: { addRaw: () => ({ write: async () => {} }) } },
    github: {
      rest: {
        pulls: { get: async () => ({ data: { head: { sha: "head" }, state: "open", user: { login: "renovate[bot]" }, head: { sha: "head", repo: { full_name: "fixture/repo" } } } }) },
        repos: { getContent: async ({ path, ref }) => path === "renovate.json" ? content({ packageRules: [] }) : content(ref === "base" ? base : head) },
        git: { getCommit: async () => ({ data: { tree: { sha: "base-tree" } } }) },
        issues: { listComments: {}, createComment: async () => {} },
      },
      paginate: async () => [],
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ sha: "new-sha" }) };
    },
    Buffer,
  });
  const treePost = requests.find(({ url, options }) => url.endsWith("/git/trees") && options.method === "POST");
  const tree = JSON.parse(treePost.options.body).tree;
  assert.deepEqual(tree.map(({ path }) => path), ["renovate.json"]);
  const emitted = JSON.parse(tree[0].content);
  assert.deepEqual(emitted.packageRules[0].matchPackageNames, ["beta"]);
  assert.equal(emitted.packageRules[0].automerge, false);
});

test("inventory rejects added or removed transitive paths", () => {
  const { base, head } = fixtures();
  base.packages["node_modules/alpha/node_modules/left-pad"] = { version: "1.0.0" };
  head.packages["node_modules/alpha/node_modules/left-pad"] = undefined;
  delete head.packages["node_modules/alpha/node_modules/left-pad"];
  head.packages["node_modules/alpha/node_modules/@scope/left-pad"] = { version: "1.0.0" };
  assert.throws(() => inventory(base, head), /Unsupported dependency topology change/);
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

test("shipped engine runs a network-free bisect against fixture locks in a real git repo", () => {
  const root = mkdtempSync(join(tmpdir(), "dependency-bisect-"));
  const repo = join(root, "repo"),
    reports = join(root, "reports"),
    engineFile = join(root, "engine.cjs");
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const { base, head } = fixtures();
  const write = (value) => {
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify(value));
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify(value.packages[""]),
    );
  };
  try {
    writeFileSync(engineFile, engine);
    git("init", "-b", "main");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    write(base);
    writeFileSync(
      join(repo, "renovate.json"),
      JSON.stringify({ extends: ["local>fixture/config"] }),
    );
    git("add", ".");
    git("commit", "-m", "base");
    const baseSha = git("rev-parse", "HEAD");
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
    assert.equal(Object.hasOwn(report, "files"), false);
    assert.deepEqual(Object.keys(report).sort(), ["culprits", "message", "rounds"]);
    assert.equal(readFileSync(join(repo, "package-lock.json"), "utf8"), before);
    assert.equal(git("status", "--porcelain"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
