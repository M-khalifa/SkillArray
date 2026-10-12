import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TOKEN_KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

// A partially written final line must not discard the last complete token event.
export function parseRollout(text) {
  const lines = text.split('\n');
  let meta = null;
  try {
    const first = JSON.parse(lines[0]);
    if (first.type === 'session_meta') meta = first.payload ?? null;
    if (meta) meta = { ...meta, timestamp: first.timestamp ?? meta.timestamp ?? null };
  } catch {}
  const tokenEvents = [];
  for (const line of lines) {
    if (!line.includes('"total_token_usage"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const usage = event.type === 'event_msg' && event.payload?.type === 'token_count'
      ? event.payload.info?.total_token_usage : null;
    if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
      tokenEvents.push({ timestamp: event.timestamp ?? null, usage });
    }
  }
  return { meta, tokenEvents, usage: tokenEvents.at(-1)?.usage ?? null };
}

function usageField(raw) {
  return {
    input_tokens: raw.input_tokens ?? null,
    cached_input_tokens: raw.cached_input_tokens ?? null,
    cache_write_input_tokens: raw.cache_write_input_tokens ?? null,
    output_tokens: raw.output_tokens ?? null,
    reasoning_tokens: raw.reasoning_output_tokens ?? null,
    total_tokens: raw.total_tokens ?? null,
    estimated_cost_usd: null,
    source: 'codex-rollout',
    raw,
  };
}

function boundaryMs(value, name) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('invalid rollout window ' + name);
  return ms;
}

// Window counters are cumulative: subtract endpoints instead of adding token events.
export function rolloutUsage(text, { start = null, end = null } = {}) {
  const rollout = parseRollout(text);
  if (start === null && end === null) {
    return rollout.usage ? usageField(rollout.usage) : { source: 'unavailable', reason: 'no rollout token usage reported' };
  }
  if (start === null || end === null) throw new Error('rollout window requires both start and end');
  const startMs = boundaryMs(start, 'start');
  const endMs = boundaryMs(end, 'end');
  if (endMs < startMs) throw new Error('rollout window end precedes start');
  const at = (limit) => {
    let latest = null;
    let latestMs = -Infinity;
    for (const event of rollout.tokenEvents) {
      const ms = Date.parse(event.timestamp);
      if (Number.isFinite(ms) && ms <= limit && ms >= latestMs) {
        latest = event.usage;
        latestMs = ms;
      }
    }
    return latest;
  };
  const final = at(endMs);
  let initial = at(startMs);
  if (!final) return { source: 'unavailable', reason: 'no rollout token usage at or before window end' };
  const createdMs = Date.parse(rollout.meta?.timestamp);
  if (!initial && Number.isFinite(createdMs) && createdMs >= startMs && createdMs <= endMs) {
    initial = Object.fromEntries(TOKEN_KEYS.map((key) => [key, 0]));
  }
  if (!initial) return { source: 'unavailable', reason: 'no rollout token baseline at or before window start' };
  const delta = Object.fromEntries(TOKEN_KEYS.map((key) => [
    key, Number.isFinite(final[key]) && Number.isFinite(initial[key]) ? final[key] - initial[key] : null,
  ]));
  return usageField(delta);
}

export async function readRolloutUsage(file, window = {}) {
  return rolloutUsage(await fs.readFile(file, 'utf8'), window);
}

function defaultSessionsDir(env) {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

// The model a thread ran, from the last turn_context line; null when the rollout has none.
export function rolloutModel(text) {
  let model = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"turn_context"')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn_context' && typeof event.payload?.model === 'string' && event.payload.model) model = event.payload.model;
    } catch {}
  }
  return model;
}

// Shell commands a thread tried, one CommandExecution item each, in the window [start, end) (ms or null); failed = not
// completed or a non-zero exit (a sandbox spawn failure is "failed", exit -1). No items while an exec_command or shell call
// exists is unknown (null), not 0: a spawned child thread can run commands without writing items.
export function rolloutCommands(text, { start = null, end = null } = {}) {
  let tried = 0;
  let failed = 0;
  let shellCall = false;
  for (const line of (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split('\n')) {
    if (!line.includes('CommandExecution') && !line.includes('"response_item"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    const at = Date.parse(event.timestamp);
    if ((start !== null && !(at >= start)) || (end !== null && !(at < end))) continue;
    const p = event.payload ?? {};
    if (event.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution') {
      tried++;
      if (p.item.status !== 'completed' || p.item.exit_code !== 0) failed++;
    } else if (event.type === 'response_item' && (p.type === 'local_shell_call' || /^(?:shell|exec_command|shell_command)$/.test(p.name ?? '') || String(p.input ?? p.arguments ?? '').includes('exec_command'))) {
      shellCall = true;
    }
  }
  return tried === 0 && shellCall ? null : { tried, failed };
}

// Filename suffix and session_meta.id must both match the orchestrator's thread.
export async function findOrchestratorRollout({ env = process.env, sessionsDir = defaultSessionsDir(env) } = {}) {
  return findThreadRollout(env.CODEX_THREAD_ID, sessionsDir);
}

export async function findThreadRollout(threadId, sessionsDir) {
  if (typeof threadId !== 'string' || !threadId) return null;
  for (const year of (await fs.readdir(sessionsDir).catch(() => [])).sort()) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of (await fs.readdir(path.join(sessionsDir, year)).catch(() => [])).sort()) {
      if (!/^\d{2}$/.test(month)) continue;
      const monthDir = path.join(sessionsDir, year, month);
      for (const day of (await fs.readdir(monthDir).catch(() => [])).sort()) {
        if (!/^\d{2}$/.test(day)) continue;
        const dayDir = path.join(monthDir, day);
        for (const name of (await fs.readdir(dayDir).catch(() => [])).sort()) {
          if (!name.startsWith('rollout-') || !name.endsWith('-' + threadId + '.jsonl')) continue;
          const file = path.join(dayDir, name);
          const text = await fs.readFile(file, 'utf8').catch(() => '');
          if (parseRollout(text).meta?.id === threadId) return file;
        }
      }
    }
  }
  return null;
}

export async function findChildThreads(threadId, sinceMs, sessionsDir) {
  if (!threadId) return [];
  const files = [];
  const walk = async (dir) => {
    for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else if (/^rollout-.*\.jsonl$/.test(d.name)) files.push(p);
    }
  };
  const since = new Date(sinceMs - 86400000);
  const minDay = `${since.getFullYear()}${String(since.getMonth() + 1).padStart(2, '0')}${String(since.getDate()).padStart(2, '0')}`;
  for (const y of await fs.readdir(sessionsDir).catch(() => [])) {
    for (const m of await fs.readdir(path.join(sessionsDir, y)).catch(() => [])) {
      for (const day of await fs.readdir(path.join(sessionsDir, y, m)).catch(() => [])) {
        if (`${y}${m}${day}` >= minDay) await walk(path.join(sessionsDir, y, m, day));
      }
    }
  }
  const byParent = new Map();
  for (const f of files) {
    const st = await fs.stat(f).catch(() => null);
    if (!st || st.mtimeMs < sinceMs) continue;
    const text = await fs.readFile(f, 'utf8').catch(() => '');
    const firstLine = text.split('\n', 1)[0];
    let meta;
    try { meta = JSON.parse(firstLine)?.payload; } catch { continue; }
    const spawn = meta?.source?.subagent?.thread_spawn;
    if (!spawn?.parent_thread_id) continue;
    const usage = parseRollout(text).usage;
    const entry = { threadId: meta.id ?? meta.session_id ?? null, parentThreadId: spawn.parent_thread_id, agentPath: spawn.agent_path ?? null, depth: spawn.depth ?? null, usage };
    (byParent.get(spawn.parent_thread_id) ?? byParent.set(spawn.parent_thread_id, []).get(spawn.parent_thread_id)).push(entry);
  }
  const out = [];
  const queue = [threadId];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      out.push(child);
      if (child.threadId) queue.push(child.threadId);
    }
  }
  return out;
}

