module.exports = async ({context, github, core, process}) => {
const pr = context.payload.pull_request;
if (context.eventName !== 'pull_request' || !pr || pr.user.login !== 'renovate[bot]' ||
    pr.user.type !== 'Bot' || pr.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
    pr.base.ref !== context.payload.repository.default_branch) {
  throw new Error('Only same-repository Renovate pull_request updates to the default branch are eligible');
}
if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(process.env.LOCKFILE) ||
    process.env.LOCKFILE.split('/').some(s => s === '..' || s === '.') ||
    process.env.LOCKFILE.startsWith('.github/')) throw new Error('Unsafe lockfile path');
const commands = JSON.parse(process.env.COMMANDS);
const ecosystem = process.env.ECOSYSTEM || 'npm';
if (!['npm', 'go'].includes(ecosystem)) throw new Error('ecosystem must be npm or go');
const required = ['install-command', 'build-command', 'test-command', 'smoke-command'];
if (ecosystem === 'npm') required.push('provenance-command');
for (const key of required) {
  if (!commands[key]?.trim()) throw new Error(`${key} must not be empty`);
}
const rounds = Number(process.env.MAX_ROUNDS), minutes = Number(process.env.TIMEOUT_MINUTES);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 32 ||
    !Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('Bisect limits: 1..32 trials, 1..60 minutes');
const files = await github.paginate(github.rest.pulls.listFiles, {
  ...context.repo, pull_number: pr.number, per_page: 100,
});
const allowed = new Set(ecosystem === 'go'
  ? ['go.mod', 'go.sum', 'renovate.json']
  : ['package.json', process.env.LOCKFILE, 'renovate.json']);
if (!files.length || files.length !== pr.changed_files || files.some(f =>
    !allowed.has(f.filename) || (f.previous_filename && !allowed.has(f.previous_filename)))) {
  throw new Error('Changed files are incomplete or outside dependency-only scope');
}
core.setOutput('eligible', 'true');
};
