import * as vscode from "vscode";
import { getConfig } from "./configCompat";
import { classHierarchy, defaultPropsMap, rebuildDerivedClassData } from "./data";

// API-dump augmentation is additive; built-in properties win conflicts.

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
  try {
    const stat = await vscode.workspace.fs.stat(cacheFile);
    const age = Date.now() - stat.mtime;
    if (age < CACHE_TTL_MS) {
      const bytes = await vscode.workspace.fs.readFile(cacheFile);
      return JSON.parse(new TextDecoder().decode(bytes)) as ApiDump;
    }
  } catch {
    // Cache miss; fetch below.
  }
  try {
    const res = await fetch(API_DUMP_URL, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {return undefined;}
    const text = await res.text();
    const parsed = JSON.parse(text) as ApiDump;
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(cacheFile, "..")
      );
    } catch {
      // The directory may already exist.
    }
    await vscode.workspace.fs.writeFile(
      cacheFile,
      new TextEncoder().encode(text)
    );
    return parsed;
  } catch {
    // Use stale cache when the network is unavailable.
    try {
      const bytes = await vscode.workspace.fs.readFile(cacheFile);
      return JSON.parse(new TextDecoder().decode(bytes)) as ApiDump;
    } catch {
      return undefined;
    }
  }
}

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
    // Include inherited properties when deduplicating.
    const existing = new Set(defaultPropsMap[className]);
    for (const m of cls.Members) {
      if (m.MemberType !== "Property") {continue;}
      if (!m.Name) {continue;}
      if (existing.has(m.Name)) {continue;}
      // Parent is admitted per framework, not as a class property.
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
      // Update the hierarchy so descendants inherit the additions.
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
