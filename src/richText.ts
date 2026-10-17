import * as vscode from "vscode";
import { getConfig } from "./configCompat";

// RichText tag snippets include closing tags and VS Code tab stops.

interface RichTextTag {
  name: string;
  detail: string;
  /** aq must differ from the surrounding Lua string's quote. */
  snippet: (aq: '"' | "'") => string;
  selfClosing?: boolean;
}

const TAG_ATTRIBUTES: Record<string, string[]> = {
  font: ["color", "size", "face", "family", "weight", "transparency"],
  stroke: ["color", "thickness", "transparency", "joins"],
  mark: ["color", "transparency"],
};

function formatColor(r: number, g: number, b: number): string {
  const fmt = getConfig<string>("richText.defaultColorFormat", "hex");
  if (fmt === "rgb") {
    return `rgb(${r}, ${g}, ${b})`;
  }
  const toHex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Resolve color placeholders lazily so settings changes take effect. */
function getAttrDefault(name: string): string {
  switch (name) {
    case "color":
      return formatColor(255, 255, 255);
    case "size":
      return "18";
    case "face":
      return "Gotham";
    case "family":
      return "rbxasset://fonts/families/SourceSansPro.json";
    case "weight":
      return "Bold";
    case "transparency":
      return "0";
    case "thickness":
      return "1";
    case "joins":
      return "round";
    default:
      return "";
  }
}

const RICH_TEXT_TAGS: RichTextTag[] = [
  { name: "b", detail: "Bold", snippet: () => "<b>$0</b>" },
  { name: "i", detail: "Italic", snippet: () => "<i>$0</i>" },
  { name: "u", detail: "Underline", snippet: () => "<u>$0</u>" },
  { name: "s", detail: "Strikethrough", snippet: () => "<s>$0</s>" },
  { name: "sc", detail: "Small caps", snippet: () => "<sc>$0</sc>" },
  { name: "smallcaps", detail: "Small caps", snippet: () => "<smallcaps>$0</smallcaps>" },
  { name: "uppercase", detail: "Force uppercase", snippet: () => "<uppercase>$0</uppercase>" },
  { name: "sub", detail: "Subscript", snippet: () => "<sub>$0</sub>" },
  { name: "sup", detail: "Superscript", snippet: () => "<sup>$0</sup>" },
  { name: "comment", detail: "Invisible comment", snippet: () => "<comment>$0</comment>" },

  { name: "br", detail: "Line break", snippet: () => "<br/>", selfClosing: true },

  {
    name: "font",
    detail: "Font styling — color / size / face / weight / transparency",
    // Leave attributes empty so completion can suggest the user's choice.
    snippet: () => `<font $1>$0</font>`,
  },
  {
    name: "stroke",
    detail: "Text stroke",
    snippet: () => `<stroke $1>$0</stroke>`,
  },
  {
    name: "mark",
    detail: "Highlight background",
    snippet: () => `<mark $1>$0</mark>`,
  },
];

const RICH_TEXT_TAG_NAMES = new Set(RICH_TEXT_TAGS.map((t) => t.name));
const SELF_CLOSING_TAG_NAMES = new Set(
  RICH_TEXT_TAGS.filter((t) => t.selfClosing).map((t) => t.name)
);

/** Detect single-line quoted or backtick strings; exclude long-bracket strings. */
function enclosingStringQuote(
  text: string,
  offset: number
): '"' | "'" | "`" | undefined {
  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") {
    lineStart--;
  }
  let quote: '"' | "'" | "`" | undefined;
  for (let i = lineStart; i < offset; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) {
        quote = undefined;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    }
  }
  return quote;
}

function pickAttrQuote(outer: '"' | "'" | "`"): '"' | "'" {
  if (outer === '"') {
    return "'";
  }
  return '"';
}

interface OpenTagContext {
  tagName: string;
  /** True between attributes, not inside a quoted value. */
  inAttrNameSlot: boolean;
}

function findEnclosingOpenTag(
  text: string,
  offset: number
): OpenTagContext | undefined {
  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") {
    lineStart--;
  }
  let tagStart = -1;
  for (let i = offset - 1; i >= lineStart; i--) {
    if (text[i] === "<") {
      tagStart = i;
      break;
    }
    if (text[i] === ">") {
      return undefined;
    }
  }
  if (tagStart === -1) {
    return undefined;
  }

  let i = tagStart + 1;
  if (text[i] === "/") {
    return undefined;
  }
  const nameMatch = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(text.slice(i));
  if (!nameMatch) {
    return undefined;
  }
  const tagName = nameMatch[1];
  i += tagName.length;

  while (i < offset) {
    const c = text[i];
    if (c === ">") {
      return undefined;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (!/[a-zA-Z]/.test(c)) {
      i++;
      continue;
    }
    while (i < offset && /[a-zA-Z0-9_-]/.test(text[i])) {
      i++;
    }
    if (i >= offset) {
      return { tagName, inAttrNameSlot: true };
    }
    while (i < offset && /\s/.test(text[i])) {
      i++;
    }
    if (i >= offset) {
      return { tagName, inAttrNameSlot: true };
    }
    if (text[i] !== "=") {
      continue;
    }
    i++;
    while (i < offset && /\s/.test(text[i])) {
      i++;
    }
    if (i >= offset) {
      return { tagName, inAttrNameSlot: false };
    }
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      i++;
      while (i < offset && text[i] !== q) {
        i++;
      }
      if (i >= offset) {
        return { tagName, inAttrNameSlot: false };
      }
      i++;
    } else {
      while (i < offset && !/\s/.test(text[i]) && text[i] !== ">") {
        i++;
      }
    }
  }

  return { tagName, inAttrNameSlot: true };
}

export class RichTextCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (!getConfig<boolean>("richText.enabled", true)) {
      return undefined;
    }
    const text = document.getText();
    const offset = document.offsetAt(position);
    const outerQuote = enclosingStringQuote(text, offset);
    if (!outerQuote) {
      return undefined;
    }
    const attrQuote = pickAttrQuote(outerQuote);

    const tagSlot = matchTagNameSlot(text, offset);
    if (tagSlot) {
      return buildTagItems(document, tagSlot, attrQuote);
    }

    const openTag = findEnclosingOpenTag(text, offset);
    if (openTag && openTag.inAttrNameSlot) {
      const attrs = TAG_ATTRIBUTES[openTag.tagName];
      if (attrs) {
        return buildAttributeItems(document, offset, openTag.tagName, attrs, attrQuote);
      }
    }

    return undefined;
  }
}

interface TagSlot {
  /** Offset of the opening <. */
  ltOffset: number;
  /** Exclusive end of the partial tag name. */
  endOffset: number;
}

function matchTagNameSlot(text: string, offset: number): TagSlot | undefined {
  let i = offset - 1;
  while (i >= 0 && /[a-zA-Z]/.test(text[i])) {
    i--;
  }
  if (text[i] !== "<") {
    return undefined;
  }
  // Do not complete closing tags.
  if (text[i + 1] === "/") {
    return undefined;
  }
  let endOffset = offset;
  while (endOffset < text.length && /[a-zA-Z]/.test(text[endOffset])) {
    endOffset++;
  }
  return { ltOffset: i, endOffset };
}

function buildTagItems(
  document: vscode.TextDocument,
  slot: TagSlot,
  attrQuote: '"' | "'"
): vscode.CompletionItem[] {
  const range = new vscode.Range(
    document.positionAt(slot.ltOffset),
    document.positionAt(slot.endOffset)
  );
  return RICH_TEXT_TAGS.map((tag, index) => {
    const item = new vscode.CompletionItem(
      `<${tag.name}>`,
      vscode.CompletionItemKind.Snippet
    );
    item.detail = `RichText — ${tag.detail}`;
    item.filterText = `<${tag.name}`;
    item.sortText = String(index).padStart(4, "0");
    item.range = range;
    item.insertText = new vscode.SnippetString(tag.snippet(attrQuote));
    return item;
  });
}

function buildAttributeItems(
  document: vscode.TextDocument,
  offset: number,
  tagName: string,
  attrs: string[],
  attrQuote: '"' | "'"
): vscode.CompletionItem[] {
  // Replace a partial attribute name instead of duplicating it.
  const text = document.getText();
  let start = offset;
  while (start > 0 && /[a-zA-Z0-9_-]/.test(text[start - 1])) {
    start--;
  }
  let end = offset;
  while (end < text.length && /[a-zA-Z0-9_-]/.test(text[end])) {
    end++;
  }
  const range = new vscode.Range(
    document.positionAt(start),
    document.positionAt(end)
  );
  return attrs.map((attr, index) => {
    const item = new vscode.CompletionItem(
      attr,
      vscode.CompletionItemKind.Property
    );
    item.detail = `RichText <${tagName}> attribute`;
    item.sortText = String(index).padStart(4, "0");
    item.range = range;
    const placeholder = getAttrDefault(attr);
    item.insertText = new vscode.SnippetString(
      `${attr}=${attrQuote}\${1:${placeholder}}${attrQuote}$0`
    );
    return item;
  });
}

/** Auto-close known RichText tags inside strings only. */
export function registerRichTextAutoClose(
  context: vscode.ExtensionContext
): void {
  const sub = vscode.workspace.onDidChangeTextDocument(async (event) => {
    if (!getConfig<boolean>("richText.enabled", true)) {
      return;
    }
    const lang = event.document.languageId;
    if (lang !== "lua" && lang !== "luau") {
      return;
    }
    if (event.contentChanges.length !== 1) {
      return;
    }
    const change = event.contentChanges[0];
    if (change.text !== ">") {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) {
      return;
    }

    const text = event.document.getText();
    const afterGt = event.document.offsetAt(change.range.start) + 1;

    const tagStart = findOpeningTagStart(text, afterGt - 1);
    if (tagStart === -1) {
      return;
    }
    const tagText = text.slice(tagStart, afterGt);
    if (tagText.endsWith("/>")) {
      return;
    }
    const nameMatch = /^<\s*([a-zA-Z][a-zA-Z0-9]*)\b/.exec(tagText);
    if (!nameMatch) {
      return;
    }
    const tagName = nameMatch[1];
    if (!RICH_TEXT_TAG_NAMES.has(tagName)) {
      return;
    }
    if (SELF_CLOSING_TAG_NAMES.has(tagName)) {
      return;
    }
    if (!enclosingStringQuote(text, afterGt)) {
      return;
    }
    const lookahead = text.slice(afterGt, afterGt + tagName.length + 3);
    if (lookahead === `</${tagName}>`) {
      return;
    }

    const insertPos = event.document.positionAt(afterGt);
    await editor.edit(
      (edit) => {
        edit.insert(insertPos, `</${tagName}>`);
      },
      { undoStopBefore: false, undoStopAfter: false }
    );
    // Keep the cursor between the opening and closing tags.
    editor.selection = new vscode.Selection(insertPos, insertPos);
  });
  context.subscriptions.push(sub);
}

/** Ignore angle brackets inside quoted attribute values. */
function findOpeningTagStart(text: string, gtIndex: number): number {
  let i = gtIndex - 1;
  let inAttrString = false;
  let attrQuote: '"' | "'" | undefined;
  // Bound scans to a short tag-sized window.
  const limit = Math.max(0, gtIndex - 300);
  while (i >= limit) {
    const c = text[i];
    if (c === "\n") {
      return -1;
    }
    if (inAttrString) {
      if (c === "\\") {
        i -= 2;
        continue;
      }
      if (c === attrQuote) {
        inAttrString = false;
        attrQuote = undefined;
      }
    } else if (c === '"' || c === "'") {
      inAttrString = true;
      attrQuote = c;
    } else if (c === ">") {
      return -1;
    } else if (c === "<") {
      return i;
    }
    i--;
  }
  return -1;
}

// Color picker edits preserve the original hex or rgb format.

const COLOUR_BEARING_TAGS = new Set(["font", "stroke", "mark"]);

interface ParsedColor {
  r: number;
  g: number;
  b: number;
  /** True for rgb(), false for hex. */
  isRgbForm: boolean;
}

function parseColorValue(value: string): ParsedColor | undefined {
  const trimmed = value.trim();
  const rgbMatch = /^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(
    trimmed
  );
  if (rgbMatch) {
    const r = clamp255(parseInt(rgbMatch[1], 10));
    const g = clamp255(parseInt(rgbMatch[2], 10));
    const b = clamp255(parseInt(rgbMatch[3], 10));
    return { r, g, b, isRgbForm: true };
  }
  const hex6 = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return {
      r: (n >> 16) & 0xff,
      g: (n >> 8) & 0xff,
      b: n & 0xff,
      isRgbForm: false,
    };
  }
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (hex3) {
    const r = parseInt(hex3[1][0] + hex3[1][0], 16);
    const g = parseInt(hex3[1][1] + hex3[1][1], 16);
    const b = parseInt(hex3[1][2] + hex3[1][2], 16);
    return { r, g, b, isRgbForm: false };
  }
  return undefined;
}

function clamp255(n: number): number {
  if (Number.isNaN(n)) {return 0;}
  if (n < 0) {return 0;}
  if (n > 255) {return 255;}
  return n;
}

export class RichTextColorProvider implements vscode.DocumentColorProvider {
  provideDocumentColors(
    document: vscode.TextDocument
  ): vscode.ProviderResult<vscode.ColorInformation[]> {
    if (!getConfig<boolean>("richText.enabled", true)) {
      return [];
    }
    // RichText and Color3 previews have independent settings.
    if (!getConfig<boolean>("richText.colorPicker", true)) {
      return [];
    }
    const text = document.getText();
    // Skip files without tag characters before scanning attributes.
    if (!text.includes("<")) {
      return [];
    }
    const out: vscode.ColorInformation[] = [];
    const tagRe = /<(font|stroke|mark)\b([^>\n]*)>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(text)) !== null) {
      if (!COLOUR_BEARING_TAGS.has(m[1].toLowerCase())) {
        continue;
      }
      const attrsText = m[2];
      const attrsStart = m.index + 1 + m[1].length;
      const colorRe = /\bcolor\s*=\s*(['"])([^'"\n]+)\1/gi;
      let cm: RegExpExecArray | null;
      while ((cm = colorRe.exec(attrsText)) !== null) {
        const parsed = parseColorValue(cm[2]);
        if (!parsed) {
          continue;
        }
        const valueOffsetInAttrs =
          cm.index + cm[0].indexOf(cm[1]) + 1;
        const valueStart = attrsStart + valueOffsetInAttrs;
        const valueEnd = valueStart + cm[2].length;
        out.push(
          new vscode.ColorInformation(
            new vscode.Range(
              document.positionAt(valueStart),
              document.positionAt(valueEnd)
            ),
            new vscode.Color(
              parsed.r / 255,
              parsed.g / 255,
              parsed.b / 255,
              1
            )
          )
        );
      }
    }
    return out;
  }

  provideColorPresentations(
    color: vscode.Color,
    context: { document: vscode.TextDocument; range: vscode.Range }
  ): vscode.ProviderResult<vscode.ColorPresentation[]> {
    const r = Math.round(color.red * 255);
    const g = Math.round(color.green * 255);
    const b = Math.round(color.blue * 255);
    const toHex = (n: number) =>
      n.toString(16).toUpperCase().padStart(2, "0");
    const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    const rgb = `rgb(${r}, ${g}, ${b})`;
    const original = context.document.getText(context.range).trim();
    const userPrefersRgb = /^rgb\b/i.test(original);
    return userPrefersRgb
      ? [new vscode.ColorPresentation(rgb), new vscode.ColorPresentation(hex)]
      : [new vscode.ColorPresentation(hex), new vscode.ColorPresentation(rgb)];
  }
}
