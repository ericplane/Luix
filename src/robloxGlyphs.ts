import * as vscode from "vscode";
import { configChangeAffects, getConfig } from "./configCompat";

// Name Roblox's private-use glyphs when editor fonts cannot render them.

export interface RobloxGlyph {
  codepoint: number;
  name: string;
  slug: string;
}

export const ROBLOX_GLYPHS: RobloxGlyph[] = [
  { codepoint: 0xe000, name: "Verified", slug: "verified" },
  { codepoint: 0xe001, name: "Premium", slug: "premium" },
  { codepoint: 0xe002, name: "Robux", slug: "robux" },
  { codepoint: 0xe003, name: "Roblox Plus", slug: "roblox-plus" },
];

const BY_CODEPOINT = new Map<number, RobloxGlyph>(
  ROBLOX_GLYPHS.map((g) => [g.codepoint, g])
);

const ANY_GLYPH_RE = new RegExp(
  "[" +
    ROBLOX_GLYPHS.map((g) => `\\u{${g.codepoint.toString(16)}}`).join("") +
    "]",
  "u"
);

function formatCodepoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

function formatHoverMarkdown(glyph: RobloxGlyph): vscode.MarkdownString {
  const hex = glyph.codepoint.toString(16).toUpperCase().padStart(4, "0");
  const md = new vscode.MarkdownString(
    `**Roblox glyph — ${glyph.name}**\n\n` +
      `Codepoint: \`${formatCodepoint(glyph.codepoint)}\`\n\n` +
      `Luau escape: \`\\u{${hex}}\`\n\n` +
      `_VS Code can't render this glyph, but it shows correctly in-game._`
  );
  md.isTrusted = false;
  return md;
}

function findGlyphOccurrences(
  document: vscode.TextDocument
): Array<{ glyph: RobloxGlyph; offset: number; length: number }> {
  const text = document.getText();
  if (!ANY_GLYPH_RE.test(text)) {
    return [];
  }
  const out: Array<{ glyph: RobloxGlyph; offset: number; length: number }> = [];
  // All supported codepoints are in the BMP; code-unit scanning is sufficient.
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    const glyph = BY_CODEPOINT.get(cp);
    if (glyph) {
      out.push({ glyph, offset: i, length: 1 });
    }
  }
  return out;
}

export class RobloxGlyphInlayHintsProvider
  implements vscode.InlayHintsProvider, vscode.Disposable
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints: vscode.Event<void> = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (configChangeAffects(e, "robloxGlyphs")) {
          this._onDidChange.fire();
        }
      })
    );
  }

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.ProviderResult<vscode.InlayHint[]> {
    if (!getConfig<boolean>("robloxGlyphs.enabled", true)) {
      return [];
    }
    const occurrences = findGlyphOccurrences(document);
    if (occurrences.length === 0) {
      return [];
    }
    const startOffset = document.offsetAt(range.start);
    const endOffset = document.offsetAt(range.end);
    const hints: vscode.InlayHint[] = [];
    for (const occ of occurrences) {
      if (occ.offset < startOffset || occ.offset > endOffset) {
        continue;
      }
      const pos = document.positionAt(occ.offset + occ.length);
      const hint = new vscode.InlayHint(
        pos,
        `${occ.glyph.name}`,
        vscode.InlayHintKind.Type
      );
      hint.paddingLeft = true;
      hint.paddingRight = true;
      hint.tooltip = formatHoverMarkdown(occ.glyph);
      hints.push(hint);
    }
    return hints;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this._onDidChange.dispose();
  }
}

export class RobloxGlyphHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    if (!getConfig<boolean>("robloxGlyphs.enabled", true)) {
      return undefined;
    }
    const line = document.lineAt(position.line).text;
    if (position.character >= line.length) {
      return undefined;
    }
    const cp = line.charCodeAt(position.character);
    const glyph = BY_CODEPOINT.get(cp);
    if (!glyph) {
      return undefined;
    }
    const range = new vscode.Range(
      position,
      position.translate(0, 1)
    );
    return new vscode.Hover(formatHoverMarkdown(glyph), range);
  }
}

export class RobloxGlyphCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (!getConfig<boolean>("robloxGlyphs.enabled", true)) {
      return undefined;
    }
    const text = document.getText();
    const offset = document.offsetAt(position);
    let i = offset - 1;
    while (i >= 0 && /[a-zA-Z0-9-]/.test(text[i])) {
      i--;
    }
    if (text[i] !== ":") {
      return undefined;
    }
    const colonOffset = i;
    if (!isInsideSingleLineString(text, colonOffset)) {
      return undefined;
    }

    const range = new vscode.Range(
      document.positionAt(colonOffset),
      document.positionAt(offset)
    );

    const builtins = ROBLOX_GLYPHS.map((glyph, index) => {
      const item = new vscode.CompletionItem(
        `:${glyph.slug}:`,
        vscode.CompletionItemKind.Constant
      );
      item.detail = `Roblox glyph — ${glyph.name} (${formatCodepoint(
        glyph.codepoint
      )})`;
      item.documentation = formatHoverMarkdown(glyph);
      item.filterText = `:${glyph.slug}`;
      item.sortText = String(index).padStart(4, "0");
      item.range = range;
      // Insert literal characters so ordinary Lua strings work too.
      item.insertText = String.fromCharCode(glyph.codepoint);
      return item;
    });

    // Custom slugs cannot shadow built-in glyphs.
    const custom = getCustomGlyphs();
    const builtinSlugs = new Set(ROBLOX_GLYPHS.map((g) => g.slug));
    const customItems: vscode.CompletionItem[] = [];
    let customIndex = ROBLOX_GLYPHS.length;
    for (const [slug, value] of Object.entries(custom)) {
      if (!slug || builtinSlugs.has(slug)) {
        continue;
      }
      const item = new vscode.CompletionItem(
        `:${slug}:`,
        vscode.CompletionItemKind.Constant
      );
      item.detail = `Custom glyph — inserts \`${value}\``;
      item.filterText = `:${slug}`;
      item.sortText = String(customIndex++).padStart(4, "0");
      item.range = range;
      item.insertText = value;
      customItems.push(item);
    }

    return [...builtins, ...customItems];
  }
}

function getCustomGlyphs(): Record<string, string> {
  const raw =
    getConfig<Record<string, unknown>>("robloxGlyphs.custom", {}) ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.length > 0) {
      out[k] = v;
    }
  }
  return out;
}

function isInsideSingleLineString(text: string, offset: number): boolean {
  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") {
    lineStart--;
  }
  let inString = false;
  let quote: '"' | "'" | "`" | undefined;
  for (let i = lineStart; i < offset; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) {
        inString = false;
        quote = undefined;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      inString = true;
      quote = c;
    }
  }
  return inString;
}
