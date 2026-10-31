// Pure-function tests for ../codex-dispatch.mjs. No live codex CLI, no network.
// Run: node --test scripts/tests/codex-dispatch.test.mjs
// (name the file -- the directory form `node --test scripts/tests/` reports a spurious failure)
import { test } from 'node:test';
import { assertWin32Safe, posixKillTree } from '../spawn-utils.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SEAT_CONFIG_OVERRIDES,
  findChildThreads,
  parsePorcelainRecords,
  parsePorcelainPaths,
  diffTouchedFiles,
  checkSessionIdentity,
  parseArgs,
  buildCodexArgs,
  RelayError,
  installSignalForwarding,
  RESULT_REQUIRED_KEYS,
  codexReadOnly,
  retryDeadline,
  spawnCli,
  buildChildEnv,
  buildUsageField,
  buildUsageDelta,
  mcpOffOverrides,
  resolvedEffort,
  CODEX_DEFAULT_EFFORT,
} from '../codex-dispatch.mjs';

test('Linux round F9: the resolved effort is the rollout\'s own; with none and no --effort it is the Codex-default marker, never a silent null', () => {
  const line = (o) => JSON.stringify(o);
  const withEffort = [line({ type: 'session_meta', payload: { id: 't' } }), line({ type: 'turn_context', payload: { model: 'gpt-6-sol', effort: 'high' } })].join('\n');
  const noEffort = [line({ type: 'session_meta', payload: { id: 't' } }), line({ type: 'turn_context', payload: { model: 'gpt-5.6-luna', reasoning_effort: null } })].join('\n');
  assert.equal(resolvedEffort(withEffort, 'high'), 'high');
  assert.equal(resolvedEffort(noEffort, null), CODEX_DEFAULT_EFFORT);
  assert.equal(CODEX_DEFAULT_EFFORT, 'codex-default (not reported)');
  assert.equal(resolvedEffort(noEffort, 'medium'), null, 'an asked-for effort the rollout does not confirm stays unknown');
  assert.equal(resolvedEffort(null, null), null, 'no rollout: unknown');
});

// assertWin32Safe only throws on win32; skip the throwing tests elsewhere.
const IS_WIN32 = process.platform === 'win32';

test('parsePorcelainRecords: plain ASCII filenames pass through unchanged', () => {
  const records = parsePorcelainRecords(' M plain.txt\0?? new.txt\0');
  assert.deepEqual(records, [
    { code: ' M', paths: ['plain.txt'] },
    { code: '??', paths: ['new.txt'] },
  ]);
});

test('parsePorcelainRecords: -z output needs no unquoting for spaces/non-ASCII (the whole point of -z)', () => {
  const records = parsePorcelainRecords(' M has space.txt\0?? uni-café.txt\0');
  assert.deepEqual(records, [
    { code: ' M', paths: ['has space.txt'] },
    { code: '??', paths: ['uni-café.txt'] },
  ]);
});

test('parsePorcelainRecords: rename/copy record reassembles from two consecutive NUL fields', () => {
  // Status code is "R  " (R + two spaces), not "R100" with an inline similarity percentage.
  const records = parsePorcelainRecords('R  new name.txt\0old name.txt\0');
  assert.deepEqual(records, [{ code: 'R ', paths: ['new name.txt', 'old name.txt'] }]);
});

test('parsePorcelainRecords: a rename record whose NEW path itself contains " -> " is not corrupted', () => {
  const records = parsePorcelainRecords('R  new -> weird.txt\0old.txt\0');
  assert.deepEqual(records, [{ code: 'R ', paths: ['new -> weird.txt', 'old.txt'] }]);
});

test('parsePorcelainRecords: a rename record whose OLD path itself contains " -> " is not corrupted', () => {
  const records = parsePorcelainRecords('R  new.txt\0old -> weird.txt\0');
  assert.deepEqual(records, [{ code: 'R ', paths: ['new.txt', 'old -> weird.txt'] }]);
});

test('parsePorcelainRecords: a PLAIN (non-rename) record with " -> " in the filename is not misread as a rename', () => {
  const records = parsePorcelainRecords(' M a -> b.txt\0');
  assert.deepEqual(records, [{ code: ' M', paths: ['a -> b.txt'] }]);
});

test('parsePorcelainPaths: extracts both sides of a rename', () => {
  const paths = parsePorcelainPaths({ code: 'R ', paths: ['new name.txt', 'old name.txt'] });
  assert.deepEqual([...paths].sort(), ['new name.txt', 'old name.txt']);
});

test('parsePorcelainPaths: extracts a plain modified path', () => {
  const paths = parsePorcelainPaths({ code: ' M', paths: ['has space.txt'] });
  assert.deepEqual([...paths], ['has space.txt']);
});

test('diffTouchedFiles: detects a newly untracked file', () => {
  const before = ' M plain.txt\0';
  const after = ' M plain.txt\0?? new.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['new.txt']);
});

test('diffTouchedFiles: detects a status-code change on the same path (" M" -> "MM")', () => {
  const before = ' M plain.txt\0';
  const after = 'MM plain.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['plain.txt']);
});

test('diffTouchedFiles: a file with a space in its name reports cleanly, not mangled', () => {
  const before = '';
  const after = '?? has space.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['has space.txt']);
});

test('diffTouchedFiles: a rename whose path contains " -> " reports the real filenames, not split fragments', () => {
  const before = '';
  const after = 'R  new -> weird.txt\0old.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['new -> weird.txt', 'old.txt']);
});

test('diffTouchedFiles: a plain modify with " -> " in the filename reports the real filename whole', () => {
  const before = '';
  const after = ' M a -> b.txt\0';
  assert.deepEqual(diffTouchedFiles(before, after), ['a -> b.txt']);
});

test('diffTouchedFiles: known limitation — a file dirty before AND modified again during the run can be under-reported', () => {
  const before = ' M plain.txt\0';
  const after = ' M plain.txt\0'; // same status code both times, despite a real edit
  assert.deepEqual(diffTouchedFiles(before, after), []);
});

test('checkSessionIdentity: a fresh dispatch with a confirmed thread id is sound', () => {
  assert.equal(checkSessionIdentity({ session: null, observedThreadId: 'abc-123' }), null);
});

test('checkSessionIdentity: a resume where the observed id matches the requested session is sound', () => {
  assert.equal(checkSessionIdentity({ session: 'abc-123', observedThreadId: 'abc-123' }), null);
});

test('checkSessionIdentity: a fresh dispatch with NO thread id observed fails closed', () => {
  const err = checkSessionIdentity({ session: null, observedThreadId: null });
  assert.match(err, /no thread\.started event was observed/);
});

test('checkSessionIdentity: a resume with NO thread id observed fails closed (does not silently retain the request)', () => {
  const err = checkSessionIdentity({ session: 'requested-id', observedThreadId: null });
  assert.match(err, /requested session "requested-id"/);
  assert.match(err, /no thread\.started event was observed/);
});

test('checkSessionIdentity: a resume where the observed id does NOT match the requested session fails closed', () => {
  const err = checkSessionIdentity({ session: 'requested-id', observedThreadId: 'different-id' });
  assert.match(err, /session mismatch/);
  assert.match(err, /requested "requested-id"/);
  assert.match(err, /observed thread_id "different-id"/);
});

test('assertWin32Safe: rejects a trailing backslash (escapes the closing quote, merges the next argv entry) (platform injected, runs on every OS)', () => {
  assert.throws(() => assertWin32Safe('C:\\repo\\', { platform: 'win32' }), /unsafe to pass through cmd\.exe/);
});

test('assertWin32Safe: rejects an embedded double quote (can re-expose shell metacharacters) (platform injected, runs on every OS)', () => {
  assert.throws(() => assertWin32Safe('x" & echo INJECTED & rem "', { platform: 'win32' }), /unsafe to pass through cmd\.exe/);
});

test('assertWin32Safe: rejects a percent sign (cmd.exe expands %VAR% inside double quotes) (platform injected, runs on every OS)', () => {
  assert.throws(() => assertWin32Safe('before %USERNAME% after', { platform: 'win32' }), /unsafe to pass through cmd\.exe/);
});

test('assertWin32Safe: the same unsafe characters are not rejected on a non-win32 platform (the guard is win32-specific)', () => {
  assert.doesNotThrow(() => assertWin32Safe('before %USERNAME% after', { platform: 'linux' }));
});

test('assertWin32Safe: accepts an ordinary path with no special characters', () => {
  // Not skipped off win32: no-throw is meaningful on every platform.
  assert.doesNotThrow(() => assertWin32Safe('C:\\Users\\me\\repo', { platform: 'win32' }));
});

test('assertWin32Safe: accepts a path with a space (not one of the rejected characters)', () => {
  assert.doesNotThrow(() => assertWin32Safe('C:\\dir with space\\repo', { platform: 'win32' }));
});

test('assertWin32Safe: on a real, uninjected call, follows the actual process platform', () => {
  if (IS_WIN32) {
    assert.throws(() => assertWin32Safe('x" & echo injected'), /unsafe to pass through cmd\.exe/);
  } else {
    assert.doesNotThrow(() => assertWin32Safe('x" & echo injected'));
  }
});

test('parseArgs: a trailing --session with no value is rejected, not silently treated as a fresh dispatch', () => {
  // A bare trailing --session must error, not resolve to undefined and fall into
  // the fresh-dispatch branch, which would silently defeat Phase 2's resume discipline.
  assert.throws(
    () => parseArgs(['--brief', 'b.txt', '--cd', '.', '--session']),
    (err) => err instanceof RelayError && /--session requires a value/.test(err.message)
  );
});

test('parseArgs: --session followed immediately by another flag is rejected, not consumed as the value', () => {
  // `--session --cd /tmp` must not read '--cd' as the session value and then
  // consume the real --cd on the next iteration, corrupting both.
  assert.throws(
    () => parseArgs(['--brief', 'b.txt', '--session', '--cd', '.']),
    (err) => err instanceof RelayError && /--session requires a value/.test(err.message)
  );
});

test('parseArgs: a trailing --brief/--cd/--sandbox with no value is rejected the same way', () => {
  assert.throws(() => parseArgs(['--brief']), /--brief requires a value/);
  assert.throws(() => parseArgs(['--brief', 'b.txt', '--cd']), /--cd requires a value/);
  assert.throws(
    () => parseArgs(['--brief', 'b.txt', '--cd', '.', '--sandbox']),
    /--sandbox requires a value/
  );
});

test('parseArgs: a well-formed --session with a real value still parses correctly', () => {
  const args = parseArgs(['--brief', 'b.txt', '--cd', '.', '--session', 'thread-123']);
  assert.equal(args.session, 'thread-123');
});

test('parseArgs: --isolate is rejected with a message pointing at --sandbox read-only, not a bare "unrecognized argument"', () => {
  assert.throws(
    () => parseArgs(['--brief', 'b.txt', '--cd', '.', '--isolate']),
    /not a codex-dispatch option.*--sandbox read-only/s
  );
});

test('parseArgs: sandbox defaults to read-only when --sandbox is omitted', () => {
  const args = parseArgs(['--brief', 'b.txt', '--cd', '.']);
  assert.equal(args.sandbox, 'read-only');
});

test('parseArgs: --web defaults to false and is a boolean flag with no value', () => {
  const withoutWeb = parseArgs(['--brief', 'b.txt', '--cd', '.']);
  assert.equal(withoutWeb.web, false);
  const withWeb = parseArgs(['--brief', 'b.txt', '--cd', '.', '--web']);
  assert.equal(withWeb.web, true);
});

test('model and effort options parse and reject missing or unsafe values', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  const config = parseArgs([...common, '--model', 'gpt-test', '--effort', 'high']);
  assert.equal(config.model, 'gpt-test');
  assert.equal(config.effort, 'high');
  for (const flag of ['--model', '--effort']) {
    assert.throws(() => parseArgs([...common, flag]), /requires a value/);
    assert.throws(() => parseArgs([...common, flag, '']), /requires a value/);
    assert.throws(() => parseArgs([...common, flag, '--session', 'x']), /requires a value/);
  }
  assert.throws(() => parseArgs([...common, '--model', 'x & echo bad']), /model ID/);
  assert.throws(() => parseArgs([...common, '--effort', 'high"']), /level token/);
  assert.throws(() => parseArgs([...common, '--effort', 'default']), /omit/);
});

test('parseArgs: --timeout defaults to a provisional non-null value when omitted, never unlimited by omission', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  const config = parseArgs(common);
  assert.equal(typeof config.timeout, 'number');
  assert.ok(config.timeout > 0, 'the default must be a positive bound, not 0/unlimited');
});

test('parseArgs: --timeout 0 means explicitly unlimited, distinct from omitting the flag', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  const config = parseArgs([...common, '--timeout', '0']);
  assert.equal(config.timeout, 0);
});

test('parseArgs: --timeout accepts a whole number (including 0) and rejects non-numeric, fractional, or negative-looking values', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  assert.equal(parseArgs([...common, '--timeout', '45']).timeout, 45);
  assert.throws(() => parseArgs([...common, '--timeout', 'abc']), /whole number of seconds/);
  assert.throws(() => parseArgs([...common, '--timeout', '5.5']), /whole number of seconds/);
  // A value starting with "-" is consumed as the next flag by takeValue, not
  // as a negative number -- this is existing CLI-parsing behavior, exercised
  // here as "requires a value" rather than the numeric-format error.
  assert.throws(() => parseArgs([...common, '--timeout', '-5']), /requires a value/);
});

test('fresh and resumed argument vectors forward selections without resume sandbox flags', () => {
  const options = { cd: '/target', sandbox: 'read-only', model: 'gpt-test', effort: 'high', userExtensions: true };
  assert.deepEqual(buildCodexArgs(options), [
    'exec', '-C', '/target', '-s', 'read-only', '--model', 'gpt-test',
    '-c', 'model_reasoning_effort=high', '--json', '-',
  ]);
  assert.deepEqual(buildCodexArgs({ ...options, session: 'thread-123' }), [
    'exec', 'resume', 'thread-123', '--model', 'gpt-test',
    '-c', 'model_reasoning_effort=high', '--json', '-',
  ]);
  const defaults = buildCodexArgs({ cd: '.', sandbox: 'read-only', userExtensions: true });
  assert.equal(defaults.includes('--model'), false);
  assert.equal(defaults.includes('-c'), false);
});

test('buildCodexArgs: a seat runs without sub-agents, plugins, apps or the skills catalog on fresh AND resumed calls unless --keep-user-extensions', () => {
  const overrides = SEAT_CONFIG_OVERRIDES.flatMap((o) => ['-c', o]);
  assert.ok(SEAT_CONFIG_OVERRIDES.includes('agents.enabled=false'));
  assert.deepEqual(buildCodexArgs({ cd: '/t', sandbox: 'read-only', effort: 'high' }), [
    'exec', '-C', '/t', '-s', 'read-only', '-c', 'model_reasoning_effort=high', ...overrides, '--json', '-',
  ]);
  assert.deepEqual(buildCodexArgs({ cd: '/t', sandbox: 'read-only', session: 'th-1' }), ['exec', 'resume', 'th-1', ...overrides, '--json', '-']);
  assert.equal(buildCodexArgs({ cd: '/t', sandbox: 'read-only', userExtensions: true }).includes('agents.enabled=false'), false);
  assert.equal(parseArgs(['--brief', 'b', '--cd', 'c']).userExtensions, false);
  assert.equal(parseArgs(['--brief', 'b', '--cd', 'c', '--keep-user-extensions']).userExtensions, true);
});

test('findChildThreads: finds every descendant of the seat thread written during this call, with each one\'s own usage, and nothing else', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sessions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Today's date folder, as Codex writes it: a fixed date would fall out of the search window.
  const now = new Date();
  const day = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await fs.mkdir(day, { recursive: true });
  const meta = (id, parent, agentPath, depth) => JSON.stringify({ type: 'session_meta', payload: { id, ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent, depth, agent_path: agentPath } } } } : { source: 'exec' }) } });
  const tok = (input) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: input - 1, output_tokens: 7 }, last_token_usage: { input_tokens: 1 } } } });
  const write = (name, lines) => fs.writeFile(path.join(day, `rollout-${name}.jsonl`), lines.join('\n') + '\n');
  await write('seat', [meta('seat', null), tok(100)]);
  await write('kid', [meta('kid', 'seat', '/root/a', 1), tok(10), tok(40)]);
  await write('grandkid', [meta('grandkid', 'kid', '/root/a/b', 2), tok(5), '{"type":"event_msg","payload":{"type":"token_co']);
  await write('other', [meta('other', 'unrelated-seat', '/root/x', 1), tok(999)]);
  await write('stale', [meta('stale', 'seat', '/root/old', 1), tok(3)]);
  const old = new Date(Date.now() - 3600_000);
  await fs.utimes(path.join(day, 'rollout-stale.jsonl'), old, old);
  // A child in a date folder days before the call is never read, even with a fresh mtime.
  const oldDay = path.join(root, '2020', '01', '01');
  await fs.mkdir(oldDay, { recursive: true });
  await fs.writeFile(path.join(oldDay, 'rollout-oldday.jsonl'), [meta('oldday', 'seat', '/root/old-day', 1), tok(7)].join('\n') + '\n');
  const since = Date.now() - 60_000;
  const found = await findChildThreads('seat', since, root);
  assert.deepEqual(found.map((c) => [c.threadId, c.parentThreadId, c.agentPath, c.depth, c.usage?.input_tokens]), [
    ['kid', 'seat', '/root/a', 1, 40],
    ['grandkid', 'kid', '/root/a/b', 2, 5],
  ]);
  assert.deepEqual(await findChildThreads('other', since, root), []);
  assert.deepEqual(await findChildThreads(null, since, root), []);
  assert.deepEqual(await findChildThreads('seat', since, path.join(root, 'missing')), []);
});

test('buildCodexArgs: --web prepends --search BEFORE "exec" (a global codex flag, rejected if placed after), on both fresh and resumed argv shapes', () => {
  const fresh = buildCodexArgs({ cd: '/target', sandbox: 'read-only', web: true, userExtensions: true });
  assert.deepEqual(fresh, ['--search', 'exec', '-C', '/target', '-s', 'read-only', '--json', '-']);
  assert.equal(fresh[0], '--search', '--search must be argv[0], ahead of "exec"');
  assert.equal(fresh.indexOf('--search') < fresh.indexOf('exec'), true);

  const resumed = buildCodexArgs({ cd: '/target', sandbox: 'read-only', session: 'thread-123', web: true, userExtensions: true });
  assert.deepEqual(resumed, ['--search', 'exec', 'resume', 'thread-123', '--json', '-']);
  assert.equal(resumed.indexOf('--search') < resumed.indexOf('exec'), true);

  const withoutWeb = buildCodexArgs({ cd: '/target', sandbox: 'read-only' });
  assert.equal(withoutWeb.includes('--search'), false);
});

test('spawnCli: the POSIX branch passes detached:true and shell:false to spawn(), the load-bearing options for posixKillTree\'s process-group kill', () => {
  let captured = null;
  const fakeSpawn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return new EventEmitter();
  };
  spawnCli('codex', ['exec'], { cwd: '/tmp' }, { spawnFn: fakeSpawn, platform: 'linux' });
  assert.equal(captured.cmd, 'codex');
  assert.deepEqual(captured.args, ['exec']);
  assert.equal(captured.opts.detached, true);
  assert.equal(captured.opts.shell, false);
  assert.equal(captured.opts.cwd, '/tmp');
});

test('spawnCli: the win32 branch runs under a shell and does not set detached', () => {
  let captured = null;
  const fakeSpawn = (cmdLine, opts) => {
    captured = { cmdLine, opts };
    return new EventEmitter();
  };
  spawnCli('codex', ['exec'], { cwd: '/tmp' }, { spawnFn: fakeSpawn, platform: 'win32' });
  assert.match(captured.cmdLine, /"codex" "exec"/);
  assert.equal(captured.opts.shell, true);
  assert.equal(captured.opts.detached, undefined);
});

test('spawnCli: A3=B12 -- an injected win32 platform actually reaches assertWin32Safe, so this guard is testable on any OS', () => {
  const fakeSpawn = () => new EventEmitter();
  assert.throws(
    () => spawnCli('codex', ['x" & echo injected'], { cwd: '/tmp' }, { spawnFn: fakeSpawn, platform: 'win32' }),
    /unsafe to pass/
  );
  assert.doesNotThrow(
    () => spawnCli('codex', ['x" & echo injected'], { cwd: '/tmp' }, { spawnFn: fakeSpawn, platform: 'linux' })
  );
});

function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  return child;
}

test('posixKillTree: a child that never exits gets SIGTERM then SIGKILL, both targeting the process group', async () => {
  const calls = [];
  const child = fakeChild();
  const kill = (pid, sig) => calls.push([pid, sig]);
  await posixKillTree(child, { kill, escalateMs: 1 });
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 0], [-4242, 'SIGKILL']]);
});

test('posixKillTree: a child that exits after SIGTERM never gets SIGKILL', async () => {
  const calls = [];
  const child = fakeChild();
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === 'SIGTERM') setImmediate(() => child.emit('exit', null));
  };
  await posixKillTree(child, { kill, escalateMs: 50 });
  assert.deepEqual(calls, [[-4242, 'SIGTERM']]);
});

test('posixKillTree: SIGKILL still fires even when the fake kill sets child.killed like the real one does (the exact regression)', async () => {
  const calls = [];
  const child = fakeChild();
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    child.killed = true;
  };
  await posixKillTree(child, { kill, escalateMs: 1 });
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 0], [-4242, 'SIGKILL']]);
});

test('posixKillTree: a pid that is already gone (ESRCH) is not an error', async () => {
  const child = fakeChild();
  const kill = () => { const err = new Error('no such process'); err.code = 'ESRCH'; throw err; };
  await assert.doesNotReject(() => posixKillTree(child, { kill, escalateMs: 1 }));
});

test('installSignalForwarding: SIGINT and SIGTERM trigger killTree on the child and exit with the matching code', async () => {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const proc = new EventEmitter();
    const child = fakeChild();
    const killed = [];
    const exited = [];
    const killTreeFn = (c) => { killed.push(c); return Promise.resolve(); };
    const exit = (c) => exited.push(c);
    installSignalForwarding(child, { proc, killTreeFn, exit });
    proc.emit(sig);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(killed, [child]);
    assert.deepEqual(exited, [code]);
  }
});

test('closing round 3: a stop signal never signals a CLI that already exited (its pid may be reused), and still kills one that has not', async () => {
  const cases = [[{}, true], [{ exitCode: null, signalCode: null }, true], [{ exitCode: 0 }, false], [{ exitCode: 1 }, false], [{ exitCode: null, signalCode: 'SIGKILL' }, false]];
  for (const [fields, expectKill] of cases) {
    const proc = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 4194301 }, fields);
    const killed = [];
    const exited = [];
    installSignalForwarding(child, { proc, killTreeFn: (c) => { killed.push(c); return Promise.resolve(); }, exit: (c) => exited.push(c) });
    proc.emit('SIGINT');
    await new Promise((r) => setImmediate(r));
    assert.equal(killed.length, expectKill ? 1 : 0, JSON.stringify(fields));
    assert.deepEqual(exited, [130], JSON.stringify(fields));
  }
});

test('installSignalForwarding: a second signal during the kill (Ctrl-C again) is caught and ignored, never left to Node\'s default handler', async () => {
  const proc = new EventEmitter();
  const child = fakeChild();
  const killed = [];
  const exited = [];
  let release;
  const pending = new Promise((r) => { release = r; });
  installSignalForwarding(child, { proc, killTreeFn: (c) => { killed.push(c); return pending; }, exit: (c) => exited.push(c) });
  proc.emit('SIGINT');
  assert.equal(proc.listenerCount('SIGINT'), 1, 'still caught while the kill runs');
  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(killed, [child], 'one kill');
  assert.deepEqual(exited, [130], 'one exit, with the first signal\'s code');
});

test('installSignalForwarding: uninstall removes the listeners, a later signal does nothing', async () => {
  const proc = new EventEmitter();
  const child = fakeChild();
  const killed = [];
  const uninstall = installSignalForwarding(child, {
    proc, killTreeFn: (c) => { killed.push(c); return Promise.resolve(); }, exit: () => {},
  });
  uninstall();
  proc.emit('SIGINT');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(killed, []);
});

test('buildChildEnv: envMode "inherit" returns undefined, matching Node spawn()\'s own full-inheritance default', () => {
  const env = buildChildEnv({ envMode: 'inherit', sourceEnv: { PATH: '/x', AWS_SECRET_ACCESS_KEY: 'super-secret' } });
  assert.equal(env, undefined);
});

test('buildChildEnv: envMode "filtered" strips a secret-shaped variable that is not on the allowlist', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'linux',
    sourceEnv: { PATH: '/usr/bin', HOME: '/home/x', AWS_SECRET_ACCESS_KEY: 'super-secret', GITHUB_TOKEN: 'ghp_x', DB_PASSWORD: 'hunter2' },
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/x');
  assert.ok(!('AWS_SECRET_ACCESS_KEY' in env), 'a secret-shaped var not on the allowlist must be stripped');
  assert.ok(!('GITHUB_TOKEN' in env), 'a secret-shaped var not on the allowlist must be stripped');
  assert.ok(!('DB_PASSWORD' in env), 'a secret-shaped var not on the allowlist must be stripped');
});

test('buildChildEnv: envMode "filtered" keeps CODEX_HOME, codex\'s own credential-locator variable', () => {
  const env = buildChildEnv({ envMode: 'filtered', platform: 'linux', sourceEnv: { PATH: '/usr/bin', CODEX_HOME: '/custom/.codex' } });
  assert.equal(env.CODEX_HOME, '/custom/.codex');
});

test('mcpOffOverrides: one override per enabled server; a server already off is skipped; bad output or an unsafe name is refused', () => {
  assert.deepEqual(mcpOffOverrides(JSON.stringify([{ name: 'node_repl', enabled: true }, { name: 'open-brain' }, { name: 'off', enabled: false }])),
    ['mcp_servers.node_repl.enabled=false', 'mcp_servers.open-brain.enabled=false']);
  assert.deepEqual(mcpOffOverrides('[]'), []);
  assert.throws(() => mcpOffOverrides('not json'), /did not print JSON/);
  assert.throws(() => mcpOffOverrides('{"servers":[]}'), /did not print a list/);
  assert.throws(() => mcpOffOverrides(JSON.stringify([{ name: 'a.b' }])), /cannot be turned off/);
});

test('buildChildEnv: envMode "filtered" keeps the proxy and CA variables a Claude seat keeps', () => {
  const names = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'];
  const env = buildChildEnv({ envMode: 'filtered', platform: 'linux', sourceEnv: { PATH: '/usr/bin', GITHUB_TOKEN: 'x', ...Object.fromEntries(names.map((n) => [n, `v-${n}`])) } });
  for (const n of names) assert.equal(env[n], `v-${n}`, n);
  assert.ok(!('GITHUB_TOKEN' in env));
});

test('buildChildEnv: envMode "filtered" on POSIX keeps LC_*/XDG_* prefixed variables by prefix match, not just exact allowlist entries', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'linux',
    sourceEnv: { PATH: '/usr/bin', LC_ALL: 'en_US.UTF-8', XDG_DATA_HOME: '/home/x/.local/share', RANDOM_VAR: 'not-allowed' },
  });
  assert.equal(env.LC_ALL, 'en_US.UTF-8');
  assert.equal(env.XDG_DATA_HOME, '/home/x/.local/share');
  assert.ok(!('RANDOM_VAR' in env));
});

test('buildChildEnv: envMode "filtered" on win32 uses the win32 allowlist, not the POSIX one (no LC_/XDG_ prefix matching)', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'win32',
    sourceEnv: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\x', LC_ALL: 'en_US.UTF-8', HOME: '/should-not-apply-on-win32' },
  });
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.USERPROFILE, 'C:\\Users\\x');
  assert.ok(!('LC_ALL' in env), 'POSIX-only prefix matching must not apply on win32');
  assert.ok(!('HOME' in env), 'HOME is POSIX-only; win32 uses USERPROFILE');
});

test('buildChildEnv: envPassthrough adds an explicitly named variable that the base allowlist does not cover', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'linux',
    envPassthrough: ['MY_PROVIDER_API_KEY'],
    sourceEnv: { PATH: '/usr/bin', MY_PROVIDER_API_KEY: 'sk-real-key', OTHER_SECRET: 'not-passed' },
  });
  assert.equal(env.MY_PROVIDER_API_KEY, 'sk-real-key');
  assert.ok(!('OTHER_SECRET' in env));
});

test('buildChildEnv: an env var with value undefined is never included, filtered or inherit-by-name', () => {
  const sourceEnv = { PATH: '/usr/bin' };
  Object.defineProperty(sourceEnv, 'WEIRD', { value: undefined, enumerable: true });
  const env = buildChildEnv({ envMode: 'filtered', platform: 'linux', sourceEnv });
  assert.ok(!('WEIRD' in env));
});

test('buildChildEnv: envMode "filtered" on win32 matches allowlisted names case-insensitively (cmd.exe/PowerShell expose "Path", not "PATH")', () => {
  const env = buildChildEnv({
    envMode: 'filtered',
    platform: 'win32',
    sourceEnv: { Path: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows' },
  });
  assert.equal(env.Path, 'C:\\Windows\\system32', 'a differently-cased allowlisted name must still pass through on win32');
});

test('parseArgs: --env-mode defaults to "filtered", the safe-by-default choice', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  assert.equal(parseArgs(common).envMode, 'filtered');
});

test('parseArgs: --env-mode accepts "inherit" and rejects anything else', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  assert.equal(parseArgs([...common, '--env-mode', 'inherit']).envMode, 'inherit');
  assert.throws(() => parseArgs([...common, '--env-mode', 'yolo']), /must be "filtered" or "inherit"/);
});

test('parseArgs: --env-passthrough splits a comma-separated list and rejects an invalid variable name', () => {
  const common = ['--brief', 'b.txt', '--cd', '.'];
  const config = parseArgs([...common, '--env-passthrough', 'FOO_KEY, BAR_TOKEN']);
  assert.deepEqual(config.envPassthrough, ['FOO_KEY', 'BAR_TOKEN']);
  assert.throws(() => parseArgs([...common, '--env-passthrough', '123BAD']), /not a valid environment variable name/);
  assert.throws(() => parseArgs([...common, '--env-passthrough', 'has-a-dash']), /not a valid environment variable name/);
});

test('buildUsageField: maps a real turn.completed.usage event to the nested usage shape with source "provider"', () => {
  // Exact shape captured from a live "codex exec --json --sandbox read-only" run.
  const rawUsage = {
    input_tokens: 26076,
    cached_input_tokens: 8960,
    cache_write_input_tokens: 0,
    output_tokens: 6,
    reasoning_output_tokens: 0,
  };
  assert.deepEqual(buildUsageField(rawUsage), {
    input_tokens: 26076,
    cached_input_tokens: 8960,
    cache_write_input_tokens: 0,
    output_tokens: 6,
    reasoning_tokens: 0,
    estimated_cost_usd: null,
    source: 'provider',
    raw: rawUsage,
  });
});

test('buildUsageField: no turn.completed event observed yields {source: "unavailable"}, never a fabricated value', () => {
  assert.deepEqual(buildUsageField(null), { source: 'unavailable' });
});

test('buildUsageField: never assumes a relationship between cached_input_tokens and input_tokens -- both are passed through verbatim, no derived/combined total', () => {
  const rawUsage = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 };
  const field = buildUsageField(rawUsage);
  assert.equal(field.input_tokens, 100, 'input_tokens must be the raw provider value, not reduced by cached_input_tokens');
  assert.equal(field.cached_input_tokens, 40, 'cached_input_tokens must be the raw provider value, not added to input_tokens');
  assert.ok(!('derived_total_input_tokens_estimate' in field), 'this dispatcher computes no derived total -- that is a separate, explicitly-labeled downstream concern');
});

test('estimated_cost_usd is always null from buildUsageField: no price table is embedded in this dispatcher', () => {
  assert.equal(buildUsageField({ input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }).estimated_cost_usd, null);
  assert.equal(buildUsageField(null).estimated_cost_usd, undefined, '{source: "unavailable"} carries no numeric fields at all, not even a null cost');
});

test('buildUsageDelta: a fresh thread reports its own usage, a resume with --previous-result reports only this call, and a resume without it says why it cannot', () => {
  const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_tokens: 10, source: 'provider' });
  const fresh = buildUsageDelta(usage(1821943, 1700000, 9000), { session: null, threadId: 't1', previous: null });
  assert.equal(fresh.source, 'fresh-thread');
  assert.equal(fresh.input_tokens, 1821943);
  const resumed = buildUsageDelta(usage(3196564, 3000000, 15000), {
    session: 't1', threadId: 't1', previous: { threadId: 't1', usage: usage(1821943, 1700000, 9000) },
  });
  assert.equal(resumed.source, 'delta-from-previous-result');
  assert.equal(resumed.input_tokens, 1374621);
  assert.equal(resumed.output_tokens, 6000);
  assert.equal(resumed.reasoning_tokens, 0);
  assert.equal(buildUsageDelta(usage(1, 1, 1), { session: 't1', threadId: 't1', previous: null }).source, 'unavailable');
  assert.equal(buildUsageDelta(usage(1, 1, 1), {
    session: 't1', threadId: 't1', previous: { threadId: 'other', usage: usage(0, 0, 0) },
  }).source, 'unavailable', 'a result from a different thread is never subtracted');
});

test('retryDeadline: reads a 12-hour clock time as today, or tomorrow when it is over 12 hours behind; any other wording is null', () => {
  const now = new Date(2026, 8, 28, 13, 30);
  assert.deepEqual(retryDeadline('3:06 PM', now), new Date(2026, 8, 28, 15, 6));
  assert.deepEqual(retryDeadline('1:25 pm', now), new Date(2026, 8, 28, 13, 25), 'a time just passed stays today');
  assert.deepEqual(retryDeadline('12:00 AM', now), new Date(2026, 8, 29, 0, 0), 'midnight, 13.5 hours behind, is tomorrow');
  assert.deepEqual(retryDeadline('12:15 PM', now), new Date(2026, 8, 28, 12, 15));
  assert.deepEqual(retryDeadline('1:00 AM', new Date(2026, 8, 28, 23, 0)), new Date(2026, 8, 29, 1, 0));
  assert.deepEqual(retryDeadline('10:51 A.M.', now), new Date(2026, 8, 28, 10, 51));
  for (const text of [null, '', '15:06', '13:06 PM', '3:66 PM', '0:30 AM', 'Sep 29th, 2026 3:06 PM', 'in 5 days']) {
    assert.equal(retryDeadline(text, now), null, JSON.stringify(text));
  }
});

test('flake fix: retryDeadline reads the clock time from when the record was written, so a deadline read after midnight or a day later lands on the right day', () => {
  const written = new Date(2026, 8, 28, 23, 50).toISOString();
  assert.deepEqual(retryDeadline('11:59 PM', new Date(2026, 8, 29, 0, 1), { after: written }), new Date(2026, 8, 28, 23, 59), 'read two minutes after midnight: passed, not tomorrow night');
  assert.deepEqual(retryDeadline('4:00 AM', new Date(2026, 8, 29, 16, 30), { after: written }), new Date(2026, 8, 29, 4, 0), 'read the next afternoon: passed, not tomorrow');
  assert.deepEqual(retryDeadline('12:05 AM', new Date(2026, 8, 28, 23, 55), { after: written }), new Date(2026, 8, 29, 0, 5), 'a time after midnight is still ahead');
  assert.deepEqual(retryDeadline('11:50 PM', new Date(2026, 8, 29, 0, 1), { after: new Date(2026, 8, 28, 23, 50, 40).toISOString() }), new Date(2026, 8, 28, 23, 50), 'the same minute as the record is not pushed a day');
  assert.deepEqual(retryDeadline('3:06 PM', new Date(2026, 8, 28, 13, 30), { after: 'not a date' }), new Date(2026, 8, 28, 15, 6), 'an unreadable record time falls back to now');
  const nearMidnight = new Date(2026, 9, 29, 0, 1).toISOString();
  assert.deepEqual(retryDeadline('11:47 PM', new Date(2026, 9, 29, 0, 5), { after: nearMidnight }), new Date(2026, 9, 28, 23, 47), 'written just after midnight: the limit that ended just before it, not tonight');
  assert.deepEqual(retryDeadline('11:47 PM', new Date(2026, 9, 29, 20, 0), { after: nearMidnight }), new Date(2026, 9, 28, 23, 47), 'the same record read the next evening');
  assert.deepEqual(retryDeadline('11:47 PM', new Date(2026, 9, 29, 0, 5), { after: new Date(2026, 9, 28, 23, 58).toISOString() }), new Date(2026, 9, 28, 23, 47), 'written just before midnight');
  assert.deepEqual(retryDeadline('12:00 AM', new Date(2026, 8, 29, 12, 0, 3), { after: new Date(2026, 8, 29, 11, 59, 59).toISOString() }), new Date(2026, 8, 30, 0, 0), 'a reset 12 hours ahead of the write is still ahead');
  assert.deepEqual(retryDeadline('12:05 AM', new Date(2026, 8, 29, 12, 10), { after: new Date(2026, 8, 29, 11, 50).toISOString() }), new Date(2026, 8, 30, 0, 5), 'an older record read from its start time: still ahead');
});

test('flake fix: retryDeadline on the autumn DST night does not move a reset in the repeated hour a day later', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    // 2026-11-01 01:00-01:59 happens twice there; 07:10Z is 01:10 CST, the second pass.
    const after = '2026-11-01T07:10:00.000Z';
    assert.equal(retryDeadline('1:00 AM', new Date('2026-11-01T07:15:00.000Z'), { after }).toISOString(), '2026-11-01T07:00:00.000Z');
    // 01:30 is ambiguous here; the first pass (40 minutes before the write) wins, so the worst case is an early retry.
    assert.equal(retryDeadline('1:30 AM', new Date('2026-11-01T07:15:00.000Z'), { after }).toISOString(), '2026-11-01T06:30:00.000Z');
    // The spring change skips 02:00-02:59: a time in that gap is reached when the clock jumps to 03:00 CDT.
    assert.equal(retryDeadline('2:30 AM', new Date('2026-03-08T07:00:00.000Z'), { after: '2026-03-08T07:00:00.000Z' }).toISOString(), '2026-03-08T08:00:00.000Z');
    // The hour before the write starts in the last minute before the jump: its first whole minute is already 03:00 CDT.
    for (const after of ['2026-03-08T08:59:00.001Z', '2026-03-08T08:59:30.000Z', '2026-03-08T09:00:00.000Z']) {
      assert.equal(retryDeadline('2:30 AM', new Date(after), { after }).toISOString(), '2026-03-08T08:00:00.000Z', after);
      assert.equal(retryDeadline('2:30 AM', new Date(Date.parse(after) + 11 * 3600000)).toISOString(), '2026-03-08T08:00:00.000Z', `${after} without a record time`);
    }
    process.env.TZ = 'Europe/London';
    assert.equal(retryDeadline('1:30 AM', new Date('2026-03-29T01:59:30.000Z'), { after: '2026-03-29T01:59:30.000Z' }).toISOString(), '2026-03-29T01:00:00.000Z');
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});

test('flake fix: retryDeadline across both DST changes in four zones returns the printed local time, at most 25 hours after the write', () => {
  const zone = process.env.TZ;
  // Each zone's spring and autumn change in 2026, as UTC instants.
  const changes = {
    'America/Chicago': ['2026-03-08T08:00:00Z', '2026-11-01T07:00:00Z'],
    'Europe/London': ['2026-03-29T01:00:00Z', '2026-10-25T01:00:00Z'],
    'America/Santiago': ['2026-09-06T04:00:00Z', '2026-04-05T03:00:00Z'],
    'Australia/Lord_Howe': ['2026-10-03T15:30:00Z', '2026-04-04T15:00:00Z'],
  };
  try {
    for (const [tz, instants] of Object.entries(changes)) {
      process.env.TZ = tz;
      for (const change of instants) {
        // The local clock of every minute from 6 hours before the change to 34 hours after it, read once.
        const start = Date.parse(change) - 6 * 3600000;
        const clocks = Array.from({ length: 40 * 60 }, (_, i) => { const d = new Date(start + i * 60000); return d.getHours() * 60 + d.getMinutes(); });
        const writes = [];
        for (let w = -4 * 60; w <= 4 * 60; w += 20) writes.push(Date.parse(change) + w * 60000);
        // Written under a minute before change + 1 hour: the hour before the write starts just before the change.
        writes.push(Date.parse(change) + 3600000 - 30000, Date.parse(change) + 3600000 - 1);
        for (const ms of writes) {
          const after = new Date(ms);
          const firstIndex = Math.ceil((ms - 3600000 - start) / 60000);
          for (let c = 0; c < 24 * 60; c += 15) {
            const h = Math.floor(c / 60), mm = c % 60;
            const text = `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
            const at = retryDeadline(text, after, { after: after.toISOString() });
            const where = `${tz} written ${after.toISOString()} "${text}"`;
            // Expected: the first minute from an hour before the write that shows the time, or that a forward jump
            // (the spring change, under 12 hours) from the minute before it skips the time over.
            let expected = null;
            for (let i = firstIndex; i < clocks.length && start + i * 60000 < ms - 3600000 + 27 * 3600000; i++) {
              const step = (clocks[i] - clocks[i - 1] + 1440) % 1440;
              const gap = (c - clocks[i - 1] + 1440) % 1440;
              if (clocks[i] === c || (step > 1 && step < 720 && gap > 0 && gap < step)) { expected = start + i * 60000; break; }
            }
            assert.ok(expected !== null && expected - ms <= 25 * 3600000, `${where}: no expected minute within 25 hours`);
            assert.equal(at?.getTime(), expected, `${where} -> ${at?.toISOString()}, expected ${new Date(expected).toISOString()}`);
          }
        }
      }
    }
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});

test('flake fix: retryDeadline on the 23-hour spring DST day does not move a passed limit to tonight', () => {
  const zone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    // 2026-03-08 is the spring change there: written at 00:01 CST (06:01 UTC), the day has 23 hours.
    const after = '2026-03-08T06:01:00.000Z';
    assert.equal(retryDeadline('11:47 PM', new Date('2026-03-08T06:05:00.000Z'), { after }).toISOString(), '2026-03-08T05:47:00.000Z', 'the limit that ended at 23:47 the evening before');
    assert.equal(retryDeadline('4:00 AM', new Date('2026-03-08T06:05:00.000Z'), { after }).toISOString(), '2026-03-08T09:00:00.000Z', 'a reset after the change is that morning, in daylight time');
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});

test('a read-only Codex run records a read-only guarantee for the manifest and any other sandbox records none', () => {
  assert.deepEqual(codexReadOnly({ sandbox: 'read-only' }), { fileTools: 'enforced', shell: 'enforced', cwd: 'target' });
  assert.equal(codexReadOnly({ sandbox: 'workspace-write' }), null);
});
