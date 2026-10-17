import * as vscode from "vscode";
import { createHash } from "crypto";
import { configChangeAffects, getConfig } from "./configCompat";
import { getAliasPartition, getDirectInstanceClassNames } from "./frameworks";
import {
  AliasPartition,
  CreateElementCall,
  findAllCreateElementCalls,
  scanDocument,
  DocumentComponentInfo,
  withTransientAnalyses,
} from "./parser";

const MAX_PARALLEL_READS = 6;
const INDEX_SLICE_MS = 12;
// Cap file size because each parse blocks the event loop.
const MAX_INDEXED_FILE_BYTES = 2 * 1024 * 1024;
// Bound write deferral while scans keep arriving.
const PERSIST_MAX_WAIT_MS = 60_000;

function yieldToEventLoop(): Promise<void> {
  return typeof setImmediate === "function"
    ? new Promise((resolve) => setImmediate(resolve))
    : Promise.resolve();
}

// Match TextDocument decoding and line endings so stored offsets stay valid.
export function decodeFileText(bytes: Uint8Array): string {
  return normalizeLineEndings(decodeBytes(bytes));
}

function decodeBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder("utf-16be").decode(bytes);
    } catch {
      // Fall back to UTF-8 if UTF-16BE decoding is unavailable.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

// Match VS Code: CRLF wins when over half the breaks are CRLF or CR; normalize all breaks.
export function normalizeLineEndings(text: string): string {
  if (text.indexOf("\r") === -1) {
    return text;
  }
  let cr = 0;
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else {
        cr++;
      }
    } else if (c === 10) {
      lf++;
    }
  }
  const eol = cr + crlf > (cr + lf + crlf) / 2 ? "\r\n" : "\n";
  const uniform = eol === "\r\n" ? cr === 0 && lf === 0 : cr === 0 && crlf === 0;
  return uniform ? text : text.replace(/\r\n|\r|\n/g, eol);
}

export function positionsInText(text: string): (offset: number) => vscode.Position {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) {
      lineStarts.push(i + 1);
    }
  }
  return (offset) => {
    const at = Math.min(Math.max(0, offset), text.length);
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid] <= at) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return new vscode.Position(lo, at - lineStarts[lo]);
  };
}

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

// Skip tool copies and caches without excluding every dot-directory.
const TOOL_DIRS = [
  ".git",
  ".hg",
  ".svn",
  ".jj",
  ".claude",
  ".codex",
  ".worktrees",
  ".cache",
  ".history",
  ".vscode",
  ".vscode-test",
  ".idea",
  ".vs",
];
const TOOL_DIR_SET = new Set(TOOL_DIRS);

// Check only inside the workspace root, so workspaces opened within tool folders still index.
function isInToolFolder(uri: vscode.Uri): boolean {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return false;
  }
  const root = folder.uri.path.replace(/\/+$/, "");
  const path = uri.path;
  if (path.length <= root.length || path.slice(0, root.length).toLowerCase() !== root.toLowerCase()) {
    return false;
  }
  const directories = path.slice(root.length).split("/").slice(0, -1);
  return directories.some((segment) => TOOL_DIR_SET.has(segment.toLowerCase()));
}

function isIgnored(uri: vscode.Uri, excludedDirs: string[]): boolean {
  return isExcluded(uri, excludedDirs) || isInToolFolder(uri);
}

function buildExcludeGlob(excludedDirs: string[]): string {
  if (excludedDirs.length === 0) {
    return "";
  }
  return `**/{${excludedDirs.join(",")}}/**`;
}

// Require an element return or explicit @extends; @prop alone also occurs on ordinary helpers.
function looksLikeComponent(info: DocumentComponentInfo): boolean {
  if (info.detectedBase) {
    return true;
  }
  if (info.annotations.extendsClass) {
    return true;
  }
  return false;
}

// Lookups are name-based; duplicate component names use the first matching file.
interface CacheEntry {
  components: Map<string, DocumentComponentInfo>;
  // Call sites keyed by the final name segment: Components.Button becomes Button.
  callSites: Map<string, CreateElementCall[]>;
  fingerprint?: { mtime: number; size: number };
  // Invalidates derived work when this entry is replaced.
  stamp: number;
}

let nextEntryStamp = 0;

function parseForIndex(
  text: string,
  aliases: AliasPartition
): Pick<CacheEntry, "components" | "callSites"> {
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
  return { components, callSites };
}

export class WorkspaceIndex implements vscode.Disposable {
  private cache = new Map<string, CacheEntry>();
  private warmupPromise: Promise<void>;
  private disposables: vscode.Disposable[] = [];
  private _onDidChange = new vscode.EventEmitter<void>();
  private _changeTimer: NodeJS.Timeout | undefined;
  private _persistTimer: NodeJS.Timeout | undefined;
  private _unsavedSince: number | undefined;
  private _scanTimers = new Map<string, NodeJS.Timeout>();
  private context: vscode.ExtensionContext | undefined;
  private disposed = false;
  private generation = 0;
  private scanVersions = new Map<string, number>();
  private bufferBacked = new Set<string>();
  private readsInFlight = 0;
  private readWaiters: Array<() => void> = [];
  private sliceStart = 0;
  private membership = 0;
  private _sample: { membership: number; limit: number; uris: vscode.Uri[] } | undefined;
  // Invalidate these views whenever cache entries or gating configuration change.
  private _componentNamesCache: Set<string> | undefined;
  private _directCallTargetsCache: Set<string> | undefined;
  private _callSiteCounts: Map<string, number> | undefined;
  readonly onDidChangeIndex: vscode.Event<void> = this._onDidChange.event;

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

  private invalidateNameCaches(): void {
    this._componentNamesCache = undefined;
    this._directCallTargetsCache = undefined;
    this._callSiteCounts = undefined;
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
        if (isIgnored(e.document.uri, getExcludedDirs())) {
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
        // Discarded buffers must stop shadowing saved files.
        if (this.bufferBacked.has(doc.uri.toString())) {
          void this.scanUri(doc.uri).catch(() => {});
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.rebuild(false)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          configChangeAffects(e, "createElementAliases") ||
          configChangeAffects(e, "frameworks") ||
          configChangeAffects(e, "react.aliases") ||
          configChangeAffects(e, "roact.aliases") ||
          configChangeAffects(e, "fusion.aliases") ||
          configChangeAffects(e, "vide.aliases")
        ) {
          this.rebuild(true);
        } else if (configChangeAffects(e, "exclude")) {
          this.rebuild(false);
        } else if (configChangeAffects(e, "vide.directInstanceCalls")) {
          this._directCallTargetsCache = undefined;
        }
      })
    );
  }

  // Alias changes require reparsing; other rebuilds reuse matching fingerprints.
  private rebuild(reparse: boolean): void {
    this.generation++;
    for (const timer of this._scanTimers.values()) {clearTimeout(timer);}
    this._scanTimers.clear();
    if (reparse) {
      this.cache.clear();
      this.bufferBacked.clear();
      this.membership++;
    }
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
    this.bufferBacked.delete(key);
    if (this.cache.delete(key)) {
      this.membership++;
      this.invalidateNameCaches();
      this.scheduleChange();
      this.schedulePersist();
    }
  }

  private isLive(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private async warmup(): Promise<void> {
    const generation = this.generation;
    const configuration = cacheConfiguration();
    const excludedDirs = getExcludedDirs();
    const excludeGlob = buildExcludeGlob([...excludedDirs, ...TOOL_DIRS]);
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
    if (!this.isLive(generation)) {return;}
    const eligibleUris: vscode.Uri[] = [];
    const eligible = new Set<string>();
    this.sliceStart = Date.now();
    for (let i = 0; i < files.length; i++) {
      const uri = files[i];
      if (!isIgnored(uri, excludedDirs)) {
        eligibleUris.push(uri);
        eligible.add(uri.toString());
      }
      if (i % 512 === 511) {
        await this.breathe();
        if (!this.isLive(generation)) {return;}
      }
    }
    for (const key of this.cache.keys()) {
      if (!eligible.has(key)) {
        this.cache.delete(key);
        this.bufferBacked.delete(key);
        this.membership++;
      }
    }
    for (const [key, entry] of restored) {
      // Do not overwrite a buffer changed while the cache was loading.
      if (eligible.has(key) && !this.cache.has(key)) {
        this.cache.set(key, entry);
        this.membership++;
      }
    }
    this.invalidateNameCaches();
    // Workers share a queue to bound reads without allocating one promise per file.
    let next = 0;
    const worker = async () => {
      while (next < eligibleUris.length && this.isLive(generation)) {
        const uri = eligibleUris[next++];
        await this.scanUri(uri, generation).catch(() => undefined);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_PARALLEL_READS, eligibleUris.length) }, worker)
    );
    if (!this.isLive(generation)) {return;}
    // A warmup served entirely from cache must still notify consumers.
    this.invalidateNameCaches();
    this.scheduleChange();
    if (persistEnabled) {
      this.schedulePersist();
    }
  }

  private async acquireRead(): Promise<void> {
    while (this.readsInFlight >= MAX_PARALLEL_READS && !this.disposed) {
      await new Promise<void>((resolve) => this.readWaiters.push(resolve));
    }
    this.readsInFlight++;
  }

  private releaseRead(): void {
    this.readsInFlight--;
    this.readWaiters.shift()?.();
  }

  private async breathe(): Promise<void> {
    if (Date.now() - this.sliceStart >= INDEX_SLICE_MS) {
      await yieldToEventLoop();
      this.sliceStart = Date.now();
    }
  }

  private openDocument(key: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((doc) => !doc.isClosed && doc.uri.toString() === key);
  }

  // Read via workspace.fs to avoid triggering other extensions by opening documents.
  private async scanUri(uri: vscode.Uri, generation = this.generation): Promise<void> {
    if (!this.isLive(generation) ||
      !/\.(lua|luau)$/i.test(uri.path) ||
      !vscode.workspace.getWorkspaceFolder(uri) || isIgnored(uri, getExcludedDirs())) {
      return;
    }
    const key = uri.toString();
    const scanVersion = (this.scanVersions.get(key) ?? 0) + 1;
    this.scanVersions.set(key, scanVersion);
    const isCurrent = () => this.isLive(generation) &&
      this.scanVersions.get(key) === scanVersion;
    const open = this.openDocument(key);
    if (open?.isDirty) {
      this.scanText(open.uri, open.getText());
      return;
    }
    let stat: vscode.FileStat;
    let text: string;
    await this.acquireRead();
    try {
      if (!isCurrent()) {return;}
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        if (isCurrent()) {this.removeUri(uri);}
        return;
      }
      if (!isCurrent()) {return;}
      // Also remove oversized entries restored from an older cache.
      if (stat.size > MAX_INDEXED_FILE_BYTES) {
        if (this.cache.has(key)) {this.removeUri(uri);}
        return;
      }
      const cached = this.cache.get(key);
      if (cached?.fingerprint &&
        stat.mtime === cached.fingerprint.mtime &&
        stat.size === cached.fingerprint.size) {
        return;
      }
      text = decodeFileText(await vscode.workspace.fs.readFile(uri));
    } catch {
      return;
    } finally {
      this.releaseRead();
    }
    await this.breathe();
    if (!isCurrent()) {return;}
    // Keep the pre-read fingerprint so concurrent disk changes trigger another read.
    this.scanText(uri, text, { mtime: stat.mtime, size: stat.size });
  }

  private scanDocument(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    this.scanVersions.set(key, (this.scanVersions.get(key) ?? 0) + 1);
    this.scanText(doc.uri, doc.getText());
  }

  // Only disk snapshots have fingerprints; buffer parses are never persisted.
  private scanText(uri: vscode.Uri, text: string, fingerprint?: { mtime: number; size: number }): void {
    const key = uri.toString();
    if (text.length > MAX_INDEXED_FILE_BYTES) {
      if (this.cache.has(key)) {this.removeUri(uri);}
      return;
    }
    const aliases = getAliasPartition();
    const parsed = fingerprint
      ? withTransientAnalyses(() => parseForIndex(text, aliases))
      : parseForIndex(text, aliases);
    if (!this.cache.has(key)) {
      this.membership++;
    }
    this.cache.set(key, { ...parsed, fingerprint, stamp: ++nextEntryStamp });
    if (fingerprint) {
      this.bufferBacked.delete(key);
    } else {
      this.bufferBacked.add(key);
    }
    this.invalidateNameCaches();
    this.scheduleChange();
    this.schedulePersist();
  }

  async readText(uri: vscode.Uri): Promise<string | undefined> {
    const open = this.openDocument(uri.toString());
    if (open) {
      return open.getText();
    }
    await this.acquireRead();
    try {
      return decodeFileText(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    } finally {
      this.releaseRead();
    }
  }

  entryStamp(uri: vscode.Uri): number | undefined {
    return this.cache.get(uri.toString())?.stamp;
  }

  // Stable path-sorted sample, refreshed only when index membership changes.
  frameworkSample(limit: number): vscode.Uri[] {
    if (this._sample?.membership !== this.membership || this._sample.limit !== limit) {
      const uris = this.indexedUris().sort((a, b) => a.fsPath.localeCompare(b.fsPath));
      this._sample = { membership: this.membership, limit, uris: uris.slice(0, limit) };
    }
    return this._sample.uris;
  }

  private schedulePersist(): void {
    if (this.disposed || !this.context) {return;}
    if (!getConfig<boolean>("indexPersistence.enabled", true)) {return;}
    const now = Date.now();
    this._unsavedSince ??= now;
    // Allow pending writes once the oldest change reaches the deferral limit.
    if (this._persistTimer && now - this._unsavedSince >= PERSIST_MAX_WAIT_MS) {return;}
    if (this._persistTimer) {clearTimeout(this._persistTimer);}
    this._persistTimer = setTimeout(() => {
      this._persistTimer = undefined;
      void this.persistNow().catch(() => {});
    }, 5000);
  }

  private async persistNow(): Promise<void> {
    if (this.disposed || !this.context ||
      !getConfig<boolean>("indexPersistence.enabled", true)) {return;}
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = undefined;
    }
    this._unsavedSince = undefined;
    await this.writePersisted(this.context, serialiseCache(this.cache, cacheConfiguration()));
  }

  private async writePersisted(context: vscode.ExtensionContext, data: PersistedCache): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {return;}
    const file = persistFileFor(context);
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(file, "..")
      );
    } catch {
      // The directory may already exist.
    }
    await vscode.workspace.fs.writeFile(file, bytes);
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
      return restored; // No readable prior cache.
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
      // Discard partial loads from corrupt data.
      restored.clear();
    }
    return restored;
  }

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

  // Prefer files other than excludeUri; local inference has already checked the current file.
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

  indexedUris(): vscode.Uri[] {
    const out: vscode.Uri[] = [];
    for (const uriString of this.cache.keys()) {
      try {
        out.push(vscode.Uri.parse(uriString));
      } catch {
        // Skip malformed stored URIs.
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
        if (looksLikeComponent(info)) {
          out.add(name);
        }
      }
    }
    this._componentNamesCache = out;
    return out;
  }

  knownDirectCallTargets(): ReadonlySet<string> {
    if (this._directCallTargetsCache) {
      return this._directCallTargetsCache;
    }
    // Copy before adding built-ins; knownComponentNames must stay workspace-only.
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

  // Count cached call sites without reading files; resolve locations only on demand.
  countCallSites(componentName: string): number {
    const key = componentName.split(".").pop() ?? componentName;
    if (!this._callSiteCounts) {
      const counts = new Map<string, number>();
      for (const entry of this.cache.values()) {
        for (const [name, hits] of entry.callSites) {
          counts.set(name, (counts.get(name) ?? 0) + hits.length);
        }
      }
      this._callSiteCounts = counts;
    }
    return this._callSiteCounts.get(key) ?? 0;
  }

  async findCallSites(
    componentName: string
  ): Promise<Array<{ uri: vscode.Uri; range: vscode.Range }>> {
    await this.warmupPromise;
    const key = componentName.split(".").pop() ?? componentName;
    const out: Array<{ uri: vscode.Uri; range: vscode.Range }> = [];
    for (const [uriString, entry] of this.cache) {
      const hits = entry.callSites.get(key);
      if (!hits) {continue;}
      const uri = vscode.Uri.parse(uriString);
      const open = this.openDocument(uriString);
      let positionAt: (offset: number) => vscode.Position;
      if (open) {
        positionAt = (offset) => open.positionAt(offset);
      } else {
        const text = await this.readText(uri);
        if (text === undefined) {continue;}
        positionAt = positionsInText(text);
      }
      for (const call of hits) {
        out.push({
          uri,
          range: new vscode.Range(
            positionAt(call.classNameStart),
            positionAt(call.classNameEnd)
          ),
        });
      }
    }
    return out;
  }

  _seedForTesting(
    entries: Array<[string, Map<string, DocumentComponentInfo>]>
  ): void {
    this.generation++;
    for (const [uriString, components] of entries) {
      this.cache.set(uriString, {
        components,
        callSites: new Map(),
        stamp: ++nextEntryStamp,
      });
    }
    this.membership++;
    this.invalidateNameCaches();
    this.warmupPromise = Promise.resolve();
  }

  dispose(): void {
    // Flush pending changes before disposal.
    const flush = this._persistTimer && this.context &&
      getConfig<boolean>("indexPersistence.enabled", true)
      ? { context: this.context, data: serialiseCache(this.cache, cacheConfiguration()) }
      : undefined;
    this.disposed = true;
    this.generation++;
    for (const d of this.disposables) {
      d.dispose();
    }
    if (this._changeTimer) {
      clearTimeout(this._changeTimer);
      this._changeTimer = undefined;
    }
    // Cancel writes scheduled against an index that is no longer maintained.
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = undefined;
    }
    for (const t of this._scanTimers.values()) {
      clearTimeout(t);
    }
    this._scanTimers.clear();
    for (const wake of this.readWaiters.splice(0)) {
      wake();
    }
    this._onDidChange.dispose();
    if (flush) {
      void this.writePersisted(flush.context, flush.data).catch(() => {});
    }
  }
}

export const _internal = {
  isExcluded,
  isIgnored,
  DEFAULT_EXCLUDED_DIRS,
  TOOL_DIRS,
  MAX_INDEXED_FILE_BYTES,
  buildExcludeGlob,
};

// Bump PERSIST_VERSION when the serialized cache structure changes.

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
  // Include all roots and authorities to distinguish remote hosts with identical paths.
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
    // Unverified disk snapshots and dirty buffers must be reparsed next session.
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
    stamp: ++nextEntryStamp,
  };
}
