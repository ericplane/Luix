import * as vscode from "vscode";
import { getConfig } from "./configCompat";
import { logWarn } from "./output";

// ============================================================================
// Roblox asset thumbnail helpers — shared by the hover provider and the
// gutter decorator
// ============================================================================
//
// Two layers of caching, with deliberately different lifetimes:
//
//   1. In-memory `thumbnailUrlCache` — maps `assetId` → resolved CDN
//      URL, for the *hover* path. The hover renders the image directly
//      from the CDN URL through VS Code's markdown image loader, so it
//      never touches disk. 24h TTL on success, 1 min on failure.
//
//   2. On-disk PNG cache, for the *gutter icon* path. VS Code's
//      `gutterIconPath` requires a local file URI (remote URLs aren't
//      supported), so we download each thumbnail once and write it
//      somewhere the decorator can point to.
//
// The on-disk cache lives in one of two places, picked by
// `luix.imageGutter.cacheLocation`:
//
//   • `global` (default) — `<extension globalStorage>/assetThumbs/`.
//     Shared across every workspace, never touches the user's repo.
//   • `workspace` — `<workspace>/.luix/assetThumbs/`. Self-contained per
//     project. A `.luix/.gitignore` is auto-written so the cache
//     doesn't leak into commits.

/**
 * Size requested from the thumbnails API. 150×150 is the sweet spot:
 *   - Big enough to be legible in the hover popup with no scroll.
 *   - Small enough that the file cache stays under a few KB per asset.
 *   - Looks crisp scaled down to the ~16px gutter icon.
 */
const THUMBNAIL_SIZE = "150x150" as const;

interface CachedUrl {
  url: string | null;
  /** When this entry stops being honoured. `0` means never cached. */
  expires: number;
  /** What we last heard from the API — used by callers to compose a hover message. */
  state?: ThumbnailState;
}
const thumbnailUrlCache = new Map<string, CachedUrl>();
let cacheGeneration = 0;
let purgePromise: Promise<void> | undefined;
const activeWrites = new Set<Promise<void>>();
const THUMBNAIL_TTL_OK = 24 * 60 * 60 * 1000;
/**
 * Cache lifetime for *settled* failures (asset blocked, moderated, the
 * API returned 404, etc.). 10 s — long enough to suppress hammering
 * during a flurry of hovers, short enough that fixing a typo or
 * switching to a different ID gets a fresh fetch on the next look.
 *
 * Previously 60 s, which left users staring at a "moderated" message
 * for a full minute after every edit until the in-memory cache aged out.
 */
const THUMBNAIL_TTL_FAIL = 10 * 1000;

/**
 * Roblox's thumbnails API splits its responses into a handful of named
 * states. We use this to decide whether a result is worth caching:
 *
 *   • `Completed` — done, has `imageUrl`. Cache for a day.
 *   • `Pending` / `InReview` — Roblox hasn't generated the thumbnail
 *     yet (common for freshly-uploaded assets). Almost always
 *     transitions to `Completed` within seconds. **Do not cache** —
 *     the next call will succeed.
 *   • `Error` / `TemporarilyUnavailable` — transient backend issue.
 *     Same rationale: don't cache, let the next call retry.
 *   • `Blocked` / `Moderated` — permanent. Cache as failure.
 *   • Unknown / missing / network error — cache as failure (short TTL).
 */
export type ThumbnailState =
  | "Completed"
  | "Pending"
  | "InReview"
  | "Error"
  | "TemporarilyUnavailable"
  | "Blocked"
  | "Moderated"
  | "Unknown";

const TRANSIENT_STATES: ReadonlySet<ThumbnailState> = new Set([
  "Pending",
  "InReview",
  "Error",
  "TemporarilyUnavailable",
]);

export interface ThumbnailLookup {
  url: string | null;
  state: ThumbnailState;
}

/**
 * Resolve a Roblox asset ID to the actual CDN image URL via the public
 * thumbnails API. Returns the URL plus the API's reported state so the
 * caller can pick a sensible message (transient vs permanent).
 * Memoised for the session — successes for 24 h, settled failures for
 * 10 s, transient states (Pending, InReview, Error, …) not cached at all.
 */
export async function fetchAssetThumbnail(
  assetId: string,
  size: string = THUMBNAIL_SIZE
): Promise<ThumbnailLookup> {
  const cacheKey = `${assetId}@${size}`;
  const generation = cacheGeneration;
  const now = Date.now();
  const cached = thumbnailUrlCache.get(cacheKey);
  if (cached && cached.expires > now) {
    return { url: cached.url, state: cached.state ?? "Unknown" };
  }
  const url =
    `https://thumbnails.roblox.com/v1/assets` +
    `?assetIds=${assetId}&size=${size}&format=Png&isCircular=false`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (generation !== cacheGeneration) {return { url: null, state: "Unknown" };}
    if (!res.ok) {
      logWarn(
        `Thumbnail API returned ${res.status} for asset ${assetId}`
      );
      return cacheFailure(cacheKey, now, "Unknown");
    }
    const payload = (await res.json()) as {
      data?: Array<{ state?: string; imageUrl?: string | null }>;
    };
    const entry = payload?.data?.[0];
    if (generation !== cacheGeneration) {return { url: null, state: "Unknown" };}
    const state = (entry?.state ?? "Unknown") as ThumbnailState;
    if (state === "Completed" && entry?.imageUrl) {
      thumbnailUrlCache.set(cacheKey, {
        url: entry.imageUrl,
        expires: now + THUMBNAIL_TTL_OK,
        state,
      });
      return { url: entry.imageUrl, state };
    }
    if (TRANSIENT_STATES.has(state)) {
      // Don't cache — the next call will likely succeed once Roblox has
      // finished generating the thumbnail / recovered from a backend
      // blip. This is the difference between "hover works after a few
      // seconds" and "hover is stuck for 60 s after every edit".
      return { url: null, state };
    }
    return cacheFailure(cacheKey, now, state);
  } catch (err) {
    logWarn(`Thumbnail API fetch failed for asset ${assetId}`, err);
    if (generation !== cacheGeneration) {return { url: null, state: "Unknown" };}
    return cacheFailure(cacheKey, now, "Unknown");
  }
}

function cacheFailure(
  cacheKey: string,
  now: number,
  state: ThumbnailState
): ThumbnailLookup {
  thumbnailUrlCache.set(cacheKey, {
    url: null,
    expires: now + THUMBNAIL_TTL_FAIL,
    state,
  });
  return { url: null, state };
}

/**
 * Back-compat shim for callers that only want the URL — the gutter
 * decorator doesn't need to know the state.
 */
export async function fetchAssetThumbnailUrl(
  assetId: string,
  size: string = THUMBNAIL_SIZE
): Promise<string | null> {
  const { url } = await fetchAssetThumbnail(assetId, size);
  return url;
}

/**
 * Resolve the directory where on-disk thumbnails should live. Honours
 * `luix.imageGutter.cacheLocation` and falls back to global storage
 * when "workspace" is requested but no workspace is open.
 */
export function getThumbnailCacheDir(
  context: vscode.ExtensionContext
): vscode.Uri {
  const location = getConfig<string>("imageGutter.cacheLocation", "global");
  if (location === "workspace") {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      return vscode.Uri.joinPath(folder.uri, ".luix", "assetThumbs");
    }
  }
  return vscode.Uri.joinPath(context.globalStorageUri, "assetThumbs");
}

/**
 * Every cache directory that has ever been used for this extension —
 * resolved location *plus* the global fallback. Used by `purge` and
 * `getCacheStats` so flipping the location setting doesn't leave a
 * second directory dangling.
 */
function allKnownCacheDirs(
  context: vscode.ExtensionContext
): vscode.Uri[] {
  const out: vscode.Uri[] = [
    vscode.Uri.joinPath(context.globalStorageUri, "assetThumbs"),
  ];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    out.push(vscode.Uri.joinPath(folder.uri, ".luix", "assetThumbs"));
  }
  return out;
}

/**
 * Ensure the thumbnail PNG for `assetId` exists on disk; download it
 * if not. Returns the local file URI suitable for `gutterIconPath`,
 * or undefined if the network/API call failed.
 */
export async function ensureThumbnailFile(
  context: vscode.ExtensionContext,
  assetId: string,
  canWrite: () => boolean = () => true
): Promise<vscode.Uri | undefined> {
  if (purgePromise) {await purgePromise;}
  const generation = cacheGeneration;
  const isCurrent = () => generation === cacheGeneration && canWrite();
  if (!isCurrent()) {return undefined;}
  const cacheDir = getThumbnailCacheDir(context);
  const filePath = vscode.Uri.joinPath(cacheDir, `${assetId}.png`);
  try {
    await vscode.workspace.fs.stat(filePath);
    return isCurrent() ? filePath : undefined;
  } catch {
    // Not cached yet — fall through to download.
  }
  const cdnUrl = await fetchAssetThumbnailUrl(assetId);
  if (!cdnUrl || !isCurrent()) {
    return undefined;
  }
  try {
    const res = await fetch(cdnUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      logWarn(
        `Thumbnail CDN returned ${res.status} for asset ${assetId}`
      );
      return undefined;
    }
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (!isCurrent()) {return undefined;}
    const write = (async () => {
      await ensureCacheDirReady(cacheDir);
      if (isCurrent()) {await vscode.workspace.fs.writeFile(filePath, buffer);}
    })();
    activeWrites.add(write);
    try {
      await write;
    } finally {
      activeWrites.delete(write);
    }
    return isCurrent() ? filePath : undefined;
  } catch (err) {
    logWarn(`Thumbnail download failed for asset ${assetId}`, err);
    return undefined;
  }
}

/**
 * Create the cache directory if missing. When the cache lives inside
 * the workspace, also drop a `.gitignore` next to it so the cache
 * doesn't leak into commits.
 */
async function ensureCacheDirReady(cacheDir: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(cacheDir);
  } catch {
    // Already exists — fine.
  }
  // The cache dir is `<…>/.luix/assetThumbs` — the gitignore goes one
  // level up so the whole `.luix/` folder is ignored.
  if (!cacheDir.path.includes("/.luix/")) {
    return;
  }
  const parent = vscode.Uri.joinPath(cacheDir, "..");
  const gitignore = vscode.Uri.joinPath(parent, ".gitignore");
  try {
    await vscode.workspace.fs.stat(gitignore);
    return; // already there
  } catch {
    // Need to write it.
  }
  try {
    await vscode.workspace.fs.writeFile(
      gitignore,
      new TextEncoder().encode(
        "# Auto-written by the Luix Roblox extension.\n" +
          "# Caches Roblox asset thumbnails for the inline image previews.\n" +
          "# Safe to ignore — they re-download on demand.\n" +
          "*\n"
      )
    );
  } catch {
    // Best-effort.
  }
}

/**
 * Tally up every PNG across the active cache and the global fallback
 * so the sidebar can display "N assets, X MB" honestly even if the
 * user flipped between cache locations.
 */
export async function getCacheStats(
  context: vscode.ExtensionContext
): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  for (const dir of allKnownCacheDirs(context)) {
    let entries: Array<[string, vscode.FileType]> = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue;
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) {continue;}
      if (!name.endsWith(".png")) {continue;}
      try {
        const stat = await vscode.workspace.fs.stat(
          vscode.Uri.joinPath(dir, name)
        );
        count++;
        bytes += stat.size;
      } catch {
        // Ignore individual stat failures.
      }
    }
  }
  return { count, bytes };
}

/**
 * Delete every cached thumbnail across both possible locations. Safe
 * to call when the cache is empty or the directories don't exist —
 * the call is idempotent.
 */
export async function purgeAllThumbnails(
  context: vscode.ExtensionContext
): Promise<void> {
  if (purgePromise) {return purgePromise;}
  cacheGeneration++;
  thumbnailUrlCache.clear();
  const purge = (async () => {
    // Finish writes already dispatched before deleting their directories;
    // downloads still in flight fail their generation check before writing.
    await Promise.allSettled([...activeWrites]);
    for (const dir of allKnownCacheDirs(context)) {
      try {
        await vscode.workspace.fs.delete(dir, {
          recursive: true,
          useTrash: false,
        });
      } catch {
        // Directory may not exist — fine.
      }
    }
  })();
  purgePromise = purge;
  try {
    await purge;
  } finally {
    if (purgePromise === purge) {purgePromise = undefined;}
  }
}

/** Extract every distinct asset ID referenced anywhere in the document. */
export function findAssetReferences(
  text: string
): Array<{ assetId: string; offset: number }> {
  const out: Array<{ assetId: string; offset: number }> = [];
  // Match `rbxassetid://NNNN` or `rbxasset://NNNN` inside any quote
  // style (`"…"`, `'…'`, Luau backticks). The thumbnails API treats both
  // prefixes the same; users sometimes type one and sometimes the other.
  const re = /(["'`])rbxasset(?:id)?:\/\/(\d+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ assetId: m[2], offset: m.index });
  }
  return out;
}
