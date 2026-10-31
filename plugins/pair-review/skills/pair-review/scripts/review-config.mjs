#!/usr/bin/env node
// Local reviewer preferences. Runtime availability is checked before dispatch.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { catalog, isSupportedPair, PROVIDERS } from './provider-catalog.mjs';
import { isMainModule } from './path-utils.mjs';

const SKILLS = ['pair-review', 'cross-review'];
const MODES = ['collaborate', 'adversarial', 'none'];
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const EFFORT = /^[a-z][a-z0-9_-]*$/;

export function configPath(skill, env = process.env, home = os.homedir()) {
  if (!SKILLS.includes(skill)) throw new Error('Unknown review skill');
  const root = env.REVIEW_SKILLS_CONFIG_DIR ||
    path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'review-skills');
  if (!path.isAbsolute(root)) throw new Error('Configuration directory must be absolute');
  return path.join(root, `${skill}.json`);
}

// A user's own bug checklists live next to the saved choices, never in the repository: <config dir>/checklists/<NAME>.md, one "- item" per line.
export function checklistDir(env = process.env, home = os.homedir()) {
  return path.join(path.dirname(configPath(SKILLS[0], env, home)), 'checklists');
}

const CHECKLIST_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export async function listChecklists(dir) {
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith('.md') && CHECKLIST_FILE_RE.test(f.slice(0, -3))).map((f) => f.slice(0, -3)).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const out = [];
  for (const name of names) out.push({ name, items: (await readChecklist(dir, name)).items.length });
  return out;
}

export async function readChecklist(dir, name) {
  if (!CHECKLIST_FILE_RE.test(name)) throw new Error('A checklist name is letters, digits, "-" or "_" (up to 40 characters)');
  let text;
  try {
    text = await fs.readFile(path.join(dir, `${name}.md`), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No checklist "${name}" in ${dir}`);
    throw err;
  }
  const items = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => /^\s*[-*]\s+(.+?)\s*$/.exec(l)?.[1]).filter(Boolean);
  return { name, items };
}

function defaultRuntime(provider) {
  return Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider].runtimes[0] : null;
}

function normalizeConfig(config, skill) {
  if (!config || config.skill !== skill) throw new Error('Unsupported configuration version or wrong skill');
  if (config.version === 2) return structuredClone(config);
  if (config.version !== 1) throw new Error('Unsupported configuration version or wrong skill');
  const migrated = structuredClone(config);
  migrated.version = 2;
  for (const seat of Object.values(migrated.reviewers || {})) {
    if (seat && !seat.runtime) seat.runtime = defaultRuntime(seat.provider);
  }
  return migrated;
}

function validateSeat(seat, role) {
  if (!seat || typeof seat.provider !== 'string' || !TOKEN.test(seat.provider) ||
      typeof seat.runtime !== 'string' || !TOKEN.test(seat.runtime) ||
      !isSupportedPair(seat.provider, seat.runtime) || typeof seat.model !== 'string' ||
      !TOKEN.test(seat.model) || seat.model === 'inherit' || typeof seat.effort !== 'string' ||
      !EFFORT.test(seat.effort)) {
    throw new Error(`Invalid reviewer ${role}; supply explicit provider, runtime, model, and effort or default`);
  }
}

export function validateConfig(config, skill) {
  const normalized = normalizeConfig(config, skill);
  if (!MODES.includes(normalized.mode) || (skill === 'cross-review' && normalized.mode !== 'adversarial')) {
    throw new Error('Invalid review mode');
  }
  for (const role of ['A', 'B']) validateSeat(normalized.reviewers?.[role], role);
  const { A, B } = normalized.reviewers;
  if (skill === 'pair-review') {
    const vendors = { anthropic: 'claude', openai: 'codex' };
    if (A.provider !== B.provider || vendors[A.provider] === undefined || A.runtime !== vendors[A.provider] || B.runtime !== vendors[B.provider]) {
      throw new Error('Pair review requires two reviewers from one vendor: both anthropic/claude or both openai/codex');
    }
    if (A.model === B.model) throw new Error('Pair review requires two distinct models');
  } else {
    // Seat A is a Claude reviewer and seat B a Codex one; no other layout has a defined dispatch path.
    if (A.provider !== 'anthropic' || A.runtime !== 'claude') {
      throw new Error('Cross review requires seat A to run on the Claude harness (provider anthropic, runtime claude)');
    }
    if (B.runtime !== 'codex') {
      throw new Error('Cross review requires seat B to run through codex-dispatch.mjs (provider openai, runtime codex)');
    }
    if (A.provider === B.provider) throw new Error('Cross review requires two different providers');
  }
  return normalized;
}

export async function readConfig(file, skill) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (err) { throw new SyntaxError(`${file} is not valid JSON (${err.message}); fix it or run reset`); }
  // A file saved by an older version (an OpenCode seat, say) no longer validates: name it and the way out.
  try { return validateConfig(parsed, skill); }
  catch (err) { throw new Error(`${file} holds saved choices this version cannot use (${err.message}); run reset, then setup`); }
}

function emptyConfig(skill) {
  return {
    version: 2, skill, mode: skill === 'pair-review' ? 'collaborate' : 'adversarial',
    reviewers: {
      A: { provider: 'anthropic', runtime: 'claude', model: '', effort: 'default' },
      B: skill === 'pair-review'
        ? { provider: 'anthropic', runtime: 'claude', model: '', effort: 'default' }
        : { provider: 'openai', runtime: 'codex', model: '', effort: 'default' },
    },
  };
}

export function resolveConfig(saved, skill, options = {}) {
  const config = saved ? structuredClone(validateConfig(saved, skill)) : emptyConfig(skill);
  if (options.mode !== undefined) config.mode = options.mode;
  for (const role of ['A', 'B']) {
    const key = role.toLowerCase();
    const seat = config.reviewers[role];
    const providerKey = `${key}-provider`;
    const runtimeKey = `${key}-runtime`;
    if (options[providerKey] !== undefined && options[providerKey] !== seat.provider) {
      seat.provider = options[providerKey];
      seat.runtime = defaultRuntime(seat.provider);
      seat.model = '';
      seat.effort = 'default';
    }
    if (options[runtimeKey] !== undefined && options[runtimeKey] !== seat.runtime) {
      seat.runtime = options[runtimeKey];
      seat.model = '';
      seat.effort = 'default';
    }
    if (options[key] !== undefined && options[key] !== seat.model) {
      seat.model = options[key];
      seat.effort = 'default';
    }
    if (options[`${key}-effort`] !== undefined) seat.effort = options[`${key}-effort`];
  }
  return validateConfig(config, skill);
}

const NATIVE_RUNTIME_OF_HOST = { 'claude-code': 'claude', codex: 'codex' };

// The seats file preflight --host reads, built from a resolved configuration: an actor whose runtime is the host's own
// is a native agent unless transport says cli; every other runtime runs through its CLI. The auditor repeats seat A unless --auditor names another model of the same provider.
// --env ROLE=NAME,NAME, --env-mode ROLE=filtered|inherit and --use-api-key ROLE (each once per role) as run.json env settings.
export function seatEnv(options = {}) {
  const out = {};
  const roleOf = (role, flag) => {
    if (!['A', 'B', 'auditor'].includes(role)) throw new Error(`${flag} takes a role first: A, B or auditor`);
    return (out[role] ??= {});
  };
  const once = (env, key, flag, role) => {
    if (env[key] !== undefined) throw new Error(`${flag} given twice for ${role}`);
  };
  for (const value of options.env ?? []) {
    const m = /^([^=]+)=(.+)$/.exec(value);
    if (!m) throw new Error('--env takes ROLE=NAME,NAME (variable names, never values)');
    const env = roleOf(m[1], '--env');
    once(env, 'pass', '--env', m[1]);
    env.pass = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    const bad = env.pass.find((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
    if (bad !== undefined) throw new Error(`--env ${m[1]}: "${bad}" is not a variable name (names only, never NAME=value)`);
  }
  for (const value of options['env-mode'] ?? []) {
    const m = /^([^=]+)=(filtered|inherit)$/.exec(value);
    if (!m) throw new Error('--env-mode takes ROLE=filtered or ROLE=inherit');
    const env = roleOf(m[1], '--env-mode');
    once(env, 'mode', '--env-mode', m[1]);
    env.mode = m[2];
  }
  for (const role of options['use-api-key'] ?? []) {
    const env = roleOf(role, '--use-api-key');
    once(env, 'apiKey', '--use-api-key', role);
    env.apiKey = true;
  }
  return out;
}

export function buildSeats(config, host, { transport = null, repoOnly = false, falsification = false, auditorModel = null, auditorEffort = null, env = {} } = {}) {
  const nativeRuntime = NATIVE_RUNTIME_OF_HOST[host];
  if (!nativeRuntime) throw new Error('--host must be claude-code or codex');
  if (transport !== null && !['native', 'cli'].includes(transport)) throw new Error('--transport must be native or cli');
  if (auditorModel !== null && !/^[^\s]+$/.test(auditorModel)) throw new Error('--auditor must be one model id with no spaces');
  if (auditorEffort !== null && auditorModel === null) throw new Error('--auditor-effort needs --auditor');
  const actor = (seat) => ({
    provider: seat.provider, runtime: seat.runtime, model: seat.model,
    effort: seat.effort === 'default' ? null : seat.effort,
    transport: seat.runtime === nativeRuntime ? (transport ?? 'native') : 'cli',
  });
  const { A, B } = config.reviewers;
  const seats = {
    seatA: actor(A), seatB: actor(B),
    auditor: auditorModel === null ? actor(A) : { ...actor(A), model: auditorModel, effort: auditorEffort },
    flags: { falsification, mode: config.mode, repoOnly: repoOnly === true },
  };
  // The auditor runs on seat A's provider, so it takes seat A's setting unless it has its own.
  for (const [role, key] of [['A', 'seatA'], ['B', 'seatB'], ['auditor', 'auditor']]) {
    const own = env[role] ?? (role === 'auditor' ? env.A : undefined);
    if (!own) continue;
    if (seats[key].transport !== 'cli') {
      if (env[role]) throw new Error(`the environment options for ${role} apply to a CLI actor only; ${role} runs as a native agent (use --transport cli)`);
      continue;
    }
    if (own.apiKey && seats[key].runtime !== 'claude') throw new Error(`--use-api-key ${role}: ANTHROPIC_API_KEY is for a Claude CLI actor; name the variable with --env ${role}=NAME instead`);
    seats[key].env = { ...own };
  }
  return seats;
}

export async function writeConfig(file, config) {
  const normalized = validateConfig(config, config.skill);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(normalized, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    try { await fs.unlink(temp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

export function parseOptions(argv) {
  const [command = 'show', ...rest] = argv;
  if (!['show', 'setup', 'resolve', 'reset', 'catalog', 'seats', 'checklists', '--help'].includes(command)) throw new Error('Unknown command');
  const options = {};
  const allowed = ['a', 'b', 'a-effort', 'b-effort', 'a-provider', 'b-provider', 'a-runtime', 'b-runtime', 'mode'];
  if (command === 'checklists') allowed.push('name');
  if (command === 'seats') allowed.push('host', 'transport', 'out', 'auditor', 'auditor-effort', 'env', 'env-mode', 'use-api-key');
  const repeatable = command === 'seats' ? ['env', 'env-mode', 'use-api-key'] : [];
  if (rest.includes('--help') || rest.includes('-h')) return { command: '--help', options: {} };
  for (let i = 0; i < rest.length; i += 2) {
    if (repeatable.includes(rest[i]?.replace(/^--/, '')) && rest[i].startsWith('--')) {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`${rest[i]} requires a value`);
      (options[rest[i].slice(2)] ??= []).push(rest[i + 1]);
      continue;
    }
    if (command === 'seats' && (rest[i] === '--repo-only' || rest[i] === '--falsification' || rest[i] === '--replace')) {
      const flag = rest[i].slice(2);
      if (options[flag]) throw new Error(`Duplicate option: ${rest[i]}`);
      options[flag] = true;
      i -= 1;
      continue;
    }
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || !allowed.includes(key)) throw new Error(`Unknown option: ${rest[i]}`);
    if (options[key] !== undefined) throw new Error(`Duplicate option: ${rest[i]}`);
    if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`${rest[i]} requires a value`);
    options[key] = rest[i + 1];
  }
  if (!['setup', 'resolve', 'seats', 'checklists'].includes(command) && rest.length) throw new Error(`${command} takes no options`);
  return { command, options };
}

async function main() {
  const skill = path.basename(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const { command, options } = parseOptions(process.argv.slice(2));
  if (command === '--help') {
    process.stdout.write('review-config.mjs show|catalog|setup|resolve|seats|checklists|reset\n' +
      'checklists [--name NAME]: lists your own bug checklists (<config dir>/checklists/NAME.md, one "- item" per line, never in the repository), or prints one so its items can go into the task packet as hypotheses.\n' +
      'seats: --host claude-code|codex [--transport native|cli] [--repo-only] [--falsification] [--auditor MODEL [--auditor-effort LEVEL]] [--env ROLE=NAME,NAME] [--env-mode ROLE=filtered|inherit] [--use-api-key ROLE] [--out FILE [--replace]] [--a MODEL --b MODEL --mode MODE, and the other resolve overrides, for this run only]: prints (or writes) the seats file preflight --host reads, built from the saved choices.\n' +
      'setup/resolve: --a-provider PROVIDER --a-runtime RUNTIME --a MODEL [--a-effort LEVEL] (same for B) [--mode MODE]\n' +
      'setup saves; resolve overrides for one run without saving; reset removes only this skill config.\n');
    return;
  }
  if (command === 'checklists') {
    const dir = checklistDir();
    if (options.name) {
      const { items } = await readChecklist(dir, options.name);
      process.stdout.write(items.map((item) => `- ${item}`).join('\n') + '\n');
    } else {
      process.stdout.write(JSON.stringify({ dir, checklists: await listChecklists(dir) }, null, 2) + '\n');
    }
    return;
  }
  if (command === 'catalog') { process.stdout.write(JSON.stringify(catalog(), null, 2) + '\n'); return; }
  const file = configPath(skill);
  if (command === 'reset') {
    await fs.rm(file, { force: true });
    process.stdout.write(JSON.stringify({ path: file, configured: false }) + '\n');
    return;
  }
  const saved = await readConfig(file, skill);
  if (command === 'show') {
    process.stdout.write(JSON.stringify({ path: file, configured: saved !== null, config: saved }, null, 2) + '\n');
    return;
  }
  const config = resolveConfig(saved, skill, options);
  if (command === 'seats') {
    if (!options.host) throw new Error('seats needs --host claude-code or --host codex');
    const seats = buildSeats(config, options.host, { transport: options.transport ?? null, repoOnly: options['repo-only'] === true, falsification: options.falsification === true, auditorModel: options.auditor ?? null, auditorEffort: options['auditor-effort'] ?? null, env: seatEnv(options) });
    // The manifest's selection_source: "saved" when the seat's model came from the saved choices, "explicit" when this run
    // chose another model, provider or runtime (an effort override alone keeps the saved model).
    for (const role of ['A', 'B']) {
      const overridden = ['', '-provider', '-runtime'].some((suffix) => options[`${role.toLowerCase()}${suffix}`] !== undefined);
      seats[`seat${role}`].selectionSource = saved !== null && !overridden ? 'saved' : 'explicit';
    }
    const text = JSON.stringify(seats, null, 2) + '\n';
    // A field run on Codex's default effort got a 61-second pass with one claim, and Codex does not report the effort it chose.
    for (const role of ['A', 'B']) {
      const seat = seats[`seat${role}`];
      if (seat.runtime === 'codex' && seat.transport === 'cli' && !seat.effort) {
        process.stderr.write(`review-config: WARNING: seat ${role} (codex) runs on Codex's default effort, which the rollout does not report; set one with --${role.toLowerCase()}-effort high if the review needs depth\n`);
      }
    }
    // A native agent starts with whatever the host loads into every agent (the user's global instructions, memory).
    const native = [['seat A', seats.seatA], ['seat B', seats.seatB], ['the auditor', seats.auditor]].filter(([, s]) => s?.transport === 'native').map(([n]) => n);
    if (native.length > 0) process.stderr.write(`review-config: note: ${native.join(', ')} ${native.length === 1 ? 'runs as a native agent and also sees' : 'run as native agents and also see'} the host's own instructions and memory (told to treat them as unchecked context); use --transport cli where that matters\n`);
    if (options.out) {
      try {
        // --replace: switching a seat's transport before preflight; run.json keeps its own copy, so a run already started is unchanged.
        await fs.writeFile(path.resolve(options.out), text, { flag: options.replace === true ? 'w' : 'wx' });
      } catch (err) {
        if (err.code === 'EEXIST') throw new Error(`${path.resolve(options.out)} already exists: choose a new --out path, or add --replace to overwrite it`);
        throw err;
      }
      process.stdout.write(JSON.stringify({ seatsFile: path.resolve(options.out) }) + '\n');
    } else {
      process.stdout.write(text);
    }
    return;
  }
  if (command === 'setup') await writeConfig(file, config);
  process.stdout.write(JSON.stringify({ path: file, saved: command === 'setup', config }, null, 2) + '\n');
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { process.stderr.write(`review-config: ${err.message}\n`); process.exitCode = 1; });
}
