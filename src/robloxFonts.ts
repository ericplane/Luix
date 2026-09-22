import * as vscode from "vscode";
import { getConfig } from "./configCompat";

// ============================================================================
// Roblox font catalogue
// ============================================================================
//
// `Font.fromName("Gotham", Enum.FontWeight.Bold)` accepts a family
// string from Roblox's built-in catalogue. The set of valid families is
// well-known but huge; the *supported weights per family* is the
// trickier bit — most decorative fonts only ship `Regular`, while
// modern UI families (Gotham, Roboto, BuilderSans, SourceSans) cover
// the full enum.
//
// The data below is a hand-curated subset of the most-used families.
// Anything not listed will still type-check at runtime since Roblox
// silently falls back to `Regular` for unknown weights — but the
// dropdown only surfaces what we know works.

export interface RobloxFont {
  family: string;
  weights: RobloxFontWeight[];
  /** Bump in the sort order — tag the common modern UI fonts so they
   *  surface above the decorative ones. */
  popular?: boolean;
}

export type RobloxFontWeight =
  | "Thin"
  | "ExtraLight"
  | "Light"
  | "Regular"
  | "Medium"
  | "SemiBold"
  | "Bold"
  | "ExtraBold"
  | "Heavy";

const ALL_WEIGHTS: RobloxFontWeight[] = [
  "Thin",
  "ExtraLight",
  "Light",
  "Regular",
  "Medium",
  "SemiBold",
  "Bold",
  "ExtraBold",
  "Heavy",
];

const REGULAR_ONLY: RobloxFontWeight[] = ["Regular"];
const REGULAR_BOLD: RobloxFontWeight[] = ["Regular", "Bold"];

export const ROBLOX_FONTS: RobloxFont[] = [
  // ---- Modern UI defaults (full weight range) ----
  {
    family: "BuilderSans",
    weights: ["Thin", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold"],
    popular: true,
  },
  // Roblox now aliases `Gotham` / `GothamSSm` to Montserrat under the
  // hood (per the engine's font-removal table — the legacy `Enum.Font`
  // members `Gotham`, `GothamMedium`, `GothamBold`, `GothamBlack` all
  // redirect to Montserrat). Both the legacy name and the canonical
  // `Montserrat` are accepted by `Font.fromName`, so we keep Gotham in
  // the list AND offer Montserrat directly. Same weight set since
  // Montserrat ships the full nine weights.
  {
    family: "Montserrat",
    weights: ALL_WEIGHTS,
    popular: true,
  },
  {
    family: "Gotham",
    weights: ALL_WEIGHTS,
    popular: true,
  },
  {
    family: "GothamSSm",
    weights: ALL_WEIGHTS,
    popular: true,
  },
  { family: "Roboto", weights: ALL_WEIGHTS, popular: true },
  {
    family: "RobotoMono",
    weights: ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold"],
    popular: true,
  },
  {
    family: "RobotoCondensed",
    weights: ["Thin", "ExtraLight", "Light", "Regular", "Medium", "SemiBold", "Bold"],
    popular: true,
  },
  {
    family: "SourceSansPro",
    weights: ["ExtraLight", "Light", "Regular", "SemiBold", "Bold", "Heavy"],
    popular: true,
  },

  // ---- Sans / serif workhorses ----
  { family: "Arial", weights: REGULAR_BOLD },
  { family: "Garamond", weights: REGULAR_BOLD },
  { family: "Merriweather", weights: REGULAR_BOLD },
  { family: "Nunito", weights: ALL_WEIGHTS },
  { family: "Oswald", weights: ["Light", "Regular", "Medium", "SemiBold", "Bold"] },
  { family: "TitilliumWeb", weights: ["Light", "Regular", "SemiBold", "Bold", "ExtraBold"] },
  { family: "Ubuntu", weights: ["Light", "Regular", "Medium", "Bold"] },
  { family: "JosefinSans", weights: ["Light", "Regular", "Medium", "SemiBold", "Bold"] },
  { family: "Jura", weights: ["Light", "Regular", "Medium", "SemiBold", "Bold"] },
  { family: "GrenzeGotisch", weights: ["Light", "Regular", "Medium", "SemiBold", "Bold"] },

  // ---- Decorative / display (Regular only unless noted) ----
  { family: "Cartoon", weights: REGULAR_ONLY },
  { family: "Code", weights: REGULAR_ONLY },
  { family: "Highway", weights: REGULAR_ONLY },
  { family: "SciFi", weights: REGULAR_ONLY },
  { family: "Arcade", weights: REGULAR_ONLY },
  { family: "Fantasy", weights: REGULAR_ONLY },
  { family: "Antique", weights: REGULAR_ONLY },
  { family: "Bodoni", weights: REGULAR_ONLY },
  { family: "Fondamento", weights: REGULAR_ONLY },
  { family: "IndieFlower", weights: REGULAR_ONLY },
  { family: "LuckiestGuy", weights: REGULAR_ONLY },
  { family: "Michroma", weights: REGULAR_ONLY },
  { family: "MoulPali", weights: REGULAR_ONLY },
  { family: "PatrickHand", weights: REGULAR_ONLY },
  { family: "PermanentMarker", weights: REGULAR_ONLY },
  { family: "SpecialElite", weights: REGULAR_ONLY },
  { family: "AmaticSC", weights: REGULAR_BOLD },
  { family: "Bangers", weights: REGULAR_ONLY },
  { family: "Creepster", weights: REGULAR_ONLY },
  { family: "DenkOne", weights: REGULAR_ONLY },
  { family: "FredokaOne", weights: REGULAR_ONLY },
  { family: "Kalam", weights: ["Light", "Regular", "Bold"] },
  { family: "Sarpanch", weights: ALL_WEIGHTS },
];

const BUILTIN_BY_FAMILY = new Map<string, RobloxFont>(
  ROBLOX_FONTS.map((f) => [f.family, f])
);

/**
 * Pull user-defined custom fonts from the `luix.customFonts` setting,
 * filter out invalid entries, and merge with the built-in catalogue.
 * Custom fonts win on family-name collision so users can shadow a
 * built-in with their own weight list if needed.
 */
export function getEffectiveFonts(): {
  fonts: RobloxFont[];
  byName: Map<string, RobloxFont & { isCustom?: boolean }>;
} {
  const raw =
    getConfig<Record<string, unknown>>("customFonts", {}) ?? {};
  const customFonts: Array<RobloxFont & { isCustom: true }> = [];
  for (const [family, value] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9_-]+$/.test(family)) {continue;}
    if (!Array.isArray(value)) {continue;}
    const weights: RobloxFontWeight[] = [];
    for (const w of value) {
      if (typeof w === "string" && ALL_WEIGHTS.includes(w as RobloxFontWeight)) {
        weights.push(w as RobloxFontWeight);
      }
    }
    if (weights.length === 0) {continue;}
    customFonts.push({ family, weights, isCustom: true });
  }

  const byName = new Map<string, RobloxFont & { isCustom?: boolean }>();
  // Built-ins first so customs (added next) overwrite on collision.
  for (const f of ROBLOX_FONTS) {
    byName.set(f.family, f);
  }
  for (const f of customFonts) {
    byName.set(f.family, f);
  }
  return { fonts: Array.from(byName.values()), byName };
}

/** Look up a single family by name, considering custom fonts. */
export function getFontFamily(
  name: string
): (RobloxFont & { isCustom?: boolean }) | undefined {
  // Cheap path first: user has no custom fonts → use the built-in map.
  const builtin = BUILTIN_BY_FAMILY.get(name);
  if (builtin) {return builtin;}
  return getEffectiveFonts().byName.get(name);
}

// ============================================================================
// Family completion — fires inside `Font.fromName("…")`
// ============================================================================

export class FontFamilyCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const ctx = findFontFromNameStringArg(text, offset);
    if (!ctx) {return undefined;}

    // Range starts after the opening quote so VS Code's filter matches
    // the partial family name the user is typing — same approach as
    // the class-name provider for `e("Fr|")`.
    const replaceStart = ctx.stringStart + 1;
    const replaceEnd =
      ctx.stringEnd !== -1 ? ctx.stringEnd : offset;
    const range = new vscode.Range(
      document.positionAt(replaceStart),
      document.positionAt(replaceEnd)
    );

    const { fonts } = getEffectiveFonts();
    return fonts.map((font, index) => {
      const item = new vscode.CompletionItem(
        font.family,
        vscode.CompletionItemKind.Reference
      );
      const isCustom = (font as { isCustom?: boolean }).isCustom === true;
      item.detail = isCustom
        ? `Custom font · ${font.weights.length} weight${font.weights.length === 1 ? "" : "s"}`
        : `Roblox font · ${font.weights.length} weight${font.weights.length === 1 ? "" : "s"}`;
      item.documentation = new vscode.MarkdownString(
        `${isCustom ? "**Custom font** (from `luix.customFonts`)" : "**Roblox font**"} — \`${font.family}\`\n\nSupports: ${font.weights.join(", ")}`
      );
      item.filterText = font.family;
      // Sort order: custom fonts first (user-defined wins attention),
      // then popular built-ins, then everything else.
      const tier = isCustom ? "0" : font.popular ? "1" : "2";
      item.sortText = `${tier}_${String(index).padStart(3, "0")}`;
      item.range = range;
      item.insertText = font.family;
      return item;
    });
  }
}

/**
 * If the cursor sits inside the FIRST string arg of `Font.fromName(...)`,
 * return its bounds. Returns undefined for any other context.
 */
function findFontFromNameStringArg(
  text: string,
  cursor: number
): { stringStart: number; stringEnd: number; quote: '"' | "'" | "`" } | undefined {
  // Walk back to the opening quote (same line, identifier-only contents).
  let stringStart = -1;
  let quote: '"' | "'" | "`" | undefined;
  for (let i = cursor - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "\n") {return undefined;}
    if (c === '"' || c === "'" || c === "`") {
      stringStart = i;
      quote = c;
      break;
    }
  }
  if (stringStart === -1 || !quote) {return undefined;}

  // Inside the string up to the cursor must look like a family name.
  for (let i = stringStart + 1; i < cursor; i++) {
    const c = text[i];
    if (!/[A-Za-z0-9_]/.test(c)) {return undefined;}
  }

  // Forward scan for the closing quote.
  let stringEnd = -1;
  for (let i = cursor; i < text.length; i++) {
    if (text[i] === "\n") {break;}
    if (text[i] === quote) {
      stringEnd = i;
      break;
    }
    if (!/[A-Za-z0-9_]/.test(text[i])) {return undefined;}
  }

  // The opening quote must be preceded by `Font.fromName(`.
  const before = text.slice(Math.max(0, stringStart - 80), stringStart);
  if (!/\bFont\.fromName\s*\(\s*$/.test(before)) {
    return undefined;
  }
  return { stringStart, stringEnd, quote };
}

// ============================================================================
// Weight completion — fires after `Enum.FontWeight.`
// ============================================================================
//
// If we can detect the family from the surrounding `Font.fromName(...)`,
// suggest ONLY the weights that family supports. Otherwise (e.g. cursor
// is in some unrelated `Enum.FontWeight.X` reference), fall back to
// the full enum so we don't get in the way.

export class FontWeightCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const lineText = document.lineAt(position.line).text;
    const before = lineText.slice(0, position.character);
    if (!/\bEnum\.FontWeight\.$/.test(before)) {
      return undefined;
    }

    const text = document.getText();
    const offset = document.offsetAt(position);
    const family = findFontFamilyInCurrentCall(text, offset);
    const weights = family ? family.weights : ALL_WEIGHTS;

    const range = new vscode.Range(position, position);
    return weights.map((weight, index) => {
      const item = new vscode.CompletionItem(
        weight,
        vscode.CompletionItemKind.EnumMember
      );
      item.detail = family
        ? `${family.family} — supported weight`
        : "Enum.FontWeight";
      item.filterText = weight;
      item.sortText = String(index).padStart(2, "0");
      item.range = range;
      item.insertText = weight;
      return item;
    });
  }
}

/**
 * Scan back from `offset` looking for `Font.fromName("X"` on the same
 * line (or close by). Returns the matched font's catalogue entry if we
 * know it, undefined otherwise.
 */
function findFontFamilyInCurrentCall(
  text: string,
  offset: number
): RobloxFont | undefined {
  // Bound the search to ~200 chars back so we don't scan whole files.
  const start = Math.max(0, offset - 200);
  const slice = text.slice(start, offset);
  // Greedy on the last match — handles cases where multiple
  // `Font.fromName` calls appear on one line.
  const re = /\bFont\.fromName\s*\(\s*["'`]([A-Za-z0-9_-]+)["'`]/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    last = m;
  }
  if (!last) {return undefined;}
  return getFontFamily(last[1]);
}
