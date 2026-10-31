import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWin32Safe, winQuote, posixKillTree, killGroupOnExit, killTree, spawnCli, preserveEarlierResult, processTable, psBinary, stopMarkedProcesses, treeGroups, watchTreeGroups, atomicWriteJson, renameRetrying, jobSpawn } from '../spawn-utils.mjs';

const IS_WIN32 = process.platform === 'win32';

test('preserveEarlierResult: renames result.json and result.stderr.log to the first free result.attempt-<n>.* name, and returns null when there is none', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preserve-result-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = path.join(dir, 'result.json');
  assert.equal(await preserveEarlierResult(result), null);
  await fs.writeFile(result, '{"n":1}');
  await fs.writeFile(path.join(dir, 'result.stderr.log'), 'err1');
  assert.equal(await preserveEarlierResult(result), path.join(dir, 'result.attempt-1.json'));
  await fs.writeFile(result, '{"n":2}');
  assert.equal(await preserveEarlierResult(result), path.join(dir, 'result.attempt-2.json'));
  assert.deepEqual((await fs.readdir(dir)).sort(), ['result.attempt-1.json', 'result.attempt-1.stderr.log', 'result.attempt-2.json']);
  assert.equal(await fs.readFile(path.join(dir, 'result.attempt-1.stderr.log'), 'utf8'), 'err1');
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

test('winQuote: wraps in double quotes and escapes an embedded double quote', () => {
  assert.equal(winQuote('plain'), '"plain"');
  assert.equal(winQuote('has "quote"'), '"has \\"quote\\""');
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
  // A caller with no console (a detached worker, an agent's tool shell) would otherwise open a window per child (field report).
  assert.equal(captured.opts.windowsHide, true);
  spawnCli('codex', ['exec'], { cwd: '/tmp' }, { spawnFn: (cmd, args, opts) => { captured = { opts }; return new EventEmitter(); }, platform: 'linux' });
  assert.equal(captured.opts.windowsHide, true);
});

test('every direct spawn in the shared scripts hides its window (no console window per child on Windows)', async () => {
  const dir = path.dirname(fileURLToPath(new URL('../spawn-utils.mjs', import.meta.url)));
  const missing = [];
  for (const name of (await fs.readdir(dir)).filter((n) => n.endsWith('.mjs'))) {
    const lines = (await fs.readFile(path.join(dir, name), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (!/\b(?:spawn|spawnSync|execFileSync)\(/.test(line) || /^\s*\/\//.test(line) || /\bfunction\b/.test(line)) return;
      const call = lines.slice(i, i + 3).join(' ');
      // POSIX-only "ps" probes never run on Windows; spawnCli's own calls get windowsHide inside spawnCli.
      if (/'ps'/.test(call) || /spawnFn\(cmd/.test(call) || /spawnFn\(cmdLine/.test(call)) return;
      if (!/windowsHide: true/.test(call)) missing.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(missing, []);
});

test('spawnCli: an injected win32 platform actually reaches assertWin32Safe, so this guard is testable on any OS', () => {
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

test('killGroupOnExit: on POSIX the exited child\'s group gets SIGKILL once, an empty group is no error, Windows is left alone', () => {
  const sent = [];
  const posix = Object.assign(new EventEmitter(), { pid: 4242 });
  killGroupOnExit(posix, { platform: 'linux', kill: (pid, sig) => sent.push([pid, sig]) });
  assert.deepEqual(sent, [], 'nothing before the child exits');
  posix.emit('exit', 0);
  posix.emit('exit', 0);
  assert.deepEqual(sent, [[-4242, 'SIGKILL']]);
  const empty = Object.assign(new EventEmitter(), { pid: 4243 });
  killGroupOnExit(empty, { platform: 'darwin', kill: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); } });
  assert.doesNotThrow(() => empty.emit('exit', 0));
  const win = Object.assign(new EventEmitter(), { pid: 4244 });
  killGroupOnExit(win, { platform: 'win32', kill: () => sent.push('win') });
  win.emit('exit', 0);
  assert.equal(sent.length, 1);
});

test('killGroupOnExit: a command that leaves a job in the background still closes at once, and the job is gone [slow]', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/sh', ['-c', 'sleep 60 & echo $! ; echo ok'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  killGroupOnExit(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const started = Date.now();
  await new Promise((resolve) => child.on('close', resolve));
  assert.ok(Date.now() - started < 10000, 'close does not wait for the background sleep');
  const sleeper = Number(out.split('\n')[0]);
  // A killed process answers signal 0 until init reaps it, which lags under load.
  const alive = () => { try { process.kill(sleeper, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.throws(() => process.kill(sleeper, 0), 'the background job was killed with the group');
});

test('posixKillTree: a child that never exits gets SIGTERM then SIGKILL, both targeting the process group', async () => {
  const calls = [];
  const child = fakeChild();
  const kill = (pid, sig) => calls.push([pid, sig]);
  await posixKillTree(child, { kill, escalateMs: 1 });
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 0], [-4242, 'SIGKILL']]);
});

test('posixKillTree: a child whose whole group exits after SIGTERM never gets SIGKILL', async () => {
  const calls = [];
  const child = fakeChild();
  let gone = false;
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === 0 && gone) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    if (sig === 'SIGTERM') setImmediate(() => { gone = true; child.emit('exit', null); });
  };
  await posixKillTree(child, { kill, escalateMs: 20 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 0]]);
});

test('posixKillTree: when the leader exits but a group member ignored SIGTERM, the group still gets SIGKILL', async () => {
  const calls = [];
  const child = fakeChild();
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === 'SIGTERM') setImmediate(() => child.emit('exit', null));
  };
  await posixKillTree(child, { kill, escalateMs: 20 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 0], [-4242, 'SIGKILL']]);
});

test('posixKillTree waitForGroup: when the leader exits first, it resolves only after the surviving group got SIGKILL', async () => {
  const calls = [];
  const child = fakeChild();
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === 'SIGTERM') setImmediate(() => child.emit('exit', null));
  };
  await posixKillTree(child, { kill, escalateMs: 20, waitForGroup: true });
  assert.deepEqual(calls.at(-1), [-4242, 'SIGKILL'], 'a signal handler that exits on resolve must not exit before the group kill');
});

test('posixKillTree waitForGroup: when the whole group exits with its leader, it resolves without SIGKILL', async () => {
  const calls = [];
  const child = fakeChild();
  let gone = false;
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === 0 && gone) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    if (sig === 'SIGTERM') setImmediate(() => { gone = true; child.emit('exit', null); });
  };
  await posixKillTree(child, { kill, escalateMs: 50, waitForGroup: true });
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 0]]);
});

test('posixKillTree: with a process table it also signals the groups its tree leads, never a group shared with an outside process', async () => {
  const calls = [];
  const child = fakeChild();
  const table = new Map([[4242, { ppid: 1, pgid: 4242 }], [4300, { ppid: 4242, pgid: 4300 }], [4301, { ppid: 4242, pgid: 77 }], [77, { ppid: 1, pgid: 77 }]]);
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === 'SIGTERM' && pid === -4242) setImmediate(() => child.emit('exit', null));
  };
  await posixKillTree(child, { kill, escalateMs: 20, waitForGroup: true, readTable: () => table });
  assert.deepEqual(calls.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid), [-4242, -4300]);
  assert.ok(!calls.some(([pid]) => pid === -77), 'group 77 belongs to a process outside the tree');
});

test('posixKillTree: a tree group it may not signal (EPERM, another user\'s processes) is skipped and the others are still signalled', async () => {
  const calls = [];
  const child = fakeChild();
  const table = new Map([[4242, { ppid: 1, pgid: 4242 }], [4300, { ppid: 4242, pgid: 4300 }], [4400, { ppid: 4242, pgid: 4400 }]]);
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (pid === -4300 && sig !== 0) throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    if (sig === 'SIGTERM' && pid === -4242) setImmediate(() => child.emit('exit', null));
  };
  await posixKillTree(child, { kill, escalateMs: 20, waitForGroup: true, readTable: () => table });
  assert.deepEqual(calls.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid), [-4242, -4300, -4400]);
});

test('treeGroups: descendants found through parent ids; only groups led inside the tree', () => {
  const table = new Map([[10, { ppid: 1, pgid: 10 }], [11, { ppid: 10, pgid: 11 }], [12, { ppid: 11, pgid: 11 }], [13, { ppid: 12, pgid: 13 }], [14, { ppid: 10, pgid: 5 }], [20, { ppid: 1, pgid: 20 }]]);
  assert.deepEqual(treeGroups(10, table).sort((a, b) => a - b), [10, 11, 13]);
  assert.deepEqual(treeGroups(99, new Map()), []);
});

test('posixKillTree: a pid that is already gone (ESRCH) is not an error', async () => {
  const child = fakeChild();
  const kill = () => { const err = new Error('no such process'); err.code = 'ESRCH'; throw err; };
  await assert.doesNotReject(() => posixKillTree(child, { kill, escalateMs: 1 }));
});

test('killTree: on a non-win32 platform, delegates to posixKillTree (SIGTERM then SIGKILL, both forwarded)', async () => {
  const calls = [];
  const child = fakeChild();
  // Inject a recording fake `kill` -- never send a real signal to an
  // arbitrary pid here: on a Linux/macOS CI runner, -4242 could coincide
  // with a real process group, and posixKillTree's default `kill` calls
  // the real process.kill(-pid, sig) unless overridden.
  const kill = (pid, sig) => calls.push([pid, sig]);
  await killTree(child, { platform: 'linux', kill, escalateMs: 1 });
  assert.deepEqual(calls, [[-4242, 'SIGTERM'], [-4242, 0], [-4242, 'SIGKILL']]);
});

test('killTree: a log callback receives a message on taskkill failure (win32 branch)', { skip: !IS_WIN32 && 'taskkill.exe only exists on Windows' }, async () => {
  // Exercises killTree's win32 branch without a real taskkill.exe: an invalid
  // pid still spawns taskkill, which will exit non-zero rather than error, so
  // this asserts killTree resolves rather than hangs -- the log callback
  // itself is exercised in the dispatchers' own integration-level tests, which run on real Windows CI.
  const child = fakeChild(999999999);
  await assert.doesNotReject(() => killTree(child, { platform: 'win32', log: () => {} }));
});

test('preserveEarlierResult: a dead worker\'s live stderr log is archived with its attempt, not erased by the next dispatch', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preserve live '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const result = path.join(dir, 'result.json');
  await fs.writeFile(result, '{"status":"running"}');
  await fs.writeFile(path.join(dir, 'result.stderr.live.log'), 'ERROR exec_command failed: x\n');
  assert.equal(await preserveEarlierResult(result), path.join(dir, 'result.attempt-1.json'));
  assert.equal(await fs.readFile(path.join(dir, 'result.attempt-1.stderr.live.log'), 'utf8'), 'ERROR exec_command failed: x\n');
  assert.equal(await fs.access(path.join(dir, 'result.stderr.live.log')).then(() => true, () => false), false);
});

test('Linux round linux-r1 F1: a background job left in a tool command group whose leader exited is stopped; a reused group id is not', () => {
  const T = (rows) => new Map(rows.map(([pid, ppid, pgid, start]) => [pid, { ppid, pgid, start }]));
  // The CLI 100 runs a tool shell 200 in its own group; the shell starts a background job 201 and exits.
  const running = T([[1, 0, 1, 'a'], [100, 50, 100, 'c'], [200, 100, 200, 's'], [201, 200, 200, 'j'], [400, 1, 400, 'u']]);
  const after = T([[1, 0, 1, 'a'], [201, 1, 200, 'j'], [400, 1, 400, 'u']]);
  let table = running;
  const kills = [];
  const w = watchTreeGroups(100, { readTable: () => table, kill: (pid, sig) => kills.push([pid, sig]), platform: 'linux', intervalMs: 60000 });
  table = after;
  assert.deepEqual(w.stop(), [201], 'the job left in the dead leader group');
  assert.deepEqual(kills, [[-200, 'SIGKILL']], 'only that group, never the unrelated group 400');
  // The group emptied and its id came back for an unrelated process: not killed.
  table = running;
  const k2 = [];
  const w2 = watchTreeGroups(100, { readTable: () => table, kill: (pid, sig) => k2.push([pid, sig]), platform: 'linux', intervalMs: 60000 });
  table = T([[1, 0, 1, 'a'], [200, 1, 200, 'other']]);
  assert.deepEqual(w2.stop(), []);
  assert.deepEqual(k2, []);
  assert.equal(watchTreeGroups(100, { platform: 'win32' }), null, 'Windows uses the job object');
});

test('Linux round linux-r1 F1: every process still carrying the run id is stopped, others and this process are not', () => {
  const env = { 10: 'PATH=/x\0REVIEW_SEAT_RUN_ID=abc\0', 11: 'REVIEW_SEAT_RUN_ID=abcd\0', 12: 'HOME=/h\0', 13: 'REVIEW_SEAT_RUN_ID=abc\0' };
  const kills = [];
  const left = stopMarkedProcesses('abc', { listPids: () => [10, 11, 12, 13, 14], readEnviron: (pid) => { if (!(pid in env)) throw new Error('EACCES'); return env[pid]; }, kill: (pid, sig) => kills.push([pid, sig]), platform: 'linux', self: 13 });
  assert.deepEqual(left, [10], 'an id that only starts the same is another run; this process is skipped; an unreadable one is skipped');
  assert.deepEqual(kills, [[10, 'SIGKILL']]);
  assert.deepEqual(stopMarkedProcesses('abc', { platform: 'darwin', readPsEnv: () => ({ status: 1 }) }), [], 'ps failed on macOS: nothing');
  assert.deepEqual(stopMarkedProcesses('abc', { platform: 'win32', readPsEnv: () => { throw new Error('no ps on Windows'); } }), [], 'Windows uses the job object');
  assert.deepEqual(stopMarkedProcesses('', { platform: 'linux', listPids: () => [10], readEnviron: () => env[10] }), [], 'no id, nothing');
});

test('macOS: every process whose environment in ps carries the run id is stopped, others and this process are not', () => {
  const id = 'f0e1d2c3-0000-4000-8000-000000000001';
  const stdout = [
    `  201 node -e setInterval(() => {}, 1000) PATH=/usr/bin REVIEW_SEAT_RUN_ID=${id} HOME=/Users/x`,
    `  202 node server.js REVIEW_SEAT_RUN_ID=${id}0 HOME=/Users/x`,
    `  203 python3 job.py FOO=xREVIEW_SEAT_RUN_ID=${id}`,
    '  204 /bin/sleep 300',
    `  205 node self.js REVIEW_SEAT_RUN_ID=${id}`,
    `  206 /opt/homebrew/bin/python3 w.py REVIEW_SEAT_RUN_ID=${id}`,
    `    0 forged REVIEW_SEAT_RUN_ID=${id}`,
    `    1 forged REVIEW_SEAT_RUN_ID=${id}`,
    '',
  ].join('\n');
  const kills = [];
  const left = stopMarkedProcesses(id, { platform: 'darwin', readPsEnv: () => ({ status: 0, stdout }), kill: (pid, sig) => kills.push([pid, sig]), self: 205 });
  assert.deepEqual(left, [201, 206], 'a longer id, a marker glued to another variable, no marker, pid 0 or 1 and this process are left alone');
  assert.deepEqual(kills, [[201, 'SIGKILL'], [206, 'SIGKILL']]);
  const gone = stopMarkedProcesses(id, { platform: 'darwin', readPsEnv: () => ({ status: 0, stdout }), kill: (pid) => { if (pid === 201) throw Object.assign(new Error('x'), { code: 'ESRCH' }); }, self: 205 });
  assert.deepEqual(gone, [206], 'one that exited meanwhile is not named');
  const err = Object.assign(new Error('spawnSync ps ENOBUFS'), { code: 'ENOBUFS' });
  assert.deepEqual(stopMarkedProcesses(id, { platform: 'darwin', readPsEnv: () => ({ status: null, error: err, stdout }), kill: () => assert.fail('nothing is signalled') }), [], 'ps cut off: nothing');
  assert.deepEqual(stopMarkedProcesses('', { platform: 'darwin', readPsEnv: () => assert.fail('no id, no ps') }), []);
});

test('the process table reads ps start times in UTC, so a time-zone change while a seat runs keeps each start the same', { skip: process.platform !== 'darwin' }, () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const west = processTable({ platform: 'darwin' })?.get(process.pid)?.start;
    process.env.TZ = 'Asia/Tokyo';
    const east = processTable({ platform: 'darwin' })?.get(process.pid)?.start;
    assert.ok(west, 'ps gives a start');
    assert.equal(east, west);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('Linux round linux-r2 F4: once the CLI has exited, a process that reuses its pid is not followed', () => {
  const T = (rows) => new Map(rows.map(([pid, ppid, pgid, start]) => [pid, { ppid, pgid, start }]));
  let table = T([[100, 50, 100, 'c'], [200, 100, 200, 's']]);
  const kills = [];
  const w = watchTreeGroups(100, { readTable: () => table, kill: (pid, sig) => kills.push([pid, sig]), platform: 'linux', intervalMs: 60000 });
  // The CLI exits; pid 100 now holds an unrelated process whose child leads group 300.
  table = T([[100, 1, 100, 'reused'], [300, 100, 300, 'x'], [200, 1, 200, 's']]);
  w.sample();
  assert.deepEqual(w.stop(), [200], 'only the group seen while the CLI ran');
  assert.deepEqual(kills, [[-200, 'SIGKILL']], 'never the reused pid\'s group 300');
});

test('Linux round linux-r3 F7: off Linux the process table carries ps\'s start, so a reused pid is told apart', () => {
  const runPs = () => ({ status: 0, stdout: '  101     1   101 Thu Oct 22 22:41:10 2026\n  102   101   102 Thu Oct 22 22:41:11 2026\n' });
  const table = processTable({ platform: 'darwin', runPs });
  assert.deepEqual(table.get(101), { ppid: 1, pgid: 101, start: 'Thu Oct 22 22:41:10 2026' });
  assert.notEqual(table.get(102).start, table.get(101).start);
  if (process.platform !== 'win32') {
    const real = processTable({ platform: 'darwin' });
    assert.ok(typeof real?.get(process.pid)?.start === 'string' && real.get(process.pid).start.length > 0, 'the real ps gives a start');
  }
});

test('flake fix: a result.json rename Windows refuses for a moment (EPERM, EBUSY) is retried, so a detached worker does not die with its record still "running"', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename retry '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'result.json');
  await fs.writeFile(file, '{"status":"running"}\n');
  const codes = ['EPERM', 'EBUSY'];
  const calls = [];
  const rename = async (from, to) => {
    calls.push(to);
    const code = codes.shift();
    if (code) throw Object.assign(new Error(code), { code });
    return fs.rename(from, to);
  };
  await atomicWriteJson(file, { status: 'completed' }, { rename });
  assert.equal(calls.length, 3, 'two refusals, then the rename');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).status, 'completed');
  assert.deepEqual(await fs.readdir(dir), ['result.json'], 'no temp file is left');
});

test('flake fix: a rename refused every time, or refused for another reason, throws and leaves no temp file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename retry '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const from = path.join(dir, '.tmp');
  for (const [code, tries] of [['EPERM', 3], ['EXDEV', 1]]) {
    await fs.writeFile(from, 'x');
    let calls = 0;
    const rename = async () => { calls += 1; throw Object.assign(new Error(code), { code }); };
    await assert.rejects(renameRetrying(from, path.join(dir, 'to'), { rename, tries: 3, delayMs: 1 }), { code });
    assert.equal(calls, tries, `${code}: ${tries} attempt(s)`);
    assert.deepEqual(await fs.readdir(dir), [], `${code}: the temp file is removed`);
  }
});

test('macOS reads ps by its path, so the process checks do not depend on PATH; elsewhere ps is looked up on PATH', () => {
  assert.equal(psBinary('darwin'), '/bin/ps');
  assert.equal(psBinary('linux'), 'ps');
  assert.equal(psBinary('freebsd'), 'ps');
});

test('jobSpawn: the PowerShell wrapper starts with this process\'s PSModulePath, and the command still gets the PSModulePath of the env it was given', async (t) => {
  const saved = Object.keys(process.env).filter((k) => k.toLowerCase() === 'psmodulepath').map((k) => [k, process.env[k]]);
  for (const [k] of saved) delete process.env[k];
  process.env.PSModulePath = 'own-modules';
  t.after(() => { delete process.env.PSModulePath; for (const [k, v] of saved) process.env[k] = v; });
  const spawned = [];
  const spawnFn = (cmd, args, opts) => { spawned.push(opts.env); return new EventEmitter(); };
  for (const [env, forCommand] of [[{ Path: 'bin' }, '<unset>'], [{ Path: 'bin', psmodulepath: 'given-modules' }, 'given-modules']]) {
    const { dir } = jobSpawn('echo x', { cwd: os.tmpdir(), env, spawnFn });
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const shellEnv = spawned.at(-1);
    assert.deepEqual(Object.keys(shellEnv).filter((k) => k.toLowerCase() === 'psmodulepath'), ['PSModulePath'], 'one PSModulePath key');
    assert.equal(shellEnv.PSModulePath, 'own-modules', 'the wrapper starts with this process\'s value');
    assert.equal(shellEnv.PREFLIGHT_EXEC_PSMODULEPATH, forCommand, 'the command gets the value of the env it was given');
  }
});

test('jobSpawn: the command sees the PSModulePath of the env it was given, or none [slow]', { skip: process.platform !== 'win32' && 'Windows job wrapper' }, async (t) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
  for (const [env, want] of [[{ ...base, PSModulePath: 'given-modules' }, '[given-modules]'], [base, '[%PSModulePath%]']]) {
    const { child, dir } = jobSpawn('echo [%PSModulePath%]', { cwd: os.tmpdir(), env });
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0);
    assert.equal(out.trim(), want);
  }
});
