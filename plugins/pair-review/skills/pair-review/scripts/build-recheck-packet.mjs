#!/usr/bin/env node
// Drafts the task packet for a re-review of an earlier run: the old packet with the old findings as hypotheses
// to confirm or refute, and a summary of what changed since. What only the author knows stays marked "FILL".
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { firstSentence, expandTagRange, splitTicketEntries, TICKETS_LINE_RE } from './build-report.mjs';
import { isMainModule } from './path-utils.mjs';

class PacketError extends Error {}

const HELP = `build-recheck-packet.mjs: a draft task packet for a re-review of an earlier run.

Usage:
  node build-recheck-packet.mjs --from-run <old-run-dir> --out <new-packet.md> [--since-diff <diff-file>]
      [--target <new-target-dir>] [--title "<title line>"] [--skip F7,F8] [--drop-tag AC-OWN-D]...

Reads <old-run-dir>/task-packet.md and <old-run-dir>/phase3/findings.json and writes a new packet:
  - the old packet's sections, kept as they were, except the ones below;
  - "What changed since the previous review": the files and +/- line counts from --since-diff (a unified diff,
    for example git diff --no-index between the two snapshots), with a FILL line for why each change was made;
  - "Hypotheses to test": every previous finding as [H1], [H2], ... to confirm fixed or refute (previous hypotheses
    are dropped; their numbers would clash);
  - any older "What changed since ..." section is replaced by the new one, and "Known deviations" gets a FILL line;
  - "Evidence both seats may cite": reset to FILL, because the old snapshot hash and test counts are stale.
  - "Author-reported evidence (not reproducible; do not cite as EXECUTED)": a FILL slot after the evidence section.
Options:
  --target <dir>     the new target folder: the old target path in the packet is rewritten (the old target comes from the
                     old run's run.json). The old run folder path is always rewritten to the folder of --out.
  --title "<text>"   the packet's title line, instead of "Task packet: re-review of <old title>".
  --skip F7,F8       leave these previous findings out of the hypotheses (settled, nothing left to re-check).
  --drop-tag <tag>   remove a criterion tag: its "- [tag]" bullet and its entry in the Tickets line (repeat or comma-separate).
--out is never overwritten. Every "FILL" marker must be replaced before the seats start; the script lists them.
`;

export function parseArgs(argv) {
  const args = { fromRun: null, out: null, sinceDiff: null, target: null, title: null, skip: [], dropTags: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new PacketError(`${tok} requires a value`);
      return v;
    };
    if (tok === '--from-run') args.fromRun = value();
    else if (tok === '--out') args.out = value();
    else if (tok === '--since-diff') args.sinceDiff = value();
    else if (tok === '--target') args.target = value();
    else if (tok === '--title') args.title = value();
    else if (tok === '--skip') args.skip.push(...value().split(',').map((x) => x.trim()).filter(Boolean));
    else if (tok === '--drop-tag') args.dropTags.push(...value().split(',').map((x) => x.trim()).filter(Boolean));
    else if (tok === '-h' || tok === '--help') args.help = true;
    else throw new PacketError(`unrecognized argument: ${tok}`);
  }
  if (!args.help && (!args.fromRun || !args.out)) throw new PacketError('--from-run <dir> and --out <file> are required');
  return args;
}

// Splits a packet into its preamble (the title and anything before the first "## ") and its "## " sections, in order.
export function splitSections(text) {
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = { title: h[1], body: [] };
      sections.push(current);
    } else if (current) current.body.push(line);
    else preamble.push(line);
  }
  return { preamble: preamble.join('\n'), sections: sections.map((s) => ({ title: s.title, body: s.body.join('\n').replace(/\s+$/, '') })) };
}

// A path from a diff header: git quotes names with unusual characters as "a/dir/caf\303\251.md".
function diffPath(raw) {
  let text = raw.trim().replace(/\t.*$/, '');
  if (text.startsWith('"') && text.endsWith('"')) {
    const bytes = [];
    const body = text.slice(1, -1);
    for (let i = 0; i < body.length; i += 1) {
      const octal = /^\\([0-7]{3})/.exec(body.slice(i));
      if (octal) {
        bytes.push(parseInt(octal[1], 8));
        i += 3;
      } else if (body[i] === '\\' && 'tnr"\\'.includes(body[i + 1])) {
        bytes.push({ t: 9, n: 10, r: 13, '"': 34, '\\': 92 }[body[i + 1]]);
        i += 1;
      } else bytes.push(...Buffer.from(body[i], 'utf8'));
    }
    text = Buffer.from(bytes).toString('utf8');
  }
  return text.replace(/^[ab]\//, '');
}

// Files and added/removed line counts from a unified diff (git or plain `diff -u`). Hunk headers say how many lines a hunk
// holds, so a changed line that starts with "--" or "++" is still counted.
export function diffSummary(diffText) {
  const files = [];
  let current = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldHeader = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) { current.added += 1; newLeft -= 1; continue; }
      if (line.startsWith('-')) { current.removed += 1; oldLeft -= 1; continue; }
      if (line.startsWith(' ') || line === '') { oldLeft -= 1; newLeft -= 1; continue; }
      if (line.startsWith('\\')) continue;
    }
    if (line.startsWith('diff --git ')) {
      current = { path: null, added: 0, removed: 0 };
      files.push(current);
      oldHeader = null;
    } else if (line.startsWith('--- ')) {
      oldHeader = diffPath(line.slice(4));
    } else if (line.startsWith('+++ ') && oldHeader !== null) {
      const newPath = diffPath(line.slice(4));
      const name = newPath === '/dev/null' ? oldHeader : newPath;
      if (current === null || current.path !== null) {
        current = { path: name, added: 0, removed: 0 };
        files.push(current);
      } else current.path = name;
      oldHeader = null;
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
      if (hunk && current) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      }
    }
  }
  return files.filter((f) => f.path !== null);
}

const FINDING_CAP = 120;
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function findingHypothesis(f, n) {
  const first = firstSentence(oneLine(f.title ?? f.summary));
  const title = first.length > FINDING_CAP ? `${first.slice(0, FINDING_CAP - 3).trimEnd()}...` : first;
  const severity = String(f.severity_audited ?? f.severity ?? 'unknown').toLowerCase();
  return `- [H${n}] Previous finding ${f.id} (${severity}, ${f.final_state ?? 'unknown'}): ${title} Confirm it is fixed, or refute it with evidence.`;
}

// Removes a criterion tag: its bullet line and its entry in a "Tickets:" line (a ticket left with no tag is dropped too).
// A range that holds the tag ("AC-6040-1..-5") is written out without it; the packet keeps its line ending.
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function dropTagFromPacket(text, tags) {
  if (tags.length === 0) return text;
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    if (tags.some((t) => new RegExp(`^\\s*[-*]\\s+\\**\\[${escapeRe(t)}\\]`).test(line))) continue;
    const m = TICKETS_LINE_RE.exec(line);
    let changed = false;
    const parts = m ? splitTicketEntries(m[2]).map((part) => {
      const t = /^(\s*#?\d+\s*[=:]\s*)(.+?)\s*$/.exec(part);
      if (!t) return part;
      const kept = t[2].split(/[,\s]+/).filter(Boolean).flatMap((x) => {
        const all = expandTagRange(x.replace(/^\[|\]$/g, ''));
        if (!all.some((tag) => tags.includes(tag))) return [x];
        changed = true;
        return all.filter((tag) => !tags.includes(tag));
      });
      return kept.length > 0 ? `${t[1]}${kept.join(', ')}` : null;
    }).filter((p) => p !== null && p.trim() !== '') : [];
    if (!changed) lines.push(line);
    else if (parts.length > 0) lines.push(`${m[1]}${parts.join(';').replace(/^\s+/, '')}`);
  }
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
}

export function buildRecheckPacket({ oldPacket, findingsDoc, diffText = '', previousRun = 'the previous run', title = null, skip = [], dropTags = [] }) {
  if (!findingsDoc || !Array.isArray(findingsDoc.findings)) throw new PacketError('findings.json has no "findings" array');
  const { preamble, sections } = splitSections(oldPacket);
  const lines = preamble.split('\n');
  const titleIndex = lines.findIndex((l) => /^#\s+/.test(l));
  const oldTitle = titleIndex >= 0 ? lines[titleIndex].replace(/^#\s+(?:Task packet\b[^:]*:\s*)?/i, '') : 'the target';
  const titleLine = title ? `# ${title.replace(/^#+\s*/, '')}` : `# Task packet: re-review of ${oldTitle}`;
  if (titleIndex >= 0) lines[titleIndex] = titleLine;
  else lines.unshift(titleLine);
  const intro = `This is a re-review of ${previousRun}. Those findings are listed below as hypotheses only. Confirm or refute each from the code as it is now; do not assume a fix works because a change touched the line.`;
  const head = `${lines.join('\n').replace(/\s+$/, '')}\n\n${intro}`;

  const files = diffSummary(diffText);
  const shown = files.slice(0, 40).map((f) => `- ${f.path} (+${f.added} -${f.removed})`);
  const changed = [
    ...(files.length > 0 ? shown : ['- FILL: the files changed since the previous review (no --since-diff was given)']),
    ...(files.length > 40 ? [`- ... and ${files.length - 40} more file(s)`] : []),
    'FILL: why each change was made, and which previous finding it answers.',
  ].join('\n');

  const previous = findingsDoc.findings.filter((f) => !skip.includes(f.id));
  const hypotheses = previous.length > 0
    ? ['In `## Checks performed`, end each hypothesis line with CONFIRMED, REFUTED or PARTLY CONFIRMED; the report prints that outcome.', ...previous.map((f, i) => findingHypothesis(f, i + 1))].join('\n')
    : '- FILL: the previous review had no findings; list what to re-check, or delete this section.';

  const evidence = "FILL: this run's pre-flight summary (HEAD, snapshotHash, test results and log paths). The previous run's hash and counts no longer apply.";
  const out = [];
  let sawHypotheses = false;
  let sawChanged = false;
  for (const s of sections) {
    const key = s.title.toLowerCase();
    if (key.startsWith('hypotheses')) {
      if (!sawHypotheses) out.push({ title: 'Hypotheses to test', body: hypotheses });
      sawHypotheses = true;
    } else if (key.startsWith('what changed since')) {
      if (!sawChanged) out.push({ title: 'What changed since the previous review', body: changed });
      sawChanged = true;
    } else if (key.startsWith('evidence both seats may cite')) {
      out.push({ title: 'Evidence both seats may cite', body: evidence });
      out.push({ title: 'Author-reported evidence (not reproducible; do not cite as EXECUTED)', body: 'FILL: results the author ran that the seats cannot repeat, or write "none".' });
    } else if (key.startsWith('author-reported evidence')) {
      // The earlier author's results do not carry over; the slot after the evidence section replaces it.
    } else if (key.startsWith('known deviations')) {
      out.push({ title: s.title, body: `${s.body}
FILL: which of these deviations still apply to the changed code, and any new one.`.replace(/^\n/, '') });
    } else out.push(s);
    if (key === 'scope' && !sawChanged) {
      out.push({ title: 'What changed since the previous review', body: changed });
      sawChanged = true;
    }
  }
  if (!sawChanged) out.unshift({ title: 'What changed since the previous review', body: changed });
  if (!sawHypotheses) out.push({ title: 'Hypotheses to test', body: hypotheses });
  const text = `${dropTagFromPacket(`${head}\n\n${out.map((s) => `## ${s.title}\n${s.body}`).join('\n\n')}`, dropTags)}\n`;
  const fills = text.split('\n').map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => /\bFILL:/.test(l)).map(({ l, n }) => ({ line: n, text: l.trim().slice(0, 100) }));
  return { text, fills };
}

// Replaces a folder path wherever the packet writes it, with either slash style; a Windows path (drive letter or UNC) in any case.
// The path must end there: at a separator, a space, a quote, a closing bracket, punctuation or the end ("old(backup)" is another folder).
const windowsPath = (p) => /^(?:[A-Za-z]:|[\\/]{2})/.test(p);
export function rewritePaths(text, pairs) {
  const map = new Map();
  for (const [from, to] of pairs) {
    if (!from || !to || from === to) continue;
    for (const v of new Set([from, from.split('\\').join('/'), from.split('/').join('\\')])) map.set(windowsPath(v) ? v.toLowerCase() : v, to);
  }
  if (map.size === 0) return text;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp('(' + keys.map(escapeRe).join('|') + ')(?=$|[\\\\/\\s"\'`)\\]>,;:|*]|\\.(?![A-Za-z0-9_-]))', keys.some(windowsPath) ? 'gi' : 'g');
  return text.replace(re, (hit) => map.get(windowsPath(hit) ? hit.toLowerCase() : hit) ?? hit);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const run = path.resolve(args.fromRun);
  const read = async (file, what) => {
    try {
      const text = await readFile(file, 'utf8');
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } catch (err) {
      throw new PacketError(`cannot read ${what} ${file}: ${err.message}`);
    }
  };
  const readJson = async (file, what) => {
    const text = await read(file, what);
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new PacketError(`${what} ${file} is not valid JSON: ${err.message}`);
    }
  };
  const oldPacket = await read(path.join(run, 'task-packet.md'), 'the previous task packet');
  const findingsDoc = await readJson(path.join(run, 'phase3', 'findings.json'), 'the previous findings');
  const diffText = args.sinceDiff ? await read(path.resolve(args.sinceDiff), '--since-diff') : '';
  const out = path.resolve(args.out);
  if (existsSync(out)) throw new PacketError(`${out} already exists; it is never overwritten`);
  if (diffText.trim() !== '' && diffSummary(diffText).length === 0) throw new PacketError(`no changed files found in --since-diff ${args.sinceDiff} (expected a unified diff with "diff --git" or "--- / +++" headers)`);
  let oldTarget = null;
  try {
    oldTarget = JSON.parse((await readFile(path.join(run, 'run.json'), 'utf8')).replace(/^\uFEFF/, '')).targetDir ?? null;
  } catch {
    oldTarget = null;
  }
  const built = buildRecheckPacket({ oldPacket, findingsDoc, diffText, previousRun: `the review in ${path.basename(run)}`, title: args.title, skip: args.skip, dropTags: args.dropTags });
  const pairs = [[run, path.dirname(out)], ...(args.target && oldTarget ? [[path.resolve(oldTarget), path.resolve(args.target)]] : [])];
  const text = rewritePaths(built.text, pairs);
  const fills = built.fills;
  if (args.target && !oldTarget) process.stderr.write('build-recheck-packet: WARNING: the old run has no run.json targetDir, so the old target path was not rewritten\n');
  await writeFile(out, text, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`build-recheck-packet: wrote ${out}\n${fills.length} FILL marker(s) to complete before the seats start:\n${fills.map((f) => `  line ${f.line}: ${f.text}`).join('\n')}\n`);
}

if (isMainModule(import.meta.url)) {
  // A reader that stops early (head, Select-Object -First) closes the pipe: the rest of the output is dropped, the exit code stays.
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') return;
    throw err;
  });
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`build-recheck-packet: ${err.message}\n`);
    process.exitCode = err instanceof PacketError ? 1 : 2;
  });
}
