// End-to-end checks that go through the real extension host: open a
// `luau` document, let the extension activate and publish diagnostics,
// then inspect what VS Code reports. Complements the pure-function suites
// in `extension.test.ts` for behaviour that only exists once the
// providers are wired up (diagnostics, hover, completion).
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const UNKNOWN_PROP = "luix.unknown-prop";

async function activateExtension(): Promise<void> {
  const ext = vscode.extensions.getExtension("ericplane.luix-roblox");
  assert.ok(ext, "luix extension not found in the test host");
  await ext!.activate();
}

// The providers are registered for `scheme: "file"` only, so fixtures
// are written to a temp directory as real `.luau` files rather than
// opened as untitled documents.
let fixtureDir: string | undefined;
let fixtureCounter = 0;

async function openLuau(content: string): Promise<vscode.TextDocument> {
  if (!fixtureDir) {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "luix-e2e-"));
  }
  const file = path.join(fixtureDir, `fixture-${++fixtureCounter}.luau`);
  fs.writeFileSync(file, content, "utf8");
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  assert.strictEqual(doc.languageId, "luau");
  await activateExtension();
  return doc;
}

suiteTeardown(() => {
  if (fixtureDir) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  }
});

/**
 * Diagnostics are published asynchronously after open. Poll until the
 * `luix` set has been stable for a few consecutive reads.
 */
async function luixDiagnostics(content: string): Promise<vscode.Diagnostic[]> {
  const doc = await openLuau(content);
  let last = "";
  let stable = 0;
  let diags: vscode.Diagnostic[] = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    diags = vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.source === "luix");
    const sig = JSON.stringify(diags.map((d) => [d.code, d.message]));
    if (sig === last) {
      stable++;
      if (stable >= 4) {
        break;
      }
    } else {
      stable = 0;
      last = sig;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return diags;
}

function unknownPropKeys(diags: vscode.Diagnostic[]): string[] {
  return diags
    .filter((d) => d.code === UNKNOWN_PROP)
    .map((d) => /Unknown property `([^`]+)`/.exec(d.message)?.[1] ?? d.message)
    .sort();
}

function positionOf(doc: vscode.TextDocument, needle: string): vscode.Position {
  const idx = doc.getText().indexOf(needle);
  assert.notStrictEqual(idx, -1, `"${needle}" not found in document`);
  return doc.positionAt(idx + 1);
}

async function hoverTextAt(
  doc: vscode.TextDocument,
  needle: string
): Promise<string> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    doc.uri,
    positionOf(doc, needle)
  );
  return (hovers ?? [])
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === "string" ? c : "value" in c ? c.value : ""))
    .join("\n");
}

/**
 * Open a document whose text contains a single `|` cursor marker and
 * return the extension's completion items at that spot. VS Code's own
 * word-based suggestions are filtered out by keeping only items whose
 * `detail` names the class (`TextButton property` / `TextButton event`).
 */
async function luixCompletions(
  contentWithCursor: string,
  className: string
): Promise<vscode.CompletionItem[]> {
  const cursor = contentWithCursor.indexOf("|");
  assert.notStrictEqual(cursor, -1, "fixture must contain a | cursor marker");
  const content =
    contentWithCursor.slice(0, cursor) + contentWithCursor.slice(cursor + 1);
  const doc = await openLuau(content);
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    doc.uri,
    doc.positionAt(cursor)
  );
  return (list?.items ?? []).filter(
    (i) => typeof i.detail === "string" && i.detail.startsWith(className)
  );
}

function labelOf(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

// ============================================================================
// Unknown-prop diagnostic — Vide events as plain keys (issue #4)
// ============================================================================

suite("e2e diagnostics — Vide events as plain keys (issue #4)", () => {
  test("curried `create \"TextButton\" { events }` → no unknown-prop", async () => {
    const diags = await luixDiagnostics(
      [
        'local b = create "TextButton" {',
        '  Text = "hi",',
        "  Activated = function() end,",
        "  MouseEnter = function() end,",
        "  MouseLeave = function() end,",
        "  MouseButton1Down = function() end,",
        "  MouseButton1Up = function() end,",
        "}",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), []);
  });

  test("parens `create(\"TextButton\", { events })` → no unknown-prop", async () => {
    const diags = await luixDiagnostics(
      [
        'local b = create("TextButton", {',
        "  Activated = function() end,",
        "  MouseEnter = function() end,",
        "})",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), []);
  });

  test("`Vide.create(\"TextBox\", { FocusLost })` → no unknown-prop", async () => {
    const diags = await luixDiagnostics(
      [
        'local b = Vide.create("TextBox", {',
        "  FocusLost = function() end,",
        "  Focused = function() end,",
        "})",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), []);
  });

  test("receiver form `MyVide.create \"Frame\" { MouseEnter }` → no unknown-prop", async () => {
    const diags = await luixDiagnostics(
      [
        "local MyVide = require(script.Parent.vide)",
        'local b = MyVide.create "Frame" {',
        "  MouseEnter = function() end,",
        "}",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), []);
  });

  test("Instance-level signals (Destroying, AncestryChanged, Changed, …) are accepted", async () => {
    const diags = await luixDiagnostics(
      [
        'local b = create "Frame" {',
        "  Destroying = function() end,",
        "  AncestryChanged = function() end,",
        "  Changed = function() end,",
        "  ChildAdded = function() end,",
        "  StyledPropertiesChanged = function() end,",
        "}",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), []);
  });

  test("GuiButton.SecondaryActivated is accepted; a bogus key beside it is still flagged", async () => {
    const diags = await luixDiagnostics(
      [
        'local b = create "TextButton" {',
        "  SecondaryActivated = function() end,",
        "  NotARealProp = 1,",
        "}",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), ["NotARealProp"]);
  });

  test("VideoFrame / UIPageLayout events are accepted", async () => {
    const diags = await luixDiagnostics(
      [
        'local v = create "VideoFrame" {',
        "  Ended = function() end,",
        "  Loaded = function() end,",
        "}",
        'local p = create "UIPageLayout" {',
        "  PageEnter = function() end,",
        "  Stopped = function() end,",
        "}",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), []);
  });

  test("typo `Activatd` is still flagged, with did-you-mean `Activated`", async () => {
    const diags = await luixDiagnostics(
      ['local b = create "TextButton" {', "  Activatd = function() end,", "}"].join(
        "\n"
      )
    );
    assert.deepStrictEqual(unknownPropKeys(diags), ["Activatd"]);
    const d = diags.find((x) => x.code === UNKNOWN_PROP)!;
    assert.ok(
      d.message.includes("Did you mean `Activated`"),
      `expected did-you-mean Activated, got: ${d.message}`
    );
  });

  test("an event the class doesn't have (Frame.Activated) is still flagged", async () => {
    const diags = await luixDiagnostics(
      ['local b = create "Frame" {', "  Activated = function() end,", "}"].join(
        "\n"
      )
    );
    assert.deepStrictEqual(unknownPropKeys(diags), ["Activated"]);
  });

  test("a genuinely unknown prop next to an event is still flagged", async () => {
    const diags = await luixDiagnostics(
      [
        'local b = create "TextButton" {',
        "  Activated = function() end,",
        "  NotARealProp = 1,",
        "}",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), ["NotARealProp"]);
  });

  test("React computed event keys are unaffected; a bare React `Activated` is still a mistake", async () => {
    const ok = await luixDiagnostics(
      [
        'local b = e("TextButton", {',
        '  Text = "x",',
        "  [React.Event.Activated] = function() end,",
        "})",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(ok), []);

    const bad = await luixDiagnostics(
      ['local b = e("TextButton", {', "  Activated = function() end,", "})"].join(
        "\n"
      )
    );
    assert.deepStrictEqual(unknownPropKeys(bad), ["Activated"]);
  });

  test("Fusion `[OnEvent \"Activated\"]` is unaffected; a bare Fusion `Activated` is still a mistake", async () => {
    const ok = await luixDiagnostics(
      [
        'local b = New "TextButton" {',
        '  Text = "x",',
        '  [OnEvent "Activated"] = function() end,',
        "}",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(ok), []);

    const bad = await luixDiagnostics(
      ['local b = New "TextButton" {', "  Activated = function() end,", "}"].join(
        "\n"
      )
    );
    assert.deepStrictEqual(unknownPropKeys(bad), ["Activated"]);
  });

  test("Roact `[Roact.Event.Activated]` is unaffected", async () => {
    const diags = await luixDiagnostics(
      [
        'local b = Roact.createElement("TextButton", {',
        "  [Roact.Event.Activated] = function() end,",
        "})",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), []);
  });
});

// ============================================================================
// Unknown-prop diagnostic — `Parent = …` for Fusion / Vide
// ============================================================================

suite("e2e diagnostics — Parent as a table key", () => {
  test("Fusion `New \"ScreenGui\" { Parent = … }` → no unknown-prop", async () => {
    const diags = await luixDiagnostics(
      [
        'local gui = New "ScreenGui" {',
        '  Name = "HUD",',
        "  Parent = playerGui,",
        "}",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), []);
  });

  test("Vide `create \"ScreenGui\" { Parent = … }` → no unknown-prop", async () => {
    const diags = await luixDiagnostics(
      [
        'local gui = create "ScreenGui" {',
        "  Parent = playerGui,",
        "  ResetOnSpawn = false,",
        "}",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), []);
  });

  test("typo `Parnt` under Fusion suggests `Parent`", async () => {
    const diags = await luixDiagnostics(
      ['local gui = New "ScreenGui" {', "  Parnt = playerGui,", "}"].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), ["Parnt"]);
    const d = diags.find((x) => x.code === UNKNOWN_PROP)!;
    assert.ok(
      d.message.includes("Did you mean `Parent`"),
      `expected did-you-mean Parent, got: ${d.message}`
    );
  });

  test("React / Roact `Parent = …` is still flagged (they mount via a root), and the warning says why", async () => {
    const react = await luixDiagnostics(
      ['local gui = e("ScreenGui", {', "  Parent = playerGui,", "})"].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(react), ["Parent"]);
    const rd = react.find((x) => x.code === UNKNOWN_PROP)!;
    assert.ok(rd.message.startsWith("Unknown property `Parent` on `ScreenGui`."), rd.message);
    assert.ok(rd.message.includes("React mounts through a root or portal"), rd.message);

    const roact = await luixDiagnostics(
      [
        'local gui = Roact.createElement("ScreenGui", {',
        "  Parent = playerGui,",
        "})",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(roact), ["Parent"]);
    const od = roact.find((x) => x.code === UNKNOWN_PROP)!;
    assert.ok(od.message.includes("Roact mounts through a root or portal"), od.message);
  });

  test("Vide direct instance call `ScreenGui({ … })` is not prop-validated at all", async () => {
    // `NotARealProp` would be flagged on a scanned host-class call; its
    // absence proves the direct-call shape never reaches the validator.
    const diags = await luixDiagnostics(
      [
        "local gui = ScreenGui({",
        "  Parent = playerGui,",
        "  NotARealProp = 1,",
        "})",
      ].join("\n")
    );
    assert.deepStrictEqual(unknownPropKeys(diags), []);
  });
});

// ============================================================================
// Hover — Vide event keys and Parent
// ============================================================================

suite("e2e hover — event keys and Parent", () => {
  test("hovering `Activated` in a Vide TextButton shows an event hover", async () => {
    const doc = await openLuau(
      ['local b = create "TextButton" {', "  Activated = function() end,", "}"].join(
        "\n"
      )
    );
    const text = await hoverTextAt(doc, "Activated");
    assert.ok(text.includes("**TextButton.Activated**"), text);
    assert.ok(text.includes("Event"), text);
    assert.ok(text.includes("Inherited from `GuiButton`"), text);
    assert.ok(text.includes("classes/GuiButton#Activated"), text);
  });

  test("hovering `MouseEnter` in a Vide direct instance call `Frame({ … })` shows an event hover", async () => {
    const doc = await openLuau(
      ["local f = Frame({", "  MouseEnter = function() end,", "})"].join("\n")
    );
    const text = await hoverTextAt(doc, "MouseEnter");
    assert.ok(text.includes("**Frame.MouseEnter**"), text);
    assert.ok(text.includes("Inherited from `GuiObject`"), text);
  });

  test("hovering `Parent` in a Fusion `New \"ScreenGui\"` shows the Parent hover", async () => {
    const doc = await openLuau(
      ['local gui = New "ScreenGui" {', "  Parent = playerGui,", "}"].join("\n")
    );
    const text = await hoverTextAt(doc, "Parent");
    assert.ok(text.includes("**ScreenGui.Parent**"), text);
    assert.ok(text.includes("Type: `Instance`"), text);
  });

  test("hovering a bare `Activated` in a React table shows nothing (not a React prop)", async () => {
    const doc = await openLuau(
      ['local b = e("TextButton", {', "  Activated = function() end,", "})"].join(
        "\n"
      )
    );
    const text = await hoverTextAt(doc, "Activated");
    assert.strictEqual(text, "");
  });

  test("computed event keys get the event hover under React, Roact and Fusion", async () => {
    const react = await openLuau(
      ['local b = e("TextButton", {', "  [React.Event.Activated] = fn,", "})"].join("\n")
    );
    assert.ok((await hoverTextAt(react, "Activated")).includes("**TextButton.Activated**"));

    const roact = await openLuau(
      [
        'local b = Roact.createElement("TextBox", {',
        "  [Roact.Event.FocusLost] = fn,",
        "})",
      ].join("\n")
    );
    assert.ok((await hoverTextAt(roact, "FocusLost")).includes("**TextBox.FocusLost**"));

    const fusion = await openLuau(
      ['local b = New "Frame" {', '  [OnEvent "MouseEnter"] = fn,', "}"].join("\n")
    );
    const text = await hoverTextAt(fusion, "MouseEnter");
    assert.ok(text.includes("**Frame.MouseEnter**"), text);
    assert.ok(text.includes("Inherited from `GuiObject`"), text);
  });

  test("event / Parent hovers only fire on keys, not on identifiers in values", async () => {
    const doc = await openLuau(
      [
        'local f = create "Frame" {',
        "  Size = other.Changed,",
        "  Parent = script.Parent,",
        "}",
      ].join("\n")
    );
    assert.strictEqual(await hoverTextAt(doc, "Changed"), "");
    // The value's `Parent` (in `script.Parent,`) — no hover; the key does.
    assert.strictEqual(await hoverTextAt(doc, "Parent,"), "");
    assert.ok((await hoverTextAt(doc, "Parent =")).includes("**Frame.Parent**"));
  });

  test("`Changed` hover links to the Object docs page where the anchor exists", async () => {
    const doc = await openLuau(
      ['local f = create "Frame" {', "  Changed = function() end,", "}"].join("\n")
    );
    const text = await hoverTextAt(doc, "Changed");
    assert.ok(text.includes("**Frame.Changed**"), text);
    assert.ok(text.includes("Inherited from `Instance`"), text);
    assert.ok(text.includes("classes/Object#Changed"), text);
  });

  test("Fusion `[OnEvent 'X']` (single quotes) gets the event hover too", async () => {
    // The parenthesised `[OnEvent("X")]` spelling is not covered: the
    // enclosing-call detector bails when the cursor is inside `( … )`
    // within a props table, a pre-existing parser limitation.
    const single = await openLuau(
      ['local b = New "TextButton" {', "  [OnEvent 'Activated'] = fn,", "}"].join("\n")
    );
    assert.ok((await hoverTextAt(single, "Activated")).includes("**TextButton.Activated**"));
  });

  test("Parent hover: Vide curried and direct-call yes, React no", async () => {
    const vide = await openLuau(
      ['local gui = create "ScreenGui" {', "  Parent = playerGui,", "}"].join("\n")
    );
    assert.ok((await hoverTextAt(vide, "Parent")).includes("**ScreenGui.Parent**"));

    const direct = await openLuau(
      ["local gui = ScreenGui({", "  Parent = playerGui,", "})"].join("\n")
    );
    assert.ok((await hoverTextAt(direct, "Parent")).includes("**ScreenGui.Parent**"));

    const react = await openLuau(
      ['local gui = e("ScreenGui", {', "  Parent = playerGui,", "})"].join("\n")
    );
    assert.strictEqual(await hoverTextAt(react, "Parent"), "");
  });

  test("a key whose `=` wrapped onto the next line still hovers", async () => {
    const doc = await openLuau(
      ['local b = create "TextButton" {', "  Activated", "    = function() end,", "}"].join("\n")
    );
    assert.ok((await hoverTextAt(doc, "Activated")).includes("**TextButton.Activated**"));
  });

  test("Vide custom component with a known base gets an event hover", async () => {
    const doc = await openLuau(
      [
        "---@extends TextButton",
        "local function Button(props)",
        '  return create "TextButton" { Text = props.Text }',
        "end",
        "",
        "local b = create(Button, {",
        '  Text = "hi",',
        "  Activated = function() end,",
        "})",
      ].join("\n")
    );
    const text = await hoverTextAt(doc, "Activated = ");
    assert.ok(text.includes("**Button.Activated**"), text);
    assert.ok(text.includes("Event forwarded from `TextButton.Activated`"), text);
  });

  test("custom component under React: computed event key hovers, bare key does not", async () => {
    const doc = await openLuau(
      [
        "---@extends TextButton",
        "local function Button(props)",
        '  return e("TextButton", { Text = props.Text })',
        "end",
        "",
        "local b = e(Button, {",
        "  [React.Event.Activated] = fn,",
        "  MouseEnter = fn,",
        "})",
      ].join("\n")
    );
    const computed = await hoverTextAt(doc, "Activated");
    assert.ok(computed.includes("Event forwarded from `TextButton.Activated`"), computed);
    // React doesn't take events as plain keys, so `MouseEnter = fn` on a
    // React component is not an event and gets no event hover.
    assert.strictEqual(await hoverTextAt(doc, "MouseEnter"), "");
  });

  test("regular prop hover still works", async () => {
    const doc = await openLuau(
      ['local b = create "TextButton" {', '  Text = "hi",', "}"].join("\n")
    );
    const text = await hoverTextAt(doc, "Text =");
    assert.ok(text.includes("**TextButton.Text**"), text);
  });
});

// ============================================================================
// Completion — Vide events carry the Event kind; Parent offered for Fusion/Vide
// ============================================================================

suite("e2e completion — event items and Parent", () => {
  test("Vide TextButton props list includes events as Event items with a handler snippet", async () => {
    const items = await luixCompletions(
      ['local b = create "TextButton" {', "  |", "}"].join("\n"),
      "TextButton"
    );
    const activated = items.find((i) => labelOf(i) === "Activated");
    assert.ok(activated, "Activated not offered");
    assert.strictEqual(activated!.kind, vscode.CompletionItemKind.Event);
    assert.strictEqual(activated!.detail, "TextButton event");
    const insert = activated!.insertText;
    assert.ok(insert instanceof vscode.SnippetString, "expected a snippet");
    assert.ok(
      (insert as vscode.SnippetString).value.startsWith(
        "Activated = function()"
      ),
      (insert as vscode.SnippetString).value
    );
    // Regular props keep the Property kind.
    const text = items.find((i) => labelOf(i) === "Text");
    assert.ok(text, "Text not offered");
    assert.strictEqual(text!.kind, vscode.CompletionItemKind.Property);
    // Most-specific events lead the merged list (own → inherited).
    const labels = items.map(labelOf);
    assert.ok(
      labels.indexOf("Activated") < labels.indexOf("MouseEnter"),
      "GuiButton events should precede GuiObject events"
    );
    assert.ok(
      labels.indexOf("MouseEnter") < labels.indexOf("Destroying"),
      "GuiObject events should precede Instance events"
    );
  });

  test("renaming an existing entry inserts just the event name (name-only mode)", async () => {
    const items = await luixCompletions(
      ['local b = create "TextButton" {', "  Activ| = function() end,", "}"].join("\n"),
      "TextButton"
    );
    const activated = items.find((i) => labelOf(i) === "Activated");
    assert.ok(activated, "Activated not offered");
    assert.strictEqual(activated!.kind, vscode.CompletionItemKind.Event);
    const insert = activated!.insertText;
    assert.ok(insert instanceof vscode.SnippetString);
    assert.strictEqual((insert as vscode.SnippetString).value, "Activated");
  });

  test("Vide direct instance call `Frame({ | })` offers events and Parent", async () => {
    const items = await luixCompletions(
      ["local f = Frame({", "  |", "})"].join("\n"),
      "Frame"
    );
    const labels = items.map(labelOf);
    assert.ok(labels.includes("Parent"), "Parent not offered");
    const mouseEnter = items.find((i) => labelOf(i) === "MouseEnter");
    assert.ok(mouseEnter, "MouseEnter not offered");
    assert.strictEqual(mouseEnter!.kind, vscode.CompletionItemKind.Event);
  });

  test("Parent is offered for Fusion and Vide host classes (typed Instance), not for React", async () => {
    const fusionItems = await luixCompletions(
      ['local gui = New "ScreenGui" {', "  |", "}"].join("\n"),
      "ScreenGui"
    );
    const fusion = fusionItems.map(labelOf);
    const parent = fusionItems.find((i) => labelOf(i) === "Parent");
    assert.ok(parent, "Fusion should offer Parent");
    assert.strictEqual(parent!.detail, "ScreenGui property — Instance");
    // ScreenGui has the Instance signals; Fusion (eventsAsProps=false)
    // must not merge them into its prop list.
    assert.ok(!fusion.includes("Destroying"), "Fusion should not merge events");

    const vide = (
      await luixCompletions(
        ['local gui = create "ScreenGui" {', "  |", "}"].join("\n"),
        "ScreenGui"
      )
    ).map(labelOf);
    assert.ok(vide.includes("Parent"), "Vide should offer Parent");
    assert.ok(vide.includes("Destroying"), "Vide should merge Instance events");

    const react = (
      await luixCompletions(
        ['local gui = e("ScreenGui", {', "  |", "})"].join("\n"),
        "ScreenGui"
      )
    ).map(labelOf);
    assert.ok(react.includes("Enabled"), "sanity: React list populated");
    assert.ok(!react.includes("Parent"), "React should not offer Parent");
    assert.ok(!react.includes("Destroying"), "React should not merge events");
  });

  test("event snippet honours `luix.snippetMode = value` (no trailing comma)", async () => {
    const cfg = vscode.workspace.getConfiguration("luix");
    await cfg.update("snippetMode", "value", vscode.ConfigurationTarget.Global);
    try {
      const items = await luixCompletions(
        ['local b = create "TextButton" {', "  |", "}"].join("\n"),
        "TextButton"
      );
      const insert = items.find((i) => labelOf(i) === "Activated")!
        .insertText as vscode.SnippetString;
      assert.strictEqual(insert.value, "Activated = function()\n\t$1\nend$0");
    } finally {
      await cfg.update("snippetMode", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("`[OnEvent \"|` lists most-specific events first and includes the new signals", async () => {
    const items = await luixCompletions(
      ['local b = New "TextButton" {', '  [OnEvent "|"] = fn,', "}"].join("\n"),
      "TextButton"
    );
    const labels = items.map(labelOf);
    assert.strictEqual(labels[0], "Activated");
    assert.ok(labels.includes("SecondaryActivated"));
    assert.ok(labels.includes("StyledPropertiesChanged"));
    assert.ok(labels.indexOf("MouseEnter") < labels.indexOf("Destroying"));
  });

  test("`[React.Event.|` lists most-specific events first and includes Instance signals", async () => {
    const items = await luixCompletions(
      ['local b = e("TextButton", {', "  [React.Event.|] = fn,", "})"].join("\n"),
      "TextButton"
    );
    const labels = items.map(labelOf);
    assert.ok(labels.includes("Activated"), "Activated missing");
    assert.ok(labels.includes("SecondaryActivated"), "SecondaryActivated missing");
    assert.ok(labels.includes("Destroying"), "Instance events missing");
    assert.ok(labels.includes("StyledPropertiesChanged"), "StyledPropertiesChanged missing");
    assert.strictEqual(labels[0], "Activated", "GuiButton's own events lead");
    assert.ok(labels.indexOf("MouseEnter") < labels.indexOf("Destroying"));
    assert.strictEqual(items[0].detail, "TextButton event");
  });
});

// ============================================================================
// Sort props code action — class-scoped events, children preserved
// ============================================================================

import { SortPropsCodeActionProvider } from "../sortProps";

suite("e2e sort props — code action", () => {
  async function sortedTextAt(
    content: string,
    needle: string
  ): Promise<string | undefined> {
    const doc = await openLuau(content);
    const pos = positionOf(doc, needle);
    const actions = new SortPropsCodeActionProvider().provideCodeActions(
      doc,
      new vscode.Range(pos, pos)
    );
    if (!actions || actions.length === 0) {
      return undefined;
    }
    const edit = actions[0].edit!;
    const [[, edits]] = edit.entries();
    const e = edits[0];
    return (
      doc.getText().slice(0, doc.offsetAt(e.range.start)) +
      e.newText +
      doc.getText().slice(doc.offsetAt(e.range.end))
    );
  }

  test("sorts a Vide VideoFrame with its own event list and keeps the inline child", async () => {
    const out = await sortedTextAt(
      [
        'local v = create "VideoFrame" {',
        '  create "TextLabel" { Text = "t" },',
        "  Ended = fn,",
        "  Size = x,",
        '  Name = "v",',
        "}",
      ].join("\n"),
      "Ended"
    );
    assert.strictEqual(
      out,
      [
        'local v = create "VideoFrame" {',
        '  Name = "v",',
        "  Size = x,",
        "  Ended = fn,",
        '  create "TextLabel" { Text = "t" },',
        "}",
      ].join("\n")
    );
  });

  test("the same `Ended` key on a Frame is an ordinary prop (Other), after the child", async () => {
    const out = await sortedTextAt(
      [
        'local f = create "Frame" {',
        "  Ended = fn,",
        '  create "TextLabel" { Text = "t" },',
        '  Name = "f",',
        "}",
      ].join("\n"),
      "Ended"
    );
    assert.strictEqual(
      out,
      [
        'local f = create "Frame" {',
        '  Name = "f",',
        '  create "TextLabel" { Text = "t" },',
        "  Ended = fn,",
        "}",
      ].join("\n")
    );
  });

  test("an already-sorted table offers no action", async () => {
    const out = await sortedTextAt(
      ['local f = create "Frame" {', '  Name = "f",', "  Size = x,", "}"].join("\n"),
      "Size"
    );
    assert.strictEqual(out, undefined);
  });
});
