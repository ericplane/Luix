// Pure parsing helpers; no VS Code dependency.

export interface EnclosingCall {
  className: string;
  isStringLiteralName: boolean;
  /** Matched factory alias, or the component name for a direct call. */
  alias?: string;
  callShape?: "parens" | "curried";
  /** Direct component call rather than a configured factory call. */
  isDirectComponentCall?: boolean;
}

export interface ComponentAnnotations {
  extendsClass?: string;
  props: string[];
}

export interface DocumentComponentInfo {
  name: string;
  defLineIndex: number;
  paramTypeFields?: string[];
  annotations: ComponentAnnotations;
  detectedBase?: string;
  /** Root props whose values do not textually reference the component's props parameter. */
  hardcodedProps?: Set<string>;
  paramName?: string;
  /** Offset of the first character inside the function body. */
  bodyStart?: number;
  /** Offset just after the function's terminating end. */
  bodyEnd?: number;
  /** Start of the props parameter's type annotation, after the colon. */
  paramTypeStart?: number;
  paramTypeEnd?: number;
}

export interface CreateElementCall {
  className: string;
  isStringLiteralName: boolean;
  isDirectComponentCall?: boolean;
  /** Configured Vide constructor after excluding component bindings. */
  isDirectInstanceCall?: boolean;
  nameProp?: string;
  /** Factory alias without its receiver; use this for framework lookup. */
  alias?: string;
  /** Verbatim receiver and separator, such as scope:; code generation must retain it. */
  receiver?: string;
  /** The whole call spans [aliasStart, fullEnd), including any receiver. */
  aliasStart: number;
  fullEnd: number;
  classNameStart: number;
  classNameEnd: number;
  childrenStart?: number;
  childrenEnd?: number;
  /** Opening props brace, absent when props are passed as a variable. */
  propsBraceStart?: number;
  propsBraceEnd?: number;
}

export interface CallTreeNode {
  call: CreateElementCall;
  children: CallTreeNode[];
}

export interface ColorLiteral {
  r: number;
  g: number;
  b: number;
  start: number;
  end: number;
}

export interface AliasPartition {
  parens: string[];
  curried: string[];
  /** Parens aliases with inline children; absent values fall back to curried-bucket membership. */
  parensWithInlineChildren?: string[];
}

function asPartition(aliases: AliasPartition | string[]): AliasPartition {
  if (Array.isArray(aliases)) {
    return { parens: aliases, curried: [] };
  }
  return aliases;
}

// Share lazy analysis per text; separate document and fragment caches prevent fragment churn from evicting documents.

const DOCUMENT_ANALYSES_MAX = 8;
const FRAGMENT_ANALYSES_MAX = 16;
/** Character budget per tier; always retain the newest analysis even if larger. */
const ANALYSES_CHARS_MAX = 3_000_000;
/** Maximum alias/direct-call result variants cached per text. */
const RESULTS_PER_TEXT_MAX = 8;

class TextAnalysis {
  private maskBits?: boolean[];
  private maskedText?: string;
  private blockIndex?: BlockIndex;
  private newlineOffsets?: number[];
  private lineList?: string[];
  private memos?: Map<string, { deps: readonly unknown[]; value: unknown }>;
  readonly scans = new Map<string, Map<string, DocumentComponentInfo>>();
  readonly calls = new Map<string, CreateElementCall[]>();
  /** Factory-only calls in discovery order, keyed by alias set. */
  readonly rawCalls = new Map<string, CreateElementCall[]>();

  /** Adopt equal caller strings so repeated lookups can use pointer equality. */
  constructor(public text: string) {}

  get mask(): boolean[] {
    return (this.maskBits ??= buildCodeMaskImpl(this.text));
  }

  ownsMask(mask: boolean[]): boolean {
    return this.maskBits === mask;
  }

  get masked(): string {
    return (this.maskedText ??= applyMaskImpl(this.text, this.mask));
  }

  get blocks(): BlockIndex {
    return (this.blockIndex ??= buildBlockIndex(this.masked));
  }

  get lines(): string[] {
    return (this.lineList ??= this.text.split("\n"));
  }

  lineOf(offset: number): number {
    if (!this.newlineOffsets) {
      const offsets: number[] = [];
      for (let i = this.text.indexOf("\n"); i !== -1; i = this.text.indexOf("\n", i + 1)) {
        offsets.push(i);
      }
      this.newlineOffsets = offsets;
    }
    return lowerBound(this.newlineOffsets, Math.min(offset, this.text.length));
  }

  memo<T>(slot: string, deps: readonly unknown[], compute: () => T): T {
    const hit = this.memos?.get(slot);
    if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) {
      return hit.value as T;
    }
    const value = compute();
    (this.memos ??= new Map()).set(slot, { deps, value });
    return value;
  }
}

interface AnalysisCache {
  documents: TextAnalysis[];
  fragments: TextAnalysis[];
}

const sharedAnalyses: AnalysisCache = { documents: [], fragments: [] };
/** Temporary analyses keep background work from evicting open documents. */
let transientAnalyses: AnalysisCache | undefined;

function analyses(entry: TextAnalysis, text: string): boolean {
  // Reject different lengths before comparing large texts.
  if (entry.text.length !== text.length || entry.text !== text) {
    return false;
  }
  entry.text = text;
  return true;
}

function takeFrom(list: TextAnalysis[], text: string): TextAnalysis | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (analyses(entry, text)) {
      if (i !== list.length - 1) {
        list.splice(i, 1);
        list.push(entry);
      }
      return entry;
    }
  }
  return undefined;
}

function remember(list: TextAnalysis[], entry: TextAnalysis, max: number): void {
  list.push(entry);
  let chars = 0;
  for (const kept of list) {
    chars += kept.text.length;
  }
  while (list.length > 1 && (list.length > max || chars > ANALYSES_CHARS_MAX)) {
    chars -= list.shift()!.text.length;
  }
}

function lookupAnalysis(cache: AnalysisCache, text: string, asDocument: boolean): TextAnalysis | undefined {
  const document = takeFrom(cache.documents, text);
  if (document) {
    return document;
  }
  const fragment = takeFrom(cache.fragments, text);
  if (fragment && asDocument) {
    cache.fragments.splice(cache.fragments.indexOf(fragment), 1);
    remember(cache.documents, fragment, DOCUMENT_ANALYSES_MAX);
  }
  return fragment;
}

function analysisFor(text: string, asDocument = false): TextAnalysis {
  const shared = lookupAnalysis(sharedAnalyses, text, asDocument);
  if (shared) {
    return shared;
  }
  const cache = transientAnalyses ?? sharedAnalyses;
  if (transientAnalyses) {
    const transient = lookupAnalysis(transientAnalyses, text, asDocument);
    if (transient) {
      return transient;
    }
  }
  const entry = new TextAnalysis(text);
  if (asDocument) {
    remember(cache.documents, entry, DOCUMENT_ANALYSES_MAX);
  } else {
    remember(cache.fragments, entry, FRAGMENT_ANALYSES_MAX);
  }
  return entry;
}

function peekAnalysis(text: string): TextAnalysis | undefined {
  for (const cache of transientAnalyses ? [sharedAnalyses, transientAnalyses] : [sharedAnalyses]) {
    for (const list of [cache.documents, cache.fragments]) {
      // Search newest first to avoid comparing older, equal-length document versions.
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i];
        if (analyses(entry, text)) {
          return entry;
        }
      }
    }
  }
  return undefined;
}

/** Reuse cached analyses, but discard new ones when synchronous background work returns. */
export function withTransientAnalyses<T>(work: () => T): T {
  const outer = transientAnalyses;
  transientAnalyses = outer ?? { documents: [], fragments: [] };
  try {
    return work();
  } finally {
    transientAnalyses = outer;
  }
}

/** Memoize by text and dependency identity; values expire with the text's analysis. */
export function memoForText<T>(
  text: string,
  slot: string,
  deps: readonly unknown[],
  compute: () => T
): T {
  return analysisFor(text, true).memo(slot, deps, compute);
}

function trimResults<V>(results: Map<string, V>): void {
  if (results.size > RESULTS_PER_TEXT_MAX) {
    const oldest = results.keys().next().value;
    if (oldest !== undefined) {
      results.delete(oldest);
    }
  }
}

/** First index whose value is at least x in an ascending array. */
function lowerBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Immutable cached code mask; string/comment contents are false, while delimiters remain visible. */
export function buildCodeMask(text: string): boolean[] {
  return analysisFor(text).mask;
}

function buildCodeMaskImpl(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(true);
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    if (c === "-" && text[i + 1] === "-") {
      const blockMatch = /^\[(=*)\[/.exec(text.slice(i + 2));
      if (blockMatch) {
        const level = blockMatch[1].length;
        const closeStr = "]" + "=".repeat(level) + "]";
        const searchFrom = i + 2 + blockMatch[0].length;
        const closeIdx = text.indexOf(closeStr, searchFrom);
        const endIdx = closeIdx === -1 ? text.length : closeIdx + closeStr.length;
        for (let j = i; j < endIdx; j++) {
          mask[j] = false;
        }
        i = endIdx;
        continue;
      }
      while (i < text.length && text[i] !== "\n") {
        mask[i] = false;
        i++;
      }
      continue;
    }

    // Keep quotes visible to downstream patterns.
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === "\\" && i + 1 < text.length) {
          mask[i] = false;
          if (text[i + 1] !== "\n") {
            mask[i + 1] = false;
          }
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        if (text[i] === "\n") {
          // Recover from unterminated strings at the next line.
          break;
        }
        mask[i] = false;
        i++;
      }
      continue;
    }

    // Long-bracket strings keep their delimiters visible.
    if (c === "[") {
      const longMatch = /^\[(=*)\[/.exec(text.slice(i));
      if (longMatch) {
        const level = longMatch[1].length;
        const closeStr = "]" + "=".repeat(level) + "]";
        const innerStart = i + longMatch[0].length;
        const closeIdx = text.indexOf(closeStr, innerStart);
        const innerEnd = closeIdx === -1 ? text.length : closeIdx;
        for (let j = innerStart; j < innerEnd; j++) {
          mask[j] = false;
        }
        i = closeIdx === -1 ? text.length : closeIdx + closeStr.length;
        continue;
      }
    }

    i++;
  }

  return mask;
}

/** Blank masked characters, preserving newlines; matching text/mask pairs reuse cached output. */
export function applyMask(text: string, mask: boolean[]): string {
  const cached = peekAnalysis(text);
  if (cached && cached.ownsMask(mask)) {
    return cached.masked;
  }
  return applyMaskImpl(text, mask);
}

function maskUncached(text: string): string {
  return applyMaskImpl(text, buildCodeMaskImpl(text));
}

function applyMaskImpl(text: string, mask: boolean[]): string {
  // Copy whole runs to avoid per-character string allocation.
  const out: string[] = [];
  const n = text.length;
  let runStart = 0;
  let i = 0;
  while (i < n) {
    if (mask[i]) {
      i++;
      continue;
    }
    if (i > runStart) {
      out.push(text.slice(runStart, i));
    }
    let j = i + 1;
    while (j < n && !mask[j]) {
      j++;
    }
    let blankFrom = i;
    for (let k = i; k < j; k++) {
      if (text.charCodeAt(k) === 10) {
        if (k > blankFrom) {
          out.push(" ".repeat(k - blankFrom));
        }
        out.push("\n");
        blankFrom = k + 1;
      }
    }
    if (j > blankFrom) {
      out.push(" ".repeat(j - blankFrom));
    }
    runStart = i = j;
  }
  if (runStart < n) {
    out.push(runStart === 0 ? text : text.slice(runStart));
  }
  return out.join("");
}

export function lineNumberOf(text: string, offset: number): number {
  let line = 0;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}

const aliasAlternationCache = new Map<string, string>();

export function buildAliasAlternation(aliases: string[]): string {
  const key = aliases.join("|");
  const hit = aliasAlternationCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  // Longest aliases must match before their shorter suffixes.
  const sorted = [...aliases].sort((a, b) => b.length - a.length);
  const result = sorted.map(escapeRegex).join("|");
  aliasAlternationCache.set(key, result);
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+*?^$()[\]{}|\\]/g, "\\$&");
}

/** Lazy receiver matching lets configured dotted aliases match whole. */
const RECEIVER_PREFIX = `(?:[A-Za-z_][A-Za-z0-9_]*\\s*[.:]\\s*)??`;

const CLASS_NAME_ALT =
  `(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|` +
  `([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*))`;

/** Leading scope arguments exclude nested parentheses and newlines to keep matching linear. */
const LEADING_ARGS = `(?:[^()\\n]*?,\\s*)?`;

const parensPatternCache = new Map<string, RegExp>();
const curriedPatternCache = new Map<string, RegExp>();
const curriedNameParensPatternCache = new Map<string, RegExp>();
const curriedPropsParensPatternCache = new Map<string, RegExp>();
const factoryNameStageParensCache = new Map<string, RegExp>();

function parensPatternFor(aliasPattern: string): RegExp {
  const hit = parensPatternCache.get(aliasPattern);
  if (hit) {return hit;}
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_.])(${aliasPattern})\\s*\\(\\s*` +
      `(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|` +
      `([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*))` +
      `\\s*,\\s*$`
  );
  parensPatternCache.set(aliasPattern, re);
  return re;
}

function curriedPatternFor(aliasPattern: string): RegExp {
  const hit = curriedPatternCache.get(aliasPattern);
  if (hit) {return hit;}
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_.])${RECEIVER_PREFIX}(${aliasPattern})` +
      `\\s+${CLASS_NAME_ALT}\\s*$`
  );
  curriedPatternCache.set(aliasPattern, re);
  return re;
}

/** Match a parenthesized name stage ending at the props brace, with an optional props-stage parenthesis. */
function curriedNameParensPatternFor(aliasPattern: string): RegExp {
  const hit = curriedNameParensPatternCache.get(aliasPattern);
  if (hit) {return hit;}
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_.])${RECEIVER_PREFIX}(${aliasPattern})` +
      `\\s*\\(\\s*${LEADING_ARGS}${CLASS_NAME_ALT}\\s*\\)\\s*(?:\\(\\s*)?$`
  );
  curriedNameParensPatternCache.set(aliasPattern, re);
  return re;
}

/** Support mixed call sugar and parentheses, such as New "Frame" ({ ... }). */
function curriedPropsParensPatternFor(aliasPattern: string): RegExp {
  const hit = curriedPropsParensPatternCache.get(aliasPattern);
  if (hit) {return hit;}
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_.])${RECEIVER_PREFIX}(${aliasPattern})` +
      `\\s+${CLASS_NAME_ALT}\\s*\\(\\s*$`
  );
  curriedPropsParensPatternCache.set(aliasPattern, re);
  return re;
}

function factoryNameStageParensPatternFor(aliasPattern: string): RegExp {
  const hit = factoryNameStageParensCache.get(aliasPattern);
  if (hit) {return hit;}
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_.])${RECEIVER_PREFIX}(${aliasPattern})` +
      `\\s*\\(\\s*${LEADING_ARGS}$`
  );
  factoryNameStageParensCache.set(aliasPattern, re);
  return re;
}

const DIRECT_PARENS_PATTERN =
  /(?:^|[^A-Za-z0-9_.:])([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*$/;
const DIRECT_CURRIED_PATTERN =
  /(?:^|[^A-Za-z0-9_.:])([A-Za-z_][A-Za-z0-9_]*)\s*$/;
// Fusion scope arguments must stay on one line without nested parentheses.
const DIRECT_PARENS_SCOPED_PATTERN =
  /(?:^|[^A-Za-z0-9_.:])([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*[^()\n{}]*?,\s*$/;

/** Bound per-keystroke backward scans when no enclosing table exists. */
const MAX_BACKWARD_SCAN = 16 * 1024;

/** Return the nearest enclosing block only when it is a recognized factory props table. */
export function findEnclosingPropsCall(
  text: string,
  cursorIndex: number,
  aliases: AliasPartition | string[],
  /** Allow direct-call shapes only for these known names, not arbitrary Lua table-call functions. */
  directComponents?: ReadonlySet<string>
): EnclosingCall | undefined {
  const partition = asPartition(aliases);
  const mask = buildCodeMask(text);

  let braceDepth = 0;
  let parenDepth = 0;
  let openBraceIdx = -1;
  const stopAt = Math.max(0, cursorIndex - MAX_BACKWARD_SCAN);

  for (let i = cursorIndex - 1; i >= stopAt; i--) {
    if (!mask[i]) {
      continue;
    }
    const c = text[i];
    if (c === "}") {
      braceDepth++;
    } else if (c === "{") {
      if (braceDepth === 0) {
        // An unmatched opening parenthesis means the cursor is inside a value expression.
        if (parenDepth < 0) {
          return undefined;
        }
        openBraceIdx = i;
        break;
      }
      braceDepth--;
    } else if (c === ")") {
      parenDepth++;
    } else if (c === "(") {
      parenDepth--;
    }
  }

  if (openBraceIdx === -1) {
    return undefined;
  }

  const sliceStart = Math.max(0, openBraceIdx - 500);
  const before = text.slice(sliceStart, openBraceIdx);

  if (partition.parens.length > 0) {
    const aliasPattern = buildAliasAlternation(partition.parens);
    const pattern = parensPatternFor(aliasPattern);
    const match = pattern.exec(before);
    if (match) {
      const alias = match[1];
      const dq = match[2];
      const sq = match[3];
      const id = match[4];
      const name = dq || sq || id;
      if (name) {
        return {
          className: name,
          isStringLiteralName: !!(dq || sq),
          alias,
          callShape: "parens",
        };
      }
    }
  }

  if (partition.curried.length > 0) {
    const aliasPattern = buildAliasAlternation(partition.curried);
    const pattern = curriedPatternFor(aliasPattern);
    const match = pattern.exec(before);
    if (match) {
      const alias = match[1];
      const dq = match[2];
      const sq = match[3];
      const id = match[4];
      const name = dq || sq || id;
      if (name) {
        return {
          className: name,
          isStringLiteralName: !!(dq || sq),
          alias,
          callShape: "curried",
        };
      }
    }
  }

  // Accept parentheses independently around the name and props stages, including Fusion scope arguments.
  if (partition.curried.length > 0) {
    const aliasPattern = buildAliasAlternation(partition.curried);
    for (const pattern of [
      curriedNameParensPatternFor(aliasPattern),
      curriedPropsParensPatternFor(aliasPattern),
    ]) {
      const match = pattern.exec(before);
      if (!match) {
        continue;
      }
      const name = match[2] || match[3] || match[4];
      if (name) {
        return {
          className: name,
          isStringLiteralName: !!(match[2] || match[3]),
          alias: match[1],
          callShape: "curried",
        };
      }
    }
  }

  // Direct calls require known component names; exclude methods and qualified accesses.
  if (directComponents && directComponents.size > 0) {
    const parensMatch =
      DIRECT_PARENS_PATTERN.exec(before) ??
      DIRECT_PARENS_SCOPED_PATTERN.exec(before);
    if (parensMatch && directComponents.has(parensMatch[1])) {
      const name = parensMatch[1];
      return {
        className: name,
        isStringLiteralName: false,
        alias: name,
        callShape: "parens",
        isDirectComponentCall: true,
      };
    }
    const curriedMatch = DIRECT_CURRIED_PATTERN.exec(before);
    if (curriedMatch && directComponents.has(curriedMatch[1])) {
      const name = curriedMatch[1];
      return {
        className: name,
        isStringLiteralName: false,
        alias: name,
        callShape: "curried",
        isDirectComponentCall: true,
      };
    }
  }

  return undefined;
}

export interface EnclosingStringArg {
  alias: string;
  callShape: "parens" | "curried";
  /** The curried name stage is parenthesized and must close before the props stage opens. */
  nameStageParens?: boolean;
  quote: '"' | "'" | "`";
  /** Opening quote offset. */
  stringStart: number;
  /** Closing quote offset, or -1 if absent on this line. */
  stringEnd: number;
  /** Closing parenthesis safe to consume in the same-line edit, or -1. */
  closeParen: number;
  /** Existing props follow the name; do not insert another props block. */
  hasPropsAfter: boolean;
  /** Existing punctuation/comments must stay outside the single-line edit. */
  preserveSuffix?: boolean;
}

/** Find a factory's quoted class-name argument containing the cursor. */
export function findEnclosingFactoryStringArg(
  text: string,
  cursorIndex: number,
  aliases: AliasPartition | string[]
): EnclosingStringArg | undefined {
  const partition = asPartition(aliases);
  if (partition.parens.length === 0 && partition.curried.length === 0) {
    return undefined;
  }

  let stringStart = -1;
  let quote: '"' | "'" | "`" | undefined;
  for (let i = cursorIndex - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "\n") {
      return undefined;
    }
    if (c === '"' || c === "'" || c === "`") {
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && text[j] === "\\") {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 0) {
        stringStart = i;
        quote = c;
        break;
      }
    }
  }
  if (stringStart === -1 || !quote) {
    return undefined;
  }

  for (let i = stringStart + 1; i < cursorIndex; i++) {
    const c = text[i];
    if (!/[A-Za-z0-9_]/.test(c)) {
      return undefined;
    }
  }

  let stringEnd = -1;
  for (let i = cursorIndex; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      break;
    }
    if (c === quote) {
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && text[j] === "\\") {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 0) {
        stringEnd = i;
        break;
      }
    }
    if (!/[A-Za-z0-9_]/.test(c)) {
      return undefined;
    }
  }

  const beforeSliceStart = Math.max(0, stringStart - 200);
  const before = text.slice(beforeSliceStart, stringStart);

  let alias: string | undefined;
  let callShape: "parens" | "curried" | undefined;
  let nameStageParens = false;

  if (partition.parens.length > 0) {
    const aliasPattern = buildAliasAlternation(partition.parens);
    const pattern = new RegExp(
      `(?:^|[^A-Za-z0-9_.])(${aliasPattern})\\s*\\(\\s*$`
    );
    const m = pattern.exec(before);
    if (m) {
      alias = m[1];
      callShape = "parens";
    }
  }
  if (!alias && partition.curried.length > 0) {
    const aliasPattern = buildAliasAlternation(partition.curried);
    const pattern = new RegExp(
      `(?:^|[^A-Za-z0-9_.])${RECEIVER_PREFIX}(${aliasPattern})\\s+$`
    );
    const m = pattern.exec(before);
    if (m) {
      alias = m[1];
      callShape = "curried";
    }
  }
  if (!alias && partition.curried.length > 0) {
    const aliasPattern = buildAliasAlternation(partition.curried);
    const pattern = factoryNameStageParensPatternFor(aliasPattern);
    const m = pattern.exec(before);
    if (m) {
      alias = m[1];
      callShape = "curried";
      nameStageParens = true;
    }
  }
  if (!alias || !callShape) {
    return undefined;
  }

  // Inspect across lines, but consume closing punctuation only in a same-line, trivia-free edit.
  let closeParen = -1;
  let hasPropsAfter = false;
  let preserveSuffix = false;
  const skipTrivia = (start: number): number => {
    let i = start;
    while (i < text.length) {
      if (/\s/.test(text[i])) { i++; continue; }
      if (!text.startsWith("--", i)) { break; }
      const block = /^--\[(=*)\[/.exec(text.slice(i));
      if (block) {
        const end = text.indexOf(`]${block[1]}]`, i + block[0].length);
        i = end < 0 ? text.length : end + block[1].length + 2;
      } else {
        const end = text.indexOf("\n", i + 2);
        i = end < 0 ? text.length : end + 1;
      }
    }
    return i;
  };
  if (stringEnd !== -1) {
    const i = skipTrivia(stringEnd + 1);
    if (callShape === "parens") {
      if (text[i] === ",") {
        // Existing props may be a table, a variable or an unfinished argument.
        hasPropsAfter = true;
      } else if (text[i] === ")") {
        const next = skipTrivia(i + 1);
        if (partition.curried.includes(alias) && (text[next] === "{" || text[next] === "(")) {
          callShape = "curried";
          nameStageParens = true;
          hasPropsAfter = true;
        } else if (/^[ \t]*$/.test(text.slice(stringEnd + 1, i))) {
          closeParen = i;
        } else {
          preserveSuffix = true;
        }
      }
    } else if (nameStageParens) {
      if (text[i] === ")") {
        const j = skipTrivia(i + 1);
        if (text[j] === "{" || text[j] === "(") {
          hasPropsAfter = true;
        } else if (/^[ \t]*$/.test(text.slice(stringEnd + 1, i))) {
          closeParen = i;
        } else {
          preserveSuffix = true;
        }
      }
    } else {
      if (text[i] === "{" || text[i] === "(") {
        hasPropsAfter = true;
      }
    }
  }

  return {
    alias,
    callShape,
    nameStageParens,
    quote,
    stringStart,
    stringEnd,
    closeParen,
    hasPropsAfter,
    preserveSuffix,
  };
}

export interface PropEntry {
  key: string;
  /** Offsets are relative to the supplied table body. */
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

/** Extract top-level Key = value entries from a brace-free table body, excluding computed keys. */
export function extractPropEntries(bodyText: string): PropEntry[] {
  // Keep short-lived props fragments out of the shared analysis cache.
  return parsePropEntriesFromMasked(maskUncached(bodyText));
}

/** Extract entries using the full document's cached mask. */
export function extractPropEntriesFromDocument(
  fullText: string,
  bodyStart: number,
  bodyEnd: number
): PropEntry[] {
  return parsePropEntriesFromMasked(
    analysisFor(fullText, true).masked.slice(bodyStart, bodyEnd)
  );
}

function parsePropEntriesFromMasked(masked: string): PropEntry[] {
  const out: PropEntry[] = [];
  let i = 0;
  while (i < masked.length) {
    while (i < masked.length && /[\s,;]/.test(masked[i])) {
      i++;
    }
    if (i >= masked.length) {
      break;
    }
    if (masked[i] === "[") {
      let depth = 1;
      i++;
      while (i < masked.length && depth > 0) {
        if (masked[i] === "[") {depth++;}
        else if (masked[i] === "]") {depth--;}
        i++;
      }
      while (i < masked.length && /\s/.test(masked[i])) {i++;}
      if (masked[i] === "=") {
        i++;
        i = skipValueExpression(masked, i);
      }
      continue;
    }
    if (!/[A-Za-z_]/.test(masked[i])) {
      // Unmatched closers can stop value scanning immediately; always advance to avoid an infinite loop.
      i = Math.max(i + 1, skipValueExpression(masked, i));
      continue;
    }
    const keyStart = i;
    while (i < masked.length && /\w/.test(masked[i])) {
      i++;
    }
    const keyEnd = i;
    const key = masked.slice(keyStart, keyEnd);
    while (i < masked.length && /\s/.test(masked[i])) {
      i++;
    }
    if (masked[i] !== "=") {
      continue;
    }
    i++;
    while (i < masked.length && /\s/.test(masked[i])) {
      i++;
    }
    const valueStart = i;
    i = skipValueExpression(masked, i);
    out.push({ key, keyStart, keyEnd, valueStart, valueEnd: i });
  }
  return out;
}

function skipValueExpression(masked: string, start: number): number {
  let i = start;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  while (i < masked.length) {
    const c = masked[i];
    if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      if (c === "," || c === ";") {
        return i;
      }
    }
    if (c === "{") {braceDepth++;}
    else if (c === "}") {
      if (braceDepth === 0) {return i;}
      braceDepth--;
    } else if (c === "(") {parenDepth++;}
    else if (c === ")") {
      if (parenDepth === 0) {return i;}
      parenDepth--;
    } else if (c === "[") {bracketDepth++;}
    else if (c === "]") {
      if (bracketDepth === 0) {return i;}
      bracketDepth--;
    }
    i++;
  }
  return i;
}

/** Extract top-level fields from a brace-free type literal, excluding index signatures and nested fields. */
export function extractTypeFields(literalBody: string): string[] {
  const masked = maskUncached(literalBody);
  const fields: string[] = [];
  let i = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let angleDepth = 0;
  let expectingFieldName = true;

  while (i < masked.length) {
    const c = masked[i];

    if (c === "{") {
      braceDepth++;
      expectingFieldName = false;
      i++;
      continue;
    }
    if (c === "}") {
      braceDepth--;
      i++;
      continue;
    }
    if (c === "(") {
      parenDepth++;
      expectingFieldName = false;
      i++;
      continue;
    }
    if (c === ")") {
      parenDepth--;
      i++;
      continue;
    }
    if (c === "<") {
      angleDepth++;
      expectingFieldName = false;
      i++;
      continue;
    }
    if (c === ">") {
      if (angleDepth > 0) {
        angleDepth--;
      }
      i++;
      continue;
    }

    const atTopLevel =
      braceDepth === 0 && parenDepth === 0 && angleDepth === 0;

    if (atTopLevel) {
      if (c === "," || c === ";") {
        expectingFieldName = true;
        i++;
        continue;
      }
      if (c === "[") {
        let depth = 1;
        i++;
        while (i < masked.length && depth > 0) {
          if (masked[i] === "[") {
            depth++;
          } else if (masked[i] === "]") {
            depth--;
          }
          i++;
        }
        expectingFieldName = false;
        continue;
      }
      if (expectingFieldName && /[A-Za-z_]/.test(c)) {
        const start = i;
        while (i < masked.length && /\w/.test(masked[i])) {
          i++;
        }
        const name = masked.slice(start, i);
        let j = i;
        while (j < masked.length && /\s/.test(masked[j])) {
          j++;
        }
        if (masked[j] === ":") {
          fields.push(name);
        }
        expectingFieldName = false;
        continue;
      }
    }

    i++;
  }

  return fields;
}

/** Read recognized directives from consecutive triple-dash lines before the definition. */
export function parseAnnotationsForComponent(
  text: string,
  defLineIndex: number
): ComponentAnnotations {
  return parseAnnotationsFromLines(text.split("\n"), defLineIndex);
}

function parseAnnotationsFromLines(
  lines: readonly string[],
  defLineIndex: number
): ComponentAnnotations {
  const result: ComponentAnnotations = { props: [] };
  const commentLines: string[] = [];

  for (let i = defLineIndex - 1; i >= 0; i--) {
    const trimmed = lines[i].trimStart();
    if (!trimmed.startsWith("---")) {
      break;
    }
    commentLines.unshift(trimmed);
  }

  for (const line of commentLines) {
    const extendsMatch = /^---\s*@extends\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(
      line
    );
    if (extendsMatch) {
      result.extendsClass = extendsMatch[1];
      continue;
    }
    const propMatch = /^---\s*@prop\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (propMatch) {
      result.props.push(propMatch[1]);
      continue;
    }
  }

  return result;
}

// Share one block-keyword pass across functions to avoid quadratic scans of unfinished bodies.

const BLOCK_KEYWORD_RE = /\b(?:function|if|do|repeat|end|until|return)\b/g;

interface BlockIndex {
  /** Block-keyword offsets in ascending order. */
  starts: number[];
  ends: number[];
  /** Depth after each keyword; may be negative in unbalanced text. */
  depthAfter: number[];
  /** Number of function entries on the block stack before each keyword. */
  fnBefore: number[];
  /** Closer keyword indexes grouped by their resulting depth. */
  closersByDepth: Map<number, number[]>;
  /** Return keyword indexes grouped by their fnBefore value. */
  returnsByFn: Map<number, number[]>;
}

function buildBlockIndex(masked: string): BlockIndex {
  const starts: number[] = [];
  const ends: number[] = [];
  const depthAfter: number[] = [];
  const fnBefore: number[] = [];
  const closersByDepth = new Map<number, number[]>();
  const returnsByFn = new Map<number, number[]>();
  // 1 marks function entries; 0 marks other blocks.
  const stack: number[] = [];
  let depth = 0;
  let fns = 0;
  const re = new RegExp(BLOCK_KEYWORD_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const word = m[0];
    const k = starts.length;
    starts.push(m.index);
    ends.push(m.index + word.length);
    fnBefore.push(fns);
    if (word === "function") {
      depth++;
      stack.push(1);
      fns++;
    } else if (word === "end" || word === "until") {
      depth--;
      if (stack.length > 0 && stack.pop() === 1) {
        fns--;
      }
      let closers = closersByDepth.get(depth);
      if (!closers) {
        closersByDepth.set(depth, (closers = []));
      }
      closers.push(k);
    } else if (word === "return") {
      let returns = returnsByFn.get(fns);
      if (!returns) {
        returnsByFn.set(fns, (returns = []));
      }
      returns.push(k);
    } else {
      depth++;
      stack.push(0);
    }
    depthAfter.push(depth);
  }
  return { starts, ends, depthAfter, fnBefore, closersByDepth, returnsByFn };
}

/** Find the first closer one level below the body start, or return the text length if unclosed. */
function matchingEnd(ix: BlockIndex, maskedLength: number, startIdx: number): number {
  const k0 = lowerBound(ix.starts, startIdx);
  const base = k0 > 0 ? ix.depthAfter[k0 - 1] : 0;
  const closers = ix.closersByDepth.get(base - 1);
  if (closers) {
    const j = lowerBound(closers, k0);
    if (j < closers.length) {
      return ix.ends[closers[j]];
    }
  }
  return maskedLength;
}

/** Visit the body's own returns in source order, excluding nested functions; stop when visit returns true. */
function forEachOwnReturn(
  ix: BlockIndex,
  bodyStart: number,
  bodyEnd: number,
  visit: (afterReturn: number) => boolean
): void {
  const k0 = lowerBound(ix.starts, bodyStart);
  if (k0 >= ix.starts.length) {
    return;
  }
  const returns = ix.returnsByFn.get(ix.fnBefore[k0]);
  if (!returns) {
    return;
  }
  for (let j = lowerBound(returns, k0); j < returns.length; j++) {
    const k = returns[j];
    if (ix.starts[k] >= bodyEnd || visit(ix.ends[k])) {
      return;
    }
  }
}

/** Cache the block map for caller-supplied masked text outside the shared analysis cache. */
let looseBlocks: { masked: string; index: BlockIndex } | undefined;

function blocksForMasked(originalText: string, masked: string): BlockIndex {
  const analysis = peekAnalysis(originalText);
  if (analysis && analysis.masked === masked) {
    return analysis.blocks;
  }
  if (looseBlocks?.masked !== masked) {
    looseBlocks = { masked, index: buildBlockIndex(masked) };
  }
  return looseBlocks.index;
}

function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 1;
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

// Return-pattern captures: parens 1-3, curried sugar 4-6, curried parens 7-9.
const returnPatternCache = new Map<string, RegExp | null>();

function returnAliasPatternFor(partition: AliasPartition): RegExp | null {
  const key = partition.parens.join("|") + "\0" + partition.curried.join("|");
  const hit = returnPatternCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const parts: string[] = [];
  if (partition.parens.length > 0) {
    const a = buildAliasAlternation(partition.parens);
    parts.push(`(?:${a})\\s*\\(\\s*${CLASS_NAME_ALT}`);
  }
  if (partition.curried.length > 0) {
    const a = buildAliasAlternation(partition.curried);
    parts.push(`${RECEIVER_PREFIX}(?:${a})\\s+${CLASS_NAME_ALT}`);
    parts.push(
      `${RECEIVER_PREFIX}(?:${a})\\s*\\(\\s*${LEADING_ARGS}${CLASS_NAME_ALT}\\s*\\)`
    );
  }
  const re = parts.length === 0
    ? null
    : new RegExp(`^\\s*\\(?\\s*(?:${parts.join("|")})`);
  returnPatternCache.set(key, re);
  return re;
}

/** Find a factory return outside nested functions; use originalText for class names hidden by masking. */
export function detectReturnedClass(
  originalText: string,
  maskedText: string,
  bodyStart: number,
  bodyEnd: number,
  aliases: AliasPartition | string[]
): string | undefined {
  const pattern = returnAliasPatternFor(asPartition(aliases));
  if (!pattern) {
    return undefined;
  }
  return detectReturnedClassIn(
    blocksForMasked(originalText, maskedText),
    originalText,
    bodyStart,
    bodyEnd,
    pattern
  );
}

function detectReturnedClassIn(
  ix: BlockIndex,
  originalText: string,
  bodyStart: number,
  bodyEnd: number,
  pattern: RegExp
): string | undefined {
  let found: string | undefined;
  forEachOwnReturn(ix, bodyStart, bodyEnd, (afterReturn) => {
    const r = pattern.exec(originalText.slice(afterReturn, bodyEnd));
    found = r?.slice(1).find(Boolean);
    return found !== undefined;
  });
  return found;
}

/** Sort by source position while retaining discovery order for tie-breaking. */
interface SortedCalls {
  calls: CreateElementCall[];
  order: number[];
  starts: number[];
}

function sortCalls(calls: CreateElementCall[]): SortedCalls {
  const order = calls.map((_call, i) => i);
  order.sort((a, b) => calls[a].aliasStart - calls[b].aliasStart || a - b);
  return { calls, order, starts: order.map((i) => calls[i].aliasStart) };
}

/** Allow whitespace, one opening parenthesis and an optional receiver after return. */
const ROOT_GAP = /^\s*\(?\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*[.:]\s*)?$/;
/** Greedy prefix bounds the longest gap ROOT_GAP can accept. */
const ROOT_GAP_PREFIX = /\s*\(?\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*[.:]\s*)?/y;

/** Find the first own return followed by a factory call, preserving discovery-order priority. */
function findReturnedRootCallIn(
  ix: BlockIndex,
  rootCalls: () => SortedCalls,
  originalText: string,
  bodyStart: number,
  bodyEnd: number
): CreateElementCall | undefined {
  let found: CreateElementCall | undefined;
  forEachOwnReturn(ix, bodyStart, bodyEnd, (after) => {
    const sorted = rootCalls();
    ROOT_GAP_PREFIX.lastIndex = after;
    const longest = ROOT_GAP_PREFIX.exec(originalText);
    const limit = after + (longest ? longest[0].length : 0);
    let best = -1;
    for (let j = lowerBound(sorted.starts, after); j < sorted.starts.length && sorted.starts[j] <= limit; j++) {
      const index = sorted.order[j];
      const call = sorted.calls[index];
      if (
        call.aliasStart < bodyEnd &&
        (best === -1 || index < best) &&
        ROOT_GAP.test(originalText.slice(after, call.aliasStart))
      ) {
        best = index;
      }
    }
    if (best !== -1) {
      found = sorted.calls[best];
      return true;
    }
    return false;
  });
  return found;
}

/** Textual forwarding check; indirect aliases of props are not resolved. */
function hardcodedPropsOf(
  rootCall: CreateElementCall | undefined,
  originalText: string,
  paramName: string | undefined,
  entriesByCall: Map<CreateElementCall, PropEntry[]>
): Set<string> | undefined {
  if (
    !rootCall ||
    rootCall.propsBraceStart === undefined ||
    rootCall.propsBraceEnd === undefined
  ) {
    return undefined;
  }

  const propsBody = originalText.slice(
    rootCall.propsBraceStart + 1,
    rootCall.propsBraceEnd
  );
  let entries = entriesByCall.get(rootCall);
  if (!entries) {
    entries = extractPropEntries(propsBody);
    entriesByCall.set(rootCall, entries);
  }
  if (entries.length === 0) {
    return undefined;
  }

  // Match the actual parameter name; use conventional props when absent or ignored.
  const candidate = paramName && paramName !== "_" ? paramName : "props";
  const re = new RegExp(`\\b${candidate}\\b`);

  const out = new Set<string>();
  for (const entry of entries) {
    const valueText = propsBody.slice(entry.valueStart, entry.valueEnd);
    if (!re.test(valueText)) {
      out.add(entry.key);
    }
  }
  return out.size > 0 ? out : undefined;
}

function collectTypeAliases(maskedText: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const re = /\btype\s+([A-Za-z_]\w*)\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(maskedText)) !== null) {
    const name = m[1];
    const braceStart = m.index + m[0].length - 1;
    const braceEnd = findMatchingBrace(maskedText, braceStart);
    if (braceEnd === -1) {
      continue;
    }
    const body = maskedText.slice(braceStart + 1, braceEnd);
    result.set(name, extractTypeFields(body));
  }
  return result;
}

interface FunctionDef {
  name: string;
  defIdx: number;
  paramType?: string;
  paramName?: string;
  /** Type annotation start after the colon, used to locate unused-prop fields. */
  paramTypeStart?: number;
  paramTypeEnd?: number;
  bodyStart: number;
  bodyEnd: number;
}

interface ParameterListInfo {
  firstParamType?: string;
  firstParamName?: string;
  firstParamTypeStart?: number;
  firstParamTypeEnd?: number;
  paramListEnd: number;
}

interface ParsedParameter {
  name: string;
  type?: string;
  typeStart?: number;
  typeEnd?: number;
}

/** Fusion 0.3 may pass scope before props; require an explicit scope name or type to infer it. */
function looksLikeFusionScopeParam(param: ParsedParameter): boolean {
  if (/^_?scope$/i.test(param.name)) {
    return true;
  }
  return !!param.type && /\bScope\b/.test(param.type);
}

function parseParameterList(
  maskedText: string,
  openParenIdx: number
): ParameterListInfo | undefined {
  const params: ParsedParameter[] = [];
  let i = openParenIdx + 1;
  let depth = 1;

  while (i < maskedText.length) {
    while (i < maskedText.length && /[\s,]/.test(maskedText[i])) {
      i++;
    }
    if (maskedText[i] === ")") {
      break;
    }

    const nameStart = i;
    while (i < maskedText.length && /\w/.test(maskedText[i])) {
      i++;
    }
    if (i === nameStart) {
      break;
    }
    const param: ParsedParameter = {
      name: maskedText.slice(nameStart, i),
    };

    let j = i;
    while (j < maskedText.length && /\s/.test(maskedText[j])) {
      j++;
    }
    if (maskedText[j] === ":") {
      j++;
      while (j < maskedText.length && /\s/.test(maskedText[j])) {
        j++;
      }
      const typeStart = j;
      let typeEnd = j;
      let bDepth = 0;
      let pDepth = 0;
      let aDepth = 0;
      while (typeEnd < maskedText.length) {
        const c = maskedText[typeEnd];
        if (bDepth === 0 && pDepth === 0 && aDepth === 0) {
          if (c === "," || c === ")") {
            break;
          }
        }
        if (c === "{") {
          bDepth++;
        } else if (c === "}") {
          bDepth--;
        } else if (c === "(") {
          pDepth++;
        } else if (c === ")") {
          if (pDepth === 0) {
            break;
          }
          pDepth--;
        } else if (c === "<") {
          aDepth++;
        } else if (c === ">") {
          if (aDepth > 0) {
            aDepth--;
          }
        }
        typeEnd++;
      }
      param.type = maskedText.slice(typeStart, typeEnd).trim();
      param.typeStart = typeStart;
      param.typeEnd = typeEnd;
      i = typeEnd;
    }

    params.push(param);
    // Only props, or scope plus props, are needed.
    if (params.length === 2) {
      break;
    }
  }

  const propsParam =
    params.length > 1 && looksLikeFusionScopeParam(params[0])
      ? params[1]
      : params[0];

  while (i < maskedText.length) {
    const c = maskedText[i];
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return {
          firstParamType: propsParam?.type,
          firstParamName: propsParam?.name,
          firstParamTypeStart: propsParam?.typeStart,
          firstParamTypeEnd: propsParam?.typeEnd,
          paramListEnd: i,
        };
      }
    }
    i++;
  }
  return undefined;
}

function findFunctionDefinitions(maskedText: string, blocks: BlockIndex): FunctionDef[] {
  const results: FunctionDef[] = [];

  const p1 =
    /(?<![A-Za-z0-9_])(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g;
  const p2 =
    /(?<![A-Za-z0-9_])local\s+([A-Za-z_]\w*)\s*=\s*function\s*\(/g;

  for (const pattern of [p1, p2]) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(maskedText)) !== null) {
      const name = m[1];
      const defIdx = m.index;
      const openParenIdx = m.index + m[0].length - 1;
      const sig = parseParameterList(maskedText, openParenIdx);
      if (!sig) {
        continue;
      }
      const bodyStart = sig.paramListEnd + 1;
      const bodyEnd = matchingEnd(blocks, maskedText.length, bodyStart);
      results.push({
        name,
        defIdx,
        paramType: sig.firstParamType,
        paramName: sig.firstParamName,
        paramTypeStart: sig.firstParamTypeStart,
        paramTypeEnd: sig.firstParamTypeEnd,
        bodyStart,
        bodyEnd,
      });
    }
  }

  results.sort((a, b) => a.defIdx - b.defIdx);
  return results;
}

/** Cached component definitions by alias set; callers must not mutate the returned Map. */
export function scanDocument(
  text: string,
  aliases: AliasPartition | string[]
): Map<string, DocumentComponentInfo> {
  const partition = asPartition(aliases);
  const aliasesKey =
    partition.parens.join("|") + "\0" + partition.curried.join("|");
  const analysis = analysisFor(text, true);
  const cached = analysis.scans.get(aliasesKey);
  if (cached) {
    return cached;
  }
  const components = scanAnalysis(analysis, partition);
  analysis.scans.set(aliasesKey, components);
  trimResults(analysis.scans);
  return components;
}

function scanAnalysis(
  analysis: TextAnalysis,
  partition: AliasPartition
): Map<string, DocumentComponentInfo> {
  const text = analysis.text;
  const masked = analysis.masked;
  const blocks = analysis.blocks;
  const typeAliases = collectTypeAliases(masked);
  const components = new Map<string, DocumentComponentInfo>();
  const returnPattern = returnAliasPatternFor(partition);
  let sortedCalls: SortedCalls | undefined;
  const rootCalls = () => (sortedCalls ??= sortCalls(rawCallsOf(analysis, partition)));
  const entriesByCall = new Map<CreateElementCall, PropEntry[]>();

  for (const def of findFunctionDefinitions(masked, blocks)) {
    const lastSegment = def.name.split(".").pop()!;
    if (components.has(lastSegment)) {
      continue;
    }

    const defLineIndex = analysis.lineOf(def.defIdx);
    const annotations = parseAnnotationsFromLines(analysis.lines, defLineIndex);

    let paramTypeFields: string[] | undefined;
    if (def.paramType) {
      const tt = def.paramType.trim();
      if (tt.startsWith("{") && tt.endsWith("}")) {
        paramTypeFields = extractTypeFields(tt.slice(1, -1));
      } else if (/^[A-Za-z_]\w*$/.test(tt)) {
        const aliasFields = typeAliases.get(tt);
        if (aliasFields) {
          paramTypeFields = aliasFields;
        }
      }
    }

    const detectedBase = returnPattern
      ? detectReturnedClassIn(blocks, text, def.bodyStart, def.bodyEnd, returnPattern)
      : undefined;

    const hardcodedProps = hardcodedPropsOf(
      findReturnedRootCallIn(blocks, rootCalls, text, def.bodyStart, def.bodyEnd),
      text,
      def.paramName,
      entriesByCall
    );

    components.set(lastSegment, {
      name: lastSegment,
      defLineIndex,
      paramTypeFields,
      annotations,
      detectedBase,
      hardcodedProps,
      paramName: def.paramName,
      bodyStart: def.bodyStart,
      bodyEnd: def.bodyEnd,
      paramTypeStart: def.paramTypeStart,
      paramTypeEnd: def.paramTypeEnd,
    });
  }

  return components;
}

export interface DirectCallOptions {
  componentNames?: ReadonlySet<string>;
  instanceNames?: ReadonlySet<string>;
}

function partitionKey(partition: AliasPartition): string {
  return JSON.stringify([
    partition.parens, partition.curried, partition.parensWithInlineChildren,
  ]);
}

// Cache sorted name keys per set to avoid sorting on every lookup.
const namesKeyCache = new WeakMap<ReadonlySet<string>, { size: number; key: string }>();

function namesKey(names: ReadonlySet<string> | undefined): string {
  if (!names || names.size === 0) {
    return "[]";
  }
  const hit = namesKeyCache.get(names);
  if (hit && hit.size === names.size) {
    return hit.key;
  }
  const key = JSON.stringify([...names].sort());
  namesKeyCache.set(names, { size: names.size, key });
  return key;
}

/** Factory calls in discovery order, shared by component and call scans. */
function rawCallsOf(analysis: TextAnalysis, partition: AliasPartition): CreateElementCall[] {
  const key = partitionKey(partition);
  let calls = analysis.rawCalls.get(key);
  if (!calls) {
    calls = findFactoryCalls(analysis, partition);
    analysis.rawCalls.set(key, calls);
    trimResults(analysis.rawCalls);
  }
  return calls;
}

/** Cached calls in document order; callers must not mutate the returned array. */
export function findAllCreateElementCalls(
  text: string,
  aliases: AliasPartition | string[],
  directCalls?: DirectCallOptions
): CreateElementCall[] {
  const partition = asPartition(aliases);
  const key = partitionKey(partition) + "\0" +
    namesKey(directCalls?.componentNames) + "\0" +
    namesKey(directCalls?.instanceNames);
  const analysis = analysisFor(text, true);
  const cached = analysis.calls.get(key);
  if (cached) {
    return cached;
  }
  const factory = rawCallsOf(analysis, partition);
  const result = directCalls
    ? factory.concat(findDirectCalls(analysis, factory, directCalls))
    : factory.slice();
  result.sort((a, b) => a.aliasStart - b.aliasStart);
  analysis.calls.set(key, result);
  trimResults(analysis.calls);
  return result;
}

const parensCallPatternCache = new Map<string, RegExp>();
const curriedCallPatternCache = new Map<string, RegExp>();

function factoryPattern(cache: Map<string, RegExp>, aliasPattern: string, build: () => string): RegExp {
  let re = cache.get(aliasPattern);
  if (!re) {
    re = new RegExp(build(), "g");
    cache.set(aliasPattern, re);
  }
  re.lastIndex = 0;
  return re;
}

function findFactoryCalls(
  analysis: TextAnalysis,
  partition: AliasPartition
): CreateElementCall[] {
  const text = analysis.text;
  const masked = analysis.masked;
  const results: CreateElementCall[] = [];

  if (partition.parens.length > 0) {
    const aliasPattern = buildAliasAlternation(partition.parens);
    const re = factoryPattern(parensCallPatternCache, aliasPattern, () =>
      `(?<![A-Za-z0-9_.])(${aliasPattern})\\s*\\(`
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const alias = m[1];
      const aliasStart = m.index;
      const openParen = m.index + m[0].length - 1;
      const closeParen = findMatchingParen(masked, openParen);
      if (closeParen === -1) {
        continue;
      }

      const argRanges = splitTopLevelArgs(masked, openParen + 1, closeParen);
      if (argRanges.length < 2) {
        continue;
      }

      // A second props stage identifies a curried call; leave it to the next pass to avoid duplicates.
      if (
        partition.curried.includes(alias) &&
        curriedPropsStageFollows(text, closeParen + 1)
      ) {
        continue;
      }

      const classNameInfo = parseFirstArgClassName(
        text,
        argRanges[0].start,
        argRanges[0].end
      );
      if (!classNameInfo) {
        continue;
      }

      const propsText = text.slice(argRanges[1].start, argRanges[1].end);
      const nameMatch = /\bName\s*=\s*"([^"\n]*)"/.exec(propsText);
      const nameProp = nameMatch ? nameMatch[1] : undefined;

      let propsBraceStart: number | undefined;
      let propsBraceEnd: number | undefined;
      const propsOpenBrace = findFirstChar(
        masked,
        "{",
        argRanges[1].start,
        argRanges[1].end
      );
      if (propsOpenBrace !== -1) {
        const propsCloseBrace = findMatchingBrace(masked, propsOpenBrace);
        if (propsCloseBrace !== -1) {
          propsBraceStart = propsOpenBrace;
          propsBraceEnd = propsCloseBrace;
        }
      }

      let childrenStart: number | undefined;
      let childrenEnd: number | undefined;
      if (argRanges.length >= 3) {
        const childArg = argRanges[2];
        const openBrace = findFirstChar(
          masked,
          "{",
          childArg.start,
          childArg.end
        );
        if (openBrace !== -1) {
          const closeBrace = findMatchingBrace(masked, openBrace);
          if (closeBrace !== -1) {
            childrenStart = openBrace + 1;
            childrenEnd = closeBrace;
          }
        }
      } else if (
        // Use explicit inline-child aliases when available; otherwise retain the legacy bucket fallback.
        (partition.parensWithInlineChildren
          ? partition.parensWithInlineChildren.includes(alias)
          : partition.curried.includes(alias)) &&
        propsBraceStart !== undefined &&
        propsBraceEnd !== undefined
      ) {
        // Vide's props table also contains its children.
        childrenStart = propsBraceStart + 1;
        childrenEnd = propsBraceEnd;
      }

      results.push({
        className: classNameInfo.name,
        isStringLiteralName: classNameInfo.isString,
        nameProp,
        alias,
        aliasStart,
        fullEnd: closeParen + 1,
        classNameStart: classNameInfo.start,
        classNameEnd: classNameInfo.end,
        childrenStart,
        childrenEnd,
        propsBraceStart,
        propsBraceEnd,
      });
    }
  }

  // Parse curried stages from original text because masking hides quoted class names.
  if (partition.curried.length > 0) {
    const aliasPattern = buildAliasAlternation(partition.curried);
    // A lazy receiver preserves whole dotted aliases; the forward parser validates the call shape.
    const aliasRe = factoryPattern(curriedCallPatternCache, aliasPattern, () =>
      `(?<![A-Za-z0-9_.])((?:[A-Za-z_][A-Za-z0-9_]*\\s*[.:]\\s*)??)` +
        `(?:${aliasPattern})(?![A-Za-z0-9_])`
    );
    let m: RegExpExecArray | null;
    while ((m = aliasRe.exec(masked)) !== null) {
      const parsed = parseCurriedCall(text, masked, m.index + m[0].length);
      if (!parsed) {
        continue;
      }
      // Keep the receiver in the full source range and separately for code generation.
      const receiver = m[1];
      const alias = m[0].slice(receiver.length);

      const propsText = text.slice(parsed.openBrace + 1, parsed.closeBrace);
      const nameMatch = /\bName\s*=\s*"([^"\n]*)"/.exec(propsText);
      const nameProp = nameMatch ? nameMatch[1] : undefined;

      results.push({
        className: parsed.name,
        isStringLiteralName: parsed.isString,
        nameProp,
        alias,
        receiver,
        aliasStart: m.index,
        fullEnd: parsed.fullEnd,
        classNameStart: parsed.classNameStart,
        classNameEnd: parsed.classNameEnd,
        childrenStart: parsed.openBrace + 1,
        childrenEnd: parsed.closeBrace,
        propsBraceStart: parsed.openBrace,
        propsBraceEnd: parsed.closeBrace,
      });
    }
  }

  return results;
}

/** Recognize only configured direct names, skipping offsets already claimed by factories. */
function findDirectCalls(
  analysis: TextAnalysis,
  factoryCalls: CreateElementCall[],
  directCalls: DirectCallOptions
): CreateElementCall[] {
  const text = analysis.text;
  const masked = analysis.masked;
  const results: CreateElementCall[] = [];
  {
    const names = new Set([
      ...(directCalls.componentNames ?? []),
      ...(directCalls.instanceNames ?? []),
    ]);
    const existingStarts = new Set(factoryCalls.map((call) => call.aliasStart));
    const re = /(?<![A-Za-z0-9_.:])([A-Za-z_][A-Za-z0-9_]*)\s*(?=[({])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const name = m[1];
      if (!names.has(name) || existingStarts.has(m.index)) {continue;}
      // Function parameter tables are not calls; inspect the preceding token.
      let before = m.index - 1;
      while (before >= 0 && /\s/.test(masked[before])) {before--;}
      if (masked.slice(Math.max(0, before - 7), before + 1) === "function" &&
          !/[A-Za-z0-9_]/.test(masked[before - 8] ?? "")) {continue;}
      let openBrace = m.index + m[0].length;
      let fullEnd: number;
      if (masked[openBrace] === "(") {
        const closeParen = findMatchingParen(masked, openBrace);
        if (closeParen === -1) {continue;}
        const args = splitTopLevelArgs(masked, openBrace + 1, closeParen);
        // Custom components may pass Fusion scope before props.
        const arg = args.length === 1 ? args[0]
          : args.length === 2 && directCalls.componentNames?.has(name)
            ? args[1] : undefined;
        if (!arg) {continue;}
        openBrace = arg.start;
        while (/\s/.test(masked[openBrace] ?? "") && openBrace < arg.end) {openBrace++;}
        if (masked[openBrace] !== "{") {continue;}
        const endBrace = findMatchingBrace(masked, openBrace);
        if (endBrace === -1 || masked.slice(endBrace + 1, arg.end).trim()) {continue;}
        fullEnd = closeParen + 1;
      } else {
        const closeBrace = findMatchingBrace(masked, openBrace);
        if (closeBrace === -1) {continue;}
        fullEnd = closeBrace + 1;
      }
      const closeBrace = findMatchingBrace(masked, openBrace);
      if (closeBrace === -1) {continue;}
      const entries = parsePropEntriesFromMasked(masked.slice(openBrace + 1, closeBrace));
      const nameEntry = entries.find((entry) => entry.key === "Name");
      const nameValue = nameEntry && text.slice(
        openBrace + 1 + nameEntry.valueStart, openBrace + 1 + nameEntry.valueEnd
      ).trim();
      const nameProp = nameValue && /^(["'])([^\n]*?)\1$/.exec(nameValue)?.[2];
      results.push({
        className: name, isStringLiteralName: false,
        isDirectComponentCall: true,
        isDirectInstanceCall: directCalls.instanceNames?.has(name) ?? false,
        nameProp: nameProp || undefined, alias: name,
        aliasStart: m.index, fullEnd,
        classNameStart: m.index, classNameEnd: m.index + name.length,
        propsBraceStart: openBrace, propsBraceEnd: closeBrace,
        childrenStart: openBrace + 1, childrenEnd: closeBrace,
      });
    }
  }

  return results;
}

function curriedPropsStageFollows(text: string, from: number): boolean {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  if (text[i] === "{") {
    return true;
  }
  if (text[i] !== "(") {
    return false;
  }
  i++;
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  return text[i] === "{";
}

interface ParsedCurriedCall {
  name: string;
  isString: boolean;
  classNameStart: number;
  classNameEnd: number;
  openBrace: number;
  closeBrace: number;
  /** Offset after the full call, including the props-stage closing parenthesis if present. */
  fullEnd: number;
}

/** Require a complete name/props pair to reject unrelated identifiers and two-argument parens calls. */
function parseCurriedCall(
  text: string,
  masked: string,
  afterAlias: number
): ParsedCurriedCall | undefined {
  const skipSpace = (from: number): number => {
    let i = from;
    while (i < text.length && /\s/.test(text[i])) {
      i++;
    }
    return i;
  };

  let i = skipSpace(afterAlias);

  let name: string | undefined;
  let classNameStart = -1;
  let classNameEnd = -1;
  let isString = false;

  if (text[i] === "(") {
    // The class name is the last name-stage argument; earlier arguments carry Fusion scope.
    const closeParen = findMatchingParen(masked, i);
    if (closeParen === -1) {
      return undefined;
    }
    const args = splitTopLevelArgs(masked, i + 1, closeParen);
    if (args.length === 0) {
      return undefined;
    }
    const last = args[args.length - 1];
    const parsed = parseFirstArgClassName(text, last.start, last.end);
    if (!parsed) {
      return undefined;
    }
    name = parsed.name;
    isString = parsed.isString;
    classNameStart = parsed.start;
    classNameEnd = parsed.end;
    i = closeParen + 1;
  } else if (text[i] === '"' || text[i] === "'") {
    const quote = text[i];
    const close = text.indexOf(quote, i + 1);
    if (close === -1) {
      return undefined;
    }
    const candidate = text.slice(i + 1, close);
    if (!/^[A-Za-z_]\w*$/.test(candidate)) {
      return undefined;
    }
    name = candidate;
    classNameStart = i + 1;
    classNameEnd = close;
    isString = true;
    i = close + 1;
  } else if (/[A-Za-z_]/.test(text[i] ?? "")) {
    const start = i;
    while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) {
      i++;
    }
    name = text.slice(start, i);
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(name)) {
      return undefined;
    }
    classNameStart = start;
    classNameEnd = i;
  } else {
    return undefined;
  }

  i = skipSpace(i);
  let propsParen = -1;
  if (text[i] === "(") {
    propsParen = i;
    i = skipSpace(i + 1);
  }
  if (text[i] !== "{") {
    return undefined;
  }
  const openBrace = i;
  const closeBrace = findMatchingBrace(masked, openBrace);
  if (closeBrace === -1) {
    return undefined;
  }

  let fullEnd = closeBrace + 1;
  if (propsParen !== -1) {
    const closeProps = findMatchingParen(masked, propsParen);
    if (closeProps === -1) {
      return undefined;
    }
    fullEnd = closeProps + 1;
  }

  return {
    name,
    isString,
    classNameStart,
    classNameEnd,
    openBrace,
    closeBrace,
    fullEnd,
  };
}

export function buildCallTree(calls: CreateElementCall[]): CallTreeNode[] {
  const sorted = [...calls].sort((a, b) => a.aliasStart - b.aliasStart);
  const nodes: CallTreeNode[] = sorted.map((call) => ({
    call,
    children: [],
  }));

  const roots: CallTreeNode[] = [];
  const stack: CallTreeNode[] = [];

  for (const node of nodes) {
    while (
      stack.length > 0 &&
      !containsInChildren(stack[stack.length - 1].call, node.call.aliasStart)
    ) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  return roots;
}

function containsInChildren(
  parent: CreateElementCall,
  offset: number
): boolean {
  return (
    parent.childrenStart !== undefined &&
    parent.childrenEnd !== undefined &&
    offset > parent.childrenStart &&
    offset < parent.childrenEnd
  );
}

function findMatchingParen(text: string, openIdx: number): number {
  let depth = 1;
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] === "(") {
      depth++;
    } else if (text[i] === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function findFirstChar(
  text: string,
  ch: string,
  start: number,
  end: number
): number {
  for (let i = start; i < end; i++) {
    if (text[i] === ch) {
      return i;
    }
  }
  return -1;
}

function splitTopLevelArgs(
  masked: string,
  start: number,
  end: number
): Array<{ start: number; end: number }> {
  const args: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let argStart = start;
  for (let i = start; i < end; i++) {
    const c = masked[i];
    if (c === "(" || c === "{" || c === "[") {
      depth++;
    } else if (c === ")" || c === "}" || c === "]") {
      depth--;
    } else if (c === "," && depth === 0) {
      args.push({ start: argStart, end: i });
      argStart = i + 1;
    }
  }
  if (argStart < end) {
    args.push({ start: argStart, end });
  }
  return args;
}

function parseFirstArgClassName(
  text: string,
  start: number,
  end: number
): { name: string; isString: boolean; start: number; end: number } | undefined {
  let i = start;
  while (i < end && /\s/.test(text[i])) {
    i++;
  }
  let j = end;
  while (j > i && /\s/.test(text[j - 1])) {
    j--;
  }
  if (i >= j) {
    return undefined;
  }
  const inner = text.slice(i, j);

  const stringMatch = /^["']([A-Za-z_]\w*)["']$/.exec(inner);
  if (stringMatch) {
    return {
      name: stringMatch[1],
      isString: true,
      start: i + 1,
      end: j - 1,
    };
  }
  const idMatch = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/.exec(
    inner
  );
  if (idMatch) {
    return {
      name: idMatch[1],
      isString: false,
      start: i,
      end: j,
    };
  }
  return undefined;
}

/** Resolve Color3 literals to RGB channels in [0, 1]; fromHex also requires originalText. */
export function extractColorLiterals(
  maskedText: string,
  originalText?: string
): ColorLiteral[] {
  const out: ColorLiteral[] = [];
  const re =
    /\bColor3\.(fromRGB|new|fromHex|fromHSV)\s*\(\s*([^()]*?)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(maskedText)) !== null) {
    const kind = m[1];
    let rgb: { r: number; g: number; b: number } | undefined;
    if (kind === "fromHex") {
      if (!originalText) {
        continue;
      }
      const callText = originalText.slice(m.index, m.index + m[0].length);
      const hexMatch = /["']\s*(#?[0-9a-fA-F]{3,8})\s*["']/.exec(callText);
      if (!hexMatch) {
        continue;
      }
      rgb = parseHex(hexMatch[1]);
    } else if (kind === "fromHSV") {
      const args = m[2].split(",").map((s) => Number(s.trim()));
      if (args.length !== 3 || args.some((n) => !Number.isFinite(n))) {
        continue;
      }
      rgb = hsvToRgb(args[0], args[1], args[2]);
    } else {
      const args = m[2].split(",").map((s) => Number(s.trim()));
      if (args.length !== 3 || args.some((n) => !Number.isFinite(n))) {
        continue;
      }
      if (kind === "fromRGB") {
        rgb = { r: args[0] / 255, g: args[1] / 255, b: args[2] / 255 };
      } else {
        rgb = { r: args[0], g: args[1], b: args[2] };
      }
    }
    if (!rgb) {
      continue;
    }
    if ([rgb.r, rgb.g, rgb.b].some((n) => n < 0 || n > 1)) {
      continue;
    }
    out.push({
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

function parseHex(s: string): { r: number; g: number; b: number } | undefined {
  const hex = s.startsWith("#") ? s.slice(1) : s;
  if (hex.length === 3) {
    return {
      r: parseInt(hex[0] + hex[0], 16) / 255,
      g: parseInt(hex[1] + hex[1], 16) / 255,
      b: parseInt(hex[2] + hex[2], 16) / 255,
    };
  }
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
    };
  }
  return undefined;
}

function hsvToRgb(
  h: number,
  s: number,
  v: number
): { r: number; g: number; b: number } {
  // Roblox HSV channels use the 0-1 range.
  const hNorm = ((h % 1) + 1) % 1;
  const i = Math.floor(hNorm * 6);
  const f = hNorm * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return { r: v, g: t, b: p };
    case 1:
      return { r: q, g: v, b: p };
    case 2:
      return { r: p, g: v, b: t };
    case 3:
      return { r: p, g: q, b: v };
    case 4:
      return { r: t, g: p, b: v };
    default:
      return { r: v, g: p, b: q };
  }
}

export function pushUnique(target: string[], items: string[]): void {
  for (const item of items) {
    if (!target.includes(item)) {
      target.push(item);
    }
  }
}

export function collectLocalBindings(text: string): Set<string> {
  const masked = applyMask(text, buildCodeMask(text));
  const out = new Set<string>();
  const re = /(?<![A-Za-z0-9_])local\s+(?:function\s+)?([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    out.add(m[1]);
  }
  return out;
}

export const _scanInternals = {
  matchingEnd(masked: string, startIdx: number): number {
    return matchingEnd(buildBlockIndex(masked), masked.length, startIdx);
  },
  ownReturns(masked: string, bodyStart: number, bodyEnd: number): number[] {
    const out: number[] = [];
    forEachOwnReturn(buildBlockIndex(masked), bodyStart, bodyEnd, (after) => {
      out.push(after);
      return false;
    });
    return out;
  },
  factoryCalls(text: string, aliases: AliasPartition | string[]): CreateElementCall[] {
    return rawCallsOf(analysisFor(text, true), asPartition(aliases));
  },
  returnedRootCall(
    text: string,
    bodyStart: number,
    bodyEnd: number,
    aliases: AliasPartition | string[]
  ): CreateElementCall | undefined {
    const analysis = analysisFor(text, true);
    const partition = asPartition(aliases);
    return findReturnedRootCallIn(
      analysis.blocks,
      () => sortCalls(rawCallsOf(analysis, partition)),
      text,
      bodyStart,
      bodyEnd
    );
  },
  lineOf(text: string, offset: number): number {
    return new TextAnalysis(text).lineOf(offset);
  },
  cachedTexts(): { documents: number; fragments: number } {
    return {
      documents: sharedAnalyses.documents.length,
      fragments: sharedAnalyses.fragments.length,
    };
  },
  isCached(text: string): boolean {
    return [...sharedAnalyses.documents, ...sharedAnalyses.fragments]
      .some((entry) => entry.text === text);
  },
  cachedChars(): { documents: number; fragments: number } {
    const sum = (list: TextAnalysis[]) => list.reduce((n, entry) => n + entry.text.length, 0);
    return { documents: sum(sharedAnalyses.documents), fragments: sum(sharedAnalyses.fragments) };
  },
  DOCUMENT_ANALYSES_MAX,
  ANALYSES_CHARS_MAX,
};
