import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { configChangeAffects, getConfig } from "./configCompat";
import { logWarn } from "./output";

// Supported sizes follow Roblox docs and Quenty's RbxThumbUtils (NevermoreEngine).

export interface RbxThumbType {
  type: string;
  // Supported square sizes (w === h).
  sizes: number[];
  idLabel: string;
  circular?: boolean;
  description: string;
}

export const RBXTHUMB_TYPES: RbxThumbType[] = [
  {
    type: "AvatarHeadShot",
    sizes: [48, 60, 150],
    idLabel: "userId",
    circular: true,
    description: "Avatar headshot (player's face)",
  },
  {
    type: "Avatar",
    sizes: [100, 352, 720],
    idLabel: "userId",
    description: "Full-body avatar thumbnail",
  },
  {
    type: "GameIcon",
    sizes: [50, 150],
    idLabel: "placeId",
    description: "Experience (game) icon",
  },
  {
    type: "GroupIcon",
    sizes: [150, 420],
    idLabel: "groupId",
    description: "Group emblem",
  },
  {
    type: "BadgeIcon",
    sizes: [150],
    idLabel: "badgeId",
    description: "Badge icon",
  },
  {
    type: "GamePass",
    sizes: [150],
    idLabel: "gamePassId",
    description: "Game Pass icon",
  },
  {
    type: "Asset",
    sizes: [150, 420],
    idLabel: "assetId",
    description: "Decal / image asset thumbnail",
  },
  {
    type: "BundleThumbnail",
    sizes: [150, 420],
    idLabel: "bundleId",
    description: "Bundle thumbnail",
  },
  {
    type: "Outfit",
    sizes: [150, 420],
    idLabel: "outfitId",
    description: "Outfit thumbnail",
  },
];

const RBXTHUMB_BY_TYPE = new Map<string, RbxThumbType>(
  RBXTHUMB_TYPES.map((t) => [t.type, t])
);

export function getRbxThumbType(name: string): RbxThumbType | undefined {
  return RBXTHUMB_BY_TYPE.get(name);
}

export function formatSizes(sizes: number[]): string {
  return sizes.map((s) => `${s}×${s}`).join(", ");
}

export interface ParsedRbxThumb {
  type?: string;
  id?: string;
  w?: string;
  h?: string;
  filters?: string;
}

// Accept partial URLs so completion can use the same parser as diagnostics.
export function parseRbxThumb(inner: string): ParsedRbxThumb | undefined {
  const trimmed = inner.trim();
  const m = /^rbxthumb:\/\/(.*)$/.exec(trimmed);
  if (!m) {return undefined;}
  const out: ParsedRbxThumb = {};
  for (const part of m[1].split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) {continue;}
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "type") {out.type = value;}
    else if (key === "id") {out.id = value;}
    else if (key === "w") {out.w = value;}
    else if (key === "h") {out.h = value;}
    else if (key === "filters") {out.filters = value;}
  }
  return out;
}

export type RbxThumbProblemKind =
  | "missing-type"
  | "unknown-type"
  | "missing-size"
  | "bad-size"
  | "bad-filter";

export interface RbxThumbProblem {
  kind: RbxThumbProblemKind;
  message: string;
}

export function validateRbxThumb(p: ParsedRbxThumb): RbxThumbProblem[] {
  const problems: RbxThumbProblem[] = [];
  if (!p.type) {
    problems.push({
      kind: "missing-type",
      message: "rbxthumb is missing a `type=` parameter.",
    });
    return problems;
  }
  const spec = getRbxThumbType(p.type);
  if (!spec) {
    problems.push({
      kind: "unknown-type",
      message: `Unknown rbxthumb type "${p.type}". Valid types: ${RBXTHUMB_TYPES.map(
        (t) => t.type
      ).join(", ")}.`,
    });
    return problems;
  }
  if (p.w === undefined || p.h === undefined) {
    problems.push({
      kind: "missing-size",
      message: `${spec.type} needs both \`w=\` and \`h=\`. Supported sizes: ${formatSizes(
        spec.sizes
      )}.`,
    });
  } else {
    const w = Number(p.w);
    const h = Number(p.h);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w !== h) {
      problems.push({
        kind: "bad-size",
        message: `rbxthumb sizes must be square (w = h). ${spec.type} supports: ${formatSizes(
          spec.sizes
        )}.`,
      });
    } else if (!spec.sizes.includes(w)) {
      problems.push({
        kind: "bad-size",
        message: `${spec.type} doesn't support ${w}×${h}. Supported: ${formatSizes(
          spec.sizes
        )}.`,
      });
    }
  }
  if (p.filters !== undefined && p.filters !== "circular") {
    problems.push({
      kind: "bad-filter",
      message: `Unknown rbxthumb filter "${p.filters}". The only supported filter is \`circular\`.`,
    });
  } else if (p.filters === "circular" && !spec.circular) {
    problems.push({
      kind: "bad-filter",
      message: `\`filters=circular\` only applies to AvatarHeadShot, not ${spec.type}.`,
    });
  }
  return problems;
}

export interface EnclosingString {
  // First character inside the quotes, in document offsets.
  innerStart: number;
  // Closing quote, or line end for an unterminated string.
  innerEnd: number;
  quote: string;
}

// Content URLs are single-line strings, so scanning from the line start is sufficient.
export function getEnclosingString(
  text: string,
  offset: number
): EnclosingString | undefined {
  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") {lineStart--;}
  let inString = false;
  let quote = "";
  let innerStart = -1;
  for (let i = lineStart; i < offset; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) {
        inString = false;
        quote = "";
        innerStart = -1;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      inString = true;
      quote = c;
      innerStart = i + 1;
    }
  }
  if (!inString) {return undefined;}
  let end = offset;
  while (end < text.length && text[end] !== quote && text[end] !== "\n") {
    if (text[end] === "\\") {end++;}
    end++;
  }
  return { innerStart, innerEnd: end, quote };
}

const RBXTHUMB_PREFIX = "rbxthumb://";
const RBXASSET_PREFIX = "rbxasset://";

export class RbxThumbCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (!getConfig<boolean>("robloxContent.enabled", true)) {return undefined;}
    const text = document.getText();
    const offset = document.offsetAt(position);
    const enc = getEnclosingString(text, offset);
    if (!enc) {return undefined;}
    const before = text.slice(enc.innerStart, offset);
    if (!before.startsWith(RBXTHUMB_PREFIX)) {return undefined;}
    const afterScheme = before.slice(RBXTHUMB_PREFIX.length);

    const sizeMatch = /(?:^|&)(w|h)=(\d*)$/.exec(afterScheme);
    if (sizeMatch) {
      const typeMatch = /(?:^|&)type=([A-Za-z]+)/.exec(afterScheme);
      const spec = typeMatch ? getRbxThumbType(typeMatch[1]) : undefined;
      if (!spec) {return undefined;}
      const partial = sizeMatch[2];
      const range = new vscode.Range(
        document.positionAt(offset - partial.length),
        position
      );
      return spec.sizes.map((size, i) => {
        const item = new vscode.CompletionItem(
          String(size),
          vscode.CompletionItemKind.Value
        );
        item.detail = `${spec.type} size (${size}×${size})`;
        item.filterText = String(size);
        item.sortText = String(i).padStart(2, "0");
        item.range = range;
        return item;
      });
    }

    if (!/^(?:type=)?[A-Za-z]*$/.test(afterScheme)) {return undefined;}
    const range = new vscode.Range(
      document.positionAt(enc.innerStart + RBXTHUMB_PREFIX.length),
      position
    );
    return RBXTHUMB_TYPES.map((t, i) => {
      const item = new vscode.CompletionItem(
        t.type,
        vscode.CompletionItemKind.EnumMember
      );
      item.detail = `${t.description} — ${formatSizes(t.sizes)}`;
      item.documentation = new vscode.MarkdownString(
        `**rbxthumb — ${t.type}**\n\n${t.description}\n\n` +
          `Supported sizes: ${formatSizes(t.sizes)}` +
          (t.circular ? `\n\nSupports \`&filters=circular\`.` : "")
      );
      // Share a tabstop to keep width and height equal.
      const sizeChoice = `\${2|${t.sizes.join(",")}|}`;
      item.insertText = new vscode.SnippetString(
        `type=${t.type}&id=\${1:${t.idLabel}}&w=${sizeChoice}&h=${sizeChoice}$0`
      );
      item.filterText = t.type;
      item.sortText = String(i).padStart(2, "0");
      item.range = range;
      return item;
    });
  }
}

export class RbxThumbHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.Hover> {
    if (!getConfig<boolean>("robloxContent.enabled", true)) {return undefined;}
    const text = document.getText();
    const offset = document.offsetAt(position);
    const enc = getEnclosingString(text, offset);
    if (!enc) {return undefined;}
    const inner = text.slice(enc.innerStart, enc.innerEnd);
    const parsed = parseRbxThumb(inner);
    if (!parsed) {return undefined;}
    const spec = parsed.type ? getRbxThumbType(parsed.type) : undefined;
    const lines: string[] = [];
    if (spec) {
      lines.push(`**rbxthumb — ${spec.type}**`, "", spec.description, "");
      lines.push(`Supported sizes: ${formatSizes(spec.sizes)}`);
    } else {
      lines.push("**rbxthumb thumbnail URL**");
    }
    const problems = validateRbxThumb(parsed).filter(
      (p) => p.kind !== "missing-size" && p.kind !== "missing-type"
    );
    if (problems.length > 0) {
      lines.push("", ...problems.map((p) => `⚠️ ${p.message}`));
    }
    const md = new vscode.MarkdownString(lines.join("\n"));
    md.isTrusted = false;
    const range = new vscode.Range(
      document.positionAt(enc.innerStart),
      document.positionAt(enc.innerEnd)
    );
    return new vscode.Hover(md, range);
  }
}

export const RBXTHUMB_DIAGNOSTIC_CODE = "luix.rbxthumb";

const RBXTHUMB_SCAN_RE = /rbxthumb:\/\/[A-Za-z0-9=&]*/g;

export class RbxThumbDiagnostics implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;
  private disposables: vscode.Disposable[] = [];
  private timers = new Map<string, NodeJS.Timeout>();

  constructor() {
    this.collection =
      vscode.languages.createDiagnosticCollection("luix-rbxthumb");
    this.disposables.push(
      this.collection,
      vscode.workspace.onDidOpenTextDocument((d) => this.refresh(d)),
      vscode.workspace.onDidChangeTextDocument((e) =>
        this.schedule(e.document)
      ),
      vscode.workspace.onDidCloseTextDocument((d) => {
        this.collection.delete(d.uri);
        const t = this.timers.get(d.uri.toString());
        if (t) {
          clearTimeout(t);
          this.timers.delete(d.uri.toString());
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (configChangeAffects(e, "robloxContent")) {
          this.refreshAllVisible();
        }
      })
    );
    this.refreshAllVisible();
  }

  private isLua(doc: vscode.TextDocument): boolean {
    return doc.languageId === "lua" || doc.languageId === "luau";
  }

  private schedule(doc: vscode.TextDocument): void {
    if (!this.isLua(doc)) {return;}
    const key = doc.uri.toString();
    const existing = this.timers.get(key);
    if (existing) {clearTimeout(existing);}
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refresh(doc);
      }, 300)
    );
  }

  private refreshAllVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refresh(editor.document);
    }
  }

  refresh(doc: vscode.TextDocument): void {
    if (!this.isLua(doc)) {return;}
    if (!getConfig<boolean>("robloxContent.enabled", true)) {
      this.collection.delete(doc.uri);
      return;
    }
    const text = doc.getText();
    const diagnostics: vscode.Diagnostic[] = [];
    RBXTHUMB_SCAN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RBXTHUMB_SCAN_RE.exec(text)) !== null) {
      const parsed = parseRbxThumb(m[0]);
      if (!parsed) {continue;}
      // Suppress incomplete-URL diagnostics while typing.
      const problems = validateRbxThumb(parsed).filter(
        (p) =>
          p.kind === "unknown-type" ||
          p.kind === "bad-size" ||
          p.kind === "bad-filter"
      );
      if (problems.length === 0) {continue;}
      const range = new vscode.Range(
        doc.positionAt(m.index),
        doc.positionAt(m.index + m[0].length)
      );
      for (const problem of problems) {
        const diag = new vscode.Diagnostic(
          range,
          problem.message,
          vscode.DiagnosticSeverity.Warning
        );
        diag.source = "Luix";
        diag.code = RBXTHUMB_DIAGNOSTIC_CODE;
        diagnostics.push(diag);
      }
    }
    this.collection.set(doc.uri, diagnostics);
  }

  dispose(): void {
    for (const t of this.timers.values()) {clearTimeout(t);}
    this.timers.clear();
    for (const d of this.disposables) {d.dispose();}
    this.disposables = [];
  }
}

const CONTENT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".tga",
  ".bmp",
  ".dds",
  ".ktx",
  ".svg",
  ".json",
  ".mesh",
  ".obj",
  ".ogg",
  ".mp3",
  ".rbxm",
]);

const MAX_CONTENT_FILES = 20000;

// undefined = not searched; null = searched, none found.
let _contentDir: string | null | undefined;
let _filesPromise: Promise<string[]> | undefined;

export function resetContentCache(): void {
  _contentDir = undefined;
  _filesPromise = undefined;
}

function looksLikeContentDir(dir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dir, "textures")) ||
      fs.existsSync(path.join(dir, "fonts")) ||
      fs.existsSync(path.join(dir, "sounds"))
    );
  } catch {
    return false;
  }
}

function newestVersionContent(versionsDir: string): string | undefined {
  let best: { dir: string; mtime: number } | undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {continue;}
    const contentDir = path.join(versionsDir, entry.name, "content");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(contentDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {continue;}
    const mtime = stat.mtimeMs;
    if (!best || mtime > best.mtime) {best = { dir: contentDir, mtime };}
  }
  return best?.dir;
}

// The override accepts a content, version, or Versions directory.
export function discoverContentDir(): string | undefined {
  if (_contentDir !== undefined) {return _contentDir ?? undefined;}

  const resolve = (): string | undefined => {
    const override = getConfig<string>("robloxContent.path", "").trim();
    if (override) {
      try {
        if (!fs.existsSync(override)) {return undefined;}
      } catch {
        return undefined;
      }
      if (looksLikeContentDir(override)) {return override;}
      const sub = path.join(override, "content");
      if (looksLikeContentDir(sub)) {return sub;}
      return newestVersionContent(override);
    }

    const candidates: string[] = [];
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(path.join(localAppData, "Roblox", "Versions"));
    }
    const home = os.homedir();
    if (home) {
      candidates.push(
        path.join(home, "Library", "Application Support", "Roblox", "Versions")
      );
    }
    for (const versionsDir of candidates) {
      const content = newestVersionContent(versionsDir);
      if (content) {return content;}
    }
    const macStudio =
      "/Applications/RobloxStudio.app/Contents/Resources/content";
    if (looksLikeContentDir(macStudio)) {return macStudio;}
    return undefined;
  };

  const found = resolve();
  _contentDir = found ?? null;
  if (!found) {
    logWarn(
      "rbxasset autocomplete: no Roblox content folder found. Set `luix.robloxContent.path` to your install's content directory."
    );
  }
  return found;
}

export function getContentFiles(): Promise<string[]> {
  if (!_filesPromise) {_filesPromise = scanContentFiles();}
  return _filesPromise;
}

async function scanContentFiles(): Promise<string[]> {
  const dir = discoverContentDir();
  if (!dir) {return [];}
  try {
    // Node 18.15 lacks recursive readdir. Walk depth-first and reject ancestor link cycles.
    const rootPath = await fs.promises.realpath(dir);
    const pending = [{
      relative: "",
      entries: await fs.promises.readdir(dir, { withFileTypes: true }),
      ancestors: new Set([rootPath]),
    }];
    const out: string[] = [];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const entry of current.entries) {
        const relative = path.join(current.relative, entry.name);
        const absolute = path.join(dir, relative);
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            isDirectory = (await fs.promises.stat(absolute)).isDirectory();
          } catch {
            // Skip broken links.
          }
        }
        if (CONTENT_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
          out.push(relative.split(path.sep).join("/"));
          if (out.length >= MAX_CONTENT_FILES) {
            return out.sort();
          }
        }
        if (isDirectory) {
          const realPath = await fs.promises.realpath(absolute);
          if (!current.ancestors.has(realPath)) {
            pending.push({
              relative,
              entries: await fs.promises.readdir(absolute, { withFileTypes: true }),
              ancestors: new Set([...current.ancestors, realPath]),
            });
          }
        }
      }
    }
    return out.sort();
  } catch (err) {
    logWarn("rbxasset autocomplete: failed to scan content folder", err);
    return [];
  }
}

const MAX_RBXASSET_RESULTS = 2000;

export interface RbxAssetChild {
  name: string;
  isFolder: boolean;
}

export function computeRbxAssetChildren(
  files: string[],
  committedDir: string
): RbxAssetChild[] {
  const folders = new Set<string>();
  const fileNames = new Set<string>();
  for (const file of files) {
    if (committedDir && !file.startsWith(committedDir)) {continue;}
    const rest = file.slice(committedDir.length);
    if (rest.length === 0) {continue;}
    const slash = rest.indexOf("/");
    if (slash === -1) {
      fileNames.add(rest);
    } else {
      folders.add(rest.slice(0, slash));
    }
  }
  const out: RbxAssetChild[] = [];
  for (const name of folders) {out.push({ name, isFolder: true });}
  for (const name of fileNames) {out.push({ name, isFolder: false });}
  out.sort((a, b) =>
    a.isFolder === b.isFolder
      ? a.name.localeCompare(b.name)
      : a.isFolder
        ? -1
        : 1
  );
  return out;
}

export class RbxAssetCompletionProvider
  implements vscode.CompletionItemProvider
{
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    if (!getConfig<boolean>("robloxContent.enabled", true)) {return undefined;}
    const text = document.getText();
    const offset = document.offsetAt(position);
    const enc = getEnclosingString(text, offset);
    if (!enc) {return undefined;}
    const before = text.slice(enc.innerStart, offset);
    if (!before.startsWith(RBXASSET_PREFIX)) {return undefined;}

    const files = await getContentFiles();
    if (files.length === 0) {return undefined;}

    const typedPath = before.slice(RBXASSET_PREFIX.length);
    const lastSlash = typedPath.lastIndexOf("/");
    const committedDir =
      lastSlash === -1 ? "" : typedPath.slice(0, lastSlash + 1);
    const partial = typedPath.slice(lastSlash + 1);

    const children = computeRbxAssetChildren(files, committedDir);
    if (children.length === 0) {return undefined;}

    // Replace only the partial segment, preserving the selected directory.
    const range = new vscode.Range(
      document.positionAt(offset - partial.length),
      position
    );

    const out: vscode.CompletionItem[] = [];
    for (const child of children) {
      const label = child.isFolder ? `${child.name}/` : child.name;
      const item = new vscode.CompletionItem(
        label,
        child.isFolder
          ? vscode.CompletionItemKind.Folder
          : vscode.CompletionItemKind.File
      );
      item.filterText = label;
      item.insertText = label;
      item.range = range;
      // Keep folders first regardless of VS Code's label sorting.
      item.sortText = `${child.isFolder ? "0" : "1"}_${child.name.toLowerCase()}`;
      if (child.isFolder) {
        // Accepting a folder opens the next level.
        item.command = {
          command: "editor.action.triggerSuggest",
          title: "",
        };
      }
      out.push(item);
      if (out.length >= MAX_RBXASSET_RESULTS) {break;}
    }
    return out;
  }
}

export const _internal = {
  RBXTHUMB_SCAN_RE,
  CONTENT_EXTENSIONS,
};
