import * as assert from "assert";
import * as vscode from "vscode";
import {
  buildCodeMask,
  extractPropEntries,
  findEnclosingFactoryStringArg,
  findEnclosingPropsCall,
  extractTypeFields,
  parseAnnotationsForComponent,
  scanDocument,
  _internal,
} from "../extension";

const ALIASES = _internal.DEFAULT_ALIASES;

function detect(text: string, cursorMarker = "|"): ReturnType<typeof findEnclosingPropsCall> {
  const cursor = text.indexOf(cursorMarker);
  assert.notStrictEqual(cursor, -1, "test text must contain a cursor marker");
  const stripped = text.slice(0, cursor) + text.slice(cursor + cursorMarker.length);
  return findEnclosingPropsCall(stripped, cursor, ALIASES);
}

suite("buildCodeMask", () => {
  test("masks line comments", () => {
    const text = `local x = 1 -- {hidden}\nx = 2`;
    const mask = buildCodeMask(text);
    const idxOfBrace = text.indexOf("{");
    assert.strictEqual(mask[idxOfBrace], false, "{ inside comment is not code");
  });

  test("masks block comments", () => {
    const text = `--[[ {fake} ]]\nlocal y = 3`;
    const mask = buildCodeMask(text);
    assert.strictEqual(mask[text.indexOf("{")], false);
    assert.strictEqual(mask[text.indexOf("}")], false);
  });

  test("masks double-quoted string interiors", () => {
    const text = `local s = "click {here}"\n`;
    const mask = buildCodeMask(text);
    assert.strictEqual(mask[text.indexOf("{")], false);
    assert.strictEqual(mask[text.indexOf("}")], false);
    // Quotes themselves remain code.
    assert.strictEqual(mask[text.indexOf('"')], true);
  });

  test("masks long bracket strings", () => {
    const text = `local s = [==[ {nested} ]==]\n`;
    const mask = buildCodeMask(text);
    assert.strictEqual(mask[text.indexOf("{")], false);
    assert.strictEqual(mask[text.indexOf("}")], false);
  });

  test("leaves real code untouched", () => {
    const text = `e("Frame", { Size = 1 })`;
    const mask = buildCodeMask(text);
    assert.strictEqual(mask[text.indexOf("{")], true);
    assert.strictEqual(mask[text.indexOf("}")], true);
  });
});

suite("findEnclosingPropsCall", () => {
  test("detects simple e(\"Frame\", { ... }) call", () => {
    const result = detect(`e("Frame", { | })`);
    assert.strictEqual(result?.className, "Frame");
    assert.strictEqual(result?.isStringLiteralName, true);
  });

  test("detects React.createElement", () => {
    const result = detect(`React.createElement("TextLabel", { | })`);
    assert.strictEqual(result?.className, "TextLabel");
    assert.strictEqual(result?.isStringLiteralName, true);
  });

  test("detects Roact.createElement", () => {
    const result = detect(`Roact.createElement("Frame", { | })`);
    assert.strictEqual(result?.className, "Frame");
  });

  test("detects custom component (identifier, no quotes)", () => {
    const result = detect(`e(MyButton, { | })`);
    assert.strictEqual(result?.className, "MyButton");
    assert.strictEqual(result?.isStringLiteralName, false);
  });

  test("detects dotted identifier component", () => {
    const result = detect(`e(Components.Button, { | })`);
    assert.strictEqual(result?.className, "Components.Button");
  });

  test("returns the actually-enclosing class, not the last seen one (regression for issue #3)", () => {
    // Cursor is back in Frame's props, after a closed TextLabel child.
    const text = `
e("Frame", {
    child = e("TextLabel", { Text = "x" }),
    |
})`.trimStart();
    const result = detect(text);
    assert.strictEqual(result?.className, "Frame");
  });

  test("handles deep nesting correctly", () => {
    const text = `
e("Frame", {
    Layout = e("UIListLayout", { Padding = 5 }),
    Inner = e("ScrollingFrame", {
        |
    }),
})`.trimStart();
    const result = detect(text);
    assert.strictEqual(result?.className, "ScrollingFrame");
  });

  test("ignores braces inside strings (regression for issue #4)", () => {
    const text = `
e("TextLabel", {
    Text = "click {here}",
    |
})`.trimStart();
    const result = detect(text);
    assert.strictEqual(result?.className, "TextLabel");
  });

  test("ignores braces inside line comments", () => {
    const text = `
e("TextLabel", {
    -- } this } closes nothing
    |
})`.trimStart();
    const result = detect(text);
    assert.strictEqual(result?.className, "TextLabel");
  });

  test("rejects identifier-suffix `e` false positives (regression for issue #5)", () => {
    // `frame(...)` is NOT a createElement call.
    const result = detect(`frame("Frame", { | })`);
    assert.strictEqual(result, undefined);
  });

  test("rejects an identifier ending in `e` followed by paren", () => {
    const result = detect(`createMe("Frame", { | })`);
    assert.strictEqual(result, undefined);
  });

  test("returns undefined outside any createElement call", () => {
    const result = detect(`local t = { | }`);
    assert.strictEqual(result, undefined);
  });

  test("returns undefined inside an unclosed paren expression", () => {
    // Cursor is in the argument list of UDim2.new, not in Frame's props.
    const text = `e("Frame", { Size = UDim2.new(| ) })`;
    const result = detect(text);
    assert.strictEqual(result, undefined);
  });

  test("works when cursor is right after the opening brace", () => {
    const result = detect(`e("Frame", {|})`);
    assert.strictEqual(result?.className, "Frame");
  });

  test("works with the snake-case `createElement` alias", () => {
    const result = detect(`createElement("Frame", { | })`);
    assert.strictEqual(result?.className, "Frame");
  });

  test("custom aliases via config", () => {
    const text = `r("Frame", { | })`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(stripped, cursor, ["r"]);
    assert.strictEqual(result?.className, "Frame");
  });

  test("does not match createElement inside a comment", () => {
    const text = `
-- e("Decoy", {
e("Frame", {
    |
})`.trimStart();
    const result = detect(text);
    assert.strictEqual(result?.className, "Frame");
  });
});

suite("Default props map", () => {
  test("contains Frame with BackgroundColor3", () => {
    assert.ok(_internal.defaultPropsMap.Frame.includes("BackgroundColor3"));
  });

  test("contains TextLabel with Text", () => {
    assert.ok(_internal.defaultPropsMap.TextLabel.includes("Text"));
  });

  test("Frame includes modern GuiObject props (Interactable, Active, Selectable)", () => {
    const frame = _internal.defaultPropsMap.Frame;
    assert.ok(frame.includes("Interactable"));
    assert.ok(frame.includes("Active"));
    assert.ok(frame.includes("Selectable"));
    assert.ok(frame.includes("Name"));
  });

  test("UIListLayout includes Wraps and HorizontalFlex", () => {
    const list = _internal.defaultPropsMap.UIListLayout;
    assert.ok(list.includes("Wraps"));
    assert.ok(list.includes("HorizontalFlex"));
    assert.ok(list.includes("VerticalFlex"));
  });

  test("ScrollingFrame includes modern scroll-bar props", () => {
    const sf = _internal.defaultPropsMap.ScrollingFrame;
    assert.ok(sf.includes("ScrollBarImageColor3"));
    assert.ok(sf.includes("ElasticBehavior"));
    assert.ok(sf.includes("HorizontalScrollBarInset"));
  });

  test("TextLabel includes FontFace", () => {
    assert.ok(_internal.defaultPropsMap.TextLabel.includes("FontFace"));
  });

  test("New utility classes are present", () => {
    assert.ok(_internal.defaultPropsMap.UIAspectRatioConstraint);
    assert.ok(_internal.defaultPropsMap.UIFlexItem);
    assert.ok(_internal.defaultPropsMap.UISizeConstraint);
    assert.ok(_internal.defaultPropsMap.UIScale);
    assert.ok(_internal.defaultPropsMap.UITableLayout);
  });
});

// ============================================================================
// 1.4.0 — type-aware snippets
// ============================================================================

import { _testing } from "../extension";

suite("renderTypeSnippet", () => {
  test("Color3 yields fromRGB template", () => {
    const s = _testing.renderTypeSnippet("Color3");
    assert.ok(s && s.startsWith("Color3.fromRGB("));
    assert.ok(s.includes("${1:"));
  });

  test("UDim2 yields four-arg template", () => {
    const s = _testing.renderTypeSnippet("UDim2");
    assert.ok(s && s.includes("UDim2.new"));
    assert.ok(s.includes("${4:0}"));
  });

  test("boolean yields a choice element", () => {
    const s = _testing.renderTypeSnippet("boolean");
    assert.strictEqual(s, "${1|true,false|}");
  });

  test("Enum.* falls back to a generic template", () => {
    const s = _testing.renderTypeSnippet("Enum.HorizontalAlignment");
    assert.strictEqual(s, "Enum.HorizontalAlignment.${1}");
  });

  test("unknown types return undefined", () => {
    assert.strictEqual(_testing.renderTypeSnippet("MysteryType"), undefined);
  });
});

suite("Class hierarchy", () => {
  test("GuiObject base exists and has core props", () => {
    const gui = _testing.classHierarchy.GuiObject;
    assert.ok(gui, "GuiObject should be defined");
    assert.ok(gui.own.includes("BackgroundColor3"));
    assert.ok(gui.own.includes("Interactable"));
    assert.ok(gui.own.includes("Position"));
    assert.ok(gui.own.includes("Size"));
  });

  test("Frame inherits from GuiObject and adds Style", () => {
    const frame = _testing.classHierarchy.Frame;
    assert.strictEqual(frame.inherits, "GuiObject");
    // Frame's own `Style` prop is type `Enum.FrameStyle` (distinct from
    // GuiButton's `Style` → `Enum.ButtonStyle`); resolved via
    // `PROP_TYPE_OVERRIDES`.
    assert.deepStrictEqual(frame.own, ["Style"]);
    assert.strictEqual(
      _testing.getPropType("Frame", "Style"),
      "Enum.FrameStyle"
    );
  });

  test("TextButton chains inheritance: GuiObject → GuiButton → TextButton", () => {
    const tb = _testing.classHierarchy.TextButton;
    assert.strictEqual(tb.inherits, "GuiButton");
    // `own` carries the text-rendering props (mirrored from TextLabel) since
    // TextButton is a button-and-label hybrid in our model.
    assert.ok(tb.own.includes("Text"));
    assert.ok(tb.own.includes("FontFace"));
  });

  test("Flattening TextButton includes GuiObject, GuiButton, and text props", () => {
    const flat = _testing.flattenClassProps("TextButton");
    // From GuiObject:
    assert.ok(flat.includes("BackgroundColor3"));
    assert.ok(flat.includes("Position"));
    assert.ok(flat.includes("Interactable"));
    // From GuiButton:
    assert.ok(flat.includes("AutoButtonColor"));
    assert.ok(flat.includes("Selected"));
    // Mirrored text props on TextButton itself:
    assert.ok(flat.includes("Text"));
    assert.ok(flat.includes("FontFace"));
  });

  test("Flattening ImageButton includes GuiButton extras and image props", () => {
    const flat = _testing.flattenClassProps("ImageButton");
    assert.ok(flat.includes("Image"));
    assert.ok(flat.includes("ImageColor3"));
    assert.ok(flat.includes("AutoButtonColor"));
    assert.ok(flat.includes("HoverImage"));
  });

  test("UILayout subclasses share Padding/FillDirection from UILayout", () => {
    for (const cls of [
      "UIListLayout",
      "UIGridLayout",
      "UIPageLayout",
      "UITableLayout",
    ]) {
      const flat = _testing.flattenClassProps(cls);
      assert.ok(flat.includes("FillDirection"), `${cls} should inherit FillDirection`);
      assert.ok(flat.includes("HorizontalAlignment"), `${cls} should inherit HorizontalAlignment`);
    }
  });

  test("Flattening is idempotent (no duplicate prop names)", () => {
    const flat = _testing.flattenClassProps("ScrollingFrame");
    assert.strictEqual(
      new Set(flat).size,
      flat.length,
      "no duplicates expected after dedupe"
    );
  });

  test("Unknown class flattens to empty", () => {
    assert.deepStrictEqual(
      _testing.flattenClassProps("NotARealClass"),
      []
    );
  });
});

suite("PROP_TYPES coverage", () => {
  test("known Color3-typed props are tagged", () => {
    for (const name of [
      "BackgroundColor3",
      "TextColor3",
      "BorderColor3",
      "ImageColor3",
    ]) {
      assert.strictEqual(
        _testing.PROP_TYPES[name],
        "Color3",
        `expected ${name} → Color3`
      );
    }
  });

  test("Interactable is a boolean", () => {
    assert.strictEqual(_testing.PROP_TYPES.Interactable, "boolean");
  });

  test("Name is a string", () => {
    assert.strictEqual(_testing.PROP_TYPES.Name, "string");
  });

  test("Size and Position are UDim2", () => {
    assert.strictEqual(_testing.PROP_TYPES.Size, "UDim2");
    assert.strictEqual(_testing.PROP_TYPES.Position, "UDim2");
  });

  test("Style resolves to the right enum per class", () => {
    // Frame.Style → Enum.FrameStyle
    assert.strictEqual(
      _testing.getPropType("Frame", "Style"),
      "Enum.FrameStyle"
    );
    // GuiButton.Style → Enum.ButtonStyle (and inherited subclasses)
    assert.strictEqual(
      _testing.getPropType("GuiButton", "Style"),
      "Enum.ButtonStyle"
    );
    assert.strictEqual(
      _testing.getPropType("TextButton", "Style"),
      "Enum.ButtonStyle"
    );
    assert.strictEqual(
      _testing.getPropType("ImageButton", "Style"),
      "Enum.ButtonStyle"
    );
  });

  test("getPropType falls back to global PROP_TYPES for shared props", () => {
    // BackgroundColor3 has no override — same answer everywhere.
    assert.strictEqual(
      _testing.getPropType("Frame", "BackgroundColor3"),
      "Color3"
    );
    assert.strictEqual(
      _testing.getPropType("TextButton", "BackgroundColor3"),
      "Color3"
    );
    // No className supplied at all → still resolves via the global map.
    assert.strictEqual(
      _testing.getPropType(undefined, "Position"),
      "UDim2"
    );
  });
});

// ============================================================================
// 1.2.0 — in-file prop inference
// ============================================================================

suite("extractTypeFields", () => {
  test("simple flat literal", () => {
    assert.deepStrictEqual(
      extractTypeFields(`a: number, b: string`),
      ["a", "b"]
    );
  });

  test("trailing comma is fine", () => {
    assert.deepStrictEqual(
      extractTypeFields(`a: number, b: string,`),
      ["a", "b"]
    );
  });

  test("semicolon separator works", () => {
    assert.deepStrictEqual(
      extractTypeFields(`a: number; b: string`),
      ["a", "b"]
    );
  });

  test("optional fields", () => {
    assert.deepStrictEqual(
      extractTypeFields(`a: number?, b: string?`),
      ["a", "b"]
    );
  });

  test("nested types do not leak inner fields", () => {
    assert.deepStrictEqual(
      extractTypeFields(`a: { x: number, y: number }, b: string`),
      ["a", "b"]
    );
  });

  test("function-typed field", () => {
    assert.deepStrictEqual(
      extractTypeFields(`onClick: () -> (), label: string`),
      ["onClick", "label"]
    );
  });

  test("function with typed params doesn't leak inner names", () => {
    assert.deepStrictEqual(
      extractTypeFields(`onClick: (x: number) -> string, label: string`),
      ["onClick", "label"]
    );
  });

  test("index signature is skipped", () => {
    assert.deepStrictEqual(
      extractTypeFields(`[string]: number, label: string`),
      ["label"]
    );
  });

  test("generic field type", () => {
    assert.deepStrictEqual(
      extractTypeFields(`items: Array<string>, count: number`),
      ["items", "count"]
    );
  });
});

suite("parseAnnotationsForComponent", () => {
  test("single @extends directive", () => {
    const text = `---@extends Frame\nlocal function Foo() end`;
    const result = parseAnnotationsForComponent(text, 1);
    assert.strictEqual(result.extendsClass, "Frame");
    assert.deepStrictEqual(result.props, []);
  });

  test("multiple @prop lines preserve order", () => {
    const text = [
      "---@prop gamepassId number",
      "---@prop layoutOrder number?",
      "---@prop onActivated () -> ()",
      "local function GamepassCard(props) end",
    ].join("\n");
    const result = parseAnnotationsForComponent(text, 3);
    assert.deepStrictEqual(result.props, [
      "gamepassId",
      "layoutOrder",
      "onActivated",
    ]);
  });

  test("mixed @extends and @prop", () => {
    const text = [
      "---@extends Frame",
      "---@prop gamepassId number",
      "local function GamepassCard(props) end",
    ].join("\n");
    const result = parseAnnotationsForComponent(text, 2);
    assert.strictEqual(result.extendsClass, "Frame");
    assert.deepStrictEqual(result.props, ["gamepassId"]);
  });

  test("stops at first non-triple-dash line", () => {
    const text = [
      "-- a regular comment",
      "---@extends Frame",
      "local function Foo(props) end",
    ].join("\n");
    // The plain `--` comment breaks the chain, so @extends is NOT picked up.
    const result = parseAnnotationsForComponent(text, 2);
    assert.strictEqual(result.extendsClass, "Frame");
  });

  test("returns empty when no annotations present", () => {
    const text = `local function Foo(props) end`;
    const result = parseAnnotationsForComponent(text, 0);
    assert.strictEqual(result.extendsClass, undefined);
    assert.deepStrictEqual(result.props, []);
  });
});

suite("scanDocument — function discovery", () => {
  test("discovers a `local function` definition", () => {
    const text = `local function Foo(props) return e("Frame", {}) end`;
    const result = scanDocument(text, ALIASES);
    assert.ok(result.has("Foo"));
  });

  test("discovers a `local X = function` definition", () => {
    const text = `local Bar = function(props) return e("TextLabel", {}) end`;
    const result = scanDocument(text, ALIASES);
    assert.ok(result.has("Bar"));
  });

  test("discovers a dotted function definition (indexed by last segment)", () => {
    const text = `function Module.Baz(props) return e("Frame", {}) end`;
    const result = scanDocument(text, ALIASES);
    assert.ok(result.has("Baz"));
  });
});

suite("scanDocument — return-statement auto-detection", () => {
  test("simple `return e(\"Frame\", ...)`", () => {
    const text = `local function Foo(props) return e("Frame", {}) end`;
    const info = scanDocument(text, ALIASES).get("Foo");
    assert.strictEqual(info?.detectedBase, "Frame");
  });

  test("skips returns inside nested functions", () => {
    const text = `
local function Outer(props)
    local inner = function()
        return e("Inner", {})
    end
    return e("Outer", {})
end`.trimStart();
    const info = scanDocument(text, ALIASES).get("Outer");
    assert.strictEqual(info?.detectedBase, "Outer");
  });

  test("doesn't detect when no createElement is returned", () => {
    const text = `local function Foo(props) return 1 end`;
    const info = scanDocument(text, ALIASES).get("Foo");
    assert.strictEqual(info?.detectedBase, undefined);
  });

  test("ignores returns inside `hover:map(function() return X end)` style callbacks", () => {
    const text = `
local function GamepassCard(props)
    local color = hover:map(function(h)
        return otherClass:Lerp(other, h)
    end)
    return e("Frame", {})
end`.trimStart();
    const info = scanDocument(text, ALIASES).get("GamepassCard");
    assert.strictEqual(info?.detectedBase, "Frame");
  });

  test("ignores `return` inside `if/then/end` block correctly", () => {
    const text = `
local function Foo(props)
    if cond then
        return e("A", {})
    end
    return e("B", {})
end`.trimStart();
    const info = scanDocument(text, ALIASES).get("Foo");
    // First top-level return wins.
    assert.strictEqual(info?.detectedBase, "A");
  });
});

suite("scanDocument — typed signature inference", () => {
  test("inline literal type", () => {
    const text = `local function Foo(props: { a: number, b: string }) end`;
    const info = scanDocument(text, ALIASES).get("Foo");
    assert.deepStrictEqual(info?.paramTypeFields, ["a", "b"]);
  });

  test("named type alias resolves", () => {
    const text = [
      "type FooProps = { a: number, b: string }",
      "local function Foo(props: FooProps) end",
    ].join("\n");
    const info = scanDocument(text, ALIASES).get("Foo");
    assert.deepStrictEqual(info?.paramTypeFields, ["a", "b"]);
  });

  test("no type annotation → no signature fields", () => {
    const text = `local function Foo(props) end`;
    const info = scanDocument(text, ALIASES).get("Foo");
    assert.strictEqual(info?.paramTypeFields, undefined);
  });

  test("return-type annotation doesn't confuse parser", () => {
    const text = `local function Foo(props: { a: number }): React.ReactNode end`;
    const info = scanDocument(text, ALIASES).get("Foo");
    assert.deepStrictEqual(info?.paramTypeFields, ["a"]);
  });
});

suite("scanDocument — annotations integration", () => {
  test("picks up @extends and @prop above a function", () => {
    const text = [
      "---@extends Frame",
      "---@prop gamepassId number",
      "local function GamepassCard(props) end",
    ].join("\n");
    const info = scanDocument(text, ALIASES).get("GamepassCard");
    assert.strictEqual(info?.annotations.extendsClass, "Frame");
    assert.deepStrictEqual(info?.annotations.props, ["gamepassId"]);
  });
});

suite("scanDocument — caching", () => {
  test("returns the same map instance for the same input", () => {
    const text = `local function Foo(props) return e("Frame", {}) end`;
    const a = scanDocument(text, ALIASES);
    const b = scanDocument(text, ALIASES);
    assert.strictEqual(a, b);
  });
});

// ============================================================================
// 1.3.0 — cross-file resolution (unit)
// ============================================================================
//
// The full WorkspaceIndex relies on VS Code's file watcher and workspace
// APIs. The hard part — parsing — is already covered by scanDocument tests.
// Here we just verify the *aggregation* logic that `findComponent` will run
// over the cache, by parsing two pretend "files" the same way the index
// does and looking up across them.

// ============================================================================
// 1.5.0 — new helpers
// ============================================================================

import {
  extractColorLiterals,
  findAllCreateElementCalls,
  buildCallTree,
} from "../extension";

suite("Events (1.5)", () => {
  test("GuiObject events include MouseEnter and MouseLeave", () => {
    const events = _testing.flattenClassEvents("GuiObject");
    assert.ok(events.includes("MouseEnter"));
    assert.ok(events.includes("MouseLeave"));
  });

  test("TextButton inherits Activated from GuiButton", () => {
    const events = _testing.flattenClassEvents("TextButton");
    assert.ok(events.includes("Activated"));
    assert.ok(events.includes("MouseButton1Click"));
    // Still has GuiObject events:
    assert.ok(events.includes("MouseEnter"));
  });

  test("TextBox has Focused / FocusLost / ReturnPressedFromOnScreenKeyboard", () => {
    const events = _testing.flattenClassEvents("TextBox");
    assert.ok(events.includes("Focused"));
    assert.ok(events.includes("FocusLost"));
    assert.ok(events.includes("ReturnPressedFromOnScreenKeyboard"));
  });

  test("Frame doesn't have button-only events", () => {
    const events = _testing.flattenClassEvents("Frame");
    assert.ok(!events.includes("Activated"));
    assert.ok(!events.includes("MouseButton1Click"));
  });
});

suite("findIntroducingClass", () => {
  test("BackgroundColor3 is introduced on GuiObject", () => {
    assert.strictEqual(
      _testing.findIntroducingClass("Frame", "BackgroundColor3"),
      "GuiObject"
    );
    assert.strictEqual(
      _testing.findIntroducingClass("TextLabel", "BackgroundColor3"),
      "GuiObject"
    );
  });

  test("AutoButtonColor is introduced on GuiButton", () => {
    assert.strictEqual(
      _testing.findIntroducingClass("TextButton", "AutoButtonColor"),
      "GuiButton"
    );
  });

  test("CanvasSize is introduced on ScrollingFrame itself", () => {
    assert.strictEqual(
      _testing.findIntroducingClass("ScrollingFrame", "CanvasSize"),
      "ScrollingFrame"
    );
  });

  test("unknown prop returns undefined", () => {
    assert.strictEqual(
      _testing.findIntroducingClass("Frame", "NotAProp"),
      undefined
    );
  });
});

suite("extractColorLiterals", () => {
  test("captures Color3.fromRGB(255, 128, 0)", () => {
    const result = extractColorLiterals("local x = Color3.fromRGB(255, 128, 0)");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].r, 1);
    assert.strictEqual(result[0].g, 128 / 255);
    assert.strictEqual(result[0].b, 0);
  });

  test("captures Color3.new with floats", () => {
    const result = extractColorLiterals("local x = Color3.new(0.5, 0.5, 0.5)");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].r, 0.5);
  });

  test("rejects non-numeric args", () => {
    const result = extractColorLiterals(
      "local x = Color3.fromRGB(getR(), 0, 0)"
    );
    assert.strictEqual(result.length, 0);
  });

  test("rejects out-of-range Color3.new", () => {
    const result = extractColorLiterals("local x = Color3.new(2, 3, 4)");
    assert.strictEqual(result.length, 0);
  });

  test("captures multiple in one document", () => {
    const result = extractColorLiterals(
      `local a = Color3.fromRGB(1, 2, 3)\nlocal b = Color3.fromRGB(4, 5, 6)`
    );
    assert.strictEqual(result.length, 2);
  });
});

suite("findAllCreateElementCalls", () => {
  test("flat list of all calls", () => {
    const text = `
local frame = e("Frame", {
  Name = "Outer",
}, {
  e("TextLabel", { Text = "x" }),
  e("UICorner", {}),
})
`.trimStart();
    const calls = findAllCreateElementCalls(text, _internal.DEFAULT_ALIASES);
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls[0].className, "Frame");
    assert.strictEqual(calls[0].nameProp, "Outer");
    assert.strictEqual(calls[1].className, "TextLabel");
    assert.strictEqual(calls[2].className, "UICorner");
  });

  test("identifier-named components are detected with isStringLiteralName=false", () => {
    const text = `e(MyComp, { LayoutOrder = 1 })`;
    const calls = findAllCreateElementCalls(text, _internal.DEFAULT_ALIASES);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].className, "MyComp");
    assert.strictEqual(calls[0].isStringLiteralName, false);
  });
});

suite("buildCallTree", () => {
  test("nests children under their parent", () => {
    const text = `
local frame = e("Frame", {
  Name = "Outer",
}, {
  e("TextLabel", { Text = "x" }, {
    e("UIPadding", {}),
  }),
  e("UICorner", {}),
})
`.trimStart();
    const calls = findAllCreateElementCalls(text, _internal.DEFAULT_ALIASES);
    const tree = buildCallTree(calls);
    assert.strictEqual(tree.length, 1);
    const root = tree[0];
    assert.strictEqual(root.call.className, "Frame");
    assert.strictEqual(root.children.length, 2);
    assert.strictEqual(root.children[0].call.className, "TextLabel");
    assert.strictEqual(root.children[0].children.length, 1);
    assert.strictEqual(root.children[0].children[0].call.className, "UIPadding");
    assert.strictEqual(root.children[1].call.className, "UICorner");
  });

  test("siblings outside any parent become roots", () => {
    const text = `e("Frame", {})\ne("TextLabel", {})`;
    const calls = findAllCreateElementCalls(text, _internal.DEFAULT_ALIASES);
    const tree = buildCallTree(calls);
    assert.strictEqual(tree.length, 2);
  });
});

suite("collectLocalBindings", () => {
  test("captures `local X = require(...)` lines", () => {
    const text = `
local Foo = require(script.Foo)
local Bar = require(script.Parent.Bar)
local x = 1
local function helper() end
`.trimStart();
    const set = _testing.collectLocalBindings(text);
    assert.ok(set.has("Foo"));
    assert.ok(set.has("Bar"));
    assert.ok(set.has("x"));
    assert.ok(set.has("helper"));
  });

  test("ignores bindings inside string literals", () => {
    const text = `local s = "local Hidden = nothing"`;
    const set = _testing.collectLocalBindings(text);
    assert.ok(set.has("s"));
    assert.ok(!set.has("Hidden"));
  });
});

suite("buildFontFaceReplacement", () => {
  test("known font maps to family + weight", () => {
    assert.strictEqual(
      _testing.buildFontFaceReplacement("GothamBold"),
      'Font.fromName("Gotham", Enum.FontWeight.Bold)'
    );
  });

  test("italic variant uses Font.new", () => {
    const r = _testing.buildFontFaceReplacement("SourceSansItalic");
    assert.ok(r.includes("Enum.FontStyle.Italic"));
  });

  test("unknown font falls back to the enum name as family", () => {
    assert.strictEqual(
      _testing.buildFontFaceReplacement("Mysterious"),
      'Font.fromName("Mysterious", Enum.FontWeight.Regular)'
    );
  });
});

suite("buildRelativePath", () => {
  function uri(p: string) {
    return vscode.Uri.file(p);
  }
  test("siblings in the same dir", () => {
    const from = uri("/proj/src/UI/Shop.lua");
    const to = uri("/proj/src/UI/GamepassCard.lua");
    assert.strictEqual(
      _testing.buildRelativePath(from, to),
      "script.Parent.GamepassCard"
    );
  });

  test("component in a subfolder", () => {
    const from = uri("/proj/src/UI/Shop.lua");
    const to = uri("/proj/src/UI/Components/GamepassCard.lua");
    assert.strictEqual(
      _testing.buildRelativePath(from, to),
      "script.Parent.Components.GamepassCard"
    );
  });

  test("component up a level", () => {
    const from = uri("/proj/src/UI/Shop/index.lua");
    const to = uri("/proj/src/UI/GamepassCard.lua");
    assert.strictEqual(
      _testing.buildRelativePath(from, to),
      "script.Parent.Parent.GamepassCard"
    );
  });
});

suite("Cross-file aggregation", () => {
  test("a component defined in one document is found when looking up by name", () => {
    const fileA = `---@extends Frame\nlocal function GamepassCard(props) end\nreturn GamepassCard`;
    const fileB = `local function Shop() return e(GamepassCard, {}) end`;

    const indexA = scanDocument(fileA, ALIASES);
    const indexB = scanDocument(fileB, ALIASES);

    // File B (the consumer) has no GamepassCard definition.
    assert.strictEqual(indexB.has("GamepassCard"), false);

    // File A has it with the @extends annotation.
    const info = indexA.get("GamepassCard");
    assert.strictEqual(info?.annotations.extendsClass, "Frame");

    // Aggregation: consumer's same-file lookup misses → fall back to file A.
    const acrossFiles = indexB.get("GamepassCard") ?? indexA.get("GamepassCard");
    assert.strictEqual(acrossFiles?.annotations.extendsClass, "Frame");
  });
});

// ============================================================================
// 1.6.0 — multi-framework support (Fusion, Vide)
// ============================================================================

const FUSION_PARTITION = {
  parens: [] as string[],
  curried: ["New", "Fusion.New"],
};
const VIDE_PARTITION = {
  // 1.5.0: Vide aliases live in *both* buckets via
  // `recognizedCallShapes: ["parens", "curried"]` so the parser picks
  // up `create "Frame" { … }`, `create("Frame", { … })`, and the
  // dotted `Vide.create(...)` form alike.
  parens: ["create", "vide.create", "Vide.create"],
  curried: ["create", "vide.create", "Vide.create"],
};
const ALL_PARTITION = {
  parens: [
    "e",
    "createElement",
    "React.createElement",
    "Roact.createElement",
    "create",
    "vide.create",
    "Vide.create",
  ],
  curried: [
    "New",
    "Fusion.New",
    "create",
    "vide.create",
    "Vide.create",
  ],
};

suite("Fusion call detection", () => {
  test("findEnclosingPropsCall picks up `New \"Frame\" { | }`", () => {
    const text = `New "Frame" { | }`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(stripped, cursor, FUSION_PARTITION);
    assert.strictEqual(result?.className, "Frame");
    assert.strictEqual(result?.callShape, "curried");
    assert.strictEqual(result?.alias, "New");
  });

  test("findAllCreateElementCalls picks up a Fusion call", () => {
    const text = `local b = New "Frame" { Name = "Outer" }`;
    const calls = findAllCreateElementCalls(text, FUSION_PARTITION);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].className, "Frame");
    assert.strictEqual(calls[0].isStringLiteralName, true);
    assert.strictEqual(calls[0].nameProp, "Outer");
  });

  test("nested Fusion call appears as a child via call-tree", () => {
    const text = `
local b = New "Frame" {
  Name = "Outer",
  [Children] = {
    New "TextLabel" { Text = "Hi" },
  },
}`.trimStart();
    const calls = findAllCreateElementCalls(text, FUSION_PARTITION);
    assert.strictEqual(calls.length, 2);
    const tree = buildCallTree(calls);
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].call.className, "Frame");
    assert.strictEqual(tree[0].children.length, 1);
    assert.strictEqual(tree[0].children[0].call.className, "TextLabel");
  });
});

suite("Vide call detection", () => {
  test("findEnclosingPropsCall picks up `create \"Frame\" { | }`", () => {
    const text = `create "Frame" { | }`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(stripped, cursor, VIDE_PARTITION);
    assert.strictEqual(result?.className, "Frame");
    assert.strictEqual(result?.callShape, "curried");
    assert.strictEqual(result?.alias, "create");
  });

  test("findAllCreateElementCalls handles inline children", () => {
    const text = `
local b = create "Frame" {
  Name = "Outer",
  create "TextLabel" { Text = "Hi" },
}`.trimStart();
    const calls = findAllCreateElementCalls(text, VIDE_PARTITION);
    assert.strictEqual(calls.length, 2);
    const tree = buildCallTree(calls);
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].children.length, 1);
    assert.strictEqual(tree[0].children[0].call.className, "TextLabel");
  });

  // Fork's three Vide-parens tests — ported as-is so future
  // regressions in the parens-form path get caught early.
  test("findEnclosingPropsCall picks up `Vide.create(\"Frame\", { | })`", () => {
    const text = `Vide.create("Frame", { | })`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(stripped, cursor, VIDE_PARTITION);
    assert.strictEqual(result?.className, "Frame");
    assert.strictEqual(result?.callShape, "parens");
    assert.strictEqual(result?.alias, "Vide.create");
  });

  test("findAllCreateElementCalls handles parenthesised inline children", () => {
    const text = `local b = Vide.create("Frame", {
  Name = "Outer",
  Vide.create("TextLabel", { Text = "Hi" }),
})`;
    const calls = findAllCreateElementCalls(text, VIDE_PARTITION);
    assert.strictEqual(calls.length, 2);
    const tree = buildCallTree(calls);
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].children.length, 1);
    assert.strictEqual(tree[0].children[0].call.className, "TextLabel");
  });
});

suite("Mixed framework file", () => {
  test("both parens and curried calls coexist", () => {
    const text = `
e("Frame", { Name = "A" })
New "Frame" { Name = "B" }
create "Frame" { Name = "C" }`.trimStart();
    const calls = findAllCreateElementCalls(text, ALL_PARTITION);
    const names = calls.map((c) => c.nameProp).sort();
    assert.deepStrictEqual(names, ["A", "B", "C"]);
  });
});

suite("Framework filtering", () => {
  test("Fusion-only partition ignores parens calls", () => {
    const text = `e("Frame", { Name = "A" })\nNew "Frame" { Name = "B" }`;
    const calls = findAllCreateElementCalls(text, FUSION_PARTITION);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].nameProp, "B");
  });

  test("React-only partition ignores curried calls", () => {
    const text = `e("Frame", { Name = "A" })\nNew "Frame" { Name = "B" }`;
    const reactOnly = { parens: ["e"], curried: [] };
    const calls = findAllCreateElementCalls(text, reactOnly);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].nameProp, "A");
  });
});

suite("Parens-form inline-children scoping (1.5.0)", () => {
  // 1.5.0 review: the inline-children fallback in the parens-form
  // branch used to gate on `partition.curried.includes(alias)`, which
  // misfires for non-Vide aliases that happen to land in the curried
  // bucket via an alias override. Behaviour is now scoped to
  // `partition.parensWithInlineChildren` — populated only for
  // frameworks whose spec declares `childrenLayout: "inline"` AND
  // recognises the parens shape (today: Vide only).

  test("React 2-arg parens never sets inline-children", () => {
    // `e("Frame", { Inner = e("X", {}) })` — `Inner` is a prop value,
    // not a sibling child. With React-only aliases (no curried entries)
    // the inline-children branch must NOT fire, so the inner call
    // remains a sibling at the tree root, not nested under `Frame`.
    const text = `e("Frame", { Inner = e("X", {}) })`;
    const calls = findAllCreateElementCalls(text, {
      parens: ["e"],
      curried: [],
      parensWithInlineChildren: [],
    });
    const outer = calls.find((c) => c.className === "Frame");
    assert.strictEqual(outer?.childrenStart, undefined);
    // The buildCallTree result depends on Vide's inline-children
    // membership; with React-only, both calls stay at the root.
    assert.strictEqual(buildCallTree(calls).length, 2);
  });

  test("Vide parens form DOES set inline-children", () => {
    // The positive case — when the alias IS in
    // `parensWithInlineChildren`, the props brace doubles as the
    // children container, so the inner call nests as a tree child.
    const text = `Vide.create("Frame", { Vide.create("X", {}) })`;
    const calls = findAllCreateElementCalls(text, {
      parens: ["Vide.create"],
      curried: ["Vide.create"],
      parensWithInlineChildren: ["Vide.create"],
    });
    const outer = calls.find((c) => c.className === "Frame");
    assert.ok(outer?.childrenStart !== undefined);
    assert.strictEqual(buildCallTree(calls).length, 1);
  });
});

suite("Curried return-statement detection", () => {
  test("detectedBase picks up `return New \"Frame\" {...}`", () => {
    const text = [
      "local function MyCard(props)",
      "  return New \"Frame\" {",
      "    Name = \"Card\",",
      "  }",
      "end",
    ].join("\n");
    const info = scanDocument(text, FUSION_PARTITION).get("MyCard");
    assert.strictEqual(info?.detectedBase, "Frame");
  });

  test("detectedBase picks up `return create \"Frame\" {...}`", () => {
    const text = [
      "local function MyCard(props)",
      "  return create \"Frame\" {",
      "    Name = \"Card\",",
      "  }",
      "end",
    ].join("\n");
    const info = scanDocument(text, VIDE_PARTITION).get("MyCard");
    assert.strictEqual(info?.detectedBase, "Frame");
  });
});

// ============================================================================
// Issue #3: curried calls written with explicit parentheses.
//
// The class-name stage and the props stage each independently accept
// Lua's call sugar or explicit parens, and Fusion 0.3 adds a scope —
// either threaded as a leading argument or bound to a `scope:` receiver
// by `scoped()`. StyLua's `call_parentheses = "Always"` (which the
// Roblox Lua Style Guide mandates) rewrites every sugar call into the
// parenthesised form, so a formatted codebase hits these shapes on
// every element.
// ============================================================================

/** Every way `New "Frame" { … }` can legally be spelled. */
const CURRIED_HEADS = [
  ['sugar', 'New "Frame" '],
  ['scoped sugar', 'scope:New "Frame" '],
  ['dotted receiver', 'MyFusion.New "Frame" '],
  ['configured dotted alias', 'Fusion.New "Frame" '],
  ['paren name stage', 'New("Frame")'],
  ['fusion 0.3 explicit scope', 'New(scope, "Frame")'],
  ['scoped paren name stage', 'scope:New("Frame")'],
] as const;

suite("Curried calls with explicit parentheses (issue #3)", () => {
  for (const [label, head] of CURRIED_HEADS) {
    for (const [propsLabel, open, close] of [
      ["sugar props", "{", "}"],
      ["paren props", "({", "})"],
    ] as const) {
      test(`findAllCreateElementCalls: ${label} + ${propsLabel}`, () => {
        const text = `local x = ${head}${open} Name = "Outer" ${close}`;
        const calls = findAllCreateElementCalls(text, FUSION_PARTITION);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].className, "Frame");
        assert.strictEqual(calls[0].isStringLiteralName, true);
        assert.strictEqual(calls[0].nameProp, "Outer");
        // The reported range has to cover the whole call — receiver and
        // trailing `)` included — or refactors rewrite a partial call.
        assert.strictEqual(
          text.slice(calls[0].aliasStart, calls[0].fullEnd),
          `${head}${open} Name = "Outer" ${close}`
        );
      });

      test(`findEnclosingPropsCall: ${label} + ${propsLabel}`, () => {
        const text = `local x = ${head}${open}\n  `;
        const result = findEnclosingPropsCall(
          text,
          text.length,
          FUSION_PARTITION
        );
        assert.strictEqual(result?.className, "Frame");
        assert.strictEqual(result?.callShape, "curried");
      });
    }
  }

  test("alias resolves past a `scope:` receiver", () => {
    const text = 'local x = scope:New "Frame" { Size = 1 }';
    const [call] = findAllCreateElementCalls(text, FUSION_PARTITION);
    assert.strictEqual(call.alias, "New");
    assert.strictEqual(call.receiver, "scope:");
  });

  test("a configured dotted alias still matches whole", () => {
    const text = 'local x = Fusion.New "Frame" { Size = 1 }';
    const [call] = findAllCreateElementCalls(text, FUSION_PARTITION);
    assert.strictEqual(call.alias, "Fusion.New");
    assert.strictEqual(call.receiver, "");
    assert.strictEqual(call.aliasStart, text.indexOf("Fusion"));
  });

  test("nested StyLua-formatted children build a call tree", () => {
    const text = [
      'local b = scope:New("Frame")({',
      '  [Children] = {',
      '    scope:New("TextLabel")({ Text = "Hi" }),',
      "  },",
      "})",
    ].join("\n");
    const tree = buildCallTree(
      findAllCreateElementCalls(text, FUSION_PARTITION)
    );
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].call.className, "Frame");
    assert.strictEqual(tree[0].children.length, 1);
    assert.strictEqual(tree[0].children[0].call.className, "TextLabel");
  });

  test("Vide's StyLua form parses without colliding with its parens form", () => {
    const text = 'local x = create("Frame")({ Size = 1 })';
    const calls = findAllCreateElementCalls(text, VIDE_PARTITION);
    assert.strictEqual(calls.length, 1, "must not be reported twice");
    assert.strictEqual(calls[0].className, "Frame");
  });

  test("Vide's two-argument parens form is untouched", () => {
    const text = 'local x = create("Frame", { Size = 1 })';
    const calls = findAllCreateElementCalls(text, VIDE_PARTITION);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].className, "Frame");
  });

  test("a bare alias reference is not an element call", () => {
    for (const text of [
      "local New = Fusion.New",
      "local t = { New = 1 }",
      'local ctor = New(scope, "Frame")',
    ]) {
      assert.deepStrictEqual(
        findAllCreateElementCalls(text, FUSION_PARTITION).map(
          (c) => c.className
        ),
        [],
        text
      );
    }
  });

  test("detectedBase follows a parenthesised return", () => {
    for (const returned of [
      'New("Frame")({ Name = "Card" })',
      'New(scope, "Frame") { Name = "Card" }',
      'scope:New("Frame")({ Name = "Card" })',
      'scope:New "Frame" { Name = "Card" }',
    ]) {
      const text = [
        "local function MyCard(scope, props)",
        `  return ${returned}`,
        "end",
      ].join("\n");
      const info = scanDocument(text, FUSION_PARTITION).get("MyCard");
      assert.strictEqual(info?.detectedBase, "Frame", returned);
    }
  });

  test("class-name completion context inside a parenthesised name stage", () => {
    for (const text of [
      'local x = New("Fr',
      'local x = New(scope, "Fr',
      'local x = scope:New("Fr',
    ]) {
      const ctx = findEnclosingFactoryStringArg(
        text,
        text.length,
        FUSION_PARTITION
      );
      assert.strictEqual(ctx?.alias, "New", text);
      assert.strictEqual(ctx?.callShape, "curried", text);
      assert.strictEqual(ctx?.nameStageParens, true, text);
    }
  });

  test("class-name completion sees an existing props table", () => {
    for (const [text, expected] of [
      ['local x = New("Fr")', false],
      ['local x = New("Fr") { }', true],
      ['local x = New("Fr")({ })', true],
    ] as const) {
      const ctx = findEnclosingFactoryStringArg(
        text,
        text.indexOf("Fr") + 2,
        FUSION_PARTITION
      );
      assert.strictEqual(ctx?.hasPropsAfter, expected, text);
    }
  });
});

suite("Fusion 0.3 scope parameter (issue #3)", () => {
  test("props come from the second parameter when the first is a scope", () => {
    const text = [
      "type CardProps = { Title: string }",
      "local function Card(scope: Scope<typeof(Fusion)>, props: CardProps)",
      '  return scope:New("Frame")({ Name = props.Title })',
      "end",
    ].join("\n");
    const info = scanDocument(text, FUSION_PARTITION).get("Card");
    assert.strictEqual(info?.paramName, "props");
    assert.deepStrictEqual(info?.paramTypeFields, ["Title"]);
  });

  test("an untyped `scope` first parameter is skipped too", () => {
    const text = [
      "local function Card(scope, props: { Title: string })",
      '  return scope:New "Frame" { Name = props.Title }',
      "end",
    ].join("\n");
    const info = scanDocument(text, FUSION_PARTITION).get("Card");
    assert.strictEqual(info?.paramName, "props");
  });

  test("a lone parameter is always the props table, whatever it's called", () => {
    const text = [
      "local function Card(scope)",
      '  return New "Frame" { Name = "x" }',
      "end",
    ].join("\n");
    const info = scanDocument(text, FUSION_PARTITION).get("Card");
    assert.strictEqual(info?.paramName, "scope");
  });

  test("a props-first component is unaffected", () => {
    const text = [
      "local function Card(props: { Title: string }, extra)",
      '  return New "Frame" { Name = props.Title }',
      "end",
    ].join("\n");
    const info = scanDocument(text, FUSION_PARTITION).get("Card");
    assert.strictEqual(info?.paramName, "props");
    assert.deepStrictEqual(info?.paramTypeFields, ["Title"]);
  });
});

// ============================================================================
// Sidebar plumbing: palette completion + scaffold templates
// ============================================================================

import { buildPaletteCompletions } from "../palette";
import { _renderTemplate } from "../scaffolds";

suite("Palette completion", () => {
  test("returns one entry per palette color, replaces `Color3.`", () => {
    const palette = {
      primary: "Color3.fromRGB(124, 92, 255)",
      surface: "Color3.fromRGB(28, 30, 38)",
    };
    // Pretend the cursor is at column 30 of a line ending with `= Color3.`.
    const position = new vscode.Position(0, 30);
    const items = buildPaletteCompletions(palette, position);
    assert.strictEqual(items.length, 2);
    const labels = items.map((i) =>
      typeof i.label === "string" ? i.label : i.label.label
    );
    assert.ok(labels.includes("palette.primary"));
    assert.ok(labels.includes("palette.surface"));
    // Each insertion replaces the trailing `Color3.` (7 chars) and
    // inserts the full configured expression.
    for (const item of items) {
      assert.ok(item.range instanceof vscode.Range);
      assert.strictEqual(
        (item.range as vscode.Range).end.character -
          (item.range as vscode.Range).start.character,
        "Color3.".length
      );
      assert.ok(
        typeof item.insertText === "string" &&
          item.insertText.startsWith("Color3.")
      );
    }
  });

  test("returns empty array when palette is empty", () => {
    const items = buildPaletteCompletions({}, new vscode.Position(0, 10));
    assert.deepStrictEqual(items, []);
  });
});

// ============================================================================
// Workspace exclusion + component filtering
// ============================================================================

import { _internal as wsInternal } from "../workspaceIndex";

suite("WorkspaceIndex exclusion", () => {
  test("defaults skip Packages/, _Index/, etc.", () => {
    const dirs = wsInternal.DEFAULT_EXCLUDED_DIRS;
    assert.ok(dirs.includes("Packages"));
    assert.ok(dirs.includes("_Index"));
    assert.ok(dirs.includes("DevPackages"));
    assert.ok(dirs.includes("ServerPackages"));
  });

  test("isExcluded matches any path segment", () => {
    const dirs = wsInternal.DEFAULT_EXCLUDED_DIRS;
    const wallyFile = vscode.Uri.file(
      "/proj/Packages/_Index/react@0.4.0/react/src/index.luau"
    );
    const userFile = vscode.Uri.file(
      "/proj/src/Client/UI/Components/GamepassCard.luau"
    );
    assert.strictEqual(wsInternal.isExcluded(wallyFile, dirs), true);
    assert.strictEqual(wsInternal.isExcluded(userFile, dirs), false);
  });

  test("extra exclude entries work", () => {
    const dirs = [...wsInternal.DEFAULT_EXCLUDED_DIRS, "Tests"];
    const testFile = vscode.Uri.file("/proj/src/Tests/foo.luau");
    assert.strictEqual(wsInternal.isExcluded(testFile, dirs), true);
  });

  test("buildExcludeGlob unions directories", () => {
    const glob = wsInternal.buildExcludeGlob(["Packages", "_Index"]);
    assert.strictEqual(glob, "**/{Packages,_Index}/**");
  });
});

suite("buildFolderTree", () => {
  // Lightweight stub of the workspace folder lookup. The real
  // implementation reads vscode.workspace.getWorkspaceFolder, which
  // would resolve to undefined in the headless test host. We sidestep
  // that here by writing the tree-builder's input as paths already
  // relative to a virtual workspace folder.

  function fakeEntry(name: string, fsPath: string) {
    return {
      name,
      uri: vscode.Uri.file(fsPath),
      info: {
        name,
        defLineIndex: 0,
        annotations: { props: [] },
        detectedBase: "Frame",
      },
    };
  }

  // Skip in environments without a workspace folder.
  test("groups components by folder when componentsRoot is set", () => {
    // We can't easily fake `vscode.workspace.getWorkspaceFolder` from a
    // test; if no workspace folder is open all entries get dropped at
    // the root. That degenerate behavior is itself worth validating.
    const tree = sidebar.buildFolderTree(
      [
        fakeEntry("Card", "/proj/src/UI/Components/Card.luau"),
        fakeEntry("Modal", "/proj/src/UI/Components/Modals/Modal.luau"),
      ],
      undefined
    );
    // All entries land at root because no workspace folder resolves.
    assert.strictEqual(tree.kind, "folder");
    assert.ok(tree.children.length >= 0);
  });
});

import * as sidebar from "../sidebar";

suite("Scaffold templates produce parseable components", () => {
  test("React template — scanDocument detects component + Frame base", () => {
    const text = _renderTemplate("react", "MyCard");
    const info = scanDocument(text, ALIASES).get("MyCard");
    assert.ok(info, "scanDocument should find MyCard");
    assert.strictEqual(info?.detectedBase, "Frame");
  });

  test("Fusion template — scanDocument detects component + Frame base", () => {
    const text = _renderTemplate("fusion", "MyCard");
    const info = scanDocument(text, {
      parens: [],
      curried: ["New"],
    }).get("MyCard");
    assert.ok(info, "scanDocument should find MyCard");
    assert.strictEqual(info?.detectedBase, "Frame");
  });

  test("Vide template — scanDocument detects component + Frame base", () => {
    const text = _renderTemplate("vide", "MyCard");
    const info = scanDocument(text, {
      parens: [],
      curried: ["create"],
    }).get("MyCard");
    assert.ok(info, "scanDocument should find MyCard");
    assert.strictEqual(info?.detectedBase, "Frame");
  });
});

suite("findEnclosingFactoryStringArg", () => {
  function detectArg(text: string, partition = ALL_PARTITION) {
    const cursor = text.indexOf("|");
    assert.notStrictEqual(cursor, -1);
    const stripped = text.replace("|", "");
    return findEnclosingFactoryStringArg(stripped, cursor, partition);
  }

  test("parens form — partial class name with close paren", () => {
    const r = detectArg(`e("Fr|")`);
    assert.ok(r);
    assert.strictEqual(r?.callShape, "parens");
    assert.strictEqual(r?.alias, "e");
    assert.strictEqual(r?.quote, '"');
    assert.notStrictEqual(r?.stringEnd, -1);
    assert.notStrictEqual(r?.closeParen, -1);
    assert.strictEqual(r?.hasPropsAfter, false);
  });

  test("parens form — single quotes work too", () => {
    const r = detectArg(`e('Fr|')`);
    assert.ok(r);
    assert.strictEqual(r?.quote, "'");
  });

  test("parens form — empty string after open quote", () => {
    const r = detectArg(`e("|")`);
    assert.ok(r);
    assert.strictEqual(r?.callShape, "parens");
  });

  test("parens form — recognizes existing props table", () => {
    const r = detectArg(`e("Fr|", { Size = 1 })`);
    assert.ok(r);
    assert.strictEqual(r?.hasPropsAfter, true);
    assert.strictEqual(r?.closeParen, -1);
  });

  test("parens form — Roact.createElement", () => {
    const r = detectArg(`Roact.createElement("Fr|")`);
    assert.ok(r);
    assert.strictEqual(r?.callShape, "parens");
    assert.strictEqual(r?.alias, "Roact.createElement");
  });

  // Fork's `Vide.create("…")` parens-form string-arg test —
  // the alias lives in both partition buckets so the parens-form
  // detector should match it (and not just the curried form).
  test("parens form — Vide.create", () => {
    const r = detectArg(`Vide.create("Fr|")`);
    assert.ok(r);
    assert.strictEqual(r?.callShape, "parens");
    assert.strictEqual(r?.alias, "Vide.create");
  });

  test("curried form — Fusion New", () => {
    const r = detectArg(`New "Fr|"`);
    assert.ok(r);
    assert.strictEqual(r?.callShape, "curried");
    assert.strictEqual(r?.alias, "New");
    assert.strictEqual(r?.hasPropsAfter, false);
  });

  test("curried form — Vide create with existing props", () => {
    const r = detectArg(`create "Fr|" { Text = "x" }`);
    assert.ok(r);
    assert.strictEqual(r?.callShape, "curried");
    assert.strictEqual(r?.hasPropsAfter, true);
  });

  test("ignores strings outside a factory call", () => {
    const r = detectArg(`print("Fr|")`);
    assert.strictEqual(r, undefined);
  });

  test("ignores prior strings on the same line", () => {
    const r = detectArg(`local x = "hello"; e("Fr|")`);
    assert.ok(r);
    assert.strictEqual(r?.alias, "e");
  });

  test("rejects non-identifier content inside the string", () => {
    const r = detectArg(`e("path/to|")`);
    assert.strictEqual(r, undefined);
  });

  test("ignores cursors inside non-first arguments", () => {
    const r = detectArg(`e("Frame", "Fr|")`);
    assert.strictEqual(r, undefined);
  });

  test("parens form — Luau backtick template string", () => {
    const r = detectArg("e(`Fr|`)");
    assert.ok(r);
    assert.strictEqual(r?.callShape, "parens");
    assert.strictEqual(r?.quote, "`");
  });
});

suite("extractPropEntries", () => {
  test("simple key/value pairs", () => {
    const r = extractPropEntries(
      `Size = UDim2.fromScale(1, 1), Name = "Outer"`
    );
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].key, "Size");
    assert.strictEqual(r[1].key, "Name");
  });

  test("skips computed `[Children] = ...` keys", () => {
    const r = extractPropEntries(`Name = "x", [Children] = {}, Size = 1`);
    const keys = r.map((e) => e.key);
    assert.deepStrictEqual(keys, ["Name", "Size"]);
  });

  test("nested tables don't leak", () => {
    const r = extractPropEntries(
      `Style = { Padding = 4 }, Size = UDim2.new(0, 0, 0, 0)`
    );
    assert.deepStrictEqual(
      r.map((e) => e.key),
      ["Style", "Size"]
    );
  });

  test("trailing comma tolerated", () => {
    const r = extractPropEntries(`Name = "x",`);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].key, "Name");
  });
});

suite("scanDocument — hardcodedProps", () => {
  test("flags props the component assigns to non-`props` values", () => {
    const text = `local function Card(props)
  return e("Frame", {
    Position = UDim2.new(0, 0, 0, 0),
    BackgroundColor3 = props.BackgroundColor3,
    Size = props.Size,
  })
end`;
    const info = scanDocument(text, _internal.DEFAULT_ALIASES).get("Card");
    assert.ok(info);
    assert.ok(info?.hardcodedProps);
    assert.ok(info?.hardcodedProps?.has("Position"));
    assert.ok(!info?.hardcodedProps?.has("BackgroundColor3"));
    assert.ok(!info?.hardcodedProps?.has("Size"));
  });

  test("respects a non-default parameter name", () => {
    const text = `local function Card(p)
  return e("Frame", {
    Position = UDim2.new(0, 0, 0, 0),
    Size = p.Size,
  })
end`;
    const info = scanDocument(text, _internal.DEFAULT_ALIASES).get("Card");
    assert.ok(info?.hardcodedProps?.has("Position"));
    assert.ok(!info?.hardcodedProps?.has("Size"));
  });
});

// ============================================================================
// 1.4.3 — direct component-call detection (Vide / Fusion idiom)
// ============================================================================

suite("Direct component-call detection", () => {
  const KNOWN = new Set(["StylizedButton", "Card", "MyComp"]);

  test("picks up `StylizedButton({ | })` when the name is a known component", () => {
    const text = `StylizedButton({ | })`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      VIDE_PARTITION,
      KNOWN
    );
    assert.strictEqual(result?.className, "StylizedButton");
    assert.strictEqual(result?.callShape, "parens");
    assert.strictEqual(result?.isDirectComponentCall, true);
  });

  test("picks up `StylizedButton { | }` (curried direct call)", () => {
    const text = `StylizedButton { | }`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      VIDE_PARTITION,
      KNOWN
    );
    assert.strictEqual(result?.className, "StylizedButton");
    assert.strictEqual(result?.callShape, "curried");
    assert.strictEqual(result?.isDirectComponentCall, true);
  });

  test("does NOT trigger when the identifier isn't a known component", () => {
    const text = `randomFn({ | })`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      VIDE_PARTITION,
      KNOWN
    );
    assert.strictEqual(result, undefined);
  });

  test("does NOT trigger for a plain `tbl { ... }` Lua function call with unknown name", () => {
    // This is the safety case — without the known-components gate the
    // curried regex would match every `f { ... }` table-call in Lua.
    const text = `task.spawn(function() local t = work { | } end)`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      VIDE_PARTITION,
      KNOWN
    );
    assert.strictEqual(result, undefined);
  });

  test("does NOT trigger when no known-components set is supplied", () => {
    // Back-compat: the old 3-arg signature must keep returning undefined
    // for bare component calls.
    const text = `StylizedButton({ | })`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(stripped, cursor, VIDE_PARTITION);
    assert.strictEqual(result, undefined);
  });

  test("does NOT trigger on method calls like `obj:Card({ | })`", () => {
    const text = `obj:Card({ | })`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      VIDE_PARTITION,
      KNOWN
    );
    assert.strictEqual(result, undefined);
  });

  test("does NOT trigger on qualified accesses like `Mod.Card({ | })`", () => {
    // The `.` exclusion in the regex keeps `Mod.Card(` out — Luix's
    // workspace index keys components by bare name anyway, so the
    // user's component table is always a `require`d local.
    const text = `Mod.Card({ | })`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      VIDE_PARTITION,
      KNOWN
    );
    assert.strictEqual(result, undefined);
  });

  test("framework-mediated calls still take precedence over direct detection", () => {
    // `e(Card, { | })` should match the parens-form alias path first
    // (callShape=parens, alias='e', isDirectComponentCall=undefined),
    // not the direct-call fallback.
    const text = `e(Card, { | })`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      ALL_PARTITION,
      KNOWN
    );
    assert.strictEqual(result?.className, "Card");
    assert.strictEqual(result?.alias, "e");
    assert.strictEqual(result?.callShape, "parens");
    assert.notStrictEqual(result?.isDirectComponentCall, true);
  });

  test("direct call inside an outer e(...) still resolves to the inner component", () => {
    // Mixed framework: React-style outer with a direct-Vide-call inner
    // child. Cursor inside the inner `{ ... }` should resolve to the
    // inner component, not the outer "Frame".
    const text = `e("Frame", {
  StylizedButton({ | }),
})`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      ALL_PARTITION,
      KNOWN
    );
    assert.strictEqual(result?.className, "StylizedButton");
    assert.strictEqual(result?.isDirectComponentCall, true);
  });
});

// ============================================================================
// Direct instance-call detection — Vide's `Frame({...})` shape for built-in
// Roblox classes. Same gate as direct component calls; the parser doesn't
// distinguish, downstream code differentiates by checking `classHierarchy`.
// ============================================================================

suite("Direct instance-call detection (Vide)", () => {
  // Built-in class names that flow through as direct-call targets when
  // `luix.vide.directInstanceCalls` is on. In production these come from
  // `DIRECT_INSTANTIABLE_CLASS_NAMES`; here we hand-roll the same shape.
  const INSTANCES = new Set([
    "Frame",
    "TextLabel",
    "TextButton",
    "ImageButton",
    "ScrollingFrame",
    "UICorner",
    "UIPadding",
  ]);

  test("picks up `Frame({ | })`", () => {
    const text = `Frame({ | })`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      VIDE_PARTITION,
      INSTANCES
    );
    assert.strictEqual(result?.className, "Frame");
    assert.strictEqual(result?.callShape, "parens");
    assert.strictEqual(result?.isDirectComponentCall, true);
  });

  test("picks up `TextButton { | }` (curried instance call)", () => {
    const text = `TextButton { | }`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      VIDE_PARTITION,
      INSTANCES
    );
    assert.strictEqual(result?.className, "TextButton");
    assert.strictEqual(result?.callShape, "curried");
    assert.strictEqual(result?.isDirectComponentCall, true);
  });

  test("does NOT fire on `Camera({ | })` (non-UI class not in the set)", () => {
    // The allowlist is UI-only; non-UI Roblox class names like Camera,
    // Sound, Tween, Workspace are deliberately absent so a local
    // variable with one of those names can't accidentally trigger.
    const text = `Camera({ | })`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      VIDE_PARTITION,
      INSTANCES
    );
    assert.strictEqual(result, undefined);
  });

  test("workspace component shadows a built-in class name in the set", () => {
    // If both `Frame` (workspace component) and `Frame` (built-in class)
    // map into the set, detection still succeeds — downstream picks the
    // workspace component via `findComponent` → `getPropsForClass`. The
    // parser itself is order-agnostic; this test guards the membership
    // check, not the precedence (which is downstream).
    const both = new Set(["Frame", "TextLabel"]);
    const text = `Frame { | }`;
    const cursor = text.indexOf("|");
    const stripped = text.replace("|", "");
    const result = findEnclosingPropsCall(
      stripped,
      cursor,
      VIDE_PARTITION,
      both
    );
    assert.strictEqual(result?.className, "Frame");
    assert.strictEqual(result?.isDirectComponentCall, true);
  });

  test("DIRECT_INSTANTIABLE_CLASS_NAMES excludes abstract bases", () => {
    // Smoke-test the curated allowlist: concrete UI classes present,
    // abstract bases absent.
    const { DIRECT_INSTANTIABLE_CLASS_NAMES } = require("../data");
    const set: ReadonlySet<string> = DIRECT_INSTANTIABLE_CLASS_NAMES;
    // Concrete — should be there.
    assert.ok(set.has("Frame"));
    assert.ok(set.has("TextLabel"));
    assert.ok(set.has("ScrollingFrame"));
    assert.ok(set.has("UIPadding"));
    assert.ok(set.has("UICorner"));
    // Abstract — should NOT be there.
    assert.ok(!set.has("Instance"));
    assert.ok(!set.has("GuiBase2d"));
    assert.ok(!set.has("GuiObject"));
    assert.ok(!set.has("GuiButton"));
    assert.ok(!set.has("UILayout"));
    // Non-UI — should NOT be there (defensive; Luix's classHierarchy
    // doesn't model them anyway).
    assert.ok(!set.has("Camera"));
    assert.ok(!set.has("Sound"));
    assert.ok(!set.has("Tween"));
    assert.ok(!set.has("Workspace"));
  });
});

// ============================================================================
// 1.5.0 — Active-framework detection (per-file framework discovery)
// ============================================================================
//
// Drives the snippet- and completion-gating system that lets a Vide
// file surface only Vide snippets, a React file only React, etc.
// Detector lives in `src/activeFramework.ts`; we test the pure
// text-only helpers (require + factory-call scanning) since they're
// the meaningful logic — override precedence is a one-line config
// read and workspace fallback is a setter/getter pair.

import { _internal as activeFrameworkInternal } from "../activeFramework";

suite("activeFramework — detectFromRequires (1.5.0)", () => {
  const { detectFromRequires } = activeFrameworkInternal;

  test("require(...Packages.React) → react", () => {
    const text =
      `local React = require(ReplicatedStorage.Packages.React)\n` +
      `local e = React.createElement\n`;
    assert.strictEqual(detectFromRequires(text), "react");
  });

  test("require(...Packages.Roact) → roact (wins over react substring)", () => {
    // "Roact" contains "react" as a substring; the priority order in
    // detectFromRequires checks Roact first so the more-specific match
    // wins. Regression guard: if someone swaps the test order, a Roact
    // file would mis-detect as React and surface the wrong snippets.
    const text =
      `local Roact = require(ReplicatedStorage.Packages.Roact)\n` +
      `local e = Roact.createElement\n`;
    assert.strictEqual(detectFromRequires(text), "roact");
  });

  test("require(...vide) → vide", () => {
    const text =
      `local vide = require(ReplicatedStorage.Packages.vide)\n` +
      `local create = vide.create\n`;
    assert.strictEqual(detectFromRequires(text), "vide");
  });

  test("require(...Fusion) → fusion", () => {
    const text =
      `local Fusion = require(ReplicatedStorage.Packages.Fusion)\n` +
      `local New = Fusion.New\n`;
    assert.strictEqual(detectFromRequires(text), "fusion");
  });

  test("no require → undefined", () => {
    // A file with no require at all should fall through; the calls
    // path then takes over upstream of this helper.
    const text = `local x = 1\nlocal y = 2\n`;
    assert.strictEqual(detectFromRequires(text), undefined);
  });

  test("require inside a string literal still matches the regex (acceptable)", () => {
    // The detection regex is intentionally permissive — it matches
    // `require(... <name> ...)` shape anywhere in the file, including
    // inside strings. The cost of stricter parsing isn't worth it
    // (false positives here mean "we picked a framework for a file
    // that wasn't really using one", which is the same effective
    // behaviour as the workspace fallback). This test pins the
    // current behaviour so we notice if it ever changes.
    const text = `local s = "require(Packages.Vide)"\n`;
    assert.strictEqual(detectFromRequires(text), "vide");
  });
});

suite("activeFramework — detectFromCalls (1.5.0)", () => {
  const { detectFromCalls } = activeFrameworkInternal;

  // detectFromCalls relies on the real getAliasPartition(), which
  // reads `luix.frameworks` from the workspace configuration. In the
  // test extension host that defaults to all four frameworks
  // enabled, so all aliases (`e`, `New`, `create`, `Vide.create`,
  // `Roact.createElement`, …) participate.

  test("e(\"Frame\", { … }) → react (factory-call fallback)", () => {
    const text = `local x = e("Frame", { Name = "A" })`;
    const fw = detectFromCalls(text);
    assert.strictEqual(fw, "react");
  });

  test("New \"Frame\" { … } → fusion", () => {
    const text = `local x = New "Frame" { Name = "A" }`;
    const fw = detectFromCalls(text);
    assert.strictEqual(fw, "fusion");
  });

  test("Vide.create(\"Frame\", { … }) → vide (fork's parens form)", () => {
    // Forks the same alias added in 1.5.0 — guards that the
    // detection's call-fallback path sees the parens-form alias
    // alongside its curried twin.
    const text = `local x = Vide.create("Frame", { Name = "A" })`;
    const fw = detectFromCalls(text);
    assert.strictEqual(fw, "vide");
  });

  test("Roact.createElement(\"Frame\", { … }) → roact", () => {
    const text = `local x = Roact.createElement("Frame", { Name = "A" })`;
    const fw = detectFromCalls(text);
    assert.strictEqual(fw, "roact");
  });

  test("no factory call → undefined", () => {
    const text = `local x = 1\nlocal function foo() return 42 end\n`;
    assert.strictEqual(detectFromCalls(text), undefined);
  });
});

// ============================================================================
// 1.5.0 — Computed-key fast-path regexes (React / Roact / Fusion)
// ============================================================================
//
// 1.4.x's fast-path was React-only (`[React.Event.X]`). 1.5.0 extends
// it to Roact (same shape, different prefix) and adds Fusion's
// quoted-string shapes (`[OnEvent "X"]`, `[OnChange "X"]`, `[Out "X"]`).
// Tests below pin each regex shape so a refactor can't quietly drop
// a framework's support.

import { _internal as completionInternal } from "../completion";

suite("Computed-key fast-paths (1.5.0)", () => {
  const fp = completionInternal.COMPUTED_KEY_FAST_PATHS;

  test("React: [React.Event.A → matches reactEvent", () => {
    assert.ok(fp.reactEvent.exec("[React.Event.A"));
    assert.ok(fp.reactEvent.exec("  [ React.Event.MouseEnter"));
  });

  test("Roact: [Roact.Event.A → matches roactEvent (1.5 — separate from React)", () => {
    // 1.5.0 review: React and Roact get separate regexes so the
    // active-framework gate downstream can suppress the Roact shape
    // in React files and vice versa. Previously a single merged
    // `(?:React|Roact)` regex matched both, which leaked Roact
    // suggestions into React files when typing `[Roact.Event.…`.
    assert.ok(fp.roactEvent.exec("[Roact.Event.Activated"));
    assert.ok(fp.roactEvent.exec("[Roact.Event."));
    // Cross-framework non-match: reactEvent must NOT swallow Roact.
    assert.strictEqual(fp.reactEvent.exec("[Roact.Event.A"), null);
    assert.strictEqual(fp.roactEvent.exec("[React.Event.A"), null);
  });

  test("Roact: [Roact.Change.A → matches roactChange (1.5 — separate from React)", () => {
    assert.ok(fp.roactChange.exec("[Roact.Change.BackgroundColor3"));
    assert.ok(fp.roactChange.exec("[Roact.Change."));
    assert.strictEqual(fp.reactChange.exec("[Roact.Change.A"), null);
    assert.strictEqual(fp.roactChange.exec("[React.Change.A"), null);
  });

  test("Fusion: [OnEvent \" → matches fusionEvent", () => {
    assert.ok(fp.fusionEvent.exec(`[OnEvent "`));
    assert.ok(fp.fusionEvent.exec(`  [ OnEvent "Activated`));
  });

  test("Fusion: [OnChange \" → matches fusionChange", () => {
    assert.ok(fp.fusionChange.exec(`[OnChange "`));
    assert.ok(fp.fusionChange.exec(`[OnChange "Text`));
  });

  test("Fusion: [Out \" → matches fusionOut", () => {
    assert.ok(fp.fusionOut.exec(`[Out "`));
    assert.ok(fp.fusionOut.exec(`[Out "Text`));
  });

  test("non-matching shapes do not match", () => {
    // Plain text, no `[`, mid-identifier, wrong framework name, etc.
    assert.strictEqual(fp.reactEvent.exec("React.Event.A"), null);
    assert.strictEqual(fp.reactEvent.exec("[Vide.Event.A"), null);
    assert.strictEqual(fp.roactEvent.exec("[Vide.Event.A"), null);
    assert.strictEqual(fp.fusionEvent.exec(`OnEvent "A`), null);
    assert.strictEqual(fp.fusionEvent.exec(`[OnChange "A`), null);
    assert.strictEqual(fp.fusionOut.exec(`[OnEvent "A`), null);
  });
});

// ============================================================================
// 1.5.0 — Snippet-bag smoke tests
// ============================================================================
//
// Every framework's element / scaffold / event / state snippets are
// gated to that framework via `snip.framework === active`. The smoke
// tests below assert the bag is populated for each (id, kind) pair —
// catches accidental deletion / mis-gating of an entire bag in one
// shot, instead of waiting for the user to notice an absent snippet.

import { _internal as snippetsInternal } from "../elementSnippets";

suite("Snippet-bag parity (1.5.0)", () => {
  const SNIPPETS = snippetsInternal.SNIPPETS;
  const ELEMENT_BASELINE = [
    "Frame",
    "ScrollingFrame",
    "TextLabel",
    "TextButton",
    "ImageLabel",
    "ImageButton",
    "UIListLayout",
    "UIGridLayout",
    "UIPadding",
    "UICorner",
    "UIStroke",
  ];

  function byKindAndFramework(
    kind: string,
    framework: string
  ): readonly { prefix: string }[] {
    return SNIPPETS.filter(
      (s) => s.kind === kind && s.framework === framework
    );
  }

  function elementClassNames(framework: string): string[] {
    // Each element snippet's prefix is `<letter><ClassName>` — `e` for
    // React, `r` for Roact, `n` for Fusion, `c` for Vide. Strip the
    // single-letter framework marker to recover the class name.
    return byKindAndFramework("element", framework).map((s) =>
      s.prefix.replace(/^[a-z]/, "")
    );
  }

  test("React element snippets cover the 11-class baseline", () => {
    const classes = elementClassNames("react");
    for (const cls of ELEMENT_BASELINE) {
      assert.ok(classes.includes(cls), `missing eReact snippet for ${cls}`);
    }
  });

  test("Roact element snippets cover the 11-class baseline (1.5.0 new)", () => {
    const classes = elementClassNames("roact");
    for (const cls of ELEMENT_BASELINE) {
      assert.ok(classes.includes(cls), `missing rRoact snippet for ${cls}`);
    }
  });

  test("Fusion element snippets cover the 11-class baseline (1.5.0 expanded)", () => {
    const classes = elementClassNames("fusion");
    for (const cls of ELEMENT_BASELINE) {
      assert.ok(classes.includes(cls), `missing nFusion snippet for ${cls}`);
    }
  });

  test("Vide element snippets cover the 11-class baseline (1.5.0 expanded)", () => {
    const classes = elementClassNames("vide");
    for (const cls of ELEMENT_BASELINE) {
      assert.ok(classes.includes(cls), `missing cVide snippet for ${cls}`);
    }
  });

  test("Per-framework scaffolds — rfc / rofc / nfc / vfc (1.5.0 new)", () => {
    const scaffolds = SNIPPETS.filter((s) => s.kind === "scaffold");
    const prefixToFw = new Map(scaffolds.map((s) => [s.prefix, s.framework]));
    assert.strictEqual(prefixToFw.get("rfc"), "react");
    assert.strictEqual(prefixToFw.get("rofc"), "roact");
    assert.strictEqual(prefixToFw.get("nfc"), "fusion");
    assert.strictEqual(prefixToFw.get("vfc"), "vide");
  });

  test("Per-framework event shorthands — reactEvent / roactEvent / onEvent / videEvent (1.5.0 new)", () => {
    const events = SNIPPETS.filter((s) => s.kind === "event");
    const prefixToFw = new Map(events.map((s) => [s.prefix, s.framework]));
    assert.strictEqual(prefixToFw.get("reactEvent"), "react");
    assert.strictEqual(prefixToFw.get("roactEvent"), "roact");
    assert.strictEqual(prefixToFw.get("onEvent"), "fusion");
    assert.strictEqual(prefixToFw.get("videEvent"), "vide");
  });

  test("Fusion state primitives — Value / Computed / Spring / Tween / Observer / For* (1.5.0 new)", () => {
    const fusionState = byKindAndFramework("state", "fusion").map(
      (s) => s.prefix
    );
    for (const prefix of [
      "value",
      "computed",
      "spring",
      "tween",
      "observer",
      "forKeys",
      "forValues",
      "forPairs",
    ]) {
      assert.ok(
        fusionState.includes(prefix),
        `missing Fusion state snippet: ${prefix}`
      );
    }
  });

  test("Vide state primitives — source / derive / effect / cleanup / etc. (1.5.0 new)", () => {
    const videState = byKindAndFramework("state", "vide").map((s) => s.prefix);
    for (const prefix of [
      "source",
      "derive",
      "effect",
      "cleanup",
      "untrack",
      "batch",
      "show",
      "switch",
      "indexes",
      "values",
    ]) {
      assert.ok(
        videState.includes(prefix),
        `missing Vide state snippet: ${prefix}`
      );
    }
  });

  test("Every framework-tagged snippet sits in one of the four frameworks", () => {
    // Sanity check: no typos like "react " or "Fusion" sneaking in.
    const valid = new Set(["react", "roact", "fusion", "vide"]);
    for (const s of SNIPPETS) {
      if (s.framework !== undefined) {
        assert.ok(
          valid.has(s.framework),
          `snippet ${s.prefix} has invalid framework: ${s.framework}`
        );
      }
    }
  });
});

// ============================================================================
// 1.5.1 — Roblox content-URL autocomplete (rbxthumb:// + rbxasset://)
// ============================================================================

import {
  RBXTHUMB_TYPES,
  getRbxThumbType,
  parseRbxThumb,
  validateRbxThumb,
  getEnclosingString,
  computeRbxAssetChildren,
  _internal as contentInternal,
} from "../robloxContent";

suite("rbxthumb type table (1.5.1)", () => {
  test("every type's sizes are square-able (used as a single w=h choice)", () => {
    // The completion mirrors one size choice into both w and h, which
    // is only valid because every documented size is square. This test
    // pins that invariant: each entry must have >=1 size and they must
    // be positive integers.
    for (const t of RBXTHUMB_TYPES) {
      assert.ok(t.sizes.length > 0, `${t.type} has no sizes`);
      for (const s of t.sizes) {
        assert.ok(Number.isInteger(s) && s > 0, `${t.type} bad size ${s}`);
      }
    }
  });

  test("types are unique and lookup works", () => {
    const seen = new Set<string>();
    for (const t of RBXTHUMB_TYPES) {
      assert.ok(!seen.has(t.type), `duplicate type ${t.type}`);
      seen.add(t.type);
      assert.strictEqual(getRbxThumbType(t.type), t);
    }
    assert.strictEqual(getRbxThumbType("NopeNotAType"), undefined);
  });

  test("AvatarHeadShot supports circular; others don't", () => {
    assert.strictEqual(getRbxThumbType("AvatarHeadShot")?.circular, true);
    assert.notStrictEqual(getRbxThumbType("GameIcon")?.circular, true);
  });

  test("known sizes match the documented set (spot-check)", () => {
    assert.deepStrictEqual(getRbxThumbType("AvatarHeadShot")?.sizes, [48, 60, 150]);
    assert.deepStrictEqual(getRbxThumbType("GameIcon")?.sizes, [50, 150]);
    assert.deepStrictEqual(getRbxThumbType("BadgeIcon")?.sizes, [150]);
    assert.deepStrictEqual(getRbxThumbType("Outfit")?.sizes, [150, 420]);
  });
});

suite("parseRbxThumb (1.5.1)", () => {
  test("parses a full URL", () => {
    const p = parseRbxThumb(
      "rbxthumb://type=AvatarHeadShot&id=2685270261&w=150&h=150"
    );
    assert.ok(p);
    assert.strictEqual(p?.type, "AvatarHeadShot");
    assert.strictEqual(p?.id, "2685270261");
    assert.strictEqual(p?.w, "150");
    assert.strictEqual(p?.h, "150");
  });

  test("parses filters=circular", () => {
    const p = parseRbxThumb(
      "rbxthumb://type=AvatarHeadShot&id=1&w=150&h=150&filters=circular"
    );
    assert.strictEqual(p?.filters, "circular");
  });

  test("tolerates partial input (mid-typing)", () => {
    const p = parseRbxThumb("rbxthumb://type=Game");
    assert.strictEqual(p?.type, "Game");
    assert.strictEqual(p?.w, undefined);
  });

  test("returns undefined for non-rbxthumb strings", () => {
    assert.strictEqual(parseRbxThumb("rbxassetid://123"), undefined);
    assert.strictEqual(parseRbxThumb("just text"), undefined);
  });
});

suite("validateRbxThumb (1.5.1)", () => {
  test("a fully valid URL has no problems", () => {
    const p = parseRbxThumb("rbxthumb://type=GameIcon&id=1&w=150&h=150")!;
    assert.deepStrictEqual(validateRbxThumb(p), []);
  });

  test("flags an unsupported size for the type", () => {
    const p = parseRbxThumb("rbxthumb://type=AvatarHeadShot&id=1&w=200&h=200")!;
    const probs = validateRbxThumb(p);
    assert.strictEqual(probs.length, 1);
    assert.strictEqual(probs[0].kind, "bad-size");
    assert.ok(/doesn't support 200/.test(probs[0].message));
  });

  test("flags a valid size for a DIFFERENT type (per-type gating)", () => {
    // 420 is valid for Outfit but not for AvatarHeadShot — the whole
    // point of per-type sizing.
    const ok = validateRbxThumb(
      parseRbxThumb("rbxthumb://type=Outfit&id=1&w=420&h=420")!
    );
    assert.deepStrictEqual(ok, []);
    const bad = validateRbxThumb(
      parseRbxThumb("rbxthumb://type=AvatarHeadShot&id=1&w=420&h=420")!
    );
    assert.strictEqual(bad.some((p) => p.kind === "bad-size"), true);
  });

  test("flags non-square sizes", () => {
    const p = parseRbxThumb("rbxthumb://type=GameIcon&id=1&w=150&h=50")!;
    assert.strictEqual(validateRbxThumb(p).some((x) => x.kind === "bad-size"), true);
  });

  test("flags an unknown type", () => {
    const p = parseRbxThumb("rbxthumb://type=Bogus&id=1&w=150&h=150")!;
    const probs = validateRbxThumb(p);
    assert.strictEqual(probs[0].kind, "unknown-type");
  });

  test("flags an unknown filter and circular-on-wrong-type", () => {
    const badFilter = validateRbxThumb(
      parseRbxThumb("rbxthumb://type=GameIcon&id=1&w=150&h=150&filters=square")!
    );
    assert.strictEqual(badFilter.some((p) => p.kind === "bad-filter"), true);
    const circularWrong = validateRbxThumb(
      parseRbxThumb("rbxthumb://type=GameIcon&id=1&w=150&h=150&filters=circular")!
    );
    assert.strictEqual(circularWrong.some((p) => p.kind === "bad-filter"), true);
  });

  test("missing size / type are flagged but as the low-signal kinds", () => {
    // The diagnostic filters these out (they fire while typing); make
    // sure they're tagged so that filter works.
    const missingSize = validateRbxThumb(
      parseRbxThumb("rbxthumb://type=GameIcon&id=1")!
    );
    assert.strictEqual(missingSize[0].kind, "missing-size");
    const missingType = validateRbxThumb(parseRbxThumb("rbxthumb://")!);
    assert.strictEqual(missingType[0].kind, "missing-type");
  });
});

suite("getEnclosingString (1.5.1)", () => {
  function at(text: string): ReturnType<typeof getEnclosingString> {
    const offset = text.indexOf("|");
    const stripped = text.replace("|", "");
    return getEnclosingString(stripped, offset);
  }

  test("detects inside a double-quoted string", () => {
    const enc = at(`local x = "rbxthumb://type=|"`);
    assert.ok(enc);
    assert.strictEqual(enc?.quote, '"');
  });

  test("detects inside single-quoted and backtick strings", () => {
    assert.strictEqual(at(`local x = 'rbxasset://text|'`)?.quote, "'");
    assert.strictEqual(at("local x = `rbxasset://text|`")?.quote, "`");
  });

  test("returns undefined outside any string", () => {
    assert.strictEqual(at(`local x = foo(|)`), undefined);
  });

  test("innerStart points at the first char inside the quotes", () => {
    const text = `e("ImageLabel", { Image = "rbxthumb://t|" })`;
    const offset = text.indexOf("|");
    const stripped = text.replace("|", "");
    const enc = getEnclosingString(stripped, offset);
    assert.ok(enc);
    // The slice from innerStart should begin with the URL.
    assert.ok(stripped.slice(enc!.innerStart).startsWith("rbxthumb://"));
  });
});

suite("rbxthumb diagnostic scan regex (1.5.1)", () => {
  test("matches a complete URL and stops at the closing quote", () => {
    const re = contentInternal.RBXTHUMB_SCAN_RE;
    re.lastIndex = 0;
    const text = `Image = "rbxthumb://type=GameIcon&id=1&w=150&h=150",`;
    const m = re.exec(text);
    assert.ok(m);
    assert.strictEqual(m![0], "rbxthumb://type=GameIcon&id=1&w=150&h=150");
  });
});

suite("deprecated-but-valid props — Font (1.5.1)", () => {
  const { isDeprecatedValidProp } = require("../data");

  test("Font is a deprecated-but-valid prop on text classes", () => {
    // Issue #2: `Font = …` on a TextLabel was wrongly flagged "Unknown
    // property". It's deprecated (in favour of FontFace) but valid.
    assert.strictEqual(isDeprecatedValidProp("TextLabel", "Font"), true);
    assert.strictEqual(isDeprecatedValidProp("TextButton", "Font"), true);
    assert.strictEqual(isDeprecatedValidProp("TextBox", "Font"), true);
  });

  test("Font is NOT valid on non-text classes (still flagged there)", () => {
    // A Frame genuinely has no Font property — keep flagging that.
    assert.strictEqual(isDeprecatedValidProp("Frame", "Font"), false);
    assert.strictEqual(isDeprecatedValidProp("ImageLabel", "Font"), false);
  });

  test("real props aren't reported as deprecated-valid", () => {
    assert.strictEqual(isDeprecatedValidProp("TextLabel", "Text"), false);
    assert.strictEqual(isDeprecatedValidProp("TextLabel", "FontFace"), false);
  });

  test("Font stays OUT of the suggestion list (valid ≠ suggested)", () => {
    // The whole point of keeping Font in a separate set: it's accepted
    // by the validator but must not be offered in completion, so users
    // are still nudged toward FontFace.
    assert.ok(!_testing.flattenClassProps("TextLabel").includes("Font"));
    assert.ok(_testing.flattenClassProps("TextLabel").includes("FontFace"));
  });
});

suite("auto-import gating — shouldInsertAutoImport (1.5.1)", () => {
  const { shouldInsertAutoImport } = require("../completion");
  const empty = new Set<string>();

  test("does NOT auto-import when the setting is disabled (the bug)", () => {
    // The reported bug: disabling `luix.autoImport.enabled` left the
    // completion-time require insertion firing anyway.
    assert.strictEqual(
      shouldInsertAutoImport(false, "GameCard", empty, empty),
      false
    );
  });

  test("auto-imports when enabled and the component isn't already known", () => {
    assert.strictEqual(
      shouldInsertAutoImport(true, "GameCard", empty, empty),
      true
    );
  });

  test("skips when already required, even if enabled", () => {
    assert.strictEqual(
      shouldInsertAutoImport(true, "GameCard", new Set(["GameCard"]), empty),
      false
    );
  });

  test("skips when declared in the same file, even if enabled", () => {
    assert.strictEqual(
      shouldInsertAutoImport(true, "GameCard", empty, new Set(["GameCard"])),
      false
    );
  });
});

suite("rbxasset folder navigation — computeRbxAssetChildren (1.5.1)", () => {
  const FILES = [
    "textures/ui/common/robux_color.png",
    "textures/ui/common/premium.png",
    "textures/ui/button.png",
    "textures/face.png",
    "fonts/SourceSans.json",
    "sounds/click.ogg",
  ];

  test("top level lists distinct first-segment folders + files", () => {
    const children = computeRbxAssetChildren(FILES, "");
    // Folders first (alpha), then files.
    assert.deepStrictEqual(children, [
      { name: "fonts", isFolder: true },
      { name: "sounds", isFolder: true },
      { name: "textures", isFolder: true },
    ]);
  });

  test("drilling into textures/ shows its immediate children only", () => {
    const children = computeRbxAssetChildren(FILES, "textures/");
    assert.deepStrictEqual(children, [
      { name: "ui", isFolder: true },
      { name: "face.png", isFolder: false },
    ]);
  });

  test("a leaf folder lists files, no full paths", () => {
    const children = computeRbxAssetChildren(FILES, "textures/ui/common/");
    assert.deepStrictEqual(children, [
      { name: "premium.png", isFolder: false },
      { name: "robux_color.png", isFolder: false },
    ]);
    // None of the entries leak the parent path.
    assert.ok(children.every((c) => !c.name.includes("/")));
  });

  test("a directory that mixes a folder and files orders folders first", () => {
    const children = computeRbxAssetChildren(FILES, "textures/");
    assert.strictEqual(children[0].isFolder, true);
    assert.strictEqual(children[0].name, "ui");
  });

  test("unknown prefix yields nothing", () => {
    assert.deepStrictEqual(computeRbxAssetChildren(FILES, "nope/"), []);
  });
});

// ============================================================================
// 1.5.1 — UICorner: CornerRadius vs individual radii (diagnostic + refactors)
// ============================================================================

import { cornerRadiusConflicts } from "../data";
import { planUICornerRefactor } from "../uiCorner";

suite("UICorner conflict detection — cornerRadiusConflicts (1.5.1)", () => {
  test("flags individual radii overridden by a co-present CornerRadius", () => {
    const conflicts = cornerRadiusConflicts([
      "CornerRadius",
      "BottomLeftRadius",
      "TopRightRadius",
    ]);
    assert.deepStrictEqual(conflicts.sort(), [
      "BottomLeftRadius",
      "TopRightRadius",
    ]);
  });

  test("no CornerRadius → no conflict (individual radii are fine alone)", () => {
    assert.deepStrictEqual(
      cornerRadiusConflicts([
        "BottomLeftRadius",
        "BottomRightRadius",
        "TopLeftRadius",
        "TopRightRadius",
      ]),
      []
    );
  });

  test("CornerRadius alone → no conflict", () => {
    assert.deepStrictEqual(cornerRadiusConflicts(["CornerRadius"]), []);
  });

  test("all four overridden when all present with CornerRadius", () => {
    const conflicts = cornerRadiusConflicts([
      "CornerRadius",
      "BottomLeftRadius",
      "BottomRightRadius",
      "TopLeftRadius",
      "TopRightRadius",
    ]);
    assert.strictEqual(conflicts.length, 4);
  });
});

suite("UICorner refactor planning — planUICornerRefactor (1.5.1)", () => {
  const r = (key: string, valueText: string) => ({ key, valueText });
  const FOUR_EQUAL = [
    r("BottomLeftRadius", "UDim.new(0, 4)"),
    r("BottomRightRadius", "UDim.new(0, 4)"),
    r("TopLeftRadius", "UDim.new(0, 4)"),
    r("TopRightRadius", "UDim.new(0, 4)"),
  ];

  test("collapse: four equal individual radii, no CornerRadius", () => {
    const plan = planUICornerRefactor(FOUR_EQUAL);
    assert.deepStrictEqual(plan, {
      kind: "collapse",
      value: "UDim.new(0, 4)",
    });
  });

  test("collapse tolerates whitespace differences (trimmed compare)", () => {
    const plan = planUICornerRefactor([
      r("BottomLeftRadius", "  UDim.new(0, 4) "),
      r("BottomRightRadius", "UDim.new(0, 4)"),
      r("TopLeftRadius", "UDim.new(0, 4)"),
      r("TopRightRadius", "UDim.new(0, 4)"),
    ]);
    assert.strictEqual(plan?.kind, "collapse");
  });

  test("no collapse when the four values differ", () => {
    const plan = planUICornerRefactor([
      r("BottomLeftRadius", "UDim.new(0, 4)"),
      r("BottomRightRadius", "UDim.new(0, 8)"),
      r("TopLeftRadius", "UDim.new(0, 4)"),
      r("TopRightRadius", "UDim.new(0, 4)"),
    ]);
    assert.strictEqual(plan, undefined);
  });

  test("no collapse when only some corners are present", () => {
    assert.strictEqual(
      planUICornerRefactor([
        r("BottomLeftRadius", "UDim.new(0, 4)"),
        r("TopRightRadius", "UDim.new(0, 4)"),
      ]),
      undefined
    );
  });

  test("expand: lone CornerRadius → individual radii", () => {
    const plan = planUICornerRefactor([r("CornerRadius", "UDim.new(0, 8)")]);
    assert.deepStrictEqual(plan, { kind: "expand", value: "UDim.new(0, 8)" });
  });

  test("conflict (both forms present) → no refactor offered", () => {
    // The diagnostic handles the conflict; neither collapse nor expand
    // makes sense, so the lightbulb stays quiet.
    const plan = planUICornerRefactor([
      r("CornerRadius", "UDim.new(0, 4)"),
      ...FOUR_EQUAL,
    ]);
    assert.strictEqual(plan, undefined);
  });

  test("no collapse when an extra non-corner prop is present", () => {
    // entries.length must be exactly 4 so the collapse span is
    // unambiguous (UICorner carries no other props in practice).
    const plan = planUICornerRefactor([...FOUR_EQUAL, r("Name", '"x"')]);
    assert.strictEqual(plan, undefined);
  });

  test("no refactor for an empty value", () => {
    assert.strictEqual(
      planUICornerRefactor([r("CornerRadius", "")]),
      undefined
    );
  });
});

// ============================================================================
// 1.5.1 — UIShadow class support
// ============================================================================

suite("UIShadow class support (1.5.1)", () => {
  const { getPropType, DIRECT_INSTANTIABLE_CLASS_NAMES, defaultPropsMap } =
    require("../data");

  test("UIShadow exposes its own props (plus Instance's Name/Archivable)", () => {
    const props = _testing.flattenClassProps("UIShadow");
    for (const p of [
      "BlurRadius",
      "Color",
      "Offset",
      "Spread",
      "Transparency",
      "ZIndex",
      "Enabled",
    ]) {
      assert.ok(props.includes(p), `UIShadow missing prop ${p}`);
    }
    // Inherited from Instance.
    assert.ok(props.includes("Name"));
    assert.ok(props.includes("Archivable"));
  });

  test("UIShadow prop types resolve correctly (incl. the Offset override)", () => {
    // Offset is globally Vector2 — on UIShadow it must be UDim2.
    assert.strictEqual(getPropType("UIShadow", "Offset"), "UDim2");
    assert.strictEqual(getPropType("UIShadow", "Spread"), "UDim2");
    assert.strictEqual(getPropType("UIShadow", "BlurRadius"), "UDim");
    assert.strictEqual(getPropType("UIShadow", "Color"), "Color3");
    assert.strictEqual(getPropType("UIShadow", "Transparency"), "number");
    // These resolve from the global PROP_TYPES (no override needed).
    assert.strictEqual(getPropType("UIShadow", "ZIndex"), "number");
    assert.strictEqual(getPropType("UIShadow", "Enabled"), "boolean");
  });

  test("a plain Vector2 Offset elsewhere is unaffected by the override", () => {
    // UIGradient.Offset is Vector2 — make sure the UIShadow override
    // didn't leak across classes.
    assert.strictEqual(getPropType("UIGradient", "Offset"), "Vector2");
  });

  test("UIShadow is in the validation set (so its props aren't 'unknown')", () => {
    assert.ok(Array.isArray(defaultPropsMap["UIShadow"]));
    assert.ok(defaultPropsMap["UIShadow"].includes("BlurRadius"));
  });

  test("UIShadow is directly instantiable (Vide `UIShadow({ … })`)", () => {
    const set: ReadonlySet<string> = DIRECT_INSTANTIABLE_CLASS_NAMES;
    assert.ok(set.has("UIShadow"));
  });
});

// ============================================================================
// 1.5.1 — Font deprecation broadened to all value forms
// ============================================================================

import { extractDeprecatedFontEnum } from "../codeActions";

suite("Font deprecation auto-fix gating — extractDeprecatedFontEnum (1.5.1)", () => {
  test("extracts the enum name from the Enum.Font.X form", () => {
    assert.strictEqual(
      extractDeprecatedFontEnum("Font = Enum.Font.GothamBold"),
      "GothamBold"
    );
    assert.strictEqual(
      extractDeprecatedFontEnum("Font  =  Enum.Font.SourceSans"),
      "SourceSans"
    );
  });

  test("returns undefined for the string form (no value-destroying fix)", () => {
    // `Font = "Gotham"` still WARNS (deprecated), but offers no
    // auto-convert — we won't silently swap the value for a default.
    assert.strictEqual(extractDeprecatedFontEnum('Font = "Gotham"'), undefined);
  });

  test("returns undefined for a variable / non-literal value", () => {
    assert.strictEqual(
      extractDeprecatedFontEnum("Font = UIConf.BoldFont"),
      undefined
    );
  });

  test("Font is still a deprecated-valid prop on text classes (warns, not 'unknown')", () => {
    // The broadened warning relies on this: any `Font` on a text class
    // is flagged deprecated, never 'unknown property'.
    const { isDeprecatedValidProp } = require("../data");
    assert.strictEqual(isDeprecatedValidProp("TextLabel", "Font"), true);
    assert.strictEqual(isDeprecatedValidProp("Frame", "Font"), false);
  });
});

suite("UIShadow element snippets (1.5.1)", () => {
  const SNIPPETS = snippetsInternal.SNIPPETS;
  test("all four frameworks have a UIShadow element snippet", () => {
    const expected: Record<string, string> = {
      eUIShadow: "react",
      nUIShadow: "fusion",
      cUIShadow: "vide",
      rUIShadow: "roact",
    };
    for (const [prefix, fw] of Object.entries(expected)) {
      const snip = SNIPPETS.find((s) => s.prefix === prefix);
      assert.ok(snip, `missing ${prefix}`);
      assert.strictEqual(snip!.kind, "element");
      assert.strictEqual(snip!.framework, fw);
      // Body should construct a UIShadow with the offset/blur props.
      const body = snip!.body.join("\n");
      assert.ok(body.includes("UIShadow"));
      assert.ok(body.includes("BlurRadius"));
    }
  });
});

// ============================================================================
// 1.5.1 — UICorner hover preview with individual radii
// ============================================================================

import { cornerRadiiFromProps, roundedRectPath } from "../hoverPreviews";

suite("UICorner preview corner resolution — cornerRadiiFromProps (1.5.1)", () => {
  const m = (entries: [string, string][]) => new Map(entries);

  test("CornerRadius sets all four corners uniformly", () => {
    const r = cornerRadiiFromProps(m([["CornerRadius", "UDim.new(0, 12)"]]));
    assert.deepStrictEqual(r, {
      tl: 12,
      tr: 12,
      br: 12,
      bl: 12,
      fromCornerRadius: true,
    });
  });

  test("individual radii map to their own corners", () => {
    const r = cornerRadiiFromProps(
      m([
        ["TopLeftRadius", "UDim.new(0, 4)"],
        ["TopRightRadius", "UDim.new(0, 8)"],
        ["BottomRightRadius", "UDim.new(0, 16)"],
        ["BottomLeftRadius", "UDim.new(0, 2)"],
      ])
    );
    assert.deepStrictEqual(r, {
      tl: 4,
      tr: 8,
      br: 16,
      bl: 2,
      fromCornerRadius: false,
    });
  });

  test("CornerRadius overrides individual radii (matches runtime)", () => {
    const r = cornerRadiiFromProps(
      m([
        ["CornerRadius", "UDim.new(0, 10)"],
        ["TopLeftRadius", "UDim.new(0, 99)"],
      ])
    );
    assert.strictEqual(r.tl, 10);
    assert.strictEqual(r.fromCornerRadius, true);
  });

  test("missing radii default to 0 (sharp corners)", () => {
    const r = cornerRadiiFromProps(m([["TopLeftRadius", "UDim.new(0, 6)"]]));
    assert.deepStrictEqual(r, {
      tl: 6,
      tr: 0,
      br: 0,
      bl: 0,
      fromCornerRadius: false,
    });
  });
});

suite("UICorner preview path — roundedRectPath (1.5.1)", () => {
  test("emits an arc for each non-zero corner, none for zero", () => {
    // Only TL + BR rounded → exactly two arc commands.
    const path = roundedRectPath(0, 0, 100, 60, 8, 0, 8, 0);
    const arcs = (path.match(/A /g) ?? []).length;
    assert.strictEqual(arcs, 2);
  });

  test("a fully sharp rect has no arcs", () => {
    const path = roundedRectPath(0, 0, 100, 60, 0, 0, 0, 0);
    assert.ok(!path.includes("A "));
    assert.ok(path.startsWith("M ") && path.trim().endsWith("Z"));
  });

  test("all four rounded → four arcs", () => {
    const path = roundedRectPath(0, 0, 100, 60, 5, 5, 5, 5);
    assert.strictEqual((path.match(/A /g) ?? []).length, 4);
  });
});
