import * as vscode from "vscode";
import { getConfig } from "./configCompat";
import { logWarn } from "./output";

// Hover URLs stay in memory; gutter thumbnails are cached on disk.

const THUMBNAIL_SIZE = "150x150" as const;

interface CachedUrl {
  url: string | null;
  // Zero means uncached.
  expires: number;
  state?: ThumbnailState;
}
const thumbnailUrlCache = new Map<string, CachedUrl>();
let cacheGeneration = 0;
let purgePromise: Promise<void> | undefined;
const activeWrites = new Set<Promise<void>>();
const THUMBNAIL_TTL_OK = 24 * 60 * 60 * 1000;
const THUMBNAIL_TTL_FAIL = 10 * 1000;

// Retry transient API states without caching them.
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

export async function fetchAssetThumbnailUrl(
  assetId: string,
  size: string = THUMBNAIL_SIZE
): Promise<string | null> {
  const { url } = await fetchAssetThumbnail(assetId, size);
  return url;
}

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

// Include both locations so switching settings leaves no orphaned cache.
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
    // Cache miss; download below.
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

async function ensureCacheDirReady(cacheDir: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(cacheDir);
  } catch {
    // The directory may already exist.
  }
  // Ignore the entire .luix directory, not just assetThumbs.
  if (!cacheDir.path.includes("/.luix/")) {
    return;
  }
  const parent = vscode.Uri.joinPath(cacheDir, "..");
  const gitignore = vscode.Uri.joinPath(parent, ".gitignore");
  try {
    await vscode.workspace.fs.stat(gitignore);
    return;
  } catch {
    // Create the missing ignore file below.
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
    // Ignore-file creation is best effort.
  }
}

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
        // Skip unreadable files.
      }
    }
  }
  return { count, bytes };
}

export async function purgeAllThumbnails(
  context: vscode.ExtensionContext
): Promise<void> {
  if (purgePromise) {return purgePromise;}
  cacheGeneration++;
  thumbnailUrlCache.clear();
  const purge = (async () => {
    // Finish active writes before deletion; generation checks reject pending downloads.
    await Promise.allSettled([...activeWrites]);
    for (const dir of allKnownCacheDirs(context)) {
      try {
        await vscode.workspace.fs.delete(dir, {
          recursive: true,
          useTrash: false,
        });
      } catch {
        // The directory may not exist.
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

export function findAssetReferences(
  text: string
): Array<{ assetId: string; offset: number }> {
  const out: Array<{ assetId: string; offset: number }> = [];
  const re = /(["'`])rbxasset(?:id)?:\/\/(\d+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ assetId: m[2], offset: m.index });
  }
  return out;
}
