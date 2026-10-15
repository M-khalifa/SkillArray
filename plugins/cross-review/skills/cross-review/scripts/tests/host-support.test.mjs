import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTS, supportOf, evaluateSupport, validateSupport, hostStatusOf, actorsOf } from '../host-support.mjs';

const actor = (role, runtime, transport) => ({ role, runtime, transport });
const descriptor = (host, seatA, seatB, auditor, extra = {}) => ({ host, seatA, seatB, auditor, verifiers: [], ...extra });

test('the table: the Claude Code cells that work, the OpenCode trial, and every native cell the host cannot start', () => {
  assert.deepEqual(HOSTS, ['claude-code', 'codex']);
  for (const [runtime, transport, status] of [
    ['claude', 'native', 'supported'], ['claude', 'cli', 'supported'], ['codex', 'cli', 'supported'],
    ['opencode', 'cli', 'trial'], ['codex', 'native', 'unsupported'], ['opencode', 'native', 'unsupported'],
  ]) assert.equal(supportOf('claude-code', { runtime, transport }).status, status, `claude-code ${runtime}/${transport}`);
});

test('the Codex host opens native Codex as a trial, gates a Claude CLI seat on a probe, and refuses every other combination', () => {
  assert.equal(supportOf('codex', { runtime: 'codex', transport: 'native' }).status, 'trial');
  for (const role of ['auditor', 'verifier-1']) assert.equal(supportOf('codex', { role, runtime: 'claude', transport: 'cli' }).status, 'trial', `a single-call Claude CLI ${role} starts as a plain detached process on a Codex host`);
  for (const role of ['A', 'B']) assert.equal(supportOf('codex', { role, runtime: 'claude', transport: 'cli' }).status, 'probe', `a Claude CLI seat ${role} is usable only when preflight proved its session survives`);
  for (const runtime of ['codex', 'opencode']) assert.equal(supportOf('codex', { runtime, transport: 'cli' }).status, 'unsupported', `codex host ${runtime}/cli`);
  for (const runtime of ['claude', 'opencode']) assert.equal(supportOf('codex', { runtime, transport: 'native' }).status, 'unsupported', `codex host ${runtime}/native`);
  assert.match(supportOf('codex', { runtime: 'claude', transport: 'cli' }).reason, /plain detached process/);
  assert.match(supportOf('codex', { runtime: 'codex', transport: 'cli' }).reason, /nested codex CLI/);
});

test('a host outside the table and an unknown runtime have no rule here (the descriptor check names them)', () => {
  assert.equal(supportOf('descriptor-host-name', { runtime: 'codex', transport: 'native' }).status, 'supported');
  assert.equal(supportOf('claude-code', { runtime: 'nope', transport: 'cli' }).status, 'supported');
});

test('evaluateSupport covers seats, auditor and verifiers; hostStatusOf is trial when any actor is a trial', () => {
  const d = descriptor('claude-code', actor('A', 'claude', 'native'), actor('B', 'opencode', 'cli'), actor('auditor', 'claude', 'native'), { verifiers: [actor('verifier-1', 'codex', 'cli')] });
  assert.equal(actorsOf(d).length, 4);
  const rows = evaluateSupport(d);
  assert.deepEqual(rows.map((r) => [r.role, r.status]), [['A', 'supported'], ['B', 'trial'], ['auditor', 'supported'], ['verifier-1', 'supported']]);
  assert.equal(hostStatusOf(rows), 'trial');
  assert.equal(hostStatusOf(rows.filter((r) => r.status === 'supported')), 'supported');
});

test('validateSupport: unsupported always throws; a trial actor needs support[] naming it as trial', () => {
  const trial = descriptor('claude-code', actor('A', 'claude', 'native'), actor('B', 'opencode', 'cli'), actor('auditor', 'claude', 'native'));
  assert.throws(() => validateSupport(trial), /actor "B" \(opencode, cli\) is a trial route on host claude-code.*run preflight --host with --allow-trial/);
  assert.throws(() => validateSupport({ ...trial, support: [{ role: 'A', status: 'supported' }] }), /trial route/);
  assert.doesNotThrow(() => validateSupport({ ...trial, support: [{ role: 'B', runtime: 'opencode', transport: 'cli', status: 'trial' }] }));
  const bad = descriptor('claude-code', actor('A', 'claude', 'native'), actor('B', 'codex', 'cli'), actor('auditor', 'codex', 'native'));
  assert.throws(() => validateSupport({ ...bad, support: [{ role: 'auditor', status: 'trial' }] }), /actor "auditor" is a native codex agent, but host claude-code can only start native claude agents; use transport cli/);
  const codexHost = descriptor('codex', actor('A', 'codex', 'native'), actor('B', 'codex', 'native'), actor('auditor', 'codex', 'cli'));
  assert.throws(() => validateSupport({ ...codexHost, support: [{ role: 'A', status: 'trial' }, { role: 'B', status: 'trial' }] }), /actor "auditor" is a nested codex CLI start is blocked/);
});

test('validateSupport: a probe row needs a recorded trial row with probe.ok', () => {
  const d = descriptor('codex', actor('A', 'claude', 'cli'), actor('B', 'codex', 'native'), actor('auditor', 'claude', 'cli'));
  const trial = (role, extra = {}) => ({ role, status: 'trial', ...extra });
  assert.throws(() => validateSupport({ ...d, support: [trial('B'), trial('auditor')] }), /actor "A" \(claude, cli\) needs a session probe on host codex/);
  assert.throws(() => validateSupport({ ...d, support: [trial('A'), trial('B'), trial('auditor')] }), /needs a session probe/, 'a trial row without probe.ok is not proof');
  assert.doesNotThrow(() => validateSupport({ ...d, support: [trial('A', { probe: { ok: true } }), trial('B'), trial('auditor')] }));
  assert.equal(hostStatusOf(evaluateSupport(d)), 'trial');
});
