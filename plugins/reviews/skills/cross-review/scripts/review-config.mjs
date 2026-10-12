#!/usr/bin/env node
// Local reviewer preferences. Runtime availability is checked before dispatch.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { catalog, isSupportedPair, PROVIDERS } from './provider-catalog.mjs';

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
  if (Object.hasOwn(PROVIDERS, provider)) return PROVIDERS[provider].runtimes[0];
  // opencode is the only runtime that accepts an uncatalogued provider.
  return 'opencode';
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
  // An OpenCode model ID is provider/model; without this check, seat.provider is a free-standing
  // label that dispatch never uses to route, so it can silently disagree with what the model ID
  // actually invokes (e.g. provider "google" alongside model "anthropic/claude-opus-5").
  if (seat.runtime === 'opencode') {
    const slash = seat.model.indexOf('/');
    const modelProvider = slash === -1 ? null : seat.model.slice(0, slash);
    if (modelProvider === null || modelProvider.toLowerCase() !== seat.provider.toLowerCase()) {
      throw new Error(
        `Invalid reviewer ${role}; OpenCode model IDs are provider/model, "${seat.model}" does ` +
          `not start with "${seat.provider}/"`
      );
    }
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
    // Phase 1/2 dispatch only seat A through this harness (Claude) and seat B
    // through a CLI (codex-dispatch.mjs or opencode-dispatch.mjs); no other
    // layout has a defined dispatch path.
    if (A.provider !== 'anthropic' || A.runtime !== 'claude') {
      throw new Error('Cross review requires seat A to run on the Claude harness (provider anthropic, runtime claude)');
    }
    if (!['codex', 'opencode'].includes(B.runtime)) {
      throw new Error('Cross review requires seat B to run through codex-dispatch.mjs or opencode-dispatch.mjs (runtime codex or opencode)');
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
  return validateConfig(parsed, skill);
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
export function buildSeats(config, host, { transport = null, repoOnly = false, auditDepth = null, falsification = false, auditorModel = null, auditorEffort = null } = {}) {
  if (auditDepth !== null && !['light', 'full'].includes(auditDepth)) throw new Error('--audit-depth must be light or full');
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
  return {
    seatA: actor(A), seatB: actor(B),
    auditor: auditorModel === null ? actor(A) : { ...actor(A), model: auditorModel, effort: auditorEffort },
    flags: { auditDepth: auditDepth ?? 'light', falsification, mode: config.mode, ...(repoOnly ? { repoOnly: true } : {}) },
  };
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
  if (command === 'seats') allowed.push('host', 'transport', 'out', 'audit-depth', 'auditor', 'auditor-effort');
  if (rest.includes('--help') || rest.includes('-h')) return { command: '--help', options: {} };
  for (let i = 0; i < rest.length; i += 2) {
    if (command === 'seats' && (rest[i] === '--repo-only' || rest[i] === '--falsification')) {
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
      'seats: --host claude-code|codex [--transport native|cli] [--repo-only] [--falsification] [--audit-depth light|full] [--auditor MODEL [--auditor-effort LEVEL]] [--out FILE] [--a MODEL --b MODEL --mode MODE, and the other resolve overrides, for this run only]: prints (or writes) the seats file preflight --host reads, built from the saved choices.\n' +
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
    const seats = buildSeats(config, options.host, { transport: options.transport ?? null, repoOnly: options['repo-only'] === true, auditDepth: options['audit-depth'] ?? null, falsification: options.falsification === true, auditorModel: options.auditor ?? null, auditorEffort: options['auditor-effort'] ?? null });
    const text = JSON.stringify(seats, null, 2) + '\n';
    if (options.out) {
      try {
        await fs.writeFile(path.resolve(options.out), text, { flag: 'wx' });
      } catch (err) {
        if (err.code === 'EEXIST') throw new Error(`${path.resolve(options.out)} already exists and is never overwritten: choose a new --out path`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`review-config: ${err.message}\n`); process.exitCode = 1; });
}
