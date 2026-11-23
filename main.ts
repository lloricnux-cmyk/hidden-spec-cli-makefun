// mend: one patch tool for every AI edit format.
//
// Implements SPEC.md: unified diffs (often with wrong line numbers),
// SEARCH/REPLACE blocks, V4A patches and JSON tool calls, matched at three
// tiers (exact, trailing whitespace, leading and trailing whitespace), applied
// all or nothing. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs this file with MAKEFUN_ENV_URL set, and the last
// lines hand over to runner.ts (kept as the kit has it): keep that hand-over.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, for the R lines of the output. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const lead = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The first tier (0, 1, 2) at which O occurs in `lines` from `from`, with every position. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const want = o.map((l) => normLine(l, tier));
    const pos: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (normLine(lines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

interface NewLine {
  text: string;
  /** Index into O for a context line, null for a new line. */
  ctx: number | null;
}

/** Build N for a match at `pos`: context lines are the file's own, tier 2 re-indents the rest. */
function buildNew(fileLines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  if (tier !== 2) return n.map((x) => (x.ctx !== null ? fileLines[pos + x.ctx]! : x.text));
  const f = lead(fileLines[pos] ?? '');
  const p = lead(o[0] ?? '');
  return n.map((x) => {
    if (x.ctx !== null) return fileLines[pos + x.ctx]!;
    const t = x.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

function stateOf(tree: Tree, p: string): FileState | null {
  const t = tree.get(p);
  return t === null ? null : parseFile(t);
}

/** O and N from body lines: ' ' is context (in both), '-' old only, '+' new only. */
function bodyToON(body: { kind: ' ' | '-' | '+'; text: string }[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface HunkBody {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface ParsedHunk {
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslash: boolean;
}

function toHunk(a: number, body: HunkBody[]): ParsedHunk {
  const { o, n } = bodyToON(body.filter((b) => b.kind !== '\\'));
  let lastCtxPlus = -1;
  body.forEach((b, bi) => {
    if (b.kind === ' ' || b.kind === '+') lastCtxPlus = bi;
  });
  const backslash = lastCtxPlus >= 0 && body[lastCtxPlus + 1]?.kind === '\\';
  return { a, o, n, backslash };
}

/** Apply hunks in order to a file's state, tracking the running line drift d. */
function applyHunks(f: FileState, hunks: ParsedHunk[], strict: boolean, path: string): FileState {
  const out: FileState = { br: f.br, lines: [...f.lines], final: f.final };
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(out.lines, h.o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const built = buildNew(out.lines, best, h.o, h.n, found.tier);
      const reachedEnd = best + h.o.length === out.lines.length;
      out.lines.splice(best, h.o.length, ...built);
      if (reachedEnd) out.final = !h.backslash;
      d += h.n.length - h.o.length;
    } else {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > out.lines.length) pos = out.lines.length;
      const atEnd = pos === out.lines.length;
      const built = h.n.map((x) => x.text);
      out.lines.splice(pos, 0, ...built);
      if (atEnd && built.length > 0) out.final = !h.backslash;
      d += h.n.length;
    }
  }
  return out;
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, a/ or b/ stripped; null for /dev/null. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/')) return raw.slice(2);
  if (raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairSeen: boolean;
  isCreate: boolean;
  isDelete: boolean;
  hunks: ParsedHunk[];
}

function uniEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.diffOld;
    const newP = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.diffNew;
    if (oldP === null || s.isCreate) {
      if (newP === null || newP === undefined) throw new Fail('unsafe', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      // The creation ends with a line break unless a `\` line follows its
      // very last `+` line: take the backslash flag of the last hunk that
      // carries any `+` line.
      let backslash = false;
      for (const h of s.hunks) {
        if (h.n.some((x) => x.ctx === null)) backslash = h.backslash;
      }
      for (const h of s.hunks) for (const x of h.n) if (x.ctx === null) plus.push(x.text);
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (backslash ? '' : '\n'));
      return;
    }
    if (newP === null || s.isDelete) {
      if (oldP === undefined) throw new Fail('unsafe', '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== undefined && newP !== undefined && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = stateOf(tree, oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const done = applyHunks(cur, s.hunks, strict, oldP);
      tree.now.set(newP, renderFile(done));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP !== undefined ? oldP : newP;
    if (p === undefined) throw new Fail('unsafe', '');
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = stateOf(tree, p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, renderFile(applyHunks(cur, s.hunks, strict, p)));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  const hunkHead = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const diffLine = /^diff --git a\/(\S+) b\/(\S+)$/;
  const blankSection = (): UniSection => ({
    pairOld: undefined,
    pairNew: undefined,
    renameOld: undefined,
    renameNew: undefined,
    diffOld: undefined,
    diffNew: undefined,
    pairSeen: false,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffLine.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = blankSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.pairSeen) {
        cur = blankSection();
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.pairSeen = true;
        sections.push(cur);
      } else {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkHead.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: HunkBody[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl === '' ? { kind: ' ', text: '' } : { kind: bl[0] as ' ' | '-' | '+' | '\\', text: bl.slice(1) });
          i++;
        } else break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === ' ' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push(toHunk(a, body));
      continue;
    }
    if (cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => uniEdit(s, strict));
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLn = i + 1;
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======' && eq < 0) eq = j;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0 || eq > rep) throw new Exit2(`error: parse ${searchLn}`);
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLn}`);
      path = prevPath;
    }
    prevPath = path;
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = stateOf(tree, p);
      if (cur === null) throw new Fail('missing', p);
      const found = findTier(cur.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      const built = buildNew(cur.lines, pos, oldLines, newLines.map((t) => ({ text: t, ctx: null })), found.tier);
      cur.lines.splice(pos, oldLines.length, ...built);
      tree.now.set(p, renderFile(cur));
    });
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface V4aLine {
  text: string;
  ln: number;
}
interface V4aChunk {
  anchor: string;
  eof: boolean;
  body: { kind: ' ' | '-' | '+'; text: string }[];
}

function v4aSectionEdit(kind: string, path: string, raw: V4aLine[], sectionLn: number, strict: boolean): Edit {
  if (kind === 'Add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else if (r.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${r.ln}`);
    }
    const content = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, content);
    };
  }
  if (kind === 'Delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.ln}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update
  let moveTo: string | null = null;
  let k = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: V4aChunk[] = [];
  let curChunk: V4aChunk | null = null;
  let started = false;
  for (; k < raw.length; k++) {
    const r = raw[k]!;
    const t = r.text;
    if (t.startsWith('@@')) {
      curChunk = { anchor: t.slice(2).trim(), eof: false, body: [] };
      chunks.push(curChunk);
      started = true;
      continue;
    }
    if (t.trimEnd() === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${r.ln}`);
      curChunk.eof = true;
      curChunk = null;
      continue;
    }
    if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
      if (curChunk === null) {
        if (started) throw new Exit2(`error: parse ${r.ln}`);
        curChunk = { anchor: '', eof: false, body: [] };
        chunks.push(curChunk);
        started = true;
      }
      curChunk.body.push({ kind: t === '' ? ' ' : (t[0] as ' ' | '-' | '+'), text: t === '' ? '' : t.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${r.ln}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLn}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = stateOf(tree, path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = cur;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const anchorFound = findTier(f.lines, [ch.anchor], strict, cursor);
        if (!anchorFound) throw new Fail('no-match', path);
        cursor = anchorFound.pos[0]! + 1;
      }
      const { o, n } = bodyToON(ch.body);
      if (o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const built = n.map((x) => x.text);
        f.lines.splice(pos, 0, ...built);
        cursor = pos + built.length;
      } else {
        const found = findTier(f.lines, o, strict, cursor);
        if (!found) throw new Fail('no-match', path);
        let positions = found.pos;
        if (ch.eof) positions = positions.filter((p) => p + o.length === f.lines.length);
        if (positions.length === 0) throw new Fail('no-match', path);
        const pos = positions[0]!;
        const built = buildNew(f.lines, pos, o, n, found.tier);
        f.lines.splice(pos, o.length, ...built);
        cursor = pos + built.length;
      }
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = sectionStart.exec(line);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const sectionLn = i + 1;
    const start = i + 1;
    let j = start;
    while (j < last && !sectionStart.test(lines[j]!)) j++;
    const raw: V4aLine[] = [];
    for (let t = start; t < j; t++) raw.push({ text: lines[t]!, ln: t + 1 });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aSectionEdit(kind, path, raw, sectionLn, strict));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Command line, output and exit codes (SPEC.md sections 1, 2, 10) ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const used = new Set<string>();
  for (const [old, nw] of tree.moves) {
    if (used.has(old) || used.has(nw)) continue;
    if (tree.original(old) !== null && tree.original(nw) === null && tree.get(old) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}` });
      used.add(old);
      used.add(nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
