import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RESULT_REQUIRED_KEYS, DEFAULT_MAX_WAIT_S } from '../codex-dispatch.mjs';

// codex-dispatch lists the MCP servers first ("codex mcp list --json"); each fake answers that with no server.
const MCP_LIST = "if (process.argv.includes('mcp')) { process.stdout.write('[]\\n'); process.exit(0); }\n";

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

test('dispatcher passes selected model and effort to a fake CLI on fresh and resumed runs [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch test '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, MCP_LIST + `let input = '';
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
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60000 });
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

test('codex-dispatch turns every enabled MCP server off for the seat, and starts nothing when the server list cannot be read [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex mcp off '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  const started = path.join(dir, 'exec-started');
  await fs.writeFile(fake, `import { existsSync, writeFileSync } from 'node:fs';
if (process.argv.includes('mcp')) {
  if (existsSync(${JSON.stringify(path.join(dir, 'list-fails'))})) { process.stderr.write('mcp list broken\\n'); process.exit(3); }
  // Listed under the seat's own overrides, so a plugin's server (already off) is never named.
  if (!process.argv.includes('features.plugins=false')) { process.stderr.write('listed without the seat overrides\\n'); process.exit(4); }
  process.stdout.write(JSON.stringify([{ name: 'node_repl', enabled: true }, { name: 'open-brain', enabled: true }, { name: 'code-review', enabled: false }]));
  process.exit(0);
}
writeFileSync(${JSON.stringify(started)}, 'x');
let input = '';
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:'thread.started', thread_id:'mcp-thread'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:JSON.stringify({argv:process.argv.slice(2)})}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  const run = async (name) => {
    const folder = path.join(dir, name);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'brief.txt'), 'brief');
    const r = spawnSync(process.execPath, [script, '--brief', path.join(folder, 'brief.txt'), '--cd', dir, '--sandbox', 'read-only', '--model', 'gpt-fixture'], { env, encoding: 'utf8', timeout: 30000 });
    return { r, record: JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8')) };
  };
  const ok = await run('ok');
  assert.equal(ok.r.status, 0, ok.r.stderr);
  const argv = JSON.parse(ok.record.finalMessage).argv;
  const overrides = argv.flatMap((a, i) => (a === '-c' ? [argv[i + 1]] : []));
  assert.ok(overrides.includes('mcp_servers.node_repl.enabled=false') && overrides.includes('mcp_servers.open-brain.enabled=false'), overrides.join(' '));
  assert.ok(!overrides.some((o) => o.includes('code-review')), 'a server that is already off is left alone');
  assert.ok(ok.record.configOverrides.includes('mcp_servers.node_repl.enabled=false'), 'result.json records what was passed');
  await fs.rm(started, { force: true });
  await fs.writeFile(path.join(dir, 'list-fails'), '');
  const refused = await run('refused');
  assert.equal(refused.r.status, 1, refused.r.stderr);
  assert.equal(refused.record.status, 'error');
  // The refusal names the fix a review-run user can make (review-run cannot pass the dispatcher's --keep-user-extensions).
  assert.match(refused.record.error, /codex mcp list --json" exited 3[^]*nothing was started \(update the Codex CLI until "codex mcp list --json" works\)/);
  assert.doesNotMatch(refused.record.error, /--keep-user-extensions/);
  await assert.rejects(fs.access(started), 'no seat was started');
});

test('codex-dispatch: a "codex mcp list" that never answers is stopped after the probe time limit, its process is killed, and no seat starts [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex mcp hang '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  const pidFile = path.join(dir, 'hang.pid');
  const started = path.join(dir, 'exec-started');
  await fs.writeFile(fake, `import { writeFileSync } from 'node:fs';
if (process.argv.includes('mcp')) { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); }
else { writeFileSync(${JSON.stringify(started)}, 'x'); }
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  env.REVIEW_PROBE_TIMEOUT_MS = '2000';
  await fs.writeFile(path.join(dir, 'brief.txt'), 'brief');
  const r = spawnSync(process.execPath, [script, '--brief', path.join(dir, 'brief.txt'), '--cd', dir, '--sandbox', 'read-only', '--model', 'gpt-fixture'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1, r.stderr);
  const record = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.match(record.error, /did not finish in 2 s; it was stopped[^]*nothing was started/);
  await assert.rejects(fs.access(started), 'no seat was started');
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  let alive = true;
  // The dispatcher waits for taskkill before it exits (taskkill dies with it); 15 s covers a kill still settling.
  for (let i = 0; i < 60 && alive; i += 1) {
    try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 250)); } catch { alive = false; }
  }
  if (alive) process.kill(pid);
  assert.equal(alive, false, 'the hung probe process is gone, not left running');
});

for (const dispatcher of ['codex']) {
  test(`${dispatcher}-dispatch reports files a reviewer wrote into a non-git --cd via the content-hash inventory, instead of touchedFiles null`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${dispatcher} nongit touched `));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    const target = path.join(dir, 'target');
    const phase1 = path.join(dir, 'phase1');
    await Promise.all([fs.mkdir(bin), fs.mkdir(target), fs.mkdir(phase1)]);
    await fs.writeFile(path.join(target, 'article.md'), 'original\n');
    const events = `console.log(JSON.stringify({type:'thread.started', thread_id:'t1'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'done'}}));`;
    const fake = path.join(bin, 'fake.mjs');
    await fs.writeFile(fake, MCP_LIST + `import { writeFileSync } from 'node:fs';
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
    const result = spawnSync(process.execPath, [script, '--brief', brief, '--cd', target], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
    assert.equal(output.status, 'completed');
    assert.deepEqual(output.touchedFiles, ['article.md', 'scratch.txt']);
    assert.ok(!('touchedFilesNote' in output), 'a successful inventory diff needs no note');
    assert.equal(await fs.access(path.join(phase1, 'result.stderr.live.log')).then(() => true, () => false), false, 'a finished run leaves no live stderr log, even when stderr was empty');
    assertResultSchema(output);
  });
}

test('codex-dispatch writes usage_delta: the fresh call\'s own usage, then only the resumed call\'s share when --previous-result is passed [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch delta '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Cumulative like the real CLI: the resumed turn reports the thread's running total.
  await fs.writeFile(fake, MCP_LIST + `let input = '';
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
  let r = spawnSync(process.execPath, [script, '--brief', path.join(phase1, 'brief.txt'), '--cd', dir], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const first = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
  assert.equal(first.usage_delta.source, 'fresh-thread');
  assert.equal(first.usage_delta.input_tokens, 1821943);
  // A result.json re-saved by PowerShell Set-Content -Encoding utf8 starts with a BOM.
  await fs.writeFile(path.join(phase1, 'result.json'), '\uFEFF' + JSON.stringify(first), 'utf8');
  r = spawnSync(process.execPath, [script, '--brief', path.join(phase2, 'brief.txt'), '--cd', dir, '--session', 'delta-thread',
    '--previous-result', path.join(phase1, 'result.json')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const second = JSON.parse(await fs.readFile(path.join(phase2, 'result.json'), 'utf8'));
  assert.equal(second.usage.input_tokens, 3196564, 'usage stays the cumulative number codex reported');
  assert.equal(second.usage_delta.source, 'delta-from-previous-result');
  assert.equal(second.usage_delta.input_tokens, 1374621);
  assert.equal(second.usage_delta.output_tokens, 6000);
  // A redaction resume in the same folder: --previous-result is the result.json the retry renames.
  r = spawnSync(process.execPath, [script, '--brief', path.join(phase2, 'brief.txt'), '--cd', dir, '--session', 'delta-thread',
    '--previous-result', path.join(phase2, 'result.json')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const third = JSON.parse(await fs.readFile(path.join(phase2, 'result.json'), 'utf8'));
  assert.equal(third.usage_delta.source, 'delta-from-previous-result', 'the previous result is read before it is renamed');
  assert.ok((await fs.readdir(phase2)).includes('result.attempt-1.json'));
});

test('codex-dispatch puts codex\'s own turn.failed error first in result.error (MCP connector stderr noise left out) and a retry keeps the failed result as result.attempt-1.json [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch codex error '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Shape copied from a real failing codex exec --json run.
  await fs.writeFile(fake, MCP_LIST + `let input = '';
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
  const dispatch = () => spawnSync(process.execPath, [script, '--brief', path.join(phase1, 'brief.txt'), '--cd', dir], { env, encoding: 'utf8', timeout: 60000 });
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
  assert.equal(await fs.access(path.join(phase1, 'result.stderr.live.log')).then(() => true, () => false), false, 'the live log is removed once the full stderr log is written');
  r = dispatch();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /kept the earlier result\.json as result\.attempt-1\.json/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(phase1, 'result.attempt-1.json'), 'utf8')).startedAt, first.startedAt);
  dispatch();
  const names = await fs.readdir(phase1);
  assert.ok(names.includes('result.attempt-2.json'), 'a third try keeps both earlier results');
  assert.ok(names.includes('result.attempt-1.stderr.log') && names.includes('result.attempt-2.stderr.log'), 'each attempt keeps its own stderr log');
});

test('codex-dispatch --web records every web_search item (every query of a batched call, action, result URLs) in result.webCalls; without --web there is no webCalls field [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch web '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Event shapes copied from a real codex 0.156 --search run.
  await fs.writeFile(fake, MCP_LIST + `let input = '';
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
    const r = spawnSync(process.execPath, [script, '--brief', path.join(folder, 'brief.txt'), '--cd', dir, ...(web ? ['--web'] : [])], { env, encoding: 'utf8', timeout: 60000 });
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

test('codex-dispatch writes result.json with status "running" and the threadId as soon as codex names its thread, so a dispatcher killed from outside leaves a resumable id; the next dispatch keeps it as result.attempt-1.json [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch running '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, MCP_LIST + `let input = '';
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
  const r = spawnSync(process.execPath, [script, '--brief', brief, '--cd', dir], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(await fs.readFile(resultPath, 'utf8')).status, 'completed');
  const kept = JSON.parse(await fs.readFile(path.join(folder, 'result.attempt-1.json'), 'utf8'));
  assert.equal(kept.status, 'running');
  assert.equal(kept.threadId, 't-killed', 'the interrupted thread id survives the retry');
});

test('codex-dispatch --detach returns at once with a running record, the worker finishes the dispatch on its own, and --wait reports the final status [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch detach '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, MCP_LIST + `let input = '';
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
  const w = spawnSync(process.execPath, [script, '--wait', path.join(folder, 'result.json'), '--max-wait', '150'], { env, encoding: 'utf8', timeout: 180000 });
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /finished with status "completed", threadId t-detach/);
  const final = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
  assert.equal(final.status, 'completed');
  assert.equal(final.finalMessage, 'detached done');
  assert.equal(typeof final.workerPid, 'number');
  assert.equal(await fs.readFile(out, 'utf8'), 'detached done');
  assert.match(await fs.readFile(path.join(folder, 'dispatch-worker.log'), 'utf8'), /relay: done/);
  assert.ok(Date.now() - started < 170000);
});

test('codex-dispatch --wait: a worker gone while result.json says running exits 1 and names the thread to resume; --max-wait exits 3; bad arguments exit 2 [slow]', async (t) => {
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

test('codex-dispatch --wait-retry: exits 0 with the thread to resume once retryAfter has passed, 3 when --max-wait passes first, 2 for another status, a non-clock retryAfter or a bad argument [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch retry '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const resultPath = path.join(dir, 'result.json');
  const clock = (d) => `${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  const write = (rec) => fs.writeFile(resultPath, JSON.stringify({ status: 'rate-limited', threadId: 't-limit', ...rec }));
  const run = (...extra) => spawnSync(process.execPath, [script, '--wait-retry', resultPath, ...extra], { encoding: 'utf8', timeout: 30000 });
  const now = new Date();
  // finishedAt anchors the clock time to the day the record was written, so this holds across midnight too.
  await write({ retryAfter: clock(new Date(now.getTime() - 60000)), finishedAt: new Date(now.getTime() - 90000).toISOString() });
  const past = run();
  assert.equal(past.status, 0, past.stderr);
  assert.match(past.stdout, /usage limit ended at .*; resume thread t-limit with --session, or start a new dispatch/);
  await write({ retryAfter: clock(new Date(now.getTime() + 2 * 3600 * 1000)), finishedAt: now.toISOString() });
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

test('codex-dispatch refuses, before starting anything, to overwrite an existing --final-message-out file unless --replace-completed; a completed result.json in the folder does not stop a resume [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch done '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const marker = path.join(dir, 'codex-started');
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, MCP_LIST + 'import { writeFileSync } from "node:fs";\nwriteFileSync(' + JSON.stringify(marker) + ', "x");\nprocess.exit(1);\n');
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
  const run = (...extra) => spawnSync(process.execPath, [script, '--brief', path.join(folder, 'brief.txt'), '--cd', dir, '--session', 't-done', ...extra], { env, encoding: 'utf8', timeout: 60000 });
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
  const r = run('--final-message-out', findings);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--final-message-out .*B-findings\.md already exists/);
  assert.match(r.stderr, /\(16 bytes\)/, 'the refusal names the file size');
  await fs.writeFile(findings, '');
  assert.match(run('--final-message-out', findings).stderr, /it is empty \(0 bytes\), so that answer failed/);
});

test('codex-dispatch: a run that exits 0 with an empty last message is status "error" and writes no --final-message-out file [slow]', async (t) => {
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
  };
  for (const [name, body] of Object.entries(fakes)) {
    const fake = path.join(bin, `${name}-fake.mjs`);
    await fs.writeFile(fake, MCP_LIST + body);
    const shim = path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
    await fs.writeFile(shim, process.platform === 'win32'
      ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
      : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  for (const [name, extra, pattern] of [
    ['codex', [], /codex exec exited 0 but its last agent_message was empty/],
  ]) {
    const folder = path.join(dir, name);
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'brief.txt'), 'go');
    const out = path.join(dir, `${name}-findings.md`);
    const script = fileURLToPath(new URL(`../${name}-dispatch.mjs`, import.meta.url));
    const r = spawnSync(process.execPath, [script, '--brief', path.join(folder, 'brief.txt'), '--cd', target, '--final-message-out', out, ...extra], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 1, r.stderr);
    const result = JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8'));
    assert.equal(result.status, 'error');
    assert.match(result.error, pattern);
    await assert.rejects(fs.access(out), `${name}: no empty answer file is written`);
  }
});

test('codex-dispatch: a Codex usage limit is status "rate-limited" with retryAfter and the threadId kept for a resume; another failure stays "error" [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch limit '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  // Message text copied from a real codex 0.156 run that hit the account limit.
  await fs.writeFile(fake, MCP_LIST + `let input = '';
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
    const r = spawnSync(process.execPath, [script, '--brief', path.join(folder, 'brief.txt'), '--cd', dir], { env, encoding: 'utf8', timeout: 60000 });
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

test('codex-dispatch --final-message-out writes the exact final message as UTF-8 without BOM, and a failed run leaves the earlier file untouched [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch final out '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, MCP_LIST + `let input = '';
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
  const dispatch = (...extra) => spawnSync(process.execPath, [script, '--brief', brief, '--cd', dir, '--final-message-out', out, ...extra], { env, encoding: 'utf8', timeout: 60000 });
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

test('dispatcher parses a real turn.completed.usage event into result.json\'s usage field with source "provider"', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch usage '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, MCP_LIST + `let input = '';
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
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60000 });
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

test('dispatcher kills a hung codex process on --timeout and writes status timed-out [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch timeout '));
  // The killed child can hold the folder for a moment on Windows (EBUSY); retry the cleanup.
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  const pidFile = path.join(dir, 'fake.pid');
  // Emits thread.started, then never closes stdout/exits on its own -- the
  // dispatcher's --timeout is the only thing that ends this process. Writes
  // its own pid so the test can confirm the REAL node process behind the
  // .cmd shim died, not just cmd.exe (see codex.cmd wrapping the shim).
  await fs.writeFile(fake, MCP_LIST + `import { writeFileSync } from 'node:fs';
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
  // 15 s, not 2: under release-check's full parallel load the fake took over 2 s to start and write its pid.
  const args = [script, '--brief', brief, '--cd', dir, '--sandbox', 'read-only', '--timeout', '15'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(output.status, 'timed-out');
  assert.match(output.error, /timeout 15s/);
  assertResultSchema(output);

  const fakePid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.throws(
    () => process.kill(fakePid, 0),
    'the real node process behind the .cmd shim must be dead, not just cmd.exe'
  );
});

test('codex-dispatch stops a codex still running after its final answer and keeps the answer; a turn with no answer is not stopped early [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch answered '));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  const fake = path.join(bin, 'fake.mjs');
  const pidFile = path.join(dir, 'fake.pid');
  await fs.writeFile(fake, MCP_LIST + `import { writeFileSync } from 'node:fs';
let input = ''; for await (const c of process.stdin) input += c;
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log(JSON.stringify({type:'thread.started', thread_id:'answered-thread'}));
if (!input.includes('silent')) console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'the answer'}}));
console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
if (input.includes('orphan')) {
  const { spawn } = await import('node:child_process');
  const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
  kid.unref();
  process.exit(0);
}
if (input.includes('held')) {
  const { spawn } = await import('node:child_process');
  const body = "const { spawn } = require('node:child_process'); const o = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, windowsHide: true, cwd: require('node:os').tmpdir(), stdio: ['ignore', 'inherit', 'inherit'] }); require('node:fs').writeFileSync(" + JSON.stringify(${JSON.stringify(pidFile + '.held')}) + ", String(o.pid)); o.unref();";
  const launcher = spawn(process.execPath, ['-e', body], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((resolve) => launcher.on('exit', resolve));
}
setInterval(() => {}, 1000);
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin;
  env.REVIEW_ANSWER_GRACE_MS = '1000';
  // Without a job object, the path a sandbox that refuses one (and POSIX) takes: an orphan holding the output is only warned about.
  env.REVIEW_SEAT_JOB = 'off';
  const run = async (name, prompt, timeout) => {
    const folder = path.join(dir, name);
    await fs.mkdir(folder);
    const brief = path.join(folder, 'brief.txt');
    await fs.writeFile(brief, prompt);
    const r = spawnSync(process.execPath, [script, '--brief', brief, '--cd', dir, '--sandbox', 'read-only', '--timeout', timeout, '--final-message-out', path.join(folder, 'answer.md')], { env, encoding: 'utf8', timeout: 60000 });
    const fakePid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    let alive = true;
    try { process.kill(fakePid, 0); } catch { alive = false; }
    if (alive) process.kill(fakePid);
    return { r, folder, alive, output: JSON.parse(await fs.readFile(path.join(folder, 'result.json'), 'utf8')) };
  };
  // --timeout is only a backstop: without the stop the run ends timed-out, not completed.
  const done = await run('answered', 'fixture prompt', '20');
  assert.equal(done.r.status, 0, done.r.stderr);
  assert.match(done.r.stderr, /still running 1 s after its final answer; it was stopped and the answer kept/);
  assert.equal(done.output.status, 'completed');
  assert.equal(done.output.stoppedAfterAnswer, true);
  assertResultSchema(done.output);
  assert.equal(await fs.readFile(path.join(done.folder, 'answer.md'), 'utf8'), 'the answer');
  assert.equal(done.alive, false, 'the real node process behind the shim was stopped');
  assert.equal(done.output.stopIncomplete, undefined);
  // Closing round 1 F3: stopped after its answer while a process outside its tree still holds the output.
  try {
    const held = await run('held', 'held prompt', '40');
    assert.equal(held.r.status, 0, held.r.stderr);
    assert.match(held.r.stderr, /still running 1 s after its final answer; it was stopped and the answer kept/);
    assert.equal(held.output.status, 'completed');
    assert.equal(held.output.stopIncomplete, true);
  } finally {
    try { process.kill(Number(await fs.readFile(`${pidFile}.held`, 'utf8'))); } catch { /* already gone */ }
  }
  // A process that left the tree and holds the output open cannot be stopped: the run says so instead of a clean stop.
  const leaky = await run('orphan', 'orphan prompt', '30');
  assert.equal(leaky.r.status, 0, leaky.r.stderr);
  // Linux round: codex had exited, so nothing is killed and the text does not say it was stopped.
  assert.match(leaky.r.stderr, /codex exec exited after its final answer, but its output was still open 1 s later: a process it started may still be running/);
  assert.doesNotMatch(leaky.r.stderr, /was still running/);
  assert.equal(leaky.output.status, 'completed');
  assert.equal(leaky.output.stopIncomplete, true);
  // Closing round 4: no answer and an exit with the output held open ends as an error soon, with --timeout 0.
  const noAnswer = await run('orphan-silent', 'orphan silent prompt', '0');
  assert.equal(noAnswer.r.status, 1, noAnswer.r.stderr);
  assert.match(noAnswer.r.stderr, /codex exec exited without an answer, but its output stayed open/);
  assert.notEqual(noAnswer.output.status, 'completed');
  assert.equal(noAnswer.output.stopIncomplete, true);
  // Closing round 5: the same when a finite --timeout falls due inside that wait: not a timeout, still warned.
  // 4 s: due inside the 5 s exit wait, with room for a slow fake start on a loaded host.
  const noAnswerTimed = await run('orphan-silent-timed', 'orphan silent prompt', '4');
  assert.equal(noAnswerTimed.r.status, 1, noAnswerTimed.r.stderr);
  assert.match(noAnswerTimed.r.stderr, /codex exec exited without an answer, but its output stayed open/);
  assert.notEqual(noAnswerTimed.output.status, 'timed-out');
  assert.notEqual(noAnswerTimed.output.status, 'completed');
  assert.equal(noAnswerTimed.output.stopIncomplete, true);
  // Closing round 3: a timeout due before the grace ends, on a codex that already exited, ends as answered, nothing killed.
  env.REVIEW_ANSWER_GRACE_MS = '20000';
  const early = await run('orphan-early', 'orphan prompt', '6');
  env.REVIEW_ANSWER_GRACE_MS = '1000';
  assert.equal(early.r.status, 0, early.r.stderr);
  assert.match(early.r.stderr, /codex exec exited after its final answer, but its output was still open/);
  assert.equal(early.output.status, 'completed');
  const silent = await run('silent', 'silent prompt', '4');
  assert.equal(silent.r.status, 1, silent.r.stderr);
  assert.equal(silent.output.status, 'timed-out');
  assert.equal(silent.output.stoppedAfterAnswer, undefined);
});

test('dispatcher writes a full result.json schema on a codex error path (nonexistent --cd)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch cd-error '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const brief = path.join(dir, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const missingCd = path.join(dir, 'does-not-exist');
  const args = [script, '--brief', brief, '--cd', missingCd, '--sandbox', 'read-only',
    '--model', 'gpt-fixture', '--effort', 'high'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000 });
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
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000 });
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
  for (const [script, prefix] of [['codex-dispatch.mjs', 'relay'], ['preflight.mjs', 'preflight.mjs']]) {
    const r = spawnSync(process.execPath, [path.join(dir, script), '--bogus-flag'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 2, script);
    const lines = r.stderr.trimEnd().split('\n');
    assert.equal(lines.at(-1), `${prefix}: unrecognized argument: --bogus-flag`, script);
    assert.equal(lines.at(-2), 'Run with --help for every option.', script);
    assert.ok(lines.length <= 3, `${script}: ${lines.length} lines on stderr`);
  }
  // The manifest step is a review-run command: its argument error is its one line.
  const manifest = spawnSync(process.execPath, [path.join(dir, 'review-run.mjs'), 'manifest', '--bogus-flag'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(manifest.status, 2);
  assert.equal(manifest.stderr, 'build-manifest: unrecognized argument: --bogus-flag\n');
});

test('codex-dispatch reports writes to a file that was already dirty, inside an untracked folder and under an ignored folder in a git --cd [slow]', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex git touched '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const target = path.join(dir, 'target');
  const phase1 = path.join(dir, 'phase1');
  await Promise.all([fs.mkdir(bin), fs.mkdir(target), fs.mkdir(phase1)]);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: target, stdio: 'ignore' });
  await fs.writeFile(path.join(target, 'a.txt'), 'one\n');
  await fs.writeFile(path.join(target, '.gitignore'), 'build/\n');
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  // State before the reviewer runs: a tracked file already modified, an untracked folder, an ignored folder.
  await fs.writeFile(path.join(target, 'a.txt'), 'two\n');
  await fs.mkdir(path.join(target, 'u'));
  await fs.writeFile(path.join(target, 'u', 'old.txt'), 'old\n');
  await fs.mkdir(path.join(target, 'build'));
  await fs.writeFile(path.join(target, 'build', 'o.txt'), 'o\n');
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, MCP_LIST + `import { writeFileSync } from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
writeFileSync(${JSON.stringify(path.join(target, 'a.txt'))}, 'three\\n');
writeFileSync(${JSON.stringify(path.join(target, 'u', 'new.txt'))}, 'new\\n');
writeFileSync(${JSON.stringify(path.join(target, 'build', 'new.txt'))}, 'new\\n');
console.log(JSON.stringify({type:'thread.started', thread_id:'t1'}));
console.log(JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'done'}}));
`);
  const shim = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await fs.writeFile(shim, process.platform === 'win32'
    ? '@echo off\r\n"' + process.execPath + '" "' + fake + '" %*\r\n'
    : '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const brief = path.join(phase1, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir();
  const result = spawnSync(process.execPath, [script, '--brief', brief, '--cd', target], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(await fs.readFile(path.join(phase1, 'result.json'), 'utf8'));
  assert.deepEqual(output.touchedFiles, ['a.txt', 'build/new.txt', 'u/new.txt']);
});

test('codex-dispatch --detach: a worker killed with SIGKILL leaves no running codex behind once --wait has run [slow]', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex orphan '));
  const bin = path.join(dir, 'bin');
  const target = path.join(dir, 'target');
  const phase1 = path.join(dir, 'phase1');
  await Promise.all([fs.mkdir(bin), fs.mkdir(target), fs.mkdir(phase1)]);
  const pidFile = path.join(dir, 'pid');
  const fake = path.join(bin, 'fake.mjs');
  await fs.writeFile(fake, MCP_LIST + `import { writeFileSync } from 'node:fs';
console.log(JSON.stringify({type:'thread.started', thread_id:'t-orphan'}));
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`);
  await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexec "' + process.execPath + '" "' + fake + '" "$@"\n', { mode: 0o755 });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let child = null;
  t.after(async () => {
    if (child) { try { process.kill(-child, 'SIGKILL'); } catch { /* gone */ } }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const brief = path.join(phase1, 'brief.txt');
  await fs.writeFile(brief, 'fixture prompt');
  const script = fileURLToPath(new URL('../codex-dispatch.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.PATH = bin + path.delimiter + realGitDir() + path.delimiter + '/bin' + path.delimiter + '/usr/bin';
  const started = spawnSync(process.execPath, [script, '--brief', brief, '--cd', target, '--detach'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(started.status, 0, started.stderr);
  for (let i = 0; i < 100 && !child; i++) {
    child = await fs.readFile(pidFile, 'utf8').then(Number, () => null);
    if (!child) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(child, 'the fake codex never started');
  const result = path.join(phase1, 'result.json');
  let running;
  for (let i = 0; i < 50 && (!running?.childPid || !running?.threadId); i++) {
    running = JSON.parse(await fs.readFile(result, 'utf8'));
    if (!running.childPid || !running.threadId) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(running.childPid, child, 'the running record names the codex child');
  assert.equal(running.threadId, 't-orphan', 'and still carries the thread it started');
  process.kill(running.workerPid, 'SIGKILL');
  for (let i = 0; i < 50 && alive(running.workerPid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(alive(child), 'precondition: killing the worker alone leaves codex running');
  const waited = spawnSync(process.execPath, [script, '--wait', result, '--max-wait', '10'], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(waited.status, 1);
  assert.match(waited.stdout, /has been stopped/);
  assert.match(waited.stdout, /resume thread t-orphan with --session/);
  for (let i = 0; i < 50 && alive(child); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(child), 'codex is gone');
});
