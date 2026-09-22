import * as assert from "assert";
import * as vscode from "vscode";
import { CreateElementInlayHintsProvider } from "../editor";

suite("Vide recording: closing labels", () => {
  let previousScope: unknown;
  let previousPosition: unknown;
  let provider: CreateElementInlayHintsProvider;

  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration("luix");
    previousScope = config.inspect("inlayHints.scope")?.globalValue;
    previousPosition = config.inspect("inlayHints.position")?.globalValue;
    await config.update("inlayHints.scope", "all", vscode.ConfigurationTarget.Global);
    await config.update("inlayHints.position", "after-comma", vscode.ConfigurationTarget.Global);
    provider = new CreateElementInlayHintsProvider();
  });

  suiteTeardown(async () => {
    provider.dispose();
    const config = vscode.workspace.getConfiguration("luix");
    await config.update("inlayHints.scope", previousScope, vscode.ConfigurationTarget.Global);
    await config.update("inlayHints.position", previousPosition, vscode.ConfigurationTarget.Global);
  });

  test("partial child ranges exclude the enclosing ImageButton label", async () => {
    const text = 'return create "ImageButton" {\n  create "TextLabel" {\n    Text = "Hello",\n  },\n}';
    const document = await vscode.workspace.openTextDocument({ language: "luau", content: text });
    const range = new vscode.Range(1, 0, 3, 4);
    const hints = await provider.provideInlayHints(document, range);
    assert.deepStrictEqual(hints?.map(hint => hint.label), [" ▸ TextLabel"]);
    assert.ok(hints?.every(hint => range.contains(hint.position)));
  });

  test("after-comma labels respect the exact character boundary", async () => {
    const text = 'local children = {\n  create "TextLabel" {\n    Text = "Hello",\n  },\n}';
    const document = await vscode.workspace.openTextDocument({ language: "luau", content: text });
    const beforeComma = new vscode.Range(1, 0, 3, 3);
    assert.deepStrictEqual(await provider.provideInlayHints(document, beforeComma), []);
    const throughComma = new vscode.Range(1, 0, 3, 4);
    const hints = await provider.provideInlayHints(document, throughComma);
    assert.strictEqual(hints?.length, 1);
    assert.ok(hints?.[0].position.isEqual(new vscode.Position(3, 4)));
  });

  test("editing a classless Vide child produces no inherited parent label or source edits", async () => {
    const initial = 'return create "ImageButton" {\n  create {\n  }\n}';
    const document = await vscode.workspace.openTextDocument({ language: "luau", content: initial });
    const fullRange = () => new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
    let hints = await provider.provideInlayHints(document, fullRange());
    assert.deepStrictEqual(hints?.map(hint => hint.label), [" ▸ ImageButton"]);
    assert.ok(hints?.[0].position.isEqual(new vscode.Position(3, 1)));
    assert.strictEqual(document.getText(), initial);

    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(1, 8), ' "TextLabel"');
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    const edited = document.getText();
    hints = await provider.provideInlayHints(document, fullRange());
    assert.deepStrictEqual(hints?.map(hint => hint.label), [" ▸ ImageButton", " ▸ TextLabel"]);
    assert.ok(hints?.[1].position.isEqual(new vscode.Position(2, 3)));
    assert.ok(hints?.every(hint => hint.textEdits === undefined));
    assert.strictEqual(document.getText(), edited);
  });
});
