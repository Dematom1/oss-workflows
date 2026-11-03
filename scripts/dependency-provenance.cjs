const cp = require('node:child_process');
const fs = require('node:fs');
const { inventory } = require('./dependency-engine.cjs');

async function verifyTransitions(changes, lookup, verifySignatures) {
  const warnings = [];
  const metadata = new Map();
  const cachedLookup = (name, version) => {
    const key = `${name}@${version}`;
    if (!metadata.has(key)) metadata.set(key, lookup(name, version));
    return metadata.get(key);
  };
  for (const [name, entries] of changes) {
    for (const { before, after } of entries) {
      if (!before?.version || !after?.version || before.version === after.version) continue;
      const previous = await cachedLookup(name, before.version);
      const next = await cachedLookup(name, after.version);
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

function parseVersionMetadata(raw, expectedName, expectedVersion) {
  const metadata = JSON.parse(raw);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      metadata.name !== expectedName || metadata.version !== expectedVersion ||
      !metadata.dist || typeof metadata.dist !== 'object' || Array.isArray(metadata.dist) ||
      typeof metadata.dist.integrity !== 'string' || !metadata.dist.integrity) {
    throw new Error('Unrecognized or mismatched npm version metadata');
  }
  const attestations = metadata.dist.attestations;
  if (attestations === undefined) return { provenance: null };
  if (!attestations || typeof attestations !== 'object' || Array.isArray(attestations)) {
    throw new Error('Unrecognized npm attestation metadata');
  }
  if (attestations.provenance === undefined) return { provenance: null };
  if (!attestations.provenance || typeof attestations.provenance !== 'object' || Array.isArray(attestations.provenance)) {
    throw new Error('Unrecognized npm provenance metadata');
  }
  return { provenance: attestations.provenance };
}

function registryMetadata(name, version) {
  const result = cp.spawnSync('npm', ['view', `${name}@${version}`, 'name', 'version', 'dist', '--json'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
  });
  if (result.status !== 0 || result.error) return { error: true };
  try {
    return parseVersionMetadata(result.stdout || '', name, version);
  } catch {
    return { error: true };
  }
}

async function run() {
  const lockfile = process.env.LOCKFILE;
  const base = JSON.parse(cp.execFileSync('git', ['show', `${process.env.BASE_REF}:${lockfile}`], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }));
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

module.exports = { verifyTransitions, parseVersionMetadata, registryMetadata, run };
if (require.main === module) {
  run().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
