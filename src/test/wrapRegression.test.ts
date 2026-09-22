import * as assert from "assert";
import * as vscode from "vscode";
import { WrapInCodeActionProvider } from "../codeActions";
import { applyTextChanges } from "../editSyntax";
import { findAllCreateElementCalls } from "../parser";
import { getAliasPartition } from "../frameworks";

async function wraps(text: string): Promise<Map<string, string>> {
  const document = await vscode.workspace.openTextDocument({ language: "luau", content: text });
  const at = text.indexOf("TextLabel") + 2;
  assert.ok(at >= 2);
  const position = document.positionAt(at);
  const actions = await new WrapInCodeActionProvider().provideCodeActions(document, new vscode.Range(position, position));
  assert.ok(actions && actions.length === 3);
  return new Map(actions.map(action => {
    const edits = action.edit?.get(document.uri);
    assert.ok(edits && edits.length === 1);
    return [action.title, applyTextChanges(text, edits.map(edit => ({
      start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end), text: edit.newText,
    })))];
  }));
}

suite("Wrap regression: constructors and literal preservation", () => {
  test("explicit Fusion scope survives all wrapper constructors and the list layout", async () => {
    const inner = 'New(scope, "TextLabel")({ Text = "Hello" })';
    const text = 'local Children = Fusion.Children\nreturn ' + inner;
    for (const [title, output] of await wraps(text)) {
      assert.ok(output.includes(inner));
      const calls = findAllCreateElementCalls(output, getAliasPartition());
      const wrapper = calls[0];
      assert.ok(output.slice(wrapper.aliasStart, wrapper.propsBraceStart).startsWith('New(scope, "'));
      assert.ok(output.slice(wrapper.propsBraceEnd! + 1, wrapper.fullEnd) === ")");
      if (title.includes("UIListLayout")) {
        assert.ok(output.includes('New(scope, "UIListLayout")({'));
        assert.ok(/\[Children\] = \{\s*New\(scope, "UIListLayout"\)/.test(output));
      }
    }
  });

  test("receiver calls retain both parenthesized stages", async () => {
    const inner = 'scope:New("TextLabel")({ Text = "Hello" })';
    const text = 'local Children = Fusion.Children\nreturn ' + inner;
    const output = (await wraps(text)).get("Wrap in Frame + UIListLayout")!;
    assert.ok(output.includes('scope:New("Frame")({'));
    assert.ok(output.includes('scope:New("UIListLayout")({'));
    assert.ok(output.includes(inner));
  });

  test("Fusion list layout uses the existing qualified Children key", async () => {
    const text = 'return scope:New "Frame" { [scope.Children] = { scope:New "TextLabel" { Text = "Hello" } } }';
    const output = (await wraps(text)).get("Wrap in Frame + UIListLayout")!;
    assert.ok(/\[scope\.Children\] = \{\s*scope:New "UIListLayout"/.test(output));
    assert.ok(!output.includes("[Children]"));
  });

  test("Fusion list layout reuses an imported Children alias", async () => {
    const text = 'local Kids = Fusion.Children\nreturn New(scope, "TextLabel") { Text = "Hello" }';
    const output = (await wraps(text)).get("Wrap in Frame + UIListLayout")!;
    assert.ok(/\[Kids\] = \{\s*New\(scope, "UIListLayout"\)/.test(output));
    assert.ok(!output.includes("[Children]"));
  });

  test("legacy Fusion, React and Vide keep their respective children layouts", async () => {
    const fusion = (await wraps('local Children = Fusion.Children\nreturn New "TextLabel" {}')).get("Wrap in Frame + UIListLayout")!;
    assert.ok(/\[Children\] = \{\s*New "UIListLayout"/.test(fusion));
    const react = (await wraps('return e("TextLabel", {})')).get("Wrap in Frame + UIListLayout")!;
    assert.ok(/\}, \{\s*e\("UIListLayout"/.test(react));
    assert.ok(!react.includes("[Children]"));
    const vide = (await wraps('return create("TextLabel", {})')).get("Wrap in Frame + UIListLayout")!;
    assert.ok(vide.startsWith('return create("Frame", {'));
    assert.ok(vide.includes('create("UIListLayout", {'));
    assert.ok(!vide.includes("[Children]"));
  });

  test("all wrappers preserve multiline string bytes in LF and CRLF documents", async () => {
    for (const eol of ["\n", "\r\n"]) {
      for (const literal of [`[[First line${eol}Second line]]`, `\`Hello${eol}{props.name}\``]) {
        const inner = `e("TextLabel", { Text = ${literal} })`;
        for (const output of (await wraps("return " + inner)).values()) {
          assert.ok(output.includes(inner));
          assert.ok(output.includes(literal));
          assert.ok(!output.includes("\r\r\n"));
        }
      }
    }
  });
});
