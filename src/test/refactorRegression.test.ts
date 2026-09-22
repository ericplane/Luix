import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { promises as fs } from "fs";
import { sortPropsBody, DEFAULT_CATEGORY_ORDER } from "../sortProps";
import { applyTextChanges, luaTokens } from "../editSyntax";
import { planBindingRename, planComponentRenameDocuments } from "../rename";
import { buildExtractionEdit, planComponentExtraction } from "../extractComponent";
import { FRAMEWORKS, getAliasPartition } from "../frameworks";
import { extractPropEntries, findAllCreateElementCalls } from "../parser";
import { rewriteLiteralProps } from "../propEdits";

function rename(text: string, name = "Card", replacement = "Panel", at = text.indexOf(name)): string {
  return applyTextChanges(text, planBindingRename(text, at, replacement));
}

function sourceDocument(name: string, text: string): vscode.TextDocument {
  return { uri: vscode.Uri.file(path.join(os.tmpdir(), "luix-refactor-fixtures", name)), getText: () => text } as vscode.TextDocument;
}

function extraction(text: string, framework: keyof typeof FRAMEWORKS = "react") {
  const call = findAllCreateElementCalls(text, getAliasPartition()).at(-1);
  assert.ok(call);
  return planComponentExtraction(text, call, "ExtractedLabel", FRAMEWORKS[framework]);
}

suite("Refactor regression: syntax-preserving sorting", () => {
  test("keeps commas, statements and nested blocks inside the callback", () => {
    const callback = "function() local a, b = 1, 2; if a then for i = 1, 3 do print(a,b,i) end end; repeat a += 1 until a > 3 end";
    const body = `\n  Activated = ${callback},\n  Name = "hello",\n`;
    const sorted = sortPropsBody(body, DEFAULT_CATEGORY_ORDER, { className: "TextButton", isStringLiteralName: true });
    assert.ok(sorted);
    assert.ok(sorted.includes(`Activated = ${callback},`));
    assert.ok(sorted.indexOf("Name") < sorted.indexOf("Activated"));
    assert.strictEqual(sortPropsBody(sorted, DEFAULT_CATEGORY_ORDER), undefined);
  });

  test("preserves long strings and nested interpolated strings exactly", () => {
    for (const literal of ["[=[hello, world; end]=]", "`hello, {format(`nested, {name}`)}`"]) {
      const sorted = sortPropsBody(`\n Text = ${literal},\n Name = "x",\n`, DEFAULT_CATEGORY_ORDER);
      assert.ok(sorted?.includes(`Text = ${literal},`));
    }
  });

  test("does not rewrite unfinished callbacks", () => {
    assert.strictEqual(sortPropsBody('\n Activated = function() local a,b = 1,2,\n Name = "x",\n', DEFAULT_CATEGORY_ORDER), undefined);
  });
});

suite("Refactor regression: lexical component rename", () => {
  test("renames exports and variable references but leaves labels and strings", () => {
    const text = 'local function Card() return e("Frame") end\nlocal copy = Card\nreturn { Card = Card, label = "Card" }';
    const out = rename(text);
    assert.ok(out.includes("function Panel()"));
    assert.ok(out.includes("local copy = Panel"));
    assert.ok(out.includes('{ Card = Panel, label = "Card" }'));
  });

  test("keeps a parameter shadow and unrelated member names", () => {
    const text = 'local function Card() return e("Frame") end\nlocal function other(Card) return Card(), Components.Card end\nreturn Card';
    const out = rename(text);
    assert.ok(out.includes("other(Card) return Card(), Components.Card"));
    assert.ok(out.endsWith("return Panel"));
  });

  test("renames callback assignments after semicolons without renaming table labels", () => {
    const text = 'local function Card() return e("Frame") end\nlocal props = { Activated = function() print("x"); Card = Card; local values = { Card = Card } end }\nreturn Card';
    const out = rename(text);
    assert.ok(out.includes('print("x"); Panel = Panel; local values = { Card = Panel }'));
    assert.ok(out.endsWith("return Panel"));
  });

  test("local initializers end before adjacent same-line statements", () => {
    assert.strictEqual(rename("local Card = factory() return Card"), "local Panel = factory() return Panel");
    assert.strictEqual(rename("local Card = factory() Card()"), "local Panel = factory() Panel()");
  });

  test("does not confuse a conditional expression's else with a block branch", () => {
    const text = 'local Card = outer\nif ready then\n local Card = inner\n local text = if enabled then "yes" else "no"\n print(Card)\nend\nreturn Card';
    const out = rename(text);
    assert.ok(out.includes("print(Card)"));
    assert.ok(out.endsWith("return Panel"));
  });

  test("repeat locals remain in scope in the until condition", () => {
    const text = "local Card = 1\nrepeat\n local Card = 2\nuntil Card > 0\nreturn Card";
    const out = rename(text);
    assert.ok(out.includes("until Card > 0"));
    assert.ok(out.endsWith("return Panel"));
    const multiline = text.replace("until Card > 0", "until\n Card >\n 0");
    assert.ok(rename(multiline).includes("until\n Card >\n 0"));
  });

  test("callbacks in repeat conditions inherit the repeat locals", () => {
    const text = 'local function Card() return e("Frame") end\nrepeat local Card = other until check(function() return Card end)\nreturn Card';
    const out = rename(text);
    assert.ok(out.includes("until check(function() return Card end)"));
    assert.ok(out.endsWith("return Panel"));
  });

  test("repeat conditions end before adjacent same-line statements", () => {
    const text = "local Card = outer\nrepeat local Card = inner until ready Card()\nreturn Card";
    const out = rename(text);
    assert.ok(out.includes("until ready Panel()"));
    assert.ok(out.endsWith("return Panel"));
  });

  test("renames interpolation expressions without touching their text", () => {
    const text = 'local Card = value\nreturn `Card: {Card} {format(`nested {Card}`)}`';
    assert.ok(rename(text).includes('`Card: {Panel} {format(`nested {Panel}`)}`'));
  });

  test("rejects reserved names, collisions, properties and unresolved globals", () => {
    assert.throws(() => rename("local Card = x\nreturn Card", "Card", "end"), /reserved/);
    assert.throws(() => rename("local Card = x\nlocal Panel = y\nreturn Card"), /already used/);
    assert.throws(() => rename("return Card()"), /local binding/);
    assert.throws(() => rename("return Components.Card()"), /local binding/);
  });

  test("updates the exporting module and proven imports, leaving unrelated Card modules", () => {
    const owner = sourceDocument("Card.luau", 'local function Card(props) return e("Frame", props) end\nreturn Card');
    const caller = sourceDocument("App.luau", 'local Card = require(script.Parent.Card)\nreturn e(Card, {})');
    const other = sourceDocument("Other.luau", 'local function Card() return e("Frame") end\nreturn Card');
    const plans = planComponentRenameDocuments(owner, owner.getText().indexOf("Card"), "Panel", [owner, caller, other]);
    assert.strictEqual(plans.has(other), false);
    const updatedOwner = applyTextChanges(owner.getText(), plans.get(owner)!);
    const updatedCaller = applyTextChanges(caller.getText(), plans.get(caller)!);
    assert.ok(updatedOwner.endsWith("return Panel"));
    assert.strictEqual(updatedCaller, 'local Panel = require(script.Parent.Card)\nreturn e(Panel, {})');
  });

  test("starting from an import also updates the proven definition", () => {
    const owner = sourceDocument("Card.luau", 'local function Card() return e("Frame") end\nreturn Card');
    const caller = sourceDocument("App.luau", 'local Card = require("./Card")\nreturn Card({})');
    const plans = planComponentRenameDocuments(caller, caller.getText().indexOf("Card"), "Panel", [owner, caller]);
    assert.ok(applyTextChanges(owner.getText(), plans.get(owner)!).endsWith("return Panel"));
    assert.ok(applyTextChanges(caller.getText(), plans.get(caller)!).includes("return Panel({})"));
  });
});

suite("Refactor regression: component extraction", () => {
  test("passes props, imports and captured locals without recreating state", () => {
    const text = 'local e = React.createElement\nlocal function Screen(props)\n local value = makeState()\n return e("TextLabel", { Text = props.title, Value = value })\nend';
    const plan = extraction(text);
    assert.deepStrictEqual(new Set(plan.captures), new Set(["e", "props", "value"]));
    assert.ok(plan.replacement.includes("__luix_props = props"));
    assert.ok(plan.replacement.includes("__luix_value = value"));
    assert.ok(plan.content.includes("local props = __luixInputs.__luix_props"));
    assert.ok(!plan.content.includes("makeState()"));
  });

  test("a new import cannot shadow an existing global", () => {
    const text = 'local e = React.createElement\nreturn e("Frame", {})';
    const target = findAllCreateElementCalls(text, getAliasPartition())[0];
    assert.throws(() => planComponentExtraction(text, target, "React", FRAMEWORKS.react), /cannot shadow/);
  });

  test("callback parameters and locals are not captured from the call site", () => {
    const plan = extraction('local e = React.createElement\nreturn e("TextButton", { Activated = function(input) local a,b=1,2; print(input,a,b,theme) end })');
    assert.deepStrictEqual(new Set(plan.captures), new Set(["e", "theme"]));
    assert.ok(plan.content.includes("local a,b=1,2"));
  });

  test("React reserved names receive safe prop keys", () => {
    const plan = extraction('local e = React.createElement\nlocal ref, key = foo, bar\nreturn e("Frame", { Ref = ref, Name = key })');
    assert.ok(plan.replacement.includes("__luix_ref = ref"));
    assert.ok(plan.replacement.includes("__luix_key = key"));
    assert.ok(!/[{,] ref =/.test(plan.replacement));
  });

  test("Fusion receiver and explicit constructor shapes keep their existing scope", () => {
    for (const call of ['scope:New "Frame" { Name = title }', 'New(scope, "Frame")({ Name = title })']) {
      const plan = extraction(`local scope = scoped(Fusion)\nlocal title = "x"\nreturn ${call}`, "fusion");
      assert.ok(plan.replacement.startsWith("ExtractedLabel(scope, "));
      assert.ok(plan.content.startsWith("local function ExtractedLabel(scope, __luixInputs)"));
      assert.ok(!plan.content.includes("scoped(Fusion)"));
    }
  });

  test("captures variables used by interpolation", () => {
    const plan = extraction('return e("TextLabel", { Text = `hello {props.name}` })');
    assert.ok(plan.captures.includes("props"));
    assert.ok(plan.content.includes("`hello {props.name}`"));
  });

  test("preserves multiline literal bytes for LF and CRLF sources", () => {
    for (const eol of ["\n", "\r\n"]) {
      for (const literal of [`[[First line${eol}Second line]]`, `\`Hello${eol}{props.name}\``]) {
        const plan = extraction(`return e("TextLabel", { Text = ${literal} })`);
        assert.ok(plan.content.includes(literal));
        assert.ok(!plan.content.includes("\r\r\n"));
      }
    }
  });

  test("rejects writes to captured locals instead of changing closure semantics", () => {
    assert.throws(() => extraction('local count = 0\nreturn e("TextButton", { Activated = function() count += 1 end })'), /assigns to captured/);
    assert.throws(() => extraction('local count = 0\ncount = 1\nreturn e("TextLabel", { Text = count })'), /reassigned/);
    assert.throws(() => extraction('local count = 0\nlocal data = {}\nreturn e("TextButton", { Activated = function() count, data.x = count + 1, 2 end })'), /assigns to captured/);
    assert.throws(() => extraction('local count = 0\nreturn e("TextButton", { Activated = function() print("click"); count = count + 1 end })'), /assigns to captured/);
  });

  test("creates a sibling file and rewrites init.luau with one WorkspaceEdit", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "luix-extract-regression-"));
    try {
      const sourceUri = vscode.Uri.file(path.join(directory, "init.luau"));
      const newUri = vscode.Uri.file(path.join(directory, "ExtractedLabel.luau"));
      const text = '--!strict\nlocal e = React.createElement\nlocal function Screen(props)\n return e("TextLabel", { Text = [[First line\nSecond line]], Name = props.title })\nend\nreturn Screen\n'.replace(/\n/g, "\r\n");
      await vscode.workspace.fs.writeFile(sourceUri, Buffer.from(text));
      const document = await vscode.workspace.openTextDocument(sourceUri);
      const target = findAllCreateElementCalls(text, getAliasPartition())[0];
      const plan = planComponentExtraction(text, target, "ExtractedLabel", FRAMEWORKS.react);
      assert.strictEqual(await vscode.workspace.applyEdit(buildExtractionEdit(document, target, "ExtractedLabel", newUri, plan)), true);
      const output = await vscode.workspace.openTextDocument(newUri);
      assert.ok(output.getText().includes("local props = __luixInputs.__luix_props"));
      assert.ok(output.getText().includes("[[First line\r\nSecond line]]"));
      assert.ok(!output.getText().includes("\r\r\n"));
      assert.ok(document.getText().startsWith('--!strict\r\nlocal ExtractedLabel = require(script.ExtractedLabel)'));
      assert.ok(document.getText().includes("__luix_props = props"));
      await document.save(); await output.save();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

suite("Refactor regression: visual property edits", () => {
  const rectUpdates = [
    { key: "ImageRectOffset", value: "Vector2.new(1, 2)", remove: false },
    { key: "ImageRectSize", value: "Vector2.new(20, 30)", remove: false },
  ];

  test("two missing crop fields produce one separator and preserve existing image", () => {
    const body = ' Image = "rbxassetid://123" ';
    const output = rewriteLiteralProps(body, extractPropEntries(body), rectUpdates, "  ");
    assert.ok(!output.includes(",,"));
    const entries = extractPropEntries(output);
    assert.deepStrictEqual(entries.map(e => e.key), ["Image", "ImageRectOffset", "ImageRectSize"]);
    assert.ok(output.includes('Image = "rbxassetid://123",'));
  });

  test("three missing gradient fields work with a comment after the final value", () => {
    const body = '\n  Name = "Gradient" -- preserve this note\n';
    const updates = ["Color", "Transparency", "Rotation"].map(key => ({ key, value: "1", remove: false }));
    const output = rewriteLiteralProps(body, extractPropEntries(body), updates, "  ");
    assert.ok(output.includes('Name = "Gradient", -- preserve this note'));
    assert.ok(!output.includes(",,"));
    assert.deepStrictEqual(extractPropEntries(output).map(e => e.key), ["Name", "Color", "Transparency", "Rotation"]);
  });

  test("can remove a final property and add new ones in the same operation", () => {
    const body = '\n  Name = "x",\n  Rotation = 0\n';
    const output = rewriteLiteralProps(body, extractPropEntries(body), [{ key: "Rotation", value: "0", remove: true }, ...rectUpdates], "  ");
    assert.ok(!output.includes("Rotation"));
    assert.ok(!output.includes(",,"));
    assert.deepStrictEqual(extractPropEntries(output).map(e => e.key), ["Name", "ImageRectOffset", "ImageRectSize"]);
  });

  test("rejects duplicate edited keys and preserves semicolon separators", () => {
    const duplicate = " Rotation = 1, Rotation = 2 ";
    assert.throws(() => rewriteLiteralProps(duplicate, extractPropEntries(duplicate), [{ key: "Rotation", value: "3", remove: false }], " "), /duplicate/);
    const body = ' Image = "rbxassetid://123"; ';
    const output = rewriteLiteralProps(body, extractPropEntries(body), rectUpdates, " ");
    assert.ok(!output.includes(";,"));
    assert.ok(luaTokens(output).length > 0);
  });
});
