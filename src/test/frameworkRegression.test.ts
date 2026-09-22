import * as assert from "assert";
import * as vscode from "vscode";
import {
  _internal,
  detectFrameworkForDocument,
  getWorkspaceFallback,
  resetDocumentDetectionCache,
  setWorkspaceFallback,
} from "../activeFramework";
import { getEnabledFrameworks } from "../frameworks";
import { _renderTemplate } from "../scaffolds";
import { scanDocument } from "../parser";
import { fusionSnippetBody } from "../fusionSnippets";
import { _internal as snippets } from "../elementSnippets";

suite("Framework detection regressions", () => {
  test("ignores imports in comments and ordinary strings", () => {
    const text = [
      '-- require(Packages.Vide)',
      '--[=[ require(Packages.Fusion) ]=]',
      'local example = "require(Packages.Roact)"',
      'local React = require(Packages.React)',
    ].join("\n");
    assert.strictEqual(_internal.detectFromRequires(text), "react");
  });

  test("balances nested calls and accepts multiline requires", () => {
    assert.strictEqual(_internal.detectFromRequires([
      'local Fusion = require(',
      '  game:GetService("ReplicatedStorage").Packages.Fusion',
      ')',
    ].join("\n")), "fusion");
    assert.strictEqual(_internal.detectFromRequires('local ui = require("@Packages/vide")'), "vide");
    assert.strictEqual(_internal.detectFromRequires('local ui = require("@Packages/Fusion" -- module\n)'), "fusion");
    assert.strictEqual(_internal.detectFromRequires('local ui = require(--[[ module ]] "@Packages/Fusion")'), "fusion");
  });

  test("ignores framework names in nested strings and comments", () => {
    assert.strictEqual(_internal.detectFromRequires([
      'local React = require(game:GetService("Vide").Packages.React -- Fusion',
      ')',
    ].join("\n")), "react");
    assert.strictEqual(_internal.detectFromRequires('loader.require(Packages.Vide)'), undefined);
  });

  test("a disabled import does not hide an enabled framework", () => {
    assert.strictEqual(_internal.detectFromRequires([
      'local vide = require(Packages.Vide)',
      'local React = require(Packages.React)',
    ].join("\n"), new Set(["react"])), "react");
  });

  test("Vide direct constructors select Vide without importing a factory", () => {
    assert.strictEqual(_internal.detectFromCalls('local frame = Frame({ Size = UDim2.fromScale(1, 1) })'), "vide");
    assert.strictEqual(_internal.detectFromCalls('local Frame = function(props) return props end\nFrame({})'), undefined);
  });

  test("new workspace inference invalidates an unchanged document", () => {
    const previous = getWorkspaceFallback();
    const doc = {
      uri: vscode.Uri.file("/luix-framework-regression/new.luau"),
      version: 1,
      getText: () => "",
    } as unknown as vscode.TextDocument;
    try {
      resetDocumentDetectionCache();
      setWorkspaceFallback(undefined);
      assert.strictEqual(detectFrameworkForDocument(doc).effective, undefined);
      setWorkspaceFallback("react");
      assert.strictEqual(detectFrameworkForDocument(doc).effective, "react");
      setWorkspaceFallback("vide");
      assert.strictEqual(detectFrameworkForDocument(doc).effective, "vide");
    } finally {
      setWorkspaceFallback(previous);
      resetDocumentDetectionCache();
    }
  });

  test("an explicit empty framework list disables all frameworks", async () => {
    const config = vscode.workspace.getConfiguration("luix");
    const previous = config.inspect<string[]>("frameworks")?.globalValue;
    try {
      await config.update("frameworks", [], vscode.ConfigurationTarget.Global);
      assert.deepStrictEqual(getEnabledFrameworks(), []);
      const doc = {
        uri: vscode.Uri.file("/luix-framework-regression/disabled.luau"),
        version: 1,
        getText: () => 'local React = require(Packages.React)',
      } as unknown as vscode.TextDocument;
      assert.strictEqual(detectFrameworkForDocument(doc).effective, undefined);
    } finally {
      await config.update("frameworks", previous, vscode.ConfigurationTarget.Global);
      resetDocumentDetectionCache();
    }
  });
});

suite("Fusion scaffold compatibility", () => {
  const snippet = (prefix: string) => snippets.SNIPPETS.find((entry) => entry.prefix === prefix)!.body.join("\n");
  test("new component accepts its caller's scope and keeps props inference", () => {
    const code = _renderTemplate("fusion", "Card");
    assert.ok(code.includes("scope: Fusion.Scope<typeof(Fusion)>, props"));
    assert.ok(code.includes('scope:New "Frame"'));
    assert.ok(!code.includes("local New = Fusion.New"));
    const component = scanDocument(code, { parens: [], curried: ["New", "Fusion.New"] }).get("Card");
    assert.strictEqual(component?.paramName, "props");
    assert.strictEqual(component?.detectedBase, "Frame");
  });

  test("explicit legacy scaffold keeps the Fusion 0.2 constructor", () => {
    const code = _renderTemplate("fusion", "Card", true);
    assert.ok(code.includes("local function Card(props)"));
    assert.ok(code.includes('return New "Frame"'));
    assert.ok(!code.includes("scope:New"));
  });

  test("element and state snippets use the enclosing component scope", () => {
    const text = _renderTemplate("fusion", "Card");
    const offset = text.indexOf("return scope:New");
    assert.ok(fusionSnippetBody("nFrame", snippet("nFrame"), text, offset).startsWith('scope:New "Frame"'));
    assert.ok(fusionSnippetBody("value", snippet("value"), text, offset).includes("scope:Value("));
    assert.ok(fusionSnippetBody("computed", snippet("computed"), text, offset).includes("scope:Computed(function(use, scope)"));
    assert.ok(fusionSnippetBody("forPairs", snippet("forPairs"), text, offset).includes("function(use, scope, key, value)"));
  });

  test("scoped local aliases and bare scopes retain their calling convention", () => {
    const scoped = "local ui = Fusion.scoped(Fusion)\nlocal marker = true";
    assert.ok(fusionSnippetBody("value", snippet("value"), scoped, scoped.length).includes("ui:Value("));
    const bare = "local scope = {}\nlocal marker = true";
    assert.ok(fusionSnippetBody("value", snippet("value"), bare, bare.length).includes("Value(scope, "));
    const empty = "local scope = scoped()\nlocal marker = true";
    assert.ok(fusionSnippetBody("nFrame", snippet("nFrame"), empty, empty.length).startsWith('New(scope, "Frame")'));
    const partial = "local scope = scoped({Value = Fusion.Value})\nlocal marker = true";
    assert.ok(fusionSnippetBody("nFrame", snippet("nFrame"), partial, partial.length).startsWith('New(scope, "Frame")'));
  });

  test("does not borrow a scope from another function", () => {
    const text = "local function Other(scope)\nreturn scope\nend\nlocal marker = true";
    assert.strictEqual(fusionSnippetBody("value", snippet("value"), text, text.length), snippet("value"));
  });

  test("new nfc snippets use scopes and existing legacy files keep New syntax", () => {
    const blank = "local Fusion = require(Packages.Fusion)";
    assert.ok(fusionSnippetBody("nfc", snippet("nfc"), blank, blank.length).includes("scope: Fusion.Scope"));
    const legacy = 'local x = New "Frame" {}';
    assert.strictEqual(fusionSnippetBody("nfc", snippet("nfc"), legacy, legacy.length), snippet("nfc"));
    assert.strictEqual(fusionSnippetBody("value", snippet("value"), legacy, legacy.length), snippet("value"));
    const namedScope = 'local function Test(scope)\n local old = New "Frame" {}\n local marker = true\nend';
    assert.strictEqual(fusionSnippetBody("nFrame", snippet("nFrame"), namedScope, namedScope.indexOf("local marker")), snippet("nFrame"));
  });
});
