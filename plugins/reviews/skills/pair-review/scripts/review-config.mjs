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
}

export function validateConfig(config, skill) {
  const normalized = normalizeConfig(config, skill);
  if (!MODES.includes(normalized.mode) || (skill === 'cross-review' && normalized.mode !== 'adversarial')) {
    throw new Error('Invalid review mode');
  }
  for (const role of ['A', 'B']) validateSeat(normalized.reviewers?.[role], role);
  const { A, B } = normalized.reviewers;
  if (skill === 'pair-review') {
    if (A.provider !== 'anthropic' || B.provider !== 'anthropic' || A.runtime !== 'claude' || B.runtime !== 'claude') {
      throw new Error('Pair review requires two Claude-harness reviewers');
    }
    if (A.model === B.model) throw new Error('Pair review requires two distinct models');
  } else if (A.provider === B.provider) {
    throw new Error('Cross review requires two different providers');
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
  if (!['show', 'setup', 'resolve', 'reset', 'catalog', '--help'].includes(command)) throw new Error('Unknown command');
  const options = {};
  const allowed = ['a', 'b', 'a-effort', 'b-effort', 'a-provider', 'b-provider', 'a-runtime', 'b-runtime', 'mode'];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || !allowed.includes(key)) throw new Error(`Unknown option: ${rest[i]}`);
    if (options[key] !== undefined) throw new Error(`Duplicate option: ${rest[i]}`);
    if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`${rest[i]} requires a value`);
    options[key] = rest[i + 1];
  }
  if (!['setup', 'resolve'].includes(command) && rest.length) throw new Error(`${command} takes no options`);
  return { command, options };
}

async function main() {
  const skill = path.basename(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const { command, options } = parseOptions(process.argv.slice(2));
  if (command === '--help') {
    process.stdout.write('review-config.mjs show|catalog|setup|resolve|reset\n' +
      'setup/resolve: --a-provider PROVIDER --a-runtime RUNTIME --a MODEL [--a-effort LEVEL] (same for B) [--mode MODE]\n' +
      'setup saves; resolve overrides for one run without saving; reset removes only this skill config.\n');
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
  if (command === 'setup') await writeConfig(file, config);
  process.stdout.write(JSON.stringify({ path: file, saved: command === 'setup', config }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`review-config: ${err.message}\n`); process.exitCode = 1; });
}
