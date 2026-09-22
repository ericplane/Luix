import * as vscode from "vscode";
import { getConfig } from "./configCompat";
import { classHierarchy, defaultPropsMap, rebuildDerivedClassData } from "./data";

// ============================================================================
// Roblox API-dump augmentation (opt-in, background)
// ============================================================================
//
// Off by default. When the user flips `luix.useRobloxApiDump` on, we
// fetch the community-maintained Mini-API-Dump JSON, cache it for 24h
// under the extension's global storage, and merge any *additional*
// properties it reports for classes we already know about into the
// in-memory `defaultPropsMap`. Built-in props win on conflicts so our
// hand-curated synthetic levels (`GuiObject`, `UILayout`, etc.) stay
// authoritative.
//
// The augmentation is one-way and additive — we never DROP properties
// from `defaultPropsMap`, so a stale or partial dump can't break
// existing completions.

const API_DUMP_URL =
  "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Mini-API-Dump.json";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface ApiClassMember {
  MemberType?: string;
  Name?: string;
  Tags?: string[];
}
interface ApiClass {
  Name?: string;
  Members?: ApiClassMember[];
  Tags?: string[];
}
interface ApiDump {
  Classes?: ApiClass[];
}

let mergeApplied = false;

/**
 * Kick off the API-dump fetch + merge on activation. Returns
 * immediately; the merge happens in the background and updates the
 * in-memory prop map when it lands. Safe to call repeatedly — the
 * fetch is short-circuited when the cache is fresh.
 */
export function maybeAugmentFromApiDump(
  context: vscode.ExtensionContext
): void {
  if (!getConfig<boolean>("useRobloxApiDump", false)) {
    return;
  }
  void (async () => {
    const dump = await loadDump(context);
    if (!dump || mergeApplied) {return;}
    mergeIntoBuiltins(dump);
    mergeApplied = true;
  })();
}

async function loadDump(
  context: vscode.ExtensionContext
): Promise<ApiDump | undefined> {
  const cacheFile = vscode.Uri.joinPath(
    context.globalStorageUri,
    "api-dump.json"
  );
  // 1) Try the cache first.
  try {
    const stat = await vscode.workspace.fs.stat(cacheFile);
    const age = Date.now() - stat.mtime;
    if (age < CACHE_TTL_MS) {
      const bytes = await vscode.workspace.fs.readFile(cacheFile);
      return JSON.parse(new TextDecoder().decode(bytes)) as ApiDump;
    }
  } catch {
    // Not cached — fall through to fetch.
  }
  // 2) Fetch.
  try {
    const res = await fetch(API_DUMP_URL, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {return undefined;}
    const text = await res.text();
    // Validate it parses before writing.
    const parsed = JSON.parse(text) as ApiDump;
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(cacheFile, "..")
      );
    } catch {
      // exists — fine.
    }
    await vscode.workspace.fs.writeFile(
      cacheFile,
      new TextEncoder().encode(text)
    );
    return parsed;
  } catch {
    // Best-effort. A stale cache still works if the network is dead.
    try {
      const bytes = await vscode.workspace.fs.readFile(cacheFile);
      return JSON.parse(new TextDecoder().decode(bytes)) as ApiDump;
    } catch {
      return undefined;
    }
  }
}

/**
 * For every class we already know about in `defaultPropsMap`, look up
 * the same class in the dump and append any properties the dump knows
 * that we don't. Skip properties tagged `Deprecated`, `NotScriptable`,
 * `Hidden`, or `ReadOnly` — those would be noise in a completion list.
 */
function mergeIntoBuiltins(dump: ApiDump): void {
  if (!dump.Classes) {return;}
  const byName = new Map<string, ApiClass>();
  for (const cls of dump.Classes) {
    if (cls?.Name) {byName.set(cls.Name, cls);}
  }
  let mutated = false;
  for (const className of Object.keys(defaultPropsMap)) {
    const cls = byName.get(className);
    if (!cls?.Members) {continue;}
    const hierarchyEntry = classHierarchy[className];
    if (!hierarchyEntry) {continue;}
    // Dedupe against the *flattened* prop list (which includes inherited
    // props from synthetic intermediate classes like `GuiObject`).
    // Otherwise we'd re-add inherited props onto every subclass.
    const existing = new Set(defaultPropsMap[className]);
    for (const m of cls.Members) {
      if (m.MemberType !== "Property") {continue;}
      if (!m.Name) {continue;}
      if (existing.has(m.Name)) {continue;}
      // `Parent` is a real Instance property in the dump, but Luix
      // admits it per framework (`FrameworkSpec.parentAsProp`) rather
      // than as a class prop — merging it here would offer it to
      // React/Roact and silence the diagnostic there.
      if (m.Name === "Parent") {
        continue;
      }
      const tags = m.Tags ?? [];
      if (
        tags.includes("Deprecated") ||
        tags.includes("NotScriptable") ||
        tags.includes("Hidden") ||
        tags.includes("ReadOnly")
      ) {
        continue;
      }
      // Push to the *source of truth* (classHierarchy[name].own) so
      // descendants pick the prop up when we re-flatten below. The
      // previous implementation mutated `defaultPropsMap[className]`
      // directly, which left ScrollingFrame / TextLabel / etc. with
      // their stale pre-merge flattened lists.
      hierarchyEntry.own.push(m.Name);
      existing.add(m.Name);
      mutated = true;
    }
  }
  if (mutated) {
    rebuildDerivedClassData();
  }
}

export const _internal = {
  mergeIntoBuiltins,
};
