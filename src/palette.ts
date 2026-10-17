import * as vscode from "vscode";
import { getConfig } from "./configCompat";

export type Palette = Record<string, string>;

export function getPalette(): Palette {
  return getConfig<Palette>("palette", {}) ?? {};
}

/** Insert full configured expressions; palette names are not runtime Color3 members. */
export class PaletteCompletionProvider
  implements vscode.CompletionItemProvider
{
  static readonly TRIGGER = ".";

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const lineText = document.lineAt(position.line).text;
    const before = lineText.slice(0, position.character);
    if (!/Color3\.$/.test(before)) {
      return undefined;
    }
    const palette = getPalette();
    const range = new vscode.Range(
      new vscode.Position(position.line, position.character - "Color3.".length),
      position
    );
    return [
      ...buildColor3Constructors(range),
      ...buildPaletteCompletions(palette, position),
    ];
  }
}

/** Constructor snippets preserve per-channel tab stops. */
function buildColor3Constructors(
  range: vscode.Range
): vscode.CompletionItem[] {
  const constructors: Array<{
    label: string;
    insert: string;
    detail: string;
  }> = [
    {
      label: "fromRGB",
      insert: "Color3.fromRGB(${1:255}, ${2:255}, ${3:255})",
      detail: "Color3 from 0-255 RGB channels",
    },
    {
      label: "fromHex",
      insert: 'Color3.fromHex("${1:#FFFFFF}")',
      detail: "Color3 from a `#RRGGBB` hex string",
    },
    {
      label: "new",
      insert: "Color3.new(${1:1}, ${2:1}, ${3:1})",
      detail: "Color3 from 0-1 RGB channels",
    },
    {
      label: "fromHSV",
      insert: "Color3.fromHSV(${1:0}, ${2:0}, ${3:1})",
      detail: "Color3 from 0-1 hue / saturation / value",
    },
  ];
  return constructors.map((c, i) => {
    const item = new vscode.CompletionItem(
      c.label,
      vscode.CompletionItemKind.Method
    );
    item.detail = c.detail;
    item.filterText = `Color3.${c.label}`;
    // List constructors before palette tokens.
    item.sortText = `0_${String(i).padStart(2, "0")}`;
    item.range = range;
    item.insertText = new vscode.SnippetString(c.insert);
    return item;
  });
}

export function buildPaletteCompletions(
  palette: Palette,
  position: vscode.Position
): vscode.CompletionItem[] {
  const entries = Object.entries(palette);
  if (entries.length === 0) {
    return [];
  }
  const range = new vscode.Range(
    new vscode.Position(position.line, position.character - "Color3.".length),
    position
  );
  return entries.map(([name, value], index) => {
    const item = new vscode.CompletionItem(
      `palette.${name}`,
      vscode.CompletionItemKind.Color
    );
    item.insertText = value;
    item.range = range;
    item.detail = value;
    item.documentation = new vscode.MarkdownString(
      `**Luix palette** — \`${name}\`\n\n\`${value}\``
    );
    item.filterText = `Color3.palette.${name}`;
    item.sortText = `1_${String(index).padStart(4, "0")}`;
    return item;
  });
}

// Offer configured spacing and font expressions alongside constructors.

export class SpacingCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const lineText = document.lineAt(position.line).text;
    const before = lineText.slice(0, position.character);
    if (!/UDim\.$/.test(before)) {
      return undefined;
    }
    const spacing = getConfig<Record<string, string>>("spacing", {}) ?? {};
    const range = new vscode.Range(
      new vscode.Position(
        position.line,
        position.character - "UDim.".length
      ),
      position
    );
    const items: vscode.CompletionItem[] = [...buildUDimConstructors(range)];
    Object.entries(spacing).forEach(([name, value], index) => {
      const item = new vscode.CompletionItem(
        `spacing.${name}`,
        vscode.CompletionItemKind.Unit
      );
      item.insertText = value;
      item.range = range;
      item.detail = value;
      item.documentation = new vscode.MarkdownString(
        `**Luix spacing token** — \`${name}\`\n\n\`${value}\``
      );
      item.filterText = `UDim.spacing.${name}`;
      item.sortText = `1_${String(index).padStart(4, "0")}`;
      items.push(item);
    });
    return items;
  }
}

function buildUDimConstructors(range: vscode.Range): vscode.CompletionItem[] {
  const constructors = [
    {
      label: "new",
      insert: "UDim.new(${1:0}, ${2:0})",
      detail: "UDim from scale (0-1) + offset (px)",
    },
  ];
  return constructors.map((c, i) => {
    const item = new vscode.CompletionItem(
      c.label,
      vscode.CompletionItemKind.Method
    );
    item.detail = c.detail;
    item.filterText = `UDim.${c.label}`;
    item.sortText = `0_${String(i).padStart(2, "0")}`;
    item.range = range;
    item.insertText = new vscode.SnippetString(c.insert);
    return item;
  });
}

export class FontsCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const lineText = document.lineAt(position.line).text;
    const before = lineText.slice(0, position.character);
    if (!/\bFont\.$/.test(before)) {
      return undefined;
    }
    const fonts = getConfig<Record<string, string>>("fonts", {}) ?? {};
    const range = new vscode.Range(
      new vscode.Position(
        position.line,
        position.character - "Font.".length
      ),
      position
    );
    const items: vscode.CompletionItem[] = [...buildFontConstructors(range)];
    Object.entries(fonts).forEach(([name, value], index) => {
      const item = new vscode.CompletionItem(
        `fonts.${name}`,
        vscode.CompletionItemKind.Reference
      );
      item.insertText = value;
      item.range = range;
      item.detail = value;
      item.documentation = new vscode.MarkdownString(
        `**Luix font token** — \`${name}\`\n\n\`${value}\``
      );
      item.filterText = `Font.fonts.${name}`;
      item.sortText = `1_${String(index).padStart(4, "0")}`;
      items.push(item);
    });
    return items;
  }
}

function buildFontConstructors(range: vscode.Range): vscode.CompletionItem[] {
  // Roblox maps legacy Gotham fonts to Montserrat.
  const defaultFamily =
    getConfig<string>("font.defaultFamily", "Montserrat") || "Montserrat";
  const constructors = [
    {
      label: "fromName",
      insert: `Font.fromName("\${1:${defaultFamily}}", Enum.FontWeight.\${2:Regular})`,
      detail: "Font from a Roblox font family name + weight",
    },
    {
      label: "fromId",
      insert: "Font.fromId(${1:12187365364}, Enum.FontWeight.${2:Regular})",
      detail: "Font from an uploaded asset id + weight",
    },
  ];
  return constructors.map((c, i) => {
    const item = new vscode.CompletionItem(
      c.label,
      vscode.CompletionItemKind.Method
    );
    item.detail = c.detail;
    item.filterText = `Font.${c.label}`;
    item.sortText = `0_${String(i).padStart(2, "0")}`;
    item.range = range;
    item.insertText = new vscode.SnippetString(c.insert);
    return item;
  });
}
