const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const goEnv = {
  ...process.env, GOENV: 'off', GOWORK: 'off', GOFLAGS: '', GOTOOLCHAIN: 'local',
  GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org',
  GOPRIVATE: '', GONOPROXY: 'none', GONOSUMDB: 'none', GOINSECURE: '', GOTELEMETRY: 'off',
};
const exec = (command, args, options = {}) => cp.execFileSync(command, args, {
  env: goEnv, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, ...options,
});

function parseMod(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-go-parse-'));
  try {
    const file = path.join(dir, 'go.mod');
    fs.writeFileSync(file, text);
    return JSON.parse(exec('go', ['mod', 'edit', '-json', file], { cwd: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function inventory(base, head) {
  const entries = mod => new Map([
    ...(mod.Require || []).map(r => [r.Path, r.Version]),
    ...(mod.Replace || []).map(r => [`replace ${r.Old.Path}${r.Old.Version ? `@${r.Old.Version}` : ''}`,
      `${r.New.Path}${r.New.Version ? `@${r.New.Version}` : ''}`]),
  ]);
  const before = entries(base), after = entries(head);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(name => before.get(name) !== after.get(name))
    .map(name => ({ name, before: before.get(name) || '(added)', after: after.get(name) || '(removed)' }));
}

function diff() {
  const base = exec('git', ['show', `${process.env.BASE_REF}:go.mod`]);
  const changes = inventory(parseMod(base), parseMod(fs.readFileSync('go.mod', 'utf8')));
  const baseSum = cp.spawnSync('git', ['show', `${process.env.BASE_REF}:go.sum`], { encoding: 'utf8' });
  const sumLines = text => new Set(text.split(/\r?\n/).filter(Boolean));
  const beforeSum = sumLines(baseSum.status === 0 ? baseSum.stdout : '');
  const afterSum = sumLines(fs.existsSync('go.sum') ? fs.readFileSync('go.sum', 'utf8') : '');
  const sumChanges = [...new Set([...beforeSum, ...afterSum])].filter(line => beforeSum.has(line) !== afterSum.has(line));
  const grouped = new Map();
  for (const line of sumChanges) {
    const [module, version, checksum] = line.split(/\s+/);
    const key = `${module}@${version.replace(/\\/g, '/')}`;
    const rows = grouped.get(key) || [];
    rows.push(`${beforeSum.has(line) ? '-' : '+'} ${checksum}`);
    grouped.set(key, rows);
  }
  const sumMessage = [...grouped].map(([key, rows]) => `${key}:\n${rows.join('\n')}`);
  const message = [...changes.map(c => `${c.name}: ${c.before} → ${c.after}`), ...sumMessage].join('\n') || 'No go.mod or go.sum changes.';
  fs.mkdirSync(process.env.REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.REPORT_DIR, 'diff.json'), JSON.stringify({ message }));
  console.log(message);
}

function verify() {
  const manifest = fs.readFileSync('go.mod', 'utf8');
  const mod = parseMod(manifest);
  if ((mod.Replace || []).some(r => !r.New.Version)) {
    throw new Error('Local Go replacements cannot be verified by the public checksum database');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-go-verify-'));
  const env = { ...goEnv, GOMODCACHE: path.join(dir, 'cache'), GOBIN: path.join(dir, 'bin') };
  try {
    // No PR go.sum or existing cache: every module must first match sum.golang.org.
    fs.writeFileSync(path.join(dir, 'go.mod'), manifest);
    exec('go', ['mod', 'download', 'all'], { cwd: dir, env, stdio: 'inherit' });
    // Check the same downloaded content against the caller's go.sum, then verify cache integrity.
    exec('go', ['mod', 'download', 'all'], { env, stdio: 'inherit' });
    exec('go', ['mod', 'verify'], { env, stdio: 'inherit' });
    exec('go', ['install', 'golang.org/x/vuln/cmd/govulncheck@v1.9.0'], {
      env: { ...env, GOTOOLCHAIN: 'auto' }, stdio: 'inherit',
    });
    // govulncheck's default source mode fails on reachable vulnerabilities, not imports alone.
    exec(path.join(env.GOBIN, 'govulncheck'), ['./...'], { env, stdio: 'inherit' });
  } finally {
    for (const cleanup of [
      () => exec('go', ['clean', '-modcache'], { env }),
      () => fs.rmSync(dir, { recursive: true, force: true }),
    ]) {
      try { cleanup(); }
      catch (error) { console.warn(`Go verification cleanup failed: ${error.message}`); }
    }
  }
}

module.exports = { parseMod, inventory, diff, verify };
if (require.main === module) {
  try {
    if (process.argv[2] === 'diff') diff();
    else if (process.argv[2] === 'verify') verify();
    else throw new Error('Expected diff or verify');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
