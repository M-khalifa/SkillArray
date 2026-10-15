import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retryDeadline, DEFAULT_MAX_WAIT_S, processStartMs, processStartToken, startTokenFromProcStat, workerIsLive, START_TOLERANCE_MS, stopRecordedChild, stateFromProcStat, processExists } from '../detach-utils.mjs';

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'detach utils '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'worker.mjs');
  const moduleUrl = new URL('../detach-utils.mjs', import.meta.url).href;
  const envUrl = new URL('../env-filter.mjs', import.meta.url).href;
  const child = path.join(dir, 'child.mjs');
  await fs.writeFile(child, [
    "const names = ['CODEX_HOME', 'CLAUDECODE', 'CODEX_THREAD_ID', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'CUSTOM_TOKEN'];",
    "process.stdout.write(JSON.stringify(Object.fromEntries(names.map(k => [k, process.env[k] ?? null]))));",
  ].join('\n'));
  await fs.writeFile(script, [
    'import { createDetachHandlers } from ' + JSON.stringify(moduleUrl) + ';',
    'import { buildChildEnv } from ' + JSON.stringify(envUrl) + ';',
    "import { promises as fs } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "import path from 'node:path';",
    'class RelayError extends Error {}',
    "const log = msg => process.stderr.write('relay: ' + msg + '\\n');",
    "const atomicWriteJson = (file, data) => fs.writeFile(file, JSON.stringify(data));",
    "Object.assign(process.env, {CLAUDECODE:'fixture', CODEX_THREAD_ID:'fixture', ANTHROPIC_API_KEY:'fixture', AWS_SECRET_ACCESS_KEY:'fixture', CUSTOM_TOKEN:'fixture'});",
    'async function dispatch(argv, {worker} = {}) {',
    "  const brief = argv[argv.indexOf('--brief') + 1];",
    "  const envMode = argv.includes('--env-inherit') ? 'inherit' : 'filtered';",
    "  const envPassthrough = argv.includes('--custom') ? ['CUSTOM_TOKEN'] : [];",
    "  const env = buildChildEnv({envMode, envPassthrough, providerAllowlist:['CODEX_HOME']});",
    '  const res = spawnSync(process.execPath, [' + JSON.stringify(child) + "], {env, encoding:'utf8'});",
    "  if (res.status !== 0) throw new Error(res.stderr);",
    "  await atomicWriteJson(path.join(path.dirname(brief), 'result.json'), {status:'completed', threadId:'fake-thread', finalMessage:res.stdout, ...worker});",
    "  log('done');",
    '}',
    "const runningRecord = (args, fields) => ({status:'running', ...fields, ...fields.worker});",
    'const handlers = createDetachHandlers({scriptPath:' + JSON.stringify(script) + ', dispatch, runningRecord, atomicWriteJson, RelayError, log});',
    'const argv = process.argv.slice(2);',
    'try {',
    "  if (argv[0] === '--job') await handlers.runJob(argv[1]);",
    "  else if (argv[0] === '--wait') await handlers.runWait(argv.slice(1));",
    "  else if (argv[0] === '--wait-retry') await handlers.runWaitRetry(argv.slice(1));",
    "  else await handlers.runDetach({brief:argv[argv.indexOf('--brief')+1], envMode:'filtered'}, argv);",
    "} catch (err) { log(err.message); process.exit(2); }",
  ].join('\n'));
  const run = (argv, env = process.env) => spawnSync(process.execPath, [script, ...argv], { env, encoding: 'utf8', timeout: 20000 });
  const result = path.join(dir, 'result.json');
  return { dir, script, result, run };
}

test('detached start, worker and wait complete with filtered child environment and a secret-free job [slow]', async (t) => {
  const h = await harness(t);
  const brief = path.join(h.dir, 'brief.txt');
  await fs.writeFile(brief, 'fake brief');
  const env = { ...process.env, CODEX_HOME: path.join(h.dir, 'login'), CUSTOM_TOKEN: 'fixture' };
  const start = h.run(['--detach', '--brief', brief], env);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /detached worker pid \d+ started/);
  assert.ok(start.stdout.includes('node "' + h.script + '" --wait'));
  const wait = h.run(['--wait', h.result, '--max-wait', '12']);
  assert.equal(wait.status, 0, wait.stderr);
  const job = JSON.parse(await fs.readFile(path.join(h.dir, 'dispatch-job.json'), 'utf8'));
  assert.deepEqual(job.argv, ['--brief', brief]);
  assert.equal(job.cwd, process.cwd());
  assert.deepEqual(Object.keys(job.env).map(k => k.toLowerCase()).sort(), ['codex_home', 'path']);
  const record = JSON.parse(await fs.readFile(h.result, 'utf8'));
  assert.equal(record.detached, true);
  assert.ok(record.workerPid > 0);
  assert.deepEqual(JSON.parse(record.finalMessage), {
    CODEX_HOME: env.CODEX_HOME, CLAUDECODE: null, CODEX_THREAD_ID: null,
    ANTHROPIC_API_KEY: null, AWS_SECRET_ACCESS_KEY: null, CUSTOM_TOKEN: null,
  });
  await fs.access(record.workerLog);
});

for (const [mode, extra, expected] of [
  ['filtered', [], null], ['passthrough', ['--custom'], 'fixture'], ['inherit', ['--env-inherit'], 'fixture'],
]) {
  test('detached worker applies env-filter for ' + mode + ' mode', async (t) => {
    const h = await harness(t);
    const job = path.join(h.dir, 'job.json');
    const login = path.join(h.dir, 'job login');
    await fs.writeFile(job, JSON.stringify({cwd:h.dir, env:{CODEX_HOME:login}, argv:['--brief', path.join(h.dir, 'brief.txt'), ...extra]}));
    const run = h.run(['--job', job], { ...process.env, CODEX_HOME: 'stale-login' });
    assert.equal(run.status, 0, run.stderr);
    const record = JSON.parse(await fs.readFile(h.result, 'utf8'));
    const child = JSON.parse(record.finalMessage);
    assert.equal(child.CODEX_HOME, login);
    assert.equal(child.CUSTOM_TOKEN, expected);
    for (const key of ['CLAUDECODE', 'CODEX_THREAD_ID', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY']) {
      assert.equal(child[key], mode === 'inherit' ? 'fixture' : null);
    }
  });
}

test('wait accepts a BOM result and returns success only for completed status', async (t) => {
  const h = await harness(t);
  for (const [status, code] of [['completed',0], ['error',1], ['timed-out',1], ['rate-limited',1]]) {
    await fs.writeFile(h.result, String.fromCharCode(0xfeff) + JSON.stringify({status, threadId:'fake-thread'}));
    const run = h.run(['--wait', h.result]);
    assert.equal(run.status, code, run.stderr);
    assert.match(run.stdout, /threadId fake-thread/);
    if (code) assert.equal(run.stderr, run.stdout);
  }
});

test('wait timeout bounds missing or partially written results [slow]', async (t) => {
  const h = await harness(t);
  const missing = h.run(['--wait', h.result, '--max-wait', '1']);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stdout, /does not exist: this seat was never dispatched there/);
  await fs.writeFile(h.result, '{"status":');
  const partial = h.run(['--wait', h.result, '--max-wait', '1']);
  assert.equal(partial.status, 3, partial.stderr);
  assert.match(partial.stdout, /still running; run --wait again/);
});

test('wait refuses a dead worker or a placeholder older than two minutes', async (t) => {
  const h = await harness(t);
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  for (const record of [
    {status:'running', workerPid:exited.pid, threadId:'fake-thread'},
    {status:'running', workerPid:exited.pid},
    {status:'running', startedAt:new Date(Date.now()-180000).toISOString()},
  ]) {
    await fs.writeFile(h.result, JSON.stringify(record));
    const run = h.run(['--wait', h.result]);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /worker.*gone|never started/);
  }
});

test('wait and wait-retry reject missing paths and unsupported options [slow]', async (t) => {
  const h = await harness(t);
  for (const flag of ['--wait', '--wait-retry']) {
    for (const tail of [[], [h.result,'--bad'], [h.result,'--max-wait','abc']]) {
      const run = h.run([flag, ...tail]);
      assert.equal(run.status, 2);
      assert.match(run.stderr, /requires the path|accepts only/);
    }
  }
});

test('wait-retry returns once the clock deadline passes and bounds a future deadline', async (t) => {
  const h = await harness(t);
  const clock = date => date.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit',hour12:true});
  await fs.writeFile(h.result, JSON.stringify({status:'rate-limited', retryAfter:clock(new Date(Date.now()-120000)), threadId:'fake-thread'}));
  const past = h.run(['--wait-retry', h.result]);
  assert.equal(past.status, 0, past.stderr);
  assert.match(past.stdout, /resume thread fake-thread/);
  await fs.writeFile(h.result, JSON.stringify({status:'rate-limited', retryAfter:clock(new Date(Date.now()+300000))}));
  const future = h.run(['--wait-retry', h.result, '--max-wait', '1']);
  assert.equal(future.status, 3, future.stderr);
  assert.match(future.stdout, /run --wait-retry again/);
});

test('wait-retry reports unreadable results, wrong status and unsupported retry wording', async (t) => {
  const h = await harness(t);
  assert.equal(h.run(['--wait-retry', h.result]).status, 2);
  for (const record of [{status:'completed'}, {status:'rate-limited', retryAfter:'in five days'}]) {
    await fs.writeFile(h.result, JSON.stringify(record));
    const run = h.run(['--wait-retry', h.result]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no limit to wait for|not a plain clock time/);
  }
});

test('retryDeadline preserves local clock rollover and the default wait bound', () => {
  const now = new Date(2026,8,28,23,0);
  assert.deepEqual(retryDeadline('1:00 AM',now), new Date(2026,8,29,1,0));
  assert.equal(retryDeadline('13:00 PM',now),null);
  assert.equal(DEFAULT_MAX_WAIT_S,540);
});

function liveChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => child.kill());
  return child;
}

test('R2-F17: processStartMs reads the real start time of a live process [slow]', () => {
  const start = processStartMs(process.pid);
  assert.ok(Number.isFinite(start));
  const expected = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(start - expected) < START_TOLERANCE_MS, `start ${start} vs expected ${expected}`);
  assert.equal(processStartMs(2 ** 22 + 12345), null, 'a pid that does not exist has no start time');
});

test('R2-F17: workerIsLive refuses a live pid whose start time differs from the recorded worker start (reused pid) [slow]', (t) => {
  const child = liveChild(t);
  assert.equal(workerIsLive(child.pid, new Date().toISOString()), true, 'the recorded start matches the process');
  assert.equal(workerIsLive(child.pid, new Date(Date.now() - 3600000).toISOString()), false, 'a process that started an hour after the worker is not the worker');
  assert.equal(workerIsLive(child.pid, undefined), true, 'a record with no start time keeps the plain pid check');
  assert.equal(workerIsLive(child.pid, 'not a date'), true);
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(workerIsLive(exited.pid, new Date().toISOString()), false, 'a dead pid is never live');
});

test('R2-F17: workerIsLive keeps a verified pid for a short time and treats an unreadable start time as unverified', () => {
  let reads = 0;
  const readStart = () => { reads += 1; return Date.now(); };
  const recorded = new Date().toISOString();
  assert.equal(workerIsLive(process.pid, recorded, { readStart }), true);
  assert.equal(workerIsLive(process.pid, recorded, { readStart }), true);
  assert.equal(reads, 1, 'the second check reuses the verification');
  assert.equal(workerIsLive(process.pid, new Date(Date.now() - 1000).toISOString(), { readStart: () => null }), true, 'an unreadable start time proves nothing, so the pid check stands');
});

test('R2-F17: wait refuses a live pid that is not the recorded worker (reused pid) and keeps a matching one running [slow]', async (t) => {
  const h = await harness(t);
  const child = liveChild(t);
  await fs.writeFile(h.result, JSON.stringify({ status: 'running', workerPid: child.pid, workerStartedAt: new Date(Date.now() - 3600000).toISOString(), startedAt: new Date(Date.now() - 3600000).toISOString() }));
  const run = h.run(['--wait', h.result, '--max-wait', '2']);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /worker.*gone/);
  await fs.writeFile(h.result, JSON.stringify({ status: 'running', workerPid: child.pid, workerStartedAt: new Date().toISOString(), startedAt: new Date().toISOString() }));
  const alive = h.run(['--wait', h.result, '--max-wait', '1']);
  assert.equal(alive.status, 3, 'a matching start time keeps the worker running');
});

test('R2-F17: the detached worker records its own start time with its pid [slow]', async (t) => {
  const h = await harness(t);
  const brief = path.join(h.dir, 'brief.txt');
  await fs.writeFile(brief, 'fake brief');
  const before = Date.now();
  assert.equal(h.run(['--detach', '--brief', brief]).status, 0);
  assert.equal(h.run(['--wait', h.result, '--max-wait', '12']).status, 0);
  const record = JSON.parse(await fs.readFile(h.result, 'utf8'));
  const started = Date.parse(record.workerStartedAt);
  assert.ok(started >= before - START_TOLERANCE_MS && started <= Date.now(), record.workerStartedAt);
  assert.equal(workerIsLive(record.workerPid, record.workerStartedAt), false, 'the finished worker is gone');
});

// A /proc/<pid>/stat line: field 2 (the command name) holds spaces and parentheses; field 22 is the start time in ticks.
const statLine = (ticks) => ['4242 (node (a b) c)', 'S', ...Array.from({ length: 18 }, (_, i) => String(i + 4)), String(ticks), '0 0 0'].join(' ');

test('final-F10: the start token is field 22 of /proc/<pid>/stat, found after the last closing parenthesis', () => {
  assert.equal(startTokenFromProcStat(statLine(987654)), 'ticks:987654');
  assert.equal(startTokenFromProcStat('4242 (node) S 1 2'), null, 'a short line has no field 22');
  assert.equal(startTokenFromProcStat('no parenthesis at all'), null);
  assert.equal(startTokenFromProcStat(undefined), null);
});

test('final-F10: processStartToken reads this process on Linux, and returns null on Windows and for a pid that does not exist', () => {
  assert.equal(processStartToken(2 ** 22 + 12345), null);
  assert.equal(processStartToken(0), null);
  if (process.platform === 'win32') assert.equal(processStartToken(process.pid), null, 'Windows keeps reading the stored StartTime');
  else assert.ok(processStartToken(process.pid), 'a live process has a start token');
  assert.equal(processStartToken(process.pid), processStartToken(process.pid), 'the token of one process does not change');
});

test('final-F10: a recorded start token decides liveness, so a wall-clock step cannot make a live worker look dead or a reused pid look live', () => {
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const readStart = () => Date.now();
  assert.equal(workerIsLive(process.pid, hourAgo, { readStart }), false, 'without a token the wall-clock comparison still applies');
  assert.equal(workerIsLive(process.pid, hourAgo, { readStart, recordedToken: 'ticks:7', readToken: () => 'ticks:7' }), true, 'same token: live, whatever the clock says');
  assert.equal(workerIsLive(process.pid, new Date().toISOString(), { readStart, recordedToken: 'ticks:7', readToken: () => 'ticks:8' }), false, 'another token: a reused pid');
  assert.equal(workerIsLive(process.pid, hourAgo, { readStart, recordedToken: 'ticks:7', readToken: () => null }), false, 'an unreadable token falls back to the wall-clock comparison');
  assert.equal(workerIsLive(process.pid, new Date().toISOString(), { readStart, recordedToken: 'ticks:7', readToken: () => null }), true);
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(workerIsLive(exited.pid, hourAgo, { recordedToken: 'ticks:7', readToken: () => 'ticks:7' }), false, 'a dead pid is never live');
});

test('final-F10: the detached worker records its start token beside its start time [slow]', async (t) => {
  const h = await harness(t);
  const brief = path.join(h.dir, 'brief.txt');
  await fs.writeFile(brief, 'fake brief');
  assert.equal(h.run(['--detach', '--brief', brief]).status, 0);
  assert.equal(h.run(['--wait', h.result, '--max-wait', '12']).status, 0);
  const record = JSON.parse(await fs.readFile(h.result, 'utf8'));
  assert.ok(Object.hasOwn(record, 'workerStartToken'), 'the key is always written');
  if (process.platform === 'win32') assert.equal(record.workerStartToken, null);
  else assert.match(record.workerStartToken, /^(ticks|lstart):/);
});

test('final-F10: wait trusts a matching start token over a wall-clock start time that is an hour off (Linux and macOS only)', { skip: process.platform === 'win32' }, async (t) => {
  const h = await harness(t);
  const child = liveChild(t);
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  await fs.writeFile(h.result, JSON.stringify({ status: 'running', workerPid: child.pid, workerStartedAt: hourAgo, workerStartToken: processStartToken(child.pid), startedAt: hourAgo }));
  assert.equal(h.run(['--wait', h.result, '--max-wait', '1']).status, 3, 'the worker is still running');
  await fs.writeFile(h.result, JSON.stringify({ status: 'running', workerPid: child.pid, workerStartedAt: new Date().toISOString(), workerStartToken: 'ticks:1', startedAt: new Date().toISOString() }));
  assert.equal(h.run(['--wait', h.result, '--max-wait', '2']).status, 1, 'a different token means another process holds the pid');
});

test('REVIEW_DETACH_MODE=plain starts the worker without WMI and the wait completes', async (t) => {
  const h = await harness(t);
  const brief = path.join(h.dir, 'brief.txt');
  await fs.writeFile(brief, 'fake brief');
  const env = { ...process.env, REVIEW_DETACH_MODE: 'plain', CODEX_HOME: path.join(h.dir, 'login') };
  const start = h.run(['--detach', '--brief', brief], env);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /detached worker pid \d+ started/);
  assert.doesNotMatch(start.stderr, /WMI/);
  const wait = h.run(['--wait', h.result, '--max-wait', '12']);
  assert.equal(wait.status, 0, wait.stderr);
  const record = JSON.parse(await fs.readFile(h.result, 'utf8'));
  assert.equal(record.status, 'completed');
  assert.ok(record.workerPid > 0, 'the worker recorded its own pid');
});

test('when WMI is refused the default mode starts a plain detached worker and says so; mode wmi does not fall back [slow]', { skip: process.platform !== 'win32' }, async (t) => {
  const h = await harness(t);
  const brief = path.join(h.dir, 'brief.txt');
  await fs.writeFile(brief, 'fake brief');
  const env = { ...process.env, REVIEW_DETACH_POWERSHELL: path.join(h.dir, 'no-such-powershell.exe'), CODEX_HOME: path.join(h.dir, 'login') };
  const start = h.run(['--detach', '--brief', brief], env);
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stderr, /could not start the detached worker through WMI.*started the worker as a plain detached process instead/);
  const wait = h.run(['--wait', h.result, '--max-wait', '12']);
  assert.equal(wait.status, 0, wait.stderr);
  const strict = h.run(['--detach', '--brief', brief, '--replace-completed'], { ...env, REVIEW_DETACH_MODE: 'wmi' });
  assert.notEqual(strict.status, 0, 'mode wmi never falls back');
  assert.match(strict.stderr, /through WMI/);
});

test('stopRecordedChild: kills the recorded process group while the pid is still that process; a wrong or missing token, a missing pid and null leave everything alone', { skip: process.platform === 'win32' }, async (t) => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const children = [];
  t.after(() => { for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } } });
  const start = () => {
    // detached: its own process group, as the dispatchers start their CLI; the shell makes a grandchild in that group
    const c = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); setInterval(()=>{},1000)"], { detached: true, stdio: 'ignore' });
    children.push(c);
    return c;
  };
  const wait = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 100)); };

  const reused = start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(stopRecordedChild({ childPid: reused.pid, childStartToken: 'lstart:some other process' }), false, 'a different start token is a reused pid');
  assert.equal(stopRecordedChild({ childPid: reused.pid }), false, 'no recorded token: not sure it is the same process, so not touched');
  assert.equal(stopRecordedChild({ childPid: 0, childStartToken: 'x' }), false);
  assert.equal(stopRecordedChild({ childPid: 1, childStartToken: 'x' }), false);
  assert.equal(stopRecordedChild(null), false);
  assert.equal(stopRecordedChild({}), false);
  assert.ok(alive(reused.pid), 'none of the refusals touched the process');

  const token = processStartToken(reused.pid);
  assert.ok(token, 'this platform can read a start token');
  assert.equal(stopRecordedChild({ childPid: reused.pid, childStartToken: token }), true);
  await wait(() => !alive(reused.pid));
  assert.ok(!alive(reused.pid));
  assert.equal(stopRecordedChild({ childPid: reused.pid, childStartToken: token }), false, 'already gone');
});

test('--wait of both dispatchers on a result.json that does not exist exits 1 naming it [slow]', { timeout: 30000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wait-missing-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const missing = path.join(dir, 'B', 'result.json');
  for (const script of ['claude-dispatch.mjs', 'codex-dispatch.mjs']) {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL(`../${script}`, import.meta.url)), '--wait', missing, '--max-wait', '1'], { encoding: 'utf8' });
    assert.equal(r.status, 1, `${script}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /does not exist: this seat was never dispatched there/);
  }
});

test('processExists on Linux: a zombie (state Z or X) does not count as existing; other states and a missing /proc entry do', () => {
  const zombie = '386629 (python3) Z 386628 386628 386628 0 -1 4228108 95 0 0 0 0 0 0 0 20 0 1 0 95090417 0 0';
  assert.equal(stateFromProcStat(zombie), 'Z');
  assert.equal(stateFromProcStat('12 (a (b) c) S 1 12 12'), 'S', 'a command name holding ")" is skipped');
  assert.equal(stateFromProcStat('garbage'), null);
  const live = () => {};
  assert.equal(processExists(386629, { kill: live, platform: 'linux', readStat: () => zombie }), false);
  assert.equal(processExists(386629, { kill: live, platform: 'linux', readStat: () => zombie.replace(' Z ', ' X ') }), false);
  assert.equal(processExists(42, { kill: live, platform: 'linux', readStat: () => '42 (sleep) S 1 42 42' }), true);
  assert.equal(processExists(42, { kill: live, platform: 'linux', readStat: () => { throw new Error('ENOENT'); } }), true, 'no /proc entry: the kill(0) answer stands');
  assert.equal(processExists(42, { kill: live, platform: 'darwin', readStat: () => zombie }), true, '/proc is read on Linux only');
  assert.equal(processExists(42, { kill: () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); }, platform: 'linux' }), false);
});

test('stopRecordedChild on POSIX: kills the recorded group and the groups its tree leads, never a shared group, and never a gone leader\'s group', () => {
  // 100 is the recorded seat CLI (group 100); 101 is a tool command in its own group (setsid); 102 joined the shell's
  // group 50, which the tree does not lead; 103 is a grandchild in group 101.
  const table = new Map([[100, { ppid: 1, pgid: 100 }], [101, { ppid: 100, pgid: 101 }], [102, { ppid: 100, pgid: 50 }], [103, { ppid: 101, pgid: 101 }], [50, { ppid: 1, pgid: 50 }]]);
  const sent = [];
  const kill = (pid, sig) => { sent.push([pid, sig]); };
  const base = { platform: 'linux', kill, readToken: () => 'ticks:1', readTable: () => table };
  assert.equal(stopRecordedChild({ childPid: 100, childStartToken: 'ticks:1' }, { ...base, exists: () => true }), true);
  assert.deepEqual(sent.splice(0).sort((a, b) => a[0] - b[0]), [[-101, 'SIGKILL'], [-100, 'SIGKILL']].sort((a, b) => a[0] - b[0]), 'group 50 is shared with a process outside the tree, so it is left alone');
  assert.equal(stopRecordedChild({ childPid: 100, childStartToken: 'ticks:1' }, { ...base, exists: () => true, readToken: () => 'ticks:2' }), false, 'a reused pid');
  assert.deepEqual(sent.splice(0), []);
  // A zombie holding the pid with another process's start token: nothing is signalled (Linux round 3, F2).
  const holder = { ...base, exists: () => false, readToken: () => 'ticks:95950779', readTable: () => { throw new Error('no table for another holder'); } };
  assert.equal(stopRecordedChild({ childPid: 100, childStartToken: 'ticks:1' }, holder), false);
  assert.deepEqual(sent.splice(0), [], 'an unrelated group is never signalled');
  // Our own child as a zombie: the token still matches, so its tree is stopped.
  assert.equal(stopRecordedChild({ childPid: 100, childStartToken: 'ticks:1' }, { ...base, exists: () => false }), true);
  assert.deepEqual(sent.splice(0).map(([p]) => p).sort((a, b) => a - b), [-101, -100]);
  // A gone leader: its group id may now belong to an unrelated group, so nothing is signalled.
  const gone = { ...base, exists: () => false, readToken: () => null, readTable: () => { throw new Error('the table is not read for a gone leader'); } };
  assert.equal(stopRecordedChild({ childPid: 100, childStartToken: 'ticks:1' }, gone), false);
  assert.deepEqual(sent.splice(0), [], 'a group under a gone leader\'s id is never signalled');
  assert.equal(stopRecordedChild({ childPid: 100, childStartToken: 'ticks:1' }, { ...base, exists: () => true, readTable: () => null }), true, 'no process table: the recorded group alone, as before');
  assert.deepEqual(sent.splice(0), [[-100, 'SIGKILL']]);
});

test('stopRecordedChild on Windows: kills only the recorded process, or the children of its ended shell started near the recorded time', () => {
  const at = '2026-10-15T12:00:00.000Z';
  const t0 = Date.parse(at);
  const killed = [];
  const opts = (o) => ({ platform: 'win32', killTree: (pid) => { killed.push(pid); return true; }, ...o });
  assert.equal(stopRecordedChild({ childPid: 50 }, opts({ exists: () => true, readStart: () => t0 })), false, 'no recorded start time: not touched');
  assert.equal(stopRecordedChild({ childPid: 50, childStartedAt: at }, opts({ exists: () => true, readStart: () => t0 + 3600000 })), false, 'a live pid that started an hour later is a reused pid');
  assert.equal(stopRecordedChild({ childPid: 50, childStartedAt: at }, opts({ exists: () => true, readStart: () => null })), false, 'start time unknown: not touched');
  assert.deepEqual(killed, []);
  assert.equal(stopRecordedChild({ childPid: 50, childStartedAt: at }, opts({ exists: () => true, readStart: () => t0 + 200 })), true);
  assert.deepEqual(killed.splice(0), [50]);
  const children = () => [{ pid: 61, startMs: t0 + 800 }, { pid: 62, startMs: t0 + 7200000 }];
  assert.equal(stopRecordedChild({ childPid: 50, childStartedAt: at }, opts({ exists: () => false, readChildren: children })), true);
  assert.deepEqual(killed.splice(0), [61], 'a child started two hours later belongs to a process that reused the pid');
  assert.equal(stopRecordedChild({ childPid: 50, childStartedAt: at }, opts({ exists: () => false, readChildren: () => [] })), false);
});
