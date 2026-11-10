#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ args: ['govulncheck', ...process.argv.slice(2)] }) + '\n');
if (process.env.FIXTURE_VULNERABLE === 'true') {
  console.error('Fixture: reachable vulnerability detected');
  process.exit(3);
}
