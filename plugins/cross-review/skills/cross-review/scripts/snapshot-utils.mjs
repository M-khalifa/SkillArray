// Content-hash inventory of a plain directory, for targets that are not git repositories.
// Gives preflight a snapshotHash and the dispatchers a touchedFiles list when git status cannot.
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { entryKey, entrySha256, nameBytes } from './path-utils.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const GIT_ONLY = new Set(['.git']);
// Python writes these when code runs; skipCaches leaves them out of a source snapshot's hash.
const CACHE_DIRS = new Set(['__pycache__', '.pytest_cache']);
const CACHE_FILE_RE = /\.py[co]$/;
export const DEFAULT_MAX_FILES = 20000;

// Returns { files: { 'rel/path': sha256 }, snapshotHash }, plus skippedCaches (the cache folders and
// files left out) when skipCaches is set. Paths use '/' on every platform.
// Throws when the tree holds more than maxFiles files, rather than hashing a partial tree.
// node_modules is left out (a source snapshot) unless includeDependencies is set (write detection).
export async function hashInventory(dir, { maxFiles = DEFAULT_MAX_FILES, skipCaches = false, includeDependencies = false } = {}) {
  const skipDirs = includeDependencies ? GIT_ONLY : SKIP_DIRS;
  const rels = [];
  const skippedCaches = [];
  // Names are read as bytes: a Linux name need not be valid UTF-8 (nor a Windows one valid UTF-16), and its decoded
  // text names no file. Such a path is kept as a Buffer, and its relative bytes as raw (null for every valid path).
  async function walk(abs, rel, relRaw) {
    const entries = await readdir(abs, { withFileTypes: true, encoding: 'buffer' });
    for (const entry of entries) {
      const name = entry.name.toString('utf8');
      const exact = Buffer.from(name, 'utf8').equals(entry.name);
      const relPath = rel ? `${rel}/${name}` : name;
      const raw = relRaw || !exact ? Buffer.concat([...(rel ? [relRaw ?? Buffer.from(rel, 'utf8'), Buffer.from('/')] : []), entry.name]) : null;
      const childAbs = typeof abs === 'string' && exact ? path.join(abs, name) : Buffer.concat([Buffer.isBuffer(abs) ? abs : Buffer.from(abs, 'utf8'), Buffer.from(path.sep), entry.name]);
      if (entry.isDirectory()) {
        if (skipDirs.has(name)) continue;
        if (skipCaches && CACHE_DIRS.has(name)) { skippedCaches.push(`${relPath}/`); continue; }
        await walk(childAbs, relPath, raw);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // A link (or junction) is recorded by its link text and never walked, so retargeting it changes the hash.
        if (skipCaches && CACHE_FILE_RE.test(name)) { skippedCaches.push(relPath); continue; }
        rels.push({ text: relPath, raw, abs: childAbs });
        if (rels.length > maxFiles) {
          throw Object.assign(new Error(`"${dir}" holds more than ${maxFiles} files; refusing a partial inventory`), { code: 'INVENTORY_TOO_LARGE' });
        }
      }
    }
  }
  await walk(dir, '', null);
  rels.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : entryKey(a) < entryKey(b) ? -1 : 1));
  const files = {};
  const combined = createHash('sha256');
  combined.update('inventory-v1\n');
  for (const entry of rels) {
    const hash = await entrySha256(entry.abs);
    files[entryKey(entry)] = hash;
    // For a valid name nameBytes is its UTF-8 text, so this hashes exactly as the text line did.
    combined.update(nameBytes(entry));
    combined.update(`:${hash}\n`);
  }
  const result = { files, snapshotHash: combined.digest('hex') };
  if (skipCaches) result.skippedCaches = skippedCaches.sort();
  return result;
}

// Inventory for write detection: node_modules is hashed too. A tree too large with it falls back to the
// source-only inventory and reports dependenciesCovered: false; includeDependencies: false asks for that
// directly, so an after-run inventory compares like with like against a baseline that lacked dependencies.
export const DEPENDENCIES_NOTE = 'node_modules was not inventoried (too many files); a write under it is not detected';
export async function hashWriteInventory(dir, options = {}) {
  if (options.includeDependencies !== false) {
    try {
      return { ...(await hashInventory(dir, { ...options, includeDependencies: true })), dependenciesCovered: true };
    } catch (err) {
      if (err.code !== 'INVENTORY_TOO_LARGE') throw err;
    }
  }
  return { ...(await hashInventory(dir, { ...options, includeDependencies: false })), dependenciesCovered: false };
}

// Paths added, removed, or changed between two hashInventory().files maps, sorted.
export function diffInventories(before, after) {
  const changed = new Set();
  for (const [rel, hash] of Object.entries(after)) {
    if (before[rel] !== hash) changed.add(rel);
  }
  for (const rel of Object.keys(before)) {
    if (!Object.hasOwn(after, rel)) changed.add(rel);
  }
  return [...changed].sort();
}
