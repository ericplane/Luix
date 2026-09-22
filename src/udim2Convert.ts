import * as vscode from "vscode";
import {
  CreateElementCall,
  extractPropEntriesFromDocument,
  findAllCreateElementCalls,
} from "./parser";
import { getAliasPartition } from "./frameworks";

// ============================================================================
// UDim2 fromScale ↔ fromOffset conversion
// ============================================================================
//
// When the cursor sits on a `UDim2.fromScale(sx, sy)` or
// `UDim2.fromOffset(ox, oy)` literal that lives inside an element's
// `Size = …` prop, offer a refactor action that flips the form by
// walking up the parent element chain in source order until we hit a
// concrete pixel size, then multiplying / dividing through the
// accumulated scales.
//
// Example (cursor on the innermost `fromScale`):
//
//   e("Frame", { Size = UDim2.fromOffset(800, 600) }, {
//     e("Frame", { Size = UDim2.fromScale(0.5, 0.5) }, {
//       e("Frame", { Size = UDim2.fromScale(1, 0.15) })  ← cursor
//     })
//   })
//
//   Parent chain pixel size: 800 × 600 × 0.5 × 0.5 = 400 × 300.
//   Converted: UDim2.fromOffset(400, 45).
//
// Limitations:
//
//   - We only resolve when every link in the chain is a pure literal
//     (`UDim2.fromScale(…)`, `UDim2.fromOffset(…)`, or the pure-axis
//     forms of `UDim2.new(…)`). A mixed-axis `UDim2.new(0.5, 10, …)`
//     or a non-literal `Size = props.something` breaks the chain and
//     the action stays hidden — better than emitting a wrong value.
//   - We don't follow `UIAspectRatioConstraint`, `UISizeConstraint`,
//     `UIPadding`, or `AutomaticSize`. Layout primitives can warp
//     effective sizes in ways we can't deduce statically.
//   - Calls without a literal `Size` prop on every ancestor (or
//     calls at the top of a component with no parent in source) are
//     skipped — there's no anchor to derive a pixel size from.

interface UDim2Value {
  /** Pure scale and offset components for each axis. UDim2.fromScale
   *  has the offsets at 0; UDim2.fromOffset has the scales at 0;
   *  UDim2.new can mix. */
  sx: number;
  ox: number;
  sy: number;
  oy: number;
}

interface UDim2Literal {
  value: UDim2Value;
  /** The constructor form the user typed. */
  form: "fromScale" | "fromOffset" | "new";
  /** Document offset of `U` in `UDim2.…`. */
  start: number;
  /** Document offset just past the closing `)`. */
  end: number;
}

const UDIM2_LITERAL_RE =
  /UDim2\.(fromScale|fromOffset|new)\s*\(([^()]*)\)/g;

function parseUDim2Args(
  argsText: string,
  form: "fromScale" | "fromOffset" | "new"
): UDim2Value | undefined {
  const parts = argsText.split(",").map((s) => Number(s.trim()));
  if (parts.some((n) => !Number.isFinite(n))) {return undefined;}
  switch (form) {
    case "fromScale":
      if (parts.length !== 2) {return undefined;}
      return { sx: parts[0], ox: 0, sy: parts[1], oy: 0 };
    case "fromOffset":
      if (parts.length !== 2) {return undefined;}
      return { sx: 0, ox: parts[0], sy: 0, oy: parts[1] };
    case "new":
      if (parts.length !== 4) {return undefined;}
      return { sx: parts[0], ox: parts[1], sy: parts[2], oy: parts[3] };
  }
}

/**
 * Returns the UDim2 literal at the cursor offset, or undefined when
 * the cursor isn't on one. Uses a fresh regex per call so multiple
 * code-action invocations don't share lastIndex state.
 */
function findUDim2LiteralAt(
  text: string,
  offset: number
): UDim2Literal | undefined {
  const re = new RegExp(UDIM2_LITERAL_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index <= offset && offset <= m.index + m[0].length) {
      const form = m[1] as "fromScale" | "fromOffset" | "new";
      const value = parseUDim2Args(m[2], form);
      if (!value) {return undefined;}
      return { value, form, start: m.index, end: m.index + m[0].length };
    }
  }
  return undefined;
}

/** Smallest createElement call whose `[aliasStart, fullEnd]` range
 *  contains `offset`. */
function findEnclosingCall(
  calls: readonly CreateElementCall[],
  offset: number
): CreateElementCall | undefined {
  let best: CreateElementCall | undefined;
  let bestSize = Infinity;
  for (const c of calls) {
    if (c.aliasStart <= offset && offset <= c.fullEnd) {
      const size = c.fullEnd - c.aliasStart;
      if (size < bestSize) {
        best = c;
        bestSize = size;
      }
    }
  }
  return best;
}

/** Smallest other call whose body strictly contains `child`'s body. */
function findParentCall(
  calls: readonly CreateElementCall[],
  child: CreateElementCall
): CreateElementCall | undefined {
  let best: CreateElementCall | undefined;
  let bestSize = Infinity;
  for (const c of calls) {
    if (c === child) {continue;}
    if (c.aliasStart < child.aliasStart && child.fullEnd < c.fullEnd) {
      const size = c.fullEnd - c.aliasStart;
      if (size < bestSize) {
        best = c;
        bestSize = size;
      }
    }
  }
  return best;
}

/** Extract the `Size` prop's value as a UDim2 literal, if it's a
 *  recognised form. Non-literal values (`Size = props.x`) return
 *  undefined and break the resolution chain. */
function getSizeOf(
  call: CreateElementCall,
  text: string
): UDim2Value | undefined {
  if (
    call.propsBraceStart === undefined ||
    call.propsBraceEnd === undefined
  ) {
    return undefined;
  }
  const entries = extractPropEntriesFromDocument(
    text,
    call.propsBraceStart + 1,
    call.propsBraceEnd
  );
  const entry = entries.find((e) => e.key === "Size");
  if (!entry) {return undefined;}
  const valueText = text
    .slice(
      call.propsBraceStart + 1 + entry.valueStart,
      call.propsBraceStart + 1 + entry.valueEnd
    )
    .trim();
  // 1) Direct literal — `UDim2.fromScale(...)` / `UDim2.fromOffset(...)` /
  //    `UDim2.new(...)`.
  const direct = /^UDim2\.(fromScale|fromOffset|new)\s*\(([^()]*)\)/.exec(
    valueText
  );
  if (direct) {
    return parseUDim2Args(
      direct[2],
      direct[1] as "fromScale" | "fromOffset" | "new"
    );
  }
  // 2) Reactive binding — `<expr>:map(function(s) return
  //    UDim2.fromOffset(460 * s, 360 * s) end)`. Pulls the leading
  //    numeric coefficient out of each axis. This matches the
  //    canonical Vide / Charm / Ripple "scale-by-binding" idiom and
  //    keeps the conversion meaningful when the parent's Size is
  //    animated rather than a static literal.
  return parseMappedFromOffset(valueText);
}

/**
 * Detect `<expr>:map(function(<args>) return UDim2.fromOffset(<X>,
 * <Y>) end)` and pull the numeric coefficient out of each axis. Each
 * axis expression has to be one of these strict shapes for us to
 * trust the value (otherwise we'd be guessing):
 *
 *   - `<NUM>`                    e.g. `460`
 *   - `<NUM> * <IDENT>`          e.g. `460 * s`
 *   - `<IDENT> * <NUM>`          e.g. `s * 460`
 *
 * Anything more elaborate (`460 + bonus`, `clamp(s, …) * 460`, …)
 * gets `undefined` so the caller skips that ancestor rather than
 * picking a number that might be wrong.
 */
function parseMappedFromOffset(valueText: string): UDim2Value | undefined {
  const m =
    /:\s*map\s*\(\s*function\s*\([^)]*\)\s*return\s+UDim2\.fromOffset\s*\(([^,]+),\s*([^)]+)\)\s*end\s*\)/.exec(
      valueText
    );
  if (!m) {return undefined;}
  const x = extractAxisCoefficient(m[1]);
  const y = extractAxisCoefficient(m[2]);
  if (x === undefined || y === undefined) {return undefined;}
  return { sx: 0, ox: x, sy: 0, oy: y };
}

function extractAxisCoefficient(expr: string): number | undefined {
  const t = expr.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) {return Number(t);}
  const numFirst = /^(-?\d+(?:\.\d+)?)\s*\*\s*[A-Za-z_]\w*$/.exec(t);
  if (numFirst) {return Number(numFirst[1]);}
  const numLast = /^[A-Za-z_]\w*\s*\*\s*(-?\d+(?:\.\d+)?)$/.exec(t);
  if (numLast) {return Number(numLast[1]);}
  return undefined;
}

/** Walk the parent chain starting from `call` and resolve to a pure
 *  pixel size (ignoring any layout primitives). Returns undefined if
 *  any ancestor mixes scale + offset on the same axis, has no literal
 *  Size, or the chain reaches a top-level element with no parent. */
function computePixelSize(
  call: CreateElementCall,
  calls: readonly CreateElementCall[],
  text: string
): { x: number; y: number } | undefined {
  let cumSx = 1;
  let cumSy = 1;
  let current: CreateElementCall | undefined = call;
  // Soft cap on chain depth — UI trees rarely exceed 20-30 levels;
  // 64 is far above that and guards against pathological inputs.
  for (let depth = 0; depth < 64 && current; depth++) {
    const size = getSizeOf(current, text);
    if (!size) {return undefined;}
    // Pure offset → we have a concrete pixel size to anchor on.
    if (size.sx === 0 && size.sy === 0) {
      return { x: cumSx * size.ox, y: cumSy * size.oy };
    }
    // Pure scale → propagate up.
    if (size.ox === 0 && size.oy === 0) {
      cumSx *= size.sx;
      cumSy *= size.sy;
      current = findParentCall(calls, current);
      continue;
    }
    // Mixed (UDim2.new with both scale + offset on the same axis) —
    // can't resolve without knowing the actual pixel size of the
    // surrounding container, which we don't have access to statically.
    return undefined;
  }
  return undefined;
}

/** Pretty-print a number for the replacement text: rounded to 3
 *  decimals, trailing zeros trimmed, integer-valued numbers printed
 *  without a decimal point. */
function fmt(n: number): string {
  const rounded = Math.round(n * 1000) / 1000;
  return Number.isInteger(rounded)
    ? rounded.toString()
    : rounded.toString();
}

export class UDim2ResolveCodeActionProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorRewrite,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    const text = document.getText();
    const cursorOffset = document.offsetAt(range.start);

    const literal = findUDim2LiteralAt(text, cursorOffset);
    if (!literal) {return [];}
    // Only fire on the two pure forms — `UDim2.new(…)` already has
    // both axes encoded so there's nothing to convert.
    if (literal.form !== "fromScale" && literal.form !== "fromOffset") {
      return [];
    }

    const aliases = getAliasPartition();
    const calls = findAllCreateElementCalls(text, aliases);
    const enclosing = findEnclosingCall(calls, cursorOffset);
    if (!enclosing) {return [];}

    // Verify the literal is the value of *this* call's `Size` prop —
    // not a UDim2 used elsewhere (Position, CanvasSize, etc.). The
    // conversion is only meaningful relative to the parent's Size, so
    // applying it to e.g. Position would produce a wrong number.
    if (!isLiteralTheSizeOf(literal, enclosing, text)) {return [];}

    const parent = findParentCall(calls, enclosing);
    if (!parent) {return [];}

    // Strict — if the parent chain doesn't resolve to a concrete
    // pixel size, hide the action entirely rather than emit an
    // arbitrary fallback number. The user prefers "no action" over
    // "wrong value" (a wrong conversion silently breaks UI more
    // visibly than a missing lightbulb).
    const parentPixels = computePixelSize(parent, calls, text);
    if (!parentPixels) {return [];}
    if (parentPixels.x <= 0 || parentPixels.y <= 0) {return [];}

    const literalRange = new vscode.Range(
      document.positionAt(literal.start),
      document.positionAt(literal.end)
    );

    if (literal.form === "fromScale") {
      const ox = literal.value.sx * parentPixels.x;
      const oy = literal.value.sy * parentPixels.y;
      const replacement = `UDim2.fromOffset(${fmt(ox)}, ${fmt(oy)})`;
      const action = new vscode.CodeAction(
        `Convert to ${replacement}`,
        vscode.CodeActionKind.RefactorRewrite
      );
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, literalRange, replacement);
      action.isPreferred = true;
      return [action];
    }

    // fromOffset → fromScale
    const sx = literal.value.ox / parentPixels.x;
    const sy = literal.value.oy / parentPixels.y;
    const replacement = `UDim2.fromScale(${fmt(sx)}, ${fmt(sy)})`;
    const action = new vscode.CodeAction(
      `Convert to ${replacement}`,
      vscode.CodeActionKind.RefactorRewrite
    );
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, literalRange, replacement);
    action.isPreferred = true;
    return [action];
  }
}

/** True iff the given literal is the value of the call's `Size` prop. */
function isLiteralTheSizeOf(
  literal: UDim2Literal,
  call: CreateElementCall,
  text: string
): boolean {
  if (
    call.propsBraceStart === undefined ||
    call.propsBraceEnd === undefined
  ) {
    return false;
  }
  const entries = extractPropEntriesFromDocument(
    text,
    call.propsBraceStart + 1,
    call.propsBraceEnd
  );
  const sizeEntry = entries.find((e) => e.key === "Size");
  if (!sizeEntry) {return false;}
  const valStart = call.propsBraceStart + 1 + sizeEntry.valueStart;
  const valEnd = call.propsBraceStart + 1 + sizeEntry.valueEnd;
  return literal.start >= valStart && literal.end <= valEnd;
}

// ============================================================================
// "Calculate Size from children" — the second action
// ============================================================================
//
// Sibling to the chain-walking action above: when the cursor is on
// an element whose own `Size` is `UDim2.fromScale(…)` *and* every
// child element has a literal pixel `Size`, this offers to replace
// the parent's Size with the offset value implied by the children.
//
// Layout rules it understands:
//
//   - `UIListLayout` with FillDirection = Horizontal / Vertical and
//     a `Padding = UDim.new(0, N)` spacing. Sums children along the
//     fill axis, takes the max across, factors in (n-1) gaps.
//   - `UIPadding` with `Padding{Top,Bottom,Left,Right} = UDim.new(0,
//     N)` margins. Adds them after the children sum.
//   - No layout primitive → assumes children are independently
//     positioned and uses `max(child.size)` on both axes.
//
// What it deliberately skips (to keep results honest):
//
//   - Children whose Size isn't a literal pixel (mixed scale, a
//     variable, a `:map(...)` binding without a clean coefficient).
//   - Layouts other than UIListLayout / UIPadding (UIGridLayout,
//     UIPageLayout, custom Vide layouts, …).
//   - `Padding` keys whose value isn't `UDim.new(0, N)` (scale-based
//     padding doesn't have a meaningful pixel value without the
//     parent size, and that's what we're trying to compute).

interface ChildPixelSize {
  width: number;
  height: number;
}

interface UIPaddingValues {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface UIListLayoutValues {
  direction: "Horizontal" | "Vertical";
  padding: number;
}

/** Return the direct-child element calls of `parent` (the calls
 *  whose body sits strictly inside parent's body, with no other call
 *  between them). */
function directChildCalls(
  parent: CreateElementCall,
  calls: readonly CreateElementCall[]
): CreateElementCall[] {
  const inside = calls.filter(
    (c) =>
      c !== parent &&
      c.aliasStart > parent.aliasStart &&
      c.fullEnd < parent.fullEnd
  );
  // A call is a *direct* child iff no other inside-call strictly
  // contains it. O(N²) on `inside` which is fine — children counts
  // rarely exceed a few dozen.
  return inside.filter(
    (c) =>
      !inside.some(
        (o) =>
          o !== c &&
          o.aliasStart < c.aliasStart &&
          c.fullEnd < o.fullEnd
      )
  );
}

/** Pixel width / height of a child whose Size is a pure
 *  `UDim2.fromOffset(W, H)` literal (or the equivalent `UDim2.new(0,
 *  W, 0, H)`). Returns undefined for anything else — including
 *  mixed-axis or scale-bearing values, since their pixel size
 *  depends on a parent dimension we don't yet have. */
function pixelSizeOfChild(
  child: CreateElementCall,
  text: string
): ChildPixelSize | undefined {
  const size = getSizeOf(child, text);
  if (!size) {return undefined;}
  if (size.sx !== 0 || size.sy !== 0) {return undefined;}
  return { width: size.ox, height: size.oy };
}

/** Extract a literal `UDim.new(0, N)` value from a prop entry's
 *  text, returning N. Anything else (scale > 0, non-literal) is
 *  treated as zero. */
function readUDimOffsetEntry(
  call: CreateElementCall,
  text: string,
  key: string
): number {
  if (
    call.propsBraceStart === undefined ||
    call.propsBraceEnd === undefined
  ) {
    return 0;
  }
  const entries = extractPropEntriesFromDocument(
    text,
    call.propsBraceStart + 1,
    call.propsBraceEnd
  );
  const entry = entries.find((e) => e.key === key);
  if (!entry) {return 0;}
  const value = text
    .slice(
      call.propsBraceStart + 1 + entry.valueStart,
      call.propsBraceStart + 1 + entry.valueEnd
    )
    .trim();
  const m = /^UDim\.new\s*\(\s*0\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(value);
  return m ? Number(m[1]) : 0;
}

function readUIPadding(
  call: CreateElementCall,
  text: string
): UIPaddingValues {
  return {
    top: readUDimOffsetEntry(call, text, "PaddingTop"),
    bottom: readUDimOffsetEntry(call, text, "PaddingBottom"),
    left: readUDimOffsetEntry(call, text, "PaddingLeft"),
    right: readUDimOffsetEntry(call, text, "PaddingRight"),
  };
}

function readUIListLayout(
  call: CreateElementCall,
  text: string
): UIListLayoutValues | undefined {
  if (
    call.propsBraceStart === undefined ||
    call.propsBraceEnd === undefined
  ) {
    return undefined;
  }
  const entries = extractPropEntriesFromDocument(
    text,
    call.propsBraceStart + 1,
    call.propsBraceEnd
  );
  let direction: "Horizontal" | "Vertical" = "Vertical";
  const dirEntry = entries.find((e) => e.key === "FillDirection");
  if (dirEntry) {
    const v = text
      .slice(
        call.propsBraceStart + 1 + dirEntry.valueStart,
        call.propsBraceStart + 1 + dirEntry.valueEnd
      )
      .trim();
    if (/Horizontal/.test(v)) {direction = "Horizontal";}
    else if (/Vertical/.test(v)) {direction = "Vertical";}
  }
  const padding = readUDimOffsetEntry(call, text, "Padding");
  return { direction, padding };
}

/** Compute the parent's implied pixel size from its children.
 *  Returns undefined when any contentful child has a Size we can't
 *  reduce to pure pixels (so we never lie). */
function computeSizeFromChildren(
  parent: CreateElementCall,
  calls: readonly CreateElementCall[],
  text: string
): ChildPixelSize | undefined {
  const children = directChildCalls(parent, calls);
  if (children.length === 0) {return undefined;}

  let padding: UIPaddingValues = { top: 0, bottom: 0, left: 0, right: 0 };
  let layout: UIListLayoutValues | undefined;
  const contentful: ChildPixelSize[] = [];

  for (const child of children) {
    if (child.className === "UIPadding" && !child.isStringLiteralName) {
      padding = readUIPadding(child, text);
      continue;
    }
    if (child.isStringLiteralName && child.className === "UIPadding") {
      padding = readUIPadding(child, text);
      continue;
    }
    if (child.className === "UIListLayout") {
      layout = readUIListLayout(child, text);
      continue;
    }
    // Constraints / decorators that don't take up content space — skip.
    if (
      child.className === "UICorner" ||
      child.className === "UIStroke" ||
      child.className === "UIGradient" ||
      child.className === "UIFlexItem" ||
      child.className === "UIScale" ||
      child.className === "UIAspectRatioConstraint" ||
      child.className === "UISizeConstraint" ||
      child.className === "UITextSizeConstraint"
    ) {
      continue;
    }
    // Anything else needs a literal pixel Size.
    const px = pixelSizeOfChild(child, text);
    if (!px) {return undefined;}
    contentful.push(px);
  }

  if (contentful.length === 0) {return undefined;}

  let width: number;
  let height: number;
  if (layout?.direction === "Horizontal") {
    width =
      contentful.reduce((s, c) => s + c.width, 0) +
      Math.max(0, contentful.length - 1) * layout.padding;
    height = contentful.reduce((m, c) => Math.max(m, c.height), 0);
  } else if (layout?.direction === "Vertical") {
    height =
      contentful.reduce((s, c) => s + c.height, 0) +
      Math.max(0, contentful.length - 1) * layout.padding;
    width = contentful.reduce((m, c) => Math.max(m, c.width), 0);
  } else {
    // No layout primitive — assume free-positioned children and use
    // the bounding box.
    width = contentful.reduce((m, c) => Math.max(m, c.width), 0);
    height = contentful.reduce((m, c) => Math.max(m, c.height), 0);
  }

  width += padding.left + padding.right;
  height += padding.top + padding.bottom;
  if (width <= 0 || height <= 0) {return undefined;}
  return { width, height };
}

export class UDim2FromChildrenCodeActionProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorRewrite,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    const text = document.getText();
    const cursorOffset = document.offsetAt(range.start);

    // The cursor has to be on a UDim2 literal that IS the call's Size
    // prop. Mirrors the other action's gating exactly — the lightbulb
    // shows next to the literal you're trying to replace.
    const literal = findUDim2LiteralAt(text, cursorOffset);
    if (!literal) {return [];}
    if (literal.form !== "fromScale" && literal.form !== "fromOffset") {
      return [];
    }

    const aliases = getAliasPartition();
    const calls = findAllCreateElementCalls(text, aliases);
    const enclosing = findEnclosingCall(calls, cursorOffset);
    if (!enclosing) {return [];}
    if (!isLiteralTheSizeOf(literal, enclosing, text)) {return [];}

    const implied = computeSizeFromChildren(enclosing, calls, text);
    if (!implied) {return [];}

    const literalRange = new vscode.Range(
      document.positionAt(literal.start),
      document.positionAt(literal.end)
    );
    const replacement = `UDim2.fromOffset(${fmt(implied.width)}, ${fmt(implied.height)})`;
    const action = new vscode.CodeAction(
      `Calculate Size from children — ${replacement}`,
      vscode.CodeActionKind.RefactorRewrite
    );
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, literalRange, replacement);
    return [action];
  }
}
