import * as vscode from "vscode";
import { buildFontFaceReplacement } from "./data";
import {
  AutoImportAlias,
  AutoImportConfig,
  getAutoImportConfig,
} from "./config";
import { DIAGNOSTIC_CODE } from "./diagnostics";
import { WorkspaceIndex } from "./workspaceIndex";

// ============================================================================
// Auto-import code action (opt-in)
// ============================================================================

export class AutoImportCodeActionProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  constructor(private readonly workspaceIndex: WorkspaceIndex) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): Promise<vscode.CodeAction[]> {
    const actions: vscode.CodeAction[] = [];
    const config = getAutoImportConfig();
    if (!config.enabled) {
      return actions;
    }

    for (const diag of context.diagnostics) {
      if (diag.code !== DIAGNOSTIC_CODE.MissingImport) {
        continue;
      }
      const componentName = document.getText(diag.range);
      const found = await this.workspaceIndex.findComponentFile(
        componentName,
        document.uri.toString()
      );
      if (!found) {
        continue;
      }
      const importPath = buildImportPath(
        document.uri,
        found.uri,
        config
      );
      if (!importPath) {
        continue;
      }
      const insertLine = findImportInsertionLine(document.getText());
      const insertPosition = new vscode.Position(insertLine, 0);
      const importLine = `local ${componentName} = require(${importPath})\n`;

      const action = new vscode.CodeAction(
        `Import ${componentName} from ${importPath}`,
        vscode.CodeActionKind.QuickFix
      );
      action.diagnostics = [diag];
      action.isPreferred = true;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.insert(document.uri, insertPosition, importLine);
      actions.push(action);
    }

    return actions;
  }
}

export function buildImportPath(
  currentFileUri: vscode.Uri,
  componentFileUri: vscode.Uri,
  config: AutoImportConfig
): string | undefined {
  if (config.style === "alias") {
    const aliasPath = resolveViaAlias(componentFileUri, config.aliases);
    if (aliasPath) {
      return aliasPath;
    }
  }
  return buildRelativePath(currentFileUri, componentFileUri);
}

export function buildRelativePath(
  fromUri: vscode.Uri,
  toUri: vscode.Uri
): string {
  const path = require("path") as typeof import("path");
  const rel = path.relative(
    path.dirname(fromUri.fsPath),
    toUri.fsPath
  );
  const parts = rel.split(path.sep);
  let result = "script.Parent";
  for (const part of parts) {
    if (part === "..") {
      result += ".Parent";
    } else if (part !== "" && part !== ".") {
      const clean = part.replace(/\.lua[u]?$/, "");
      result += `.${clean}`;
    }
  }
  return result;
}

export function resolveViaAlias(
  componentUri: vscode.Uri,
  aliases: AutoImportAlias[]
): string | undefined {
  if (aliases.length === 0) {
    return undefined;
  }
  const path = require("path") as typeof import("path");
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(componentUri);
  if (!workspaceFolder) {
    return undefined;
  }
  const relFromWorkspace = path.relative(
    workspaceFolder.uri.fsPath,
    componentUri.fsPath
  );
  for (const alias of aliases) {
    const normalized = alias.filesystemPath.replace(/\/+$/, "");
    if (
      relFromWorkspace === normalized ||
      relFromWorkspace.startsWith(normalized + path.sep)
    ) {
      const remaining = relFromWorkspace
        .slice(normalized.length)
        .replace(/^[/\\]+/, "");
      const segments = remaining
        .split(path.sep)
        .filter((s) => s.length > 0)
        .map((s) => s.replace(/\.lua[u]?$/, ""));
      if (segments.length === 0) {
        return alias.robloxPath;
      }
      return `${alias.robloxPath}.${segments.join(".")}`;
    }
  }
  return undefined;
}

function findImportInsertionLine(text: string): number {
  const lines = text.split("\n");
  let lastRequireLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*local\s+[A-Za-z_]\w*\s*=\s*require\b/.test(lines[i])) {
      lastRequireLine = i;
    }
  }
  if (lastRequireLine !== -1) {
    return lastRequireLine + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith("--")) {
      continue;
    }
    return i;
  }
  return 0;
}

// ============================================================================
// Deprecation quick fixes — Font → FontFace, TextColor → TextColor3
// ============================================================================

/**
 * Extract the `Enum.Font.X` family name from a `Font = …` snippet, or
 * `undefined` when the value isn't an enum literal (a string like
 * `"Gotham"`, a variable, …). The `Font` deprecation warning fires for
 * every value form, but only the enum-literal form can be auto-converted
 * to `FontFace = Font.fromName(...)` — other forms return `undefined`
 * here so no (value-discarding) fix is offered. Pure — unit-tested.
 */
export function extractDeprecatedFontEnum(snippet: string): string | undefined {
  const m = /Font\s*=\s*Enum\.Font\.([A-Za-z_]\w*)/.exec(snippet);
  return m ? m[1] : undefined;
}

export class DeprecationCodeActionProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    const actions: vscode.CodeAction[] = [];

    for (const diag of context.diagnostics) {
      if (diag.code === DIAGNOSTIC_CODE.DeprecatedFont) {
        const fix = this.fontFix(document, diag);
        if (fix) {
          actions.push(fix);
        }
      } else if (diag.code === DIAGNOSTIC_CODE.TypoTextColor) {
        actions.push(this.textColorFix(document, diag));
      } else if (diag.code === DIAGNOSTIC_CODE.UnknownProp) {
        const fix = this.unknownPropFix(document, diag);
        if (fix) {
          actions.push(fix);
        }
      } else if (diag.code === DIAGNOSTIC_CODE.MissingRichText) {
        actions.push(this.missingRichTextFix(document, diag));
      } else if (diag.code === DIAGNOSTIC_CODE.MissingAnchorPoint) {
        const fix = this.missingAnchorPointFix(document, diag);
        if (fix) {
          actions.push(fix);
        }
      } else if (diag.code === DIAGNOSTIC_CODE.CornerRadiusCollapsible) {
        const fix = this.collapseCornerRadiusFix(document, diag);
        if (fix) {
          actions.push(fix);
        }
      }
    }

    return actions;
  }

  /**
   * Insert `AnchorPoint = Vector2.new(x, y),` right above the flagged
   * Position key, matching its indentation. Coordinates come from the
   * diagnostic's stashed payload to avoid re-parsing.
   */
  private missingAnchorPointFix(
    document: vscode.TextDocument,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const payload = (
      diag as vscode.Diagnostic & {
        _luixData?: { anchorX: number; anchorY: number };
      }
    )._luixData;
    if (!payload) {
      return undefined;
    }
    const fmt = (n: number) =>
      Number.isInteger(n) ? n.toString() : n.toString();
    const value = `Vector2.new(${fmt(payload.anchorX)}, ${fmt(payload.anchorY)})`;
    const action = new vscode.CodeAction(
      `Add \`AnchorPoint = ${value}\``,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.isPreferred = true;
    const line = document.lineAt(diag.range.start.line);
    const indent = line.text.slice(0, diag.range.start.character);
    const insertPos = diag.range.start.with({ character: 0 });
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(
      document.uri,
      insertPos,
      `${indent}AnchorPoint = ${value},\n`
    );
    return action;
  }

  /**
   * Collapse four equal individual corner radii into a single
   * `CornerRadius`. The diagnostic's range already spans the four
   * entries and its `_luixData.value` carries the shared value, so the
   * fix is a one-line replace.
   */
  private collapseCornerRadiusFix(
    document: vscode.TextDocument,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const payload = (
      diag as vscode.Diagnostic & { _luixData?: { value?: string } }
    )._luixData;
    if (!payload?.value) {
      return undefined;
    }
    const action = new vscode.CodeAction(
      "Collapse to a single `CornerRadius`",
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(
      document.uri,
      diag.range,
      `CornerRadius = ${payload.value}`
    );
    return action;
  }

  /**
   * Insert `RichText = true,` right before the `Text` key, picking up
   * whatever indentation the existing line already uses so the result
   * formats cleanly.
   */
  private missingRichTextFix(
    document: vscode.TextDocument,
    diag: vscode.Diagnostic
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      "Set `RichText = true`",
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.isPreferred = true;
    const line = document.lineAt(diag.range.start.line);
    const indent = line.text.slice(0, diag.range.start.character);
    const insertPos = diag.range.start.with({ character: 0 });
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(
      document.uri,
      insertPos,
      `${indent}RichText = true,\n`
    );
    return action;
  }

  /**
   * "Did you mean `Position`?" → replaces the unknown key with the
   * suggested one. The suggestion is parsed back out of the diagnostic
   * message so we don't have to recompute Levenshtein here.
   */
  private unknownPropFix(
    document: vscode.TextDocument,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    const m = /Did you mean `([^`]+)`\?/.exec(diag.message);
    if (!m) {
      return undefined;
    }
    const replacement = m[1];
    const action = new vscode.CodeAction(
      `Rename to \`${replacement}\``,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, diag.range, replacement);
    return action;
  }

  private fontFix(
    document: vscode.TextDocument,
    diag: vscode.Diagnostic
  ): vscode.CodeAction | undefined {
    // Only auto-convert the `Enum.Font.X` form, where we can map the
    // enum to the right `Font.fromName(family, weight)`. For any other
    // value (`Font = "Gotham"`, a variable, …) we can't build the
    // replacement reliably — and silently substituting a default would
    // discard the user's value — so offer no fix. The deprecation
    // warning still stands.
    const enumName = extractDeprecatedFontEnum(document.getText(diag.range));
    if (!enumName) {
      return undefined;
    }
    const replacement = `FontFace = ${buildFontFaceReplacement(enumName)}`;

    const action = new vscode.CodeAction(
      `Replace with \`FontFace = Font.fromName(...)\``,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, diag.range, replacement);
    return action;
  }

  private textColorFix(
    document: vscode.TextDocument,
    diag: vscode.Diagnostic
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      "Rename to `TextColor3`",
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.isPreferred = true;
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, diag.range, "TextColor3");
    return action;
  }
}

// ============================================================================
// Convert Color3 between fromRGB / fromHex / new / fromHSV
// ============================================================================

import {
  applyMask,
  buildCodeMask,
  extractColorLiterals,
  findAllCreateElementCalls,
} from "./parser";
import { getAliasPartition } from "./frameworks";
import { findFrameworkForAlias } from "./frameworks";

export class Color3ConvertCodeActionProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorRewrite,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    const text = document.getText();
    const masked = applyMask(text, buildCodeMask(text));
    const literals = extractColorLiterals(masked, text);
    const cursor = document.offsetAt(range.start);

    const hit = literals.find(
      (c) => cursor >= c.start && cursor <= c.end
    );
    if (!hit) {
      return undefined;
    }
    const originalText = text.slice(hit.start, hit.end);
    const literalRange = new vscode.Range(
      document.positionAt(hit.start),
      document.positionAt(hit.end)
    );

    const r255 = Math.round(hit.r * 255);
    const g255 = Math.round(hit.g * 255);
    const b255 = Math.round(hit.b * 255);
    const toHex = (n: number) =>
      n.toString(16).toUpperCase().padStart(2, "0");
    const hex = `#${toHex(r255)}${toHex(g255)}${toHex(b255)}`;
    const fmt = (n: number) =>
      Number.isInteger(n) ? n.toString() : n.toFixed(3);
    const hsv = rgbToHsv(hit.r, hit.g, hit.b);

    const forms: Array<{ id: string; text: string; label: string }> = [
      {
        id: "fromRGB",
        text: `Color3.fromRGB(${r255}, ${g255}, ${b255})`,
        label: "Convert to `Color3.fromRGB(...)`",
      },
      {
        id: "fromHex",
        text: `Color3.fromHex("${hex}")`,
        label: "Convert to `Color3.fromHex(...)`",
      },
      {
        id: "new",
        text: `Color3.new(${fmt(hit.r)}, ${fmt(hit.g)}, ${fmt(hit.b)})`,
        label: "Convert to `Color3.new(...)`",
      },
      {
        id: "fromHSV",
        text: `Color3.fromHSV(${fmt(hsv.h)}, ${fmt(hsv.s)}, ${fmt(hsv.v)})`,
        label: "Convert to `Color3.fromHSV(...)`",
      },
    ];

    const actions: vscode.CodeAction[] = [];
    for (const form of forms) {
      if (originalText === form.text) {
        continue;
      }
      // Skip forms that match the *kind* (so we don't offer `fromRGB`
      // when the literal already uses fromRGB but with different
      // whitespace).
      if (originalText.includes(`Color3.${form.id}`)) {
        continue;
      }
      const action = new vscode.CodeAction(
        form.label,
        vscode.CodeActionKind.RefactorRewrite
      );
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, literalRange, form.text);
      actions.push(action);
    }
    return actions;
  }
}

function rgbToHsv(
  r: number,
  g: number,
  b: number
): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) {
      h = ((g - b) / delta) % 6;
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = max === 0 ? 0 : delta / max;
  return { h, s, v: max };
}

// ============================================================================
// Color3 → luix.palette extractor
// ============================================================================
//
// Cursor on a Color3 literal → *Save to `luix.palette`* code action.
// Prompts for a token name and writes the literal (in its existing
// form) to the user's `luix.palette` setting. The token then surfaces
// in the `Color3.` completion list everywhere — no rewrite of the
// existing literal itself, since Lua has no runtime `palette` table
// for `palette.primary` references to resolve through.

export class Color3PaletteExtractorProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorExtract,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    const text = document.getText();
    const masked = applyMask(text, buildCodeMask(text));
    const literals = extractColorLiterals(masked, text);
    const cursor = document.offsetAt(range.start);
    const hit = literals.find((c) => cursor >= c.start && cursor <= c.end);
    if (!hit) return undefined;
    const literalText = text.slice(hit.start, hit.end);
    const action = new vscode.CodeAction(
      `Save Color3 to \`luix.palette\`…`,
      vscode.CodeActionKind.RefactorExtract
    );
    action.command = {
      command: "luix.palette.addEntry",
      title: "Save Color3 to luix.palette",
      arguments: [literalText],
    };
    return [action];
  }
}

// ============================================================================
// Convert UDim2 between new / fromOffset / fromScale
// ============================================================================

export class UDim2ConvertCodeActionProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorRewrite,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    const text = document.getText();
    const cursor = document.offsetAt(range.start);
    // Find UDim2 calls on the cursor's line so we don't scan the
    // entire document for every code-action request.
    const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
    const lineEnd = text.indexOf("\n", cursor);
    const slice = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);

    const sliceCursor = cursor - lineStart;
    const re =
      /UDim2\.(new|fromOffset|fromScale)\s*\(\s*([^()]*?)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(slice)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (sliceCursor < start || sliceCursor > end) {
        continue;
      }
      const kind = m[1];
      const args = m[2]
        .split(",")
        .map((s) => s.trim())
        .map((s) => Number(s));
      if (args.some((n) => !Number.isFinite(n))) {
        return undefined;
      }
      let xScale: number;
      let xOffset: number;
      let yScale: number;
      let yOffset: number;
      if (kind === "new") {
        if (args.length !== 4) return undefined;
        [xScale, xOffset, yScale, yOffset] = args;
      } else if (kind === "fromOffset") {
        if (args.length !== 2) return undefined;
        [xOffset, yOffset] = args;
        xScale = 0;
        yScale = 0;
      } else {
        if (args.length !== 2) return undefined;
        [xScale, yScale] = args;
        xOffset = 0;
        yOffset = 0;
      }

      const literalRange = new vscode.Range(
        document.positionAt(lineStart + start),
        document.positionAt(lineStart + end)
      );

      const forms: Array<{
        id: string;
        text: string;
        label: string;
        expressible: boolean;
      }> = [
        {
          id: "new",
          text: `UDim2.new(${fmt(xScale)}, ${fmt(xOffset)}, ${fmt(yScale)}, ${fmt(yOffset)})`,
          label: "Convert to `UDim2.new(...)`",
          expressible: true,
        },
        {
          id: "fromOffset",
          text: `UDim2.fromOffset(${fmt(xOffset)}, ${fmt(yOffset)})`,
          label: "Convert to `UDim2.fromOffset(...)`",
          expressible: xScale === 0 && yScale === 0,
        },
        {
          id: "fromScale",
          text: `UDim2.fromScale(${fmt(xScale)}, ${fmt(yScale)})`,
          label: "Convert to `UDim2.fromScale(...)`",
          expressible: xOffset === 0 && yOffset === 0,
        },
      ];

      const actions: vscode.CodeAction[] = [];
      for (const form of forms) {
        if (form.id === kind || !form.expressible) {
          continue;
        }
        const action = new vscode.CodeAction(
          form.label,
          vscode.CodeActionKind.RefactorRewrite
        );
        action.edit = new vscode.WorkspaceEdit();
        action.edit.replace(document.uri, literalRange, form.text);
        actions.push(action);
      }
      return actions;
    }
    return undefined;
  }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toString();
}

// ============================================================================
// Wrap-in code actions — Frame / ScrollingFrame / Container w/ UIListLayout
// ============================================================================
//
// Pick an element at the cursor and replace it with a wrapper of one of
// three flavours, keeping the original as the wrapper's only child.
// Framework-aware — emits parens-form (`e(...)`) or curried-form
// (`New "..." {...}`, `create "..." {...}`) based on whichever factory
// the inner element already uses.

type WrapKind = "Frame" | "ScrollingFrame" | "ListContainer";

export class WrapInCodeActionProvider
  implements vscode.CodeActionProvider
{
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorRewrite,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.ProviderResult<vscode.CodeAction[]> {
    const text = document.getText();
    const selStart = document.offsetAt(range.start);
    const selEnd = document.offsetAt(range.end);
    const aliases = getAliasPartition();
    const calls = findAllCreateElementCalls(text, aliases);

    // Two cases to handle:
    //
    //   (a) Cursor / selection within a SINGLE element — wrap that one.
    //       Strategy: smallest call whose range contains the selection.
    //
    //   (b) Selection spans MULTIPLE sibling elements — wrap them as a
    //       group. Otherwise we'd wrap their common parent, which is
    //       what the user just complained about.
    //
    // Detect (b) by collecting calls *fully inside* the selection, then
    // keeping only the top-level ones (no other in-selection call
    // contains them). If at least one such top-level exists, wrap them.
    // Otherwise fall back to (a).
    const inSelection = calls.filter(
      (c) => c.aliasStart >= selStart && c.fullEnd <= selEnd
    );
    const topLevel = inSelection.filter(
      (c) =>
        !inSelection.some(
          (other) =>
            other !== c &&
            other.aliasStart < c.aliasStart &&
            other.fullEnd > c.fullEnd
        )
    );
    topLevel.sort((a, b) => a.aliasStart - b.aliasStart);

    let targets: typeof calls;
    if (topLevel.length > 0) {
      targets = topLevel;
    } else {
      let match: typeof calls[number] | undefined;
      for (const c of calls) {
        if (selStart >= c.aliasStart && selEnd <= c.fullEnd) {
          if (
            !match ||
            c.fullEnd - c.aliasStart < match.fullEnd - match.aliasStart
          ) {
            match = c;
          }
        }
      }
      if (!match) {
        return undefined;
      }
      targets = [match];
    }

    const first = targets[0];
    const last = targets[targets.length - 1];

    // Framework detection uses the first target's alias — siblings in
    // the same children list always share an alias anyway.
    const aliasText = first.alias ?? "";
    const spec = findFrameworkForAlias(aliasText);
    const curried = spec?.callShape === "curried";
    // The wrapper this action emits has to re-state any receiver the
    // wrapped call used, or a Fusion 0.3 `scope:New` becomes a bare
    // `New` with no scope to construct into.
    const aliasName = (first.receiver ?? "") + aliasText;

    const innerText = text.slice(first.aliasStart, last.fullEnd);
    const replaceRange = new vscode.Range(
      document.positionAt(first.aliasStart),
      document.positionAt(last.fullEnd)
    );
    const line = document.lineAt(document.positionAt(first.aliasStart).line);
    const baseIndent = /^[\s]*/.exec(line.text)?.[0] ?? "";
    const stepIndent = "\t";

    // Only ONE extra step needs to be added — the lines that come after
    // the slice's first line already carry their original indentation,
    // and the wrap shifts them all down by exactly one level. The old
    // `baseIndent + stepIndent` prefix double-indented every line.
    const indented = indentLines(innerText, stepIndent);

    const actions: vscode.CodeAction[] = [];
    for (const kind of ["Frame", "ScrollingFrame", "ListContainer"] as WrapKind[]) {
      const wrapped = renderWrapper(
        kind,
        aliasName,
        curried,
        spec?.childrenKey,
        indented,
        baseIndent,
        stepIndent
      );
      const action = new vscode.CodeAction(
        wrapTitle(kind),
        vscode.CodeActionKind.RefactorRewrite
      );
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, replaceRange, wrapped);
      actions.push(action);
    }
    return actions;
  }
}

function wrapTitle(kind: WrapKind): string {
  switch (kind) {
    case "Frame":
      return "Wrap in Frame";
    case "ScrollingFrame":
      return "Wrap in ScrollingFrame";
    case "ListContainer":
      return "Wrap in Frame + UIListLayout";
  }
}

function renderWrapper(
  kind: WrapKind,
  alias: string,
  curried: boolean,
  childrenKey: string | undefined,
  inner: string,
  baseIndent: string,
  step: string
): string {
  const lines: string[] = [];
  const wrapperClass = kind === "ScrollingFrame" ? "ScrollingFrame" : "Frame";
  const baseProps: string[] = [
    `Size = UDim2.fromScale(1, 1),`,
    `BackgroundTransparency = 1,`,
    `BorderSizePixel = 0,`,
  ];
  if (kind === "ScrollingFrame") {
    baseProps.push(`CanvasSize = UDim2.new(0, 0, 0, 0),`);
    baseProps.push(`AutomaticCanvasSize = Enum.AutomaticSize.Y,`);
    baseProps.push(`ScrollingDirection = Enum.ScrollingDirection.Y,`);
  }
  const innerIndent = baseIndent + step;
  if (curried) {
    lines.push(`${alias} "${wrapperClass}" {`);
    for (const p of baseProps) {
      lines.push(innerIndent + p);
    }
    if (kind === "ListContainer") {
      lines.push(
        innerIndent + `${alias} "UIListLayout" {`,
        innerIndent + step + `FillDirection = Enum.FillDirection.Vertical,`,
        innerIndent + step + `Padding = UDim.new(0, 8),`,
        innerIndent + step + `SortOrder = Enum.SortOrder.LayoutOrder,`,
        innerIndent + `},`
      );
    }
    if (childrenKey) {
      lines.push(innerIndent + `[${childrenKey}] = {`);
      lines.push(innerIndent + step + inner.trimStart() + ",");
      lines.push(innerIndent + `},`);
    } else {
      // Vide-style inline child.
      lines.push(innerIndent + inner.trimStart() + ",");
    }
    lines.push(baseIndent + `}`);
  } else {
    // Parens form (e / React.createElement / Roact.createElement).
    lines.push(`${alias}("${wrapperClass}", {`);
    for (const p of baseProps) {
      lines.push(innerIndent + p);
    }
    lines.push(`${baseIndent}}, {`);
    if (kind === "ListContainer") {
      lines.push(
        `${innerIndent}${alias}("UIListLayout", {`,
        `${innerIndent}${step}FillDirection = Enum.FillDirection.Vertical,`,
        `${innerIndent}${step}Padding = UDim.new(0, 8),`,
        `${innerIndent}${step}SortOrder = Enum.SortOrder.LayoutOrder,`,
        `${innerIndent}}),`
      );
    }
    lines.push(innerIndent + inner.trimStart() + ",");
    lines.push(`${baseIndent}})`);
  }
  return lines.join("\n");
}

function indentLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : prefix + line))
    .join("\n");
}
