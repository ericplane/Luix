import * as vscode from "vscode";
import {
  CreateElementCall,
  extractPropEntriesFromDocument,
  findAllCreateElementCalls,
} from "./parser";
import { getAliasPartition } from "./frameworks";

// Resolve sizes from literal ancestor dimensions; layout constraints are not evaluated.

interface UDim2Value {
  /** Per-axis scale and offset components. */
  sx: number;
  ox: number;
  sy: number;
  oy: number;
}

interface UDim2Literal {
  value: UDim2Value;
  form: "fromScale" | "fromOffset" | "new";
  start: number;
  /** Exclusive end offset. */
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

/** Use a fresh regex to avoid sharing lastIndex across code actions. */
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

/** Non-literal Size values stop ancestor resolution. */
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
  const direct = /^UDim2\.(fromScale|fromOffset|new)\s*\(([^()]*)\)/.exec(
    valueText
  );
  if (direct) {
    return parseUDim2Args(
      direct[2],
      direct[1] as "fromScale" | "fromOffset" | "new"
    );
  }
  // Recognize map bindings with a simple numeric scale coefficient.
  return parseMappedFromOffset(valueText);
}

/** Accept constants or one coefficient multiplied by a binding; reject other expressions. */
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

/** Resolve pure pixel sizes through ancestors; skip mixed axes or missing dimensions. */
function computePixelSize(
  call: CreateElementCall,
  calls: readonly CreateElementCall[],
  text: string
): { x: number; y: number } | undefined {
  let cumSx = 1;
  let cumSy = 1;
  let current: CreateElementCall | undefined = call;
  // Bound ancestor walks for pathological input.
  for (let depth = 0; depth < 64 && current; depth++) {
    const size = getSizeOf(current, text);
    if (!size) {return undefined;}
    if (size.sx === 0 && size.sy === 0) {
      return { x: cumSx * size.ox, y: cumSy * size.oy };
    }
    if (size.ox === 0 && size.oy === 0) {
      cumSx *= size.sx;
      cumSy *= size.sy;
      current = findParentCall(calls, current);
      continue;
    }
    // Mixed scale and offset need runtime parent dimensions.
    return undefined;
  }
  return undefined;
}

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
    if (literal.form !== "fromScale" && literal.form !== "fromOffset") {
      return [];
    }

    const aliases = getAliasPartition();
    const calls = findAllCreateElementCalls(text, aliases);
    const enclosing = findEnclosingCall(calls, cursorOffset);
    if (!enclosing) {return [];}

    // Only Size values can be converted using parent dimensions.
    if (!isLiteralTheSizeOf(literal, enclosing, text)) {return [];}

    const parent = findParentCall(calls, enclosing);
    if (!parent) {return [];}

    // Hide the action when parent dimensions are unknown.
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

// Infer parent size from pixel-sized children, UIListLayout and pixel padding only.

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

/** Reject child sizes that depend on the parent's dimensions. */
function pixelSizeOfChild(
  child: CreateElementCall,
  text: string
): ChildPixelSize | undefined {
  const size = getSizeOf(child, text);
  if (!size) {return undefined;}
  if (size.sx !== 0 || size.sy !== 0) {return undefined;}
  return { width: size.ox, height: size.oy };
}

/** Only literal offset padding contributes pixels. */
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

/** Skip the estimate if any content child has an unresolved size. */
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
    // Decorators and constraints do not occupy content space.
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
    // Without a layout, use the children's bounding box.
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
