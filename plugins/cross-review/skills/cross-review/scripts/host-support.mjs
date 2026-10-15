// Which (host, actor runtime, transport) combinations a review may use, and how far each is trusted.
// supported: runs end to end and is tested. trial: runs but is not proven; needs preflight --allow-trial.
// unsupported: refused, no override.

import { RUNTIMES } from './provider-catalog.mjs';

export const HOSTS = Object.freeze(['claude-code', 'codex']);

const NATIVE_CODEX_TRIAL = 'a native Codex agent works from a Codex orchestrator but the sequencer route has not completed a full run yet';

const CLAUDE_CLI_TRIAL = 'WMI is refused inside a Codex sandbox, so the worker starts as a plain detached process; a single call completed from codex exec, a long one has not been run';
const CLAUDE_SEAT_NEEDS_PROBE = 'whether a Claude CLI session survives a call depends on how Codex was launched (two `codex exec` runs left no session file and the resume failed with "No conversation found"; another live Codex run kept and resumed it), so preflight must prove it here: pass --probe-claude-session --yes-paid (two small Claude Haiku calls)';
const SEAT_ROLE = /^[AB]$/;

// Rows: [runtime, transport, status, reason, optional role pattern]; the first matching row wins.
// probe: usable as a trial route only when preflight proved it for this launch (the run.json support row then carries probe.ok).
const TABLE = Object.freeze({
  'claude-code': [
    ['claude', 'native', 'supported', ''],
    ['claude', 'cli', 'supported', ''],
    ['codex', 'cli', 'supported', ''],
    ['opencode', 'cli', 'trial', 'an OpenCode seat has never been run end to end'],
    ['codex', 'native', 'unsupported', 'a native codex agent, but host claude-code can only start native claude agents; use transport cli'],
    ['opencode', 'native', 'unsupported', 'a native opencode agent, but host claude-code can only start native claude agents; use transport cli'],
  ],
  codex: [
    ['codex', 'native', 'trial', NATIVE_CODEX_TRIAL],
    ['claude', 'native', 'unsupported', 'a native claude agent, but host codex can only start native codex agents'],
    ['claude', 'cli', 'probe', CLAUDE_SEAT_NEEDS_PROBE, SEAT_ROLE],
    ['claude', 'cli', 'trial', CLAUDE_CLI_TRIAL],
    ['codex', 'cli', 'unsupported', 'a nested codex CLI start is blocked by the Codex sandbox (references/hosts/codex.md)'],
    ['opencode', 'cli', 'unsupported', 'an OpenCode CLI start from a Codex host has not been tried and is blocked like the other nested CLI starts'],
    ['opencode', 'native', 'unsupported', 'a native opencode agent, but host codex can only start native codex agents'],
  ],
});

// A host name outside the table (a test fixture, a future host) has no rules here, and an unknown runtime is left
// to the descriptor's own check, which names it better.
export function supportOf(host, actor) {
  const rows = TABLE[host];
  if (!rows || !Object.hasOwn(RUNTIMES, actor.runtime)) return { status: 'supported', reason: '' };
  const row = rows.find(([runtime, transport, , , roles]) => runtime === actor.runtime && transport === actor.transport && (!roles || roles.test(actor.role ?? '')));
  if (!row) return { status: 'unsupported', reason: `no support rule for runtime ${actor.runtime} with transport ${actor.transport} on host ${host}` };
  return { status: row[2], reason: row[3] };
}

export function actorsOf(descriptor) {
  return [descriptor.seatA, descriptor.seatB, descriptor.auditor, ...(Array.isArray(descriptor.verifiers) ? descriptor.verifiers : [])];
}

// One row per actor: { role, runtime, transport, status, reason }.
export function evaluateSupport(descriptor) {
  return actorsOf(descriptor).map((actor) => ({ role: actor.role, runtime: actor.runtime, transport: actor.transport, ...supportOf(descriptor.host, actor) }));
}

// Throws a plain Error naming the first problem; the descriptor reader wraps it.
export function validateSupport(descriptor) {
  const recorded = Array.isArray(descriptor.support) ? descriptor.support : null;
  for (const row of evaluateSupport(descriptor)) {
    if (row.status === 'unsupported') {
      throw new Error(`actor "${row.role}" is ${row.reason || `${row.runtime} with transport ${row.transport}`}; ${row.runtime}/${row.transport} is unsupported on host ${descriptor.host}`);
    }
    if (row.status === 'probe' && !recorded?.some((r) => r?.role === row.role && r.status === 'trial' && r.probe?.ok === true)) {
      throw new Error(`actor "${row.role}" (${row.runtime}, ${row.transport}) needs a session probe on host ${descriptor.host}: ${row.reason}`);
    }
    if (row.status === 'trial' && !recorded?.some((r) => r?.role === row.role && r.status === 'trial')) {
      throw new Error(`actor "${row.role}" (${row.runtime}, ${row.transport}) is a trial route on host ${descriptor.host}: ${row.reason}; run preflight --host with --allow-trial`);
    }
  }
}

export function hostStatusOf(rows) {
  return rows.some((row) => row.status === 'trial' || row.status === 'probe') ? 'trial' : 'supported';
}
