#!/usr/bin/env node
// Offline command fixture: only Go's syntax parser is real; downloads and scanning are simulated.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'mod' && args[1] === 'edit') {
  const result = cp.spawnSync(process.env.REAL_GO, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ args, cwd: process.cwd(), env: process.env,
  hasSum: fs.existsSync('go.sum'), hasCache: fs.existsSync(process.env.GOMODCACHE) }) + '\n');
if (process.env.FIXTURE_FAIL === (args[0] === 'install' ? 'install' : args.slice(0, 2).join(' ')) ||
    (process.env.FIXTURE_CLEANUP_FAIL === 'true' && args[0] === 'clean')) process.exit(1);
if (args[0] === 'install') {
  fs.mkdirSync(process.env.GOBIN, { recursive: true });
  fs.copyFileSync(process.env.FIXTURE_SCANNER, path.join(process.env.GOBIN, 'govulncheck'));
  fs.chmodSync(path.join(process.env.GOBIN, 'govulncheck'), 0o755);
}
