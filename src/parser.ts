// Pure parsing helpers — no `vscode` imports, all input/output is plain
// strings/objects. Everything here is unit-testable in isolation.

// ============================================================================
// Public types
// ============================================================================

export interface EnclosingCall {
  className: string;
  isStringLiteralName: boolean;
  /** Which factory alias matched (`e`, `New`, `create`, …). Lets callers
   *  look up the framework. For direct component calls
   *  (`MyComp({...})` / `MyComp {...}`) this is the component name
   *  itself — no factory alias was used. */
  alias?: string;
  /** Whether the matched call was the parens or curried form. */
  callShape?: "parens" | "curried";
  /**
   * True when the match came from the Vide/Fusion-style direct
   * component call shape (`MyComp({...})` / `MyComp {...}`) rather than
   * a known factory alias. Callers that want to skip
   * built-in-instance-only logic (e.g. merging Roblox event names into
   * suggestions) can branch on this.
   */
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
  /**
   * Props the component's root return-element sets to a value that
   * doesn't textually reference the component's `props` parameter. When
   * a caller passes one of these keys to `<Component>`, the call-site
   * value is silently ignored — the diagnostic surface flags it.
   */
  hardcodedProps?: Set<string>;
  /** Identifier of the first parameter — the props table (e.g. "props"). */
  paramName?: string;
  /** Offset of the first character inside the function body. */
  bodyStart?: number;
  /** Offset just after the function's terminating `end`. */
  bodyEnd?: number;
  /** Offset range of the first param's type annotation (after the `:`). */
  paramTypeStart?: number;
  paramTypeEnd?: number;
}

export interface CreateElementCall {
  className: string;
  isStringLiteralName: boolean;
  nameProp?: string;
  /**
   * The factory alias that matched (`e`, `New`, `Vide.create`, …),
   * without any receiver. Look the framework up with this rather than
   * re-reading the text at `aliasStart` — that offset may point at a
   * receiver (`scope:New`), which resolves to nothing.
   */
  alias?: string;
  /**
   * The receiver in front of the alias, verbatim and including its
   * separator — `"scope:"` for Fusion 0.3's `scope:New "Frame" { … }`,
   * `""` when the alias stands alone. Code generation has to re-emit
   * it or the rewritten call loses the scope it constructs into.
   */
  receiver?: string;
  /**
   * Offset where the whole call begins — the receiver when there is
   * one, the alias otherwise. `[aliasStart, fullEnd)` is always the
   * call's complete text range.
   */
  aliasStart: number;
  fullEnd: number;
  classNameStart: number;
  classNameEnd: number;
  childrenStart?: number;
  childrenEnd?: number;
  /** Offset of the opening `{` of the props table, if a literal one is
   *  present (i.e. not when props is a variable like `Component(SomeProps)`). */
  propsBraceStart?: number;
  /** Offset of the matching closing `}` of the props table. */
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

/**
 * Aliases partitioned by call shape. `parens` aliases are used in the
 * React/Roact form (`f("X", { … })`); `curried` aliases use Lua's sugar
 * (`f "X" { … }`) as in Fusion / Vide.
 */
export interface AliasPartition {
  parens: string[];
  curried: string[];
  /** Aliases of frameworks whose `childrenLayout === "inline"` and
   *  that recognise the `parens` shape (today: Vide). When the
   *  matched alias of a parens-form call is in this set, the props
   *  table doubles as the inline-children container. Optional so
   *  hand-rolled test fixtures and legacy callers stay compiling;
   *  callers fall back to the legacy bucket-membership check when
   *  absent. Populated by `getAliasPartition()` in `./frameworks.ts`. */
  parensWithInlineChildren?: string[];
}

function asPartition(aliases: AliasPartition | string[]): AliasPartition {
  if (Array.isArray(aliases)) {
    return { parens: aliases, curried: [] };
  }
  return aliases;
}

// ============================================================================
// String/comment masking
// ============================================================================

const LUA_BLOCK_OPENERS = new Set(["function", "if", "do", "repeat"]);
const LUA_BLOCK_CLOSERS = new Set(["end", "until"]);

// Combined cache for the mask + masked text. Every provider that touches a
// document needs at least one of these, so caching both per text saves a
// surprising amount of work — `findAllCreateElementCalls` and
// `findEnclosingPropsCall` and `scanDocument` and `extractColorLiterals`
// would otherwise each rebuild the mask from scratch.
interface MaskedDoc {
  mask: boolean[];
  masked: string;
}

const maskedDocCache: Array<{ text: string; entry: MaskedDoc }> = [];
const MASKED_DOC_CACHE_MAX = 4;

function getMaskedDoc(text: string): MaskedDoc {
  for (let i = maskedDocCache.length - 1; i >= 0; i--) {
    if (maskedDocCache[i].text === text) {
      // LRU bump: move to end so most-recent stays warm.
      const hit = maskedDocCache.splice(i, 1)[0];
      maskedDocCache.push(hit);
      return hit.entry;
    }
  }
  const mask = buildCodeMaskImpl(text);
  const masked = applyMaskImpl(text, mask);
  maskedDocCache.push({ text, entry: { mask, masked } });
  if (maskedDocCache.length > MASKED_DOC_CACHE_MAX) {
    maskedDocCache.shift();
  }
  return { mask, masked };
}

/**
 * Build a per-character bitmap where `true` means the character is *code*
 * (not inside a Lua string or comment). Quotes/comment delimiters are kept
 * as code so that downstream regexes can still see them.
 *
 * Cached: repeated calls with the same `text` return the same array
 * reference. Callers must treat the returned array as immutable.
 */
export function buildCodeMask(text: string): boolean[] {
  return getMaskedDoc(text).mask;
}

function buildCodeMaskImpl(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(true);
  let i = 0;

  while (i < text.length) {
    const c = text[i];

    // Comments: `--`, `--[[ ... ]]`, `--[=*[ ... ]=*]`
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

    // Quoted strings: keep the quotes as code so a later regex can spot
    // them; mask the interior only.
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
          // Unterminated string: stop masking at end-of-line.
          break;
        }
        mask[i] = false;
        i++;
      }
      continue;
    }

    // Long-bracket strings: `[[ ... ]]` / `[=*[ ... ]=*]`. Keep delimiters as
    // code; mask only the interior.
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

/**
 * Apply a code mask to a text, replacing non-code characters with spaces
 * (newlines preserved). When the mask was produced by `buildCodeMask(text)`
 * with the same `text`, the result is cached — callers should pass the
 * pair together to take advantage of that.
 */
export function applyMask(text: string, mask: boolean[]): string {
  // Fast path: if the mask is the one our cache built for this text, the
  // masked version is already cached too.
  for (let i = maskedDocCache.length - 1; i >= 0; i--) {
    if (
      maskedDocCache[i].text === text &&
      maskedDocCache[i].entry.mask === mask
    ) {
      return maskedDocCache[i].entry.masked;
    }
  }
  return applyMaskImpl(text, mask);
}

function applyMaskImpl(text: string, mask: boolean[]): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (mask[i]) {
      out.push(text[i]);
    } else {
      out.push(text[i] === "\n" ? "\n" : " ");
    }
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

// ============================================================================
// Shared regex helpers
// ============================================================================

const aliasAlternationCache = new Map<string, string>();

export function buildAliasAlternation(aliases: string[]): string {
  const key = aliases.join("|");
  const hit = aliasAlternationCache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  // Longest first so multi-segment names like `React.createElement` win over
  // bare `createElement` during alternation.
  const sorted = [...aliases].sort((a, b) => b.length - a.length);
  const result = sorted.map(escapeRegex).join("|");
  aliasAlternationCache.set(key, result);
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+*?^$()[\]{}|\\]/g, "\\$&");
}

// ---- Curried-form syntax variants -----------------------------------------
//
// Fusion and Vide are "curried": a class-name stage followed by a props
// table. Real-world code writes that in four interchangeable ways, and
// Luix has to recognise all of them:
//
//   New "Frame" { … }              Fusion 0.2 / Vide, Lua call sugar
//   scope:New "Frame" { … }        Fusion 0.3 `scoped()` receiver sugar
//   New(scope, "Frame") { … }      Fusion 0.3 explicit-scope constructor
//   New("Frame")({ … })            StyLua `call_parentheses = "Always"`,
//                                  which the Roblox Lua Style Guide
//                                  mandates — it rewrites *every* sugar
//                                  call into an explicit parens call.
//
// StyLua composes with the others, so `scope:New("Frame")({ … })` and
// `New(scope, "Frame")({ … })` are both live shapes too. The two
// degrees of freedom are therefore independent:
//
//   name stage  → `"Frame"`      or `( [args ,] "Frame" )`
//   props stage → `{ … }`        or `( { … } )`
//
// A receiver in front of the alias is a third, orthogonal degree of
// freedom, handled by `RECEIVER_PREFIX` below — which also picks up a
// `require` bound to a local name other than `Fusion`
// (`MyFusion.New "Frame" { … }`).

/**
 * Optional `scope:` / `Fusion.` receiver in front of a curried alias.
 * Non-capturing and lazy where it matters, so a configured dotted alias
 * (`Fusion.New`) still matches whole rather than being split.
 */
const RECEIVER_PREFIX = `(?:[A-Za-z_][A-Za-z0-9_]*\\s*[.:]\\s*)??`;

/** Class-name token: `"Frame"`, `'Frame'`, or a dotted identifier. */
const CLASS_NAME_ALT =
  `(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|` +
  `([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*))`;

/**
 * Arguments preceding the class name inside a parenthesised name stage
 * — Fusion 0.3's `New(scope, "Frame")`. Deliberately excludes nested
 * parens and newlines: the leading argument is always a plain scope
 * variable, and staying single-line keeps the pattern linear.
 */
const LEADING_ARGS = `(?:[^()\\n]*?,\\s*)?`;

// Compiled-RegExp caches for the shapes findEnclosingPropsCall uses.
// Keyed by the alias-alternation string — same key the alternation
// cache uses, so a hit there means a hit here too once the patterns
// are warmed. Eliminates `new RegExp(...)` allocation on every
// keystroke per provider.
const parensPatternCache = new Map<string, RegExp>();
const curriedPatternCache = new Map<string, RegExp>();
const curriedNameParensPatternCache = new Map<string, RegExp>();
const curriedPropsParensPatternCache = new Map<string, RegExp>();
const factoryNameStageParensCache = new Map<string, RegExp>();

function parensPatternFor(aliasPattern: string): RegExp {
  const hit = parensPatternCache.get(aliasPattern);
  if (hit) return hit;
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
  if (hit) return hit;
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_.])${RECEIVER_PREFIX}(${aliasPattern})` +
      `\\s+${CLASS_NAME_ALT}\\s*$`
  );
  curriedPatternCache.set(aliasPattern, re);
  return re;
}

/**
 * Parenthesised name stage: `ALIAS("Frame")` / `ALIAS(scope, "Frame")`,
 * optionally followed by StyLua's props-stage `(`. Anchored so the
 * match ends exactly where the props `{` begins.
 */
function curriedNameParensPatternFor(aliasPattern: string): RegExp {
  const hit = curriedNameParensPatternCache.get(aliasPattern);
  if (hit) return hit;
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_.])${RECEIVER_PREFIX}(${aliasPattern})` +
      `\\s*\\(\\s*${LEADING_ARGS}${CLASS_NAME_ALT}\\s*\\)\\s*(?:\\(\\s*)?$`
  );
  curriedNameParensPatternCache.set(aliasPattern, re);
  return re;
}

/**
 * Sugar name stage but parenthesised props stage: `ALIAS "Frame" ({ … })`.
 * StyLua never emits this on its own, but hand-written and
 * partially-formatted code does.
 */
function curriedPropsParensPatternFor(aliasPattern: string): RegExp {
  const hit = curriedPropsParensPatternCache.get(aliasPattern);
  if (hit) return hit;
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_.])${RECEIVER_PREFIX}(${aliasPattern})` +
      `\\s+${CLASS_NAME_ALT}\\s*\\(\\s*$`
  );
  curriedPropsParensPatternCache.set(aliasPattern, re);
  return re;
}

/**
 * Cursor-inside-the-class-name variant: matches the text immediately
 * before the opening quote of a parenthesised name stage, i.e.
 * `ALIAS(` or `ALIAS(scope,`.
 */
function factoryNameStageParensPatternFor(aliasPattern: string): RegExp {
  const hit = factoryNameStageParensCache.get(aliasPattern);
  if (hit) return hit;
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9_.])${RECEIVER_PREFIX}(${aliasPattern})` +
      `\\s*\\(\\s*${LEADING_ARGS}$`
  );
  factoryNameStageParensCache.set(aliasPattern, re);
  return re;
}

// Module-level direct-call patterns — they don't depend on aliases.
const DIRECT_PARENS_PATTERN =
  /(?:^|[^A-Za-z0-9_.:])([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*$/;
const DIRECT_CURRIED_PATTERN =
  /(?:^|[^A-Za-z0-9_.:])([A-Za-z_][A-Za-z0-9_]*)\s*$/;
// Fusion 0.3 passes the scope to a component before its props table:
// `MyButton(scope, { … })`. Same `directComponents` gate as the other
// direct shapes; the leading-arg class excludes parens and newlines so
// this can't run away across a multi-line argument list.
const DIRECT_PARENS_SCOPED_PATTERN =
  /(?:^|[^A-Za-z0-9_.:])([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*[^()\n{}]*?,\s*$/;

/**
 * Maximum bytes the backward brace-walk in `findEnclosingPropsCall`
 * scans before giving up. Props tables in real React/Vide/Fusion code
 * fit comfortably under a few KB; 16 KB is generous and prevents the
 * worst case (cursor at the bottom of a 50K-line file with no
 * enclosing `{` → scanning the full document on every keystroke for
 * every provider that uses the function).
 */
const MAX_BACKWARD_SCAN = 16 * 1024;

// ============================================================================
// findEnclosingPropsCall — used by the completion + hover providers
// ============================================================================

/**
 * Walk backward from the cursor to find the `{` of the immediately enclosing
 * block. If that block opens a createElement-style props table, return the
 * class/component name. Otherwise return undefined.
 */
export function findEnclosingPropsCall(
  text: string,
  cursorIndex: number,
  aliases: AliasPartition | string[],
  /**
   * Identifiers Luix's workspace index already recognises as components.
   * When provided, the detector also accepts the Vide/Fusion-style direct
   * component-call shapes — `<Identifier>({ ... })` and `<Identifier> { ... }`
   * — *only* when the identifier appears in this set. Without the gate the
   * curried form would match every `f { ... }` table-call in the language,
   * so this set is the entire safety net.
   */
  directComponents?: ReadonlySet<string>
): EnclosingCall | undefined {
  const partition = asPartition(aliases);
  const mask = buildCodeMask(text);

  let braceDepth = 0;
  let parenDepth = 0;
  let openBraceIdx = -1;
  // Cap how far back we'll walk. With the cursor sitting outside any
  // table (top of a 50K-line file, say), the unbounded walk used to
  // scan the entire document on every keystroke per provider.
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
        // If we're inside an unmatched `(`, the cursor is in an expression,
        // not directly in the props object — skip.
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

  // 1) Try parens form: FUNC(ARG, $
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

  // 2) Try curried form: FUNC "ARG" $    (no comma, no second paren)
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

  // 2b) Curried form with explicit parentheses. Covers the shapes
  //     StyLua's `call_parentheses = "Always"` produces (which the
  //     Roblox Lua Style Guide mandates) and Fusion 0.3's
  //     explicit-scope constructor:
  //       New("Frame") {          New("Frame")({
  //       New(scope, "Frame") {   New(scope, "Frame")({
  //       scope:New("Frame")({    New "Frame" ({
  //     Runs after the sugar form so the cheap pattern still wins on
  //     the common case.
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

  // 3) Direct component-call shapes — Vide / Fusion idiom for custom
  //    components. Only run when the caller handed us a set of names
  //    Luix's workspace index already knows about; without that gate the
  //    curried form would match every `someFunc { … }` table-call in the
  //    language and pollute completions in pure-logic code.
  //
  //    Excludes `.` and `:` from the leading char-class so method calls
  //    (`obj.Method({…})`, `obj:Method({…})`) and qualified accesses
  //    (`Module.Sub({…})`) don't trip the regex — the user's component
  //    table is almost always a bare local from a `require`.
  if (directComponents && directComponents.size > 0) {
    // 3a) Direct parens:  IDENT(  $   — and Fusion 0.3's scope-passing
    //     convention `IDENT(scope,  $`, where the props table is the
    //     second argument.
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
    // 3b) Direct curried:  IDENT  $   (followed by `{`)
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

// ============================================================================
// findEnclosingFactoryStringArg — cursor inside the class-name string literal
// ============================================================================

export interface EnclosingStringArg {
  alias: string;
  callShape: "parens" | "curried";
  /**
   * Curried form only: the class name sits inside a parenthesised name
   * stage — `New("Fr|")` / `New(scope, "Fr|")` — rather than Lua's call
   * sugar `New "Fr|"`. Callers completing the rest of the call have to
   * close that paren before opening the props table, so the accepted
   * snippet tail is `")({ … })"` instead of `" { … }"`.
   */
  nameStageParens?: boolean;
  quote: '"' | "'" | "`";
  /** Offset of the opening quote in the document. */
  stringStart: number;
  /** Offset of the closing quote, or -1 if not present on the same line. */
  stringEnd: number;
  /**
   * For parens form: offset of the closing `)` immediately after the
   * string (skipping whitespace), or -1 if there's content between (i.e. a
   * `,` and a props table is already present).
   */
  closeParen: number;
  /**
   * Whether a props table (`{ … }`) already follows the string. If true,
   * inserting the suggestion should NOT add another `{ … }`.
   */
  hasPropsAfter: boolean;
}

/**
 * If the cursor sits inside a quoted string that is the first argument of
 * an enabled factory call (`e("Fr|"`, `New "Fr|"`, etc.), return the call
 * context — used by the class-name completion provider.
 */
export function findEnclosingFactoryStringArg(
  text: string,
  cursorIndex: number,
  aliases: AliasPartition | string[]
): EnclosingStringArg | undefined {
  const partition = asPartition(aliases);
  if (partition.parens.length === 0 && partition.curried.length === 0) {
    return undefined;
  }

  // Walk back from cursor to find the opening quote on the same line.
  // Recognises Lua's three string delimiters: `"`, `'`, and Luau's
  // backtick template strings.
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

  // The string contents up to the cursor must be a valid (partial)
  // identifier — i.e. only `[A-Za-z0-9_]`. Otherwise this isn't a class
  // name (could be a path, message, etc.).
  for (let i = stringStart + 1; i < cursorIndex; i++) {
    const c = text[i];
    if (!/[A-Za-z0-9_]/.test(c)) {
      return undefined;
    }
  }

  // Find the closing quote, if any, on the same line.
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
      // Non-identifier char between cursor and end of line means the string
      // already has unexpected content — bail.
      return undefined;
    }
  }

  // Look back from the opening quote to identify the factory alias.
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
    // Parenthesised name stage — `New("Fr|")`, `New(scope, "Fr|")`,
    // `scope:New("Fr|")`. Same curried semantics, different syntax.
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

  // Inspect what follows the closing quote (if present) on the same line.
  let closeParen = -1;
  let hasPropsAfter = false;
  if (stringEnd !== -1) {
    let i = stringEnd + 1;
    while (i < text.length && text[i] !== "\n" && /[ \t]/.test(text[i])) {
      i++;
    }
    if (callShape === "parens") {
      if (text[i] === ",") {
        // Already has a comma → props table likely already present.
        let j = i + 1;
        while (j < text.length && text[j] !== "\n" && /[ \t]/.test(text[j])) {
          j++;
        }
        if (text[j] === "{") {
          hasPropsAfter = true;
        }
      } else if (text[i] === ")") {
        closeParen = i;
      }
    } else if (nameStageParens) {
      // `New("Fr|")` — the name stage's own `)` comes first, then the
      // props stage in either shape: `) { … }` or `)({ … })`.
      if (text[i] === ")") {
        let j = i + 1;
        while (j < text.length && /[ \t]/.test(text[j])) {
          j++;
        }
        if (text[j] === "(") {
          j++;
          while (j < text.length && /[ \t]/.test(text[j])) {
            j++;
          }
        }
        if (text[j] === "{") {
          hasPropsAfter = true;
        } else {
          closeParen = i;
        }
      }
    } else {
      // curried
      if (text[i] === "{") {
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
  };
}

// ============================================================================
// Component scanning (function definitions + annotations + type aliases)
// ============================================================================

export interface PropEntry {
  key: string;
  /** Offsets relative to the body text passed in. */
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
}

/**
 * Extract top-level `Key = value` entries from the body of a Lua table
 * literal (the text INSIDE the outermost `{...}`, without those braces).
 *
 * Skips `[…] = …` computed keys, ignores entries nested inside `{}` or
 * `()`, tolerates trailing commas, and reports per-entry positions so
 * callers can map the diagnostic back to the source range.
 */
export function extractPropEntries(bodyText: string): PropEntry[] {
  const masked = applyMask(bodyText, buildCodeMask(bodyText));
  return parsePropEntriesFromMasked(masked);
}

/**
 * Faster overload for callers that already have the *full document
 * text* in hand — `applyMask(fullText, buildCodeMask(fullText))` hits
 * the document-level mask cache instead of rebuilding the mask for a
 * substring (which never sees a cache hit). A single diagnostic
 * recompute on a busy file calls this ~hundreds of times — each call
 * used to rebuild the mask from scratch.
 */
export function extractPropEntriesFromDocument(
  fullText: string,
  bodyStart: number,
  bodyEnd: number
): PropEntry[] {
  const masked = applyMask(fullText, buildCodeMask(fullText));
  return parsePropEntriesFromMasked(masked.slice(bodyStart, bodyEnd));
}

function parsePropEntriesFromMasked(masked: string): PropEntry[] {
  const out: PropEntry[] = [];
  let i = 0;
  while (i < masked.length) {
    // Skip whitespace + commas/semicolons + comments-stripped-to-space.
    while (i < masked.length && /[\s,;]/.test(masked[i])) {
      i++;
    }
    if (i >= masked.length) {
      break;
    }
    // Skip `[expr] = value` entries (array-style children, computed keys).
    if (masked[i] === "[") {
      let depth = 1;
      i++;
      while (i < masked.length && depth > 0) {
        if (masked[i] === "[") depth++;
        else if (masked[i] === "]") depth--;
        i++;
      }
      // Skip `= value` for this computed key.
      while (i < masked.length && /\s/.test(masked[i])) i++;
      if (masked[i] === "=") {
        i++;
        i = skipValueExpression(masked, i);
      }
      continue;
    }
    if (!/[A-Za-z_]/.test(masked[i])) {
      // Could be a positional value (Vide inline child, `e(...)`,
      // `local …` block, etc.). Skip the value expression and move on.
      i = skipValueExpression(masked, i);
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
      // Not a `Key = …` entry — probably a positional value that happens
      // to start with an identifier (a variable reference). Skip it.
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
    if (c === "{") braceDepth++;
    else if (c === "}") {
      if (braceDepth === 0) return i;
      braceDepth--;
    } else if (c === "(") parenDepth++;
    else if (c === ")") {
      if (parenDepth === 0) return i;
      parenDepth--;
    } else if (c === "[") bracketDepth++;
    else if (c === "]") {
      if (bracketDepth === 0) return i;
      bracketDepth--;
    }
    i++;
  }
  return i;
}

/**
 * Extract top-level field names from the body of a Luau type literal.
 * Input is the text INSIDE the outermost `{...}` (without those braces).
 * Skips index signatures (`[K]: V`) and ignores fields nested inside `{}`,
 * `()`, or `<>`.
 */
export function extractTypeFields(literalBody: string): string[] {
  const masked = applyMask(literalBody, buildCodeMask(literalBody));
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

/**
 * Walk backward from `defLineIndex - 1` over consecutive `---` comment
 * lines and pull recognized directives.
 */
export function parseAnnotationsForComponent(
  text: string,
  defLineIndex: number
): ComponentAnnotations {
  const lines = text.split("\n");
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

function findMatchingEnd(masked: string, startIdx: number): number {
  let depth = 1;
  const tokenRe = /\b\w+\b/g;
  tokenRe.lastIndex = startIdx;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(masked)) !== null) {
    if (LUA_BLOCK_OPENERS.has(m[0])) {
      depth++;
    } else if (LUA_BLOCK_CLOSERS.has(m[0])) {
      depth--;
      if (depth === 0) {
        return m.index + m[0].length;
      }
    }
  }
  return masked.length;
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

/**
 * Find the first `return ALIAS(CLASS, ...)` whose enclosing function is the
 * component (i.e. not inside a nested function literal). Conditional returns
 * inside `if`/`do`/`while`/`for`/`repeat` blocks still count.
 *
 * `maskedText` is used for token scanning (so braces inside strings/comments
 * don't trip us up), `originalText` is used for capturing the class name
 * (because masking blanks out string interiors).
 */
export function detectReturnedClass(
  originalText: string,
  maskedText: string,
  bodyStart: number,
  bodyEnd: number,
  aliases: AliasPartition | string[]
): string | undefined {
  const partition = asPartition(aliases);
  // Combined regex: try parens form OR curried form, both rooted right
  // after the `return` keyword. The two alternations are wrapped in a
  // non-capturing group, with the class-name capture groups inside each.
  const parts: string[] = [];
  if (partition.parens.length > 0) {
    const a = buildAliasAlternation(partition.parens);
    parts.push(`(?:${a})\\s*\\(\\s*${CLASS_NAME_ALT}`);
  }
  if (partition.curried.length > 0) {
    const a = buildAliasAlternation(partition.curried);
    // Sugar name stage: `return New "Frame" { … }`.
    parts.push(`${RECEIVER_PREFIX}(?:${a})\\s+${CLASS_NAME_ALT}`);
    // Parenthesised name stage: `return New("Frame") { … }`,
    // `return New(scope, "Frame")({ … })`, `return scope:New("Frame")({ … })`.
    parts.push(
      `${RECEIVER_PREFIX}(?:${a})\\s*\\(\\s*${LEADING_ARGS}${CLASS_NAME_ALT}\\s*\\)`
    );
  }
  if (parts.length === 0) {
    return undefined;
  }
  const returnAliasPattern = new RegExp(
    `^\\s*\\(?\\s*(?:${parts.join("|")})`
  );

  const stack: string[] = [];
  const tokenRe = /\b\w+\b/g;
  tokenRe.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(maskedText)) !== null) {
    if (m.index >= bodyEnd) {
      break;
    }
    const word = m[0];
    if (word === "function") {
      stack.push("fn");
    } else if (word === "if" || word === "do" || word === "repeat") {
      stack.push(word);
    } else if (word === "end" || word === "until") {
      stack.pop();
    } else if (word === "return") {
      const functionDepth = stack.reduce(
        (n, t) => n + (t === "fn" ? 1 : 0),
        0
      );
      if (functionDepth === 0) {
        const after = originalText.slice(m.index + word.length, bodyEnd);
        const r = returnAliasPattern.exec(after);
        if (r) {
          // Each alternation branch contributes its own class-name
          // capture triple (parens 1-3, curried sugar 4-6, curried
          // parens 7-9). Take whichever branch matched.
          const name = r.slice(1).find(Boolean);
          if (name) {
            return name;
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Walk the function body to find the root element returned by the
 * component, then collect prop keys whose RHS expression doesn't
 * textually reference the component's `props` parameter. Those are the
 * props a caller can't actually override.
 *
 * Heuristic — purely textual:
 *   - `Position = UDim2.new(0,0,0,0)`     → hardcoded
 *   - `Position = props.Position`         → forwarded (skipped)
 *   - `Position = if X then props.Position else ...`  → has `props`, skipped
 *   - `Position = pos` where `pos = props.Position` → indirect, *missed*
 *     (false negative — diagnostic stays quiet, which is the safe call).
 */
function computeHardcodedProps(
  originalText: string,
  maskedText: string,
  bodyStart: number,
  bodyEnd: number,
  paramName: string | undefined,
  partition: AliasPartition
): Set<string> | undefined {
  const rootCall = findReturnedRootCall(
    originalText,
    maskedText,
    bodyStart,
    bodyEnd,
    partition
  );
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
  const entries = extractPropEntries(propsBody);
  if (entries.length === 0) {
    return undefined;
  }

  // Word-boundary check against the actual parameter identifier, falling
  // back to the conventional `props`. Bare `_` (commonly used to ignore
  // the parameter) is treated as "no forwarding ever happens", so no
  // hardcoded set is produced — silence beats false positives.
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

/**
 * Mirror of `detectReturnedClass`, but returns the matched call's bounds
 * (alias start, class-name range, props brace range) so a caller can
 * inspect the root element's props table.
 */
function findReturnedRootCall(
  originalText: string,
  maskedText: string,
  bodyStart: number,
  bodyEnd: number,
  partition: AliasPartition
): CreateElementCall | undefined {
  const allCalls = findAllCreateElementCallsImpl(originalText, partition);
  const stack: string[] = [];
  const tokenRe = /\b\w+\b/g;
  tokenRe.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(maskedText)) !== null) {
    if (m.index >= bodyEnd) {
      break;
    }
    const word = m[0];
    if (word === "function") {
      stack.push("fn");
    } else if (word === "if" || word === "do" || word === "repeat") {
      stack.push(word);
    } else if (word === "end" || word === "until") {
      stack.pop();
    } else if (word === "return") {
      const functionDepth = stack.reduce(
        (n, t) => n + (t === "fn" ? 1 : 0),
        0
      );
      if (functionDepth !== 0) {
        continue;
      }
      // The next call whose alias starts after `return` (skipping
      // whitespace, an optional `(`, and an optional `scope:` /
      // `Fusion.` receiver — `aliasStart` points at the alias itself,
      // not at the receiver) is the returned root element.
      const after = m.index + word.length;
      const matched = allCalls.find(
        (c) =>
          c.aliasStart >= after &&
          c.aliasStart < bodyEnd &&
          /^\s*\(?\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*[.:]\s*)?$/.test(
            originalText.slice(after, c.aliasStart)
          )
      );
      if (matched) {
        return matched;
      }
    }
  }
  return undefined;
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
  /** Identifier of the first parameter, e.g. `props` in `function MyCard(props)`. */
  paramName?: string;
  /** Offset of the first character of the first parameter's type annotation
   *  (after the `:`), if any. Used to locate per-field positions for the
   *  unused-prop diagnostic. */
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

/**
 * A Fusion 0.3 component takes the scope *first* and its props second:
 *
 *   local function Button(scope: Scope<typeof(Fusion)>, props: ButtonProps)
 *
 * Treating `scope` as the props table would hand the prop-completion
 * and hardcoded-prop machinery the wrong parameter, so recognise it and
 * skip past. Deliberately narrow — name or annotated type has to
 * actually say "scope" — so a React/Vide component whose props
 * parameter happens to be first is never misread.
 */
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
      // Not an identifier (`...`, or something unparseable) — stop
      // collecting parameters and just find the closing paren.
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
    // Two parameters is all any caller needs (props, or scope + props).
    if (params.length === 2) {
      break;
    }
  }

  // The props table is the first parameter, unless that slot is taken
  // by a Fusion 0.3 scope and a second parameter exists to hold it.
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

function findFunctionDefinitions(maskedText: string): FunctionDef[] {
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
      const bodyEnd = findMatchingEnd(maskedText, bodyStart);
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

interface ScanCacheEntry {
  text: string;
  textLen: number;
  aliasesKey: string;
  result: Map<string, DocumentComponentInfo>;
}
const scanCache: ScanCacheEntry[] = [];
// Bumped from 4 → 8: the active set of "documents being inspected
// concurrently" can exceed 4 in a busy session (current editor +
// diagnostics on a few open files + codeLens + hover on a peeked file).
const SCAN_CACHE_MAX = 8;

export function scanDocument(
  text: string,
  aliases: AliasPartition | string[]
): Map<string, DocumentComponentInfo> {
  const partition = asPartition(aliases);
  const aliasesKey =
    partition.parens.join("|") + " " + partition.curried.join("|");
  const len = text.length;
  for (let i = scanCache.length - 1; i >= 0; i--) {
    const entry = scanCache[i];
    // Cheap rejections first: text length and alias-key are O(1) and
    // O(short-string), so we only pay the full O(N) string-equality
    // cost when a real hit is plausible. On big files this keeps the
    // cache check at near-constant time for misses.
    if (entry.textLen !== len) continue;
    if (entry.aliasesKey !== aliasesKey) continue;
    if (entry.text !== text) continue;
    const hit = scanCache.splice(i, 1)[0];
    scanCache.push(hit);
    return hit.result;
  }

  const { masked } = getMaskedDoc(text);
  const typeAliases = collectTypeAliases(masked);
  const components = new Map<string, DocumentComponentInfo>();

  for (const def of findFunctionDefinitions(masked)) {
    const lastSegment = def.name.split(".").pop()!;
    if (components.has(lastSegment)) {
      continue;
    }

    const defLineIndex = lineNumberOf(text, def.defIdx);
    const annotations = parseAnnotationsForComponent(text, defLineIndex);

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

    const detectedBase = detectReturnedClass(
      text,
      masked,
      def.bodyStart,
      def.bodyEnd,
      partition
    );

    const hardcodedProps = computeHardcodedProps(
      text,
      masked,
      def.bodyStart,
      def.bodyEnd,
      def.paramName,
      partition
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

  scanCache.push({ text, textLen: len, aliasesKey, result: components });
  if (scanCache.length > SCAN_CACHE_MAX) {
    scanCache.shift();
  }
  return components;
}

// ============================================================================
// findAllCreateElementCalls — used by inlay hints + document symbols
// ============================================================================

interface AllCallsCacheEntry {
  text: string;
  aliasesKey: string;
  result: CreateElementCall[];
}
const allCallsCache: AllCallsCacheEntry[] = [];
const ALL_CALLS_CACHE_MAX = 4;

export function findAllCreateElementCalls(
  text: string,
  aliases: AliasPartition | string[]
): CreateElementCall[] {
  const partition = asPartition(aliases);
  const aliasesKey =
    partition.parens.join("|") + " " + partition.curried.join("|");
  for (let i = allCallsCache.length - 1; i >= 0; i--) {
    if (
      allCallsCache[i].text === text &&
      allCallsCache[i].aliasesKey === aliasesKey
    ) {
      const hit = allCallsCache.splice(i, 1)[0];
      allCallsCache.push(hit);
      return hit.result;
    }
  }
  const result = findAllCreateElementCallsImpl(text, partition);
  allCallsCache.push({ text, aliasesKey, result });
  if (allCallsCache.length > ALL_CALLS_CACHE_MAX) {
    allCallsCache.shift();
  }
  // Sort by start position so consumers (inlay hints / symbols) see
  // document-order regardless of which pass produced them.
  result.sort((a, b) => a.aliasStart - b.aliasStart);
  return result;
}

function findAllCreateElementCallsImpl(
  text: string,
  partition: AliasPartition
): CreateElementCall[] {
  const { masked } = getMaskedDoc(text);
  const results: CreateElementCall[] = [];

  // Pass 1: parens form — `ALIAS ( ARG , {…}[, {…}] )`
  if (partition.parens.length > 0) {
    const aliasPattern = buildAliasAlternation(partition.parens);
    // Capturing the alias (was non-capturing): lets us detect when
    // the matched alias is *also* a curried-bucket alias (Vide:
    // `create` / `Vide.create` register in both buckets). In that
    // case the props brace doubles as the inline-children container,
    // matching Vide's `Vide.create("Frame", { Child() })` shape.
    const re = new RegExp(
      `(?<![A-Za-z0-9_.])(${aliasPattern})\\s*\\(`,
      "g"
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

      // For aliases registered in *both* buckets (Vide's `create`), a
      // props stage after the closing paren means this is really the
      // curried form with a parenthesised name stage —
      // `create(scope, "Frame")({ … })` — which pass 2 parses
      // correctly. Bail so the two passes can't both emit a call at
      // this offset with different class names.
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
        // Prefer the precise spec-derived set when present (1.5.0+);
        // fall back to the legacy bucket-membership check for callers
        // (notably hand-rolled test fixtures) that don't populate the
        // new field. Same effective behaviour for the default config
        // where the only multi-shape framework is Vide.
        (partition.parensWithInlineChildren
          ? partition.parensWithInlineChildren.includes(alias)
          : partition.curried.includes(alias)) &&
        propsBraceStart !== undefined &&
        propsBraceEnd !== undefined
      ) {
        // Vide-style parens form: the props table doubles as the
        // inline-children container. `Vide.create("Frame", { Child() })`
        // — `Child()` lives in the same brace as the props.
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

  // Pass 2: curried form. Both stages independently accept Lua's call
  // sugar or explicit parentheses (see the "Curried-form syntax
  // variants" note above), so all of these land here:
  //
  //   ALIAS "Frame" { … }          ALIAS("Frame") { … }
  //   ALIAS "Frame" ({ … })        ALIAS(scope, "Frame")({ … })
  //
  // We anchor only on the alias keyword (which is in code position, so the
  // masked text is safe), then walk forward in the *original* text to read
  // the class-name token (string contents would be blanked in the masked
  // version) and locate the props table.
  if (partition.curried.length > 0) {
    const aliasPattern = buildAliasAlternation(partition.curried);
    // Lookahead was `(?=\s)` — that only ever admitted the sugar form.
    // A plain word boundary lets `ALIAS(` through too; the forward walk
    // below is what actually validates the shape.
    //
    // The leading group absorbs a receiver so `scope:New` (Fusion 0.3
    // `scoped()`) and `MyFusion.New` (a `require` bound to any local
    // name) resolve to the `New` alias. It is *lazy* so a configured
    // dotted alias still wins outright: at `Fusion.New` the empty
    // branch is tried first and the longest-first alternation matches
    // `Fusion.New` whole, exactly as before.
    const aliasRe = new RegExp(
      `(?<![A-Za-z0-9_.])((?:[A-Za-z_][A-Za-z0-9_]*\\s*[.:]\\s*)??)` +
        `(?:${aliasPattern})(?![A-Za-z0-9_])`,
      "g"
    );
    let m: RegExpExecArray | null;
    while ((m = aliasRe.exec(masked)) !== null) {
      const parsed = parseCurriedCall(text, masked, m.index + m[0].length);
      if (!parsed) {
        continue;
      }
      // `aliasStart` covers the receiver too, so the call's text range
      // is complete; the alias and receiver travel separately.
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

/**
 * True when a curried props stage (`{ … }` or `({ … })`) begins at or
 * after `from`, skipping whitespace.
 */
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
  /** Offset of the props table's `{`. */
  openBrace: number;
  /** Offset of the props table's matching `}`. */
  closeBrace: number;
  /** Offset just past the whole call (past `)` when the props stage is
   *  parenthesised, past `}` otherwise). */
  fullEnd: number;
}

/**
 * Parse the two stages of a curried factory call starting at
 * `afterAlias` (the offset just past the alias identifier). Returns
 * undefined when what follows isn't a complete `<name><props>` pair —
 * that rejection is what keeps the widened alias anchor from matching
 * unrelated uses of the same identifier, and what separates Vide's
 * two-argument parens form `create("Frame", { … })` (handled by pass 1)
 * from a parenthesised name stage.
 */
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
    // Parenthesised name stage: `("Frame")` or `(scope, "Frame")`.
    // The class name is the last argument; anything before it is the
    // scope Fusion 0.3 threads through.
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

  // Props stage: `{ … }`, or StyLua's `({ … })`.
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

// ============================================================================
// Color literal extraction (for the DocumentColorProvider)
// ============================================================================

/**
 * Find every Color3 constructor call — `Color3.fromRGB(...)`,
 * `Color3.new(...)`, `Color3.fromHex(...)`, `Color3.fromHSV(...)` — and
 * return the resolved RGB triple (each channel `0..1`).
 *
 * Pass `originalText` alongside `maskedText` so we can read the literal
 * hex string out of `Color3.fromHex("#FFFFFF")` — the masked version
 * has the string interior blanked out. The parameter is optional for
 * back-compat with callers that only have the masked text on hand:
 * fromHex calls won't resolve in that mode (we can't see the hex), but
 * the other constructors still work.
 */
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
      // Re-parse the call from the original text so we can see the
      // string contents (the masked version blanked them out).
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
  // Roblox's HSV is 0..1 across the board. Standard conversion.
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

// ============================================================================
// Small utility used by several providers
// ============================================================================

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
  // Matches both `local X = ...` and `local function X(...)`.
  const re = /(?<![A-Za-z0-9_])local\s+(?:function\s+)?([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    out.add(m[1]);
  }
  return out;
}
