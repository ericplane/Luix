import * as vscode from "vscode";
import { getConfig } from "./configCompat";

// ============================================================================
// RichText tag data
// ============================================================================
//
// Tags supported by Roblox's RichText renderer (set `RichText = true` on a
// TextLabel/TextButton/TextBox). Snippets follow VS Code's syntax:
//   $1, $2, ...   → ordered tab stops
//   $0            → final cursor position
//   ${1|a,b,c|}   → choice tab stop
//
// Block tags include a close-tag in the snippet so completion + auto-close
// happen in one move.

interface RichTextTag {
  name: string;
  detail: string;
  /**
   * Snippet builder. `aq` is the attribute-quote char to use (the one
   * that does NOT match the enclosing Lua string's quote, so the inner
   * attribute values don't need backslash escaping).
   */
  snippet: (aq: '"' | "'") => string;
  selfClosing?: boolean;
}

/**
 * Per-tag list of attribute names that the inside-tag completion
 * suggests. Matches Roblox's RichText spec — `<font>` takes multiple of
 * `color size face family weight transparency` combined, etc.
 */
const TAG_ATTRIBUTES: Record<string, string[]> = {
  font: ["color", "size", "face", "family", "weight", "transparency"],
  stroke: ["color", "thickness", "transparency", "joins"],
  mark: ["color", "transparency"],
};

/**
 * Format a placeholder color according to the user's preferred form.
 * Roblox RichText accepts `#RRGGBB` and `rgb(R, G, B)` interchangeably,
 * but everyone has a preference and the snippet defaults should match
 * what the user actually types by hand.
 */
function formatColor(r: number, g: number, b: number): string {
  const fmt = getConfig<string>("richText.defaultColorFormat", "hex");
  if (fmt === "rgb") {
    return `rgb(${r}, ${g}, ${b})`;
  }
  const toHex = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Sensible default placeholder values per attribute, used by the
 * attribute-name snippets. `color` is resolved lazily via `formatColor`
 * so it respects `luix.richText.defaultColorFormat`.
 */
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
  // ---- Simple block tags ----
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

  // ---- Self-closing ----
  { name: "br", detail: "Line break", snippet: () => "<br/>", selfClosing: true },

  // ---- Attribute-bearing block tags ----
  {
    name: "font",
    detail: "Font styling — color / size / face / weight / transparency",
    // Leave the attribute slot empty and park the cursor inside the
    // tag — the attribute-name completion provider fires as soon as
    // the user starts typing, so they pick what they actually need
    // (`color`, `size`, `weight`, …) instead of getting `color` shoved
    // in by default. Tab → $0 lands inside the tag body once they're
    // done with attributes.
    snippet: () => `<font $1>$0</font>`,
  },
  {
    name: "stroke",
    detail: "Text stroke",
    // Same approach as `<font>`: empty attribute slot, attribute
    // completion fires inside the tag so the user picks from
    // `color`, `thickness`, `transparency`, `joins`.
    snippet: () => `<stroke $1>$0</stroke>`,
  },
  {
    name: "mark",
    detail: "Highlight background",
    // Empty attribute slot → attribute completion suggests `color`
    // and `transparency` on demand.
    snippet: () => `<mark $1>$0</mark>`,
  },
];

const RICH_TEXT_TAG_NAMES = new Set(RICH_TEXT_TAGS.map((t) => t.name));
const SELF_CLOSING_TAG_NAMES = new Set(
  RICH_TEXT_TAGS.filter((t) => t.selfClosing).map((t) => t.name)
);

// ============================================================================
// Context detection
// ============================================================================

/**
 * Quick line-scoped check: is `offset` inside a single-line `"..."`,
 * `'...'`, or Luau backtick `` `...` `` template string on its line?
 * Returns the outer quote char if so, else undefined. Multi-line /
 * long-bracket strings aren't considered (RichText `Text` props are
 * almost always single-line).
 */
function enclosingStringQuote(
  text: string,
  offset: number
): '"' | "'" | "`" | undefined {
  // Walk back to start of line.
  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") {
    lineStart--;
  }
  let quote: '"' | "'" | "`" | undefined;
  for (let i = lineStart; i < offset; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        i++; // skip escaped char
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

/**
 * Pick the attribute-quote char to use inside an outer Lua string. We
 * want one that doesn't match the outer delimiter so the attribute value
 * doesn't need backslash escaping. Backticks don't collide with either
 * `"` or `'`, so we default to `"` for the most familiar reading.
 */
function pickAttrQuote(outer: '"' | "'" | "`"): '"' | "'" {
  if (outer === '"') {
    return "'";
  }
  return '"';
}

// ============================================================================
// Open-tag detection — used by both attribute completion and auto-close
// ============================================================================

interface OpenTagContext {
  tagName: string;
  /** Whether the cursor is at a position where typing an attribute *name*
   *  would make sense (right after `<font ` or after a complete
   *  `attr="value" `), as opposed to inside an attribute value. */
  inAttrNameSlot: boolean;
}

/**
 * Forward-scan from the most recent `<` on the cursor's line to determine
 * what part of an open tag the cursor sits in. Returns undefined if the
 * cursor isn't inside an open `<tag …` at all (e.g. the tag is already
 * closed by `>`, or there's no `<` on this line, or the cursor is past
 * the closing `>`).
 */
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

  // Forward-scan attribute pairs until we either hit `offset` or `>`.
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
    // Attribute name.
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
    i++; // past `=`
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
      i++; // past closing quote
    } else {
      while (i < offset && !/\s/.test(text[i]) && text[i] !== ">") {
        i++;
      }
    }
  }

  return { tagName, inAttrNameSlot: true };
}

// ============================================================================
// Completion provider — tag list on `<`, attribute list inside open tag
// ============================================================================

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
    // Pick an attribute quote that doesn't collide with the outer Lua
    // string delimiter (avoids needing to backslash-escape attr values).
    const attrQuote = pickAttrQuote(outerQuote);

    // Tag-name slot? Cursor sits after `<` plus optional partial name.
    const tagSlot = matchTagNameSlot(text, offset);
    if (tagSlot) {
      return buildTagItems(document, tagSlot, attrQuote);
    }

    // Attribute-name slot inside an open `<font …>` / `<stroke …>` / `<mark …>`?
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
  /** Offset of the `<` that opens this tag-name slot. */
  ltOffset: number;
  /** Offset just past any partial tag-name letters already typed. */
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
  // Don't fire for closing tags `</`.
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
  // Cover any partial attr-name letters the user already typed so accepting
  // doesn't duplicate them.
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

// ============================================================================
// Auto-close handler — listens for `>` typed and inserts the matching close
// ============================================================================

/**
 * When the user types the `>` that closes an opening tag inside a string,
 * insert the matching `</tag>` after the cursor. Only fires for known
 * RichText tag names so unrelated angle brackets (generics, comparisons in
 * neighbouring code, …) are left alone.
 */
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

    // Cursor is now just past the `>` the user typed.
    const text = event.document.getText();
    const afterGt = event.document.offsetAt(change.range.start) + 1;

    // Walk back from `<` ignoring chars inside attribute values.
    const tagStart = findOpeningTagStart(text, afterGt - 1);
    if (tagStart === -1) {
      return;
    }
    const tagText = text.slice(tagStart, afterGt);
    // Self-closing form (`<br/>`) — no close needed.
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
    // If the user already has `</tagName>` immediately after, don't double.
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
    // Keep the cursor between `>` and `</tag>`.
    editor.selection = new vscode.Selection(insertPos, insertPos);
  });
  context.subscriptions.push(sub);
}

/**
 * Walk back from the `>` position to find the matching `<` of the tag,
 * skipping over `>` that appears inside quoted attribute values. Returns
 * -1 if no plausible opening tag start is found on the same line.
 */
function findOpeningTagStart(text: string, gtIndex: number): number {
  let i = gtIndex - 1;
  let inAttrString = false;
  let attrQuote: '"' | "'" | undefined;
  // Scan a bounded window — RichText tags are short.
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
      // Hit another `>` before finding the `<` — bail.
      return -1;
    } else if (c === "<") {
      return i;
    }
    i--;
  }
  return -1;
}

// ============================================================================
// RichText color picker — VS Code's built-in swatch for `color="…"` values
// ============================================================================
//
// VS Code only renders the inline color swatch / picker for ranges
// returned by a DocumentColorProvider. We scan `<font …>`, `<stroke …>`,
// and `<mark …>` for their `color` attribute and return one entry per
// occurrence. Both `#RGB` / `#RRGGBB` and `rgb(R, G, B)` forms are
// parsed; round-trip presentations preserve whichever form the user
// originally wrote so editing via the picker doesn't suddenly switch
// their codebase from hex to rgb (or vice-versa).

const COLOUR_BEARING_TAGS = new Set(["font", "stroke", "mark"]);

interface ParsedColor {
  r: number;
  g: number;
  b: number;
  /** Whether the source text was `rgb(...)` (true) or hex `#...` (false). */
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
    // Independent from `luix.colorPreview.enabled` — that one governs
    // the Color3.fromRGB / Color3.new swatch and is often disabled when
    // another Roblox-API extension supplies its own picker. Keeping
    // RichText's picker on its own toggle means users can have one
    // without the other.
    if (!getConfig<boolean>("richText.colorPicker", true)) {
      return [];
    }
    const text = document.getText();
    // Fast reject: only files that actually contain RichText tag chars
    // can have colour-bearing attributes. Cheap O(N) scan instead of a
    // full regex walk for files that have none.
    if (!text.includes("<")) {
      return [];
    }
    const out: vscode.ColorInformation[] = [];
    // Find each `<font|stroke|mark …>` open tag; within its attribute
    // span, find every `color="…"` / `color='…'`.
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
          cm.index + cm[0].indexOf(cm[1]) + 1; // past `color=` + opening quote
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
