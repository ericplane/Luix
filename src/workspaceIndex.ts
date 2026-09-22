import * as vscode from "vscode";
import { createHash } from "crypto";
import { configChangeAffects, getConfig } from "./configCompat";
import { getAliasPartition, getDirectInstanceClassNames } from "./frameworks";
import {
  CreateElementCall,
  findAllCreateElementCalls,
  scanDocument,
  DocumentComponentInfo,
} from "./parser";

/**
 * Directories Luix always skips when indexing the workspace. These are
 * the conventional homes of vendored / third-party Roblox code; the
 * user's own UI components live elsewhere.
 *
 *   - `Packages` / `DevPackages` / `ServerPackages` — Wally's package
 *     output directories.
 *   - `_Index` — Wally's internal package store under `Packages/`.
 *   - `node_modules` / `out` / `dist` — JS / build artifacts.
 *
 * Users can extend this list via `luix.exclude`.
 */
const DEFAULT_EXCLUDED_DIRS = [
  "Packages",
  "DevPackages",
  "ServerPackages",
  "_Index",
  "node_modules",
  "out",
  "dist",
];

function getExcludedDirs(): string[] {
  const extra = getConfig<string[]>("exclude", []) ?? [];
  return [...DEFAULT_EXCLUDED_DIRS, ...extra];
}

function isExcluded(uri: vscode.Uri, excludedDirs: string[]): boolean {
  const segments = uri.fsPath.split(/[/\\]/);
  for (const seg of segments) {
    if (excludedDirs.includes(seg)) {
      return true;
    }
  }
  return false;
}

function buildExcludeGlob(excludedDirs: string[]): string {
  if (excludedDirs.length === 0) {
    return "";
  }
  // `**/{Packages,DevPackages,...}/**` matches every file under any of
  // the named directories at any depth.
  return `**/{${excludedDirs.join(",")}}/**`;
}

/**
 * Conservative check for whether a `DocumentComponentInfo` describes
 * something that's actually a UI component (vs. a utility function the
 * parser also picked up). At least one strong signal must be present:
 *
 *   - The function returns an element call (`detectedBase` set), OR
 *   - It carries an explicit `---@extends ClassName` annotation.
 *
 * The annotated-but-no-extends case (e.g. only `---@prop name type`
 * lines) is intentionally excluded — that pattern shows up on
 * non-component helpers too.
 */
function looksLikeComponent(info: DocumentComponentInfo): boolean {
  if (info.detectedBase) {
    return true;
  }
  if (info.annotations.extendsClass) {
    return true;
  }
  return false;
}

/**
 * Workspace-wide component index. Scans every `.lua`/`.luau` file in the
 * project once, then keeps itself fresh via the file-system watcher and the
 * onDidChangeTextDocument event (so unsaved buffers are reflected).
 *
 * Files under Wally / vendored directories are skipped — see
 * `DEFAULT_EXCLUDED_DIRS` above.
 *
 * Lookups are name-based: the first matching component in the index wins.
 * If multiple files declare a component with the same identifier, this is
 * a best-effort guess (cross-file `require` resolution would be needed for
 * full precision and is a documented limitation).
 */
interface CacheEntry {
  components: Map<string, DocumentComponentInfo>;
  /** Every component call site in the file, keyed by the last segment
   *  of the called name (`Components.Button` → `Button`). Used by the
   *  "N references" CodeLens. */
  callSites: Map<string, CreateElementCall[]>;
  /** mtime + size fingerprint used by the on-disk cache to decide
   *  whether a file needs re-parsing on cold start. */
  fingerprint?: { mtime: number; size: number };
}

export class WorkspaceIndex implements vscode.Disposable {
  private cache = new Map<string, CacheEntry>();
  private warmupPromise: Promise<void>;
  private disposables: vscode.Disposable[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  private _changeTimer: NodeJS.Timeout | undefined;
  private _persistTimer: NodeJS.Timeout | undefined;
  private _scanTimers = new Map<string, NodeJS.Timeout>();
  private context: vscode.ExtensionContext | undefined;
  private disposed = false;
  private generation = 0;
  private scanVersions = new Map<string, number>();
  /**
   * Memoised view of every component name across the cache, lazily built
   * on first read after a cache mutation. Completion / hover / anchor /
   * diagnostics paths read this 4+ times per keystroke; rebuilding by
   * walking every file each call dominated provider overhead on large
   * workspaces. Invalidate via `invalidateNameCaches()` whenever the
   * cache or the gating config changes.
   */
  private _componentNamesCache: Set<string> | undefined;
  /** Memoised union of workspace components + Vide instance class
   *  names (when the setting is on). Same invalidation rules. */
  private _directCallTargetsCache: Set<string> | undefined;
  /** Fires after the index reaches a new steady state — used by the
   *  Components sidebar to refresh. Debounced so a burst of keystrokes
   *  doesn't rebuild the tree dozens of times per second. */
  readonly onDidChangeIndex: vscode.Event<void> = this._onDidChange.event;

  /** Coalesce rapid scan calls into a single fire (200ms). */
  private scheduleChange(): void {
    if (this.disposed) {return;}
    if (this._changeTimer) {
      clearTimeout(this._changeTimer);
    }
    this._changeTimer = setTimeout(() => {
      this._changeTimer = undefined;
      this._onDidChange.fire();
    }, 200);
  }

  /** Drop the memoised component-name views. Called from every site
   *  that mutates `this.cache` so the next read rebuilds fresh. */
  private invalidateNameCaches(): void {
    this._componentNamesCache = undefined;
    this._directCallTargetsCache = undefined;
  }

  constructor(context?: vscode.ExtensionContext) {
    this.context = context;
    this.warmupPromise = this.warmup().catch(() => {});

    const watcher = vscode.workspace.createFileSystemWatcher(
      "**/*.{lua,luau}"
    );
    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => {
        this.scanUri(uri).catch(() => {});
      }),
      watcher.onDidCreate((uri) => {
        this.scanUri(uri).catch(() => {});
      }),
      watcher.onDidDelete((uri) => {
        this.removeUri(uri);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) {return;}
        const langId = e.document.languageId;
        if (langId !== "lua" && langId !== "luau") {
          return;
        }
        if (isExcluded(e.document.uri, getExcludedDirs())) {
          return;
        }
        if (!vscode.workspace.getWorkspaceFolder(e.document.uri)) {return;}
        const key = e.document.uri.toString();
        this.scanVersions.set(key, (this.scanVersions.get(key) ?? 0) + 1);
        const existing = this._scanTimers.get(key);
        if (existing) {
          clearTimeout(existing);
        }
        this._scanTimers.set(
          key,
          setTimeout(() => {
            this._scanTimers.delete(key);
            if (!this.disposed && !e.document.isClosed) {
              this.scanDocument(e.document);
            }
          }, 200)
        );
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        void this.scanUri(doc.uri).catch(() => {});
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        // A discarded buffer must stop shadowing the saved file.
        void this.scanUri(doc.uri).catch(() => {});
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuild()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          configChangeAffects(e, "createElementAliases") ||
          configChangeAffects(e, "frameworks") ||
          configChangeAffects(e, "react.aliases") ||
          configChangeAffects(e, "roact.aliases") ||
          configChangeAffects(e, "fusion.aliases") ||
          configChangeAffects(e, "vide.aliases") ||
          configChangeAffects(e, "exclude")
        ) {
          this.rebuild();
        } else if (configChangeAffects(e, "vide.directInstanceCalls")) {
          // Doesn't change the parsed cache, just the direct-call gate;
          // bust the union cache so the next read picks up the new
          // built-in-class set (or absence of it).
          this._directCallTargetsCache = undefined;
        }
      })
    );
  }

  private rebuild(): void {
    this.generation++;
    for (const timer of this._scanTimers.values()) {clearTimeout(timer);}
    this._scanTimers.clear();
    this.cache.clear();
    this.invalidateNameCaches();
    this.warmupPromise = this.warmup().catch(() => {});
    this.scheduleChange();
  }

  private removeUri(uri: vscode.Uri): void {
    const key = uri.toString();
    this.scanVersions.set(key, (this.scanVersions.get(key) ?? 0) + 1);
    const timer = this._scanTimers.get(key);
    if (timer) {clearTimeout(timer);}
    this._scanTimers.delete(key);
    if (this.cache.delete(key)) {
      this.invalidateNameCaches();
      this.scheduleChange();
      this.schedulePersist();
    }
  }

  private async warmup(): Promise<void> {
    const generation = this.generation;
    const configuration = cacheConfiguration();
    const excludedDirs = getExcludedDirs();
    const excludeGlob = buildExcludeGlob(excludedDirs);
    // Restore persisted cache (if any) before scanning so unchanged
    // files can be re-used without re-parsing. The persist file is
    // versioned + workspace-scoped; a mismatch silently falls back to
    // a full rescan.
    const persistEnabled =
      getConfig<boolean>("indexPersistence.enabled", true) &&
      this.context !== undefined;
    const restored = persistEnabled
      ? await this.loadPersistedCache(configuration).catch(() => new Map<string, CacheEntry>())
      : new Map<string, CacheEntry>();
    const files = await vscode.workspace.findFiles(
      "**/*.{lua,luau}",
      excludeGlob || null
    );
    if (this.disposed || generation !== this.generation) {return;}
    const eligible = new Set(files
      .filter((uri) => !isExcluded(uri, excludedDirs))
      .map((uri) => uri.toString()));
    for (const key of this.cache.keys()) {
      if (!eligible.has(key)) {this.cache.delete(key);}
    }
    for (const [key, entry] of restored) {
      // Do not overwrite a buffer changed while the cache was loading.
      if (eligible.has(key) && !this.cache.has(key)) {this.cache.set(key, entry);}
    }
    this.invalidateNameCaches();
    await Promise.all(
      files.map((uri) => this.scanUri(uri, generation).catch(() => undefined))
    );
    if (this.disposed || generation !== this.generation) {return;}
    // Cache hits are also a completed warmup: notify consumers even
    // when no file needed reparsing.
    this.invalidateNameCaches();
    this.scheduleChange();
    if (persistEnabled) {
      this.schedulePersist();
    }
  }

  private async scanUri(uri: vscode.Uri, generation = this.generation): Promise<void> {
    if (this.disposed || generation !== this.generation ||
      !/\.(lua|luau)$/i.test(uri.path) ||
      !vscode.workspace.getWorkspaceFolder(uri) || isExcluded(uri, getExcludedDirs())) {
      return;
    }
    const key = uri.toString();
    const scanVersion = (this.scanVersions.get(key) ?? 0) + 1;
    this.scanVersions.set(key, scanVersion);
    const isCurrent = () => !this.disposed && generation === this.generation &&
      this.scanVersions.get(key) === scanVersion;
    const open = vscode.workspace.textDocuments.find((doc) => !doc.isClosed && doc.uri.toString() === key);
    if (open?.isDirty) {
      this.scanText(open.uri, open.getText());
      return;
    }
    // Skip re-parsing if the persisted cache entry matches the file's
    // current size + mtime.
    const cached = this.cache.get(key);
    let before: vscode.FileStat;
    try {
      before = await vscode.workspace.fs.stat(uri);
      if (!isCurrent()) {return;}
      if (cached?.fingerprint) {
        if (
          before.mtime === cached.fingerprint.mtime &&
          before.size === cached.fingerprint.size
        ) {
          return;
        }
      }
    } catch {
      if (isCurrent()) {this.removeUri(uri);}
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    if (!isCurrent()) {return;}
    const version = doc.version;
    this.scanText(doc.uri, doc.getText());
    // Stamp the fresh fingerprint so subsequent cold-starts can skip.
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const entry = this.cache.get(key);
      if (isCurrent() && entry && !doc.isDirty && doc.version === version &&
        before.mtime === stat.mtime && before.size === stat.size) {
        entry.fingerprint = { mtime: stat.mtime, size: stat.size };
      }
    } catch {
      // Best-effort.
    }
  }

  private scanDocument(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    this.scanVersions.set(key, (this.scanVersions.get(key) ?? 0) + 1);
    this.scanText(doc.uri, doc.getText());
  }

  private scanText(uri: vscode.Uri, text: string): void {
    const aliases = getAliasPartition();
    const components = scanDocument(text, aliases);
    const callSites = new Map<string, CreateElementCall[]>();
    for (const call of findAllCreateElementCalls(text, aliases)) {
      if (call.isStringLiteralName) {
        continue;
      }
      const key = call.className.split(".").pop() ?? call.className;
      const list = callSites.get(key);
      if (list) {
        list.push(call);
      } else {
        callSites.set(key, [call]);
      }
    }
    // Buffer contents have no disk fingerprint. Only scanUri can stamp
    // one after checking that the saved file and document stayed stable.
    this.cache.set(uri.toString(), {
      components,
      callSites,
    });
    this.invalidateNameCaches();
    this.scheduleChange();
    this.schedulePersist();
  }

  // ---- Persistence ------------------------------------------------------

  private schedulePersist(): void {
    if (this.disposed || !this.context) {return;}
    if (!getConfig<boolean>("indexPersistence.enabled", true)) {return;}
    if (this._persistTimer) {clearTimeout(this._persistTimer);}
    // 5s after the last change — avoids hammering disk during edits.
    this._persistTimer = setTimeout(() => {
      this._persistTimer = undefined;
      void this.persistNow().catch(() => {});
    }, 5000);
  }

  private async persistNow(): Promise<void> {
    if (this.disposed || !this.context ||
      !getConfig<boolean>("indexPersistence.enabled", true)) {return;}
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {return;}
    const generation = this.generation;
    const file = persistFileFor(this.context);
    const data = serialiseCache(this.cache, cacheConfiguration());
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(file, "..")
      );
    } catch {
      // exists — fine.
    }
    if (this.disposed || generation !== this.generation) {return;}
    await vscode.workspace.fs.writeFile(
      file,
      new TextEncoder().encode(JSON.stringify(data))
    );
  }

  private async loadPersistedCache(configuration: string): Promise<Map<string, CacheEntry>> {
    const restored = new Map<string, CacheEntry>();
    if (!this.context) {return restored;}
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {return restored;}
    const file = persistFileFor(this.context);
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(file);
    } catch {
      return restored; // No prior cache.
    }
    try {
      const data = JSON.parse(new TextDecoder().decode(bytes)) as PersistedCache;
      if (data.version !== PERSIST_VERSION || data.configuration !== configuration) {
        return restored;
      }
      for (const [uriStr, entry] of Object.entries(data.files)) {
        if (entry.fingerprint) {restored.set(uriStr, deserialiseEntry(entry));}
      }
    } catch {
      // Do not retain a partial load from corrupt data.
      restored.clear();
    }
    return restored;
  }

  /**
   * Returns every component currently in the index, alphabetised by
   * name. Only functions that actually look like UI components are
   * included — see `looksLikeComponent` for the rule. Helper functions
   * that happen to take a `props` parameter but never return an element
   * are filtered out.
   */
  async getAllComponents(): Promise<
    Array<{ name: string; uri: vscode.Uri; info: DocumentComponentInfo }>
  > {
    await this.warmupPromise;
    const out: Array<{
      name: string;
      uri: vscode.Uri;
      info: DocumentComponentInfo;
    }> = [];
    for (const [uriString, entry] of this.cache) {
      for (const [name, info] of entry.components) {
        if (!looksLikeComponent(info)) {
          continue;
        }
        out.push({ name, uri: vscode.Uri.parse(uriString), info });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Returns the first match for `componentName` across the workspace,
   * preferring files other than `excludeUri` (typically the file the user
   * is editing — its own contents have already been searched by the
   * same-file inference pass).
   */
  async findComponent(
    componentName: string,
    excludeUri?: string
  ): Promise<DocumentComponentInfo | undefined> {
    await this.warmupPromise;
    for (const [uriString, entry] of this.cache) {
      if (uriString === excludeUri) {
        continue;
      }
      const found = entry.components.get(componentName);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /**
   * Like findComponent, but returns the URI of the defining file alongside
   * the parsed info. Used by auto-import to locate the file to import from.
   */
  async findComponentFile(
    componentName: string,
    excludeUri?: string
  ): Promise<{ uri: vscode.Uri; info: DocumentComponentInfo } | undefined> {
    await this.warmupPromise;
    const lastSegment = componentName.split(".").pop() ?? componentName;
    for (const [uriString, entry] of this.cache) {
      if (uriString === excludeUri) {
        continue;
      }
      const found = entry.components.get(lastSegment);
      if (found) {
        return { uri: vscode.Uri.parse(uriString), info: found };
      }
    }
    return undefined;
  }

  /**
   * Synchronous snapshot of every component name the index currently
   * knows about, across every indexed file. Used by the parser's
   * direct-component-call detection (`MyComp({...})` / `MyComp {...}`)
   * to decide whether a bare identifier should be treated as a Vide /
   * Fusion custom-component call rather than a plain Lua function.
   *
   * Cheap — walks the cache once per call. Callers are completion /
   * hover / diagnostics paths that already accept a couple of ms of
   * setup work per keystroke. If this becomes a hotspot, memoise on
   * `onDidChangeIndex`.
   */
  /**
   * Snapshot list of every URI the index has scanned. Used by
   * activeFramework's workspace-fallback inference to pull a sample
   * of file texts and tally which framework dominates the project.
   * Cheap — just `Array.from(this.cache.keys())`.
   */
  indexedUris(): vscode.Uri[] {
    const out: vscode.Uri[] = [];
    for (const uriString of this.cache.keys()) {
      try {
        out.push(vscode.Uri.parse(uriString));
      } catch {
        // Skip unparseable URIs — shouldn't happen, the index stores
        // them via toString() round-trip.
      }
    }
    return out;
  }

  knownComponentNames(): ReadonlySet<string> {
    if (this._componentNamesCache) {
      return this._componentNamesCache;
    }
    const out = new Set<string>();
    for (const entry of this.cache.values()) {
      for (const [name, info] of entry.components) {
        // `entry.components` indexes *every* function definition the
        // parser finds — including ordinary helpers like
        // `ProductRegistry.GetGamepassProduct`. Only the ones that
        // look like UI components (return an element call, or carry
        // an explicit `@extends ClassName` annotation) should surface
        // as workspace-component completion targets. Without this
        // filter, typing `Pro` in a server script would surface every
        // workspace function whose name starts with `Pro` as a
        // "Luix component".
        if (looksLikeComponent(info)) {
          out.add(name);
        }
      }
    }
    this._componentNamesCache = out;
    return out;
  }

  /**
   * Workspace components plus the built-in Vide instance class names
   * (when `luix.vide.directInstanceCalls` is on and Vide is enabled).
   * This is the set Luix passes to the parser's direct-call detection.
   *
   * Workspace components are added *after* the built-ins so a
   * user-defined `Frame` shadows Roblox's `Frame` — but since the
   * parser just checks membership, the order doesn't actually matter
   * for detection; the precedence happens downstream in
   * `getPropsForClass`, which already looks up workspace components
   * before built-ins.
   */
  knownDirectCallTargets(): ReadonlySet<string> {
    if (this._directCallTargetsCache) {
      return this._directCallTargetsCache;
    }
    // Build a fresh copy of the component names so the in-place add of
    // built-in class names doesn't pollute `knownComponentNames`'s
    // cached view (which is workspace-only by contract).
    const out = new Set(this.knownComponentNames());
    const instances = getDirectInstanceClassNames();
    if (instances) {
      for (const name of instances) {
        out.add(name);
      }
    }
    this._directCallTargetsCache = out;
    return out;
  }

  /**
   * Synchronous count of how many call sites a component has across the
   * indexed workspace. Doesn't open any files — pure cache walk. Used
   * by the CodeLens provider's "N references" label so it can compute
   * counts for every component in the document without paying the
   * per-file `openTextDocument` cost that `findCallSites` incurs;
   * the actual Locations are only materialised when the user clicks the
   * lens.
   */
  countCallSites(componentName: string): number {
    const key = componentName.split(".").pop() ?? componentName;
    let total = 0;
    for (const entry of this.cache.values()) {
      const hits = entry.callSites.get(key);
      if (hits) {total += hits.length;}
    }
    return total;
  }

  /**
   * Locate every call site of a component across the indexed workspace,
   * returned as `{ uri, range }` pairs that the CodeLens provider can
   * surface as references. Self-calls inside the defining file are
   * included.
   */
  async findCallSites(
    componentName: string
  ): Promise<Array<{ uri: vscode.Uri; range: vscode.Range }>> {
    await this.warmupPromise;
    const key = componentName.split(".").pop() ?? componentName;
    const out: Array<{ uri: vscode.Uri; range: vscode.Range }> = [];
    for (const [uriString, entry] of this.cache) {
      const hits = entry.callSites.get(key);
      if (!hits) {continue;}
      let doc: vscode.TextDocument | undefined;
      try {
        doc = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(uriString)
        );
      } catch {
        continue;
      }
      for (const call of hits) {
        out.push({
          uri: doc.uri,
          range: new vscode.Range(
            doc.positionAt(call.classNameStart),
            doc.positionAt(call.classNameEnd)
          ),
        });
      }
    }
    return out;
  }

  /**
   * For tests: directly seed the cache with parsed component info.
   */
  _seedForTesting(
    entries: Array<[string, Map<string, DocumentComponentInfo>]>
  ): void {
    this.generation++;
    for (const [uriString, components] of entries) {
      this.cache.set(uriString, {
        components,
        callSites: new Map(),
      });
    }
    this.invalidateNameCaches();
    this.warmupPromise = Promise.resolve();
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const d of this.disposables) {
      d.dispose();
    }
    if (this._changeTimer) {
      clearTimeout(this._changeTimer);
      this._changeTimer = undefined;
    }
    // A persist timer armed within the last 5s would otherwise hold a
    // closure over `this.cache` past dispose and write to disk after
    // the extension shut down. Easy to reproduce by quickly closing
    // and reopening a window during heavy editing.
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = undefined;
    }
    for (const t of this._scanTimers.values()) {
      clearTimeout(t);
    }
    this._scanTimers.clear();
    this._onDidChange.dispose();
  }
}

/**
 * Exported for unit tests.
 */
export const _internal = {
  isExcluded,
  DEFAULT_EXCLUDED_DIRS,
  buildExcludeGlob,
};

// ============================================================================
// Persistence support
// ============================================================================
//
// The persisted cache lives in the extension's global storage, keyed by
// a hash of the workspace path. Bump `PERSIST_VERSION` whenever the
// serialised structure changes; older caches are silently discarded on
// load.

const PERSIST_VERSION = 2;

interface PersistedCache {
  version: number;
  configuration: string;
  files: Record<string, PersistedFileEntry>;
}
interface PersistedFileEntry {
  fingerprint?: { mtime: number; size: number };
  components: Array<[string, PersistedComponentInfo]>;
  callSites: Array<[string, CreateElementCall[]]>;
}
interface PersistedComponentInfo {
  name: string;
  defLineIndex: number;
  paramTypeFields?: string[];
  annotations: { extendsClass?: string; props: string[] };
  detectedBase?: string;
  hardcodedProps?: string[];
}

function cacheConfiguration(): string {
  return JSON.stringify({
    aliases: getAliasPartition(),
    excluded: [...getExcludedDirs()].sort(),
  });
}

function persistFileFor(context: vscode.ExtensionContext): vscode.Uri {
  // Include every root and URI authority (remote workspaces can have
  // identical filesystem paths on different hosts).
  const roots = (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri.toString()).sort();
  const tag = createHash("sha256").update(JSON.stringify(roots)).digest("hex");
  return vscode.Uri.joinPath(
    context.globalStorageUri,
    "workspaceIndex",
    `${tag}.json`
  );
}

function serialiseCache(
  cache: Map<string, CacheEntry>,
  configuration: string
): PersistedCache {
  const files: Record<string, PersistedFileEntry> = {};
  for (const [uri, entry] of cache) {
    // Dirty buffers and scans without a verified disk snapshot must
    // be reparsed next session, never restored as saved-file data.
    if (!entry.fingerprint) {continue;}
    const components: Array<[string, PersistedComponentInfo]> = [];
    for (const [name, info] of entry.components) {
      components.push([
        name,
        {
          name: info.name,
          defLineIndex: info.defLineIndex,
          paramTypeFields: info.paramTypeFields,
          annotations: {
            extendsClass: info.annotations.extendsClass,
            props: info.annotations.props,
          },
          detectedBase: info.detectedBase,
          hardcodedProps: info.hardcodedProps
            ? Array.from(info.hardcodedProps)
            : undefined,
        },
      ]);
    }
    files[uri] = {
      fingerprint: entry.fingerprint,
      components,
      callSites: Array.from(entry.callSites.entries()),
    };
  }
  return { version: PERSIST_VERSION, configuration, files };
}

function deserialiseEntry(entry: PersistedFileEntry): CacheEntry {
  const components = new Map<string, DocumentComponentInfo>();
  for (const [name, info] of entry.components) {
    components.set(name, {
      name: info.name,
      defLineIndex: info.defLineIndex,
      paramTypeFields: info.paramTypeFields,
      annotations: {
        extendsClass: info.annotations.extendsClass,
        props: info.annotations.props,
      },
      detectedBase: info.detectedBase,
      hardcodedProps: info.hardcodedProps
        ? new Set(info.hardcodedProps)
        : undefined,
    });
  }
  return {
    components,
    callSites: new Map(entry.callSites),
    fingerprint: entry.fingerprint,
  };
}
