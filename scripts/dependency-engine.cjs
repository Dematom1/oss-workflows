const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const gitFile = (ref, file) => cp.execFileSync('git', ['show', `${ref}:${file}`], {encoding: 'utf8'});
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
function inventory(base, head) {
  if (![base, head].every(l => l.lockfileVersion === 3 && l.packages?.[''])) {
    throw new Error('Built-in diagnostics require npm lockfile v3; supply diagnostic-command for v2 or other formats');
  }
  const changes = new Map();
  if ([base, head].some(l => Object.values(l.packages).some(p => p.link))) {
    throw new Error('Workspace/link dependencies need a custom diagnostic-command');
  }
  for (const key of new Set([...Object.keys(base.packages), ...Object.keys(head.packages)])) {
    if (!key) continue;
    const before = base.packages[key], after = head.packages[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (!before || !after) throw new Error(`Unsupported dependency topology change: ${key}`);
    if (!key.includes('node_modules/')) throw new Error(`Unsupported workspace lock entry: ${key}`);
    const name = key.slice(key.lastIndexOf('node_modules/') + 13);
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || before?.link || after?.link) {
      throw new Error(`Unsupported package entry: ${key}`);
    }
    if (!changes.has(name)) changes.set(name, []);
    changes.get(name).push({key, before, after});
  }
  return changes;
}
function variant(base, head, manifest, baseManifest, changes, active) {
  const lock = structuredClone(head), pkg = structuredClone(manifest);
  for (const [name, entries] of changes) {
    if (active.has(name)) continue;
    for (const {key, before} of entries) {
      if (before) lock.packages[key] = before;
      else delete lock.packages[key];
    }
    const isRootDependency = sections.some(section =>
      Object.hasOwn(baseManifest[section] || {}, name) || Object.hasOwn(manifest[section] || {}, name));
    if (isRootDependency) for (const section of sections) {
      for (const target of [pkg, lock.packages['']]) {
        const source = target === pkg ? baseManifest : base.packages[''];
        if (Object.hasOwn(source[section] || {}, name)) {
          target[section] ||= {};
          target[section][name] = source[section][name];
        } else if (target[section]) delete target[section][name];
      }
    }
  }
  return {lock, pkg};
}
function isolate(names, trial, maxTrials) {
  let rounds = 0;
  const check = active => {
    if (++rounds > maxTrials) throw new Error(`Cannot isolate: trial limit ${maxTrials} reached`);
    const result = trial(active);
    if (result === 'inconclusive') throw new Error('Cannot isolate: installation or an earlier verification step failed');
    return result === 'fail';
  };
  if (!check(names)) throw new Error('Cannot isolate: original failure did not reproduce');
  if (check([])) throw new Error('Cannot isolate: base dependency versions also fail');
  const culprits = [];
  const search = group => {
    if (group.length === 1) { culprits.push(group[0]); return; }
    const middle = Math.ceil(group.length / 2), left = group.slice(0, middle), right = group.slice(middle);
    const a = check(left), b = check(right);
    if (!a && !b) throw new Error(`Cannot isolate: interacting updates (${group.join(', ')})`);
    if (a) search(left);
    if (b) search(right);
  };
  search(names);
  if (check(names.filter(n => !culprits.includes(n)))) throw new Error('Cannot isolate: reduced batch still fails');
  return {culprits, rounds};
}
async function main(mode) {
  const out = process.env.REPORT_DIR;
  fs.mkdirSync(out, {recursive: true});
  const lockfile = process.env.LOCKFILE;
  const base = JSON.parse(gitFile(process.env.BASE_REF, lockfile)), head = read(lockfile);
  const changes = inventory(base, head);
  if (!changes.size) throw new Error('No changed npm packages found');
  if (mode === 'diff') {
    let message = '### Dependency diff and provenance\n\n';
    let count = 0;
    for (const [name, entries] of changes) {
      const versions = entries.map(e => `${e.before?.version || '(added)'} → ${e.after?.version || '(removed)'}`);
      message += `- ${name}: ${[...new Set(versions)].join(', ')}\n`;
      // npm audit signatures verifies registry signatures and provenance when present.
      // Absence is visible, never silently called verified provenance.
      for (const e of entries) {
        if (++count > 20) { message += '  Provenance metadata not queried: diagnostic entry limit reached.\n'; break; }
        if (e.after?.version) {
          const metadata = cp.spawnSync('npm', ['view', `${name}@${e.after.version}`, 'dist.attestations', '--json'], {
            encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
          });
          let provenance = null;
          try { provenance = JSON.parse(metadata.stdout || '{}').provenance; } catch { /* Report unknown metadata, not absence. */ }
          message += `  ${name}@${e.after.version} provenance: ${metadata.status !== 0 ? 'metadata query failed (unknown)' : provenance ? 'available; npm audit signatures must verify it' : 'MISSING from registry metadata (warning)'}\n`;
        }
        if (!e.before?.version || !e.after?.version || e.before.version === e.after.version) continue;
        const result = cp.spawnSync('npm', ['diff', '--ignore-scripts', '--diff', `${name}@${e.before.version}`, '--diff', `${name}@${e.after.version}`], {
          encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
        });
        const text = (result.stdout || result.stderr || result.error?.message || '').replace(/```/g, "'''");
        message += `\n<details><summary>${name}: npm diff (exit ${result.status ?? 'timeout/error'})</summary>\n\n\`\`\`diff\n${text.slice(0, 1800)}\n\`\`\`\n</details>\n`;
      }
    }
    message += '\nDiff output bounded to 20 entries / 1,800 characters each. Missing provenance is not proof of provenance.\n';
    fs.writeFileSync(path.join(out, 'diff.json'), JSON.stringify({message: message.slice(0, 55000)}));
    return;
  }
  const manifest = read('package.json'), baseManifest = JSON.parse(gitFile(process.env.BASE_REF, 'package.json'));
  const commands = JSON.parse(process.env.COMMANDS);
  const order = ['install', 'provenance', 'build', 'test', 'axi', 'smoke'];
  const failed = process.env.FAILED_STEP, stop = order.indexOf(failed);
  if (stop < 0) throw new Error('Unknown failing step');
  const deadline = Date.now() + Number(process.env.TIMEOUT_MINUTES) * 60000;
  const originals = new Map([lockfile, 'package.json'].map(f => [f, fs.readFileSync(f)]));
  const write = active => {
    const v = variant(base, head, manifest, baseManifest, changes, new Set(active));
    fs.writeFileSync(lockfile, JSON.stringify(v.lock, null, 2) + '\n');
    fs.writeFileSync('package.json', JSON.stringify(v.pkg, null, 2) + '\n');
  };
  try {
    const result = isolate([...changes.keys()], active => {
      if (Date.now() >= deadline) throw new Error('Cannot isolate: wall-clock limit reached');
      cp.execFileSync('git', ['reset', '--hard', process.env.HEAD_REF], {stdio: 'inherit'});
      cp.execFileSync('git', ['clean', '-ffdx'], {stdio: 'inherit'});
      write(active);
      for (let i = 0; i <= stop; i++) {
        const key = order[i] === 'axi' ? 'axi-verify-command' : `${order[i]}-command`;
        const command = commands[key];
        if (!command) continue;
        const run = cp.spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], {
          stdio: 'inherit', timeout: Math.max(1, deadline - Date.now()),
        });
        if (run.error || run.signal) throw new Error('Cannot isolate: trial timed out or was terminated');
        if (run.status !== 0) return i === stop ? 'fail' : 'inconclusive';
      }
      return 'pass';
    }, Number(process.env.MAX_ROUNDS));
    write([...changes.keys()].filter(n => !result.culprits.includes(n)));
    const config = read('renovate.json');
    config.packageRules ||= [];
    config.packageRules.push({
      description: 'Dependency verification isolated these updates; keep separate for review',
      matchPackageNames: result.culprits, groupName: null, automerge: false,
    });
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({
      ...result,
      message: `Isolated: ${result.culprits.join(', ')} in ${result.rounds} trials. A separate Renovate rule will keep these packages out of future batches.`,
    }));
  } finally {
    for (const [file, content] of originals) fs.writeFileSync(file, content);
  }
}
module.exports = {inventory, variant, isolate};
if (require.main === module) main(process.argv[2]).catch(error => {
  const out = process.env.REPORT_DIR;
  fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, process.argv[2] === 'diff' ? 'diff.json' : 'report.json'), JSON.stringify({message: error.message, culprits: []}));
  console.error(error);
  process.exitCode = 1;
});
