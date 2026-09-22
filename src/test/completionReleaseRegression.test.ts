import * as assert from "assert";
import * as vscode from "vscode";
import { ClassNameCompletionProvider, FactoryComponentCompletionProvider } from "../completion";
import type { WorkspaceIndex } from "../workspaceIndex";

const index = {
  knownComponentNames: () => new Set(["Card"]),
  knownDirectCallTargets: () => new Set(["Card", "Frame"]),
} as unknown as WorkspaceIndex;

async function fixture(marked: string, vide = false): Promise<{
  doc: vscode.TextDocument; text: string; position: vscode.Position;
}> {
  const source = (vide ? 'local vide = require(script.Parent.Vide)\n' : "") + marked;
  const cursor = source.indexOf("|");
  assert.ok(cursor >= 0);
  const text = source.slice(0, cursor) + source.slice(cursor + 1);
  const doc = await vscode.workspace.openTextDocument({ content: text, language: "luau" });
  return { doc, text, position: doc.positionAt(cursor) };
}

function applyCompletion(doc: vscode.TextDocument, item: vscode.CompletionItem): string {
  assert.ok(item.range instanceof vscode.Range);
  assert.strictEqual(item.range.start.line, item.range.end.line, "Completion edits must stay on one line");
  assert.ok(item.insertText instanceof vscode.SnippetString);
  const inserted = item.insertText.value.replace("$1", 'Name = "Test"').replace("$0", "");
  return doc.getText().slice(0, doc.offsetAt(item.range.start)) + inserted +
    doc.getText().slice(doc.offsetAt(item.range.end));
}

suite("Release completion regressions", () => {
  test("component suggestions do not rewrite declarations, signatures or type annotations", async () => {
    const provider = new FactoryComponentCompletionProvider(index);
    for (const marked of [
      "local function Car|", "function Car|", "local Car|", "local value, Car|",
      "local function render(Car|)", "local function render(\n  Car|)",
      "function e(Car|)", "local value: Car|", "local function render(): (Car|)",
      "type Result = {\n  child: Car|\n}", "local value = other :: Car|",
    ]) {
      const { doc, position } = await fixture(marked, true);
      const items = await provider.provideCompletionItems(doc, position);
      assert.ok(!items?.some((item) => item.label === "Card"), marked);
    }
  });

  test("component exports, callbacks and assignments remain function references", async () => {
    const provider = new FactoryComponentCompletionProvider(index);
    for (const marked of [
      "return Car|", "local value = Car|", "task.defer(Car|)",
      "return { Component = Car| }", "local value = enabled and Car|",
      "return Ca|rd",
    ]) {
      const { doc, text, position } = await fixture(marked, true);
      const items = await provider.provideCompletionItems(doc, position);
      const item = items?.find((candidate) => candidate.label === "Card");
      assert.ok(item, marked);
      assert.strictEqual((item.insertText as vscode.SnippetString).value, "Card", marked);
      assert.strictEqual(applyCompletion(doc, item), text.replace(/\bCar\b/, "Card"), marked);
    }
  });

  test("known Vide child positions still expand calls and preserve existing separators", async () => {
    const provider = new FactoryComponentCompletionProvider(index);
    for (const marked of [
      'return create "Frame" { Car| }',
      'return Frame({ Car| })',
      'return create "Frame" { Car|, }',
    ]) {
      const { doc, position } = await fixture(marked, true);
      const items = await provider.provideCompletionItems(doc, position);
      const item = items?.find((candidate) => candidate.label === "Card");
      assert.ok(item, marked);
      assert.ok((item.insertText as vscode.SnippetString).value.startsWith("Card {\n"), marked);
      const result = applyCompletion(doc, item);
      assert.ok(!result.includes(",,"), result);
      assert.ok(result.includes('Card {\n\tName = "Test",\n},'), result);
    }
  });

  test("factory component completion preserves arguments and multiline closing punctuation", async () => {
    const provider = new FactoryComponentCompletionProvider(index);
    for (const marked of [
      "return e(Car|, props)", "return e(Car|\n)",
      "return e(Car|\n, { Name = 'Existing' })", "return e(Car| -- retain comment\n)",
    ]) {
      const { doc, text, position } = await fixture(marked, true);
      const items = await provider.provideCompletionItems(doc, position);
      const item = items?.find((candidate) => candidate.label === "Card");
      assert.ok(item, marked);
      assert.strictEqual(applyCompletion(doc, item), text.replace("Car", "Card"), marked);
    }
    const { doc, position } = await fixture("return e(Ca|rd)", true);
    const items = await provider.provideCompletionItems(doc, position);
    const item = items?.find((candidate) => candidate.label === "Card");
    assert.ok(item);
    assert.ok(applyCompletion(doc, item).endsWith('return e(Card, {\n\tName = "Test",\n})'));
  });

  test("class completion only replaces the name when props or multiline suffixes exist", async () => {
    for (const marked of [
      'return e("Fr|", props)', 'return e("Fr|",\n { Name = "Existing" })',
      'return e("Fr|"\n)', 'return e(\n  "Fr|"\n)',
      'return e("Fr|" -- retain comment\n)', 'return e("Fr|" --[[keep]] )',
      'return e("Fr|" --[=[keep]=]\n, props)',
      'return create("Fr|") { Name = "Existing" }',
      'return create("Fr|")\n({ Name = "Existing" })',
      'return create "Fr|"\n{ Name = "Existing" }',
      'return create "Fr|" (props)', 'return New("Fr|")\n(props)',
      'return New("Fr|"\n)',
    ]) {
      const { doc, text, position } = await fixture(marked);
      const items = await new ClassNameCompletionProvider().provideCompletionItems(doc, position);
      const item = items?.find((candidate) => candidate.label === "Frame");
      assert.ok(item, marked);
      assert.strictEqual(applyCompletion(doc, item), text.replace('"Fr"', '"Frame"'), marked);
    }
  });

  test("empty single-line class calls still receive a complete props snippet", async () => {
    for (const [marked, expected] of [
      ['return e("Fr|")', 'return e("Frame", {\n\tName = "Test",\n})'],
      ['return create "Fr|"', 'return create "Frame" {\n\tName = "Test",\n}'],
      ['return New("Fr|")', 'return New("Frame")({\n\tName = "Test",\n})'],
    ]) {
      const { doc, position } = await fixture(marked);
      const items = await new ClassNameCompletionProvider().provideCompletionItems(doc, position);
      const item = items?.find((candidate) => candidate.label === "Frame");
      assert.ok(item, marked);
      assert.strictEqual(applyCompletion(doc, item), expected);
    }
  });
});
