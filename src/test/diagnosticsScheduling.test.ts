// Test scheduling with real manager logic and a stubbed diagnostic pass.
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import * as vscode from "vscode";
import type { DiagnosticsManager } from "../diagnostics";

function load<T>(name: string, stubs: Record<string, unknown>, globals: Record<string, unknown>): T {
  const filename = path.join(__dirname, "..", `${name}.js`);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, Buffer, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setImmediate, process,
    require: (id: string) => Object.prototype.hasOwnProperty.call(stubs, id)
      ? stubs[id] : require(require.resolve(id, { paths: [path.dirname(filename)] })),
    ...globals,
  }, { filename });
  return module.exports as T;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface FakeDocument {
  uri: vscode.Uri;
  languageId: string;
  version: number;
  isClosed: boolean;
  getText(): string;
}

function harness() {
  let id = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const opened = new vscode.EventEmitter<FakeDocument>();
  const changed = new vscode.EventEmitter<{ document: FakeDocument; contentChanges: unknown[] }>();
  const closed = new vscode.EventEmitter<FakeDocument>();
  const visibleChanged = new vscode.EventEmitter<Array<{ document: FakeDocument }>>();
  const configuration = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
  const documents: FakeDocument[] = [];
  const visible: Array<{ document: FakeDocument }> = [];
  const published: string[] = [];
  const fakeVscode = {
    ...vscode,
    workspace: {
      get textDocuments() { return documents; },
      onDidOpenTextDocument: opened.event,
      onDidChangeTextDocument: changed.event,
      onDidCloseTextDocument: closed.event,
      onDidChangeConfiguration: configuration.event,
    },
    window: {
      get visibleTextEditors() { return visible; },
      tabGroups: { all: [] },
      onDidChangeVisibleTextEditors: visibleChanged.event,
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: (uri: vscode.Uri) => { published.push(path.basename(uri.path)); },
        delete: () => {},
        dispose: () => {},
      }),
    },
  };
  const { DiagnosticsManager: Manager } = load<typeof import("../diagnostics")>("diagnostics", { vscode: fakeVscode }, {
    setTimeout: (callback: () => void, delay: number) => { timers.set(++id, { callback, delay }); return id; },
    clearTimeout: (key: number) => timers.delete(key),
  });
  const manager = new Manager({} as never) as DiagnosticsManager;
  // Yield between steps to exercise cancellation.
  const passes: string[] = [];
  let running = 0;
  let mostAtOnce = 0;
  const gate: { hold?: Promise<void> } = {};
  (manager as unknown as { computeDiagnostics: unknown }).computeDiagnostics =
    async (document: FakeDocument, stop: () => boolean) => {
      passes.push(path.basename(document.uri.path));
      running++;
      mostAtOnce = Math.max(mostAtOnce, running);
      try {
        for (let i = 0; i < 3; i++) {
          await (gate.hold ?? tick());
          if (stop()) {
            passes.push(`${path.basename(document.uri.path)} stopped`);
            return undefined;
          }
        }
        return [];
      } finally {
        running--;
      }
    };
  const doc = (name: string): FakeDocument => {
    const document = { uri: vscode.Uri.file(path.resolve("luix-scheduling", name)), languageId: "luau", version: 1, isClosed: false, getText: () => "" };
    documents.push(document);
    return document;
  };
  return {
    manager, opened, changed, closed, visibleChanged, visible, published, passes, gate, doc,
    mostAtOnce: () => mostAtOnce,
    /** Run due timers and let their diagnostic passes finish. */
    fire: async (delay: number) => {
      for (const [key, timer] of [...timers]) {
        if (timer.delay === delay) { timers.delete(key); timer.callback(); }
      }
      for (let i = 0; i < 200; i++) {await tick();}
    },
    pending: (delay: number) => [...timers.values()].filter((timer) => timer.delay === delay).length,
    dispose: () => { manager.dispose(); opened.dispose(); changed.dispose(); closed.dispose(); visibleChanged.dispose(); configuration.dispose(); },
  };
}

suite("Diagnostics scheduling", () => {
  test("documents opened in the background are linted one at a time, once the editor is quiet", async () => {
    const h = harness();
    try {
      const names = Array.from({ length: 12 }, (_, i) => `Background${i}.luau`);
      for (const name of names) {h.opened.fire(h.doc(name));}
      assert.deepStrictEqual(h.passes, [], "nothing runs during the burst");
      assert.strictEqual(h.pending(1000), 1, "one quiet-time timer for the whole burst");
      await h.fire(1000);
      assert.deepStrictEqual(h.published, [names[0]]);
      for (let i = 1; i < names.length; i++) {
        await h.fire(50);
      }
      assert.deepStrictEqual(h.published, names, "every one is linted, in order");
      assert.strictEqual(h.mostAtOnce(), 1, "never two passes at once");
    } finally { h.dispose(); }
  });

  test("a shown document goes first, and a background pass gives way to it", async () => {
    const h = harness();
    try {
      const background = h.doc("Background.luau");
      const shown = h.doc("Shown.luau");
      h.opened.fire(background);
      let release!: () => void;
      h.gate.hold = new Promise<void>((resolve) => { release = resolve; });
      await h.fire(1000);
      assert.deepStrictEqual(h.passes, ["Background.luau"]);
      h.visible.push({ document: shown });
      h.changed.fire({ document: shown, contentChanges: [{}] });
      await h.fire(200);
      h.gate.hold = undefined;
      release();
      for (let i = 0; i < 200; i++) {await tick();}
      assert.deepStrictEqual(h.passes, ["Background.luau", "Background.luau stopped", "Shown.luau"]);
      assert.deepStrictEqual(h.published, ["Shown.luau"]);
      assert.strictEqual(h.pending(1000), 1, "the background document takes its turn again later");
      await h.fire(1000);
      assert.deepStrictEqual(h.published, ["Shown.luau", "Background.luau"]);
      assert.strictEqual(h.mostAtOnce(), 1);
    } finally { h.dispose(); }
  });

  test("many shown documents at once are linted one after another, the visible one first", async () => {
    const h = harness();
    try {
      const docs = Array.from({ length: 8 }, (_, i) => h.doc(`Tab${i}.luau`));
      // Previously linted documents use the foreground scheduling path.
      for (const document of docs) {h.visible.push({ document });}
      h.visibleChanged.fire(h.visible);
      await h.fire(30);
      assert.strictEqual(h.published.length, 8);
      h.visible.splice(0, h.visible.length, { document: docs[5] });
      for (const document of docs) {
        document.version++;
        h.changed.fire({ document, contentChanges: [{}] });
      }
      await h.fire(200);
      assert.deepStrictEqual(h.published.slice(8, 9), ["Tab5.luau"], "the visible document is linted first");
      assert.strictEqual(h.published.length, 16);
      assert.strictEqual(h.mostAtOnce(), 1, "never two passes at once");
    } finally { h.dispose(); }
  });

  test("closing a document drops its background turn", async () => {
    const h = harness();
    try {
      const gone = h.doc("Gone.luau");
      const kept = h.doc("Kept.luau");
      h.opened.fire(gone);
      h.opened.fire(kept);
      gone.isClosed = true;
      h.closed.fire(gone);
      await h.fire(1000);
      await h.fire(50);
      assert.deepStrictEqual(h.passes, ["Kept.luau"]);
    } finally { h.dispose(); }
  });
});
