import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RESULT_REQUIRED_KEYS, DEFAULT_MAX_WAIT_S } from '../codex-dispatch.mjs';

function assertResultSchema(output) {
  for (const key of RESULT_REQUIRED_KEYS) {
    assert.ok(key in output, `result.json missing required key "${key}"`);
  }
}

// A fixture PATH narrowed to just a fake CLI's bin dir hides real git too, so isGitRepo()
// fails on ENOENT rather than on the target actually not being a repo. Append this instead.
function realGitDir() {
  const out = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).stdout;
  return path.dirname(out.split(/\r?\n/)[0]);
}

test('dispatcher passes selected model and effort to a fake CLI on fresh and resumed runs', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch test '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:'thread.started', thread_id:'fixture-thread'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message',
text:JSON.stringify({argv:process.argv.slice(2), input})}}));
`);
  // Only the fixture bin is on PATH, so this test cannot call a real Codex CLI.
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  for (const phase of ['fresh', 'resume']) {
    const folder = path.join(dir, phase);
    await fs.mkdir(folder);
    const brief = path.join(folder, 'brief.txt');
    await fs.writeFile(brief, 'fixture prompt with spaces');
    const args = [script, '--brief', brief, '--cd', dir, '--sandbox', 'read-only',
      '--model', 'gpt-fixture', '--effort', 'high'];
    if (phase === 'resume') args.push('--session', 'fixture-thread');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = bin;
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
    assert.equal(output.status, 'completed');
    const observed = JSON.parse(output.finalMessage);
    assert.equal(observed.input, 'fixture prompt with spaces');
    assert.equal(observed.argv[observed.argv.indexOf('--model') + 1], 'gpt-fixture');
    assert.equal(observed.argv[observed.argv.indexOf('-c') + 1], 'model_reasoning_effort=high');
    assert.equal(observed.argv.includes('-s'), phase === 'fresh');
    assert.equal(output.modelRequested, 'gpt-fixture');
    assert.equal(output.modelResolved, null);
    assert.equal(output.threadId, 'fixture-thread');
    assertResultSchema(output);
    assert.equal(output.isolated, false);
    assert.equal(output.worktreePath, null);
  }
});

for (const dispatcher of ['codex', 'opencode']) {
  test(`${dispatcher}-dispatch reports files a reviewer wrote into a non-git --cd via the content-hash inventory, instead of touchedFiles null`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${dispatcher} nongit touched `));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    const target = path.join(dir, 'target');
    const phase1 = path.join(dir, 'phase1');
    await Promise.all([fs.mkdir(bin), fs.mkdir(target), fs.mkdir(phase1)]);
    await fs.writeFile(path.join(target, 'article.md'), 'original\n');
    const events = dispatcher === 'codex'
      ? `console.log(JSON.stringify({type:'thread.started', thread_id:'t1'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'done'}}));`
      : `console.log(JSON.stringify({type:'text', sessionID:'s1', part:{type:'text', text:'done'}}));`;
    const fake = path.join(bin, 'fake.mjs');
    await fs.writeFile(fake, `import { writeFileSync } from 'node:fs';
let input = '';
if (!process.stdin.isTTY) { for await (const chunk of process.stdin) input += chunk; }
writeFileSync(${JSON.stringify(path.join(target, 'article.md'))}, 'edited by reviewer\\n');
writeFileSync(${JSON.stringify(path.join(target, 'scratch.txt'))}, 'new\\n');
${events}
`);
    const shim = path.join(bin, process.platform === 'win32' ? `${dispatcher}.cmd` : dispatcher);
    const wrapper = process.platform === 'win32'
      ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
      : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
    await fs.writeFile(shim, wrapper, { mode: 0o755 });
    const brief = path.join(phase1, 'brief.txt');
    await fs.writeFile(brief, 'fixture prompt');
    const script = fileURLToPath(new URL(`../${dispatcher}-dispatch.mjs`, import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = bin + path.delimiter + realGitDir();
    const result = spawnSync(process.execPath, [script, '--brief', brief, '--cd', target], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
    assert.equal(output.status, 'completed');
    assert.deepEqual(output.touchedFiles, ['article.md', 'scratch.txt']);
    assert.ok(!('touchedFilesNote' in output), 'a successful inventory diff needs no note');
    assertResultSchema(output);
  });
}

test('codex-dispatch writes usage_delta: the fresh call\'s own usage, then only the resumed call\'s share when --previous-result is passed', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch delta '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Cumulative like the real CLI: the resumed turn reports the thread's running total.
  await fs.writeFile(fake, `let input = '';
for await (const chunk of process.stdin) input += chunk;
const resumed = process.argv.includes('resume');
console.log(JSON.stringify({type:'thread.started', thread_id:'delta-thread'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'ok'}}));
console.log(JSON.stringify({type:'turn.completed', usage: resumed
  ? {input_tokens:3196564,cached_input_tokens:3000000,cache_write_input_tokens:0,output_tokens:15000,reasoning_output_tokens:40}
  : {input_tokens:1821943,cached_input_tokens:1700000,cache_write_input_tokens:0,output_tokens:9000,reasoning_output_tokens:25}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  const phase1 = path.join(dir, 'phase1'); const phase2 = path.join(dir, 'phase2');
  await fs.mkdir(phase1); await fs.mkdir(phase2);
  await fs.writeFile(path.join(phase1, 'brief.txt'), 'p1');
  await fs.writeFile(path.join(phase2, 'brief.txt'), 'p2');
  let r = spawnSync(process.execPath, [script, '--brief', path.join(phase1, 'brief.txt'), '--cd', dir], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  const first = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
  assert.equal(first.usage_delta.source, 'fresh-thread');
  assert.equal(first.usage_delta.input_tokens, 1821943);
  // A result.json re-saved by PowerShell Set-Content -Encoding utf8 starts with a BOM.
  await fs.writeFile(path.join(phase1, 'result.json'), '\uFEFF' + JSON.stringify(first), 'utf8');
  r = spawnSync(process.execPath, [script, '--brief', path.join(phase2, 'brief.txt'), '--cd', dir, '--session', 'delta-thread',
    '--previous-result', path.join(phase1, 'result.json')], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  const second = JSON.parse(await fs.readFile(path.join(phase2, 'result.json'), 'utf8'));
  assert.equal(second.usage.input_tokens, 3196564, 'usage stays the cumulative number codex reported');
  assert.equal(second.usage_delta.source, 'delta-from-previous-result');
  assert.equal(second.usage_delta.input_tokens, 1374621);
  assert.equal(second.usage_delta.output_tokens, 6000);
  // A redaction resume in the same folder: --previous-result is the result.json the retry renames.
  r = spawnSync(process.execPath, [script, '--brief', path.join(phase2, 'brief.txt'), '--cd', dir, '--session', 'delta-thread',
    '--previous-result', path.join(phase2, 'result.json')], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  const third = JSON.parse(await fs.readFile(path.join(phase2, 'result.json'), 'utf8'));
  assert.equal(third.usage_delta.source, 'delta-from-previous-result', 'the previous result is read before it is renamed');
  assert.ok((await fs.readdir(phase2)).includes('result.attempt-1.json'));
});

test('codex-dispatch puts codex\'s own turn.failed error first in result.error (MCP connector stderr noise left out) and a retry keeps the failed result as result.attempt-1.json', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch codex error '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Shape copied from a real failing codex exec --json run.
  await fs.writeFile(fake, `let input = '';
for await (const chunk of process.stdin) input += chunk;
for (let i = 0; i < 30; i++) process.stderr.write('2026-09-26T00:23:39Z ERROR rmcp::transport::worker: worker quit with fatal: HTTP 401: Invalid or missing API key\\n');
process.stderr.write('ERROR: MCP config file is not valid TOML at line 3\\n');
const body = JSON.stringify({type:'error', status:401, error:{type:'invalid_request_error', message:'Incorrect API key provided: sk-svc****'}});
console.log(JSON.stringify({type:'thread.started', thread_id:'t-err'}));
console.log(JSON.stringify({type:'error', message: body}));
console.log(JSON.stringify({type:'turn.failed', error:{message: body}}));
process.exit(1);
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const phase1 = path.join(dir, 'phase1');
  await fs.mkdir(phase1);
  await fs.writeFile(path.join(phase1, 'brief.txt'), 'p1');
  const dispatch = () => spawnSync(process.execPath, [script, '--brief', path.join(phase1, 'brief.txt'), '--cd', dir], { env, encoding: 'utf8', timeout: 15000 });
  let r = dispatch();
  assert.equal(r.status, 1);
  const first = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
  assert.equal(first.status, 'error');
  assert.deepEqual(first.codexErrors, ['HTTP 401: Incorrect API key provided: sk-svc****'], 'the two events carry one message; it is kept once');
  assert.match(first.error, /^codex exec exited with code 1\ncodex reported: HTTP 401: Incorrect API key provided/);
  assert.doesNotMatch(first.error, /rmcp::transport/);
  assert.match(first.error, /30 stderr line\(s\) from MCP connectors not shown/);
  assert.match(first.error, /ERROR: MCP config file is not valid TOML/, 'a non-logger line that mentions MCP stays visible');
  assert.equal(first.stderrLog, path.join(phase1, 'result.stderr.log'));
  assert.match(first.error, /full stderr: .*result\.stderr\.log/);
  assert.equal((await fs.readFile(first.stderrLog, 'utf8')).split('\n').filter((l) => l.includes('rmcp::')).length, 30, 'the filtered lines are kept in the log');
  r = dispatch();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /kept the earlier result\.json as result\.attempt-1\.json/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(phase1, 'result.attempt-1.json'), 'utf8')).startedAt, first.startedAt);
  dispatch();
  const names = await fs.readdir(phase1);
  assert.ok(names.includes('result.attempt-2.json'), 'a third try keeps both earlier results');
  assert.ok(names.includes('result.attempt-1.stderr.log') && names.includes('result.attempt-2.stderr.log'), 'each attempt keeps its own stderr log');
});

test('codex-dispatch --web records every web_search item (every query of a batched call, action, result URLs) in result.webCalls; without --web there is no webCalls field', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch web '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Event shapes copied from a real codex 0.156 --search run.
  await fs.writeFile(fake, `let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:'thread.started', thread_id:'t-web'}));
console.log(JSON.stringify({type:'item.started', item:{id:'item_2', type:'web_search', query:'', action:{type:'other'}}}));
console.log(JSON.stringify({type:'item.completed', item:{id:'item_2', type:'web_search', query:'site:example.org codename',
  action:{type:'search', query:'site:example.org codename'},
  results:[{type:'text_result', domain:'example.org', url:'https://example.org/a', title:'A'}, {type:'text_result', domain:'example.org', url:'https://example.org/b'}]}}));
// A batched call (real codex 0.156 capture): the full list is in action.queries, query is a '...' summary.
console.log(JSON.stringify({type:'item.completed', item:{id:'item_3', type:'web_search', query:'Babelfish extensions docs ...',
  action:{type:'search', queries:['Babelfish extensions docs', 'TimescaleDB supported versions', 'FerretDB install']},
  results:[{type:'text_result', url:'https://example.org/c'}]}}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'done'}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  for (const web of [true, false]) {
    const folder = path.join(dir, web ? 'with' : 'without');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'brief.txt'), 'p');
    const r = spawnSync(process.execPath, [script, '--brief', path.join(folder, 'brief.txt'), '--cd', dir, ...(web ? ['--web'] : [])], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
    if (web) {
      assert.deepEqual(out.webCalls, [
        { action: 'search', queries: ['site:example.org codename'], url: null, resultUrls: ['https://example.org/a', 'https://example.org/b'] },
        { action: 'search', queries: ['Babelfish extensions docs', 'TimescaleDB supported versions', 'FerretDB install'], url: null, resultUrls: ['https://example.org/c'] },
      ]);
    } else {
      assert.ok(!('webCalls' in out));
    }
  }
});

test('codex-dispatch writes result.json with status "running" and the threadId as soon as codex names its thread, so a dispatcher killed from outside leaves a resumable id; the next dispatch keeps it as result.attempt-1.json', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch running '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:'thread.started', thread_id:'t-killed'}));
if (input.includes('hang')) { setTimeout(() => process.exit(0), 8000); } else {
  console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'done'}}));
}
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const folder = path.join(dir, 'phase1', 'B');
  await fs.mkdir(folder, { recursive: true });
  const brief = path.join(folder, 'brief.txt');
  const resultPath = path.join(folder, 'result.json');
  await fs.writeFile(brief, 'hang');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [script, '--brief', brief, '--cd', dir], { env, stdio: 'ignore' });
  let running = null;
  for (let i = 0; i < 100 && running === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { running = JSON.parse(await fs.readFile(resultPath, 'utf8')); } catch { running = null; }
  }
  // The dispatcher may already have exited (fake codex ends after 8 s); only wait for an exit still to come.
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
  }
  assert.ok(running, 'result.json appeared while codex was still running');
  assert.equal(running.status, 'running');
  assert.equal(running.threadId, 't-killed');
  assert.equal(running.finishedAt, null);
  assertResultSchema(running);
  assert.equal(JSON.parse(await fs.readFile(resultPath, 'utf8')).status, 'running', 'a killed dispatcher leaves the running record behind');
  await new Promise((r) => setTimeout(r, 8500)); // let the orphaned fake codex exit before cleanup
  await fs.writeFile(brief, 'ok');
  const r = spawnSync(process.execPath, [script, '--brief', brief, '--cd', dir], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(await fs.readFile(resultPath, 'utf8')).status, 'completed');
  const kept = JSON.parse(await fs.readFile(path.join(folder, 'result.attempt-1.json'), 'utf8'));
  assert.equal(kept.status, 'running');
  assert.equal(kept.threadId, 't-killed', 'the interrupted thread id survives the retry');
});

test('codex-dispatch --detach returns at once with a running record, the worker finishes the dispatch on its own, and --wait reports the final status', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch detach '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:'thread.started', thread_id:'t-detach'}));
await new Promise((r) => setTimeout(r, 1500));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'detached done'}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const folder = path.join(dir, 'phase1', 'B');
  await fs.mkdir(folder, { recursive: true });
  const brief = path.join(folder, 'brief.txt');
  await fs.writeFile(brief, 'review');
  const out = path.join(dir, 'phase1', 'B-findings.md');
  const started = Date.now();
  const d = spawnSync(process.execPath, [script, '--brief', brief, '--cd', dir, '--detach', '--final-message-out', out], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /detached worker pid \d+ started/);
  const placeholder = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
  assert.equal(placeholder.status, 'running');
  assert.equal(placeholder.detached, true);
  assertResultSchema(placeholder);
  const job = JSON.parse(await fs.readFile(path.join(folder, 'dispatch-job.json'), 'utf8'));
  assert.ok(!job.argv.includes('--detach'), 'the worker runs the dispatch itself, not another detach');
  const w = spawnSync(process.execPath, [script, '--wait', path.join(folder, 'result.json'), '--max-wait', '60'], { env, encoding: 'utf8', timeout: 90000 });
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /finished with status "completed", threadId t-detach/);
  const final = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
  assert.equal(final.status, 'completed');
  assert.equal(final.finalMessage, 'detached done');
  assert.equal(typeof final.workerPid, 'number');
  assert.equal(await fs.readFile(out, 'utf8'), 'detached done');
  assert.match(await fs.readFile(path.join(folder, 'dispatch-worker.log'), 'utf8'), /relay: done/);
  assert.ok(Date.now() - started < 60000);
});

test('codex-dispatch --wait: a worker gone while result.json says running exits 1 and names the thread to resume; --max-wait exits 3; bad arguments exit 2', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch wait '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(gone.stdout);
  const resultPath = path.join(dir, 'result.json');
  await fs.writeFile(resultPath, JSON.stringify({ status: 'running', threadId: 't-gone', workerPid: deadPid, startedAt: new Date().toISOString() }));
  let r = spawnSync(process.execPath, [script, '--wait', resultPath], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`worker ${deadPid} is gone .*resume thread t-gone with --session`));
  assert.match(r.stderr, new RegExp(`worker ${deadPid} is gone`), 'the reason is on stderr too, for a wrapper that drops stdout');
  await fs.writeFile(resultPath, JSON.stringify({ status: 'running', threadId: null, workerPid: process.pid, startedAt: new Date().toISOString() }));
  r = spawnSync(process.execPath, [script, '--wait', resultPath, '--max-wait', '1'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 3);
  assert.match(r.stdout, /still running; run --wait again/);
  assert.match(r.stderr, /still running; run --wait again/);
  assert.ok(DEFAULT_MAX_WAIT_S > 0 && DEFAULT_MAX_WAIT_S < 600, 'a foreground --wait without --max-wait returns before a 10-minute tool limit');
  r = spawnSync(process.execPath, [script, '--wait', resultPath, '--bogus'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 2);
});

test('codex-dispatch --wait-retry: exits 0 with the thread to resume once retryAfter has passed, 3 when --max-wait passes first, 2 for another status, a non-clock retryAfter or a bad argument', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch retry '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const resultPath = path.join(dir, 'result.json');
  const clock = (d) => `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  const write = (rec) => fs.writeFile(resultPath, JSON.stringify({ status: 'rate-limited', threadId: 't-limit', ...rec }));
  const run = (...extra) => spawnSync(process.execPath, [script, '--wait-retry', resultPath, ...extra], { encoding: 'utf8', timeout: 30000 });
  const now = new Date();
  if (now.getHours() !== 0 || now.getMinutes() > 2) {
    await write({ retryAfter: clock(new Date(now.getTime() - 60000)) });
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage limit ended at .*; resume thread t-limit with --session, or start a new dispatch/);
  }
  await write({ retryAfter: clock(new Date(now.getTime() + 2 * 3600 * 1000)) });
  let r = run('--max-wait', '1');
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /\d+ s left until .*; run --wait-retry again/);
  assert.match(r.stderr, /run --wait-retry again/);
  await write({ retryAfter: 'Sep 29th, 2026' });
  r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /retryAfter "Sep 29th, 2026" is not a plain clock time/);
  await fs.writeFile(resultPath, JSON.stringify({ status: 'completed', threadId: 't-limit' }));
  r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has status "completed", not "rate-limited"/);
  assert.equal(run('--bogus').status, 2);
});

test('both dispatchers refuse, before starting anything, to overwrite an existing --final-message-out file unless --replace-completed; a completed result.json in the folder does not stop a resume', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch done '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const marker = path.join(dir, 'codex-started');
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, 'import { writeFileSync } from "node:fs";\nwriteFileSync(' + JSON.stringify(marker) + ', "x");\nprocess.exit(1);\n');
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const folder = path.join(dir, 'B');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'brief.txt'), 'continue');
  const run = (...extra) => spawnSync(process.execPath, [script, '--brief', path.join(folder, 'brief.txt'), '--cd', dir, '--session', 't-done', ...extra], { env, encoding: 'utf8', timeout: 15000 });
  const findings = path.join(dir, 'B-findings.md');
  await fs.writeFile(findings, 'the first answer');
  for (const extra of [[], ['--detach']]) {
    const r = run('--final-message-out', findings, ...extra);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--final-message-out .*B-findings\.md already exists, so a seat already answered into it/);
    await assert.rejects(fs.access(marker), 'codex was never started');
    assert.equal(await fs.readFile(findings, 'utf8'), 'the first answer');
  }
  await fs.writeFile(path.join(folder, 'result.json'), JSON.stringify({ status: 'completed', threadId: 't-done' }));
  run();
  await fs.access(marker);
  assert.equal(JSON.parse(await fs.readFile(path.join(folder, 'result.attempt-1.json'), 'utf8')).status, 'completed', 'a resume in a folder with a completed call runs, and the earlier result is kept');
  await fs.rm(marker);
  run('--final-message-out', findings, '--replace-completed');
  await fs.access(marker);
  const opencode = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [opencode, '--brief', path.join(folder, 'brief.txt'), '--cd', dir, '--model', 'p/m', '--final-message-out', findings], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--final-message-out .*B-findings\.md already exists/);
  assert.match(r.stderr, /\(16 bytes\)/, 'the refusal names the file size');
  await fs.writeFile(findings, '');
  assert.match(run('--final-message-out', findings).stderr, /it is empty \(0 bytes\), so that answer failed/);
});

test('both dispatchers: a run that exits 0 with an empty last message is status "error" and writes no --final-message-out file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch empty '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const target = path.join(dir, 'target');
  await Promise.all([fs.mkdir(bin), fs.mkdir(target)]);
  await fs.writeFile(path.join(target, 'a.md'), 'x\n');
  const fakes = {
    codex: `console.log(JSON.stringify({type:'thread.started', thread_id:'t-empty'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:' \\n'}}));
`,
    opencode: `console.log(JSON.stringify({type:'text', sessionID:'s-empty', part:{type:'text', text:''}}));
`,
  };
  for (const [name, body] of Object.entries(fakes)) {
    const fake = path.join(bin, `${name}-fake.mjs`);
    await fs.writeFile(fake, body);
    const shim = path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
    await fs.writeFile(shim, process.platform === 'win32'
      ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
      : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  for (const [name, extra, pattern] of [
    ['codex', [], /codex exec exited 0 but its last agent_message was empty/],
    ['opencode', ['--model', 'p/m'], /opencode run exited 0 but its last text event was empty/],
  ]) {
    const folder = path.join(dir, name);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'brief.txt'), 'go');
    const out = path.join(dir, `${name}-findings.md`);
    const script = fileURLToPath(new URL(`../${name}-dispatch.mjs`, import.meta.url));
    const r = spawnSync(process.execPath, [script, '--brief', path.join(folder, 'brief.txt'), '--cd', target, '--final-message-out', out, ...extra], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 1, r.stderr);
    const result = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
    assert.equal(result.status, 'error');
    assert.match(result.error, pattern);
    await assert.rejects(fs.access(out), `${name}: no empty answer file is written`);
  }
});

test('codex-dispatch: a Codex usage limit is status "rate-limited" with retryAfter and the threadId kept for a resume; another failure stays "error"', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch limit '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Message text copied from a real codex 0.156 run that hit the account limit.
  await fs.writeFile(fake, `let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:'thread.started', thread_id:'t-limit'}));
const message = input.includes('limit')
  ? 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 10:51 AM.'
  : 'stream disconnected before completion';
console.log(JSON.stringify({type:'turn.failed', error:{message}}));
process.exit(1);
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  for (const [kind, expected] of [['limit', 'rate-limited'], ['other', 'error']]) {
    const folder = path.join(dir, kind);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'brief.txt'), kind);
    const r = spawnSync(process.execPath, [script, '--brief', path.join(folder, 'brief.txt'), '--cd', dir], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 1);
    const out = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
    assert.equal(out.status, expected);
    assert.equal(out.threadId, 't-limit');
    assertResultSchema(out);
    if (kind === 'limit') {
      assert.equal(out.retryAfter, '10:51 AM');
      assert.match(out.retryAfterNote, /local time/);
      assert.match(out.error, /You’ve hit your usage limit/, 'the curly quote is stored as UTF-8, not garbled');
    } else {
      assert.ok(!('retryAfter' in out));
    }
  }
});

test('codex-dispatch --final-message-out writes the exact final message as UTF-8 without BOM, and a failed run leaves the earlier file untouched', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch final out '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:'thread.started', thread_id:'t-out'}));
if (input.includes('fail')) process.exit(1);
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'## B1 — café ✓\\r\\nline 2'}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const folder = path.join(dir, 'phase1', 'B');
  await fs.mkdir(folder, { recursive: true });
  const brief = path.join(folder, 'brief.txt');
  const out = path.join(dir, 'phase1', 'B-findings.md');
  const dispatch = (...extra) => spawnSync(process.execPath, [script, '--brief', brief, '--cd', dir, '--final-message-out', out, ...extra], { env, encoding: 'utf8', timeout: 15000 });
  await fs.writeFile(brief, 'ok');
  let r = dispatch();
  assert.equal(r.status, 0, r.stderr);
  const expected = Buffer.from('## B1 — café ✓\r\nline 2', 'utf8');
  assert.deepEqual(await fs.readFile(out), expected, 'exact bytes: UTF-8, no BOM, line endings kept');
  const result = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
  assert.equal(result.finalMessageOut, out);
  await fs.writeFile(brief, 'fail');
  r = dispatch('--replace-completed');
  assert.equal(r.status, 1);
  assert.deepEqual(await fs.readFile(out), expected, 'a failed run does not touch the earlier file');
  assert.ok(!('finalMessageOut' in JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'))));
});

test('opencode-dispatch --final-message-out writes the final message, and an unwritable path turns the run into status error', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode final out '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const target = path.join(dir, 'target');
  const phase1 = path.join(dir, 'phase1');
  await Promise.all([fs.mkdir(bin), fs.mkdir(target), fs.mkdir(phase1)]);
  await fs.writeFile(path.join(target, 'a.md'), 'x\n');
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `let input = '';
if (!process.stdin.isTTY) { for await (const chunk of process.stdin) input += chunk; }
console.log(JSON.stringify({type:'text', sessionID:'s1', part:{type:'text', text:'## B1 — naïve'}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  await fs.writeFile(path.join(phase1, 'brief.txt'), 'p1');
  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const dispatch = (out) => spawnSync(process.execPath, [script, '--brief', path.join(phase1, 'brief.txt'), '--cd', target, '--final-message-out', out], { env, encoding: 'utf8', timeout: 15000 });
  const out = path.join(dir, 'B-findings.md');
  let r = dispatch(out);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await fs.readFile(out), Buffer.from('## B1 — naïve', 'utf8'));
  assert.equal(JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8')).finalMessageOut, out);
  r = dispatch(path.join(dir, 'missing-folder', 'B-findings.md'));
  assert.equal(r.status, 1);
  const failed = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /could not write --final-message-out/);
  assert.equal(failed.finalMessage, '## B1 — naïve', 'result.json still carries the message');
});

test('opencode-dispatch --isolate --worktree: Phase 1 and Phase 2 briefs in different folders share one worktree outside the run directory', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode worktree '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const target = path.join(dir, 'target');
  const run = path.join(dir, 'run');
  await Promise.all([fs.mkdir(bin), fs.mkdir(target), fs.mkdir(path.join(run, 'phase1', 'B'), { recursive: true }), fs.mkdir(path.join(run, 'phase2', 'B'), { recursive: true })]);
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: target, encoding: 'utf8' });
  git('init', '-q');
  await fs.writeFile(path.join(target, 'a.txt'), 'x\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'x');
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `let input = '';
if (!process.stdin.isTTY) { for await (const chunk of process.stdin) input += chunk; }
console.log(JSON.stringify({type:'text', sessionID:'s1', part:{type:'text', text:'done'}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const worktree = path.join(dir, 'run-worktree');
  const results = [];
  for (const phase of ['phase1', 'phase2']) {
    const brief = path.join(run, phase, 'B', 'brief.txt');
    await fs.writeFile(brief, 'p');
    const r = spawnSync(process.execPath, [script, '--brief', brief, '--cd', target, '--isolate', '--worktree', worktree], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    results.push(JSON.parse(await fs.readFile(path.join(run, phase, 'B', 'result.json'), 'utf8')));
  }
  assert.equal(results[0].worktreePath, results[1].worktreePath);
  assert.equal(path.resolve(results[0].worktreePath), path.resolve(worktree));
  assert.match(results[1].isolationNote ?? '', /reused=true/);
  const bad = spawnSync(process.execPath, [script, '--brief', path.join(run, 'phase1', 'B', 'brief.txt'), '--cd', target, '--worktree', worktree], { env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--worktree is only meaningful with --isolate/);
});

test('opencode-dispatch: a retry in the same folder keeps the earlier result.json as result.attempt-1.json', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode retry '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const target = path.join(dir, 'target');
  const phase1 = path.join(dir, 'phase1');
  await Promise.all([fs.mkdir(bin), fs.mkdir(target), fs.mkdir(phase1)]);
  await fs.writeFile(path.join(target, 'a.md'), 'x\n');
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `let input = '';
if (!process.stdin.isTTY) { for await (const chunk of process.stdin) input += chunk; }
console.log(JSON.stringify({type:'text', sessionID:'s1', part:{type:'text', text:'done'}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  await fs.writeFile(path.join(phase1, 'brief.txt'), 'p1');
  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const dispatch = () => spawnSync(process.execPath, [script, '--brief', path.join(phase1, 'brief.txt'), '--cd', target], { env, encoding: 'utf8', timeout: 15000 });
  let r = dispatch();
  assert.equal(r.status, 0, r.stderr);
  const first = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
  r = dispatch();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /kept the earlier result\.json as result\.attempt-1\.json/);
  assert.equal(JSON.parse(await fs.readFile(path.join(phase1, 'result.attempt-1.json'), 'utf8')).startedAt, first.startedAt);
});

test('dispatcher parses a real turn.completed.usage event into result.json\'s usage field with source "provider"', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch usage '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:'thread.started', thread_id:'usage-fixture-thread'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'KIWI'}}));
console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:26076,cached_input_tokens:8960,cache_write_input_tokens:0,output_tokens:6,reasoning_output_tokens:0}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', dir, '--sandbox', 'read-only'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(output.status, 'completed');
  assert.deepEqual(output.usage, {
    input_tokens: 26076,
    cached_input_tokens: 8960,
    cache_write_input_tokens: 0,
    output_tokens: 6,
    reasoning_tokens: 0,
    estimated_cost_usd: null,
    source: 'provider',
    raw: { input_tokens: 26076, cached_input_tokens: 8960, cache_write_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 0 },
  });
  assertResultSchema(output);
});

test('dispatcher kills a hung codex process on --timeout and writes status timed-out', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch timeout '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  const pidFile = path.join(dir, 'fake.pid');
  // Emits thread.started, then never closes stdout/exits on its own -- the
  // dispatcher's --timeout is the only thing that ends this process. Writes
  // its own pid so the test can confirm the REAL node process behind the
  // .cmd shim died, not just cmd.exe (see codex.cmd wrapping the shim).
  await fs.writeFile(fake, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log(JSON.stringify({type:'thread.started', thread_id:'hung-thread'}));
setInterval(() => {}, 1000);
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', dir, '--sandbox', 'read-only', '--timeout', '2'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(output.status, 'timed-out');
  assert.match(output.error, /timeout 2s/);
  assertResultSchema(output);

  const fakePid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.throws(
    () => process.kill(fakePid, 0),
    'the real node process behind the .cmd shim must be dead, not just cmd.exe'
  );
});

test('opencode-dispatch kills a hung opencode process on --timeout and writes status timed-out', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode timeout '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Emits a sessionID event, then never closes stdout/exits on its own -- the
  // dispatcher's --timeout is the only thing that ends this process. Does not
  // read stdin: OPENCODE_SPAWN_STDIO sets the real child's stdin to 'ignore'.
  await fs.writeFile(fake, `console.log(JSON.stringify({sessionID:'hung-session', type:'step_start'}));
setInterval(() => {}, 1000);
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });
  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', dir, '--timeout', '2'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(output.status, 'timed-out');
  assert.match(output.error, /timeout 2s/);
  assertResultSchema(output);
});

test('opencode-dispatch reports usage {source: "unavailable"} when no step_finish event is observed', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode usage '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `console.log(JSON.stringify({sessionID:'usage-fixture-session', type:'text', part:{type:'text', text:'PLUM'}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });
  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', dir];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(output.status, 'completed');
  assert.deepEqual(output.usage, { source: 'unavailable' });
  assertResultSchema(output);
});

test('opencode-dispatch parses a real step_finish.part.tokens event into result.json\'s usage field with source "provider"', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode usage real '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Exact shape captured from a live "opencode run --format json" call.
  await fs.writeFile(fake, `console.log(JSON.stringify({type:'text', sessionID:'usage-fixture-session', part:{type:'text', text:'PLUM'}}));
console.log(JSON.stringify({type:'step_finish', sessionID:'usage-fixture-session', part:{type:'step-finish', reason:'stop', tokens:{total:21703,input:19907,output:4,reasoning:0,cache:{write:0,read:1792}}, cost:0}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });
  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', dir];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(output.status, 'completed');
  assert.equal(output.usage.source, 'provider');
  assert.equal(output.usage.input_tokens, 19907);
  assert.equal(output.usage.cached_input_tokens, 1792);
  assert.equal(output.usage.cache_write_input_tokens, 0);
  assert.equal(output.usage.output_tokens, 4);
  assert.equal(output.usage.reasoning_tokens, 0);
  assert.equal(output.usage.estimated_cost_usd, null, 'OpenCode\'s own cost field is not trusted (observed unreliable live) -- estimated_cost_usd stays null even though "raw" carries OpenCode\'s reported cost');
  assert.equal(output.usage.raw.cost, 0, 'the verbatim OpenCode cost value is preserved in raw for anyone who wants to inspect it despite the reliability caveat');
  assertResultSchema(output);
});

test('opencode-dispatch refuses to run unisolated when --isolate is requested against a non-git --cd', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode isolate-nongit '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const sentinel = path.join(dir, 'shim-was-invoked');
  const fake = path.join(bin, 'fake.mjs');
  // Sentinel proves the reviewer never launched, not just that its output was dropped.
  await fs.writeFile(fake, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(sentinel)}, '');
console.log(JSON.stringify({sessionID:'should-not-run', type:'step_start'}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });

  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'secret.txt'), 'must not be touched\n');

  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  // Brief lives at <run-dir>/phase1/brief.txt per phase-1-independent-passes.md, so
  // the dispatcher's briefDir/../worktree resolves to <run-dir>/worktree, not a path
  // outside this test's own mkdtemp dir shared with every other run.
  const phase1 = path.join(dir, 'phase1');
  await fs.mkdir(phase1);
  const brief = path.join(phase1, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', target, '--isolate'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);

  const output = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
  assert.equal(output.status, 'error');
  assert.match(output.error, /not a git repository/);
  assert.equal(output.isolated, false);
  assert.equal(output.worktreePath, null);
  assertResultSchema(output);
  assert.ok('touchedFilesNote' in output, 'touchedFiles is null here; touchedFilesNote must explain why');
  await assert.rejects(fs.access(sentinel), 'the reviewer process must never launch when isolation fails closed');
  assert.equal(await fs.readFile(path.join(target, 'secret.txt'), 'utf8'), 'must not be touched\n');
});

test('opencode-dispatch refuses to run unisolated when --isolate worktree setup fails', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode isolate-setupfail '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const sentinel = path.join(dir, 'shim-was-invoked');
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(sentinel)}, '');
console.log(JSON.stringify({sessionID:'should-not-run', type:'step_start'}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const wrapper = process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n';
  await fs.writeFile(shim, wrapper, { mode: 0o755 });

  // A git repo with no commits: `git worktree add ... HEAD` has no HEAD to
  // resolve, so worktree setup fails deterministically without a fake shim.
  const target = path.join(dir, 'target');
  await fs.mkdir(target);
  spawnSync('git', ['init', '-q'], { cwd: target });

  const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
  const phase1 = path.join(dir, 'phase1');
  await fs.mkdir(phase1);
  const brief = path.join(phase1, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const args = [script, '--brief', brief, '--cd', target, '--isolate'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);

  const output = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
  assert.equal(output.status, 'error');
  assert.match(output.error, /worktree setup failed/);
  assert.equal(output.isolated, false);
  assert.equal(output.worktreePath, null);
  assertResultSchema(output);
  await assert.rejects(fs.access(sentinel), 'the reviewer process must never launch when isolation fails closed');
});

test(
  'opencode-dispatch reports isolated:true/worktreePath truthfully when isolation succeeds but the dispatch itself fails afterward',
  { skip: process.platform !== 'win32' && 'this dispatch-failure trigger (a % in the brief path) is win32-specific; POSIX has no equivalent forced-reject path here' },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode isolate-then-fail '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));

    // A real commit, so worktree setup (which needs a HEAD) succeeds.
    const target = path.join(dir, 'target');
    await fs.mkdir(target);
    spawnSync('git', ['init', '-q'], { cwd: target });
    await fs.writeFile(path.join(target, 'tracked.txt'), 'content\n');
    spawnSync('git', ['add', '.'], { cwd: target });
    spawnSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: target });

    const script = fileURLToPath(new URL('../opencode-dispatch.mjs', import.meta.url));
    // Brief at <run-dir>/phase1/brief.txt so briefDir/../worktree stays inside dir.
    const phase1 = path.join(dir, 'phase1');
    await fs.mkdir(phase1);
    // "%" in the brief path: readBrief()/checkCdExists() run BEFORE isolation and don't
    // care about the character, but spawnCli's assertWin32Safe rejects it on every arg,
    // including -f <briefPath> -- so this throws synchronously INSIDE runOpencode's
    // try/catch, AFTER isolation has already succeeded. That ordering is the regression:
    // a hardcoded isolated:false written before isolation was even attempted would pass
    // this test only by accident; only a live read of isolated/worktreePath is correct.
    const brief = path.join(phase1, 'bri%ef.txt');
    await fs.writeFile(brief, 'fixture prompt');
    const args = [script, '--brief', brief, '--cd', target, '--isolate'];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = realGitDir();
    // Unlike every sibling test here, this one runs a REAL `git worktree add` before its forced
    // failure; under concurrent load that alone can take well over 15s, and a timed-out spawnSync
    // reports status:null (a signal kill), not a real assertion failure.
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 1, `signal=${result.signal} ${result.stderr}`);
    assert.match(result.stderr, /unsafe to pass through cmd\.exe/);

    const output = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
    assert.equal(output.status, 'error');
    assertResultSchema(output);
    assert.equal(output.isolated, true, 'isolation genuinely succeeded before the spawn failed; must be reported true');
    assert.ok(output.worktreePath, 'worktreePath must be the real path, not null, once isolation succeeded');
  }
);

test('dispatcher writes a full result.json schema on a codex error path (nonexistent --cd)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch cd-error '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const missingCd = path.join(dir, 'does-not-exist');
  const args = [script, '--brief', brief, '--cd', missingCd, '--sandbox', 'read-only',
    '--model', 'gpt-fixture', '--effort', 'high'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(output.status, 'error');
  assertResultSchema(output);
  assert.equal(output.modelRequested, 'gpt-fixture');
  assert.equal(output.effortRequested, 'high');
  assert.equal(output.isolated, false);
  assert.equal(output.worktreePath, null);
});

test('dispatcher stamps deterministic timing fields on result.json, never leaves them for the model to author', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch timing '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const missingCd = path.join(dir, 'does-not-exist');
  const beforeMs = Date.now();
  const args = [script, '--brief', brief, '--cd', missingCd, '--sandbox', 'read-only'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000 });
  const afterMs = Date.now();
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));

  assert.ok(!Number.isNaN(Date.parse(output.startedAt)), `startedAt must be a valid timestamp, got ${output.startedAt}`);
  assert.ok(!Number.isNaN(Date.parse(output.finishedAt)), `finishedAt must be a valid timestamp, got ${output.finishedAt}`);
  assert.ok(Date.parse(output.startedAt) >= beforeMs, 'startedAt must be at or after process launch');
  assert.ok(Date.parse(output.finishedAt) <= afterMs, 'finishedAt must be at or before process exit observed by the test');
  assert.ok(Date.parse(output.finishedAt) >= Date.parse(output.startedAt), 'finishedAt must not precede startedAt');
  assert.ok(typeof output.durationMs === 'number' && output.durationMs >= 0, `durationMs must be a non-negative number, got ${output.durationMs}`);
  assert.equal(output.timeoutS, 1800, 'no --timeout was passed, so timeoutS must reflect the provisional default actually applied, not null');
  assert.deepEqual(output.usage, { source: 'unavailable' }, 'no codex process ever ran, so no turn.completed event was observed -- usage must report unavailable, never a fabricated value');
});

test('an argument error in any single-command script ends with the error line and never prints the full help', () => {
  const dir = path.dirname(fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url)));
  for (const [script, prefix] of [['codex-dispatch.mjs', 'relay'], ['opencode-dispatch.mjs', 'relay'], ['build-manifest.mjs', 'build-manifest.mjs'], ['preflight.mjs', 'preflight.mjs']]) {
    const r = spawnSync(process.execPath, [path.join(dir, script), '--bogus-flag'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 2, script);
    const lines = r.stderr.trimEnd().split('\n');
    assert.equal(lines.at(-1), `${prefix}: unrecognized argument: --bogus-flag`, script);
    assert.equal(lines.at(-2), 'Run with --help for every option.', script);
    assert.ok(lines.length <= 3, `${script}: ${lines.length} lines on stderr`);
  }
});
