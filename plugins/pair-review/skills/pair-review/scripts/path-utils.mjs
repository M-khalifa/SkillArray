// Path and file-entry helpers that see through symlinks (macOS /tmp -> /private/tmp, a symlinked
// home or skills folder) and git calls that ignore the user's diff settings.
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs, realpathSync as jsRealpath } from 'node:fs';

// The native realpath restores the on-disk case on case-insensitive volumes (macOS APFS, Windows), where the JS
// implementation keeps the case the caller typed: "myrepo" for a folder on disk called "MyRepo" must equal git's spelling.
const realpathSync = jsRealpath.native;
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real path of p: the nearest existing ancestor is resolved and the missing rest appended, so a
// folder that does not exist yet still compares equal to its real parent's children.
export function realPath(p) {
  const abs = path.resolve(p);
  const rest = [];
  for (let cur = abs; ; ) {
    try {
      return rest.length > 0 ? path.join(realpathSync(cur), ...rest) : realpathSync(cur);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

// The form two paths are compared in: real path, case-folded only on Windows.
export function comparablePath(p) {
  const real = realPath(p);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

export function isInsidePath(child, parent) {
  const c = comparablePath(child);
  const p = comparablePath(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// The lexical and the real spelling of p, without duplicates.
export function pathSpellingsOf(p) {
  return [...new Set([path.resolve(p), realPath(p)])];
}

// True when the module at metaUrl is the script node was started with, also through a symlinked path:
// node loads the main module by its real path, so import.meta.url never equals a symlinked argv[1].
export function isMainModule(metaUrl) {
  if (typeof process.argv[1] !== 'string') return false;
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  try {
    return fold(realpathSync(fileURLToPath(metaUrl))) === fold(realpathSync(path.resolve(process.argv[1])));
  } catch {
    return metaUrl === pathToFileURL(path.resolve(process.argv[1])).href;
  }
}

// Content hash of one directory entry; a symlink hashes as its link text, so a dangling link or a
// link to a folder hashes instead of failing with ENOENT or EISDIR. The "link:" prefix keeps it apart from any file hash.
export async function entrySha256(filePath) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) return `link:${createHash('sha256').update(await fs.readlink(filePath)).digest('hex')}`;
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Copies one entry; a symlink is recreated as the same link instead of followed.
export async function copyEntry(src, dest) {
  const stat = await fs.lstat(src);
  if (!stat.isSymbolicLink()) return fs.copyFile(src, dest);
  const link = await fs.readlink(src);
  let type;
  if (process.platform === 'win32') {
    // A dangling link is most often a junction whose folder is gone; only a link to an existing file is a file link.
    const isFile = (await fs.stat(src).catch(() => null))?.isFile();
    type = isFile ? 'file' : path.isAbsolute(link) ? 'junction' : 'dir';
  }
  try {
    return await fs.symlink(link, dest, type);
  } catch (err) {
    // Windows without the symlink privilege: copy what the link points to, or skip a dangling link.
    if (err.code !== 'EPERM') throw err;
    if ((await fs.stat(src).catch(() => null))?.isFile()) return fs.copyFile(src, dest);
  }
}

// A git -z name list as entries { text, raw }. A Linux file name need not be valid UTF-8, and decoding it loses bytes
// the file system needs: raw keeps them (a Buffer) for such a name and is null for every other. text is for display,
// sorting and JSON; two fingerprints of the same tree decode a name the same way, so comparing text stays consistent.
export function gitNames(stdout) {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8');
  const entries = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0) continue;
    if (i > start) {
      const raw = buf.subarray(start, i);
      const text = raw.toString('utf8');
      entries.push({ text, raw: Buffer.from(text, 'utf8').equals(raw) ? null : Buffer.from(raw) });
    }
    start = i + 1;
  }
  return entries;
}

// The file system path of a gitNames entry under dir: a string, or a Buffer when its name is not valid UTF-8.
export function entryPath(dir, entry) {
  if (!entry.raw) return path.join(dir, entry.text);
  return Buffer.concat([Buffer.from(dir.endsWith(path.sep) ? dir : dir + path.sep, 'utf8'), entry.raw]);
}

// A key for a gitNames entry: its text, plus its bytes in hex when its name is not valid UTF-8, because every
// invalid byte decodes to the same replacement character and two such names would share one key.
export function entryKey(entry) {
  return entry.raw ? `${entry.text} [bytes ${entry.raw.toString('hex')}]` : entry.text;
}

// The bytes a gitNames entry's name is hashed as: for a valid name exactly the UTF-8 text hashed before.
export function nameBytes(entry) {
  return entry.raw ?? Buffer.from(entry.text, 'utf8');
}

// `git diff` options that make the output independent of the user's git config: no colour, no
// external diff or textconv, a/ and b/ prefixes, 3 context lines (git apply needs them), file names unquoted.
export const GIT_PLAIN = ['-c', 'color.diff=false', '-c', 'core.quotepath=false', '-c', 'diff.context=3'];
export const DIFF_PLAIN = ['--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
