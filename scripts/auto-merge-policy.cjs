// Pure F-01..F-06 policy. Inputs use GitHub PR/file field names; no I/O.
function evaluatePolicy({ repo, pr, files }) {
  // Tune this cap from observations during the shadow period.
  const MAX_DIFF_LINES = 500;
  const flags = [];
  if (pr.head.repo?.full_name !== `${repo.owner}/${repo.repo}` ||
      !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(pr.author_association)) {
    flags.push('F-01 (fork or untrusted author)');
  }
  const sensitive = path => path.startsWith('.github/') ||
    /(^|\/)(?:\.?release-please-config\.json|\.release-please-manifest\.json|renovate\.json5?|\.renovaterc(?:\.json5?|\.ya?ml)?)$/.test(path) ||
    path.startsWith('renovate/') || path.startsWith('.renovate/') ||
    /(^|\/)(?:[^/]*\.lock|[^/]*\.lockb|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.sum|packages\.lock\.json|flake\.lock)$/.test(path);
  if (files.length !== pr.changed_files || files.some(file =>
      [file.filename, file.previous_filename].filter(Boolean).some(sensitive))) {
    flags.push('F-02 (sensitive paths or incomplete file list)');
  }
  if (pr.additions + pr.deletions > MAX_DIFF_LINES) {
    flags.push('F-03 (diff exceeds 500 added+deleted lines)');
  }
  // Same v1 marker and structural fields as the pinned no-mistakes gate.
  // This is author-asserted evidence, not a signature or risk verdict.
  const prefix = '<!-- no-mistakes-pipeline-attestation:v1 ';
  const body = pr.body || '';
  const start = body.indexOf(prefix);
  const end = body.indexOf(' -->', start + prefix.length);
  let attestation;
  try {
    if (start >= 0 && end >= 0) attestation = JSON.parse(body.slice(start + prefix.length, end));
  } catch { /* Malformed author input is a flag, not a job failure. */ }
  const steps = Array.isArray(attestation?.steps) ? attestation.steps : [];
  const validSteps = steps.every(step => step && typeof step.step === 'string' &&
    step.step !== '' && typeof step.status === 'string');
  const status = new Map(steps.filter(step => step && typeof step === 'object').map(step => [step.step, step.status]));
  if (!attestation || typeof attestation.head_sha !== 'string' ||
      !pr.head.sha || attestation.head_sha !== pr.head.sha ||
      !Array.isArray(attestation.steps) || !validSteps ||
      !['review', 'test', 'document'].every(step => status.get(step) === 'completed')) {
    flags.push('F-04 (missing, malformed, incomplete, or stale attestation)');
  }
  if (steps.some(step => step?.step === 'test' &&
      Object.hasOwn(step, 'override_reason') && step.override_reason !== '' && step.override_reason !== null)) {
    flags.push('F-05 (test override reason)');
  }
  if (attestation?.live_validation?.verdict !== 'go') {
    flags.push('F-06 (live validation absent or not go)');
  }
  const verdict = `would merge itself: ${flags.length ? 'no' : 'yes'}, because ${flags.length ? flags.join('; ') : 'no flags'}`;
  return {
    flags: flags.map(label => ({ id: label.slice(0, 4), reason: label.slice(6, -1) })),
    wouldMerge: flags.length === 0,
    verdict,
    notEvaluated: ['F-07', 'F-08', 'F-09', 'infra eligibility'],
  };
}

// Validate serialized input at the workflow boundary, without changing policy.
function parseSnapshot(value) {
  const input = JSON.parse(value);
  const { repo, pr, files } = input || {};
  if (!repo || typeof repo.owner !== 'string' || !repo.owner ||
      typeof repo.repo !== 'string' || !repo.repo ||
      !pr || !/^[a-f0-9]{40}$/.test(pr.head?.sha || '') ||
      !(pr.head.repo === null || typeof pr.head.repo?.full_name === 'string') ||
      typeof pr.author_association !== 'string' ||
      !['changed_files', 'additions', 'deletions'].every(key => Number.isSafeInteger(pr[key]) && pr[key] >= 0) ||
      !(pr.body == null || typeof pr.body === 'string') ||
      !Array.isArray(files) || files.some(file => !file ||
        typeof file.filename !== 'string' || !file.filename ||
        !(file.previous_filename === undefined || typeof file.previous_filename === 'string'))) {
    throw new Error('Snapshot requires repo, PR metadata with immutable head SHA, and a complete file inventory');
  }
  return input;
}

module.exports = { evaluatePolicy, parseSnapshot };
