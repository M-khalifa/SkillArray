// A native agent (Claude Code subagent or Codex spawned agent) writes its own transcript. Reading it tells
// whether the agent has finished, so the sequencer can wait on evidence instead of a trusted --native-done.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findThreadRollout } from './rollout-utils.mjs';

const CLAUDE_AGENT_ID = /^a[0-9a-f]{8,}$/;
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function projectsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

// A Claude agent id is looked up as <config>/projects/*/*/subagents/agent-<id>.jsonl, a Codex thread id as its rollout
// under <CODEX_HOME or ~/.codex>/sessions; anything else is a path.
export async function findAgentTranscripts(value, env = process.env) {
  if (CODEX_THREAD_ID.test(value)) return [await findThreadRollout(value, path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions'))].filter(Boolean);
  if (!CLAUDE_AGENT_ID.test(value)) return [value];
  const projects = projectsDir(env);
  const found = [];
  for (const project of await fs.readdir(projects).catch(() => [])) {
    for (const session of await fs.readdir(path.join(projects, project)).catch(() => [])) {
      const file = path.join(projects, project, session, 'subagents', `agent-${value}.jsonl`);
      if (await fs.stat(file).then((s) => s.isFile(), () => false)) found.push(file);
    }
  }
  return found;
}

// A Claude CLI seat's session transcript, <config>/projects/*/<session id>.jsonl; only a session UUID is looked up.
export async function findSessionTranscripts(sessionId, env = process.env) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(sessionId))) return [];
  const projects = projectsDir(env);
  const found = [];
  for (const project of await fs.readdir(projects).catch(() => [])) {
    const file = path.join(projects, project, `${sessionId}.jsonl`);
    if (await fs.stat(file).then((s) => s.isFile(), () => false)) found.push(file);
  }
  return found;
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Shell commands in a Claude transcript: each Bash or PowerShell call in the window [start, end) (ms or null); failed = its
// result is an error (non-zero exit, denied, blocked) or never came. Results match by id across the whole file.
export function transcriptCommands(text, { start = null, end = null } = {}) {
  const calls = new Set();
  const errors = new Map();
  for (const entry of parseLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)) {
    const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    if (entry?.type === 'assistant') {
      const at = Date.parse(entry.timestamp);
      if ((start !== null && !(at >= start)) || (end !== null && !(at < end))) continue;
      for (const c of content) if (c?.type === 'tool_use' && SHELL_TOOLS.has(c.name)) calls.add(c.id);
    } else if (entry?.type === 'user') {
      for (const c of content) if (c?.type === 'tool_result' && !errors.has(c.tool_use_id)) errors.set(c.tool_use_id, c.is_error === true);
    }
  }
  return { tried: calls.size, failed: [...calls].filter((id) => errors.get(id) !== false).length };
}

function parseLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* a line still being written */ }
  }
  return events;
}

// A user entry that only carries tool results (the hand-back's own result is appended after the hand-back call) or that is
// marked meta (a reminder the harness injects) is not a new prompt; a real prompt after the last reply means the agent works again.
function isNewPrompt(entry) {
  if (entry.isMeta) return false;
  const content = entry.message?.content;
  return !(Array.isArray(content) && content.length > 0 && content.every((c) => c?.type === 'tool_result'));
}

function claudeState(events) {
  let state = 'running';
  for (const entry of events) {
    if (entry.type === 'assistant' && entry.message) {
      const content = Array.isArray(entry.message.content) ? entry.message.content : [];
      const handback = content.some((c) => c?.type === 'tool_use' && c.name === 'SubagentHandback');
      state = entry.message.stop_reason === 'end_turn' || handback ? 'done' : 'running';
    } else if (entry.type === 'user' && isNewPrompt(entry)) {
      state = 'running';
    }
  }
  return state;
}

function codexState(events) {
  const marks = events.filter((e) => e.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(e.payload?.type));
  const last = marks.at(-1);
  if (!last) return 'running';
  return last.payload.type === 'task_started' ? 'running' : 'done';
}

// 'done' when the agent's last turn ended (a Claude end_turn or hand-back, a Codex task_complete),
// 'running' when it is still working or a new prompt arrived after its last reply, 'unreadable' otherwise.
export async function agentState(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return 'unreadable';
  }
  const events = parseLines((text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  if (events.length === 0) return 'unreadable';
  return events[0].type === 'session_meta' ? codexState(events) : claudeState(events);
}

// The agent's last reply as one short line (a Codex task_complete message, or a Claude assistant's last text), or null.
export async function agentLastReply(file, maxChars = 200) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const events = parseLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  let reply = null;
  for (const entry of events) {
    if (entry.type === 'event_msg' && entry.payload?.type === 'task_complete') {
      reply = typeof entry.payload.last_agent_message === 'string' ? entry.payload.last_agent_message : reply;
    } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const words = entry.message.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join(' ');
      if (words.trim() !== '') reply = words;
    }
  }
  if (reply === null) return null;
  const line = reply.replace(/\s+/g, ' ').trim();
  return line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line;
}

// Progress of a native agent from its transcript: tool calls so far and when it started (ms since epoch), or null when unreadable.
export async function agentStats(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const events = parseLines(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (events.length === 0) return null;
  let calls = 0;
  let startedAtMs = null;
  for (const entry of events) {
    const at = Date.parse(entry.timestamp ?? entry.payload?.timestamp ?? '');
    if (startedAtMs === null && Number.isFinite(at)) startedAtMs = at;
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      calls += entry.message.content.filter((c) => c?.type === 'tool_use').length;
    } else if (entry.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(entry.payload?.type)) {
      calls += 1;
    }
  }
  return { calls, startedAtMs };
}
