import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import * as vscode from "vscode";
import type { WorkspaceIndex } from "../workspaceIndex";
import { decodeFileText, normalizeLineEndings, positionsInText, _internal as indexInternals } from "../workspaceIndex";

/** Load compiled modules with in-memory VS Code services. */
function load<T>(name: string, stubs: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const filename = path.join(__dirname, "..", `${name}.js`);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, Buffer, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setImmediate, process, AbortSignal,
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

function indexHarness(rootPath = "luix-regression-root") {
  const root = vscode.Uri.file(path.resolve(rootPath));
  const source = vscode.Uri.joinPath(root, "Button.luau");
  const folder = { uri: root, name: "project", index: 0 };
  const sourceFiles = new Map<string, string>();
  const storage = new Map<string, Uint8Array>();
  const docs = new Map<string, { uri: vscode.Uri; version: number; isDirty: boolean; isClosed: boolean; getText(): string }>();
  const changed = new vscode.EventEmitter<vscode.TextDocumentChangeEvent>();
  const closed = new vscode.EventEmitter<vscode.TextDocument>();
  const deleted = new vscode.EventEmitter<vscode.Uri>();
  const configuration = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
  const timers = clock();
  let aliases = { parens: ["e"], curried: [] as string[] };
  let excluded: string[] = [];
  let reads = 0;
  let readsInFlight = 0;
  let maxReadsInFlight = 0;
  let opens = 0;
  const fakeWorkspace = {
    workspaceFolders: [folder],
    get textDocuments() { return [...docs.values()]; },
    getWorkspaceFolder: (uri: vscode.Uri) => uri.toString().startsWith(`${root.toString()}/`) ? folder : undefined,
    createFileSystemWatcher: () => ({ dispose() {}, onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: deleted.event }),
    onDidChangeTextDocument: changed.event, onDidChangeConfiguration: configuration.event,
    onDidSaveTextDocument: noopEvent, onDidCloseTextDocument: closed.event, onDidChangeWorkspaceFolders: noopEvent,
    findFiles: async () => [...sourceFiles.keys()].map((key) => vscode.Uri.parse(key))
      .filter((uri) => !excluded.some((name) => uri.path.split("/").includes(name))),
    fs: {
      readFile: async (uri: vscode.Uri) => {
        const source = sourceFiles.get(uri.toString());
        if (source !== undefined) {
          reads++; readsInFlight++; maxReadsInFlight = Math.max(maxReadsInFlight, readsInFlight);
          try { await tick(); return new TextEncoder().encode(source); } finally { readsInFlight--; }
        }
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
    source, root, sourceFiles, storage, docs, deleted, changed, closed, timers, configuration,
    create: () => {
      const index = new Index({ globalStorageUri: vscode.Uri.joinPath(root, "storage") } as vscode.ExtensionContext);
      instances.push(index); return index;
    },
    setAliases: (names: string[]) => { aliases = { parens: names, curried: [] }; },
    setExcluded: (names: string[]) => { excluded = names; },
    reads: () => reads,
    maxReadsInFlight: () => maxReadsInFlight,
    /** Opening documents here would trigger other extensions. */
    opens: () => opens,
    dispose: () => { instances.forEach((index) => index.dispose()); changed.dispose(); closed.dispose(); deleted.dispose(); configuration.dispose(); },
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
      const reads = h.reads();
      const restored = h.create();
      assert.strictEqual(restored.knownComponentNames().size, 0);
      let events = 0; restored.onDidChangeIndex(() => events++);
      assert.deepStrictEqual(await componentNames(restored), ["Button"]);
      assert.deepStrictEqual([...restored.knownComponentNames()], ["Button"]);
      assert.strictEqual(h.reads(), reads, "unchanged files should retain the warm-start saving");
      assert.strictEqual(h.opens(), 0, "indexing must not open documents");
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
      assert.strictEqual(h.reads(), 2);
      assert.strictEqual(h.opens(), 0);
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

  test("closing a document rescans only an entry that came from its buffer", async () => {
    const h = indexHarness();
    try {
      h.sourceFiles.set(h.source.toString(), button);
      const index = h.create(); await componentNames(index);
      const reads = h.reads();
      // A clean close must not reopen files and trigger another close.
      h.closed.fire({ uri: h.source } as vscode.TextDocument);
      await settle(() => false, 5);
      assert.strictEqual(h.reads(), reads, "a clean close leaves the disk entry alone");
      const document = { uri: h.source, languageId: "luau", version: 2, isDirty: true, isClosed: false, getText: () => button.replace("Button", "Unsaved") };
      h.docs.set(h.source.toString(), document);
      h.changed.fire({ document, contentChanges: [{}] } as unknown as vscode.TextDocumentChangeEvent);
      h.timers.fire(200);
      assert.deepStrictEqual(await componentNames(index), ["Unsaved"]);
      h.docs.clear();
      h.closed.fire(document as unknown as vscode.TextDocument);
      await settle(async () => (await componentNames(index))[0] === "Button");
      assert.deepStrictEqual(await componentNames(index), ["Button"], "a discarded buffer stops shadowing the file");
      assert.strictEqual(h.reads(), reads + 1);
      assert.strictEqual(h.opens(), 0);
    } finally { h.dispose(); }
  });

  test("tool folders inside the workspace are never read; other dot-folders are", async () => {
    const h = indexHarness();
    try {
      h.sourceFiles.set(h.source.toString(), button);
      for (const dir of [".claude/worktrees/agent", ".cache/copy", ".git/modules", ".history/src", ".vscode"]) {
        h.sourceFiles.set(vscode.Uri.joinPath(h.root, dir, "Copy.luau").toString(), button.replace("Button", "Copy"));
      }
      h.sourceFiles.set(vscode.Uri.joinPath(h.root, ".storybook", "Story.luau").toString(), button.replace("Button", "Story"));
      const index = h.create();
      assert.deepStrictEqual((await componentNames(index)).sort(), ["Button", "Story"]);
      assert.strictEqual(h.reads(), 2);
    } finally { h.dispose(); }
  });

  test("a project opened from inside a tool folder (an agent's worktree) is indexed", async () => {
    const h = indexHarness(path.join(".claude", "worktrees", "agent", "luix-regression-root"));
    try {
      h.sourceFiles.set(h.source.toString(), button);
      h.sourceFiles.set(vscode.Uri.joinPath(h.root, ".claude", "worktrees", "nested", "Copy.luau").toString(), button.replace("Button", "Copy"));
      const index = h.create();
      assert.deepStrictEqual(await componentNames(index), ["Button"]);
      assert.strictEqual(h.reads(), 1);
      assert.strictEqual(indexInternals.isIgnored(h.source, indexInternals.DEFAULT_EXCLUDED_DIRS), false);
    } finally { h.dispose(); }
  });

  test("a file too big to parse in one go is left out", async () => {
    const h = indexHarness();
    try {
      h.sourceFiles.set(h.source.toString(), button);
      const generated = vscode.Uri.joinPath(h.root, "Generated.luau");
      const big = button.replace("Button", "Generated") + "\n--" + "x".repeat(indexInternals.MAX_INDEXED_FILE_BYTES);
      h.sourceFiles.set(generated.toString(), big);
      const index = h.create();
      assert.deepStrictEqual(await componentNames(index), ["Button"]);
      assert.strictEqual(h.reads(), 1, "its size is checked before reading it");
    } finally { h.dispose(); }
  });

  test("call sites in a file with mixed line endings point at the call, open or not", async () => {
    const h = indexHarness();
    try {
      // Mixed line endings normalize to LF when VS Code opens this file.
      const disk = "local e = require(script.Parent.e)\r\nlocal function Page()\n\treturn e(Button, {})\nend\nreturn Page\n";
      const page = vscode.Uri.joinPath(h.root, "Page.luau");
      h.sourceFiles.set(h.source.toString(), button);
      h.sourceFiles.set(page.toString(), disk);
      const index = h.create(); await componentNames(index);
      const unopened = await index.findCallSites("Button");
      assert.strictEqual(unopened.map((site) => `${site.range.start.line}:${site.range.start.character}-${site.range.end.character}`).join(), "2:10-16");
      const shown = disk.replace(/\r\n/g, "\n");
      const positionAt = positionsInText(shown);
      h.docs.set(page.toString(), {
        uri: page, version: 1, isDirty: false, isClosed: false, getText: () => shown,
        positionAt, offsetAt: () => 0,
      } as unknown as { uri: vscode.Uri; version: number; isDirty: boolean; isClosed: boolean; getText(): string });
      const opened = await index.findCallSites("Button");
      const range = opened[0].range;
      const lines = shown.split("\n");
      assert.strictEqual(lines[range.start.line].slice(range.start.character, range.end.character), "Button");
      assert.strictEqual(h.opens(), 0);
    } finally { h.dispose(); }
  });

  test("a large workspace is read a few files at a time", async () => {
    const h = indexHarness();
    try {
      for (let i = 0; i < 40; i++) {
        h.sourceFiles.set(vscode.Uri.joinPath(h.root, `C${i}.luau`).toString(), button.replace("Button", `C${i}`));
      }
      const index = h.create();
      assert.strictEqual((await componentNames(index)).length, 40);
      assert.ok(h.maxReadsInFlight() > 1, "reads overlap");
      assert.ok(h.maxReadsInFlight() <= 6, `at most 6 reads in flight, saw ${h.maxReadsInFlight()}`);
      assert.strictEqual(h.opens(), 0);
    } finally { h.dispose(); }
  });

  test("disposing writes index changes still waiting to be saved", async () => {
    const h = indexHarness();
    try {
      h.sourceFiles.set(h.source.toString(), button);
      const first = h.create(); await componentNames(first);
      assert.ok(h.timers.has(5000), "the warmup's write is still pending");
      first.dispose(); await tick();
      assert.strictEqual(h.storage.size, 1);
      const reads = h.reads();
      assert.deepStrictEqual(await componentNames(h.create()), ["Button"]);
      assert.strictEqual(h.reads(), reads, "the next window load reuses the saved parse");
    } finally { h.dispose(); }
  });

  test("an exclude change keeps unchanged parses instead of reading every file again", async () => {
    const h = indexHarness();
    try {
      h.sourceFiles.set(h.source.toString(), button);
      h.sourceFiles.set(vscode.Uri.joinPath(h.root, "Tests", "Spec.luau").toString(), button.replace("Button", "Spec"));
      const index = h.create();
      assert.deepStrictEqual((await componentNames(index)).sort(), ["Button", "Spec"]);
      const reads = h.reads();
      h.setExcluded(["Tests"]);
      h.configuration.fire({ affectsConfiguration: (key: string) => key === "exclude" } as vscode.ConfigurationChangeEvent);
      assert.deepStrictEqual(await componentNames(index), ["Button"]);
      assert.strictEqual(h.reads(), reads);
    } finally { h.dispose(); }
  });

  test("call-site counts match a walk over every indexed file", async () => {
    const h = indexHarness();
    try {
      const caller = 'local function Page(props)\n return e("Frame", {}, { e(Button, {}), e(Button, {}), e(Card, {}) })\nend';
      h.sourceFiles.set(h.source.toString(), button);
      h.sourceFiles.set(vscode.Uri.joinPath(h.root, "Page.luau").toString(), caller);
      h.sourceFiles.set(vscode.Uri.joinPath(h.root, "Other.luau").toString(), 'return e(Button, {})');
      const index = h.create(); await componentNames(index);
      assert.strictEqual(index.countCallSites("Button"), 3);
      assert.strictEqual(index.countCallSites("Components.Card"), 1);
      assert.strictEqual(index.countCallSites("Missing"), 0);
      h.sourceFiles.delete(vscode.Uri.joinPath(h.root, "Other.luau").toString());
      h.deleted.fire(vscode.Uri.joinPath(h.root, "Other.luau"));
      assert.strictEqual(index.countCallSites("Button"), 2);
    } finally { h.dispose(); }
  });
});

/** Wait for pending reads and parses, up to rounds event-loop turns. */
async function settle(done: () => boolean | Promise<boolean>, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds && !(await done()); i++) {
    await tick();
  }
}

suite("Positions in files read from disk", () => {
  test("count line breaks like a TextDocument: \\n, \\r\\n and a lone \\r", () => {
    const positionAt = positionsInText("a\nbc\r\ndef\rg");
    const expected: Array<[number, number, number]> = [
      [0, 0, 0], [1, 0, 1], [2, 1, 0], [3, 1, 1], [4, 1, 2], [6, 2, 0],
      [8, 2, 2], [9, 2, 3], [10, 3, 0], [11, 3, 1], [99, 3, 1], [-1, 0, 0],
    ];
    for (const [offset, line, character] of expected) {
      const position = positionAt(offset);
      assert.deepStrictEqual([position.line, position.character], [line, character], `offset ${offset}`);
    }
  });

  test("agree with a CRLF document", async () => {
    const text = "local a = 1\r\nreturn e(Button, {})\r\n\r\nend";
    const doc = await vscode.workspace.openTextDocument({ content: text, language: "luau" });
    assert.strictEqual(doc.getText(), text);
    const positionAt = positionsInText(text);
    for (let offset = 0; offset <= text.length; offset++) {
      if (text[offset - 1] === "\r") {continue;}
      const expected = doc.positionAt(offset);
      const actual = positionAt(offset);
      assert.deepStrictEqual([actual.line, actual.character], [expected.line, expected.character], `offset ${offset}`);
    }
  });

  test("decode files the way VS Code shows them", () => {
    const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xc3, 0xa9]);
    assert.strictEqual(decodeFileText(utf8Bom), "aé");
    const utf16le = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]);
    assert.strictEqual(decodeFileText(utf16le), "ab");
    assert.strictEqual(decodeFileText(new TextEncoder().encode("return {}\n")), "return {}\n");
    assert.strictEqual(decodeFileText(new TextEncoder().encode("a\r\nb\nc\r\n")), "a\r\nb\r\nc\r\n");
  });

  test("make line endings uniform the way VS Code loads a file", () => {
    const cases: Array<[string, string]> = [
      ["", ""],
      ["no breaks", "no breaks"],
      ["a\nb\n", "a\nb\n"],
      ["a\r\nb\r\n", "a\r\nb\r\n"],
      // Lone CR normalizes to CRLF.
      ["a\rb\r", "a\r\nb\r\n"],
      // A CRLF majority normalizes every break to CRLF.
      ["a\r\nb\r\nc\nd", "a\r\nb\r\nc\r\nd"],
      ["a\rb\r\nc\n", "a\r\nb\r\nc\r\n"],
      // LF wins ties.
      ["a\r\nb\nc\n", "a\nb\nc\n"],
      ["a\r\nb\n", "a\nb\n"],
      ["a\rb\n", "a\nb\n"],
      ["-- c\rlocal x = 1\nlocal y = 2\n", "-- c\nlocal x = 1\nlocal y = 2\n"],
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(normalizeLineEndings(input), expected, JSON.stringify(input));
    }
  });

  test("decoded text is what VS Code holds for the same file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luix-eol-"));
    try {
      const samples = [
        "local e = require(script.Parent.e)\r\nlocal function Page()\n\treturn e(Button, {})\nend\nreturn Page\n",
        "a\r\nb\r\nc\nd\r\n",
        "-- lone\rlocal x = 1\nreturn x\n",
        "x\r\ny\n",
        "a\rb\r",
        "\uFEFFlocal a = 1\r\nreturn a\n",
      ];
      for (let i = 0; i < samples.length; i++) {
        const file = path.join(dir, `sample-${i}.luau`);
        fs.writeFileSync(file, samples[i], "utf8");
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        assert.strictEqual(decodeFileText(fs.readFileSync(file)), document.getText(), `sample ${i}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
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

