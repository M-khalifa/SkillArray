#!/usr/bin/env node
// Local preferences only. Model availability is checked by the review harness.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const SKILLS = ['pair-review', 'cross-review'];
const MODES = ['collaborate', 'adversarial', 'none'];
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export function configPath(skill, env = process.env, home = os.homedir()) {
  if (!SKILLS.includes(skill)) throw new Error('Unknown review skill');
  const root = env.REVIEW_SKILLS_CONFIG_DIR ||
    path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'review-skills');
  if (!path.isAbsolute(root)) throw new Error('Configuration directory must be absolute');
  return path.join(root, `${skill}.json`);
}

export function validateConfig(config, skill) {
  if (!config || config.version !== 1 || config.skill !== skill) {
    throw new Error('Unsupported configuration version or wrong skill');
  }
  if (!MODES.includes(config.mode) || (skill === 'cross-review' && config.mode !== 'adversarial')) {
    throw new Error('Invalid review mode');
  }
  for (const [role, provider] of [['A', 'anthropic'], ['B', skill === 'pair-review' ? 'anthropic' : 'openai']]) {
    const seat = config.reviewers?.[role];
    if (!seat || seat.provider !== provider || typeof seat.model !== 'string' ||
        !TOKEN.test(seat.model) || seat.model === 'inherit' ||
        typeof seat.effort !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(seat.effort)) {
      throw new Error(`Invalid reviewer ${role}; supply an explicit model and effort or default`);
    }
  }
  if (skill === 'pair-review' && config.reviewers.A.model === config.reviewers.B.model) {
    throw new Error('Pair review requires two distinct models');
  }
  return config;
}

export async function readConfig(file, skill) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (err) { throw new SyntaxError(`${file} is not valid JSON (${err.message}); fix it or run reset`); }
  return validateConfig(parsed, skill);
}

export function resolveConfig(saved, skill, options = {}) {
  const config = saved ? structuredClone(validateConfig(saved, skill)) : {
    version: 1, skill, mode: skill === 'pair-review' ? 'collaborate' : 'adversarial',
    reviewers: {
      A: { provider: 'anthropic', model: '', effort: 'default' },
      B: { provider: skill === 'pair-review' ? 'anthropic' : 'openai', model: '', effort: 'default' },
    },
  };
  if (options.mode !== undefined) config.mode = options.mode;
  for (const role of ['A', 'B']) {
    const key = role.toLowerCase();
    // Effort selections are model-specific; a model change clears the old effort.
    if (options[key] !== undefined && options[key] !== config.reviewers[role].model) {
      config.reviewers[role].model = options[key];
      config.reviewers[role].effort = 'default';
    }
    if (options[`${key}-effort`] !== undefined) config.reviewers[role].effort = options[`${key}-effort`];
  }
  return validateConfig(config, skill);
}

export async function writeConfig(file, config) {
  validateConfig(config, config.skill);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    try { await fs.unlink(temp); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

export function parseOptions(argv) {
  const [command = 'show', ...rest] = argv;
  if (!['show', 'setup', 'resolve', 'reset', '--help'].includes(command)) throw new Error('Unknown command');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || !['a', 'b', 'a-effort', 'b-effort', 'mode'].includes(key)) {
      throw new Error(`Unknown option: ${rest[i]}`);
    }
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
    process.stdout.write('review-config.mjs show|setup|resolve|reset\n' +
      'setup/resolve: --a MODEL --b MODEL [--a-effort LEVEL] [--b-effort LEVEL] [--mode MODE]\n' +
      'setup saves; resolve overrides for one run without saving; reset removes only this skill config.\n');
    return;
  }
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
