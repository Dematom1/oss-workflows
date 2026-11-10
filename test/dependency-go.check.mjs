// Standalone: node --test test/dependency-*.check.mjs (Node and Go, no network).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const scope = require('../scripts/dependency-scope.cjs');
const report = require('../scripts/dependency-report.cjs');
const { parseMod, inventory } = require('../scripts/dependency-go.cjs');
const fixture = name => new URL(`./fixtures/go/${name}`, import.meta.url);
const cli = new URL('../scripts/dependency-go.cjs', import.meta.url).pathname;
const base = readFileSync(fixture('base.mod'), 'utf8');
const head = readFileSync(fixture('head.mod'), 'utf8');

function checkScope(files, { ecosystem = 'go', login = 'renovate[bot]', eventName = 'pull_request', count = files.length } = {}) {
  return scope({
    context: { eventName, repo: { owner: 'fixture', repo: 'repo' }, payload: {
      repository: { default_branch: 'main' }, pull_request: {
        number: 1, user: { login, type: 'Bot' }, head: { repo: { full_name: 'fixture/repo' } },
        base: { ref: 'main' }, changed_files: count,
      },
    } },
    process: { env: {
      ECOSYSTEM: ecosystem, LOCKFILE: 'package-lock.json', MAX_ROUNDS: '8', TIMEOUT_MINUTES: '20',
      COMMANDS: JSON.stringify(Object.fromEntries(['install', 'build', 'test', 'smoke'].map(k => [`${k}-command`, 'true']))),
    } },
    core: { setOutput: (key, value) => { assert.equal(key, 'eligible'); assert.equal(value, 'true'); } },
    github: { paginate: async () => files, rest: { pulls: { listFiles: {} } } },
  });
}

test('Go scope accepts only root module files and Renovate config from Renovate pull_request', async () => {
  await checkScope(['go.mod', 'go.sum', 'renovate.json'].map(filename => ({ filename })));
  await checkScope([{ filename: 'go.sum' }]);
  for (const filename of ['package.json', 'package-lock.json', 'main.go', 'nested/go.mod', '.github/workflows/check.yml', 'go.work']) {
    await assert.rejects(checkScope([{ filename }]), /dependency-only/);
  }
  await assert.rejects(checkScope([{ filename: 'go.mod', previous_filename: 'main.go' }]), /dependency-only/);
  await assert.rejects(checkScope([]), /incomplete/);
  await assert.rejects(checkScope([{ filename: 'go.mod' }], { count: 2 }), /incomplete/);
  await assert.rejects(checkScope([{ filename: 'go.mod' }], { login: 'human' }), /Renovate/);
  await assert.rejects(checkScope([{ filename: 'go.mod' }], { eventName: 'pull_request_target' }), /Renovate/);
  await assert.rejects(checkScope([{ filename: 'go.mod' }], { ecosystem: 'unknown' }), /ecosystem/);
});

test('Go provenance inventory uses native parsing for upgrades, additions, removals and replacements', () => {
  const changes = inventory(parseMod(base), parseMod(head));
  assert.deepEqual(changes, [
    { name: 'example.com/alpha', before: 'v1.0.0', after: 'v1.1.0' },
    { name: 'example.com/removed', before: 'v1.0.0', after: '(removed)' },
    { name: 'example.com/added/v2', before: '(added)', after: 'v2.0.0' },
  ]);
  assert.deepEqual(inventory(parseMod(head), parseMod(head)), []);
  const replaced = parseMod(head + '\nreplace example.com/alpha => example.com/fork v1.2.0\n');
  assert.deepEqual(inventory(parseMod(head), replaced).at(-1), {
    name: 'replace example.com/alpha', before: '(added)', after: 'example.com/fork@v1.2.0',
  });
  assert.throws(() => parseMod('not a module file'), /Command failed/);
});

function repository(run) {
  const root = mkdtempSync(join(tmpdir(), 'dependency-go-test-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    writeFileSync(join(repo, 'go.mod'), base);
    git('add', '.');
    git('commit', '-m', 'base');
    const env = { ...process.env, BASE_REF: git('rev-parse', 'HEAD'), REPORT_DIR: join(root, 'report') };
    writeFileSync(join(repo, 'go.mod'), head);
    run({ root, repo, env });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('shipped Go diff summarizes go.mod and handles go.sum-only changes without npm', () => repository(({ repo, env }) => {
  const run = () => spawnSync(process.execPath, [cli, 'diff'], { cwd: repo, env, encoding: 'utf8' });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  const message = JSON.parse(readFileSync(join(env.REPORT_DIR, 'diff.json'), 'utf8')).message;
  assert.match(message, /example.com\/alpha: v1.0.0 → v1.1.0/);
  assert.match(message, /example.com\/added\/v2: \(added\) → v2.0.0/);
  assert.match(message, /example.com\/removed: v1.0.0 → \(removed\)/);
  writeFileSync(join(repo, 'go.mod'), base);
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No go.mod module version changes/);
}));

for (const failure of ['', 'vulnerable', 'mod download', 'mod verify', 'install', 'local replacement', 'cleanup', 'vulnerable+cleanup']) {
  test(`Go verification CLI ${failure ? `handles failure: ${failure}` : 'checks proxy, sums, integrity and reachable vulnerabilities'}`, () => repository(({ root, repo, env }) => {
    const vulnerable = failure.startsWith('vulnerable');
    const cleanupFailure = failure.includes('cleanup');
    const bin = join(root, 'bin'), log = join(root, 'commands.jsonl');
    mkdirSync(bin);
    copyFileSync(fixture('go.cjs'), join(bin, 'go'));
    chmodSync(join(bin, 'go'), 0o755);
    const goroot = execFileSync('go', ['env', 'GOROOT'], {
      encoding: 'utf8', env: { ...process.env, GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local' },
    }).trim();
    if (failure === 'local replacement') writeFileSync(join(repo, 'go.mod'), head + '\nreplace example.com/alpha => ./local\n');
    writeFileSync(join(repo, 'go.sum'), 'untrusted fixture checksum\n');
    const result = spawnSync(process.execPath, [cli, 'verify'], { cwd: repo, encoding: 'utf8', env: {
      ...env, PATH: `${bin}:${process.env.PATH}`, REAL_GO: join(goroot, 'bin', 'go'), FIXTURE_LOG: log,
      FIXTURE_SCANNER: fixture('govulncheck.cjs').pathname, FIXTURE_FAIL: failure,
      FIXTURE_VULNERABLE: String(vulnerable), FIXTURE_CLEANUP_FAIL: String(cleanupFailure),
      GOPROXY: 'direct', GOSUMDB: 'off', GOPRIVATE: '*', GONOSUMDB: '*', GONOPROXY: '*',
      GOFLAGS: '-mod=vendor', GOWORK: '/untrusted/go.work', GOINSECURE: '*',
    } });
    if (failure && failure !== 'cleanup') assert.notEqual(result.status, 0, result.stdout);
    else assert.equal(result.status, 0, result.stderr);
    if (failure === 'local replacement') {
      assert.match(result.stderr, /Local Go replacements/);
      assert.equal(existsSync(log), false);
      return;
    }
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (vulnerable) {
      assert.match(result.stderr, /reachable vulnerability/);
      assert.match(result.stderr.trim().split('\n').at(-1), /govulncheck \.\/\.\.\.$/, 'original scan error must not be replaced by cleanup errors');
    }
    if (cleanupFailure) assert.match(result.stderr, /cleanup failed/);
    if (!failure || vulnerable || cleanupFailure) assert.deepEqual(calls.map(c => c.args), [
      ['mod', 'download', 'all'], ['mod', 'download', 'all'], ['mod', 'verify'],
      ['install', 'golang.org/x/vuln/cmd/govulncheck@v1.9.0'], ['govulncheck', './...'], ['clean', '-modcache'],
    ]);
    const first = calls[0];
    assert.notEqual(first.cwd, repo);
    assert.equal(first.hasSum, false);
    assert.equal(first.hasCache, false);
    assert.equal(existsSync(first.cwd), false, 'verification scratch directory is cleaned even on failure');
    for (const call of calls.filter(c => c.env)) {
      assert.equal(call.env.GOTOOLCHAIN, call.args[0] === 'install' ? 'auto' : 'local');
      for (const [key, value] of Object.entries({
        GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org', GOPRIVATE: '',
        GONOPROXY: 'none', GONOSUMDB: 'none', GOENV: 'off', GOWORK: 'off', GOFLAGS: '', GOINSECURE: '',
      })) assert.equal(call.env[key], value, key);
    }
  }));
}

test('Go report never parses Go files as npm locks or trusts artifact messages', async () => {
  const comments = [];
  await report({
    require: name => name === 'node:fs' ? {
      existsSync: location => location.includes('dependency-diff'), statSync: () => ({ size: 100 }),
      readFileSync: () => JSON.stringify({ message: 'example.com/alpha: v1.0.0 → v1.1.0\n<script>@everyone</script>' }),
    } : require(name),
    process: { env: { ECOSYSTEM: 'go', ARTIFACTS: '/fixture', VERIFY_RESULT: 'failure' } },
    context: { repo: { owner: 'fixture', repo: 'repo' }, payload: { pull_request: { number: 1, head: { sha: 'fixture' } } } },
    core: { summary: { addRaw: () => ({ write: async () => {} }) } },
    github: { paginate: async () => [], rest: { issues: {
      listComments: {}, createComment: async comment => comments.push(comment.body),
    } } },
  });
  assert.match(comments[0], /Untrusted Go module diagnostic/);
  assert.match(comments[0], /example.com\/alpha: v1.0.0 → v1.1.0/);
  assert.doesNotMatch(comments[0], /<script>|@everyone/);
  assert.match(comments[0], /Bisect: not supported for Go modules/);
});

test('Go preset retains npm grouping and schedule while limiting updates to gomod with tidy', () => {
  const go = JSON.parse(readFileSync(new URL('../renovate/go.json', import.meta.url)));
  const npm = JSON.parse(readFileSync(new URL('../renovate/axi.json', import.meta.url)));
  assert.deepEqual(go.enabledManagers, ['gomod']);
  assert.deepEqual(go.postUpdateOptions, ['gomodTidy']);
  delete go.enabledManagers;
  delete go.postUpdateOptions;
  assert.deepEqual(go, npm);
});

test('Go workflow is valid to GitHub Actions', () => {
  const workflow = new URL('../.github/workflows/dependency-verify.yml', import.meta.url).pathname;
  const result = spawnSync('actionlint', [workflow], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});