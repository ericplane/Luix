import { rewriteLiteralProps } from "./propEdits";
import * as vscode from "vscode";
import {
  applyMask,
  buildCodeMask,
  extractPropEntriesFromDocument,
  findAllCreateElementCalls,
} from "./parser";
import { getAliasPartition } from "./frameworks";
import { getConfig } from "./configCompat";
import {
  findMatchingBrace,
  findMatchingParen,
  skipWs,
  splitTopLevelArgs,
} from "./textUtils";

// ============================================================================
// ColorSequence parsing
//
// Three call shapes are recognised:
//   ColorSequence.new(c1)                     → solid colour
//   ColorSequence.new(c1, c2)                 → two-stop
//   ColorSequence.new({ CSK.new(t, c), ... }) → N-stop
//
// Each `c` is a `Color3.fromRGB / new / fromHex / fromHSV` call. Anything
// non-literal (a variable, function call, etc.) makes the whole gradient
// unparseable — in that case we return `undefined` so callers can leave
// the literal alone.
// ============================================================================

export interface GradientStop {
  t: number; // offset, 0..1
  r: number; // 0..1
  g: number;
  b: number;
}

export interface GradientLiteral {
  /** Offset of `ColorSequence`. */
  start: number;
  /** Offset just after the matching `)`. */
  end: number;
  stops: GradientStop[];
}

const COLOR_SEQUENCE_PATTERN =
  /\bColorSequence\.new\s*\(/g;

interface GradientCacheEntry {
  text: string;
  result: GradientLiteral[];
}
const gradientCache: GradientCacheEntry[] = [];
const GRADIENT_CACHE_MAX = 4;

/**
 * Find every `ColorSequence.new(...)` literal whose arguments are all
 * Color3 literals (and, for the keypoint form, numeric offsets). Returns
 * an empty array if none parse cleanly.
 *
 * Cached by document text identity — CodeLens + hover both call this on
 * every refresh, so the cache keeps the hot path free.
 */
export function findGradientLiterals(text: string): GradientLiteral[] {
  for (let i = gradientCache.length - 1; i >= 0; i--) {
    if (gradientCache[i].text === text) {
      const hit = gradientCache.splice(i, 1)[0];
      gradientCache.push(hit);
      return hit.result;
    }
  }

  // Fast scan: if the substring isn't present at all, skip the masking
  // step (which builds an N-length array).
  if (!text.includes("ColorSequence.new")) {
    const empty: GradientLiteral[] = [];
    gradientCache.push({ text, result: empty });
    if (gradientCache.length > GRADIENT_CACHE_MAX) {
      gradientCache.shift();
    }
    return empty;
  }

  const out: GradientLiteral[] = [];
  const mask = buildCodeMask(text);
  const masked = applyMask(text, mask);

  COLOR_SEQUENCE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COLOR_SEQUENCE_PATTERN.exec(masked)) !== null) {
    const start = m.index;
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingParen(masked, openParen);
    if (closeParen === -1) {
      continue;
    }
    const stops = parseGradientArgs(
      text,
      masked,
      openParen + 1,
      closeParen
    );
    if (!stops) {
      continue;
    }
    out.push({ start, end: closeParen + 1, stops });
  }

  gradientCache.push({ text, result: out });
  if (gradientCache.length > GRADIENT_CACHE_MAX) {
    gradientCache.shift();
  }
  return out;
}

function parseGradientArgs(
  text: string,
  masked: string,
  argsStart: number,
  argsEnd: number
): GradientStop[] | undefined {
  // Distinguish keypoint-table form from the (c) / (c1, c2) forms by
  // looking for an opening `{` before the first comma.
  const trimmedStart = skipWs(masked, argsStart, argsEnd);
  if (trimmedStart >= argsEnd) {
    // Empty `ColorSequence.new()` — surface the editor anyway with a
    // sensible black→white placeholder, so the user can populate it
    // visually instead of having to type a Color3 first.
    return [
      { t: 0, r: 0, g: 0, b: 0 },
      { t: 1, r: 1, g: 1, b: 1 },
    ];
  }
  if (masked[trimmedStart] === "{") {
    const closeBrace = findMatchingBrace(masked, trimmedStart);
    if (closeBrace === -1 || closeBrace > argsEnd) {
      return undefined;
    }
    return parseKeypointArray(
      text,
      masked,
      trimmedStart + 1,
      closeBrace
    );
  }
  // (c) or (c1, c2)
  const args = splitTopLevelArgs(masked, argsStart, argsEnd);
  if (args.length === 0 || args.length > 2) {
    return undefined;
  }
  const colors: Array<{ r: number; g: number; b: number }> = [];
  for (const arg of args) {
    const c = parseColor3Expr(text, masked, arg.start, arg.end);
    if (!c) {
      return undefined;
    }
    colors.push(c);
  }
  if (colors.length === 1) {
    return [
      { t: 0, ...colors[0] },
      { t: 1, ...colors[0] },
    ];
  }
  return [
    { t: 0, ...colors[0] },
    { t: 1, ...colors[1] },
  ];
}

function parseKeypointArray(
  text: string,
  masked: string,
  bodyStart: number,
  bodyEnd: number
): GradientStop[] | undefined {
  const stops: GradientStop[] = [];
  const entries = splitTopLevelArgs(masked, bodyStart, bodyEnd);
  if (entries.length < 2) {
    return undefined;
  }
  for (const entry of entries) {
    const stop = parseKeypoint(text, masked, entry.start, entry.end);
    if (!stop) {
      return undefined;
    }
    stops.push(stop);
  }
  stops.sort((a, b) => a.t - b.t);
  return stops;
}

const KEYPOINT_PATTERN =
  /\bColorSequenceKeypoint\.new\s*\(/;

function parseKeypoint(
  text: string,
  masked: string,
  start: number,
  end: number
): GradientStop | undefined {
  const slice = masked.slice(start, end);
  const m = KEYPOINT_PATTERN.exec(slice);
  if (!m) {
    return undefined;
  }
  const openParenRel = m.index + m[0].length - 1;
  const openParen = start + openParenRel;
  const closeParen = findMatchingParen(masked, openParen);
  if (closeParen === -1 || closeParen > end) {
    return undefined;
  }
  const args = splitTopLevelArgs(masked, openParen + 1, closeParen);
  if (args.length !== 2) {
    return undefined;
  }
  const tText = text.slice(args[0].start, args[0].end).trim();
  const t = Number(tText);
  if (!Number.isFinite(t) || t < 0 || t > 1) {
    return undefined;
  }
  const color = parseColor3Expr(text, masked, args[1].start, args[1].end);
  if (!color) {
    return undefined;
  }
  return { t, ...color };
}

const COLOR3_PATTERN =
  /\bColor3\.(fromRGB|new|fromHex|fromHSV)\s*\(/;

function parseColor3Expr(
  text: string,
  masked: string,
  start: number,
  end: number
): { r: number; g: number; b: number } | undefined {
  const slice = masked.slice(start, end);
  const m = COLOR3_PATTERN.exec(slice);
  if (!m) {
    return undefined;
  }
  const kind = m[1];
  const openParenRel = m.index + m[0].length - 1;
  const openParen = start + openParenRel;
  const closeParen = findMatchingParen(masked, openParen);
  if (closeParen === -1 || closeParen > end) {
    return undefined;
  }
  const argText = text.slice(openParen + 1, closeParen);
  if (kind === "fromHex") {
    const hex = /["']\s*(#?[0-9a-fA-F]{3,8})\s*["']/.exec(argText);
    if (!hex) {
      return undefined;
    }
    return parseHex(hex[1]);
  }
  const nums = argText.split(",").map((s) => Number(s.trim()));
  if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) {
    return undefined;
  }
  if (kind === "fromRGB") {
    return { r: nums[0] / 255, g: nums[1] / 255, b: nums[2] / 255 };
  }
  if (kind === "fromHSV") {
    return hsvToRgb(nums[0], nums[1], nums[2]);
  }
  if (nums.some((n) => n < 0 || n > 1)) {
    return undefined;
  }
  return { r: nums[0], g: nums[1], b: nums[2] };
}

function parseHex(s: string): { r: number; g: number; b: number } | undefined {
  let v = s.startsWith("#") ? s.slice(1) : s;
  if (v.length === 3) {
    v = v
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (v.length !== 6) {
    return undefined;
  }
  const n = parseInt(v, 16);
  if (Number.isNaN(n)) {
    return undefined;
  }
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

// ============================================================================
// NumberSequence parsing
//
// Same three call shapes as ColorSequence:
//   NumberSequence.new(v)
//   NumberSequence.new(v1, v2)
//   NumberSequence.new({ NumberSequenceKeypoint.new(t, v, env?), ... })
//
// NumberSequenceKeypoint's third arg (envelope) is optional and defaults
// to 0. Each value is expected to be a literal number; expressions
// referencing variables make the literal unparseable and we skip it.
// ============================================================================

export interface NumberStop {
  t: number; // 0..1
  v: number; // 0..1 (transparency) or any non-negative float (size etc.)
  env: number; // 0..1
}

export interface NumberSequenceLiteral {
  /** Offset of `NumberSequence`. */
  start: number;
  /** Offset just after the matching `)`. */
  end: number;
  stops: NumberStop[];
}

const NUMBER_SEQUENCE_PATTERN = /\bNumberSequence\.new\s*\(/g;
const NUMBER_KEYPOINT_PATTERN = /\bNumberSequenceKeypoint\.new\s*\(/;

interface NumberSequenceCacheEntry {
  text: string;
  result: NumberSequenceLiteral[];
}
const numberSequenceCache: NumberSequenceCacheEntry[] = [];
const NUMBER_SEQUENCE_CACHE_MAX = 4;

export function findNumberSequenceLiterals(
  text: string
): NumberSequenceLiteral[] {
  for (let i = numberSequenceCache.length - 1; i >= 0; i--) {
    if (numberSequenceCache[i].text === text) {
      const hit = numberSequenceCache.splice(i, 1)[0];
      numberSequenceCache.push(hit);
      return hit.result;
    }
  }

  if (!text.includes("NumberSequence.new")) {
    const empty: NumberSequenceLiteral[] = [];
    numberSequenceCache.push({ text, result: empty });
    if (numberSequenceCache.length > NUMBER_SEQUENCE_CACHE_MAX) {
      numberSequenceCache.shift();
    }
    return empty;
  }

  const out: NumberSequenceLiteral[] = [];
  const mask = buildCodeMask(text);
  const masked = applyMask(text, mask);

  NUMBER_SEQUENCE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_SEQUENCE_PATTERN.exec(masked)) !== null) {
    const start = m.index;
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingParen(masked, openParen);
    if (closeParen === -1) {
      continue;
    }
    const stops = parseNumberSequenceArgs(
      text,
      masked,
      openParen + 1,
      closeParen
    );
    if (!stops) {
      continue;
    }
    out.push({ start, end: closeParen + 1, stops });
  }

  numberSequenceCache.push({ text, result: out });
  if (numberSequenceCache.length > NUMBER_SEQUENCE_CACHE_MAX) {
    numberSequenceCache.shift();
  }
  return out;
}

function parseNumberSequenceArgs(
  text: string,
  masked: string,
  argsStart: number,
  argsEnd: number
): NumberStop[] | undefined {
  const trimmedStart = skipWs(masked, argsStart, argsEnd);
  if (trimmedStart >= argsEnd) {
    // Empty `NumberSequence.new()` → placeholder 0→0 (opaque to opaque).
    return [
      { t: 0, v: 0, env: 0 },
      { t: 1, v: 0, env: 0 },
    ];
  }
  if (masked[trimmedStart] === "{") {
    const closeBrace = findMatchingBrace(masked, trimmedStart);
    if (closeBrace === -1 || closeBrace > argsEnd) {
      return undefined;
    }
    return parseNumberKeypointArray(text, masked, trimmedStart + 1, closeBrace);
  }
  const args = splitTopLevelArgs(masked, argsStart, argsEnd);
  if (args.length === 0 || args.length > 2) {
    return undefined;
  }
  const values: number[] = [];
  for (const arg of args) {
    const numText = text.slice(arg.start, arg.end).trim();
    const num = Number(numText);
    if (!Number.isFinite(num)) {
      return undefined;
    }
    values.push(num);
  }
  if (values.length === 1) {
    return [
      { t: 0, v: values[0], env: 0 },
      { t: 1, v: values[0], env: 0 },
    ];
  }
  return [
    { t: 0, v: values[0], env: 0 },
    { t: 1, v: values[1], env: 0 },
  ];
}

function parseNumberKeypointArray(
  text: string,
  masked: string,
  bodyStart: number,
  bodyEnd: number
): NumberStop[] | undefined {
  const stops: NumberStop[] = [];
  const entries = splitTopLevelArgs(masked, bodyStart, bodyEnd);
  if (entries.length < 2) {
    return undefined;
  }
  for (const entry of entries) {
    const stop = parseNumberKeypoint(text, masked, entry.start, entry.end);
    if (!stop) {
      return undefined;
    }
    stops.push(stop);
  }
  stops.sort((a, b) => a.t - b.t);
  return stops;
}

function parseNumberKeypoint(
  text: string,
  masked: string,
  start: number,
  end: number
): NumberStop | undefined {
  const slice = masked.slice(start, end);
  const m = NUMBER_KEYPOINT_PATTERN.exec(slice);
  if (!m) {
    return undefined;
  }
  const openParenRel = m.index + m[0].length - 1;
  const openParen = start + openParenRel;
  const closeParen = findMatchingParen(masked, openParen);
  if (closeParen === -1 || closeParen > end) {
    return undefined;
  }
  const args = splitTopLevelArgs(masked, openParen + 1, closeParen);
  if (args.length < 2 || args.length > 3) {
    return undefined;
  }
  const t = Number(text.slice(args[0].start, args[0].end).trim());
  const v = Number(text.slice(args[1].start, args[1].end).trim());
  if (!Number.isFinite(t) || !Number.isFinite(v) || t < 0 || t > 1) {
    return undefined;
  }
  let env = 0;
  if (args.length === 3) {
    const e = Number(text.slice(args[2].start, args[2].end).trim());
    if (!Number.isFinite(e) || e < 0) {
      return undefined;
    }
    env = e;
  }
  return { t, v, env };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
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

// Tiny bracket/range helpers live in `./textUtils` — same implementations
// formerly duplicated here, now shared with rect.ts and hoverPreviews.ts.

// ============================================================================
// Lua code generation — render a stop array back into a `ColorSequence.new`
// expression matching the user's preferred Color3 format setting.
// ============================================================================
export function renderColorSequence(
  stops: GradientStop[],
  outerIndent = "",
  innerStep = "\t"
): string {
  const sorted = [...stops].sort((a, b) => a.t - b.t);
  // Collapse identical-color endpoints into the shortest form.
  if (
    sorted.length === 2 &&
    sorted[0].t === 0 &&
    sorted[1].t === 1
  ) {
    if (sameColor(sorted[0], sorted[1])) {
      return `ColorSequence.new(${renderColor3(sorted[0])})`;
    }
    return `ColorSequence.new(${renderColor3(sorted[0])}, ${renderColor3(sorted[1])})`;
  }
  // Multi-stop: indent inner lines by `outerIndent + innerStep` and put the
  // closing `})` at `outerIndent` so it lines up with whatever introduced
  // the call (e.g. `        Color = ColorSequence.new({` → keypoints at
  // `        \t`, closing brace at `        `).
  const lines = sorted
    .map(
      (s) =>
        `${outerIndent}${innerStep}ColorSequenceKeypoint.new(${formatNum(s.t)}, ${renderColor3(s)}),`
    )
    .join("\n");
  return `ColorSequence.new({\n${lines}\n${outerIndent}})`;
}

function sameColor(a: GradientStop, b: GradientStop): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function renderColor3(c: { r: number; g: number; b: number }): string {
  const format = getConfig<string>("color3.defaultFormat", "fromRGB");
  if (format === "fromHex") {
    return `Color3.fromHex("${toHex(c)}")`;
  }
  if (format === "new") {
    return `Color3.new(${formatNum(c.r)}, ${formatNum(c.g)}, ${formatNum(c.b)})`;
  }
  // fromRGB default
  return `Color3.fromRGB(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;
}

function toHex(c: { r: number; g: number; b: number }): string {
  const h = (n: number) =>
    Math.round(n * 255).toString(16).toUpperCase().padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) {
    return n.toString();
  }
  return Number(n.toFixed(3)).toString();
}

/**
 * Render a `NumberSequence.new(...)` call from its stops. Mirrors the
 * collapsing rules of `renderColorSequence` — two-endpoint constants use
 * the short form, otherwise we emit the keypoint-table form. The third
 * `envelope` argument is omitted when zero (Roblox's default).
 */
export function renderNumberSequence(
  stops: NumberStop[],
  outerIndent = "",
  innerStep = "\t"
): string {
  const sorted = [...stops].sort((a, b) => a.t - b.t);
  const noEnvelopes = sorted.every((s) => s.env === 0);
  if (
    sorted.length === 2 &&
    sorted[0].t === 0 &&
    sorted[1].t === 1 &&
    noEnvelopes
  ) {
    if (sorted[0].v === sorted[1].v) {
      return `NumberSequence.new(${formatNum(sorted[0].v)})`;
    }
    return `NumberSequence.new(${formatNum(sorted[0].v)}, ${formatNum(sorted[1].v)})`;
  }
  const lines = sorted
    .map((s) => {
      const tail =
        s.env === 0
          ? `${formatNum(s.t)}, ${formatNum(s.v)}`
          : `${formatNum(s.t)}, ${formatNum(s.v)}, ${formatNum(s.env)}`;
      return `${outerIndent}${innerStep}NumberSequenceKeypoint.new(${tail}),`;
    })
    .join("\n");
  return `NumberSequence.new({\n${lines}\n${outerIndent}})`;
}

// ============================================================================
// UIGradient sibling-prop context
//
// When a Color/NumberSequence literal sits inside an `e("UIGradient", { … })`
// props table, the editor's preview should reflect the OTHER channel and
// the Rotation prop too — so a user editing the colour ramp can see the
// final element. `findUIGradientContext` returns whatever it can parse
// without applying any side effects to the document.
// ============================================================================

export interface UIGradientContext {
  /** Range of the `e("UIGradient", { … })` props brace `{ … }`. */
  propsBraceStart: number;
  propsBraceEnd: number;
  colorStops?: GradientStop[];
  transparencyStops?: NumberStop[];
  rotation?: number;
  /** Range of the sibling Color/Transparency literal, if any — so callers
   *  can omit it from preview rendering when the user is currently editing it. */
  colorLiteral?: { start: number; end: number };
  transparencyLiteral?: { start: number; end: number };
}

/**
 * Find every `e("UIGradient", { … })` element call in the document, so
 * we can hang a single "Edit UIGradient" CodeLens above each one
 * (instead of separate lenses for the Color and Transparency literals
 * inside).
 */
export function findUIGradientCalls(
  text: string
): Array<{
  aliasStart: number;
  fullEnd: number;
  propsBraceStart: number;
  propsBraceEnd: number;
}> {
  // Fast reject: most files have no UIGradient at all, and this fires
  // from the CodeLens provider on every refresh.
  if (!text.includes("UIGradient")) {
    return [];
  }
  const aliases = getAliasPartition();
  const calls = findAllCreateElementCalls(text, aliases);
  const out: Array<{
    aliasStart: number;
    fullEnd: number;
    propsBraceStart: number;
    propsBraceEnd: number;
  }> = [];
  for (const c of calls) {
    if (
      c.isStringLiteralName &&
      c.className === "UIGradient" &&
      c.propsBraceStart !== undefined &&
      c.propsBraceEnd !== undefined
    ) {
      out.push({
        aliasStart: c.aliasStart,
        fullEnd: c.fullEnd,
        propsBraceStart: c.propsBraceStart,
        propsBraceEnd: c.propsBraceEnd,
      });
    }
  }
  return out;
}

/**
 * Find the `BackgroundColor3` of the element that *contains* the given
 * UIGradient call — the gradient is rendered over that color in Roblox,
 * so the preview should reflect it. Returns `undefined` when the parent
 * doesn't set BackgroundColor3 (callers default to Roblox's white).
 */
export function findParentBackgroundColor3(
  text: string,
  uigradientStart: number,
  uigradientEnd: number
): { r: number; g: number; b: number } | undefined {
  const aliases = getAliasPartition();
  const calls = findAllCreateElementCalls(text, aliases);
  // Smallest call strictly containing the UIGradient (and that isn't the
  // UIGradient itself) is its immediate parent in the tree.
  let parent: typeof calls[number] | undefined;
  for (const c of calls) {
    if (c.aliasStart === uigradientStart && c.fullEnd === uigradientEnd) {
      continue;
    }
    if (c.aliasStart <= uigradientStart && c.fullEnd >= uigradientEnd) {
      if (
        !parent ||
        c.fullEnd - c.aliasStart < parent.fullEnd - parent.aliasStart
      ) {
        parent = c;
      }
    }
  }
  if (
    !parent ||
    parent.propsBraceStart === undefined ||
    parent.propsBraceEnd === undefined
  ) {
    return undefined;
  }
  const bodyStart = parent.propsBraceStart + 1;
  const propsBody = text.slice(bodyStart, parent.propsBraceEnd);
  const entries = extractPropEntriesFromDocument(
    text,
    bodyStart,
    parent.propsBraceEnd
  );
  const bgEntry = entries.find((e) => e.key === "BackgroundColor3");
  if (!bgEntry) {
    return undefined;
  }
  const valueStart = bodyStart + bgEntry.valueStart;
  const valueEnd = bodyStart + bgEntry.valueEnd;
  const mask = buildCodeMask(text);
  const masked = applyMask(text, mask);
  return parseColor3Expr(text, masked, valueStart, valueEnd);
}

export function findUIGradientContext(
  text: string,
  literalStart: number,
  literalEnd: number
): UIGradientContext | undefined {
  const aliases = getAliasPartition();
  const calls = findAllCreateElementCalls(text, aliases);
  // Find the smallest call whose props brace strictly contains the literal.
  let host: { propsBraceStart: number; propsBraceEnd: number } | undefined;
  for (const call of calls) {
    if (
      !call.isStringLiteralName ||
      call.className !== "UIGradient" ||
      call.propsBraceStart === undefined ||
      call.propsBraceEnd === undefined
    ) {
      continue;
    }
    if (
      literalStart > call.propsBraceStart &&
      literalEnd <= call.propsBraceEnd
    ) {
      if (
        !host ||
        call.propsBraceEnd - call.propsBraceStart <
          host.propsBraceEnd - host.propsBraceStart
      ) {
        host = {
          propsBraceStart: call.propsBraceStart,
          propsBraceEnd: call.propsBraceEnd,
        };
      }
    }
  }
  if (!host) {
    return undefined;
  }
  const bodyStart = host.propsBraceStart + 1;
  const propsBody = text.slice(bodyStart, host.propsBraceEnd);
  const entries = extractPropEntriesFromDocument(
    text,
    bodyStart,
    host.propsBraceEnd
  );

  const ctx: UIGradientContext = {
    propsBraceStart: host.propsBraceStart,
    propsBraceEnd: host.propsBraceEnd,
  };
  for (const entry of entries) {
    const valueText = propsBody.slice(entry.valueStart, entry.valueEnd).trim();
    if (entry.key === "Color") {
      // Reuse the color-sequence parser by passing a single-literal slice.
      const literals = findGradientLiterals(text);
      const absValueStart = bodyStart + entry.valueStart;
      const absValueEnd = bodyStart + entry.valueEnd;
      const lit = literals.find(
        (l) => l.start >= absValueStart && l.end <= absValueEnd
      );
      if (lit) {
        ctx.colorStops = lit.stops;
        ctx.colorLiteral = { start: lit.start, end: lit.end };
      }
    } else if (entry.key === "Transparency") {
      const literals = findNumberSequenceLiterals(text);
      const absValueStart = bodyStart + entry.valueStart;
      const absValueEnd = bodyStart + entry.valueEnd;
      const lit = literals.find(
        (l) => l.start >= absValueStart && l.end <= absValueEnd
      );
      if (lit) {
        ctx.transparencyStops = lit.stops;
        ctx.transparencyLiteral = { start: lit.start, end: lit.end };
      }
    } else if (entry.key === "Rotation") {
      const num = Number(valueText);
      if (Number.isFinite(num)) {
        ctx.rotation = num;
      }
    }
  }
  return ctx;
}

// ============================================================================
// Inline preview: SVG data URI for hover markdown
// ============================================================================
export function gradientSvgDataUri(
  stops: GradientStop[],
  width = 220,
  height = 24
): string {
  const sorted = [...stops].sort((a, b) => a.t - b.t);
  const stopsXml = sorted
    .map(
      (s) =>
        `<stop offset="${(s.t * 100).toFixed(2)}%" stop-color="rgb(${Math.round(
          s.r * 255
        )},${Math.round(s.g * 255)},${Math.round(s.b * 255)})"/>`
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">${stopsXml}</linearGradient></defs><rect width="${width}" height="${height}" rx="3" ry="3" fill="url(#g)" stroke="#888" stroke-width="0.5"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * Render a NumberSequence preview as a horizontal value-curve strip —
 * useful in the hover tooltip when there's no colour to display.
 */
export function numberSequenceSvgDataUri(
  stops: NumberStop[],
  width = 220,
  height = 36
): string {
  const sorted = [...stops].sort((a, b) => a.t - b.t);
  if (sorted.length === 0) {
    return "";
  }
  const maxV = Math.max(1, ...sorted.map((s) => s.v));
  const points = sorted
    .map((s) => {
      const x = (s.t * width).toFixed(2);
      const y = (height - (s.v / maxV) * (height - 2) - 1).toFixed(2);
      return `${x},${y}`;
    })
    .join(" ");
  const fillPoints = `0,${height} ${points} ${width},${height}`;
  const dots = sorted
    .map((s) => {
      const cx = (s.t * width).toFixed(2);
      const cy = (height - (s.v / maxV) * (height - 2) - 1).toFixed(2);
      return `<circle cx="${cx}" cy="${cy}" r="2" fill="#7C5CFF"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" rx="3" ry="3" fill="rgba(127,127,127,0.08)" stroke="#888" stroke-width="0.5"/><polygon points="${fillPoints}" fill="rgba(124,92,255,0.18)" stroke="none"/><polyline points="${points}" fill="none" stroke="#7C5CFF" stroke-width="1.5"/>${dots}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// ============================================================================
// CodeLens — "Edit gradient" above any literal
// ============================================================================
export class GradientCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("luix.gradient")) {
          this._onDidChange.fire();
        }
      })
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!getConfig<boolean>("gradient.codeLensEnabled", true)) {
      return [];
    }
    const text = document.getText();
    const out: vscode.CodeLens[] = [];

    // 1) Single "Edit UIGradient" lens for every `e("UIGradient", {...})`
    //    call. This combined editor handles Color, Transparency, and
    //    Rotation together — no separate lenses for the inner literals.
    const uigradients = findUIGradientCalls(text);
    for (const ui of uigradients) {
      const range = new vscode.Range(
        document.positionAt(ui.aliasStart),
        document.positionAt(ui.fullEnd)
      );
      out.push(
        new vscode.CodeLens(range, {
          title: "$(symbol-color) Edit UIGradient",
          command: "luix.openGradientEditor",
          arguments: [document.uri, range, "uigradient"],
        })
      );
    }

    // Helper: is a literal at [start, end) inside any UIGradient props brace?
    const insideUIGradient = (start: number, end: number) =>
      uigradients.some(
        (ui) =>
          start > ui.propsBraceStart &&
          end <= ui.propsBraceEnd
      );

    // 2) Standalone ColorSequence literals (NOT inside a UIGradient).
    for (const lit of findGradientLiterals(text)) {
      if (insideUIGradient(lit.start, lit.end)) {
        continue;
      }
      const range = new vscode.Range(
        document.positionAt(lit.start),
        document.positionAt(lit.end)
      );
      out.push(
        new vscode.CodeLens(range, {
          title: "$(symbol-color) Edit gradient",
          command: "luix.openGradientEditor",
          arguments: [document.uri, range, "color"],
        })
      );
    }

    // 3) Standalone NumberSequence literals (NOT inside a UIGradient).
    for (const lit of findNumberSequenceLiterals(text)) {
      if (insideUIGradient(lit.start, lit.end)) {
        continue;
      }
      const range = new vscode.Range(
        document.positionAt(lit.start),
        document.positionAt(lit.end)
      );
      out.push(
        new vscode.CodeLens(range, {
          title: "$(graph-line) Edit sequence",
          command: "luix.openGradientEditor",
          arguments: [document.uri, range, "number"],
        })
      );
    }
    return out;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}

// ============================================================================
// Hover — inline gradient strip preview
// ============================================================================
export class GradientHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    if (!getConfig<boolean>("gradient.previewOnHover", true)) {
      return undefined;
    }
    const offset = document.offsetAt(position);
    const text = document.getText();

    const colorHit = findGradientLiterals(text).find(
      (l) => offset >= l.start && offset <= l.end
    );
    if (colorHit) {
      const uri = gradientSvgDataUri(colorHit.stops);
      const md = new vscode.MarkdownString();
      md.isTrusted = false;
      md.supportHtml = false;
      md.appendMarkdown(`**Gradient preview**\n\n![](${uri})\n\n`);
      md.appendMarkdown(
        `${colorHit.stops.length} stop${colorHit.stops.length === 1 ? "" : "s"} · _Click the_ \`Edit gradient\` _CodeLens above to open the editor._`
      );
      return new vscode.Hover(
        md,
        new vscode.Range(
          document.positionAt(colorHit.start),
          document.positionAt(colorHit.end)
        )
      );
    }

    const numHit = findNumberSequenceLiterals(text).find(
      (l) => offset >= l.start && offset <= l.end
    );
    if (numHit) {
      const uri = numberSequenceSvgDataUri(numHit.stops);
      const md = new vscode.MarkdownString();
      md.isTrusted = false;
      md.supportHtml = false;
      md.appendMarkdown(`**NumberSequence preview**\n\n![](${uri})\n\n`);
      md.appendMarkdown(
        `${numHit.stops.length} stop${numHit.stops.length === 1 ? "" : "s"} · _Click the_ \`Edit sequence\` _CodeLens above to open the editor._`
      );
      return new vscode.Hover(
        md,
        new vscode.Range(
          document.positionAt(numHit.start),
          document.positionAt(numHit.end)
        )
      );
    }

    return undefined;
  }
}

// ============================================================================
// Webview editor
// ============================================================================
export type GradientMode = "color" | "number" | "uigradient";

export class GradientEditorManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  open(uri: vscode.Uri, range: vscode.Range, mode: GradientMode = "color"): void {
    const key = `${mode}:${uri.toString()}#${range.start.line}:${range.start.character}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    void this.openImpl(uri, range, mode, key);
  }

  private async openImpl(
    uri: vscode.Uri,
    range: vscode.Range,
    mode: GradientMode,
    key: string
  ): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    const startOff = document.offsetAt(range.start);
    const endOff = document.offsetAt(range.end);

    // Per-mode resolution. The webview gets just the data it needs: a
    // ColorSequence editor sees colour stops only, a NumberSequence editor
    // sees number stops only, and the UIGradient editor gets everything
    // (both channels + rotation + parent BG colour).
    let colorHit: GradientLiteral | undefined;
    let numberHit: NumberSequenceLiteral | undefined;
    let uiGradientCall:
      | { aliasStart: number; fullEnd: number; propsBraceStart: number; propsBraceEnd: number }
      | undefined;
    let initColorStops: GradientStop[] | undefined;
    let initNumberStops: NumberStop[] | undefined;
    let initRotation = 0;
    let parentBg: { r: number; g: number; b: number } | undefined;

    if (mode === "color") {
      colorHit = findGradientLiterals(text).find(
        (l) => l.start === startOff && l.end === endOff
      );
      if (!colorHit) {
        void vscode.window.showWarningMessage(
          "Luix: couldn't parse this ColorSequence — every Color3 argument must be a literal."
        );
        return;
      }
      initColorStops = colorHit.stops;
    } else if (mode === "number") {
      numberHit = findNumberSequenceLiterals(text).find(
        (l) => l.start === startOff && l.end === endOff
      );
      if (!numberHit) {
        void vscode.window.showWarningMessage(
          "Luix: couldn't parse this NumberSequence — every argument must be a literal number."
        );
        return;
      }
      initNumberStops = numberHit.stops;
    } else {
      // uigradient — look up the UIGradient call at this range and read
      // its Color / Transparency / Rotation props from inside.
      uiGradientCall = findUIGradientCalls(text).find(
        (c) => c.aliasStart === startOff && c.fullEnd === endOff
      );
      if (!uiGradientCall) {
        void vscode.window.showWarningMessage(
          "Luix: couldn't find the UIGradient call at this location."
        );
        return;
      }
      const bodyStart = uiGradientCall.propsBraceStart + 1;
      const propsBody = text.slice(bodyStart, uiGradientCall.propsBraceEnd);
      const entries = extractPropEntriesFromDocument(
        text,
        bodyStart,
        uiGradientCall.propsBraceEnd
      );
      for (const entry of entries) {
        const absValueStart = bodyStart + entry.valueStart;
        const absValueEnd = bodyStart + entry.valueEnd;
        if (entry.key === "Color") {
          const lit = findGradientLiterals(text).find(
            (l) => l.start >= absValueStart && l.end <= absValueEnd
          );
          if (lit) {
            initColorStops = lit.stops;
          }
        } else if (entry.key === "Transparency") {
          const lit = findNumberSequenceLiterals(text).find(
            (l) => l.start >= absValueStart && l.end <= absValueEnd
          );
          if (lit) {
            initNumberStops = lit.stops;
          }
        } else if (entry.key === "Rotation") {
          const n = Number(text.slice(absValueStart, absValueEnd).trim());
          if (Number.isFinite(n)) {
            initRotation = n;
          }
        }
      }
      if (!initColorStops) {
        initColorStops = [
          { t: 0, r: 1, g: 1, b: 1 },
          { t: 1, r: 1, g: 1, b: 1 },
        ];
      }
      if (!initNumberStops) {
        initNumberStops = [
          { t: 0, v: 0, env: 0 },
          { t: 1, v: 0, env: 0 },
        ];
      }
      parentBg = findParentBackgroundColor3(
        text,
        uiGradientCall.aliasStart,
        uiGradientCall.fullEnd
      );
    }

    const title =
      mode === "color"
        ? "Luix · ColorSequence"
        : mode === "number"
          ? "Luix · NumberSequence"
          : "Luix · UIGradient";

    const panel = vscode.window.createWebviewPanel(
      "luix.gradientEditor",
      title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    // Show the Luix logo in the tab instead of the default `?` icon.
    panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "assets",
      "icon.png"
    );
    this.panels.set(key, panel);
    let disposed = false;
    panel.onDidDispose(() => {
      disposed = true;
      this.panels.delete(key);
    });

    // Register message handler BEFORE assigning HTML — the webview's
    // iframe begins loading immediately on assignment and can fire its
    // `ready` message before a handler attached afterward would catch
    // it, leaving the editor stuck on "Loading…".
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (disposed) {return;}
      if (msg?.type === "ready") {
        panel.webview.postMessage({
          type: "init",
          mode,
          colorStops: initColorStops,
          numberStops: initNumberStops,
          rotation: initRotation,
          parentBg: parentBg ?? { r: 1, g: 1, b: 1 },
        });
        return;
      }
      if (msg?.type === "apply") {
        if (mode === "color" && colorHit) {
          await applyColorEdit(uri, colorHit, msg.colorStops as GradientStop[]);
        } else if (mode === "number" && numberHit) {
          await applyNumberEdit(
            uri,
            numberHit,
            msg.numberStops as NumberStop[]
          );
        } else if (mode === "uigradient" && uiGradientCall) {
          await applyUIGradientEdit(
            uri,
            uiGradientCall,
            msg.colorStops as GradientStop[],
            msg.numberStops as NumberStop[],
            typeof msg.rotation === "number" ? msg.rotation : 0
          );
        }
        panel.dispose();
      }
      if (msg?.type === "cancel") {
        panel.dispose();
      }
    });
    panel.webview.html = renderGradientWebviewHtml();
  }

  dispose(): void {
    for (const p of this.panels.values()) {
      p.dispose();
    }
    this.panels.clear();
  }
}

// Re-locate a literal's range in the (possibly edited) document. We try
// exact-offset match first, then fall back to whatever literal lives on
// the same line. Returns `undefined` if the literal can't be found at all.
function relocateLiteral<T extends { start: number; end: number }>(
  document: vscode.TextDocument,
  literals: T[],
  original: { start: number; end: number }
): T | undefined {
  return (
    literals.find(
      (l) => l.start === original.start && l.end === original.end
    ) ??
    literals.find(
      (l) =>
        document.positionAt(l.start).line ===
        document.positionAt(original.start).line
    )
  );
}

function indentationFor(
  document: vscode.TextDocument,
  uri: vscode.Uri,
  offset: number
): { outerIndent: string; innerStep: string } {
  const lineText = document.lineAt(document.positionAt(offset).line).text;
  const outerIndent = /^[\t ]*/.exec(lineText)?.[0] ?? "";
  const editorConfig = vscode.workspace.getConfiguration("editor", uri);
  const insertSpaces = editorConfig.get<boolean>("insertSpaces", true);
  const tabSize = editorConfig.get<number>("tabSize", 4);
  return {
    outerIndent,
    innerStep: insertSpaces ? " ".repeat(tabSize) : "\t",
  };
}

async function applyColorEdit(
  uri: vscode.Uri,
  original: GradientLiteral,
  newStops: GradientStop[]
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const match = relocateLiteral(
    document,
    findGradientLiterals(document.getText()),
    original
  );
  if (!match) {
    return;
  }
  const { outerIndent, innerStep } = indentationFor(document, uri, match.start);
  const replacement = renderColorSequence(newStops, outerIndent, innerStep);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(
      document.positionAt(match.start),
      document.positionAt(match.end)
    ),
    replacement
  );
  await vscode.workspace.applyEdit(edit);
}

async function applyNumberEdit(
  uri: vscode.Uri,
  original: NumberSequenceLiteral,
  newStops: NumberStop[]
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const match = relocateLiteral(
    document,
    findNumberSequenceLiterals(document.getText()),
    original
  );
  if (!match) {
    return;
  }
  const { outerIndent, innerStep } = indentationFor(document, uri, match.start);
  const replacement = renderNumberSequence(newStops, outerIndent, innerStep);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(
      document.positionAt(match.start),
      document.positionAt(match.end)
    ),
    replacement
  );
  await vscode.workspace.applyEdit(edit);
}

/**
 * Apply a combined UIGradient edit: rewrite the Color / Transparency
 * literals (creating them if they don't exist) and set the Rotation
 * value. All three changes are queued onto a single WorkspaceEdit so
 * they apply atomically.
 */
async function applyUIGradientEdit(
  uri: vscode.Uri,
  original: { aliasStart: number; fullEnd: number; propsBraceStart: number; propsBraceEnd: number },
  newColorStops: GradientStop[],
  newNumberStops: NumberStop[],
  newRotation: number
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  const call = findUIGradientCalls(text).find(
    (c) => c.aliasStart === original.aliasStart && c.fullEnd === original.fullEnd
  );
  if (!call) {
    void vscode.window.showWarningMessage(
      "Luix: couldn't relocate the UIGradient call to apply changes."
    );
    return;
  }
  const bodyStart = call.propsBraceStart + 1;
  const propsBody = text.slice(bodyStart, call.propsBraceEnd);
  const entries = extractPropEntriesFromDocument(
    text,
    bodyStart,
    call.propsBraceEnd
  );
  const { outerIndent, innerStep } = indentationFor(
    document,
    uri,
    call.aliasStart
  );
  // Each prop sits one indent level *inside* the table opening. We pass
  // outerIndent + innerStep to the sequence renderers so their multi-line
  // form (Color/Transparency keypoint arrays) lines up correctly.
  const propIndent = outerIndent + innerStep;
  const colorLiteral = renderColorSequence(
    newColorStops,
    propIndent,
    innerStep
  );
  const numberLiteral = renderNumberSequence(
    newNumberStops,
    propIndent,
    innerStep
  );
  const rotationLiteral = formatNum(newRotation);

  // Detect "default" UIGradient values. Writing these out is noise —
  // Roblox already applies them when the prop is absent. If the user
  // edited a prop to a default, DELETE the existing entry; if it
  // wasn't there to begin with, skip the insert entirely.
  const isDefaultColor =
    newColorStops.length === 2 &&
    newColorStops.every((s) => s.r === 1 && s.g === 1 && s.b === 1);
  const isDefaultTransparency =
    newNumberStops.length === 2 &&
    newNumberStops.every((s) => s.v === 0 && s.env === 0);
  const isDefaultRotation = newRotation === 0;

  let replacement: string;
  try {
    replacement = rewriteLiteralProps(propsBody, entries, [
      { key: "Color", value: colorLiteral, remove: isDefaultColor },
      { key: "Transparency", value: numberLiteral, remove: isDefaultTransparency },
      { key: "Rotation", value: rotationLiteral, remove: isDefaultRotation },
    ], propIndent);
  } catch (err) {
    void vscode.window.showWarningMessage(`Luix: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(
    document.positionAt(bodyStart), document.positionAt(call.propsBraceEnd)
  ), replacement);

  await vscode.workspace.applyEdit(edit);
}

function renderGradientWebviewHtml(): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Luix gradient editor</title>
<style>
  :root {
    color-scheme: dark light;
    --luix: #7C5CFF;
    --luix-soft: rgba(124, 92, 255, 0.18);
    --panel-bg: rgba(255, 255, 255, 0.03);
    --panel-border: rgba(255, 255, 255, 0.06);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 22px 26px;
    user-select: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
  }
  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    opacity: 0.78;
  }
  .badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--luix-soft);
    color: var(--luix);
    border: 1px solid rgba(124, 92, 255, 0.35);
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 22px;
    align-items: start;
  }
  body[data-mode="color"] .preview-col,
  body[data-mode="number"] .preview-col {
    display: none;
  }
  body[data-mode="color"] .layout,
  body[data-mode="number"] .layout {
    grid-template-columns: 1fr;
  }

  /* Sections — visible per mode */
  .section {
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 14px;
  }
  .section-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    opacity: 0.55;
    margin-bottom: 10px;
  }
  body[data-mode="color"] .number-section,
  body[data-mode="color"] .rotation-section { display: none; }
  body[data-mode="number"] .color-section,
  body[data-mode="number"] .rotation-section { display: none; }

  /* ---- Colour ramp ---- */
  .strip {
    position: relative;
    height: 42px;
    border-radius: 5px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    cursor: copy;
    touch-action: none;
    overflow: visible;
  }
  /* Hover indicator on the colour strip — a thin vertical line + a small
     pill label showing the t value at the cursor position. */
  .strip-hover {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 2px;
    background: rgba(255, 255, 255, 0.85);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
    transform: translateX(-50%);
    pointer-events: none;
    opacity: 0;
    transition: opacity 80ms ease;
  }
  .strip-hover.visible { opacity: 1; }
  .strip-hover-label {
    position: absolute;
    bottom: 100%;
    margin-bottom: 6px;
    padding: 2px 6px;
    background: var(--luix);
    color: #fff;
    font-size: 10.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    border-radius: 3px;
    transform: translateX(-50%);
    pointer-events: none;
    opacity: 0;
    transition: opacity 80ms ease;
    white-space: nowrap;
  }
  .strip-hover-label.visible { opacity: 1; }
  .rail {
    position: relative;
    height: 28px;
    margin-top: 8px;
  }
  /* Triangular colour stop — base on top pointing UP at the strip,
     matching Roblox Studio's ColorSequence editor. */
  .cstop {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 7px solid transparent;
    border-right: 7px solid transparent;
    border-bottom: 11px solid #fff;
    cursor: grab;
    filter: drop-shadow(0 1px 1px rgba(0,0,0,0.6));
    touch-action: none;
  }
  .cstop.selected {
    z-index: 2;
    border-bottom-color: var(--luix);
    transform: translateX(-50%) scale(1.18);
  }
  .cstop::after {
    /* Inner triangle showing the stop's actual colour */
    content: "";
    position: absolute;
    top: 3px;
    left: -4px;
    width: 0;
    height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-bottom: 7px solid var(--c, #fff);
  }
  .cstop.dragging { cursor: grabbing; }

  /* ---- Transparency / NumberSequence curve ---- */
  .curve-wrap {
    position: relative;
    width: 100%;
    height: 180px;
    background: rgba(0, 0, 0, 0.18);
    border-radius: 5px;
    overflow: hidden;
    cursor: copy;
    touch-action: none;
  }
  /* Crosshair indicator on the curve — shows where a new stop would land */
  .curve-hover-v, .curve-hover-h {
    position: absolute;
    background: rgba(255, 255, 255, 0.4);
    pointer-events: none;
    opacity: 0;
    transition: opacity 80ms ease;
  }
  .curve-hover-v { width: 1px; top: 0; bottom: 0; }
  .curve-hover-h { height: 1px; left: 0; right: 0; }
  .curve-hover-v.visible, .curve-hover-h.visible { opacity: 1; }
  .curve-hover-label {
    position: absolute;
    padding: 2px 6px;
    background: var(--luix);
    color: #fff;
    font-size: 10.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    border-radius: 3px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 80ms ease;
    white-space: nowrap;
    transform: translate(8px, 8px);
  }
  .curve-hover-label.visible { opacity: 1; }
  .curve-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .curve-stops {
    position: absolute;
    inset: 0;
  }
  .nstop {
    position: absolute;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid #fff;
    background: var(--luix);
    transform: translate(-50%, -50%);
    cursor: grab;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
    touch-action: none;
  }
  .nstop.selected {
    z-index: 2;
    width: 16px;
    height: 16px;
    border-width: 3px;
    box-shadow: 0 0 0 2px var(--luix), 0 1px 4px rgba(0,0,0,0.5);
  }
  .nstop.dragging { cursor: grabbing; }

  /* ---- Rotation slider ---- */
  .rotation-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 12px;
    align-items: center;
    font-size: 12px;
  }
  .rotation-row input[type="range"] {
    width: 100%;
    accent-color: var(--luix);
  }
  .rotation-row input[type="number"] {
    width: 56px;
  }

  /* ---- Preview square (uigradient only) ---- */
  .preview-col {
    width: 256px;
    position: sticky;
    top: 22px;
  }
  .preview-wrap {
    width: 256px;
    height: 256px;
    border-radius: 8px;
    overflow: hidden;
    background-image:
      linear-gradient(45deg, #2a2a2a 25%, transparent 25%),
      linear-gradient(-45deg, #2a2a2a 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #2a2a2a 75%),
      linear-gradient(-45deg, transparent 75%, #2a2a2a 75%);
    background-size: 14px 14px;
    background-position: 0 0, 0 7px, 7px -7px, -7px 0;
    background-color: #1d1d1d;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
  }
  .preview-svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .parent-row {
    margin-top: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    opacity: 0.7;
  }
  .parent-swatch {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
  }

  /* ---- Controls strip (Time / Color / Value / Envelope / Delete) ---- */
  .controls {
    display: flex;
    gap: 14px;
    align-items: center;
    flex-wrap: wrap;
    padding: 12px 16px;
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    margin-bottom: 14px;
  }
  .controls label {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 11.5px;
    opacity: 0.85;
  }
  input[type="color"] {
    width: 28px; height: 28px; padding: 0;
    border: none; background: none; cursor: pointer;
  }
  input[type="number"],
  input[type="text"][inputmode="decimal"],
  input[type="text"][inputmode="numeric"] {
    width: 64px;
    padding: 4px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
    user-select: text;
  }
  button {
    padding: 5px 11px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    font-size: 11.5px;
  }
  button.primary {
    background: var(--luix);
    color: #fff;
  }
  button:hover { filter: brightness(1.1); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ---- Code preview + actions ---- */
  .preview-code {
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.1));
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre;
    overflow-x: auto;
    color: var(--vscode-foreground);
    user-select: text;
    margin: 0 0 14px;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .hint {
    font-size: 10.5px;
    opacity: 0.55;
    margin-top: -6px;
    margin-bottom: 14px;
  }
</style>
</head>
<body data-mode="color">
<header>
  <h2 id="title">Editor</h2>
  <span class="badge" title="This feature is actively being worked on">Preview</span>
</header>

<div class="layout">
  <div class="editor-col">
    <section class="section color-section">
      <div class="section-label">Color</div>
      <div class="strip" id="strip">
        <div class="strip-hover" id="stripHover"></div>
        <span class="strip-hover-label" id="stripHoverLabel"></span>
      </div>
      <div class="rail" id="rail"></div>
    </section>

    <section class="section number-section">
      <div class="section-label">Transparency</div>
      <div class="curve-wrap" id="curveWrap">
        <svg class="curve-svg" id="curveSvg" viewBox="0 0 100 60" preserveAspectRatio="none"></svg>
        <div class="curve-stops" id="curveStops"></div>
        <div class="curve-hover-v" id="curveHoverV"></div>
        <div class="curve-hover-h" id="curveHoverH"></div>
        <span class="curve-hover-label" id="curveHoverLabel"></span>
      </div>
    </section>

    <section class="section rotation-section">
      <div class="section-label">Rotation</div>
      <div class="rotation-row">
        <input type="range" id="rotationSlider" min="-180" max="180" step="1" value="0"/>
        <input type="text" inputmode="numeric" id="rotationInput" value="0"/>
        <span style="opacity:0.5">°</span>
      </div>
    </section>

    <div class="controls" id="controls"></div>

    <div class="hint">
      Click to add · drag to move · scroll number fields to nudge · <strong>Shift</strong> = snap to 0.05 / coarser nudge
    </div>

    <pre class="preview-code" id="preview"></pre>

    <div class="actions">
      <button id="cancel">Cancel</button>
      <button class="primary" id="apply">Apply</button>
    </div>
  </div>

  <div class="preview-col">
    <div class="section-label">Preview</div>
    <div class="preview-wrap">
      <svg class="preview-svg" id="previewSvg" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
    </div>
    <div class="parent-row">
      <span class="parent-swatch" id="parentSwatch"></span>
      <span id="parentLabel">Parent color</span>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  /** @type {"color"|"number"|"uigradient"} */
  let mode = "color";
  /** @type {{t:number,r:number,g:number,b:number}[]} */
  let colorStops = [];
  /** @type {{t:number,v:number,env:number}[]} */
  let numberStops = [];
  let rotation = 0;
  let parentBg = { r: 1, g: 1, b: 1 };

  /** "color" | "number" — which channel the selection refers to */
  let selectedKind = "color";
  let selectedIdx = 0;

  /** @type {null | { kind: "color"|"number", idx: number, pointerId: number, startClientX: number, moved: boolean }} */
  let drag = null;

  const strip = document.getElementById("strip");
  const stripHover = document.getElementById("stripHover");
  const stripHoverLabel = document.getElementById("stripHoverLabel");
  const rail = document.getElementById("rail");
  const curveWrap = document.getElementById("curveWrap");
  const curveSvg = document.getElementById("curveSvg");
  const curveStops = document.getElementById("curveStops");
  const curveHoverV = document.getElementById("curveHoverV");
  const curveHoverH = document.getElementById("curveHoverH");
  const curveHoverLabel = document.getElementById("curveHoverLabel");
  const controls = document.getElementById("controls");
  const preview = document.getElementById("preview");
  const previewSvg = document.getElementById("previewSvg");
  const rotationSlider = document.getElementById("rotationSlider");
  const rotationInput = document.getElementById("rotationInput");
  const titleEl = document.getElementById("title");
  const parentSwatch = document.getElementById("parentSwatch");

  const clampT = (n) => Math.max(0, Math.min(1, n));
  const clampV = (n) => Math.max(0, Math.min(1, n));
  const formatNum = (n) =>
    Number.isInteger(n) ? String(n) : Number(n.toFixed(3)).toString();
  /** Snap a 0..1 number to nearest 0.05 when shift is held, else leave continuous. */
  const maybeSnap = (n, shift) => (shift ? Math.round(n * 20) / 20 : n);
  const rgbToHex = (r, g, b) => {
    const h = (n) => Math.round(n * 255).toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  };
  const hexToRgb = (hex) => {
    const v = hex.replace(/^#/, "");
    const n = parseInt(v, 16);
    return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
  };
  const color3Str = (s) =>
    "Color3.fromRGB(" + Math.round(s.r * 255) + ", " + Math.round(s.g * 255) + ", " + Math.round(s.b * 255) + ")";

  // --- Sampling ---
  function sampleColor(arr, t) {
    if (!arr || arr.length === 0) return { r: 1, g: 1, b: 1 };
    const sorted = [...arr].sort((a, b) => a.t - b.t);
    if (t <= sorted[0].t) return sorted[0];
    const last = sorted[sorted.length - 1];
    if (t >= last.t) return last;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (t >= a.t && t <= b.t) {
        const k = (t - a.t) / (b.t - a.t);
        return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k };
      }
    }
    return last;
  }
  function sampleValue(arr, t) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a.t - b.t);
    if (t <= sorted[0].t) return sorted[0].v;
    const last = sorted[sorted.length - 1];
    if (t >= last.t) return last.v;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      if (t >= a.t && t <= b.t) {
        const k = (t - a.t) / (b.t - a.t);
        return a.v + (b.v - a.v) * k;
      }
    }
    return last.v;
  }

  // --- Strip (color band) ---
  function paintStrip() {
    if (mode === "number") return;
    const sorted = [...colorStops].sort((a, b) => a.t - b.t);
    const parts = sorted.map(
      (s) => "rgb(" + Math.round(s.r * 255) + "," + Math.round(s.g * 255) + "," + Math.round(s.b * 255) + ") " + (s.t * 100).toFixed(2) + "%"
    );
    strip.style.background = "linear-gradient(to right, " + parts.join(", ") + ")";
  }

  function paintColorStops() {
    if (mode === "number") return;
    const existing = Array.from(rail.children);
    while (existing.length > colorStops.length) rail.removeChild(existing.pop());
    colorStops.forEach((s, i) => {
      let el = existing[i];
      if (!el) {
        el = document.createElement("div");
        el.addEventListener("pointerdown", (ev) => onStopDown(ev, "color", i));
        rail.appendChild(el);
      }
      el.dataset.idx = String(i);
      el.className = "cstop" +
        (selectedKind === "color" && selectedIdx === i ? " selected" : "") +
        (drag && drag.kind === "color" && drag.idx === i ? " dragging" : "");
      el.style.left = (s.t * 100).toFixed(2) + "%";
      el.style.setProperty("--c",
        "rgb(" + Math.round(s.r * 255) + "," + Math.round(s.g * 255) + "," + Math.round(s.b * 255) + ")"
      );
    });
  }

  // --- Curve (number sequence) ---
  function paintCurve() {
    if (mode === "color") return;
    const sorted = [...numberStops].sort((a, b) => a.t - b.t);
    // Build grid + polyline
    const gridLines = [];
    for (let i = 1; i < 10; i++) {
      gridLines.push('<line x1="' + (i * 10) + '" y1="0" x2="' + (i * 10) + '" y2="60" stroke="rgba(255,255,255,0.05)" stroke-width="0.3"/>');
    }
    for (let i = 1; i < 6; i++) {
      gridLines.push('<line x1="0" y1="' + (i * 10) + '" x2="100" y2="' + (i * 10) + '" stroke="rgba(255,255,255,0.05)" stroke-width="0.3"/>');
    }
    const pts = sorted.map((s) => (s.t * 100).toFixed(2) + "," + (s.v * 60).toFixed(2)).join(" ");
    // Envelope shading: vertical band from (v-env) to (v+env) at each stop, connected
    let envelopePoly = "";
    if (sorted.some((s) => s.env > 0)) {
      const upper = sorted.map((s) => (s.t * 100).toFixed(2) + "," + (clampV(s.v - s.env) * 60).toFixed(2));
      const lower = sorted.map((s) => (s.t * 100).toFixed(2) + "," + (clampV(s.v + s.env) * 60).toFixed(2)).reverse();
      envelopePoly = '<polygon points="' + upper.concat(lower).join(" ") + '" fill="rgba(124,92,255,0.18)" stroke="none"/>';
    }
    curveSvg.innerHTML =
      gridLines.join("") +
      envelopePoly +
      '<polyline points="' + pts + '" fill="none" stroke="#7C5CFF" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  function paintNumberStops() {
    if (mode === "color") return;
    const existing = Array.from(curveStops.children);
    while (existing.length > numberStops.length) curveStops.removeChild(existing.pop());
    numberStops.forEach((s, i) => {
      let el = existing[i];
      if (!el) {
        el = document.createElement("div");
        el.addEventListener("pointerdown", (ev) => onStopDown(ev, "number", i));
        curveStops.appendChild(el);
      }
      el.dataset.idx = String(i);
      el.className = "nstop" +
        (selectedKind === "number" && selectedIdx === i ? " selected" : "") +
        (drag && drag.kind === "number" && drag.idx === i ? " dragging" : "");
      el.style.left = (s.t * 100).toFixed(2) + "%";
      el.style.top = (s.v * 100).toFixed(2) + "%";
    });
  }

  // --- Controls (Time / Color / Value / Envelope / Delete) ---
  // Block any keypress / paste that would put a non-numeric character
  // into a numeric text field. Caller decides whether negatives or
  // decimals are allowed via the allowedChar regex. We also enforce a
  // maxlength here so the user can't type a 30-digit number.
  function attachNumericFilter(el, allowedChar, maxLen) {
    el.setAttribute("maxlength", String(maxLen));
    el.addEventListener("beforeinput", (ev) => {
      if (!ev.data) return; // deletion, navigation, etc.
      // Reject if any char in the inserted text isn't allowed.
      for (const ch of ev.data) {
        if (!allowedChar.test(ch)) {
          ev.preventDefault();
          return;
        }
      }
    });
    // Drop any forbidden chars that slip past (e.g. from undo/redo).
    el.addEventListener("input", () => {
      const cleaned = el.value
        .split("")
        .filter((ch) => allowedChar.test(ch))
        .join("");
      if (cleaned !== el.value) el.value = cleaned;
    });
  }

  // Wire a text input to scroll-wheel and arrow-key stepping. We use
  // type="text" instead of type="number" for these fields so the display
  // always uses "." regardless of OS locale — at the cost of losing the
  // native up/down arrow stepping, which this helper replaces.
  function attachScroll(el, step, onCommit) {
    const apply = (dir, shift) => {
      const useStep = shift ? step * 5 : step;
      const cur = Number(el.value.replace(",", ".")) || 0;
      const next = cur + dir * useStep;
      el.value = next.toFixed(3);
      onCommit(next);
    };
    el.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      apply(ev.deltaY > 0 ? -1 : 1, ev.shiftKey);
    }, { passive: false });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        apply(1, ev.shiftKey);
      } else if (ev.key === "ArrowDown") {
        ev.preventDefault();
        apply(-1, ev.shiftKey);
      }
    });
  }

  // Key identifying the CURRENT controls structure. We only rebuild
  // controls.innerHTML when this key changes (different stop kind or
  // different selected index). Otherwise the existing inputs get their
  // values updated in place — that preserves focus + caret position so
  // pressing ArrowUp/ArrowDown multiple times in a row works, and the
  // input doesn't blink while you type.
  let lastControlsKey = "";

  function paintControls() {
    const arr = selectedKind === "color" ? colorStops : numberStops;
    if (
      (selectedKind === "color" && mode === "number") ||
      (selectedKind === "number" && mode === "color")
    ) {
      controls.innerHTML = "";
      lastControlsKey = "";
      return;
    }
    const s = arr[selectedIdx];
    if (!s) {
      controls.innerHTML = "";
      lastControlsKey = "";
      return;
    }
    const key = selectedKind + "|" + selectedIdx + "|" + arr.length;
    if (key === lastControlsKey) {
      // Same structure — just refresh field values for fields the user
      // isn't actively editing. This is what keeps focus stable.
      const updateText = (id, value) => {
        const el = document.getElementById(id);
        if (el && document.activeElement !== el) el.value = value;
      };
      if (selectedKind === "color") {
        updateText("cTime", s.t.toFixed(3));
        const cColor = document.getElementById("cColor");
        if (cColor && document.activeElement !== cColor) {
          cColor.value = rgbToHex(s.r, s.g, s.b);
        }
      } else {
        updateText("nTime", s.t.toFixed(3));
        updateText("nValue", s.v.toFixed(3));
        updateText("nEnv", s.env.toFixed(3));
      }
      return;
    }
    lastControlsKey = key;

    // Use type=text + inputmode=decimal instead of type=number. Browsers
    // format type=number values using the OS locale even with lang=en
    // (so EU systems display "0,5" regardless), and there's no portable
    // way to override that. Text inputs leave our value string alone.
    let html = "";
    if (selectedKind === "color") {
      html =
        '<label>Time <input type="text" inputmode="decimal" id="cTime" value="' + s.t.toFixed(3) + '"/></label>' +
        '<label>Color <input type="color" id="cColor" value="' + rgbToHex(s.r, s.g, s.b) + '"/></label>' +
        '<button id="cDel"' + (colorStops.length <= 2 ? " disabled" : "") + '>Delete stop</button>';
    } else {
      html =
        '<label>Time <input type="text" inputmode="decimal" id="nTime" value="' + s.t.toFixed(3) + '"/></label>' +
        '<label>Value <input type="text" inputmode="decimal" id="nValue" value="' + s.v.toFixed(3) + '"/></label>' +
        '<label title="Per-stop randomness — Roblox picks a random number within ±Envelope of Value at runtime. Leave at 0 for a deterministic curve."' +
        '>Envelope <input type="text" inputmode="decimal" id="nEnv" value="' + s.env.toFixed(3) + '"/></label>' +
        '<button id="nDel"' + (numberStops.length <= 2 ? " disabled" : "") + '>Delete stop</button>';
    }
    controls.innerHTML = html;

    const cTime = document.getElementById("cTime");
    const cColor = document.getElementById("cColor");
    const cDel = document.getElementById("cDel");
    const nTime = document.getElementById("nTime");
    const nValue = document.getElementById("nValue");
    const nEnv = document.getElementById("nEnv");
    const nDel = document.getElementById("nDel");

    // Allowed-char regex for unsigned decimals (Time / Value / Envelope).
    const unsignedDecimal = /[0-9.]/;
    const maxDecLen = 6; // "0.0001" or "-0.001"
    // Revert helper: on blur, restore the input from the model so any
    // unparseable junk vanishes and the formatting is normalised.
    const wireField = (el, read, commit, allowed, maxLen) => {
      attachNumericFilter(el, allowed, maxLen);
      el.addEventListener("input", () => {
        const v = Number(el.value.replace(",", "."));
        if (!Number.isFinite(v)) return;
        commit(v);
        // Don't trigger paintControls' value-overwrite — paint() does that
        // and our updateText() check (activeElement !== el) keeps the text.
        paint();
      });
      el.addEventListener("blur", () => {
        // If invalid (e.g. user typed just "." or "-"), snap back to the
        // last good value from the model.
        const v = Number(el.value.replace(",", "."));
        if (!Number.isFinite(v)) {
          el.value = read();
        } else {
          el.value = read();
        }
      });
    };

    if (cTime) {
      wireField(
        cTime,
        () => colorStops[selectedIdx].t.toFixed(3),
        (v) => { colorStops[selectedIdx].t = clampT(v); },
        unsignedDecimal,
        maxDecLen
      );
      attachScroll(cTime, 0.01, (v) => {
        colorStops[selectedIdx].t = clampT(v);
        paint();
      });
    }
    if (cColor) cColor.addEventListener("input", () => {
      Object.assign(colorStops[selectedIdx], hexToRgb(cColor.value));
      paint();
    });
    if (cDel) cDel.addEventListener("click", () => {
      if (colorStops.length <= 2) return;
      colorStops.splice(selectedIdx, 1);
      selectedIdx = Math.min(selectedIdx, colorStops.length - 1);
      paint();
    });
    if (nTime) {
      wireField(
        nTime,
        () => numberStops[selectedIdx].t.toFixed(3),
        (v) => { numberStops[selectedIdx].t = clampT(v); },
        unsignedDecimal,
        maxDecLen
      );
      attachScroll(nTime, 0.01, (v) => {
        numberStops[selectedIdx].t = clampT(v);
        paint();
      });
    }
    if (nValue) {
      wireField(
        nValue,
        () => numberStops[selectedIdx].v.toFixed(3),
        (v) => { numberStops[selectedIdx].v = clampV(v); },
        unsignedDecimal,
        maxDecLen
      );
      attachScroll(nValue, 0.01, (v) => {
        numberStops[selectedIdx].v = clampV(v);
        paint();
      });
    }
    if (nEnv) {
      wireField(
        nEnv,
        () => numberStops[selectedIdx].env.toFixed(3),
        (v) => { numberStops[selectedIdx].env = Math.max(0, v); },
        unsignedDecimal,
        maxDecLen
      );
      attachScroll(nEnv, 0.01, (v) => {
        numberStops[selectedIdx].env = Math.max(0, v);
        paint();
      });
    }
    if (nDel) nDel.addEventListener("click", () => {
      if (numberStops.length <= 2) return;
      numberStops.splice(selectedIdx, 1);
      selectedIdx = Math.min(selectedIdx, numberStops.length - 1);
      paint();
    });
  }

  // --- Preview square ---
  function paintPreview() {
    if (mode !== "uigradient") {
      previewSvg.innerHTML = "";
      return;
    }
    const tSet = new Set();
    colorStops.forEach((s) => tSet.add(s.t));
    numberStops.forEach((s) => tSet.add(s.t));
    const ts = [...tSet].sort((a, b) => a - b);
    if (ts.length === 0 || ts[0] !== 0) ts.unshift(0);
    if (ts[ts.length - 1] !== 1) ts.push(1);

    // Multiply gradient colour by parent BG (Roblox semantics).
    const bg = parentBg;
    const stopsXml = ts.map((t) => {
      const c = sampleColor(colorStops, t);
      const op = clampV(1 - sampleValue(numberStops, t));
      const r = Math.round(c.r * bg.r * 255);
      const g = Math.round(c.g * bg.g * 255);
      const b = Math.round(c.b * bg.b * 255);
      return '<stop offset="' + (t * 100).toFixed(2) + '%" stop-color="rgb(' + r + ',' + g + ',' + b + ')" stop-opacity="' + op.toFixed(3) + '"/>';
    }).join("");

    const angle = Number.isFinite(rotation) ? rotation : 0;
    previewSvg.innerHTML =
      '<defs><linearGradient id="g" x1="0" y1="0.5" x2="1" y2="0.5" ' +
        'gradientUnits="objectBoundingBox" gradientTransform="rotate(' + angle + ' 0.5 0.5)">' +
        stopsXml +
      '</linearGradient></defs>' +
      '<rect width="100" height="100" fill="url(#g)"/>';
  }

  function paintCode() {
    if (mode === "color") {
      preview.textContent = renderColorSequenceJS(colorStops);
    } else if (mode === "number") {
      preview.textContent = renderNumberSequenceJS(numberStops);
    } else {
      // UIGradient — only show props that aren't at Roblox defaults, to
      // match the write-back behaviour. Otherwise the preview pretends
      // it'll emit a line that Apply would actually delete.
      const isDefColor = colorStops.length === 2 &&
        colorStops.every((s) => s.r === 1 && s.g === 1 && s.b === 1);
      const isDefTrans = numberStops.length === 2 &&
        numberStops.every((s) => s.v === 0 && s.env === 0);
      const isDefRot = rotation === 0;
      const lines = [];
      if (!isDefColor) lines.push('Color = ' + renderColorSequenceJS(colorStops) + ',');
      if (!isDefTrans) lines.push('Transparency = ' + renderNumberSequenceJS(numberStops) + ',');
      if (!isDefRot) lines.push('Rotation = ' + formatNum(rotation) + ',');
      preview.textContent = lines.length === 0
        ? '-- (all defaults — nothing will be written)'
        : lines.join('\\n');
    }
  }

  function renderColorSequenceJS(stops) {
    const sorted = [...stops].sort((a, b) => a.t - b.t);
    if (sorted.length === 2 && sorted[0].t === 0 && sorted[1].t === 1
      && sorted[0].r === sorted[1].r && sorted[0].g === sorted[1].g && sorted[0].b === sorted[1].b) {
      return "ColorSequence.new(" + color3Str(sorted[0]) + ")";
    }
    if (sorted.length === 2 && sorted[0].t === 0 && sorted[1].t === 1) {
      return "ColorSequence.new(" + color3Str(sorted[0]) + ", " + color3Str(sorted[1]) + ")";
    }
    const lines = sorted.map((s) => "\\tColorSequenceKeypoint.new(" + formatNum(s.t) + ", " + color3Str(s) + "),");
    return "ColorSequence.new({\\n" + lines.join("\\n") + "\\n})";
  }
  function renderNumberSequenceJS(stops) {
    const sorted = [...stops].sort((a, b) => a.t - b.t);
    const noEnv = sorted.every((s) => s.env === 0);
    if (sorted.length === 2 && sorted[0].t === 0 && sorted[1].t === 1 && noEnv && sorted[0].v === sorted[1].v) {
      return "NumberSequence.new(" + formatNum(sorted[0].v) + ")";
    }
    if (sorted.length === 2 && sorted[0].t === 0 && sorted[1].t === 1 && noEnv) {
      return "NumberSequence.new(" + formatNum(sorted[0].v) + ", " + formatNum(sorted[1].v) + ")";
    }
    const lines = sorted.map((s) => {
      const tail = s.env === 0
        ? formatNum(s.t) + ", " + formatNum(s.v)
        : formatNum(s.t) + ", " + formatNum(s.v) + ", " + formatNum(s.env);
      return "\\tNumberSequenceKeypoint.new(" + tail + "),";
    });
    return "NumberSequence.new({\\n" + lines.join("\\n") + "\\n})";
  }

  function paint() {
    paintStrip();
    paintColorStops();
    paintCurve();
    paintNumberStops();
    paintControls();
    paintPreview();
    paintCode();
  }

  // --- Drag handling (shared for both stop kinds) ---
  function onStopDown(ev, kind, idx) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    selectedKind = kind;
    selectedIdx = idx;
    drag = { kind, idx, pointerId: ev.pointerId, startClientX: ev.clientX, moved: false };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) {}
    ev.currentTarget.addEventListener("pointermove", onStopMove);
    ev.currentTarget.addEventListener("pointerup", onStopEnd);
    ev.currentTarget.addEventListener("pointercancel", onStopEnd);
    paint();
  }
  function onStopMove(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    if (Math.abs(ev.clientX - drag.startClientX) > 1) drag.moved = true;
    if (drag.kind === "color") {
      const rect = strip.getBoundingClientRect();
      colorStops[drag.idx].t = maybeSnap(
        clampT((ev.clientX - rect.left) / rect.width),
        ev.shiftKey
      );
    } else {
      const rect = curveWrap.getBoundingClientRect();
      numberStops[drag.idx].t = maybeSnap(
        clampT((ev.clientX - rect.left) / rect.width),
        ev.shiftKey
      );
      numberStops[drag.idx].v = maybeSnap(
        clampV((ev.clientY - rect.top) / rect.height),
        ev.shiftKey
      );
    }
    paint();
  }
  function onStopEnd(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (e) {}
    ev.currentTarget.removeEventListener("pointermove", onStopMove);
    ev.currentTarget.removeEventListener("pointerup", onStopEnd);
    ev.currentTarget.removeEventListener("pointercancel", onStopEnd);
    drag = null;
    paint();
  }

  // --- Click-to-add stop on the strip ---
  strip.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const rect = strip.getBoundingClientRect();
    const t = maybeSnap(clampT((ev.clientX - rect.left) / rect.width), ev.shiftKey);
    const c = sampleColor(colorStops, t);
    colorStops.push({ t, r: c.r, g: c.g, b: c.b });
    selectedKind = "color";
    selectedIdx = colorStops.length - 1;
    paint();
    const newEl = rail.lastElementChild;
    if (!newEl) return;
    drag = { kind: "color", idx: selectedIdx, pointerId: ev.pointerId, startClientX: ev.clientX, moved: false };
    try { newEl.setPointerCapture(ev.pointerId); } catch (e) {}
    newEl.addEventListener("pointermove", onStopMove);
    newEl.addEventListener("pointerup", onStopEnd);
    newEl.addEventListener("pointercancel", onStopEnd);
  });

  // --- Hover indicator on the strip ---
  strip.addEventListener("pointermove", (ev) => {
    if (drag) return; // suppressed while dragging — the stop itself is the indicator
    const rect = strip.getBoundingClientRect();
    const t = maybeSnap(clampT((ev.clientX - rect.left) / rect.width), ev.shiftKey);
    const pct = (t * 100).toFixed(2) + "%";
    stripHover.style.left = pct;
    stripHoverLabel.style.left = pct;
    stripHoverLabel.textContent = t.toFixed(3);
    stripHover.classList.add("visible");
    stripHoverLabel.classList.add("visible");
  });
  strip.addEventListener("pointerleave", () => {
    stripHover.classList.remove("visible");
    stripHoverLabel.classList.remove("visible");
  });

  // --- Click-to-add stop on the curve ---
  curveWrap.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const rect = curveWrap.getBoundingClientRect();
    const t = maybeSnap(clampT((ev.clientX - rect.left) / rect.width), ev.shiftKey);
    const v = maybeSnap(clampV((ev.clientY - rect.top) / rect.height), ev.shiftKey);
    numberStops.push({ t, v, env: 0 });
    selectedKind = "number";
    selectedIdx = numberStops.length - 1;
    paint();
    const newEl = curveStops.lastElementChild;
    if (!newEl) return;
    drag = { kind: "number", idx: selectedIdx, pointerId: ev.pointerId, startClientX: ev.clientX, moved: false };
    try { newEl.setPointerCapture(ev.pointerId); } catch (e) {}
    newEl.addEventListener("pointermove", onStopMove);
    newEl.addEventListener("pointerup", onStopEnd);
    newEl.addEventListener("pointercancel", onStopEnd);
  });

  // --- Hover crosshair on the curve ---
  curveWrap.addEventListener("pointermove", (ev) => {
    if (drag) return;
    const rect = curveWrap.getBoundingClientRect();
    const t = maybeSnap(clampT((ev.clientX - rect.left) / rect.width), ev.shiftKey);
    const v = maybeSnap(clampV((ev.clientY - rect.top) / rect.height), ev.shiftKey);
    const pxX = (t * rect.width).toFixed(2);
    const pxY = (v * rect.height).toFixed(2);
    curveHoverV.style.left = pxX + "px";
    curveHoverH.style.top = pxY + "px";
    curveHoverLabel.style.left = pxX + "px";
    curveHoverLabel.style.top = pxY + "px";
    curveHoverLabel.textContent = "t=" + t.toFixed(3) + "  v=" + v.toFixed(3);
    curveHoverV.classList.add("visible");
    curveHoverH.classList.add("visible");
    curveHoverLabel.classList.add("visible");
  });
  curveWrap.addEventListener("pointerleave", () => {
    curveHoverV.classList.remove("visible");
    curveHoverH.classList.remove("visible");
    curveHoverLabel.classList.remove("visible");
  });

  // --- Rotation ---
  function setRotation(deg) {
    rotation = Math.max(-180, Math.min(180, Math.round(deg)));
    if (document.activeElement !== rotationSlider) rotationSlider.value = String(rotation);
    if (document.activeElement !== rotationInput) rotationInput.value = String(rotation);
    paintPreview();
    paintCode();
  }
  rotationSlider.addEventListener("input", () => setRotation(Number(rotationSlider.value)));
  // Rotation accepts a leading minus plus digits (-180..180). 4-char max.
  attachNumericFilter(rotationInput, /[0-9-]/, 4);
  rotationInput.addEventListener("input", () => {
    const v = Number(rotationInput.value.replace(",", "."));
    if (Number.isFinite(v)) setRotation(v);
  });
  rotationInput.addEventListener("blur", () => {
    rotationInput.value = String(rotation);
  });
  // Wheel/Arrow stepping for the rotation field. Step = 1°, Shift = 15°.
  rotationInput.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const dir = ev.deltaY > 0 ? -1 : 1;
    const step = ev.shiftKey ? 15 : 1;
    setRotation(rotation + dir * step);
  }, { passive: false });
  rotationInput.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setRotation(rotation + (ev.shiftKey ? 15 : 1));
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setRotation(rotation - (ev.shiftKey ? 15 : 1));
    }
  });

  // --- Actions ---
  document.getElementById("apply").addEventListener("click", () => {
    vscode.postMessage({
      type: "apply",
      colorStops, numberStops, rotation,
    });
  });
  document.getElementById("cancel").addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });

  // --- Keyboard ---
  window.addEventListener("keydown", (ev) => {
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const arr = selectedKind === "color" ? colorStops : numberStops;
    const s = arr[selectedIdx];
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      if (!s) return;
      const step = ev.shiftKey ? 0.05 : 0.01;
      s.t = clampT(s.t + (ev.key === "ArrowRight" ? step : -step));
      paint();
      ev.preventDefault();
    } else if (ev.key === "Tab") {
      if (arr.length === 0) return;
      const delta = ev.shiftKey ? -1 : 1;
      selectedIdx = (selectedIdx + delta + arr.length) % arr.length;
      paint();
      ev.preventDefault();
    } else if (ev.key === "Delete" || ev.key === "Backspace") {
      if (arr.length <= 2) return;
      arr.splice(selectedIdx, 1);
      selectedIdx = Math.min(selectedIdx, arr.length - 1);
      paint();
      ev.preventDefault();
    } else if (ev.key === "Enter") {
      vscode.postMessage({ type: "apply", colorStops, numberStops, rotation });
      ev.preventDefault();
    } else if (ev.key === "Escape") {
      vscode.postMessage({ type: "cancel" });
      ev.preventDefault();
    }
  });

  // --- Init ---
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg?.type !== "init") return;
    mode = msg.mode || "color";
    colorStops = (msg.colorStops || []).map((s) => Object.assign({}, s));
    numberStops = (msg.numberStops || []).map((s) => Object.assign({}, s));
    rotation = msg.rotation || 0;
    parentBg = msg.parentBg || { r: 1, g: 1, b: 1 };

    document.body.dataset.mode = mode;
    titleEl.textContent = mode === "color"
      ? "ColorSequence editor"
      : mode === "number"
        ? "NumberSequence editor"
        : "UIGradient editor";

    // Default selection per mode
    if (mode === "color") {
      selectedKind = "color";
    } else if (mode === "number") {
      selectedKind = "number";
    } else {
      selectedKind = "color";
    }
    selectedIdx = 0;

    rotationSlider.value = String(rotation);
    rotationInput.value = String(rotation);

    parentSwatch.style.background = "rgb(" +
      Math.round(parentBg.r * 255) + "," +
      Math.round(parentBg.g * 255) + "," +
      Math.round(parentBg.b * 255) + ")";

    paint();
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
