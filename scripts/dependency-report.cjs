module.exports = async ({context, github, core, process, require}) => {
const fs = require('node:fs'), path = require('node:path');
const get = (dir, file) => {
  const location = path.join(process.env.ARTIFACTS, dir, file);
  if (!fs.existsSync(location)) return null;
  if (fs.statSync(location).size > 4 * 1024 * 1024) throw new Error('Diagnostic artifact too large');
  return JSON.parse(fs.readFileSync(location, 'utf8'));
};
const result = get('dependency-bisect', 'report.json');
const diff = get('dependency-diff', 'diff.json');
const pr = context.payload.pull_request;
const contentAt = async (file, ref) => {
  const {data} = await github.rest.repos.getContent({...context.repo, path: file, ref});
  if (Array.isArray(data) || data.size > 8 * 1024 * 1024 || data.encoding !== 'base64') throw new Error('Cannot validate dependency lockfile');
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
};
const [baseLock, headLock] = await Promise.all([
  contentAt(process.env.LOCKFILE, pr.base.sha), contentAt(process.env.LOCKFILE, pr.head.sha),
]);
const changed = new Map();
for (const key of new Set([...Object.keys(baseLock.packages || {}), ...Object.keys(headLock.packages || {})])) {
  const before = baseLock.packages?.[key], after = headLock.packages?.[key];
  if (JSON.stringify(before) === JSON.stringify(after)) continue;
  const marker = key.lastIndexOf('node_modules/');
  if (marker < 0 || !before || !after) continue;
  const name = key.slice(marker + 13);
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) continue;
  changed.set(name, {before: before.version || '(unknown)', after: after.version || '(unknown)'});
}
const clean = value => String(value).replace(/[\r\n`<>]/g, '_').slice(0, 100);
let message = `<!-- dependency-verification -->\n## Dependency verification\nHead: ${pr.head.sha}\nVerification: ${process.env.VERIFY_RESULT}\n\n### Dependency changes\n`;
message += [...changed].slice(0, 50).map(([name, versions]) => `- \`${clean(name)}\`: \`${clean(versions.before)} → ${clean(versions.after)}\``).join('\n') || '- No package version changes found.';
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '@&#8203;');
const rawDiff = diff?.message || 'npm diff output unavailable';
message += `\n\n<details><summary>Untrusted npm diff diagnostic</summary><pre>${escape(rawDiff.slice(0, 30000))}${rawDiff.length > 30000 ? `\n[truncated ${rawDiff.length - 30000} characters]` : ''}</pre></details>`;
const validResult = result && Object.keys(result).every(key => ['culprits', 'rounds', 'message'].includes(key)) &&
  Array.isArray(result.culprits) && Number.isInteger(result.rounds) && result.rounds > 0 &&
  new Set(result.culprits).size === result.culprits.length && result.culprits.every(name => changed.has(name));
const validCulprits = validResult ? result.culprits : [];
message += `\n\nBisect: ${process.env.VERIFY_RESULT === 'success' ? 'not needed' : validCulprits.length ? `isolated ${validCulprits.map(clean).join(', ')} in ${result.rounds} trials` : 'could not isolate; inspect workflow logs/timeout'}`;
if (validCulprits.length) message += '\nAutomatic split is deferred; bisect diagnosis does not change this PR.';
await core.summary.addRaw(message.slice(0, 60000)).write();
const comments = await github.paginate(github.rest.issues.listComments, {...context.repo, issue_number: pr.number, per_page: 100});
const existing = comments.find(c => c.user.login === 'github-actions[bot]' && c.body?.startsWith('<!-- dependency-verification -->'));
if (existing) await github.rest.issues.updateComment({...context.repo, comment_id: existing.id, body: message.slice(0, 60000)});
else await github.rest.issues.createComment({...context.repo, issue_number: pr.number, body: message.slice(0, 60000)});
};
