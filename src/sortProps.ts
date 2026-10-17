import * as vscode from "vscode";
import {
  applyMask,
  buildCodeMask,
  findAllCreateElementCalls,
} from "./parser";
import { classHierarchy, flattenClassEvents } from "./data";
import { getAliasPartition } from "./frameworks";
import { getConfig } from "./configCompat";
import { luaValueEnd } from "./editSyntax";

// Sort by category without moving comments or reordering unknown props.

const PROP_CATEGORIES: Record<string, string[]> = {
  Identification: ["Name", "ClassName", "Key", "Archivable"],

  Layout: [
    "AnchorPoint",
    "Position",
    "Size",
    "SizeOffset",
    "AutomaticSize",
    "Rotation",
    "LayoutOrder",
    "ZIndex",
    "ZIndexBehavior",
    "SizeConstraint",
    "MinSize",
    "MaxSize",
    "AspectRatio",
    "AspectType",
    "DominantAxis",
    // UIPadding
    "Padding",
    "PaddingTop",
    "PaddingRight",
    "PaddingBottom",
    "PaddingLeft",
    // UIListLayout / UIGridLayout / UIPageLayout / UITableLayout
    "FillDirection",
    "FillDirectionMaxCells",
    "HorizontalAlignment",
    "VerticalAlignment",
    "HorizontalFlex",
    "VerticalFlex",
    "ItemLineAlignment",
    "SortOrder",
    "StartCorner",
    "CellPadding",
    "CellSize",
    "ColumnSpacing",
    "RowSpacing",
    "PageSize",
    "MajorAxis",
    // UIFlexItem
    "FlexMode",
    "GrowRatio",
    "ShrinkRatio",
    // UIScale
    "Scale",
    // ScrollingFrame canvas
    "CanvasSize",
    "CanvasPosition",
    "AutomaticCanvasSize",
    "ScrollingDirection",
    "ScrollingEnabled",
    "ScrollWheelInputEnabled",
    "ElasticBehavior",
    "ScrollBarThickness",
    "HorizontalScrollBarInset",
    "VerticalScrollBarInset",
    "VerticalScrollBarPosition",
    "BottomImage",
    "MidImage",
    "TopImage",
    "ScrollBarImageColor3",
    "ScrollBarImageTransparency",
  ],

  Style: [
    "BackgroundColor3",
    "BackgroundTransparency",
    "BorderColor3",
    "BorderMode",
    "BorderSizePixel",
    "CornerRadius",
    // UIStroke
    "ApplyStrokeMode",
    "Color",
    "Thickness",
    "LineJoinMode",
    "Transparency",
    "BorderOffset",
    "BorderStrokePosition",
    "StrokeSizingMode",
    // UIGradient
    "Offset",
    // CanvasGroup
    "GroupColor3",
    "GroupTransparency",
    // ViewportFrame lighting
    "Ambient",
    "LightColor",
    "LightDirection",
    "LightInfluence",
  ],

  Visibility: ["Visible", "ClipsDescendants", "Enabled"],

  Image: [
    "Image",
    "ImageColor3",
    "ImageTransparency",
    "ImageRectOffset",
    "ImageRectSize",
    "ScaleType",
    "SliceCenter",
    "SliceScale",
    "TileSize",
    "ResampleMode",
    "HoverImage",
    "PressedImage",
  ],

  Text: [
    "Text",
    "TextColor3",
    "TextSize",
    "MaxTextSize",
    "MinTextSize",
    "TextScaled",
    "TextWrapped",
    "FontFace",
    "Font",
    "OpenTypeFeatures",
    "RichText",
    "TextXAlignment",
    "TextYAlignment",
    "TextDirection",
    "LineHeight",
    "TextTransparency",
    "TextStrokeColor3",
    "TextStrokeTransparency",
    "TextTruncate",
    "MaxVisibleGraphemes",
    "PlaceholderText",
    "PlaceholderColor3",
    "ClearTextOnFocus",
    "MultiLine",
    "CursorPosition",
    "SelectionStart",
    "ShowNativeInput",
    "TextEditable",
  ],

  Behavior: [
    "Active",
    "Selectable",
    "Interactable",
    "AutoButtonColor",
    "Modal",
    "Selected",
    "Style",
    // Input + selection
    "InputSink",
    "SelectionOrder",
    "SelectionImageObject",
    "SelectionGroup",
    "SelectionBehaviorDown",
    "SelectionBehaviorLeft",
    "SelectionBehaviorRight",
    "SelectionBehaviorUp",
    "NextSelectionDown",
    "NextSelectionLeft",
    "NextSelectionRight",
    "NextSelectionUp",
    "GamepadInputEnabled",
    "TouchInputEnabled",
    "TabKeyboardNavigation",
    "HoverHapticEffect",
    "PressHapticEffect",
    // Localisation
    "AutoLocalize",
    "RootLocalizationTable",
    // Layer collector / Gui root
    "DisplayOrder",
    "IgnoreGuiInset",
    "ResetOnSpawn",
    "SafeAreaCompatibility",
    "ScreenInsets",
    "ClipToDeviceSafeArea",
    // BillboardGui / SurfaceGui adornment
    "Adornee",
    "AlwaysOnTop",
    "Brightness",
    "DistanceLowerLimit",
    "DistanceStep",
    "DistanceUpperLimit",
    "ExtentsOffset",
    "ExtentsOffsetWorldSpace",
    "Face",
    "MaxDistance",
    "PixelsPerStud",
    "PlayerToHideFrom",
    "SizingMode",
    "StudsOffset",
    "StudsOffsetWorldSpace",
    "ToolPunchThroughDistance",
    // ViewportFrame
    "CurrentCamera",
    // VideoFrame / audio playback
    "Looped",
    "Playing",
    "TimePosition",
    "Video",
    "Volume",
    "MaximumResolution",
    "RollOffMaxDistance",
    "RollOffMinDistance",
    "RollOffMode",
    "Animated",
    "Circular",
    "FillEmptySpaceColumns",
    "FillEmptySpaceRows",
    "Wraps",
  ],

  // Pattern-based categories are filled by categorize().
  Events: [],
  Refs: ["ref", "key"],
  Children: [],
  Other: [],
};

export const DEFAULT_CATEGORY_ORDER = [
  "Identification",
  "Layout",
  "Style",
  "Visibility",
  "Image",
  "Text",
  "Behavior",
  "Events",
  "Refs",
  "Children",
  "Other",
];

interface Category {
  name: string;
  position: number;
}

function categorize(key: string, eventNames: ReadonlySet<string>): Category {
  for (const [name, props] of Object.entries(PROP_CATEGORIES)) {
    const idx = props.indexOf(key);
    if (idx >= 0) {
      return { name, position: idx };
    }
  }
  if (key === "[Children]" || key === "children") {
    return { name: "Children", position: 0 };
  }
  if (/^\[.*Event.*\]$/i.test(key) || /^\[.*Change.*\]$/i.test(key)) {
    return { name: "Events", position: 0 };
  }
  if (/^\[OnEvent/i.test(key) || /^\[OnChange/i.test(key)) {
    return { name: "Events", position: 0 };
  }
  // Vide uses plain event names as prop keys.
  if (eventNames.has(key)) {
    return { name: "Events", position: 0 };
  }
  return { name: "Other", position: 0 };
}

export interface SortTarget {
  className: string;
  isStringLiteralName: boolean;
}

const UI_EVENT_CLASSES = ["GuiBase2d", "GuiObject", "GuiButton", "TextBox"];
let _uiEventNames: Set<string> | undefined;

/** Host classes use their own event set; components use the UI fallback. */
export function eventNamesForTarget(target?: SortTarget): ReadonlySet<string> {
  if (target && target.isStringLiteralName && classHierarchy[target.className]) {
    return new Set(flattenClassEvents(target.className));
  }
  if (!_uiEventNames) {
    _uiEventNames = new Set(
      UI_EVENT_CLASSES.flatMap((cls) => classHierarchy[cls]?.events ?? [])
    );
  }
  return _uiEventNames;
}

// Include computed keys and positional children when scanning.
interface SortableEntry {
  /** The key, or "" for positional entries. */
  key: string;
  /** Positional children keep their relative order. */
  positional: boolean;
  start: number; // Body offset of the key or expression.
  end: number;   // Exclusive end of the value.
}

function extractSortableEntries(body: string): SortableEntry[] {
  const masked = applyMask(body, buildCodeMask(body));
  const entries: SortableEntry[] = [];
  let i = 0;
  const pushPositional = (start: number) => {
    let end = luaValueEnd(body, start);
    if (end === start) {
      end = start + 1;
    } else if (body.slice(start, end).trim().length > 0) {
      entries.push({ key: "", positional: true, start, end });
    }
    return end;
  };
  while (i < masked.length) {
    while (i < masked.length && /[\s,;]/.test(masked[i])) {
      i++;
    }
    if (i >= masked.length) {
      break;
    }
    const start = i;
    let key: string;
    if (masked[i] === "[") {
      let depth = 1;
      let j = i + 1;
      while (j < masked.length && depth > 0) {
        if (masked[j] === "[") {depth++;}
        else if (masked[j] === "]") {depth--;}
        j++;
      }
      key = body.slice(i, j);
      i = j;
    } else if (/[A-Za-z_]/.test(masked[i])) {
      const ks = i;
      while (i < masked.length && /\w/.test(masked[i])) {
        i++;
      }
      key = body.slice(ks, i);
    } else {
      i = pushPositional(start);
      continue;
    }
    while (i < masked.length && /\s/.test(masked[i])) {
      i++;
    }
    if (masked[i] !== "=") {
      i = pushPositional(start);
      continue;
    }
    i++;
    while (i < masked.length && /\s/.test(masked[i])) {
      i++;
    }
    i = luaValueEnd(body, i);
    entries.push({ key, positional: false, start, end: i });
  }
  return entries;
}

function bodyHasComments(body: string): boolean {
  let i = 0;
  let inString: string | null = null;
  while (i < body.length - 1) {
    const c = body[i];
    if (inString) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === inString) {
        inString = null;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      i++;
      continue;
    }
    if (c === "-" && body[i + 1] === "-") {
      return true;
    }
    i++;
  }
  return false;
}

export function sortPropsBody(
  body: string,
  categoryOrder: string[],
  target?: SortTarget
): string | undefined {
  if (bodyHasComments(body)) {
    return undefined;
  }
  const eventNames = eventNamesForTarget(target);
  let entries: SortableEntry[];
  try {
    entries = extractSortableEntries(body);
  } catch {
    // Leave incomplete syntax untouched on save.
    return undefined;
  }
  if (entries.length < 2) {
    return undefined;
  }

  const firstKeyStart = entries[0].start;
  let lineStart = firstKeyStart;
  while (lineStart > 0 && body[lineStart - 1] !== "\n") {
    lineStart--;
  }
  const indent = body.slice(lineStart, firstKeyStart);
  if (!/^[ \t]*$/.test(indent)) {
    return undefined;
  }

  const trailingMatch = /\n([ \t]*)$/.exec(body);
  const trailingIndent = trailingMatch ? trailingMatch[1] : "";

  const catIndex = new Map<string, number>();
  categoryOrder.forEach((c, i) => catIndex.set(c, i));
  const fallbackOrder = catIndex.get("Other") ?? 999;

  const decorated = entries.map((e, originalIdx) => {
    const cat = e.positional
      ? { name: "Children", position: 0 }
      : categorize(e.key, eventNames);
    const order = catIndex.get(cat.name) ?? fallbackOrder;
    return { ...e, originalIdx, catName: cat.name, catPos: cat.position, order };
  });

  decorated.sort((a, b) => {
    if (a.order !== b.order) {return a.order - b.order;}
    if (a.catPos !== b.catPos) {return a.catPos - b.catPos;}
    return a.originalIdx - b.originalIdx;
  });

  if (decorated.every((e, i) => e.originalIdx === i)) {
    return undefined;
  }

  const lines = decorated.map(
    (e) => indent + body.slice(e.start, e.end) + ","
  );
  return "\n" + lines.join("\n") + "\n" + trailingIndent;
}

/** Sort children from the end to preserve offsets; return undefined for a no-op. */
interface SortableCall extends SortTarget {
  propsBraceStart: number;
  propsBraceEnd: number;
}

function sortBodyRecursive(
  text: string,
  bodyStart: number,
  bodyEnd: number,
  allCalls: SortableCall[],
  categoryOrder: string[],
  target: SortTarget
): string | undefined {
  let body = text.slice(bodyStart, bodyEnd);
  let changed = false;

  // Recurse through direct children to avoid sorting descendants twice.
  const inside = allCalls.filter(
    (c) =>
      c.propsBraceStart > bodyStart && c.propsBraceEnd < bodyEnd
  );
  const directChildren = inside
    .filter(
      (c) =>
        !inside.some(
          (other) =>
            other !== c &&
            other.propsBraceStart < c.propsBraceStart &&
            c.propsBraceEnd < other.propsBraceEnd
        )
    )
    .sort((a, b) => b.propsBraceStart - a.propsBraceStart);

  for (const child of directChildren) {
    const innerSorted = sortBodyRecursive(
      text,
      child.propsBraceStart + 1,
      child.propsBraceEnd,
      allCalls,
      categoryOrder,
      child
    );
    if (innerSorted !== undefined) {
      const localStart = child.propsBraceStart + 1 - bodyStart;
      const localEnd = child.propsBraceEnd - bodyStart;
      body = body.slice(0, localStart) + innerSorted + body.slice(localEnd);
      changed = true;
    }
  }

  const sortedSelf = sortPropsBody(body, categoryOrder, target);
  if (sortedSelf !== undefined) {
    body = sortedSelf;
    changed = true;
  }

  return changed ? body : undefined;
}

export class SortPropsCodeActionProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorRewrite,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] | undefined {
    const lang = document.languageId;
    if (lang !== "lua" && lang !== "luau") {
      return undefined;
    }
    const text = document.getText();
    // Skip non-table files before parsing; Fusion/Vide sugar may omit parentheses.
    if (text.indexOf("{") === -1) {
      return undefined;
    }
    const cursor = document.offsetAt(range.start);
    const aliases = getAliasPartition();
    const calls = findAllCreateElementCalls(text, aliases);
    let match: typeof calls[number] | undefined;
    for (const c of calls) {
      if (
        c.propsBraceStart === undefined ||
        c.propsBraceEnd === undefined
      ) {
        continue;
      }
      if (cursor >= c.propsBraceStart && cursor <= c.propsBraceEnd) {
        if (
          !match ||
          c.fullEnd - c.aliasStart < match.fullEnd - match.aliasStart
        ) {
          match = c;
        }
      }
    }
    if (
      !match ||
      match.propsBraceStart === undefined ||
      match.propsBraceEnd === undefined
    ) {
      return undefined;
    }
    const bodyStart = match.propsBraceStart + 1;
    const bodyEnd = match.propsBraceEnd;
    const body = text.slice(bodyStart, bodyEnd);
    const order = getConfig<string[]>(
      "sortProps.categoryOrder",
      DEFAULT_CATEGORY_ORDER
    );
    const sorted = sortPropsBody(body, order, match);
    if (!sorted) {
      return undefined;
    }
    const action = new vscode.CodeAction(
      `Sort props by category`,
      vscode.CodeActionKind.RefactorRewrite
    );
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(bodyStart),
        document.positionAt(bodyEnd)
      ),
      sorted
    );
    return [action];
  }
}

export class SortPropsOnSaveListener implements vscode.Disposable {
  private disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onWillSaveTextDocument((e) =>
      this.onWillSave(e)
    );
  }

  private onWillSave(event: vscode.TextDocumentWillSaveEvent): void {
    if (!getConfig<boolean>("sortProps.onSave", false)) {
      return;
    }
    // Only rewrite saved file documents.
    if (event.document.uri.scheme !== "file") {
      return;
    }
    const lang = event.document.languageId;
    if (lang !== "lua" && lang !== "luau") {
      return;
    }
    event.waitUntil(this.computeEdits(event.document));
  }

  private async computeEdits(
    document: vscode.TextDocument
  ): Promise<vscode.TextEdit[]> {
    const text = document.getText();
    const aliases = getAliasPartition();
    const calls = findAllCreateElementCalls(text, aliases).filter(
      (c): c is typeof c & {
        propsBraceStart: number;
        propsBraceEnd: number;
      } =>
        c.propsBraceStart !== undefined && c.propsBraceEnd !== undefined
    );
    if (calls.length === 0) {
      return [];
    }
    const order = getConfig<string[]>(
      "sortProps.categoryOrder",
      DEFAULT_CATEGORY_ORDER
    );

    // Emit one edit per outer call so nested replacements cannot overlap.
    const isStrictlyInside = (
      inner: { propsBraceStart: number; propsBraceEnd: number },
      outer: { propsBraceStart: number; propsBraceEnd: number }
    ) =>
      outer.propsBraceStart < inner.propsBraceStart &&
      inner.propsBraceEnd < outer.propsBraceEnd;

    const topLevel = calls.filter(
      (c) => !calls.some((o) => o !== c && isStrictlyInside(c, o))
    );

    const edits: vscode.TextEdit[] = [];
    for (const top of topLevel) {
      const start = top.propsBraceStart + 1;
      const end = top.propsBraceEnd;
      const sorted = sortBodyRecursive(text, start, end, calls, order, top);
      if (sorted === undefined) {continue;}
      edits.push(
        vscode.TextEdit.replace(
          new vscode.Range(
            document.positionAt(start),
            document.positionAt(end)
          ),
          sorted
        )
      );
    }
    return edits;
  }

  dispose(): void {
    this.disposable.dispose();
  }
}

export const _internal = {
  sortBodyRecursive,
};
