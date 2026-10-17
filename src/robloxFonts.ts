import * as vscode from "vscode";
import { getConfig } from "./configCompat";

export interface RobloxFont {
  family: string;
  weights: RobloxFontWeight[];
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
  {
    family: "BuilderSans",
    weights: ["Thin", "Light", "Regular", "Medium", "SemiBold", "Bold", "ExtraBold"],
    popular: true,
  },
  // Gotham aliases Montserrat; both family names remain accepted.
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
  // Custom fonts override built-ins with the same family name.
  for (const f of ROBLOX_FONTS) {
    byName.set(f.family, f);
  }
  for (const f of customFonts) {
    byName.set(f.family, f);
  }
  return { fonts: Array.from(byName.values()), byName };
}

export function getFontFamily(
  name: string
): (RobloxFont & { isCustom?: boolean }) | undefined {
  const builtin = BUILTIN_BY_FAMILY.get(name);
  if (builtin) {return builtin;}
  return getEffectiveFonts().byName.get(name);
}

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
      // Custom fonts first, then popular built-ins.
      const tier = isCustom ? "0" : font.popular ? "1" : "2";
      item.sortText = `${tier}_${String(index).padStart(3, "0")}`;
      item.range = range;
      item.insertText = font.family;
      return item;
    });
  }
}

function findFontFromNameStringArg(
  text: string,
  cursor: number
): { stringStart: number; stringEnd: number; quote: '"' | "'" | "`" } | undefined {
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

  for (let i = stringStart + 1; i < cursor; i++) {
    const c = text[i];
    if (!/[A-Za-z0-9_]/.test(c)) {return undefined;}
  }

  let stringEnd = -1;
  for (let i = cursor; i < text.length; i++) {
    if (text[i] === "\n") {break;}
    if (text[i] === quote) {
      stringEnd = i;
      break;
    }
    if (!/[A-Za-z0-9_]/.test(text[i])) {return undefined;}
  }

  const before = text.slice(Math.max(0, stringStart - 80), stringStart);
  if (!/\bFont\.fromName\s*\(\s*$/.test(before)) {
    return undefined;
  }
  return { stringStart, stringEnd, quote };
}

// Filter weights by the surrounding family; use the full enum when unknown.

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

function findFontFamilyInCurrentCall(
  text: string,
  offset: number
): RobloxFont | undefined {
  const start = Math.max(0, offset - 200);
  const slice = text.slice(start, offset);
  // Use the last match when several Font.fromName calls share a line.
  const re = /\bFont\.fromName\s*\(\s*["'`]([A-Za-z0-9_-]+)["'`]/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    last = m;
  }
  if (!last) {return undefined;}
  return getFontFamily(last[1]);
}
