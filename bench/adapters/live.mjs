// Live provider adapter for run-comparison.mjs -- makes real, costed calls.
// Gated by run-comparison.mjs itself (SKILLARRAY_LIVE_SMOKE=1 required); this
// module is only ever imported after that check has already passed.
//
// Arms:
//   claude-alone: a single Claude reviewer, no protocol, via `claude -p`.
//   codex-alone:  a single Codex reviewer, no protocol, via codex-dispatch.mjs.
//   union:        no live call -- unionFindings() merges claude-alone's and
//                 codex-alone's own findings from the SAME trial. Requires
//                 those two arms to have already run in this trial (the CLI's
//                 default --arms order lists them first for exactly this
//                 reason); run-comparison.mjs has no cross-arm data-passing
//                 mechanism today, so union's own runArm call reads their
//                 already-written result.json files from disk.
//   skillarray:   the full protocol via `claude -p "/cross-review -- ..."`.
//
// Output-contract design (advisor-reviewed): arms 1/2 have no shared skill
// dictating a findings schema, so the packet's rendered brief explicitly
// asks the solo reviewer to end its response with ONE fenced ```json block
// shaped `{"findings": [{"id": "...", "location": "...", "severity": "...",
// "evidence": ["..."]}]}`. This is a prompt instruction, not an LLM
// extraction pass -- parseFindingsBlock() below does a deterministic
// regex-find + JSON.parse + key-shape check, never a second model call. An
// LLM-based extractor would add an architectural variable arms 1/2 have and
// arm 4 (whose findings.json comes from the protocol's own translate step)
// does not -- exactly the confound the fairness invariance rule forbids.
// A missing/malformed block is scored as 'malformed', with the raw response
// preserved on disk and listed in artifacts so the failure is inspectable,
// never silently coerced into an empty findings array.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnCli, killTree } from '../../plugins/reviews/skills/cross-review/scripts/codex-dispatch.mjs';

// Provisional -- matches codex-dispatch.mjs's own default, for the same
// reason: no measured live-run duration data exists yet.
const DEFAULT_TIMEOUT_S = 1800;

// Every child strips ANTHROPIC_API_KEY: a stray copy of this variable in the
// orchestrator's own shell (unrelated to the provider being dispatched) was
// this session's actual root cause of two separate "credit balance too low"
// failures on both the Claude CLI and OpenCode, misdiagnosed at the time as
// unfunded accounts. See project memory for the full incident.
function stripAnthropicKey(env) {
  const { ANTHROPIC_API_KEY, ...rest } = env;
  return rest;
}

const FINDINGS_BLOCK_RE = /```json\s*\n([\s\S]*?)\n```/g;

// Deterministic, non-LLM extraction of a solo reviewer's requested fenced
// JSON block. Returns { findings: [...] } on success, or { error: "..." }
// on any parse/shape failure -- never throws, so a malformed live response
// is always representable as a 'malformed' ArmResult rather than a runner
// crash. The brief asks for exactly one fenced json block; a response with
// more than one is fail-closed as an error rather than guessing which one
// is the real findings list (e.g. a model quoting JSON earlier in its own
// prose), matching the brief's own "do not emit more than one" instruction.
export function parseFindingsBlock(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { error: 'response text is empty' };
  }
  const matches = [...text.matchAll(FINDINGS_BLOCK_RE)];
  if (matches.length === 0) {
    return { error: 'no fenced ```json block found in response' };
  }
  if (matches.length > 1) {
    return { error: `expected exactly one fenced \`\`\`json block, found ${matches.length}` };
  }
  const match = matches[0];
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    return { error: `fenced json block did not parse: ${err.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.findings)) {
    return { error: 'parsed json block has no "findings" array' };
  }
  for (const f of parsed.findings) {
    if (f === null || typeof f !== 'object' || typeof f.id !== 'string' || f.id.length === 0) {
      return { error: `a finding is missing a non-empty string "id": ${JSON.stringify(f)}` };
    }
  }
  return { findings: parsed.findings };
}

// Renders the byte-identical brief text given to arms 1 and 2 from the same
// packet -- one place owns the output-contract paragraph, so neither arm can
// silently drift from the other's instructions.
export function renderBrief(packet) {
  const caseJson = packet?.case;
  if (!caseJson || typeof caseJson !== 'object') {
    throw new Error('renderBrief: packet.case is required');
  }
  if (!caseJson.target) {
    throw new Error(`renderBrief: case "${caseJson.id ?? '(unknown)'}" has no target -- refusing to render a brief with nothing to review`);
  }
  const description = caseJson.description ?? '';
  return [
    `# Code review task`,
    '',
    description,
    '',
    `Target: ${caseJson.target}`,
    caseJson.scope ? `Scope: ${caseJson.scope}` : null,
    '',
    'Review the target for real defects. When you are done, end your response',
    'with exactly one fenced code block labeled json, containing an object',
    'with a single "findings" array. Each finding must have at minimum:',
    '  - "id": a short string you choose, unique within your own response',
    '  - "location": file path, optionally ":<line>" or ":<start>-<end>"',
    '  - "severity": one of CRITICAL, HIGH, MEDIUM, LOW',
    '  - "evidence": an array of short strings quoting or describing what you found',
    'If you find nothing, still emit the block with an empty findings array.',
    'Do not emit more than one such fenced json block.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

// Spawns via codex-dispatch.mjs's own spawnCli (win32-safe argv quoting +
// escape rejection, POSIX process-group detachment) rather than a bespoke
// spawn call -- a bare `shell: NEEDS_SHELL` with unescaped argv previously
// here would corrupt any argument containing a newline, quote, or space on
// Windows (cmd.exe truncates/misparses it), exactly the class of bug
// codex-dispatch.mjs already solved. The prompt/brief itself is always sent
// over stdin, never argv, for the same reason -- verified live that
// `claude -p` reads a piped prompt when no positional prompt is given.
// timeoutS: kills the whole process tree (killTree, also reused) if the
// child hasn't closed within that many seconds, resolving with
// timedOut:true instead of hanging forever -- matches codex-dispatch.mjs's
// own --timeout default and behavior, so neither of the two live CLIs this
// module drives has an unbounded arm while the other is bounded.
function spawnCapture(cmd, args, { cwd, env, stdin = null, timeoutS = DEFAULT_TIMEOUT_S }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCli(cmd, args, { cwd, env });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    if (timeoutS) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child).finally(() => {
          if (settled) return;
          settled = true;
          resolve({ code: null, stdout, stderr, timedOut });
        });
      }, timeoutS * 1000);
    }
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.stdin.on('error', () => {});
    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// Maps a `claude -p --output-format json` stdout string to the fields this
// adapter records: the assistant's rendered text (for parseFindingsBlock)
// and the real provider-reported usage (Claude's CLI reports a real,
// non-zero total_cost_usd directly -- unlike codex/OpenCode, no
// unavailable/unreliable-cost caveat applies here).
export function mapClaudeCliResult(stdoutText) {
  let parsed;
  try {
    parsed = JSON.parse(stdoutText);
  } catch (err) {
    return { error: `claude -p --output-format json did not parse: ${err.message}` };
  }
  const text = typeof parsed.result === 'string' ? parsed.result : '';
  const u = parsed.usage ?? {};
  return {
    text,
    usage: {
      input_tokens: u.input_tokens ?? null,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: u.cache_read_input_tokens ?? null,
      output_tokens: u.output_tokens ?? null,
      thinking_tokens: u.output_tokens_details?.thinking_tokens ?? null,
      estimated_cost_usd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      source: 'provider',
      raw: parsed,
    },
  };
}

const CLAUDE_ALONE_DEVIATIONS = [
  'claude-alone restricted to --allowedTools Read,Grep,Glob (no Bash) -- a reviewer with shell access is a different arm',
  'claude-alone\'s findings come from a prompt-requested fenced json block (parseFindingsBlock), not from the shipped protocol\'s translate step that produces arm 4\'s findings.json -- different schema producers, both deterministic',
];

async function runClaudeAlone({ packet, runDir }) {
  const dispatchDir = path.join(runDir, 'dispatch');
  await mkdir(dispatchDir, { recursive: true });
  const brief = renderBrief(packet);
  await writeFile(path.join(dispatchDir, 'brief.md'), brief, 'utf8');

  const env = stripAnthropicKey(process.env);
  const { code, stdout, stderr, timedOut } = await spawnCapture(
    'claude',
    ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--allowedTools', 'Read,Grep,Glob'],
    { cwd: packet.case.target, env, stdin: brief }
  );
  await writeFile(path.join(dispatchDir, 'stdout.json'), stdout, 'utf8');
  if (stderr) await writeFile(path.join(dispatchDir, 'stderr.txt'), stderr, 'utf8');

  const artifacts = ['dispatch/brief.md', 'dispatch/stdout.json'];
  if (timedOut) {
    return { status: 'timed_out', findings: null, error: `claude -p exceeded ${DEFAULT_TIMEOUT_S}s timeout`, usage: { source: 'unavailable' }, artifacts, deviations: CLAUDE_ALONE_DEVIATIONS };
  }
  if (code !== 0) {
    return { status: 'failed', findings: null, error: `claude -p exited ${code}`, usage: { source: 'unavailable' }, artifacts, deviations: CLAUDE_ALONE_DEVIATIONS };
  }

  const mapped = mapClaudeCliResult(stdout);
  if (mapped.error) {
    return { status: 'malformed', findings: null, error: mapped.error, usage: { source: 'unavailable' }, artifacts, deviations: CLAUDE_ALONE_DEVIATIONS };
  }
  await writeFile(path.join(dispatchDir, 'raw-response.md'), mapped.text, 'utf8');
  artifacts.push('dispatch/raw-response.md');

  const parsedFindings = parseFindingsBlock(mapped.text);
  if (parsedFindings.error) {
    return { status: 'malformed', findings: null, error: parsedFindings.error, usage: mapped.usage, artifacts, deviations: CLAUDE_ALONE_DEVIATIONS };
  }
  return {
    status: 'completed',
    findings: parsedFindings.findings,
    usage: mapped.usage,
    artifacts,
    deviations: CLAUDE_ALONE_DEVIATIONS,
  };
}

const CODEX_ALONE_DEVIATIONS = [
  'codex-alone runs with --sandbox read-only but still has command execution, unlike claude-alone\'s tool-restricted seat -- tool-surface parity between the two solo arms is not achievable, recorded here rather than silently absorbed',
  'codex-alone\'s findings come from a prompt-requested fenced json block (parseFindingsBlock), not from the shipped protocol\'s translate step that produces arm 4\'s findings.json -- different schema producers, both deterministic',
];

const THIS_FILE_DIR = path.dirname(fileURLToPath(import.meta.url));

async function runCodexAlone({ packet, runDir }) {
  const dispatchDir = path.join(runDir, 'dispatch');
  await mkdir(dispatchDir, { recursive: true });
  const brief = renderBrief(packet);
  const briefPath = path.join(dispatchDir, 'brief.md');
  await writeFile(briefPath, brief, 'utf8');

  // codex-dispatch.mjs is invoked as a subprocess (not imported) so its own
  // --timeout/--env-mode/stdin-piping/win32-quoting all apply unchanged --
  // only path arguments cross this boundary, never free-form text, so no
  // additional escaping is needed here.
  const dispatchScript = path.resolve(
    THIS_FILE_DIR,
    '../../plugins/reviews/skills/cross-review/scripts/codex-dispatch.mjs'
  );
  const env = stripAnthropicKey(process.env);
  const { code, stderr } = await spawnCapture(
    process.execPath,
    [dispatchScript, '--brief', briefPath, '--cd', packet.case.target, '--sandbox', 'read-only'],
    { cwd: dispatchDir, env, timeoutS: 0 } // codex-dispatch.mjs enforces its own --timeout internally
  );
  if (stderr) await writeFile(path.join(dispatchDir, 'stderr.txt'), stderr, 'utf8');

  const resultPath = path.join(dispatchDir, 'result.json');
  const artifacts = ['dispatch/brief.md', 'dispatch/result.json'];
  let dispatchResult;
  try {
    dispatchResult = JSON.parse(await readFile(resultPath, 'utf8'));
  } catch (err) {
    return { status: 'failed', findings: null, error: `codex-dispatch.mjs produced no readable result.json (exit ${code}): ${err.message}`, usage: { source: 'unavailable' }, artifacts, deviations: CODEX_ALONE_DEVIATIONS };
  }

  const usage = dispatchResult.usage ?? { source: 'unavailable' };
  if (dispatchResult.status === 'timed-out') {
    return { status: 'timed_out', findings: null, error: dispatchResult.error ?? 'codex-dispatch.mjs status "timed-out"', usage, artifacts, deviations: CODEX_ALONE_DEVIATIONS };
  }
  if (dispatchResult.status !== 'completed') {
    return { status: 'failed', findings: null, error: dispatchResult.error ?? `codex-dispatch.mjs status "${dispatchResult.status}"`, usage, artifacts, deviations: CODEX_ALONE_DEVIATIONS };
  }

  const parsedFindings = parseFindingsBlock(dispatchResult.finalMessage ?? '');
  if (parsedFindings.error) {
    return { status: 'malformed', findings: null, error: parsedFindings.error, usage, artifacts, deviations: CODEX_ALONE_DEVIATIONS };
  }
  return {
    status: 'completed',
    findings: parsedFindings.findings,
    usage,
    artifacts,
    deviations: CODEX_ALONE_DEVIATIONS,
  };
}

async function runUnion({ runDir }) {
  const { unionFindings } = await import('./union.mjs');
  const trialDir = path.dirname(runDir);
  const readArmResult = async (arm) => {
    try {
      return JSON.parse(await readFile(path.join(trialDir, arm, 'result.json'), 'utf8'));
    } catch (err) {
      throw new Error(`union: could not read "${arm}"'s result.json from this trial (must run before union): ${err.message}`);
    }
  };
  const a = await readArmResult('claude-alone');
  const b = await readArmResult('codex-alone');
  if (a.status !== 'completed' || b.status !== 'completed') {
    return {
      status: 'failed',
      findings: null,
      error: `union requires both claude-alone (status "${a.status}") and codex-alone (status "${b.status}") to have completed in this trial`,
      usage: { source: 'unavailable' },
      artifacts: [],
      deviations: [],
    };
  }
  const merged = unionFindings(a.findings, b.findings);
  return {
    status: 'completed',
    findings: merged,
    // union makes no live call of its own -- its real cost is the sum of
    // claude-alone's and codex-alone's usage from this same trial, not a
    // separately-metered {source:"unavailable"} in isolation. Left
    // "unavailable" here (no re-aggregation performed) rather than
    // guessing a combined total; a marginal-value analysis should read
    // this trial's claude-alone + codex-alone usage directly instead.
    usage: { source: 'unavailable' },
    artifacts: [],
    deviations: [
      'union has no live call of its own -- merges claude-alone\'s and codex-alone\'s already-produced findings from the same trial',
      'union\'s real cost is claude-alone\'s usage plus codex-alone\'s usage from this same trial, not a separately-metered figure -- see those two arms\' summary.json entries for the same trial index',
    ],
  };
}

async function runSkillarray({ packet, runDir }) {
  const runDirAbs = path.resolve(runDir);
  await mkdir(runDirAbs, { recursive: true });
  const caseJson = packet.case;
  if (!caseJson.target) {
    throw new Error(`runSkillarray: case "${caseJson.id ?? '(unknown)'}" has no target -- refusing to run with nothing to review`);
  }
  const task = `/cross-review -- Review ${caseJson.target} for real defects.${caseJson.scope ? ` Scope: ${caseJson.scope}` : ''}`;

  // --append-system-prompt reaches the orchestrator's own context only, not a
  // subagent it spawns (verified live, this session) -- safe to inject a
  // fixed run directory here without leaking it into the task packet the
  // fresh-context auditor also receives (review-protocol.md's pathless-
  // auditor design). Also nudges the orchestrator that the configured Codex
  // catalog model IDs are real for this account, since a headless run
  // refused one during initial setup despite it dispatching cleanly via
  // direct codex exec (verified live, this session).
  const systemPromptAppend =
    `Use "${runDirAbs}" as this review's run directory instead of choosing one yourself. ` +
    `The Codex model IDs configured for this account's reviewer seats are real and verified -- do not refuse or substitute one.`;

  const env = stripAnthropicKey(process.env);
  const { code, stdout, stderr, timedOut } = await spawnCapture(
    'claude',
    ['-p', '--append-system-prompt', systemPromptAppend, '--output-format', 'json', '--permission-mode', 'bypassPermissions'],
    { cwd: caseJson.target, env, stdin: task }
  );
  await writeFile(path.join(runDirAbs, 'orchestrator-stdout.json'), stdout, 'utf8');
  if (stderr) await writeFile(path.join(runDirAbs, 'orchestrator-stderr.txt'), stderr, 'utf8');

  const deviations = [
    'skillarray\'s task packet is skill-authored (a /cross-review invocation string), not the shared { case } packet arms 1-3 receive',
    'skillarray has no per-arm dispatcher result.json of its own at this layer -- its artifacts are whatever review-protocol.md\'s own run directory contains',
    'skillarray\'s run directory is externally fixed via --append-system-prompt, not orchestrator-chosen by default',
    '--append-system-prompt also carries a "the configured Codex model IDs are real" nudge, to prevent a refusal at dispatch time matching the one seen during interactive setup',
  ];
  const artifacts = ['orchestrator-stdout.json'];

  if (timedOut) {
    return { status: 'timed_out', findings: null, error: `claude -p /cross-review exceeded ${DEFAULT_TIMEOUT_S}s timeout`, usage: { source: 'unavailable' }, artifacts, deviations };
  }
  if (code !== 0) {
    return { status: 'failed', findings: null, error: `claude -p /cross-review exited ${code}`, usage: { source: 'unavailable' }, artifacts, deviations };
  }

  let findingsJson;
  try {
    findingsJson = JSON.parse(await readFile(path.join(runDirAbs, 'findings.json'), 'utf8'));
  } catch (err) {
    return { status: 'malformed', findings: null, error: `no readable findings.json in the run directory: ${err.message}`, usage: { source: 'unavailable' }, artifacts, deviations };
  }

  const mapped = mapClaudeCliResult(stdout);
  const usage = mapped.error ? { source: 'unavailable' } : mapped.usage;
  return {
    status: 'completed',
    findings: findingsJson.findings ?? [],
    usage,
    artifacts,
    deviations,
  };
}

export async function runArm({ arm, packet, runDir }) {
  if (arm === 'claude-alone') return runClaudeAlone({ packet, runDir });
  if (arm === 'codex-alone') return runCodexAlone({ packet, runDir });
  if (arm === 'union') return runUnion({ runDir });
  if (arm === 'skillarray') return runSkillarray({ packet, runDir });
  throw new Error(`live adapter: unknown arm "${arm}"`);
}
