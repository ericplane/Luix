import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { configChangeAffects, getConfig } from "./configCompat";
import { logWarn } from "./output";

// ============================================================================
// Roblox content-URL autocomplete — `rbxthumb://` + `rbxasset://`
// ============================================================================
//
// Two distinct Roblox content schemes, both used as `Image` / `Texture`
// values and both painful to type by hand:
//
//   1. rbxthumb:// — dynamically-resolved thumbnails (avatar headshots,
//      game icons, group emblems, …). Format:
//        rbxthumb://type=<Type>&id=<Id>&w=<W>&h=<H>[&filters=circular]
//      Every type only supports a FIXED set of (square) sizes — a
//      `w`/`h` Roblox doesn't render for that type silently fails, so
//      the completion only ever offers valid sizes and the diagnostic
//      flags hand-typed bad ones.
//
//   2. rbxasset:// — the client's bundled content files
//      (`rbxasset://textures/ui/common/robux_color.png`, fonts, sounds,
//      meshes, …). These live on disk under the local Roblox install's
//      `content/` folder; we discover that folder, scan it once, and
//      offer the relative paths as path completions.

// ----------------------------------------------------------------------
// rbxthumb:// type / size data
// ----------------------------------------------------------------------
//
// Sizes corroborated against Roblox's documented set and Quenty's
// RbxThumbUtils (NevermoreEngine) — the conservative, known-rendering
// set. All documented sizes are square (w === h), which is what lets
// the completion mirror a single size choice into both `w` and `h`.

export interface RbxThumbType {
  /** The `type=` value, e.g. "AvatarHeadShot". */
  type: string;
  /** Supported square sizes (w === h). */
  sizes: number[];
  /** Placeholder shown for the `id=` field in the inserted snippet. */
  idLabel: string;
  /** Whether `&filters=circular` is meaningful for this type. */
  circular?: boolean;
  /** Human description for completion detail / hover. */
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

/** Format a size list as `48×48, 60×60, 150×150` for messages / detail. */
export function formatSizes(sizes: number[]): string {
  return sizes.map((s) => `${s}×${s}`).join(", ");
}

// ----------------------------------------------------------------------
// rbxthumb:// parsing + validation (pure — unit-tested)
// ----------------------------------------------------------------------

export interface ParsedRbxThumb {
  type?: string;
  id?: string;
  w?: string;
  h?: string;
  filters?: string;
}

/**
 * Parse the inner of a string that begins with `rbxthumb://`. Returns
 * `undefined` when the string isn't an rbxthumb URL at all. Tolerant of
 * partial input (fields may be absent) so it can drive both the
 * diagnostic and live completion.
 */
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

/**
 * Validate a parsed rbxthumb URL. Returns every problem found. The
 * `kind` lets callers filter — the diagnostic only surfaces the
 * high-signal kinds (`unknown-type`, `bad-size`, `bad-filter`) so it
 * doesn't fire on half-typed URLs, while completion can use the full
 * set.
 */
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

// ----------------------------------------------------------------------
// Enclosing single-line string literal (shared by both providers + hover)
// ----------------------------------------------------------------------

export interface EnclosingString {
  /** Document offset of the first char inside the quotes. */
  innerStart: number;
  /** Document offset of the closing quote (or line end if unterminated). */
  innerEnd: number;
  /** The quote character. */
  quote: string;
}

/**
 * If `offset` sits inside a single-line string literal, return its inner
 * bounds. rbxthumb / rbxasset URLs never span lines, so single-line
 * scanning from the line start is sufficient and cheap.
 */
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
  // Extend to the closing quote (or end of line) for hover / full-inner.
  let end = offset;
  while (end < text.length && text[end] !== quote && text[end] !== "\n") {
    if (text[end] === "\\") {end++;}
    end++;
  }
  return { innerStart, innerEnd: end, quote };
}

const RBXTHUMB_PREFIX = "rbxthumb://";
const RBXASSET_PREFIX = "rbxasset://";

// ----------------------------------------------------------------------
// rbxthumb:// completion
// ----------------------------------------------------------------------
//
// Two contexts:
//   A. Choosing the type — cursor right after `rbxthumb://` (optionally
//      with a partial `type=Foo`). Each type inserts a complete URL
//      skeleton whose `w` / `h` are a choice dropdown of ONLY that
//      type's valid sizes (mirrored via a shared tabstop so picking
//      once fills both).
//   B. Editing a `w=` / `h=` value with a known `type=` already present.
//      Offers that type's valid sizes as plain numbers.

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

    // Context B — editing a size field.
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

    // Context A — choosing the type. Only when nothing past the type
    // value has been typed yet (`""`, `type=`, or `type=Partial`).
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
      // Mirror the size into both w and h via a shared choice tabstop.
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

// ----------------------------------------------------------------------
// rbxthumb:// hover
// ----------------------------------------------------------------------

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

// ----------------------------------------------------------------------
// rbxthumb:// diagnostics — flag hand-typed unsupported sizes / types
// ----------------------------------------------------------------------

export const RBXTHUMB_DIAGNOSTIC_CODE = "luix.rbxthumb";

// Matches a complete rbxthumb URL body — stops at the closing quote /
// whitespace because the query alphabet is letters, digits, `=`, `&`.
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
      // Only the high-signal problems — never the "incomplete while
      // typing" ones (missing type / size), which would flicker as the
      // user types the URL out.
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

// ----------------------------------------------------------------------
// rbxasset:// content-file discovery + scan
// ----------------------------------------------------------------------
//
// The local Roblox install bundles its content under
// `…/Roblox/Versions/<version>/content/`. We discover the newest such
// folder, scan it once (async, cached for the session), and surface the
// relative paths as path completions.

// Asset extensions worth completing — images, fonts, sounds, meshes.
// Everything else under content/ (config blobs, shaders, etc.) is noise
// for an Image/Sound/Mesh value.
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

// `undefined` = not yet looked; `null` = looked, none found.
let _contentDir: string | null | undefined;
let _filesPromise: Promise<string[]> | undefined;

/** Drop the discovery + scan cache (config change of the path / toggle). */
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

/** Given a `…/Versions` directory, return the `content` folder of its
 *  newest version subdir that has one (Player + Studio both live here). */
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

/**
 * Locate the Roblox `content` directory. Honours the
 * `luix.robloxContent.path` override (which may point at a `content`
 * folder, a version folder, or a `Versions` folder), else auto-discovers
 * the newest install on Windows / macOS. Cached.
 */
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
    // macOS Studio ships content directly inside the app bundle.
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

/** Scan (once, cached) the discovered content folder for completable
 *  asset files, returned as forward-slash relative paths. */
export function getContentFiles(): Promise<string[]> {
  if (!_filesPromise) {_filesPromise = scanContentFiles();}
  return _filesPromise;
}

async function scanContentFiles(): Promise<string[]> {
  const dir = discoverContentDir();
  if (!dir) {return [];}
  try {
    // VS Code 1.85 embeds Node 18.15, before readdir's recursive option.
    // Keep the same depth-first directory order, following directory links
    // while preventing a link back to an ancestor from looping forever.
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
            // A broken link is not traversable, as with native readdir.
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

// ----------------------------------------------------------------------
// rbxasset:// completion — folder-by-folder navigation
// ----------------------------------------------------------------------
//
// Rather than dumping full flat paths (which forces the user to already
// know the path), we navigate one directory level at a time, like a
// file explorer: at `rbxasset://` we offer `textures/`, `fonts/`, …; at
// `rbxasset://textures/` we offer that folder's children; and so on.
// Folders carry a trailing `/` and re-trigger completion on accept so
// the next level pops open immediately.

const MAX_RBXASSET_RESULTS = 2000;

export interface RbxAssetChild {
  name: string;
  isFolder: boolean;
}

/**
 * Derive the immediate children (one path segment deep) of `committedDir`
 * from the flat file list. A child is a *folder* when some file lives
 * deeper under it, a *file* when a file ends exactly at this level.
 * Pure — unit-tested.
 */
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
  // Folders first, then files; alphabetical within each group.
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

    // Split the typed path into the committed directory (up to and
    // including the last `/`) and the partial segment being typed.
    const typedPath = before.slice(RBXASSET_PREFIX.length);
    const lastSlash = typedPath.lastIndexOf("/");
    const committedDir =
      lastSlash === -1 ? "" : typedPath.slice(0, lastSlash + 1);
    const partial = typedPath.slice(lastSlash + 1);

    const children = computeRbxAssetChildren(files, committedDir);
    if (children.length === 0) {return undefined;}

    // Replace only the partial segment — selecting a child appends to
    // the committed dir rather than rewriting the whole path.
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
      // Folders sort first; keep the explorer-like ordering stable
      // regardless of VS Code's own label sort.
      item.sortText = `${child.isFolder ? "0" : "1"}_${child.name.toLowerCase()}`;
      if (child.isFolder) {
        // Pop the next level open immediately after accepting a folder.
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

// Exposed for tests.
export const _internal = {
  RBXTHUMB_SCAN_RE,
  CONTENT_EXTENSIONS,
};
