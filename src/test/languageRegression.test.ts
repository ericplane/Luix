import * as assert from "assert";
import * as vscode from "vscode";
import { ClassNameCompletionProvider, ReactLuauPropsCompletionProvider } from "../completion";
import { computeContrastDiagnostics, computePropValidationDiagnostics } from "../diagnostics";
import { documentDirectCalls, findDocumentCalls } from "../documentCalls";
import { CreateElementInlayHintsProvider, CreateElementSymbolProvider } from "../editor";
import { findAllCreateElementCalls } from "../parser";
import type { WorkspaceIndex } from "../workspaceIndex";
import { planBindingRename } from "../rename";
import { applyTextChanges } from "../editSyntax";

async function document(text: string): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument({ content: text, language: "luau" });
}

async function withSetting<T>(key: string, value: unknown, work: () => Promise<T>): Promise<T> {
  const config = vscode.workspace.getConfiguration("luix");
  const previous = config.inspect(key)?.globalValue;
  await config.update(key, value, vscode.ConfigurationTarget.Global);
  try {
    return await work();
  } finally {
    await config.update(key, previous, vscode.ConfigurationTarget.Global);
  }
}

suite("Language audit regressions", () => {
  test("class completion does not append a table comma in function arguments", async () => {
    for (const marked of [
      'local value = wrapper(123, e("Fr|"))',
      'local value = { wrapper(123, e("Fr|")) }',
      'local callback = { run = function() return 123, e("Fr|") end }',
    ]) {
      const cursor = marked.indexOf("|");
      const text = marked.replace("|", "");
      const doc = await document(text);
      const items = await new ClassNameCompletionProvider().provideCompletionItems(doc, doc.positionAt(cursor));
      const item = items?.find((candidate) => candidate.label === "Frame");
      assert.ok(item && item.range instanceof vscode.Range);
      const insertion = (item.insertText as vscode.SnippetString).value;
      assert.ok(!insertion.endsWith(",$0"), insertion);
      const result = text.slice(0, doc.offsetAt(item.range.start)) +
        insertion.replace("$1", 'Name = "Test"').replace("$0", "") +
        text.slice(doc.offsetAt(item.range.end));
      assert.ok(!/\),\)/.test(result), result);
    }
  });

  test("class completion retains a comma for a real table child", async () => {
    const marked = 'local children = { e("Fr|") }';
    const doc = await document(marked.replace("|", ""));
    const items = await new ClassNameCompletionProvider().provideCompletionItems(doc, doc.positionAt(marked.indexOf("|")));
    const item = items?.find((candidate) => candidate.label === "Frame");
    assert.ok((item?.insertText as vscode.SnippetString).value.endsWith(",$0"));
  });

  test("class completion preserves an existing table separator without doubling it", async () => {
    for (const separator of [",", ";"]) {
      const marked = `local children = { e("Fr|")${separator} other }`;
      const doc = await document(marked.replace("|", ""));
      const items = await new ClassNameCompletionProvider().provideCompletionItems(doc, doc.positionAt(marked.indexOf("|")));
      const item = items?.find((candidate) => candidate.label === "Frame");
      assert.ok(!(item?.insertText as vscode.SnippetString).value.endsWith(",$0"));
    }
  });

  test("responsive TextScaled layouts do not require offsets or AutomaticSize", async () => {
    for (const size of ['Size = UDim2.fromScale(1, 1),', 'Size = UDim2.new(1, 0, 0.5, 0),', ""]) {
      const text = `e("TextLabel", { ${size} TextScaled = true, Text = "Hello" })`;
      const diagnostics = computePropValidationDiagnostics(text, await document(text));
      assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === "luix.text-scaled-gotcha"));
    }
  });

  test("direct Vide constructors validate props, events and Parent", async () => {
    const text = 'TextButton({ Parent = playerGui, Activated = function() end, BackgroundTransparenc = 0.5 })';
    const diagnostics = computePropValidationDiagnostics(text, await document(text));
    const unknown = diagnostics.filter((diagnostic) => diagnostic.code === "luix.unknown-prop");
    assert.strictEqual(unknown.length, 1);
    assert.ok(unknown[0].message.includes("BackgroundTransparenc"));
    assert.strictEqual(findDocumentCalls(text)[0].isDirectInstanceCall, true);
  });

  test("direct constructor detection respects disabled settings and cache inputs", async () => {
    const text = 'Frame({ BackgroundTransparenc = 0 })';
    assert.strictEqual(findDocumentCalls(text).length, 1);
    await withSetting("vide.directInstanceCalls", false, async () => {
      assert.strictEqual(findDocumentCalls(text).length, 0);
      assert.deepStrictEqual(computePropValidationDiagnostics(text, await document(text)), []);
    });
    await withSetting("frameworks", ["react"], async () => {
      assert.strictEqual(findDocumentCalls(text).length, 0);
    });
    assert.strictEqual(findDocumentCalls(text).length, 1);
  });

  test("component bindings named Frame are not validated or completed as host Frames", async () => {
    const text = [
      'local function Frame(props: { Caption: string })',
      '  return create "TextLabel" { Text = props.Caption }',
      'end',
      'local view = Frame({ Caption = "Hello" })',
    ].join("\n");
    const doc = await document(text);
    const direct = findDocumentCalls(text).find((call) => call.isDirectComponentCall);
    assert.ok(direct && !direct.isDirectInstanceCall);
    assert.ok(!computePropValidationDiagnostics(text, doc).some((diagnostic) => diagnostic.code === "luix.unknown-prop"));
    const index = { knownComponentNames: () => new Set<string>(), findComponent: async () => undefined } as unknown as WorkspaceIndex;
    const items = await new ReactLuauPropsCompletionProvider(index).provideCompletionItems(
      doc, doc.positionAt(text.lastIndexOf("Caption") + 3)
    );
    assert.ok(items?.some((item) => item.label === "Caption"));
    assert.ok(!items?.some((item) => item.label === "Activated"));
    const imported = 'local Frame = require(script.CustomFrame)\nFrame({ Caption = "Hello" })';
    assert.strictEqual(findDocumentCalls(imported).length, 0);
    const constructor = 'local Frame = create "Frame"\nFrame({ BackgroundTransparenc = 0 })';
    assert.strictEqual(findDocumentCalls(constructor)[0].isDirectInstanceCall, true);
  });

  test("direct parser handles nested and scoped components without matching methods or definitions", () => {
    const text = 'local function Card(props) end\nCard(scope, { Child { Value = 1 } })\nobject:Card({})';
    const calls = findAllCreateElementCalls(text, [], {
      componentNames: new Set(["Card", "Child"]),
    });
    assert.deepStrictEqual(calls.map((call) => call.className), ["Card", "Child"]);
    assert.ok(calls.every((call) => text.slice(call.propsBraceStart, (call.propsBraceEnd ?? 0) + 1).startsWith("{")));
  });

  test("Outline and closing hints include direct Vide constructors", async () => {
    const text = 'Frame({\n  TextLabel { Text = "Hello" },\n})';
    const doc = await document(text);
    const symbols = await new CreateElementSymbolProvider().provideDocumentSymbols(doc);
    assert.strictEqual(symbols?.[0].name, "Frame");
    assert.strictEqual(symbols?.[0].children[0].name, "TextLabel");
    await withSetting("inlayHints.scope", "all", async () => {
      const provider = new CreateElementInlayHintsProvider();
      try {
        const hints = await provider.provideInlayHints(doc, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)));
        assert.ok(hints?.some((hint) => String(hint.label).includes("Frame")));
      } finally {
        provider.dispose();
      }
    });
  });

  test("contrast follows transparency, composites opacity and skips unknown backgrounds", async () => {
    const fixture = (background: string) => 'e("Frame", { BackgroundColor3 = Color3.new(1,1,1) }, {' +
      `Child = e("TextLabel", { BackgroundColor3 = Color3.new(0,0,0), ${background}, TextColor3 = Color3.new(0,0,0) }) })`;
    for (const transparency of ["1", "0.5", "props.Transparency"]) {
      const text = fixture(`BackgroundTransparency = ${transparency}`);
      assert.deepStrictEqual(computeContrastDiagnostics(text, await document(text)), [], transparency);
    }
    const opaque = fixture("BackgroundTransparency = 0");
    assert.strictEqual(computeContrastDiagnostics(opaque, await document(opaque)).length, 1);
    const unknown = 'e("Frame", { BackgroundColor3 = Color3.new(1,1,1) }, { Child = e("TextLabel", { TextColor3 = Color3.new(1,1,1) }) })';
    assert.deepStrictEqual(computeContrastDiagnostics(unknown, await document(unknown)), []);
  });

  test("parameter shadowing suppresses direct host detection", () => {
    const options = documentDirectCalls('local function render(Frame) return Frame({ Content = 1 }) end');
    assert.ok(!options.instanceNames?.has("Frame"));
  });

  test("typed locals without initializers do not swallow later rename references", () => {
    const text = 'local function Button() end\nlocal label: string\nreturn Button';
    const changes = planBindingRename(text, text.indexOf("Button"), "Renamed");
    assert.strictEqual(applyTextChanges(text, changes), 'local function Renamed() end\nlocal label: string\nreturn Renamed');
  });

  test("renaming a value leaves function return types intact", () => {
    const text = 'local function Vector2() end\nlocal function render(): (Vector2) return Vector2 end\nreturn Vector2';
    const changes = planBindingRename(text, text.indexOf("Vector2"), "Renamed");
    assert.strictEqual(applyTextChanges(text, changes), 'local function Renamed() end\nlocal function render(): (Vector2) return Renamed end\nreturn Renamed');
  });

  test("typeof queries inside annotations retain their value references", () => {
    const text = 'local function Button() end\nlocal copy: typeof(Button) = Button\nreturn copy';
    const changes = planBindingRename(text, text.indexOf("Button"), "Renamed");
    assert.strictEqual(applyTextChanges(text, changes), 'local function Renamed() end\nlocal copy: typeof(Renamed) = Renamed\nreturn copy');
  });
});
