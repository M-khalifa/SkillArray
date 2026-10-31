// Drafts the task packet for a re-review of an earlier run: the old packet with the old findings as hypotheses
// to confirm or refute, and a summary of what changed since. What only the author knows stays marked "FILL".
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { firstSentence, stepBackNote, expandTagRange, splitTicketEntries, TICKETS_LINE_RE, notesSections, findingStatus, outcomeOf, evidenceLocations, diffPath } from './build-report.mjs';
import { comparablePath, NAME_CONTINUES, pathSpellingsOf } from './path-utils.mjs';
import { driftedFiles, fingerprintFiles } from './preflight.mjs';
import { makeIo, refuseDirectRun, runStep as runStepWith } from './step-io.mjs';

class PacketError extends Error {}
const io = makeIo();


export function parseArgs(argv) {
  const args = { fromRun: null, out: null, sinceDiff: null, sinceDirs: null, sinceOnly: [], target: null, repoTargets: [], title: null, skip: [], dropTags: [], notes: null, round: null, sinceCommit: null, preflight: null };
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
    else if (tok === '--since-commit') args.sinceCommit = value();
    else if (tok === '--preflight') args.preflight = value();
    else if (tok === '--since-dirs') (args.sinceDirs ??= []).push([value(), value()]);
    else if (tok === '--since-only') args.sinceOnly.push(...value().split(',').map((x) => x.trim()).filter(Boolean));
    else if (tok === '--target') args.target = value();
    else if (tok === '--repo-target') {
      const v = value();
      // A path may hold "=": split where the right side starts like a path (a drive, a slash or ./ ../), else at the first "=".
      const splits = [...v.matchAll(/=/g)].map((m) => m.index);
      const at = splits.find((i) => /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])/.test(v.slice(i + 1))) ?? splits[0] ?? -1;
      if (at <= 0 || at === v.length - 1) throw new PacketError(`--repo-target "${v}" must look like <old repo path>=<new repo path>`);
      args.repoTargets.push([v.slice(0, at), v.slice(at + 1)]);
    }
    else if (tok === '--title') args.title = value();
    else if (tok === '--notes') args.notes = value();
    else if (tok === '--round') {
      const v = value();
      if (!/^[1-9]\d*$/.test(v)) throw new PacketError(`--round must be a whole number from 1, not "${v}"`);
      args.round = Number(v);
    }
    else if (tok === '--skip') args.skip.push(...value().split(',').map((x) => x.trim()).filter(Boolean));
    else if (tok === '--drop-tag') args.dropTags.push(...value().split(',').map((x) => x.trim()).filter(Boolean));
    else throw new PacketError(`unrecognized argument: ${tok}`);
  }
  if (!args.fromRun || !args.out) throw new PacketError('--from-run <dir> and --out <file> are required');
  if ([args.sinceDiff, args.sinceDirs, args.sinceCommit].filter(Boolean).length > 1) throw new PacketError('--since-diff, --since-dirs and --since-commit each name the change; give one');
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
      // A binary, empty or mode-only change has no ---/+++ lines: its name comes from this header.
      const named = /^diff --git (?:"a\/.*?"|a\/.*?) ("b\/.*"|b\/.*)$/.exec(line);
      current = { path: null, headerPath: named ? diffPath(named[1]) : null, added: 0, removed: 0 };
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
  // A .git folder inside a snapshot (a clone or a worktree pointer) is not part of the change.
  return files.map((f) => ({ path: f.path ?? f.headerPath ?? null, added: f.added, removed: f.removed }))
    .filter((f) => f.path !== null && !/(?:^|\/)\.git(?:\/|$)/.test(f.path));
}

// High enough for a whole summary; only a runaway one is cut.
const FINDING_CAP = 1200;
const SAME_SHAPE_CAP = 300;
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// A previous finding as a suspected defect, so CONFIRMED means it is still there (the template's polarity rule). The whole
// summary is kept (seats need the failing input), with the first file:line of its evidence that names a changed file (an
// evidence entry also quotes test inputs such as "src/app/handler.py:40"), else the first one.
const evidenceLocation = (entries, changed = []) => {
  const all = evidenceLocations(entries);
  // Either side may be the longer one: "preflight.mjs" for a changed "plugins/.../preflight.mjs", or an absolute path.
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p).replace(/\\/g, '/');
  const file = (loc) => norm(loc.replace(/:\d+$/, ''));
  return all.find((loc) => changed.map(norm).some((c) => c === file(loc) || c.endsWith(`/${file(loc)}`) || file(loc).endsWith(`/${c}`))) ?? all[0] ?? null;
};

export function findingHypothesis(f, n, preExisting = false, changed = []) {
  const text = oneLine(f.summary || f.title);
  const body = text.length > FINDING_CAP ? `${text.slice(0, FINDING_CAP - 3).trimEnd()}...` : text;
  const where = evidenceLocation(f.evidence, changed);
  const severity = String(f.severity_audited ?? f.severity ?? 'unknown').toLowerCase();
  // The outcome rule is stated once, on the section's first line: words such as CONFIRMED or REFUTED here would be read as an
  // outcome when a seat quotes the line.
  const sites = (Array.isArray(f.same_shape) ? f.same_shape : []).map((s) => oneLine(String(s).replace(/^[AB]\d+:\s*/, '')))
    .filter((s) => s !== '' && !/^none\b/i.test(s)).join('; ');
  const also = sites === '' ? '' : ` Also check the same shape at: ${sites.length > SAME_SHAPE_CAP ? `${sites.slice(0, SAME_SHAPE_CAP - 3).trimEnd()}...` : sites}`;
  return `- [H${n}] Previous finding ${f.id} (${severity}, ${f.final_state ?? 'unknown'}${preExisting ? ', pre-existing' : ''}) is still present: ${body.replace(/([^.?!])$/, '$1.')}${where ? ` It was at ${where}.` : ''}${also}`;
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

// The author's outcome per finding id, from the previous run's report notes ("## Finding status", first word only).
export function notesOutcomes(notesText) {
  const out = new Map();
  for (const [id, status] of findingStatus(notesSections(notesText)['finding status'] ?? '')) {
    const o = outcomeOf(status);
    if (o) out.set(id, o);
  }
  return out;
}

const SETTLED_OUTCOMES = ['wrong', 'intentional', 'not-worth-it', 'decided'];

// The evidence section from this run's evidence preflight (--compact --out): snapshot, each repository's HEAD, each command's result.
export function preflightEvidence(result, file) {
  const lines = [`From ${file} (preflight.mjs; seats may cite these):`];
  const t1 = result?.tier1 ?? {};
  const changed = Array.isArray(t1.changedFiles) ? `; ${t1.changedFiles.length} changed file(s)${t1.base ? ` since ${t1.base.slice(0, 12)}` : ''}` : '';
  lines.push(`- snapshotHash ${result?.snapshotHash ?? 'unknown'}${changed}`);
  for (const r of Array.isArray(result?.repos) ? result.repos : []) {
    if (r?.head) lines.push(`- ${r.path}: ${r.branch ?? 'detached'} at ${r.head}${r.dirty ? ', with uncommitted changes' : ''}`);
  }
  const tiers = [result?.tier2, ...(Array.isArray(result?.tier2Repos) ? result.tier2Repos : [])].filter((x) => x && Array.isArray(x.results));
  for (const tier of tiers) {
    for (const r of tier.results) {
      const exit = r.timedOut ? `timed out after ${r.timeoutS ?? '?'} s` : `exit ${r.exitCode}`;
      // The last summary line, as preflight's own summary prints it (a test runner's fail count comes last).
      const last = [(r.stdout?.summary ?? []).at(-1), (r.stdout?.tail ?? []).at(-1)].find((l) => typeof l === 'string' && l.trim() !== '');
      const log = `${r.stdout?.log ? `; log ${r.stdout.log}` : ''}${r.stderr?.log && r.stderr.bytes !== 0 ? `; stderr log ${r.stderr.log}` : ''}`;
      lines.push(`- \`${r.command}\`: ${exit}${last ? ` (${last.trim().slice(0, 120)})` : ''}${log}`);
      if (r.leftoverGroupStopped || r.leftoversStopped?.length > 0) lines.push(`- WARNING: \`${r.command}\` left process(es) running; preflight stopped them`);
      if (r.outputHeldOpen) lines.push(`- WARNING: \`${r.command}\` left a process holding its output open; it may still be running`);
    }
    if (tier.targetChanged) lines.push(`- WARNING: a command changed the target${tier.path ? ` ${tier.path}` : ''} during the run (snapshotHash ${tier.snapshotHash ?? 'unknown'} -> ${tier.snapshotHashAfter ?? 'unknown'}); these results are not of the reviewed snapshot`);
  }
  if (result?.execInChangedTarget) lines.push('- WARNING: an --exec-in command changed files of the target; its snapshotHash above is stale, so these results are not of the reviewed snapshot');
  if (tiers.length === 0) lines.push('- no test command was run (no --exec)');
  return lines.join('\n');
}

export function buildRecheckPacket({ oldPacket, findingsDoc, diffText = '', drift = [], previousRun = 'the previous run', title = null, skip = [], dropTags = [], outcomes = new Map(), round = null, evidenceText = null }) {
  if (!findingsDoc || !Array.isArray(findingsDoc.findings)) throw new PacketError('findings.json has no "findings" array');
  // The hypotheses of a re-review packet are the previous findings (H1..Hn), so an H tag would delete a finding silently.
  const hypothesisTags = dropTags.filter((t) => /^H\d+$/i.test(t));
  if (hypothesisTags.length > 0) throw new PacketError(`--drop-tag ${hypothesisTags.join(', ')} names a hypothesis; in a re-review packet H1..Hn are the previous findings, so dropping one would remove a finding without a trace: leave a finding out with --skip F<n> (it is then listed under Known deviations); nothing was written`);
  const { preamble, sections } = splitSections(oldPacket);
  // A recheck of a recheck: the earlier intro is replaced, not kept beside the new one (it names the wrong round).
  const oldRound = /^Review round:\s*(\d+)\s*$/m.exec(preamble);
  const reviewRound = round ?? (oldRound ? Number(oldRound[1]) + 1 : 2);
  const lines = preamble.split('\n').filter((l) => !/^This is a re-review of\b/.test(l) && !/^Review round:/.test(l));
  const titleIndex = lines.findIndex((l) => /^#\s+/.test(l));
  let oldTitle = titleIndex >= 0 ? lines[titleIndex].replace(/^#\s+(?:Task packet\b[^:]*:\s*)?/i, '') : 'the target';
  // The default title wraps the oldest title once, whatever the round.
  while (/^re-review after fixes \(previous: .*\)$/.test(oldTitle)) oldTitle = oldTitle.replace(/^re-review after fixes \(previous: (.*)\)$/, '$1');
  // Preamble lines besides the title (a Target line with branch and HEAD) are the previous round's facts too.
  const preambleFacts = lines.some((l, i) => i !== titleIndex && l.trim() !== '');
  const titleLine = title ? `# ${title.replace(/^#+\s*/, '')}` : `# Task packet: re-review after fixes (previous: ${oldTitle})`;
  if (titleIndex >= 0) lines.splice(titleIndex, 1, titleLine, `Review round: ${reviewRound}`);
  else lines.unshift(titleLine, `Review round: ${reviewRound}`);
  const intro = `This is a re-review of ${previousRun}. Those findings are listed below as hypotheses only. Confirm or refute each from the code as it is now; do not assume a fix works because a change touched the line.`;
  const preambleStale = preambleFacts ? '\nFILL: the lines above are from the previous packet; update the branch, HEAD and anything else that changed.' : '';
  const head = `${lines.join('\n').replace(/\s+$/, '')}${preambleStale}\n\n${intro}`;

  const files = diffSummary(diffText);
  const shown = files.slice(0, 40).map((f) => `- ${f.path} (+${f.added} -${f.removed})`);
  const changed = [
    ...(files.length > 0 ? shown
      : drift.length > 0 ? [...drift.slice(0, 40).map((p) => `- ${p}`), ...(drift.length > 40 ? [`- ... and ${drift.length - 40} more file(s)`] : []), '(listed from the previous run snapshot; no line counts without --since-diff)']
        : ['- FILL: the files changed since the previous review (no --since-commit, --since-dirs or --since-diff was given)']),
    ...(files.length > 40 ? [`- ... and ${files.length - 40} more file(s)`] : []),
    'FILL: why each change was made, and which previous finding it answers.',
  ].join('\n');

  const settled = (f) => skip.includes(f.id) || SETTLED_OUTCOMES.includes(outcomes.get(f.id)?.word);
  const previous = findingsDoc.findings.filter((f) => !settled(f));
  const counts = { total: findingsDoc.findings.length, carried: previous.length, decided: findingsDoc.findings.length - previous.length };
  // From round 2 one more hypothesis: fixes keep missing the edge values of the fields they read.
  const edge = reviewRound >= 2 ? [`- [H${previous.length + 1}] Not a previous finding: some field the changed code reads is handled wrongly when it is null, missing, empty, zero or negative, or an invariant the code relies on does not hold across those input points. Try each of these values on every field the change reads; CONFIRMED names the field and value that break it, REFUTED means all of them hold.`] : [];
  const countLine = `The previous review had ${counts.total} finding(s): ${counts.carried} are the hypotheses below, ${counts.decided} were decided and are listed under Known deviations.${edge.length > 0 ? ' The last hypothesis is a check on input edge values, not a previous finding.' : ''}`;
  const hypotheses = previous.length > 0
    ? ['In `## Checks performed`, end each hypothesis line with CONFIRMED (the previous defect is still there), REFUTED (it is gone) or PARTLY CONFIRMED; the report prints that outcome.', countLine, ...previous.map((f, i) => findingHypothesis(f, i + 1, outcomes.get(f.id)?.word === 'pre-existing', files.map((d) => String(d.path ?? d.headerPath ?? '').replace(/\\/g, '/')))), ...edge].join('\n')
    : findingsDoc.findings.length > 0
      ? `- FILL: all ${findingsDoc.findings.length} previous finding(s) were settled (see Known deviations); list what to re-check, or delete this section.`
      : '- FILL: the previous review had no findings; list what to re-check, or delete this section.';

  const evidence = evidenceText ?? "FILL: this run's pre-flight summary (HEAD, snapshotHash, test results and log paths). The previous run's hash and counts no longer apply.";
  // A finding left out with --skip or settled in the notes is a decision, so the seats are told not to spend a claim on it.
  const decided = findingsDoc.findings.filter(settled).map((f) => {
    const o = skip.includes(f.id) ? null : outcomes.get(f.id);
    const marked = o ? ` The author marked it ${o.word}${o.reason ? `: ${o.reason.replace(/([^.?!])$/, '$1.')}` : '.'}` : '';
    // Finding ids restart at F1 every round, so the round names which F1 this is.
    return `- Previous finding ${f.id} of round ${reviewRound - 1} (decided, not re-checked; do not spend a claim on it unless the code around it changed): ${firstSentence(oneLine(f.summary ?? f.title))}${marked}`;
  });
  // Sections carried over as they were may hold the previous round's facts (round numbers, finding ids, test or line counts).
  const stale = (title) => `FILL: carried over from the previous packet (section "${title}"); any counts above (lines, tests, findings) are from the previous packet: update anything that changed (round, finding ids, paths, test or line counts).`;
  const keepAsIs = (key) => ['acceptance criteria', 'severity note', 'output'].some((k) => key.startsWith(k));
  const out = [];
  let sawHypotheses = false;
  let sawChanged = false;
  let sawDeviations = false;
  let sawEvidence = false;
  const evidenceSections = [
    { title: 'Evidence both seats may cite', body: evidence },
    { title: 'Author-reported evidence (not reproducible; do not cite as EXECUTED)', body: 'FILL: results the author ran that the seats cannot repeat, or write "none".' },
  ];
  for (const s of sections) {
    const key = s.title.toLowerCase();
    if (key.startsWith('hypotheses')) {
      if (!sawHypotheses) out.push({ title: 'Hypotheses to test', body: hypotheses });
      sawHypotheses = true;
    } else if (key.startsWith('what changed since')) {
      if (!sawChanged) out.push({ title: 'What changed since the previous review', body: changed });
      sawChanged = true;
    } else if (key.startsWith('evidence both seats may cite')) {
      out.push(...evidenceSections);
      sawEvidence = true;
    } else if (key.startsWith('author-reported evidence')) {
      // The earlier author's results do not carry over; the slot after the evidence section replaces it.
    } else if (key.startsWith('known deviations')) {
      sawDeviations = true;
      out.push({ title: s.title, body: [s.body, ...decided, 'FILL: which of these deviations still apply to the changed code, and any new one.'].filter((x) => x !== '').join('\n') });
    } else if (keepAsIs(key)) out.push(s);
    else out.push({ title: s.title, body: [s.body, stale(s.title)].filter((x) => x !== '').join('\n') });
    if (key === 'scope' && !sawChanged) {
      out.push({ title: 'What changed since the previous review', body: changed });
      sawChanged = true;
    }
  }
  if (!sawChanged) out.unshift({ title: 'What changed since the previous review', body: changed });
  if (!sawDeviations && decided.length > 0) out.push({ title: 'Known deviations from the criteria', body: decided.join('\n') });
  // Evidence given for a packet that had no evidence section goes where the template puts it: before Hypotheses, Checks and Output.
  if (evidenceText !== null && !sawEvidence) {
    const at = out.findIndex((s) => ['hypotheses', 'checks', 'severity note', 'output'].some((k) => s.title.toLowerCase().startsWith(k)));
    out.splice(at < 0 ? out.length : at, 0, ...evidenceSections);
  }
  if (!sawHypotheses) out.push({ title: 'Hypotheses to test', body: hypotheses });
  const text = `${dropTagFromPacket(`${head}\n\n${out.map((s) => `## ${s.title}\n${s.body}`).join('\n\n')}`, dropTags)}\n`;
  const fills = text.split('\n').map((l, i) => ({ l, n: i + 1 })).filter(({ l }) => /\bFILL:/.test(l)).map(({ l, n }) => ({ line: n, text: l.trim().slice(0, 100) }));
  const fromNotes = findingsDoc.findings.filter((f) => !skip.includes(f.id) && outcomes.has(f.id))
    .map((f) => `${f.id} ${outcomes.get(f.id).word} (${settled(f) ? 'known deviation' : 'hypothesis'})`);
  return { text, fills, fromNotes, round: reviewRound, counts };
}

// Replaces a folder path wherever the packet writes it, with either slash style; a Windows path (drive letter or UNC) in any case.
// The path must start and end there: not after a name character ("/mnt/backup/home/u/old" is another path; "file:///home/u/old"
// is not), and before anything but a name continuation (NAME_CONTINUES: "old(backup)", "old-2" are other folders).
const windowsPath = (p) => /^(?:[A-Za-z]:|[\\/]{2})/.test(p);
export function rewritePaths(text, pairs) {
  const map = new Map();
  for (const [from, to] of pairs) {
    if (!from || !to || from === to) continue;
    for (const v of new Set([from, from.split('\\').join('/'), from.split('/').join('\\')])) map.set(windowsPath(v) ? v.toLowerCase() : v, to);
  }
  if (map.size === 0) return text;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const re = new RegExp(String.raw`(?<![\p{L}\p{N}_.~-])(` + keys.map(escapeRe).join('|') + ')(?!' + NAME_CONTINUES + ')', keys.some(windowsPath) ? 'giu' : 'gu');
  return text.replace(re, (hit) => map.get(windowsPath(hit) ? hit.toLowerCase() : hit) ?? hit);
}

// The spellings text uses for folder `from` through another link or junction than the one run.json recorded: every
// absolute path start, cut at each separator or space, that exists and has the same real path.
export function linkedSpellingsIn(text, from) {
  const want = comparablePath(from);
  const found = new Set();
  for (const m of String(text).matchAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\r\n"'`<>|*]*|(?<![\w:/\\.~-])\/[^\r\n"'`<>|*]*/g)) {
    for (const cut of [...m[0].matchAll(/[\\/ ]/g)].map((b) => b.index).slice(1, 60).concat(m[0].length)) {
      const p = m[0].slice(0, cut).replace(/[.,;:)\]]+$/, '');
      if (p.length > 3 && existsSync(p) && comparablePath(p) === want) found.add(p);
    }
  }
  return [...found];
}

// The unified diff between two snapshot folders (old, new), with paths relative to them: git diff --no-index run in the new
// folder names its files "./x" and the old folder's "../old/x", so both prefixes are taken off.
// Keeps the file blocks of a unified diff whose path is one of `only` or inside one of them (a folder). A block starts at
// "diff --git", or at a "--- " line followed by "+++ " once the current block has had its own pair (plain diff -u).
export function filterDiff(text, only) {
  if (only.length === 0) return text;
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const wanted = only.map((o) => fold(o.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')));
  const lines = text.split('\n');
  const blocks = [];
  let cur = null;
  // Inside a hunk its header's line counts decide; a removed "-- x" followed by an added "++ y" is content, not a header.
  let oldLeft = 0;
  let newLeft = 0;
  lines.forEach((line, i) => {
    if (cur !== null && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith('+')) { newLeft -= 1; cur.lines.push(line); return; }
      if (line.startsWith('-')) { oldLeft -= 1; cur.lines.push(line); return; }
      if (line.startsWith(' ') || line === '') { oldLeft -= 1; newLeft -= 1; cur.lines.push(line); return; }
      if (line.startsWith('\\')) { cur.lines.push(line); return; }
      // A line no hunk can hold ends it early (a cut-off diff).
      oldLeft = 0;
      newLeft = 0;
    }
    const pairStart = line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
    if (line.startsWith('diff --git ') || (pairStart && (cur === null || cur.sawPair))) {
      cur = { lines: [], sawPair: false, git: line.startsWith('diff --git ') };
      blocks.push(cur);
    }
    if (cur === null) return;
    if (pairStart) cur.sawPair = true;
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) { oldLeft = Number(hunk[1] ?? 1); newLeft = Number(hunk[2] ?? 1); }
    cur.lines.push(line);
  });
  const keep = blocks.filter((b) => {
    const f = diffSummary(b.lines.join('\n'))[0];
    const p = f ? fold(f.path) : null;
    // A plain `diff -ru old new` keeps its folder name in front ("new/src/a.py"); the snapshot-relative path matches too.
    const names = p === null ? [] : b.git ? [p] : [p, p.split('/').slice(1).join('/')];
    return names.some((n) => n !== '' && wanted.some((w) => n === w || n.startsWith(`${w}/`)));
  });
  return keep.map((b) => b.lines.join('\n')).join('\n');
}

// The round of a packet with no "Review round:" line, from the chain of "This is a re-review of the previous review (<run>)"
// intros: each hop is one round; a packet with a round line ends the walk. null when a run in the chain cannot be read.
export async function chainRound(runDir, readPacket, limit = 20) {
  let hops = 0;
  let dir = runDir;
  for (let i = 0; i < limit; i += 1) {
    const text = await readPacket(path.join(dir, 'task-packet.md')).catch(() => null);
    if (text === null) return null;
    const stated = /^Review round:\s*(\d+)\s*$/m.exec(text);
    if (stated) return Number(stated[1]) + hops;
    const prev = /^This is a re-review of the previous review \((.+?)\)\. /m.exec(text);
    // The 1.1.0 intro named only the previous run folder's name, a sibling of this one.
    const older = prev ? null : /^This is a re-review of the review in (.+?)\. /m.exec(text);
    if (!prev && !older) return 1 + hops;
    hops += 1;
    dir = prev ? prev[1] : path.join(path.dirname(dir), older[1]);
  }
  return null;
}

// prefix: put in front of every path (a second repository's folder name), so its files do not clash with the target's.
export function diffBetweenDirs(oldDir, newDir, prefix = '') {
  const [oldAbs, newAbs] = [path.resolve(oldDir), path.resolve(newDir)];
  for (const [dir, which] of [[oldAbs, 'old'], [newAbs, 'new']]) {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new PacketError(`--since-dirs: the ${which} snapshot ${dir} is not a folder`);
  }
  const rel = (from, to) => path.relative(from, to);
  // One inside the other would list the inner folder as added or removed files; two drives give no relative path.
  if (!rel(oldAbs, newAbs).startsWith('..') || !rel(newAbs, oldAbs).startsWith('..')) throw new PacketError('--since-dirs: one snapshot folder is inside the other; give two separate folders');
  if (path.parse(oldAbs).root.toLowerCase() !== path.parse(newAbs).root.toLowerCase()) throw new PacketError('--since-dirs: the two snapshots are on different drives; put them on the same one');
  const oldRel = rel(newAbs, oldAbs).split(path.sep).join('/');
  // --no-renames: a moved file is listed as removed and added, not as a rename with no ---/+++ lines. --ignore-cr-at-eol: two
  // copies that differ only in CRLF vs LF are not a change (a CRLF checkout against an LF copy would list every line).
  const r = spawnSync('git', ['-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', 'diff', '--no-color', '--no-index', '--no-renames', '--ignore-cr-at-eol', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--', oldRel, '.'],
    { windowsHide: true, cwd: newAbs, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) throw new PacketError(`--since-dirs: git could not run: ${r.error.message}`);
  // git diff --no-index exits 1 when the folders differ and 0 when they match; an error (a path it cannot read) also exits 1,
  // with a message and no diff.
  const failed = r.status !== 0 && (r.status !== 1 || (r.stdout === '' && String(r.stderr).trim() !== ''));
  if (failed) throw new PacketError(`--since-dirs: git diff --no-index exited ${r.status}: ${String(r.stderr).trim().split(/\r?\n/).slice(-1)[0] ?? ''}`);
  const prefixes = [`${oldRel}/`, './'];
  const strip = (s) => `${prefix}${prefixes.reduce((t, p) => (t.startsWith(p) ? t.slice(p.length) : t), s)}`;
  // A .git folder inside a snapshot is not part of the change: its file blocks are left out of the diff.
  let inGit = false;
  return r.stdout.split(/\r?\n/).map((line) => {
    const m = /^(diff --git a\/|--- a\/|\+\+\+ b\/)(.*)$/.exec(line);
    if (!m) return line;
    if (line.startsWith('diff --git')) return line.replace(/^diff --git a\/(\S.*?) b\/(.*)$/, (all, a, b) => `diff --git a/${strip(a)} b/${strip(b)}`);
    return `${m[1]}${strip(m[2])}`;
  }).filter((line) => {
    if (line.startsWith('diff --git ')) {
      const named = /^diff --git (?:"a\/.*?"|a\/.*?) ("b\/.*"|b\/.*)$/.exec(line);
      inGit = named !== null && /(?:^|\/)\.git(?:\/|$)/.test(diffPath(named[1]));
    }
    return !inGit;
  }).join('\n');
}

async function oldTargetOf(run) {
  try {
    const text = await readFile(path.join(run, 'run.json'), 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).targetDir ?? null;
  } catch {
    return null;
  }
}

// The target's diff from <rev> to its working tree (committed and uncommitted tracked changes; untracked files are not in it).
function diffSinceCommit(rev, target) {
  if (!target || !existsSync(target)) throw new PacketError('--since-commit needs the target: give --target <dir> (the previous run.json names none that exists)');
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/', '--relative', rev, '--'], { windowsHide: true, cwd: target, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) throw new PacketError(`--since-commit: git could not run: ${r.error.message}`);
  if (r.status !== 0) throw new PacketError(`--since-commit ${rev}: git diff exited ${r.status}: ${String(r.stderr).trim().split(/\r?\n/)[0] ?? ''}`);
  return r.stdout;
}

async function packet(argv) {
  const args = parseArgs(argv);
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
  // The first --since-dirs pair is the target; each later pair is another repository, its paths under its folder name.
  const rawDiff = args.sinceDiff ? await read(path.resolve(args.sinceDiff), '--since-diff')
    : args.sinceCommit ? diffSinceCommit(args.sinceCommit, args.target ?? await oldTargetOf(run))
    : args.sinceDirs ? args.sinceDirs.map(([a, b], i) => diffBetweenDirs(a, b, i === 0 ? '' : `${path.basename(path.resolve(b))}/`)).filter((d) => d.trim() !== '').join('\n') : '';
  const diffText = filterDiff(rawDiff, args.sinceOnly);
  if (args.sinceOnly.length > 0 && rawDiff.trim() !== '' && diffText.trim() === '') throw new PacketError(`--since-only ${args.sinceOnly.join(', ')} matched no changed file; nothing was written`);
  const out = path.resolve(args.out);
  if (existsSync(out)) throw new PacketError(`${out} already exists; it is never overwritten`);
  if (diffText.trim() !== '' && diffSummary(diffText).length === 0) throw new PacketError(args.sinceDiff
    ? `no changed files found in --since-diff ${args.sinceDiff} (expected a unified diff with "diff --git" or "--- / +++" headers)`
    : args.sinceCommit ? `no changed files found in the git diff since --since-commit ${args.sinceCommit}`
    : `no changed files found between --since-dirs ${args.sinceDirs.map((pair) => pair.join(' ')).join(', ')} (only .git internals differ)`);
  let oldTarget = null;
  let oldRepos = [];
  try {
    const desc = JSON.parse((await readFile(path.join(run, 'run.json'), 'utf8')).replace(/^\uFEFF/, ''));
    oldTarget = desc.targetDir ?? null;
    oldRepos = Array.isArray(desc.extraRepos) ? desc.extraRepos.map((r) => r?.dir).filter((d) => typeof d === 'string') : [];
  } catch {
    oldTarget = null;
  }
  // Every repository of the old run is named: a second repository left on its old path would be reviewed as old code.
  // A path and its other spellings (/tmp and /private/tmp on macOS, a link and its target) are the same folder.
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const same = (a, b) => pathSpellingsOf(a).some((x) => pathSpellingsOf(b).some((y) => fold(x) === fold(y)));
  const unmapped = oldRepos.filter((dir) => !args.repoTargets.some(([from]) => same(from, dir)));
  for (const [from] of args.repoTargets) {
    if (!oldRepos.some((dir) => same(from, dir))) io.err(`build-recheck-packet: WARNING: --repo-target ${from} is not a repository the previous run reviewed (its run.json extraRepos); check it for a typo\n`);
  }
  if (unmapped.length > 0) throw new PacketError(`the previous run also reviewed ${unmapped.join(', ')} (--repo); give --repo-target <old>=<new> for each (use <old>=<old> to keep a path); nothing was written`);
  // The old packet's own round, also when it was built before packets carried a round line.
  let round = args.round;
  if (round === null && !/^Review round:/m.test(oldPacket)) {
    const old = await chainRound(run, (file) => readFile(file, 'utf8'));
    if (old === null) io.err('build-recheck-packet: WARNING: the round could not be counted (a run in the chain of earlier re-reviews is missing); pass --round N\n');
    else round = old + 1;
  }
  const notesFile = args.notes ? path.resolve(args.notes) : path.join(run, 'phase3', 'report-notes.md');
  const notesText = args.notes || existsSync(notesFile) ? await read(notesFile, 'the report notes') : '';
  // No diff given (an uncommitted worktree has no commit to diff against): the previous run's file hashes name what changed.
  const oldPrint = args.sinceDiff || args.sinceDirs || args.sinceCommit ? null : await readFile(path.join(run, 'fingerprint-files.json'), 'utf8').then(JSON.parse, () => null);
  const nowTarget = args.target ?? oldTarget;
  const drift = oldPrint && nowTarget && existsSync(nowTarget) ? driftedFiles(oldPrint, await fingerprintFiles(nowTarget)) : [];
  const evidenceText = args.preflight ? preflightEvidence(await readJson(path.resolve(args.preflight), '--preflight'), path.resolve(args.preflight)) : null;
  const built = buildRecheckPacket({ oldPacket, findingsDoc, diffText, drift, previousRun: 'the previous review', title: args.title, skip: args.skip, dropTags: args.dropTags, outcomes: notesOutcomes(notesText), round, evidenceText });
  // Each old path in every spelling the packet may use (run.json and the packet's author can spell it differently).
  const spelled = (from, to) => pathSpellingsOf(from).map((s) => [s, path.resolve(to)]);
  // A target the packet spells through another link or junction than run.json is found by its real path.
  const moved = (from, to) => [...spelled(from, to), ...linkedSpellingsIn(built.text, from).map((s) => [s, path.resolve(to)])];
  const targetPairs = args.target && oldTarget ? moved(oldTarget, args.target) : [];
  const pairs = [...spelled(run, path.dirname(out)), ...targetPairs,
    ...args.repoTargets.flatMap(([from, to]) => moved(from, to))].sort((a, b) => b[0].length - a[0].length);
  if (targetPairs.length > 0 && rewritePaths(built.text, targetPairs) === built.text) {
    io.err(`build-recheck-packet: WARNING: --target was given, but the packet names the old target ${oldTarget} in no spelling found here; check that the new packet names ${path.resolve(args.target)}\n`);
  }
  // The previous run's path stays out of the packet: its folder holds the earlier seats' files and a manifest naming their
  // models, which the seats and the auditor must not read. It is recorded next to the packet for the orchestrator instead.
  const text = rewritePaths(built.text, pairs);
  const fills = built.fills;
  // Without the old target path the packet would point the seats at the old snapshot: refuse rather than publish it.
  if (args.target && !oldTarget) throw new PacketError(`--target was given, but ${path.join(run, 'run.json')} is missing or has no targetDir, so the old target path cannot be rewritten; write the packet without --target and replace the old path by hand, or restore run.json; nothing was written`);
  // The companions are checked before anything is written and written before the packet: a stale since.diff or
  // previous-run.json from another attempt is refused, and an interrupted run never leaves a packet without them.
  const record = path.join(path.dirname(out), 'previous-run.json');
  const recordText = `${JSON.stringify({ previousRun: run, round: built.round }, null, 2)}\n`;
  const diffOut = path.join(path.dirname(out), 'since.diff');
  const companions = [[record, recordText], ...(diffText.trim() !== '' ? [[diffOut, diffText]] : [])];
  for (const [file, content] of companions) {
    if (existsSync(file) && (await readFile(file, 'utf8')) !== content) {
      throw new PacketError(`${file} already exists with other contents (from another attempt or another previous run); remove it or write the packet to a new folder; nothing was written`);
    }
  }
  // A run with no diff would leave an earlier attempt's since.diff for build-report to read as this change.
  if (diffText.trim() === '' && existsSync(diffOut)) {
    throw new PacketError(`${diffOut} already exists, but this run's diff is empty (no --since-diff or --since-dirs, or no change between them), so it is from another attempt; remove it, give the diff again, or write the packet to a new folder; nothing was written`);
  }
  await mkdir(path.dirname(out), { recursive: true });
  for (const [file, content] of companions) if (!existsSync(file)) await writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
  await writeFile(out, text, { encoding: 'utf8', flag: 'wx' });
  io.out(`build-recheck-packet: previous run ${run} (recorded in ${record}; not in the packet: seats must not read that folder)\n`);
  // build-report reads it from the new run folder to say where each finding sits in this change.
  if (diffText.trim() !== '') io.out(`build-recheck-packet: wrote ${diffOut} (build-report reads it for its "Where" tags; do not cite this path in the packet, the auditor may not read the run folder: give the seats a copy outside it)\n`);
  io.out(`build-recheck-packet: previous findings: ${built.counts.total}; ${built.counts.carried} carried as hypotheses, ${built.counts.decided} decided (Known deviations)\n`);
  if (built.fromNotes.length > 0) io.out(`build-recheck-packet: outcomes from ${notesFile}: ${built.fromNotes.join(', ')}\n`);
  // The count follows this run's chain of re-reviews only; other reviews of the same code (another skill, another chain) are unknown.
  if (args.round === null) io.out(`build-recheck-packet: Review round: ${built.round} counts this chain of re-reviews only; if the same code had other reviews, rerun with --round <N> in a new folder, or after deleting the packet and previous-run.json\n`);
  if (built.round >= 3) io.out(`build-recheck-packet: ${stepBackNote(built.round)}\n`);
  // Spellings through a variable or "~" are not rewritten, and none is guessed at: the reminder is the same every time.
  if (args.target || args.repoTargets.length > 0) io.out('build-recheck-packet: old paths written through a variable or "~" (%TEMP%\\..., $HOME/..., ~/...) are not rewritten: check the packet for them by hand\n');
  io.out(`build-recheck-packet: wrote ${out}\n${fills.length} FILL marker(s) to complete before the seats start:\n${fills.map((f) => `  line ${f.line}: ${f.text}`).join('\n')}\n`);
}

async function main(argv) {
  try {
    await packet(argv);
    return 0;
  } catch (err) {
    io.err(`build-recheck-packet: ${err.message}\n`);
    return err instanceof PacketError ? 1 : 2;
  }
}

// The re-review packet in-process: { code, stdout, stderr }.
export const runStep = (argv) => runStepWith('build-recheck-packet', io, main, argv);

refuseDirectRun(import.meta.url, 'build-recheck-packet.mjs');
