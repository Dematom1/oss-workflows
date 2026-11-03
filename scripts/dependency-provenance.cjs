const cp = require('node:child_process');
const fs = require('node:fs');
const { inventory } = require('./dependency-engine.cjs');

async function verifyTransitions(changes, lookup, verifySignatures) {
  const warnings = [];
  for (const [name, entries] of changes) {
    for (const { before, after } of entries) {
      if (!before?.version || !after?.version || before.version === after.version) continue;
      const previous = await lookup(name, before.version);
      const next = await lookup(name, after.version);
      if (previous.error || next.error) {
        throw new Error(`Cannot verify provenance transition for ${name}: registry metadata unavailable`);
      }
      const hadProvenance = Boolean(previous.provenance);
      const hasProvenance = Boolean(next.provenance);
      if (hadProvenance && !hasProvenance) {
        throw new Error(`Provenance downgrade refused: ${name}@${after.version} lacks provenance`);
      }
      if (!hadProvenance) warnings.push(`${name}: neither previously published version is required to have provenance`);
    }
  }
  verifySignatures();
  return warnings;
}

function registryMetadata(name, version) {
  const result = cp.spawnSync('npm', ['view', `${name}@${version}`, 'dist.attestations', '--json'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
  });
  if (result.status !== 0 || result.error) return { error: true };
  try {
    const attestation = JSON.parse(result.stdout || '{}');
    return { provenance: attestation.provenance || null };
  } catch {
    return { error: true };
  }
}

async function run() {
  const lockfile = process.env.LOCKFILE;
  const base = JSON.parse(cp.execFileSync('git', ['show', `${process.env.BASE_REF}:${lockfile}`], { encoding: 'utf8' }));
  const head = JSON.parse(fs.readFileSync(lockfile, 'utf8'));
  const changes = inventory(base, head);
  const warnings = await verifyTransitions(changes, registryMetadata, () => {
    cp.execFileSync('bash', ['-e', '-o', 'pipefail', '-c', process.env.PROVENANCE_COMMAND], { stdio: 'inherit' });
  });
  for (const warning of warnings) {
    console.warn(`Provenance warning: ${warning}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- Provenance warning: ${warning}\n`);
  }
}

module.exports = { verifyTransitions, registryMetadata, run };
if (require.main === module) {
  run().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
