// On Windows a seat CLI runs inside a job object: a process it started that left its tree (its launcher exited) and
// holds the CLI's output is stopped with the CLI, run in the foreground, from a worker started through WMI and from a
// plain detached worker. A job the wrapper cannot create ("nojob") is named, and the old warning stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = fileURLToPath(new URL('../', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const WINDOWS = { skip: process.platform !== 'win32' && 'job objects are Windows only' };

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function gone(pid) {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

async function harness(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'seat job ')));
  const bin = path.join(dir, 'bin');
  const target = path.join(dir, 'target');
  const temp = path.join(dir, 'temp');
  await Promise.all([fs.mkdir(bin), fs.mkdir(target), fs.mkdir(temp)]);
  await fs.writeFile(path.join(target, 'a.txt'), 'x\n');
  await fs.copyFile(FAKE_CLAUDE, path.join(bin, 'fake-claude.mjs'));
  await fs.writeFile(path.join(bin, 'fake-codex.mjs'), [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "if (process.argv.includes('mcp')) { process.stdout.write('[]\\n'); process.exit(0); }",
    "let input = ''; for await (const c of process.stdin) input += c;",
    'const config = JSON.parse(input);',
    "const say = (e) => process.stdout.write(JSON.stringify(e) + '\\n');",
    "say({ type: 'thread.started', thread_id: 'job-thread' });",
    "say({ type: 'item.completed', item: { type: 'agent_message', text: 'the answer' } });",
    "say({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });",
    "const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, windowsHide: true, cwd: config.cwd, stdio: ['ignore', 'inherit', 'inherit'] });",
    'writeFileSync(config.pidFile, JSON.stringify([orphan.pid]));',
    'orphan.unref();',
    '',
  ].join('\n'));
  for (const [name, fake] of [['claude', 'fake-claude.mjs'], ['codex', 'fake-codex.mjs']]) {
    await fs.writeFile(path.join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${path.join(bin, fake)}" %*\r\n`);
  }
  const gitDir = path.dirname(spawnSync('where', ['git'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'temp', 'tmp', 'review_seat_job'].includes(key.toLowerCase())));
  Object.assign(env, { PATH: [bin, gitDir].join(path.delimiter), TEMP: temp, TMP: temp, REVIEW_ANSWER_GRACE_MS: '1000' });
  const pids = [];
  t.after(async () => {
    for (const pid of pids) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    for (const pid of pids) await gone(pid);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let n = 0;
  const seat = async (config, runtime = 'claude') => {
    const folder = path.join(dir, `seat-${++n}`);
    await fs.mkdir(folder);
    const pidFile = path.join(folder, 'pids.json');
    await fs.writeFile(path.join(folder, 'brief.txt'), JSON.stringify({ ...config, pidFile, cwd: os.tmpdir(), text: 'the answer' }));
    const args = runtime === 'claude'
      ? [path.join(SCRIPTS, 'claude-dispatch.mjs'), '--brief', path.join(folder, 'brief.txt'), '--cd', target, '--model', 'm', '--no-isolate', '--timeout', '60']
      : [path.join(SCRIPTS, 'codex-dispatch.mjs'), '--brief', path.join(folder, 'brief.txt'), '--cd', target, '--sandbox', 'read-only', '--skip-git-repo-check', '--timeout', '60'];
    const orphan = async () => {
      const [pid] = JSON.parse(await fs.readFile(pidFile, 'utf8'));
      pids.push(pid);
      return pid;
    };
    return { folder, args, orphan, result: path.join(folder, 'result.json') };
  };
  const launch = (args, extra = {}) => spawnSync(process.execPath, args, { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
  const record = async (s) => JSON.parse(await fs.readFile(s.result, 'utf8'));
  return { dir, temp, seat, launch, record };
}

test('a seat CLI that answers and exits leaves an orphan holding its output: the job stops it, foreground claude and codex [slow]', WINDOWS, async (t) => {
  const h = await harness(t);
  for (const runtime of ['claude', 'codex']) {
    const s = await h.seat(runtime === 'claude' ? { orphanAfterResult: true } : {}, runtime);
    // A loaded machine can take over 1 s to end the job wrapper; a stop after the answer would then drop its report.
    const run = h.launch(s.args, { REVIEW_ANSWER_GRACE_MS: '15000' });
    assert.equal(run.status, 0, run.stderr);
    const pid = await s.orphan();
    assert.ok(await gone(pid), `${runtime}: the orphan holding the output is gone`);
    const record = await h.record(s);
    assert.equal(record.status, 'completed', record.error);
    assert.deepEqual(record.leftoversStopped, [pid], `${runtime}: the job named the process it stopped`);
    assert.equal(record.stopIncomplete, undefined, `${runtime}: nothing is left running, so no warning`);
    assert.match(run.stderr, /left 1 process\(es\) running .*its job object stopped them/);
  }
});

test('a seat CLI still running after its answer, with an orphan outside its tree holding its output: the stop ends both [slow]', WINDOWS, async (t) => {
  const h = await harness(t);
  const s = await h.seat({ hangWithOrphan: true });
  const run = h.launch(s.args);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /still running 1 s after its final answer; it was stopped and the answer kept/);
  const pid = await s.orphan();
  assert.ok(await gone(pid), 'the orphan died with the job');
  const record = await h.record(s);
  assert.equal(record.status, 'completed');
  assert.equal(record.stoppedAfterAnswer, true);
  assert.equal(record.stopIncomplete, undefined, 'the output closed once the job ended');
});

for (const mode of ['wmi', 'plain']) {
  test(`a detached seat (${mode} worker) that leaves an orphan holding its output: the job stops it [slow]`, WINDOWS, async (t) => {
    const h = await harness(t);
    const s = await h.seat({ orphanAfterResult: true });
    // A plain worker inherits this grace (a WMI one starts with the user's environment); see the foreground test above.
    const start = h.launch([...s.args, '--detach'], { REVIEW_DETACH_MODE: mode, REVIEW_ANSWER_GRACE_MS: '15000' });
    assert.equal(start.status, 0, start.stderr);
    const wait = h.launch([s.args[0], '--wait', s.result, '--max-wait', '90'], { REVIEW_DETACH_MODE: mode });
    assert.equal(wait.status, 0, wait.stdout + wait.stderr);
    const pid = await s.orphan();
    assert.ok(await gone(pid), 'the orphan is gone');
    const record = await h.record(s);
    assert.equal(record.detached, true);
    assert.deepEqual(record.leftoversStopped, [pid]);
    assert.equal(record.stopIncomplete, undefined);
  });
}

test('a job the wrapper cannot create is named in result.json, and the orphan warning stays [slow]', WINDOWS, async (t) => {
  const h = await harness(t);
  const first = await h.seat({});
  assert.equal(h.launch(first.args).status, 0, 'a first run builds the job helper in the private TEMP');
  const dll = (await fs.readdir(h.temp)).find((name) => /^review-preflight-job-.*\.dll$/.test(name));
  assert.ok(dll, 'the job helper DLL was built');
  await fs.writeFile(path.join(h.temp, dll), 'not an assembly');
  const s = await h.seat({ orphanAfterResult: true });
  const run = h.launch(s.args);
  const pid = await s.orphan();
  assert.equal(run.status, 0, run.stderr);
  assert.ok(alive(pid), 'with no job the orphan is still running (the test stops it)');
  assert.match(run.stderr, /could not run in a job object \(.+\); a process it starts can outlive it/);
  const record = await h.record(s);
  assert.equal(typeof record.jobRefused, 'string');
  assert.equal(record.stopIncomplete, true, 'without the job the old warning still says a process may be running');
  assert.match(run.stderr, /its output was still open .* a process it started may still be running/);
  // Restructure round 1 F9: a seat stopped after its answer (it kept running) still records that its job was refused.
  // The wrapper deletes a DLL it cannot load (the next run rebuilds it), so break it again first.
  await fs.writeFile(path.join(h.temp, dll), 'not an assembly');
  const hang = await h.seat({ hangAfterResult: true });
  const stopped = h.launch(hang.args);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stderr, /could not run in a job object \(.+\); a process it starts can outlive it/);
  const hangRecord = await h.record(hang);
  assert.equal(hangRecord.stoppedAfterAnswer, true);
  assert.equal(typeof hangRecord.jobRefused, 'string');
});
