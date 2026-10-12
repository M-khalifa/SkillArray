// Reader and validator of <run-dir>/run.json, the seat table every dispatcher and the exchange read.
// A CLI seat writes only into its private folder <run-dir>/phase1|phase2/seat-<role>/; publishSeatOutput
// copies that file to the canonical path. Declared extra read folders: top-level sourceDirs, per-actor grantDirs.
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RUNTIMES, isSupportedPair } from './provider-catalog.mjs';
import { validateConfig } from './review-config.mjs';
import { validateSupport } from './host-support.mjs';

class RunDescriptorError extends Error {}

const PHASES = ['phase1', 'phase2'];
const SEATS = ['A', 'B'];
const TRANSPORTS = ['native', 'cli'];
const SEAT_KEYS = { A: 'seatA', B: 'seatB' };
const TOP_STRINGS = ['skill', 'skillDir', 'targetDir', 'host'];
const FLAG_KEYS = ['auditDepth', 'falsification', 'mode'];
const AUDIT_DEPTHS = ['light', 'full'];
const REVIEW_SKILLS = ['cross-review', 'pair-review'];
const ACTOR_STRINGS = ['role', 'provider', 'runtime', 'transport', 'outputDir'];
const ACTOR_NULLABLE = ['effort', 'sessionId', 'resultPath', 'worktreePath'];
const ABSOLUTE_PATHS = ['outputDir', 'resultPath', 'worktreePath'];
const MAPPING_FILE = /seat-to-audit|mapping/i;

function present(value) {
  return value !== undefined;
}

function validateActor(actor, label, expectedRole) {
  if (actor === null || typeof actor !== 'object' || Array.isArray(actor)) {
    throw new RunDescriptorError(`run descriptor: actor "${label}" is missing or not an object`);
  }
  for (const key of ACTOR_STRINGS) {
    if (typeof actor[key] !== 'string' || actor[key].length === 0) {
      throw new RunDescriptorError(`run descriptor: actor "${label}" needs a non-empty string "${key}"`);
    }
  }
  if (typeof actor.model !== 'string' || actor.model.trim() === '') throw new RunDescriptorError(`run descriptor: actor "${label}" needs a non-empty string "model"`);
  if (!Object.hasOwn(RUNTIMES, actor.runtime)) {
    throw new RunDescriptorError(`run descriptor: actor "${label}" has unknown runtime "${actor.runtime}" (use ${Object.keys(RUNTIMES).join(', ')})`);
  }
  if (!isSupportedPair(actor.provider, actor.runtime)) {
    throw new RunDescriptorError(`run descriptor: actor "${label}" runs provider "${actor.provider}" on runtime "${actor.runtime}", which is not a supported pair`);
  }
  for (const key of ACTOR_NULLABLE) {
    if (!present(actor[key])) throw new RunDescriptorError(`run descriptor: actor "${label}" is missing "${key}" (null is allowed)`);
    if (actor[key] !== null && typeof actor[key] !== 'string') {
      throw new RunDescriptorError(`run descriptor: actor "${label}" "${key}" must be a string or null`);
    }
  }
  if (!TRANSPORTS.includes(actor.transport)) {
    throw new RunDescriptorError(`run descriptor: actor "${label}" has unknown transport "${actor.transport}" (use ${TRANSPORTS.join(' or ')})`);
  }
  if (typeof expectedRole === 'string' ? actor.role !== expectedRole : !expectedRole.test(actor.role)) {
    throw new RunDescriptorError(`run descriptor: actor "${label}" has role "${actor.role}", expected ${expectedRole}`);
  }
  for (const key of ABSOLUTE_PATHS) {
    if (actor[key] !== null && !path.isAbsolute(actor[key])) {
      throw new RunDescriptorError(`run descriptor: actor "${label}" "${key}" must be an absolute path, got "${actor[key]}"`);
    }
  }
  if (present(actor.grantDirs) && (!Array.isArray(actor.grantDirs) || actor.grantDirs.some((d) => typeof d !== 'string' || !path.isAbsolute(d)))) {
    throw new RunDescriptorError(`run descriptor: actor "${label}" "grantDirs" must be an array of absolute paths`);
  }
}

// The same vendor, runtime, mode and distinct-model rules review-config.mjs enforces at setup, applied to the seats file.
function validateLayout(data, file) {
  if (!REVIEW_SKILLS.includes(data.skill)) return;
  const seat = (actor) => ({ provider: actor.provider, runtime: actor.runtime, model: actor.model, effort: actor.effort ?? 'default' });
  try {
    validateConfig({ version: 2, skill: data.skill, mode: data.flags.mode, reviewers: { A: seat(data.seatA), B: seat(data.seatB) } }, data.skill);
  } catch (err) {
    throw new RunDescriptorError(`run descriptor ${file}: ${err.message}`);
  }
}

function validate(data, file) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new RunDescriptorError(`run descriptor ${file} must hold one JSON object`);
  }
  for (const key of TOP_STRINGS) {
    if (typeof data[key] !== 'string' || data[key].length === 0) throw new RunDescriptorError(`run descriptor ${file}: "${key}" must be a non-empty string`);
  }
  for (const key of ['skillDir', 'targetDir']) {
    if (!path.isAbsolute(data[key])) throw new RunDescriptorError(`run descriptor ${file}: "${key}" must be an absolute path`);
  }
  if (data.flags === null || typeof data.flags !== 'object' || Array.isArray(data.flags)) {
    throw new RunDescriptorError(`run descriptor ${file}: "flags" must be an object`);
  }
  for (const key of FLAG_KEYS) {
    if (!present(data.flags[key])) throw new RunDescriptorError(`run descriptor ${file}: flags.${key} is missing`);
  }
  if (!AUDIT_DEPTHS.includes(data.flags.auditDepth)) throw new RunDescriptorError(`run descriptor ${file}: flags.auditDepth must be ${AUDIT_DEPTHS.join(' or ')}, got ${JSON.stringify(data.flags.auditDepth)}`);
  if (typeof data.flags.falsification !== 'boolean') throw new RunDescriptorError(`run descriptor ${file}: flags.falsification must be the boolean true or false, got ${JSON.stringify(data.flags.falsification)}`);
  if (present(data.flags.timeoutS) && !(Number.isInteger(data.flags.timeoutS) && data.flags.timeoutS >= 0 && data.flags.timeoutS <= 2147483)) {
    throw new RunDescriptorError(`run descriptor ${file}: flags.timeoutS must be a whole number of seconds, 0 for no limit`);
  }
  if (present(data.flags.checklists) && (!Array.isArray(data.flags.checklists) || data.flags.checklists.some((name) => typeof name !== 'string' || !/^[A-Z][A-Z0-9]{1,15}$/.test(name)))) {
    throw new RunDescriptorError(`run descriptor ${file}: flags.checklists must be a list of 2-16 upper-case letter or digit names starting with a letter`);
  }
  if (present(data.flags.repoOnly) && typeof data.flags.repoOnly !== 'boolean') throw new RunDescriptorError(`run descriptor ${file}: flags.repoOnly must be a boolean`);
  if (!present(data.fingerprint)) throw new RunDescriptorError(`run descriptor ${file}: "fingerprint" is missing (null is allowed)`);
  if (present(data.sourceDirs) && (!Array.isArray(data.sourceDirs) || data.sourceDirs.some((d) => typeof d !== 'string' || !path.isAbsolute(d)))) {
    throw new RunDescriptorError(`run descriptor ${file}: "sourceDirs" must be an array of absolute paths`);
  }
  if (present(data.extraRepos) && (!Array.isArray(data.extraRepos) || data.extraRepos.some((r) => !r || typeof r.dir !== 'string' || !path.isAbsolute(r.dir) || typeof r.snapshotHash !== 'string'))) {
    throw new RunDescriptorError(`run descriptor ${file}: "extraRepos" must be an array of { dir (absolute path), snapshotHash }`);
  }
  validateActor(data.seatA, 'seatA', 'A');
  validateActor(data.seatB, 'seatB', 'B');
  validateActor(data.auditor, 'auditor', 'auditor');
  validateLayout(data, file);
  if (!Array.isArray(data.verifiers)) throw new RunDescriptorError(`run descriptor ${file}: "verifiers" must be an array`);
  const seen = new Set();
  data.verifiers.forEach((verifier, i) => {
    validateActor(verifier, `verifiers[${i}]`, /^verifier-\d+$/);
    if (seen.has(verifier.role)) throw new RunDescriptorError(`run descriptor ${file}: duplicate verifier role "${verifier.role}"`);
    seen.add(verifier.role);
  });
  if (present(data.support) && (!Array.isArray(data.support) || data.support.some((row) => row === null || typeof row !== 'object' || typeof row.role !== 'string' || !['supported', 'trial'].includes(row.status)))) {
    throw new RunDescriptorError(`run descriptor ${file}: "support" must be a list of { role, runtime, transport, status } rows with status supported or trial`);
  }
  try {
    validateSupport(data);
  } catch (err) {
    throw new RunDescriptorError(`run descriptor ${file}: ${err.message}`);
  }
}

async function readRunDescriptor(runDir) {
  const resolved = path.resolve(runDir);
  const file = path.join(resolved, 'run.json');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    throw new RunDescriptorError(`cannot read run descriptor ${file}: ${err.code ?? err.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new RunDescriptorError(`run descriptor ${file} is not valid JSON: ${err.message}`);
  }
  validate(data, file);
  return { ...data, runDir: resolved };
}

async function writeRunDescriptor(runDir, descriptor) {
  const resolved = path.resolve(runDir);
  const file = path.join(resolved, 'run.json');
  validate(descriptor, file);
  await fs.mkdir(resolved, { recursive: true });
  try {
    await fs.writeFile(file, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw new RunDescriptorError(`${file} already exists; refusing to overwrite a run descriptor`);
    throw err;
  }
  return file;
}

function seatActor(desc, role) {
  if (!SEATS.includes(role)) throw new RunDescriptorError(`seat role must be A or B, got "${role}"`);
  return desc[SEAT_KEYS[role]];
}

function checkPhase(phase) {
  if (!PHASES.includes(phase)) throw new RunDescriptorError(`phase must be ${PHASES.join(' or ')}, got "${phase}"`);
}

function seatOutputDir(desc, phase, role) {
  checkPhase(phase);
  seatActor(desc, role);
  return path.join(desc.runDir, phase, `seat-${role}`);
}

function canonicalName(phase, role) {
  return phase === 'phase1' ? `${role}-findings.md` : `${role}-rebuttals-raw.md`;
}

function canonicalPath(desc, phase, role) {
  checkPhase(phase);
  seatActor(desc, role);
  return path.join(desc.runDir, phase, canonicalName(phase, role));
}

function privateOutputPath(desc, phase, role) {
  return path.join(seatOutputDir(desc, phase, role), canonicalName(phase, role));
}

// A native agent has file tools whatever its vendor, so it writes its own file; a CLI actor follows its runtime.
function channelFor(actor) {
  if (actor.transport === 'native' || actor.runtime === 'claude') return 'file';
  if (actor.runtime === 'codex' || actor.runtime === 'opencode') return 'final-message';
  throw new RunDescriptorError(`no output channel is defined for runtime "${actor.runtime}"`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function publishSeatOutput(desc, phase, role) {
  const actor = seatActor(desc, role);
  if (actor.transport !== 'cli' || channelFor(actor) !== 'file') {
    throw new RunDescriptorError(`seat ${role} is not a file-channel CLI seat; there is nothing to publish`);
  }
  const source = privateOutputPath(desc, phase, role);
  const destination = canonicalPath(desc, phase, role);
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code === 'EEXIST') throw new RunDescriptorError(`${destination} already exists; refusing to overwrite a published seat output`);
    if (err.code === 'ENOENT') throw new RunDescriptorError(`${source} does not exist; seat ${role} wrote no ${phase} output`);
    throw err;
  }
  const sourceSha256 = sha256(await fs.readFile(source));
  const destinationSha256 = sha256(await fs.readFile(destination));
  if (sourceSha256 !== destinationSha256) {
    throw new RunDescriptorError(`published copy ${destination} does not match ${source} (sha256 differs)`);
  }
  return { source, destination, sourceSha256, destinationSha256 };
}

function allActors(desc) {
  return [desc.seatA, desc.seatB, desc.auditor, ...desc.verifiers];
}

function seatTable(desc) {
  return allActors(desc).map((actor) => ({
    role: actor.role, provider: actor.provider, runtime: actor.runtime, model: actor.model, effort: actor.effort,
    transport: actor.transport, sessionId: actor.sessionId, outputDir: actor.outputDir, resultPath: actor.resultPath,
    worktreePath: actor.worktreePath, channel: channelFor(actor),
  }));
}

function grantedFolders(desc, actor) {
  const own = [actor.outputDir];
  if (SEATS.includes(actor.role)) own.push(...PHASES.map((phase) => seatOutputDir(desc, phase, actor.role)));
  return [...new Set([...own, ...(actor.grantDirs ?? []), ...(desc.sourceDirs ?? [])].map((d) => path.resolve(d)))];
}

function norm(p) {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function isInside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// Paths an actor must never be able to read: peers' files and folders, the pre-exchange copies, the mapping.
function protectedPaths(desc, role) {
  const peers = SEATS.includes(role) ? SEATS.filter((s) => s !== role) : SEATS;
  const run = desc.runDir;
  const files = [path.join(run, 'phase3-private', 'seat-to-audit-label.json')];
  const folders = [path.join(run, 'phase1', 'original'), path.join(run, 'phase3-private')];
  for (const peer of peers) {
    files.push(path.join(run, 'phase1', canonicalName('phase1', peer)), path.join(run, 'phase2', canonicalName('phase2', peer)));
    folders.push(...PHASES.map((phase) => path.join(run, phase, `seat-${peer}`)));
  }
  return { files, folders };
}

// Bounded walk of an existing grant for forbidden names, so a file dropped into an own folder is still found.
async function findForbiddenName(folder, role, peers) {
  const own = canonicalName('phase1', role);
  let budget = 2000;
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (--budget < 0) return null;
      const full = path.join(dir, entry.name);
      const peerFile = peers.some((peer) => entry.name === canonicalName('phase1', peer) || entry.name === canonicalName('phase2', peer));
      if (entry.isDirectory()) {
        if (entry.name === 'original') return full;
        if (depth < 4) {
          const hit = await walk(full, depth + 1);
          if (hit) return hit;
        }
      } else if (peerFile || MAPPING_FILE.test(entry.name) || (entry.name !== own && /^[AB]-findings\.md$/.test(entry.name))) {
        return full;
      }
    }
    return null;
  };
  return walk(folder, 0);
}

async function assertGrantsIsolated(desc) {
  for (const actor of allActors(desc)) {
    const { files, folders } = protectedPaths(desc, actor.role);
    const peers = SEATS.includes(actor.role) ? SEATS.filter((s) => s !== actor.role) : SEATS;
    for (const grant of grantedFolders(desc, actor)) {
      const exposed = files.find((f) => isInside(f, grant)) ?? folders.find((f) => isInside(f, grant) || isInside(grant, f));
      if (exposed) {
        throw new RunDescriptorError(`actor "${actor.role}" is granted ${grant}, which would expose ${exposed}`);
      }
      if (isInside(grant, desc.runDir)) {
        const hit = await findForbiddenName(grant, actor.role, peers);
        if (hit) throw new RunDescriptorError(`actor "${actor.role}" is granted ${grant}, which holds ${hit}`);
      }
    }
  }
}

export {
  RunDescriptorError, readRunDescriptor, writeRunDescriptor, seatOutputDir, canonicalPath, privateOutputPath, channelFor, publishSeatOutput,
  assertGrantsIsolated, seatTable, grantedFolders,
};
