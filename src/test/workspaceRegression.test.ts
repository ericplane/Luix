import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import * as vscode from "vscode";
import type { WorkspaceIndex } from "../workspaceIndex";

/** Run real compiled modules against isolated in-memory VS Code services.
 * No workspace files, settings, terminals, or network requests are changed. */
function load<T>(name: string, stubs: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const filename = path.join(__dirname, "..", `${name}.js`);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, Buffer, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, process, AbortSignal,
    require: (id: string) => Object.prototype.hasOwnProperty.call(stubs, id)
      ? stubs[id] : require(require.resolve(id, { paths: [path.dirname(filename)] })),
    ...globals,
  }, { filename });
  return module.exports as T;
}

const noopEvent = () => ({ dispose() {} });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function clock() {
  let id = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  return {
    globals: {
      setTimeout: (callback: () => void, delay: number) => {
        timers.set(++id, { callback, delay }); return id;
      },
      clearTimeout: (key: number) => timers.delete(key),
    },
    fire: (delay: number) => {
      for (const [key, timer] of [...timers]) {
        if (timer.delay === delay) { timers.delete(key); timer.callback(); }
      }
    },
    has: (delay: number) => [...timers.values()].some((timer) => timer.delay === delay),
  };
}

function indexHarness() {
  const root = vscode.Uri.file(path.resolve("luix-regression-root"));
  const source = vscode.Uri.joinPath(root, "Button.luau");
  const folder = { uri: root, name: "project", index: 0 };
  const sourceFiles = new Map<string, string>();
  const storage = new Map<string, Uint8Array>();
  const docs = new Map<string, { uri: vscode.Uri; version: number; isDirty: boolean; isClosed: boolean; getText(): string }>();
  const changed = new vscode.EventEmitter<vscode.TextDocumentChangeEvent>();
  const deleted = new vscode.EventEmitter<vscode.Uri>();
  const configuration = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
  const timers = clock();
  let aliases = { parens: ["e"], curried: [] as string[] };
  let excluded: string[] = [];
  let opens = 0;
  const fakeWorkspace = {
    workspaceFolders: [folder],
    get textDocuments() { return [...docs.values()]; },
    getWorkspaceFolder: (uri: vscode.Uri) => uri.toString().startsWith(`${root.toString()}/`) ? folder : undefined,
    createFileSystemWatcher: () => ({ dispose() {}, onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: deleted.event }),
    onDidChangeTextDocument: changed.event, onDidChangeConfiguration: configuration.event,
    onDidSaveTextDocument: noopEvent, onDidCloseTextDocument: noopEvent, onDidChangeWorkspaceFolders: noopEvent,
    findFiles: async () => [...sourceFiles.keys()].map((key) => vscode.Uri.parse(key))
      .filter((uri) => !excluded.some((name) => uri.path.split("/").includes(name))),
    fs: {
      readFile: async (uri: vscode.Uri) => {
        const bytes = storage.get(uri.toString()); if (!bytes) {throw Error("missing cache");} return bytes;
      },
      writeFile: async (uri: vscode.Uri, bytes: Uint8Array) => { storage.set(uri.toString(), bytes); },
      createDirectory: async () => {},
      stat: async (uri: vscode.Uri) => {
        if (!sourceFiles.has(uri.toString())) {throw Error("missing source");}
        return { mtime: 1, size: sourceFiles.get(uri.toString())!.length, type: vscode.FileType.File, ctime: 1 };
      },
    },
    openTextDocument: async (uri: vscode.Uri) => {
      opens++;
      return docs.get(uri.toString()) ?? {
        uri, version: 1, isDirty: false, isClosed: false,
        getText: () => sourceFiles.get(uri.toString())!,
      };
    },
  };
  const { WorkspaceIndex: Index } = load<typeof import("../workspaceIndex")>("workspaceIndex", {
    vscode: { ...vscode, workspace: fakeWorkspace },
    "./configCompat": {
      getConfig: (key: string, fallback: unknown) => key === "exclude" ? excluded : fallback,
      configChangeAffects: (event: vscode.ConfigurationChangeEvent, key: string) => event.affectsConfiguration(key),
    },
    "./frameworks": { getAliasPartition: () => aliases, getDirectInstanceClassNames: () => undefined },
  }, timers.globals);
  const instances: WorkspaceIndex[] = [];
  return {
    source, root, sourceFiles, storage, docs, deleted, changed, timers, configuration,
    create: () => {
      const index = new Index({ globalStorageUri: vscode.Uri.joinPath(root, "storage") } as vscode.ExtensionContext);
      instances.push(index); return index;
    },
    setAliases: (names: string[]) => { aliases = { parens: names, curried: [] }; },
    setExcluded: (names: string[]) => { excluded = names; },
    opens: () => opens,
    dispose: () => { instances.forEach((index) => index.dispose()); changed.dispose(); deleted.dispose(); configuration.dispose(); },
  };
}
const button = 'local function Button(props)\n return e("Frame", props)\nend';
const componentNames = async (index: WorkspaceIndex) => Array.from(await index.getAllComponents(), (entry) => entry.name);
const persist = (index: WorkspaceIndex) => (index as unknown as { persistNow(): Promise<void> }).persistNow();

suite("Workspace lifecycle regressions", () => {
  test("restoring a fully cached index invalidates early names and announces readiness", async () => {
    const h = indexHarness();
    try {
      h.sourceFiles.set(h.source.toString(), button);
      const first = h.create(); await componentNames(first); await persist(first); first.dispose();
      const opens = h.opens();
      const restored = h.create();
      assert.strictEqual(restored.knownComponentNames().size, 0);
      let events = 0; restored.onDidChangeIndex(() => events++);
      assert.deepStrictEqual(await componentNames(restored), ["Button"]);
      assert.deepStrictEqual([...restored.knownComponentNames()], ["Button"]);
      assert.strictEqual(h.opens(), opens, "unchanged files should retain the warm-start saving");
      h.timers.fire(200); assert.ok(events > 0);
    } finally { h.dispose(); }
  });

  test("deleted and newly excluded sources never reappear from disk cache", async () => {
    const h = indexHarness();
    try {
      h.sourceFiles.set(h.source.toString(), button);
      const first = h.create(); await componentNames(first); await persist(first); first.dispose();
      h.sourceFiles.clear();
      const deleted = h.create(); assert.deepStrictEqual(await componentNames(deleted), []); deleted.dispose();
      h.sourceFiles.set(h.source.toString(), button);
      h.setExcluded(["luix-regression-root"]);
      const excluded = h.create(); assert.deepStrictEqual(await componentNames(excluded), []);
    } finally { h.dispose(); }
  });

  test("alias changes reparse unchanged files instead of restoring incompatible parses", async () => {
    const h = indexHarness();
    try {
      h.sourceFiles.set(h.source.toString(), button);
      const index = h.create(); await componentNames(index); await persist(index);
      h.setAliases(["newAlias"]);
      h.configuration.fire({ affectsConfiguration: (key: string) => key === "react.aliases" } as vscode.ConfigurationChangeEvent);
      assert.deepStrictEqual(await componentNames(index), []);
      assert.strictEqual(h.opens(), 2);
    } finally { h.dispose(); }
  });

  test("dirty buffers cannot be restored with the saved-file fingerprint", async () => {
    const h = indexHarness();
    try {
      h.sourceFiles.set(h.source.toString(), button);
      const index = h.create(); await componentNames(index);
      const document = { uri: h.source, languageId: "luau", version: 2, isDirty: true, isClosed: false, getText: () => button.replace("Button", "Unsaved") };
      h.docs.set(h.source.toString(), document);
      h.changed.fire({ document, contentChanges: [{}] } as unknown as vscode.TextDocumentChangeEvent);
      h.timers.fire(200);
      assert.deepStrictEqual(await componentNames(index), ["Unsaved"]);
      await persist(index); index.dispose(); h.docs.clear();
      assert.deepStrictEqual(await componentNames(h.create()), ["Button"]);
    } finally { h.dispose(); }
  });

  test("live deletion schedules persistence and removes the saved entry", async () => {
    const h = indexHarness();
    try {
      h.sourceFiles.set(h.source.toString(), button);
      const index = h.create(); await componentNames(index); await persist(index);
      h.timers.fire(5000); await tick();
      h.sourceFiles.clear(); h.deleted.fire(h.source);
      assert.ok(h.timers.has(5000));
      h.timers.fire(5000); await tick();
      const saved = JSON.parse(new TextDecoder().decode([...h.storage.values()][0]));
      assert.strictEqual(Object.keys(saved.files).length, 0);
    } finally { h.dispose(); }
  });
});

suite("Workspace process regressions", () => {
  function tasksHarness(roots: Array<{ name: string; files: string[] }>, exitCodes: number[] = []) {
    const endProcess = new vscode.EventEmitter<vscode.TaskProcessEndEvent>();
    const endTask = new vscode.EventEmitter<vscode.TaskEndEvent>();
    const folders = roots.map((root, index) => ({ name: root.name, index, uri: vscode.Uri.file(path.resolve(root.name)) }));
    const tasks: vscode.Task[] = [];
    const warnings: string[] = [];
    const api = load<typeof import("../wally")>("wally", { vscode: {
      ...vscode,
      workspace: {
        workspaceFolders: folders,
        fs: { readDirectory: async (uri: vscode.Uri) => roots[folders.findIndex((folder) => folder.uri.toString() === uri.toString())].files.map((name) => [name, vscode.FileType.File]) },
        getWorkspaceFolder: () => undefined,
      },
      window: {
        showWarningMessage: (message: string) => { warnings.push(message); },
        showErrorMessage: (message: string) => { warnings.push(message); },
        showQuickPick: async (items: unknown[]) => items[items.length - 1],
      },
      tasks: {
        onDidEndTaskProcess: endProcess.event, onDidEndTask: endTask.event,
        executeTask: async (task: vscode.Task) => {
          tasks.push(task); const execution = { task } as vscode.TaskExecution;
          queueMicrotask(() => endProcess.fire({ execution, exitCode: exitCodes.shift() ?? 0 }));
          return execution;
        },
      },
    } }, { process: { platform: "linux" } });
    return { api, tasks, warnings, folders, dispose: () => { endProcess.dispose(); endTask.dispose(); } };
  }

  test("project names containing whitespace and shell syntax remain one argument in the chosen root", async () => {
    const filename = "client ui; echo unsafe.project.json";
    const h = tasksHarness([{ name: "first", files: ["default.project.json"] }, { name: "second", files: [filename] }]);
    try {
      await h.api.generateRojoSourcemap();
      assert.strictEqual(h.tasks.length, 1);
      const execution = h.tasks[0].execution as vscode.ProcessExecution;
      assert.ok(execution instanceof vscode.ProcessExecution);
      assert.strictEqual(execution.args[1], filename);
      assert.strictEqual(execution.options?.cwd, h.folders[1].uri.fsPath);
      assert.strictEqual(h.tasks[0].scope, h.folders[1]);
    } finally { h.dispose(); }
  });

  test("regeneration stops after a failed install and does not cross workspace roots", async () => {
    const h = tasksHarness([{ name: "project", files: ["wally.toml", "default.project.json"] }], [1]);
    const separate = tasksHarness([{ name: "wally-only", files: ["wally.toml"] }, { name: "rojo-only", files: ["default.project.json"] }]);
    try {
      await h.api.regenerateWallyTypes();
      assert.strictEqual(h.tasks.length, 1);
      await separate.api.regenerateWallyTypes();
      assert.strictEqual(separate.tasks.length, 0);
      assert.ok(separate.warnings[0].includes("same workspace root"));
    } finally { h.dispose(); separate.dispose(); }
  });

  test("regeneration chains successful tasks with an unchanged explicit root", async () => {
    const h = tasksHarness([{ name: "project", files: ["wally.toml", "default.project.json"] }]);
    try {
      await h.api.regenerateWallyTypes();
      assert.deepStrictEqual(h.tasks.map((task) => (task.execution as vscode.ProcessExecution).process), ["wally", "rojo", "wally-package-types"]);
      assert.ok(h.tasks.every((task) => (task.execution as vscode.ProcessExecution).options?.cwd === h.folders[0].uri.fsPath));
    } finally { h.dispose(); }
  });
});

suite("Async preview and validation regressions", () => {
  test("a thumbnail finishing after disabling the gutter cannot restore decorations", async () => {
    let enabled = true;
    let resolveDownload!: (uri: vscode.Uri) => void;
    const changed = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
    const applied: number[] = [];
    const editor = { document: { languageId: "luau", getText: () => '"rbxassetid://123"', positionAt: () => new vscode.Position(0, 0) }, setDecorations: (_type: unknown, ranges: unknown[]) => applied.push(ranges.length) };
    const timers = clock();
    const { ImageGutterDecorator } = load<typeof import("../imageGutter")>("imageGutter", {
      vscode: { ...vscode,
        window: { visibleTextEditors: [editor], onDidChangeActiveTextEditor: noopEvent, onDidChangeVisibleTextEditors: noopEvent, createTextEditorDecorationType: () => ({ dispose() {} }) },
        workspace: { onDidChangeTextDocument: noopEvent, onDidChangeConfiguration: changed.event, fs: { readFile: async () => Buffer.from("png") } },
      },
      "./configCompat": { getConfig: () => enabled, configChangeAffects: () => true },
      "./assetThumbnails": { ensureThumbnailFile: () => new Promise<vscode.Uri>((resolve) => { resolveDownload = resolve; }), findAssetReferences: () => [{ assetId: "123", offset: 0 }] },
    }, timers.globals);
    const gutter = new ImageGutterDecorator({ globalState: { get: () => true } } as unknown as vscode.ExtensionContext);
    try {
      timers.fire(200); enabled = false; changed.fire({} as vscode.ConfigurationChangeEvent);
      resolveDownload(vscode.Uri.file("/cache/123.png")); await tick();
      assert.ok(applied.every((count) => count === 0));
    } finally { gutter.dispose(); changed.dispose(); }
  });

  test("purging thumbnails prevents an old download from writing the cache again", async () => {
    let resolveBody!: (body: ArrayBuffer) => void;
    const writes: string[] = [];
    const api = load<typeof import("../assetThumbnails")>("assetThumbnails", {
      vscode: { ...vscode, workspace: { workspaceFolders: [], fs: {
        stat: async () => { throw Error("not cached"); }, createDirectory: async () => {},
        writeFile: async (uri: vscode.Uri) => { writes.push(uri.path); }, delete: async () => {},
      } } },
      "./configCompat": { getConfig: (_key: string, fallback: unknown) => fallback },
      "./output": { logWarn() {} },
    }, { fetch: async (url: string) => url.includes("thumbnails.roblox.com")
      ? { ok: true, json: async () => ({ data: [{ state: "Completed", imageUrl: "https://cdn.example/asset.png" }] }) }
      : { ok: true, arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { resolveBody = resolve; }) } });
    const context = { globalStorageUri: vscode.Uri.file("/isolated-cache") } as vscode.ExtensionContext;
    const download = api.ensureThumbnailFile(context, "123"); await tick();
    await api.purgeAllThumbnails(context); resolveBody(new ArrayBuffer(1));
    assert.strictEqual(await download, undefined); assert.strictEqual(writes.length, 0);
  });

  test("workspace summaries exclude external Lua diagnostics", () => {
    const timers = clock();
    const local = vscode.Uri.file("/project/local.luau");
    const { WorkspaceValidation } = load<typeof import("../workspaceValidation")>("workspaceValidation", {
      vscode: { ...vscode,
        workspace: { onDidChangeConfiguration: noopEvent, onDidChangeWorkspaceFolders: noopEvent, getWorkspaceFolder: (uri: vscode.Uri) => uri.toString() === local.toString() ? {} : undefined },
        languages: { onDidChangeDiagnostics: noopEvent, getDiagnostics: () => [[local, [{ severity: vscode.DiagnosticSeverity.Warning }]], [vscode.Uri.file("/outside/external.lua"), [{ severity: vscode.DiagnosticSeverity.Error }]]] },
      },
      "./configCompat": { getConfig: () => true, configChangeAffects: () => true },
    }, timers.globals);
    const validation = new WorkspaceValidation();
    try { timers.fire(1000); assert.deepStrictEqual(JSON.parse(JSON.stringify(validation.getSummary())), { warnings: 1, errors: 0, info: 0, fileCount: 1 }); }
    finally { validation.dispose(); }
  });
});

