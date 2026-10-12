import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseRollout, rolloutUsage, readRolloutUsage, findOrchestratorRollout, findChildThreads, findThreadRollout, rolloutModel, rolloutCommands } from '../rollout-utils.mjs';

const fixture = new URL('./fixtures/rollout/orchestrator.jsonl', import.meta.url);
const emptyFixture = new URL('./fixtures/rollout/no-usage.jsonl', import.meta.url);
const time = seconds => '2026-10-04T12:00:' + String(seconds).padStart(2,'0') + 'Z';

test('parseRollout uses the final total, ignores last usage and tolerates a partial final line', async () => {
  const parsed = parseRollout(await fs.readFile(fixture,'utf8'));
  assert.equal(parsed.meta.id,'fixture-thread');
  assert.equal(parsed.tokenEvents.length,5);
  assert.deepEqual(parsed.usage,{
    input_tokens:300,cached_input_tokens:100,cache_write_input_tokens:0,
    output_tokens:50,reasoning_output_tokens:15,total_tokens:350,
  });
  const usage = await readRolloutUsage(fixture);
  assert.equal(usage.source,'codex-rollout');
  assert.equal(usage.input_tokens,300);
  assert.equal(usage.reasoning_tokens,15);
  assert.equal(usage.estimated_cost_usd,null);
});

test('window usage subtracts the last total at or before each inclusive boundary', async () => {
  const usage = await readRolloutUsage(fixture,{start:time(10),end:time(30)});
  assert.deepEqual(usage,{
    input_tokens:60,cached_input_tokens:20,cache_write_input_tokens:0,
    output_tokens:15,reasoning_tokens:4,total_tokens:75,estimated_cost_usd:null,source:'codex-rollout',
    raw:{input_tokens:60,cached_input_tokens:20,cache_write_input_tokens:0,output_tokens:15,reasoning_output_tokens:4,total_tokens:75},
  });
  const between = await readRolloutUsage(fixture,{start:time(15),end:time(35)});
  assert.deepEqual(between,usage);
});

test('repeated token_count events never double count, including a window with no new usage', async () => {
  const text = await fs.readFile(fixture,'utf8');
  const noNew = rolloutUsage(text,{start:time(10),end:time(20)});
  assert.equal(noNew.input_tokens,0);
  assert.equal(noNew.total_tokens,0);
  assert.equal(noNew.source,'codex-rollout');
  assert.deepEqual(rolloutUsage(text,{start:time(10),end:time(10)}),noNew);
  const line = text.split('\n')[5];
  const repeated = text.split('\n').slice(0,6).concat([line,line]).join('\n');
  assert.equal(rolloutUsage(repeated).input_tokens,160);
});

test('a window starting before the session uses a known zero baseline at session creation', async () => {
  const usage = await readRolloutUsage(fixture,{start:'2026-10-04T11:59:00Z',end:time(30)});
  assert.equal(usage.input_tokens,160);
  assert.equal(usage.output_tokens,25);
  assert.equal(usage.source,'codex-rollout');
});

test('missing token events or window baselines are unavailable with a reason', async () => {
  const text = await fs.readFile(fixture,'utf8');
  for (const usage of [
    await readRolloutUsage(emptyFixture),
    rolloutUsage(text,{start:time(1),end:time(30)}),
    rolloutUsage(text,{start:'2026-10-04T11:00:00Z',end:'2026-10-04T11:30:00Z'}),
  ]) {
    assert.equal(usage.source,'unavailable');
    assert.equal(typeof usage.reason,'string');
    assert.equal(usage.input_tokens,undefined);
  }
});

test('window validation rejects incomplete, invalid and reversed boundaries', async () => {
  const text = await fs.readFile(fixture,'utf8');
  for (const window of [{start:time(10)},{end:time(10)},{start:'bad',end:time(20)},{start:time(30),end:time(10)}]) {
    assert.throws(()=>rolloutUsage(text,window),/rollout window/);
  }
  assert.deepEqual(
    rolloutUsage(text,{start:Date.parse(time(10)),end:Date.parse(time(30))}),
    rolloutUsage(text,{start:time(10),end:time(30)}),
  );
});

test('missing token fields stay null and timestamp order selects window boundaries', () => {
  const meta = JSON.stringify({type:'session_meta',timestamp:time(0),payload:{id:'fixture'}});
  const token = (seconds,input) => JSON.stringify({type:'event_msg',timestamp:time(seconds),payload:{type:'token_count',info:{total_token_usage:{input_tokens:input}}}});
  const text = [meta,token(30,90),token(10,40),token(20,60)].join('\n');
  const usage = rolloutUsage(text,{start:time(10),end:time(30)});
  assert.equal(usage.input_tokens,50);
  assert.equal(usage.output_tokens,null);
  assert.equal(usage.reasoning_tokens,null);
  assert.equal(parseRollout(text).usage.input_tokens,60);
});

test('only token_count event_msg totals are usage, never last_token_usage or another event type', () => {
  const text = [
    JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:100}}}}),
    JSON.stringify({type:'other',payload:{type:'token_count',info:{total_token_usage:{input_tokens:999}}}}),
    JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:null}}}),
  ].join('\n');
  assert.equal(parseRollout(text).usage,null);
});

test('findOrchestratorRollout verifies filename suffix and first-line session_meta.id from CODEX_THREAD_ID', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'rollout lookup '));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const day = path.join(dir,'2026','10','04');
  await fs.mkdir(day,{recursive:true});
  const text = await fs.readFile(fixture,'utf8');
  await fs.writeFile(path.join(day,'rollout-2026-10-04T01-00-00-fixture-thread.jsonl'),text.replace('"fixture-thread"','"wrong-thread"'));
  await fs.writeFile(path.join(day,'rollout-2026-10-04T02-00-00-fixture-thread.jsonl'),text.replace('"session_meta"','"event_msg"'));
  await fs.writeFile(path.join(day,'rollout-2026-10-04T03-00-00-fixture-thread-extra.jsonl'),text);
  const correct = path.join(day,'rollout-2026-10-04T07-00-00-fixture-thread.jsonl');
  await fs.writeFile(correct,text);
  const env = {CODEX_THREAD_ID:'fixture-thread',CODEX_SESSION_ID:'wrong-session'};
  assert.equal(await findOrchestratorRollout({env,sessionsDir:dir}),correct);
  const usage = await readRolloutUsage(await findOrchestratorRollout({env,sessionsDir:dir}),{start:time(10),end:time(30)});
  assert.equal(usage.input_tokens,60);
});

test('findOrchestratorRollout honors CODEX_HOME and returns null for missing id or sessions', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'rollout home '));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const day = path.join(home,'sessions','2025','01','02');
  await fs.mkdir(day,{recursive:true});
  const correct = path.join(day,'rollout-2025-01-02T00-00-00-fixture-thread.jsonl');
  await fs.writeFile(correct,await fs.readFile(fixture,'utf8'));
  assert.equal(await findOrchestratorRollout({env:{CODEX_HOME:home,CODEX_THREAD_ID:'fixture-thread'}}),correct);
  assert.equal(await findOrchestratorRollout({env:{CODEX_HOME:home}}),null);
  assert.equal(await findOrchestratorRollout({env:{CODEX_THREAD_ID:'unknown'},sessionsDir:path.join(home,'missing')}),null);
  assert.equal(await findOrchestratorRollout({env:{CODEX_THREAD_ID:'wrong-thread'},sessionsDir:path.join(home,'sessions')}),null);
});

test('descendant scan preserves its final cumulative total when an event is repeated', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'rollout children '));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const now = new Date();
  const day = path.join(dir,String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
  await fs.mkdir(day,{recursive:true});
  const text = await fs.readFile(fixture,'utf8');
  const lines = text.split('\n');
  lines[0] = JSON.stringify({type:'session_meta',payload:{id:'child',source:{subagent:{thread_spawn:{parent_thread_id:'parent',depth:1,agent_path:'/root/child'}}}}});
  await fs.writeFile(path.join(day,'rollout-child.jsonl'),lines.join('\n'));
  const children = await findChildThreads('parent',Date.now()-60000,dir);
  assert.equal(children.length,1);
  assert.equal(children[0].usage.input_tokens,300);
  assert.equal(children[0].usage.total_tokens,350);
});

test('rolloutModel takes the last turn_context model and is null without one', () => {
  const line = (o) => JSON.stringify(o);
  const text = [line({ type: 'session_meta', payload: { id: 't' } }), line({ type: 'turn_context', payload: { model: 'gpt-5.6-terra' } }),
    line({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }), '{"type":"turn_context","payload":{"model":'].join('\n');
  assert.equal(rolloutModel(text), 'gpt-5.6-sol');
  assert.equal(rolloutModel(line({ type: 'session_meta', payload: { id: 't', model: 'x' } })), null);
  assert.equal(rolloutModel(line({ type: 'turn_context', payload: {} })), null);
});

test('findThreadRollout matches the file suffix and session_meta.id, and returns null for an unknown thread', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rollout-thread-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const day = path.join(dir, '2026', '10', '06');
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, 'rollout-2026-10-06T10-00-00-thread-1.jsonl');
  await fs.writeFile(file, JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }) + '\n');
  assert.equal(await findThreadRollout('thread-1', dir), file);
  assert.equal(await findThreadRollout('thread-2', dir), null);
  assert.equal(await findThreadRollout('', dir), null);
});

test('rolloutCommands: real seat rollouts count CommandExecution items; a non-zero exit or a sandbox spawn failure is failed', async () => {
  const fixture = (name) => fs.readFile(new URL(`fixtures/commands/${name}`, import.meta.url), 'utf8');
  const seat = await fixture('codex-seat-rollout.jsonl');
  assert.deepEqual(rolloutCommands(seat), { tried: 3, failed: 1 }, 'two exit-0 items and the rg item that exited 1');
  assert.deepEqual(rolloutCommands(await fixture('codex-sandbox-rollout.jsonl')), { tried: 2, failed: 2 }, 'both items are spawn failures, exit -1');
  const items = seat.split('\n').filter((l) => l.includes('CommandExecution')).map((l) => Date.parse(JSON.parse(l).timestamp));
  assert.deepEqual(rolloutCommands(seat, { start: items[1], end: null }), { tried: 2, failed: 1 }, 'the window start is inclusive');
  assert.deepEqual(rolloutCommands(seat, { start: null, end: items[1] }), { tried: 1, failed: 0 }, 'the window end is exclusive');
  assert.equal(rolloutCommands(await fixture('codex-child-no-items.jsonl')), null, 'an exec_command call without items is unknown, not 0');
  const firstItem = seat.split('\n').slice(2).join('\n');
  assert.deepEqual(rolloutCommands(String.fromCharCode(0xfeff) + firstItem), rolloutCommands(firstItem), 'a byte-order mark does not hide the first line');
  assert.deepEqual(rolloutCommands(`null\n${seat}`), { tried: 3, failed: 1 }, 'a null line is skipped');
  const meta = seat.split('\n')[0];
  assert.deepEqual(rolloutCommands(`${meta}\n`), { tried: 0, failed: 0 }, 'no command call at all is a true 0');
  assert.deepEqual(rolloutCommands(`${meta}\n{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"text(await tools.web__run({}))"}}\n`), { tried: 0, failed: 0 }, 'a script that only searched the web ran no command');
});
