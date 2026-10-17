import * as vscode from "vscode";
import {
  getPropType,
  classHierarchy,
  defaultPropsMap,
  findIntroducingClass,
  findIntroducingEventClass,
  flattenClassEvents,
  flattenClassProps,
} from "./data";
import {
  CallTreeNode,
  DocumentComponentInfo,
  applyMask,
  buildCallTree,
  buildCodeMask,
  extractColorLiterals,
  findEnclosingPropsCall,
  scanDocument,
} from "./parser";
import {
  FRAMEWORKS,
  findFrameworkForAlias,
  getAliasPartition,
  getEnabledFrameworks,
} from "./frameworks";
import { configChangeAffects, getConfig } from "./configCompat";
import { WorkspaceIndex } from "./workspaceIndex";
import { fetchAssetThumbnail } from "./assetThumbnails";
import { documentDirectCalls, findDocumentCalls } from "./documentCalls";

export class Color3DocumentColorProvider
  implements vscode.DocumentColorProvider
{
  provideDocumentColors(
    document: vscode.TextDocument
  ): vscode.ProviderResult<vscode.ColorInformation[]> {
    if (!getConfig<boolean>("colorPreview.enabled", true)) {
      return [];
    }
    const text = document.getText();
    if (!text.includes("Color3.")) {
      return [];
    }
    const masked = applyMask(text, buildCodeMask(text));
    return extractColorLiterals(masked, text).map((c) => {
      const range = new vscode.Range(
        document.positionAt(c.start),
        document.positionAt(c.end)
      );
      return new vscode.ColorInformation(
        range,
        new vscode.Color(c.r, c.g, c.b, 1)
      );
    });
  }

  provideColorPresentations(
    color: vscode.Color,
    context: { document: vscode.TextDocument; range: vscode.Range }
  ): vscode.ProviderResult<vscode.ColorPresentation[]> {
    const r255 = Math.round(color.red * 255);
    const g255 = Math.round(color.green * 255);
    const b255 = Math.round(color.blue * 255);
    const fmt = (n: number) =>
      Number.isInteger(n) ? n.toString() : n.toFixed(3);
    const toHex = (n: number) =>
      n.toString(16).toUpperCase().padStart(2, "0");
    const hex = `#${toHex(r255)}${toHex(g255)}${toHex(b255)}`;
    const hsv = rgbToHsv(color.red, color.green, color.blue);

    const presentations = {
      fromRGB: new vscode.ColorPresentation(
        `Color3.fromRGB(${r255}, ${g255}, ${b255})`
      ),
      new: new vscode.ColorPresentation(
        `Color3.new(${fmt(color.red)}, ${fmt(color.green)}, ${fmt(color.blue)})`
      ),
      fromHex: new vscode.ColorPresentation(`Color3.fromHex("${hex}")`),
      fromHSV: new vscode.ColorPresentation(
        `Color3.fromHSV(${fmt(hsv.h)}, ${fmt(hsv.s)}, ${fmt(hsv.v)})`
      ),
    };

    // Prefer the existing Color3 form to preserve it through edits.
    const original = context.document.getText(context.range);
    const order: Array<keyof typeof presentations> = (() => {
      if (/Color3\.fromHex/.test(original)) {
        return ["fromHex", "fromRGB", "new", "fromHSV"];
      }
      if (/Color3\.fromHSV/.test(original)) {
        return ["fromHSV", "fromRGB", "fromHex", "new"];
      }
      if (/Color3\.new/.test(original)) {
        return ["new", "fromRGB", "fromHex", "fromHSV"];
      }
      return ["fromRGB", "new", "fromHex", "fromHSV"];
    })();
    return order.map((k) => presentations[k]);
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
    if (h < 0) {
      h += 1;
    }
  }
  const s = max === 0 ? 0 : delta / max;
  return { h, s, v: max };
}

export class PropHoverProvider implements vscode.HoverProvider {
  constructor(private readonly workspaceIndex?: WorkspaceIndex) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const text = document.getText();
    const cursorOffset = document.offsetAt(position);
    const aliases = getAliasPartition();

    const assetHover = await tryAssetHover(document, position, text);
    if (assetHover) {
      return assetHover;
    }

    const calls = findDocumentCalls(text, this.workspaceIndex);
    for (const call of calls) {
      if (
        cursorOffset >= call.classNameStart &&
        cursorOffset <= call.classNameEnd &&
        !call.isStringLiteralName
      ) {
        const md = await this.buildComponentHover(document, call.className);
        if (md) {
          return new vscode.Hover(
            md,
            new vscode.Range(
              document.positionAt(call.classNameStart),
              document.positionAt(call.classNameEnd)
            )
          );
        }
      }
    }

    const directCalls = documentDirectCalls(text, this.workspaceIndex);
    const detected = findEnclosingPropsCall(
      text,
      cursorOffset,
      aliases,
      new Set([...(directCalls.componentNames ?? []), ...(directCalls.instanceNames ?? [])])
    );
    if (!detected) {
      return undefined;
    }
    const wordRange = document.getWordRangeAtPosition(
      position,
      /[A-Za-z_][A-Za-z0-9_]*/
    );
    if (!wordRange) {
      return undefined;
    }
    const word = document.getText(wordRange);

    const customDirect = detected.isDirectComponentCall === true &&
      directCalls.componentNames?.has(detected.className) === true;
    if (!customDirect && defaultPropsMap[detected.className]) {
      const props = flattenClassProps(detected.className);
      if (props.includes(word)) {
        const md = buildPropHoverMarkdown(detected.className, word);
        return new vscode.Hover(md, wordRange);
      }
      // Treat direct instance calls as Vide so plain event and Parent keys get hovers.
      let framework = detected.alias
        ? findFrameworkForAlias(detected.alias)
        : undefined;
      if (
        !framework &&
        detected.isDirectComponentCall &&
        classHierarchy[detected.className]
      ) {
        framework = FRAMEWORKS.vide;
      }
      const isEvent = flattenClassEvents(detected.className).includes(word);
      if (
        isEvent &&
        ((framework?.eventsAsProps && isTableKey(document, wordRange)) ||
          isComputedEventKey(document, wordRange))
      ) {
        const md = buildEventHoverMarkdown(detected.className, word);
        return new vscode.Hover(md, wordRange);
      }
      if (
        framework?.parentAsProp &&
        word === "Parent" &&
        isTableKey(document, wordRange)
      ) {
        const md = buildParentHoverMarkdown(detected.className);
        return new vscode.Hover(md, wordRange);
      }
      return undefined;
    }

    const component = await this.findComponent(document, detected.className);
    if (!component) {
      return undefined;
    }
    const md =
      buildCustomPropHover(component, detected.className, word) ??
      buildCustomEventHover(
        component,
        detected.className,
        word,
        document,
        wordRange,
        detected.alias
      );
    if (!md) {
      return undefined;
    }
    return new vscode.Hover(md, wordRange);
  }

  private async buildComponentHover(
    document: vscode.TextDocument,
    name: string
  ): Promise<vscode.MarkdownString | undefined> {
    const component = await this.findComponent(document, name);
    if (!component) {
      return undefined;
    }
    return buildComponentMarkdown(component, name);
  }

  private async findComponent(
    document: vscode.TextDocument,
    name: string
  ): Promise<DocumentComponentInfo | undefined> {
    const lookup = name.split(".").pop() ?? name;
    const same = scanDocument(document.getText(), getAliasPartition()).get(
      lookup
    );
    if (same) {
      return same;
    }
    if (!this.workspaceIndex) {
      return undefined;
    }
    return this.workspaceIndex.findComponent(name, document.uri.toString());
  }
}

function buildComponentMarkdown(
  component: DocumentComponentInfo,
  invokedAs: string
): vscode.MarkdownString {
  const lines: string[] = [];
  lines.push(`**${invokedAs}** — custom component`);
  const base = component.annotations.extendsClass ?? component.detectedBase;
  if (base) {
    lines.push(`Extends \`${base}\`.`);
  }
  const props = collectKnownProps(component);
  if (props.length > 0) {
    lines.push("");
    lines.push("**Props:**");
    for (const p of props) {
      lines.push(`- \`${p}\``);
    }
  }
  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  return md;
}

function buildCustomPropHover(
  component: DocumentComponentInfo,
  invokedAs: string,
  propName: string
): vscode.MarkdownString | undefined {
  const props = collectKnownProps(component);
  if (!props.includes(propName)) {
    return undefined;
  }
  const lines: string[] = [];
  lines.push(`**${invokedAs}.${propName}**`);
  const base = component.annotations.extendsClass ?? component.detectedBase;
  if (base && flattenClassProps(base).includes(propName)) {
    lines.push(`Forwarded from \`${base}.${propName}\`.`);
    const type = getPropType(base, propName);
    if (type) {
      lines.push(`Type: \`${type}\``);
    }
  } else {
    lines.push("Component-defined prop.");
  }
  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  return md;
}

/** Use the thumbnails API's CDN URL; VS Code hovers do not follow the legacy redirect endpoint. */
async function tryAssetHover(
  document: vscode.TextDocument,
  position: vscode.Position,
  _text: string
): Promise<vscode.Hover | undefined> {
  const lineText = document.lineAt(position.line).text;
  let start = position.character;
  let quote: string | undefined;
  for (let i = position.character - 1; i >= 0; i--) {
    const c = lineText[i];
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      start = i;
      break;
    }
  }
  if (!quote) {
    return undefined;
  }
  let end = position.character;
  for (let i = position.character; i < lineText.length; i++) {
    if (lineText[i] === quote) {
      end = i + 1;
      break;
    }
  }
  if (end === position.character) {
    return undefined;
  }
  const inner = lineText.slice(start + 1, end - 1);
  const m = /^rbxasset(?:id)?:\/\/(\d+)$/.exec(inner.trim());
  if (!m) {
    return undefined;
  }
  const assetId = m[1];
  const range = new vscode.Range(
    new vscode.Position(position.line, start),
    new vscode.Position(position.line, end)
  );
  const { url: cdnUrl, state } = await fetchAssetThumbnail(assetId);
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportHtml = false;
  if (cdnUrl) {
    md.appendMarkdown(
      `**Roblox asset \`${assetId}\`**\n\n![](${cdnUrl})\n\n[Open on roblox.com ↗](https://www.roblox.com/library/${assetId})`
    );
  } else {
    let reason: string;
    switch (state) {
      case "Pending":
      case "InReview":
        reason =
          "Roblox is still generating the thumbnail — hover again in a few seconds.";
        break;
      case "Error":
      case "TemporarilyUnavailable":
        reason =
          "Roblox's thumbnail API is temporarily unavailable — hover again in a moment.";
        break;
      case "Blocked":
      case "Moderated":
        reason = "Asset has been moderated or removed.";
        break;
      default:
        reason =
          "Thumbnail unavailable (asset may not exist, or the API is unreachable).";
    }
    md.appendMarkdown(
      `**Roblox asset \`${assetId}\`**\n\n_${reason}_\n\n[Open on roblox.com ↗](https://www.roblox.com/library/${assetId})`
    );
  }
  return new vscode.Hover(md, range);
}

function collectKnownProps(component: DocumentComponentInfo): string[] {
  const out: string[] = [];
  const known = new Set<string>();
  const push = (xs: string[] | undefined) => {
    if (!xs) {return;}
    for (const x of xs) {
      if (!known.has(x)) {
        known.add(x);
        out.push(x);
      }
    }
  };
  push(component.annotations.props);
  push(component.paramTypeFields);
  const base = component.annotations.extendsClass ?? component.detectedBase;
  if (base) {
    push(flattenClassProps(base));
  }
  return out;
}

function buildPropHoverMarkdown(
  className: string,
  propName: string
): vscode.MarkdownString {
  const type = getPropType(className, propName);
  const introduced = findIntroducingClass(className, propName);
  const docsAnchor = introduced ?? className;
  const docsUrl = `https://create.roblox.com/docs/reference/engine/classes/${docsAnchor}#${propName}`;

  const lines: string[] = [];
  lines.push(`**${className}.${propName}**`);
  lines.push("");
  if (type) {
    lines.push(`Type: \`${type}\``);
  }
  if (introduced && introduced !== className) {
    lines.push(`Inherited from \`${introduced}\`.`);
  }
  lines.push("");
  lines.push(`[Roblox docs ↗](${docsUrl})`);

  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  return md;
}

/** Require an assignment key so value identifiers do not get event or Parent hovers. */
function isTableKey(
  document: vscode.TextDocument,
  wordRange: vscode.Range
): boolean {
  const from = document.offsetAt(wordRange.end);
  const rest = document.getText().slice(from, from + 64);
  return /^\s*=(?!=)/.test(rest);
}

function isComputedEventKey(
  document: vscode.TextDocument,
  wordRange: vscode.Range
): boolean {
  const before = document
    .lineAt(wordRange.start.line)
    .text.slice(0, wordRange.start.character);
  return /(?:React|Roact)\s*\.\s*Event\s*\.\s*$/.test(before) ||
    /\bOnEvent\s*\(?\s*["']$/.test(before);
}

// Roblox documents Changed on Object, although the data model files it under Instance.
const EVENT_DOCS_CLASS_OVERRIDE: Record<string, string> = {
  Changed: "Object",
};

function buildEventHoverMarkdown(
  className: string,
  eventName: string
): vscode.MarkdownString {
  const introduced = findIntroducingEventClass(className, eventName);
  const docsAnchor =
    EVENT_DOCS_CLASS_OVERRIDE[eventName] ?? introduced ?? className;
  const docsUrl = `https://create.roblox.com/docs/reference/engine/classes/${docsAnchor}#${eventName}`;

  const lines: string[] = [];
  lines.push(`**${className}.${eventName}**`);
  lines.push("");
  lines.push("Event — the handler is connected when the instance is created.");
  if (introduced && introduced !== className) {
    lines.push(`Inherited from \`${introduced}\`.`);
  }
  lines.push("");
  lines.push(`[Roblox docs ↗](${docsUrl})`);

  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  return md;
}

function buildCustomEventHover(
  component: DocumentComponentInfo,
  invokedAs: string,
  word: string,
  document: vscode.TextDocument,
  wordRange: vscode.Range,
  alias: string | undefined
): vscode.MarkdownString | undefined {
  const base = component.annotations.extendsClass ?? component.detectedBase;
  if (!base || !flattenClassEvents(base).includes(word)) {
    return undefined;
  }
  // Direct calls lack an alias; allow plain event keys only when events-as-props is enabled.
  const framework = alias ? findFrameworkForAlias(alias) : undefined;
  const eventsAsProps = framework
    ? framework.eventsAsProps
    : getEnabledFrameworks().some((f) => f.eventsAsProps);
  const plainKey = eventsAsProps && isTableKey(document, wordRange);
  if (!plainKey && !isComputedEventKey(document, wordRange)) {
    return undefined;
  }
  const introduced = findIntroducingEventClass(base, word);
  const docsAnchor = EVENT_DOCS_CLASS_OVERRIDE[word] ?? introduced ?? base;
  const docsUrl = `https://create.roblox.com/docs/reference/engine/classes/${docsAnchor}#${word}`;

  const lines: string[] = [];
  lines.push(`**${invokedAs}.${word}**`);
  lines.push("");
  lines.push(`Event forwarded from \`${base}.${word}\`.`);
  lines.push("");
  lines.push(`[Roblox docs ↗](${docsUrl})`);

  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  return md;
}

function buildParentHoverMarkdown(className: string): vscode.MarkdownString {
  const docsUrl =
    "https://create.roblox.com/docs/reference/engine/classes/Instance#Parent";
  const lines: string[] = [];
  lines.push(`**${className}.Parent**`);
  lines.push("");
  lines.push("Type: `Instance`");
  lines.push("");
  lines.push(
    "Mounts the created instance under the given parent. Fusion and Vide apply it after the other properties so the instance appears fully configured."
  );
  lines.push("");
  lines.push(`[Roblox docs ↗](${docsUrl})`);

  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  return md;
}

export class CreateElementInlayHintsProvider
  implements vscode.InlayHintsProvider, vscode.Disposable
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints: vscode.Event<void> =
    this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  private selectionDebounce: NodeJS.Timeout | undefined;

  constructor(private readonly workspaceIndex?: WorkspaceIndex) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(() => {
        const scope = getConfig<string>(
          "inlayHints.scope",
          "ancestors"
        );
        if (scope === "all") {
          return;
        }
        if (this.selectionDebounce) {
          clearTimeout(this.selectionDebounce);
        }
        this.selectionDebounce = setTimeout(() => {
          this.selectionDebounce = undefined;
          this._onDidChange.fire();
        }, 80);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (configChangeAffects(e, "inlayHints")) {
          this._onDidChange.fire();
        }
      })
    );
  }

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.ProviderResult<vscode.InlayHint[]> {
    if (!getConfig<boolean>("inlayHints.enabled", true)) {
      return [];
    }
    const scope = getConfig<string>("inlayHints.scope", "ancestors");
    const position = getConfig<string>(
      "inlayHints.position",
      "after-comma"
    );

    const text = document.getText();
    const calls = findDocumentCalls(text, this.workspaceIndex);
    const hints: vscode.InlayHint[] = [];

    let cursorOffset: number | undefined;
    if (scope === "ancestors") {
      const editor = vscode.window.activeTextEditor;
      if (
        editor &&
        editor.document.uri.toString() === document.uri.toString()
      ) {
        cursorOffset = document.offsetAt(editor.selection.active);
      }
    }

    for (const call of calls) {
      const openPos = document.positionAt(call.aliasStart);
      const closePos = document.positionAt(call.fullEnd);
      if (openPos.line === closePos.line) {
        continue;
      }
      if (closePos.line < range.start.line || openPos.line > range.end.line) {
        continue;
      }

      if (scope === "ancestors") {
        if (cursorOffset === undefined) {
          continue;
        }
        if (cursorOffset < call.aliasStart || cursorOffset > call.fullEnd) {
          continue;
        }
      }

      let hintOffset = call.fullEnd;
      if (position === "after-comma" && text[call.fullEnd] === ",") {
        hintOffset = call.fullEnd + 1;
      }
      const hintPos = document.positionAt(hintOffset);
      // VS Code accepts hints only inside the requested range, even for enclosing calls.
      if (!range.contains(hintPos)) {
        continue;
      }

      const label = call.nameProp
        ? `▸ ${call.className} (${call.nameProp})`
        : `▸ ${call.className}`;

      const hint = new vscode.InlayHint(
        hintPos,
        ` ${label}`,
        vscode.InlayHintKind.Type
      );
      hint.paddingLeft = true;
      hints.push(hint);
    }

    return hints;
  }

  dispose(): void {
    if (this.selectionDebounce) {
      clearTimeout(this.selectionDebounce);
      this.selectionDebounce = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}

export class CreateElementSymbolProvider
  implements vscode.DocumentSymbolProvider
{
  constructor(private readonly workspaceIndex?: WorkspaceIndex) {}

  provideDocumentSymbols(
    document: vscode.TextDocument
  ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
    if (!getConfig<boolean>("documentSymbols.enabled", true)) {
      return [];
    }
    const text = document.getText();
    const calls = findDocumentCalls(text, this.workspaceIndex);
    const tree = buildCallTree(calls);
    return tree.map((node) => this.nodeToSymbol(document, node));
  }

  private nodeToSymbol(
    document: vscode.TextDocument,
    node: CallTreeNode
  ): vscode.DocumentSymbol {
    const call = node.call;
    const fullRange = new vscode.Range(
      document.positionAt(call.aliasStart),
      document.positionAt(call.fullEnd)
    );
    const selectionRange = new vscode.Range(
      document.positionAt(call.classNameStart),
      document.positionAt(call.classNameEnd)
    );

    const name = call.nameProp
      ? `${call.className} (${call.nameProp})`
      : call.className;

    const kind = call.isStringLiteralName || call.isDirectInstanceCall
      ? vscode.SymbolKind.Object
      : vscode.SymbolKind.Function;

    const symbol = new vscode.DocumentSymbol(
      name,
      call.isStringLiteralName || call.isDirectInstanceCall ? "" : "(component)",
      kind,
      fullRange,
      selectionRange
    );

    symbol.children = node.children.map((child) =>
      this.nodeToSymbol(document, child)
    );

    return symbol;
  }
}
