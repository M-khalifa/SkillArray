import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgentTranscripts, agentState, agentLastReply, agentStats, findSessionTranscripts, transcriptCommands } from '../native-agent.mjs';

const line = (o) => JSON.stringify(o);
const assistant = (stop, content = [{ type: 'text', text: 'x' }]) => line({ type: 'assistant', message: { id: String(Math.random()), stop_reason: stop, content } });
const user = () => line({ type: 'user', message: { role: 'user', content: 'go' } });

async function write(t, name, lines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-agent '));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  await fs.writeFile(file, lines.join('\n') + '\n');
  return file;
}

test('a Claude agent is done after an end_turn reply or a hand-back, running while it works or after a new prompt', async (t) => {
  assert.equal(await agentState(await write(t, 'a.jsonl', [user(), assistant('tool_use', [{ type: 'tool_use', name: 'Read' }])])), 'running');
  assert.equal(await agentState(await write(t, 'b.jsonl', [user(), assistant('tool_use'), user(), assistant('end_turn')])), 'done');
  assert.equal(await agentState(await write(t, 'c.jsonl', [user(), assistant('tool_use', [{ type: 'tool_use', name: 'SubagentHandback' }])])), 'done');
  assert.equal(await agentState(await write(t, 'd.jsonl', [user(), assistant('end_turn'), user()])), 'running', 'a new prompt after the last reply means it is working again');
  assert.equal(await agentState(await write(t, 'e.jsonl', [user(), assistant('end_turn'), user(), assistant('tool_use')])), 'running');
  assert.equal(await agentState(await write(t, 'f.jsonl', [user(), assistant('end_turn'), '{"type":"assistant","message":{"stop'])), 'done', 'a line still being written is ignored');
});

test('the hand-back call is followed by its own tool_result, and a meta reminder may follow: still done; a real prompt after it is running again', async (t) => {
  const handback = assistant('tool_use', [{ type: 'tool_use', name: 'SubagentHandback' }]);
  const toolResult = line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
  const meta = line({ type: 'user', isMeta: true, message: { role: 'user', content: 'a reminder' } });
  const attachment = line({ type: 'attachment', attachment: { type: 'hook' } });
  assert.equal(await agentState(await write(t, 'h1.jsonl', [user(), handback, toolResult])), 'done', 'the hand-back result is not a new prompt');
  assert.equal(await agentState(await write(t, 'h2.jsonl', [user(), handback, toolResult, meta, attachment])), 'done', 'a meta entry and an attachment are not prompts');
  assert.equal(await agentState(await write(t, 'h3.jsonl', [user(), handback, toolResult, user()])), 'running', 'a resume prompt starts a new turn');
  assert.equal(await agentState(await write(t, 'h4.jsonl', [user(), handback, toolResult, user(), assistant('tool_use', [{ type: 'tool_use', name: 'Read' }]), toolResult, handback, toolResult])), 'done', 'a resumed turn that ends with a second hand-back and its result');
  assert.equal(await agentState(await write(t, 'h5.jsonl', [user(), assistant('tool_use', [{ type: 'tool_use', name: 'Read' }]), toolResult])), 'running', 'a tool result after a working turn is still running');
});

test('a Codex rollout is done at task_complete and running after task_started', async (t) => {
  const meta = line({ type: 'session_meta', payload: { id: 't' } });
  const ev = (type) => line({ type: 'event_msg', payload: { type } });
  assert.equal(await agentState(await write(t, 'r1.jsonl', [meta, ev('task_started')])), 'running');
  assert.equal(await agentState(await write(t, 'r2.jsonl', [meta, ev('task_started'), ev('task_complete')])), 'done');
  assert.equal(await agentState(await write(t, 'r3.jsonl', [meta, ev('task_started'), ev('task_complete'), ev('task_started')])), 'running', 'a follow-up task');
  assert.equal(await agentState(await write(t, 'r4.jsonl', [meta])), 'running');
});

test('an unreadable or empty transcript is reported as such, never as done', async (t) => {
  assert.equal(await agentState(path.join(os.tmpdir(), 'no-such-agent-transcript.jsonl')), 'unreadable');
  assert.equal(await agentState(await write(t, 'empty.jsonl', [''])), 'unreadable');
});

test('findAgentTranscripts: an agent id is looked up under the Claude projects folder, a path is returned as given', async (t) => {
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'claude config '));
  t.after(() => fs.rm(config, { recursive: true, force: true }));
  const dir = path.join(config, 'projects', 'proj-one', 'session-one', 'subagents');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'agent-a0123456789abcdef.jsonl'), assistant('end_turn') + '\n');
  const env = { CLAUDE_CONFIG_DIR: config };
  assert.deepEqual(await findAgentTranscripts('a0123456789abcdef', env), [path.join(dir, 'agent-a0123456789abcdef.jsonl')]);
  assert.deepEqual(await findAgentTranscripts('affffffffffffffff', env), []);
  assert.deepEqual(await findAgentTranscripts('C:/somewhere/x.jsonl', env), ['C:/somewhere/x.jsonl']);
});

test('findAgentTranscripts: a Codex thread id is resolved to its rollout under CODEX_HOME/sessions; an unknown thread matches none', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex home '));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const thread = '01a12656-5bc9-7ec3-96e6-6b6e538722d5';
  const day = path.join(home, 'sessions', '2026', '10', '10');
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, `rollout-2026-10-10T15-02-39-${thread}.jsonl`);
  await fs.copyFile(new URL('fixtures/commands/codex-seat-rollout.jsonl', import.meta.url), file);
  const env = { CODEX_HOME: home, CLAUDE_CONFIG_DIR: home };
  assert.deepEqual(await findAgentTranscripts(thread, env), [file]);
  assert.notEqual(await agentStats(file), null);
  assert.deepEqual(await findAgentTranscripts('01a12656-5bc9-7ec3-96e6-000000000000', env), [], 'an unknown thread fails fast instead of being read as a path');
});

test('agentLastReply: the last Claude text or Codex task_complete message as one short line, null when there is none', async (t) => {
  const claude = await write(t, 'c.jsonl', [user(), assistant('end_turn', [{ type: 'text', text: 'first' }]), assistant('end_turn', [{ type: 'text', text: 'blocked:\n  tool   timed out' }])]);
  assert.equal(await agentLastReply(claude), 'blocked: tool timed out');
  const codex = await write(t, 'x.jsonl', [line({ type: 'session_meta', payload: {} }), line({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Blocked: tools time out' } })]);
  assert.equal(await agentLastReply(codex), 'Blocked: tools time out');
  const long = await write(t, 'l.jsonl', [user(), assistant('end_turn', [{ type: 'text', text: 'y'.repeat(300) }])]);
  assert.equal((await agentLastReply(long)).length, 200);
  assert.equal(await agentLastReply(await write(t, 'n.jsonl', [user()])), null);
  assert.equal(await agentLastReply(path.join(os.tmpdir(), 'no-such-transcript.jsonl')), null);
});

test('agentStats counts Claude tool_use items and Codex function calls, and reads the first timestamp', async (t) => {
  const claude = await write(t, 'claude.jsonl', [
    line({ type: 'user', timestamp: '2026-10-08T18:00:00.000Z', message: { role: 'user', content: 'go' } }),
    line({ type: 'assistant', timestamp: '2026-10-08T18:00:05.000Z', message: { id: 'a', stop_reason: 'tool_use', content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: '1', name: 'Bash' }, { type: 'tool_use', id: '2', name: 'Read' }] } }),
    line({ type: 'assistant', timestamp: '2026-10-08T18:00:09.000Z', message: { id: 'b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }),
  ]);
  assert.deepEqual(await agentStats(claude), { calls: 2, startedAtMs: Date.parse('2026-10-08T18:00:00.000Z') });
  const codex = await write(t, 'codex.jsonl', [
    line({ type: 'session_meta', timestamp: '2026-10-08T18:01:00.000Z', payload: {} }),
    line({ type: 'response_item', timestamp: '2026-10-08T18:01:02.000Z', payload: { type: 'function_call' } }),
    line({ type: 'response_item', timestamp: '2026-10-08T18:01:03.000Z', payload: { type: 'message' } }),
  ]);
  assert.deepEqual(await agentStats(codex), { calls: 1, startedAtMs: Date.parse('2026-10-08T18:01:00.000Z') });
  assert.equal(await agentStats(path.join(path.dirname(claude), 'missing.jsonl')), null);
});

test('transcriptCommands: real Claude transcripts count Bash calls; an error result or a missing result is failed', async () => {
  const fixture = (name) => fs.readFile(new URL(`fixtures/commands/${name}`, import.meta.url), 'utf8');
  const agent = await fixture('claude-agent-transcript.jsonl');
  assert.deepEqual(transcriptCommands(agent), { tried: 2, failed: 1 }, 'a native seat: one Bash ok, one "Exit code 1"; the Read call is not a command');
  assert.deepEqual(transcriptCommands(await fixture('claude-cli-session.jsonl')), { tried: 2, failed: 0 }, 'a Claude CLI seat session');
  const rows = agent.trim().split('\n').map((l) => JSON.parse(l));
  const errorAt = Date.parse(rows.findLast((r) => r.type === 'assistant').timestamp);
  assert.deepEqual(transcriptCommands(agent, { start: null, end: errorAt }), { tried: 1, failed: 0 }, 'the window end is exclusive');
  const noResult = rows.filter((r) => !(r.type === 'user' && r.message.content.some((c) => c.is_error === true))).map((r) => JSON.stringify(r)).join('\n');
  assert.deepEqual(transcriptCommands(noResult), { tried: 2, failed: 1 }, 'a call that never got a result did not succeed');
  const lastResult = rows.findLast((r) => r.type === 'user');
  const late = [...rows.filter((r) => r !== lastResult), lastResult].map((r) => JSON.stringify(r)).join('\n');
  assert.deepEqual(transcriptCommands(late, { start: null, end: errorAt + 1 }), { tried: 2, failed: 1 }, 'a result after the window end still belongs to its call');
  const lines = agent.trim().split('\n');
  const okUse = lines.findIndex((l) => l.includes('"name":"Bash"'));
  const firstBash = lines.slice(okUse).join('\n');
  assert.deepEqual(transcriptCommands(String.fromCharCode(0xfeff) + firstBash), transcriptCommands(firstBash), 'a byte-order mark does not hide the first line');
  assert.deepEqual(transcriptCommands(`null\n${agent}`), { tried: 2, failed: 1 }, 'a null line is skipped, not a crash');
});

test('findSessionTranscripts: a session UUID is found under any project folder; anything else is not looked up', async (t) => {
  const cfg = await fs.mkdtemp(path.join(os.tmpdir(), 'native-agent-session-'));
  t.after(() => fs.rm(cfg, { recursive: true, force: true }));
  const id = '02f988dd-4220-4e48-b029-813a674c99c4';
  const file = path.join(cfg, 'projects', 'C--target', `${id}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{}\n');
  assert.deepEqual(await findSessionTranscripts(id, { CLAUDE_CONFIG_DIR: cfg }), [file]);
  assert.deepEqual(await findSessionTranscripts('SESSION_1', { CLAUDE_CONFIG_DIR: cfg }), [], 'not a UUID');
  assert.deepEqual(await findSessionTranscripts('../projects', { CLAUDE_CONFIG_DIR: cfg }), []);
  assert.deepEqual(await findSessionTranscripts('ses_abc123', { CLAUDE_CONFIG_DIR: cfg }), [], 'an OpenCode session id');
  assert.deepEqual(await findSessionTranscripts('11111111-2222-3333-4444-555555555555', { CLAUDE_CONFIG_DIR: cfg }), []);
});
