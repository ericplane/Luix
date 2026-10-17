// Reference walkers for parser equivalence and performance checks.
import * as assert from "assert";
import * as vscode from "vscode";
import {
  AliasPartition,
  applyMask,
  buildAliasAlternation,
  buildCodeMask,
  CreateElementCall,
  detectReturnedClass,
  extractPropEntries,
  extractPropEntriesFromDocument,
  findAllCreateElementCalls,
  lineNumberOf,
  memoForText,
  parseAnnotationsForComponent,
  scanDocument,
  withTransientAnalyses,
  _scanInternals,
} from "../parser";
import { documentDirectCalls, findDocumentCalls } from "../documentCalls";
import { getAliasPartition } from "../frameworks";
import {
  computeContrastDiagnostics,
  computeMissingRichTextDiagnostics,
  computePropValidationDiagnostics,
} from "../diagnostics";

const OPENERS = new Set(["function", "if", "do", "repeat"]);
const CLOSERS = new Set(["end", "until"]);

function referenceMatchingEnd(masked: string, startIdx: number): number {
  let depth = 1;
  const tokenRe = /\b\w+\b/g;
  tokenRe.lastIndex = startIdx;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(masked)) !== null) {
    if (OPENERS.has(m[0])) {
      depth++;
    } else if (CLOSERS.has(m[0])) {
      depth--;
      if (depth === 0) {
        return m.index + m[0].length;
      }
    }
  }
  return masked.length;
}

/** End offsets of returns belonging to this function. */
function referenceOwnReturns(masked: string, bodyStart: number, bodyEnd: number): number[] {
  const out: number[] = [];
  const stack: string[] = [];
  const tokenRe = /\b\w+\b/g;
  tokenRe.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(masked)) !== null) {
    if (m.index >= bodyEnd) {
      break;
    }
    const word = m[0];
    if (word === "function") {
      stack.push("fn");
    } else if (word === "if" || word === "do" || word === "repeat") {
      stack.push(word);
    } else if (word === "end" || word === "until") {
      stack.pop();
    } else if (word === "return" && stack.reduce((n, t) => n + (t === "fn" ? 1 : 0), 0) === 0) {
      out.push(m.index + word.length);
    }
  }
  return out;
}

const RECEIVER_PREFIX = `(?:[A-Za-z_][A-Za-z0-9_]*\\s*[.:]\\s*)??`;
const CLASS_NAME_ALT =
  `(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|` +
  `([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*))`;
const LEADING_ARGS = `(?:[^()\\n]*?,\\s*)?`;

function asPartition(aliases: AliasPartition | string[]): AliasPartition {
  return Array.isArray(aliases) ? { parens: aliases, curried: [] } : aliases;
}

function referenceDetectReturnedClass(
  originalText: string,
  maskedText: string,
  bodyStart: number,
  bodyEnd: number,
  aliases: AliasPartition | string[]
): string | undefined {
  const partition = asPartition(aliases);
  const parts: string[] = [];
  if (partition.parens.length > 0) {
    parts.push(`(?:${buildAliasAlternation(partition.parens)})\\s*\\(\\s*${CLASS_NAME_ALT}`);
  }
  if (partition.curried.length > 0) {
    const a = buildAliasAlternation(partition.curried);
    parts.push(`${RECEIVER_PREFIX}(?:${a})\\s+${CLASS_NAME_ALT}`);
    parts.push(`${RECEIVER_PREFIX}(?:${a})\\s*\\(\\s*${LEADING_ARGS}${CLASS_NAME_ALT}\\s*\\)`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  const returnAliasPattern = new RegExp(`^\\s*\\(?\\s*(?:${parts.join("|")})`);
  for (const after of referenceOwnReturns(maskedText, bodyStart, bodyEnd)) {
    const r = returnAliasPattern.exec(originalText.slice(after, bodyEnd));
    if (r) {
      const name = r.slice(1).find(Boolean);
      if (name) {
        return name;
      }
    }
  }
  return undefined;
}

function referenceRootCall(
  text: string,
  masked: string,
  bodyStart: number,
  bodyEnd: number,
  aliases: AliasPartition | string[]
): CreateElementCall | undefined {
  const allCalls = _scanInternals.factoryCalls(text, aliases);
  for (const after of referenceOwnReturns(masked, bodyStart, bodyEnd)) {
    const matched = allCalls.find(
      (c) =>
        c.aliasStart >= after &&
        c.aliasStart < bodyEnd &&
        /^\s*\(?\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*[.:]\s*)?$/.test(text.slice(after, c.aliasStart))
    );
    if (matched) {
      return matched;
    }
  }
  return undefined;
}

function referenceHardcodedProps(
  text: string,
  masked: string,
  bodyStart: number,
  bodyEnd: number,
  paramName: string | undefined,
  aliases: AliasPartition | string[]
): string[] | undefined {
  const rootCall = referenceRootCall(text, masked, bodyStart, bodyEnd, aliases);
  if (!rootCall || rootCall.propsBraceStart === undefined || rootCall.propsBraceEnd === undefined) {
    return undefined;
  }
  const propsBody = text.slice(rootCall.propsBraceStart + 1, rootCall.propsBraceEnd);
  const entries = extractPropEntries(propsBody);
  if (entries.length === 0) {
    return undefined;
  }
  const candidate = paramName && paramName !== "_" ? paramName : "props";
  const re = new RegExp(`\\b${candidate}\\b`);
  const out = new Set<string>();
  for (const entry of entries) {
    if (!re.test(propsBody.slice(entry.valueStart, entry.valueEnd))) {
      out.add(entry.key);
    }
  }
  return out.size > 0 ? [...out] : undefined;
}

const TRICKY: Array<[string, string]> = [
  ["keywords in strings, long strings and comments", [
    'local function Card(props)',
    '\tlocal s = "end function if do repeat until return"',
    "\tlocal t = 'end' .. \"\\\"end\" .. `function {props.Title} end`",
    '\t-- end end end function',
    '\t--[[ end',
    '\tfunction ]]',
    '\t--[==[ return e("Frame", {}) ]==]',
    '\tlocal long = [==[',
    '\tend ]] function',
    '\t]==]',
    '\treturn e("Frame", { Name = "end", Size = props.Size })',
    'end',
    'return Card',
  ].join("\n")],
  ["nested loops, repeat/until, if/elseif/else", [
    'local function Walk(props)',
    '\tfor i = 1, 10 do',
    '\t\twhile true do',
    '\t\t\trepeat',
    '\t\t\t\tif i > 2 then',
    '\t\t\t\t\tbreak',
    '\t\t\t\telseif i == 1 then',
    '\t\t\t\t\treturn New "Frame" { Size = UDim2.new() }',
    '\t\t\t\telse',
    '\t\t\t\t\tlocal function inner() return e("TextLabel", {}) end',
    '\t\t\t\tend',
    '\t\t\tuntil i > 3',
    '\t\tend',
    '\tend',
    '\tdo',
    '\t\treturn e("Frame", { Visible = props.Visible, ZIndex = 2 })',
    '\tend',
    'end',
  ].join("\n")],
  ["methods, dotted names and function expressions", [
    'local Widget = {}',
    'function Widget.new(props)',
    '\treturn setmetatable({}, Widget)',
    'end',
    'function Widget:Render()',
    '\treturn e("Frame", {})',
    'end',
    'function Widget.Sub.Deep(props)',
    '\treturn create "ImageLabel" { Image = props.Image, ScaleType = Enum.ScaleType.Fit }',
    'end',
    'local Anon = function(props)',
    '\treturn Fusion.New "Frame" { Name = "Anon" }',
    'end',
    'local Callbacks = function(props)',
    '\treturn e("TextButton", { [React.Event.Activated] = function() return e("Frame", {}) end, Text = "x" })',
    'end',
  ].join("\n")],
  ["if-expressions (bodies that never close)", [
    'local function A(props)',
    '\tlocal x = if props.On then 1 else 0',
    '\treturn e("Frame", { BackgroundTransparency = x })',
    'end',
    'local function B()',
    '\treturn 1',
    'end',
    '--- @prop Title',
    'local function C(props: { Title: string })',
    '\tlocal y = if props.Title then props.Title elseif true then "x" else "y"',
    '\treturn New "TextLabel" { Text = y, TextSize = 14 }',
    'end',
    'return A',
  ].join("\n")],
  ["bodiless declarations", [
    'declare function warn(...: any): ()',
    'declare class Instance',
    '\tfunction FindFirstChild(self, name: string): Instance?',
    '\tfunction GetChildren(self): { Instance }',
    'end',
    'declare function typeof(value: any): string',
    'local function Real(props)',
    '\treturn e("Frame", { Name = "Real" })',
    'end',
  ].join("\n")],
  ["a function still being typed", [
    'local function Typing(props)',
    '\tif props.x then',
    '\t\treturn e("Frame", {',
    'local function Next(props)',
    '\treturn e("TextLabel", { Text = "next" })',
    'end',
    'local function Last(',
  ].join("\n")],
  ["keyword-like identifiers", [
    'local function Ident(props)',
    '\tlocal endx, xend, _end, ending = 1, 2, 3, 4',
    '\tlocal function_ = doThing(ifs, returned, repeated, untilNow)',
    '\tlocal v = t.end_ + t["end"] + t.returns',
    '\treturn e("Frame", { Size = endx, Visible = props.Visible })',
    'end',
    'local function After() return e("Frame", { Name = "after" }) end',
  ].join("\n")],
  ["scoped, receivers, parenthesised calls and spaced returns", [
    'type Props = { Size: UDim2, Title: string }',
    'local function Scoped(scope: Fusion.Scope, props: Props)',
    '\treturn scope:New "Frame" { Name = "Scoped", Size = props.Size }',
    'end',
    'local function Parens(props)',
    '\treturn (New("Frame")({ Name = "Parens", Visible = true }))',
    'end',
    'local function Spaced(props)',
    '\treturn',
    '\t\te(',
    '\t\t\t"Frame",',
    '\t\t\t{ LayoutOrder = 1, Size = props.Size }',
    '\t\t)',
    'end',
    'local function Explicit(scope, props)',
    '\treturn New(scope, "TextLabel")({ Text = props.Title, Name = "Explicit" })',
    'end',
  ].join("\n")],
  ["stray closers", [
    'end',
    'end',
    'local function Extra(props)',
    '\treturn e("Frame", { Name = "x" })',
    'end',
    'until x',
    'local function Extra2() return e("Frame", {}) end end end',
    'return Extra',
  ].join("\n")],
  ["Vide direct calls and inline children", [
    'local function Item(props)',
    '\treturn create "TextButton" {',
    '\t\tText = props.Text,',
    '\t\tActivated = function() print("end") end,',
    '\t\tcreate "UICorner" {},',
    '\t}',
    'end',
    'local view = Item { Text = "hi" }',
    'local frame = Frame({ Size = UDim2.new() })',
    'local made = Vide.create("Frame", { Item {} })',
  ].join("\n")],
  ["empty", ""],
  ["only a comment", "-- function end"],
];

function uiChunk(i: number, ifExpr: boolean): string {
  const ie = (c: string, a: string, b: string) => ifExpr ? `if ${c} then ${a} else ${b}` : `(${c}) and ${a} or ${b}`;
  return `
type CardProps${i} = {
	Title: string,
	Size: UDim2?,
	Active: boolean?,
	OnClick: (() -> ())?,
}

--- @prop Title
--- @prop Size
local function Card${i}(props: CardProps${i})
	local active = ${ie("props.Active", "1", "0")}
	local function onClick()
		if props.OnClick then
			props.OnClick()
		end
	end
	return New "Frame" {
		Name = "Card${i}",
		Size = props.Size or UDim2.fromScale(1, 0),
		BackgroundColor3 = Color3.fromRGB(30, 30, 30),
		[Children] = {
			New "TextLabel" {
				Text = props.Title,
				TextColor3 = ${ie("active == 1", "Color3.new(1, 1, 1)", "Color3.new(0.5, 0.5, 0.5)")},
			},
			New "TextButton" {
				Text = "Go",
				[OnEvent "Activated"] = onClick,
			},
		},
	}
end

local function Row${i}(props)
	local items = {}
	for index, item in props.Items do
		items[index] = e("TextLabel", { Text = item, LayoutOrder = index })
	end
	return e("Frame", { Size = UDim2.new(1, 0, 0, 30), BackgroundTransparency = 1 }, items)
end

local function Badge${i}(props)
	return create "Frame" {
		Size = UDim2.fromOffset(20, 20),
		create "UICorner" { CornerRadius = UDim.new(0, 4) },
		Card${i} { Title = "badge" },
	}
end

function Controller${i}.new(owner)
	local self = setmetatable({}, Controller${i})
	self.owner = owner
	self.connection = owner.Changed:Connect(function(prop)
		if prop == "Parent" then
			self:Destroy()
		end
	end)
	return self
end

function Controller${i}:Destroy()
	if self.connection then
		self.connection:Disconnect()
	end
	local count = ${ie("self.owner", "1", "0")}
	return count
end
`;
}

/** Build a UI module with callbacks, methods and type aliases. */
function uiModule(lines: number, ifExpr: boolean): string {
  let out = "local Fusion = require(Packages.Fusion)\nlocal New = Fusion.New\nlocal Children = Fusion.Children\n" +
    "local OnEvent = Fusion.OnEvent\nlocal React = require(Packages.React)\nlocal e = React.createElement\n" +
    "local create = require(Packages.vide).create\n";
  let count = out.split("\n").length;
  for (let i = 0; count < lines; i++) {
    const chunk = uiChunk(i, ifExpr);
    out += chunk;
    count += chunk.split("\n").length - 1;
  }
  return out + "\nreturn {}\n";
}

/** Build one component with many child elements. */
function elementTable(rows: number): string {
  const out = ["local React = require(Packages.React)", "local e = React.createElement",
    "local function Big(props)", '\treturn e("Frame", {}, {'];
  for (let i = 0; i < rows; i++) {
    out.push(`\t\te("Frame", { Name = "F${i}", Size = UDim2.new(0, ${i}, 0, 10), BackgroundColor3 = Color3.fromRGB(${i % 255}, 0, 0) }, {`,
      `\t\t\tLabel${i} = e("TextLabel", { Text = "row ${i}", TextColor3 = Color3.new(1, 1, 1) }),`,
      "\t\t}),");
  }
  out.push("\t})", "end", "return Big", "");
  return out.join("\n");
}

/** Build a large file of bodiless declarations. */
function declarations(count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(i % 3 === 0
      ? `declare function global${i}(value: any, other: string?): number`
      : `declare class Class${i}\n\tfunction Method${i}(self, name: string): Instance?\n\tName: string\nend`);
  }
  return out.join("\n");
}

/** Generate truncated and altered versions of the input. */
function edits(text: string, seed: number, count: number): string[] {
  const out: string[] = [];
  let x = seed;
  const rnd = (m: number) => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % Math.max(1, m); };
  for (let k = 0; k < count; k++) {
    const p = rnd(text.length);
    if (k % 3 === 0) {
      out.push(text.slice(0, p));
    } else if (k % 3 === 1) {
      const e = text.indexOf("end", p);
      out.push(e === -1 ? text.slice(0, p) : text.slice(0, e) + text.slice(e + 3));
    } else {
      const nl = text.indexOf("\n", p);
      out.push(nl === -1 ? text : text.slice(0, nl) + "\n\tlocal __x = if a then b else c" + text.slice(nl));
    }
  }
  return out;
}

const PARTITIONS: Array<[string, () => AliasPartition | string[]]> = [
  ["enabled frameworks", () => getAliasPartition()],
  ["hand-rolled partition", () => ({ parens: ["e", "React.createElement"], curried: ["New", "Fusion.New"] })],
  ["alias list", () => ["e", "createElement"]],
];

function corpus(): Array<[string, string]> {
  const out: Array<[string, string]> = [...TRICKY];
  out.push(["CRLF", TRICKY[3][1].replace(/\n/g, "\r\n")]);
  const synthetic = uiModule(600, true);
  out.push(["synthetic UI module", synthetic]);
  edits(synthetic, 7, 6).forEach((text, i) => out.push([`synthetic UI module, edit ${i}`, text]));
  for (const [label, text] of TRICKY) {
    edits(text, label.length, 3).forEach((variant, i) => out.push([`${label}, edit ${i}`, variant]));
  }
  out.push(["declarations", declarations(60)]);
  return out;
}

const maskOf = (text: string) => applyMask(text, buildCodeMask(text));

suite("Block map matches the per-function walks", () => {
  test("body ends: every offset of every tricky text", () => {
    for (const [label, text] of corpus()) {
      const masked = maskOf(text);
      const step = masked.length > 4000 ? 7 : 1;
      for (let i = 0; i <= masked.length; i += step) {
        assert.strictEqual(
          _scanInternals.matchingEnd(masked, i),
          referenceMatchingEnd(masked, i),
          `${label}: end of a body starting at ${i}`
        );
      }
    }
  });

  test("a body's own returns: every body start", () => {
    for (const [label, text] of corpus()) {
      const masked = maskOf(text);
      const step = masked.length > 4000 ? 5 : 1;
      for (let i = 0; i <= masked.length; i += step) {
        const end = referenceMatchingEnd(masked, i);
        assert.deepStrictEqual(
          _scanInternals.ownReturns(masked, i, end),
          referenceOwnReturns(masked, i, end),
          `${label}: returns of a body starting at ${i}`
        );
      }
    }
  });

  test("line numbers: every offset", () => {
    for (const [label, text] of corpus()) {
      for (let i = -1; i <= text.length + 1; i += text.length > 4000 ? 11 : 1) {
        assert.strictEqual(_scanInternals.lineOf(text, i), lineNumberOf(text, i), `${label}: line of ${i}`);
      }
    }
  });

  test("unclosed bodies still end where the old walk ended them", () => {
    const text = TRICKY[3][1];
    const masked = maskOf(text);
    const scan = scanDocument(text, getAliasPartition());
    // Preserve the reference scanner's range for an if-expression.
    assert.strictEqual(scan.get("A")?.bodyEnd, masked.length);
    assert.ok((scan.get("B")?.bodyEnd ?? masked.length) < masked.length);
    assert.strictEqual(scan.get("A")?.detectedBase, "Frame");
    assert.deepStrictEqual([...(scan.get("A")?.hardcodedProps ?? [])], ["BackgroundTransparency"]);
  });
});

suite("scanDocument matches the per-function walks", () => {
  for (const [name, partitionOf] of PARTITIONS) {
    test(`components, bases, root calls and hard-coded props (${name})`, () => {
      const partition = partitionOf();
      let components = 0;
      let bases = 0;
      let hardcoded = 0;
      for (const [label, text] of corpus()) {
        const masked = maskOf(text);
        for (const [component, info] of scanDocument(text, partition)) {
          const where = `${label}: ${component}`;
          components++;
          assert.strictEqual(info.bodyEnd, referenceMatchingEnd(masked, info.bodyStart!), `${where} body end`);
          const base = referenceDetectReturnedClass(text, masked, info.bodyStart!, info.bodyEnd!, partition);
          assert.strictEqual(info.detectedBase, base, `${where} base`);
          assert.strictEqual(
            detectReturnedClass(text, masked, info.bodyStart!, info.bodyEnd!, partition), base,
            `${where} exported detectReturnedClass`
          );
          assert.strictEqual(
            _scanInternals.returnedRootCall(text, info.bodyStart!, info.bodyEnd!, partition),
            referenceRootCall(text, masked, info.bodyStart!, info.bodyEnd!, partition),
            `${where} root call`
          );
          assert.deepStrictEqual(
            info.hardcodedProps ? [...info.hardcodedProps] : undefined,
            referenceHardcodedProps(text, masked, info.bodyStart!, info.bodyEnd!, info.paramName, partition),
            `${where} hard-coded props`
          );
          assert.deepStrictEqual(info.annotations, parseAnnotationsForComponent(text, info.defLineIndex), `${where} annotations`);
          const defLine = text.split("\n")[info.defLineIndex] ?? "";
          assert.ok(defLine.includes("function") && defLine.includes(component), `${where} definition line: ${defLine}`);
          if (base) {bases++;}
          if (info.hardcodedProps) {hardcoded++;}
        }
      }
      assert.ok(components > 100, `components seen: ${components}`);
      assert.ok(bases > 30, `bases seen: ${bases}`);
      if (!Array.isArray(partition)) {
        assert.ok(hardcoded > 10, `hard-coded sets seen: ${hardcoded}`);
      }
    });
  }

  test("known components of the tricky texts", () => {
    const partition = getAliasPartition();
    const scan = (i: number) => scanDocument(TRICKY[i][1], partition);
    assert.strictEqual(scan(0).get("Card")?.detectedBase, "Frame");
    assert.deepStrictEqual([...(scan(0).get("Card")?.hardcodedProps ?? [])], ["Name"]);
    assert.strictEqual(scan(1).get("Walk")?.detectedBase, "Frame");
    assert.strictEqual(scan(2).get("Deep")?.detectedBase, "ImageLabel");
    assert.strictEqual(scan(2).get("Anon")?.detectedBase, "Frame");
    assert.strictEqual(scan(4).get("Real")?.detectedBase, "Frame");
    assert.strictEqual(scan(5).get("Next")?.detectedBase, "TextLabel");
    assert.strictEqual(scan(7).get("Scoped")?.detectedBase, "Frame");
    assert.strictEqual(scan(7).get("Parens")?.detectedBase, "Frame");
    assert.strictEqual(scan(7).get("Spaced")?.detectedBase, "Frame");
    assert.strictEqual(scan(7).get("Explicit")?.detectedBase, "TextLabel");
    assert.deepStrictEqual([...(scan(7).get("Explicit")?.hardcodedProps ?? [])], ["Name"]);
    assert.strictEqual(scan(9).get("Item")?.detectedBase, "TextButton");
  });
});

suite("Shared analysis cache", () => {
  const partition = () => getAliasPartition();

  test("every feature asking about one text shares one scan", () => {
    const text = uiModule(300, false);
    const copy = (text + " ").slice(0, -1); // Equal contents, separate string.
    assert.strictEqual(scanDocument(text, partition()), scanDocument(copy, partition()));
    assert.strictEqual(findAllCreateElementCalls(text, partition()), findAllCreateElementCalls(copy, partition()));
    assert.strictEqual(buildCodeMask(text), buildCodeMask(copy));
    assert.strictEqual(applyMask(text, buildCodeMask(text)), applyMask(copy, buildCodeMask(copy)));
    assert.strictEqual(findDocumentCalls(text), findDocumentCalls(copy));
    assert.strictEqual(documentDirectCalls(text), documentDirectCalls(copy));
  });

  test("results are keyed by alias set and direct-call names", () => {
    const text = TRICKY[9][1];
    const react = { parens: ["e"], curried: [] };
    assert.notStrictEqual(scanDocument(text, react), scanDocument(text, partition()));
    assert.strictEqual(scanDocument(text, react), scanDocument(text, { parens: ["e"], curried: [] }));
    const withItem = findAllCreateElementCalls(text, partition(), { componentNames: new Set(["Item"]) });
    assert.strictEqual(withItem, findAllCreateElementCalls(text, partition(), { componentNames: new Set(["Item"]) }));
    assert.notStrictEqual(withItem, findAllCreateElementCalls(text, partition()));
    assert.ok(withItem.some((call) => call.isDirectComponentCall && call.className === "Item"));
    assert.ok(!findAllCreateElementCalls(text, partition()).some((call) => call.isDirectComponentCall));
  });

  test("an edited text gets fresh results", () => {
    const text = TRICKY[0][1];
    const edited = text.replace('Name = "end"', 'Name = "end", Visible = false');
    assert.notStrictEqual(scanDocument(text, partition()), scanDocument(edited, partition()));
    assert.deepStrictEqual(
      [...(scanDocument(edited, partition()).get("Card")?.hardcodedProps ?? [])],
      ["Name", "Visible"]
    );
  });

  test("fragments never push a document out", () => {
    const text = uiModule(200, true) + "\n-- fragments";
    const scan = scanDocument(text, partition());
    for (let i = 0; i < 100; i++) {
      const fragment = `Size = UDim2.new(${i}, 0, 0, 0), Name = "${"x".repeat(i * 40)}"`;
      extractPropEntries(fragment);
      applyMask(fragment, buildCodeMask(fragment));
    }
    assert.strictEqual(scanDocument(text, partition()), scan);
    assert.ok(_scanInternals.cachedTexts().fragments <= 16);
  });

  test("background passes leave the shared cache alone", () => {
    const text = uiModule(200, false) + "\n-- foreground";
    const scan = scanDocument(text, partition());
    const others = Array.from({ length: _scanInternals.DOCUMENT_ANALYSES_MAX * 2 }, (_, i) => `${TRICKY[1][1]}\n-- background ${i}`);
    const inside = withTransientAnalyses(() => others.map((other) => {
      const result = scanDocument(other, partition());
      findDocumentCalls(other);
      return result;
    }));
    assert.strictEqual(scanDocument(text, partition()), scan, "the open document's scan survived");
    assert.ok(others.every((other) => !_scanInternals.isCached(other)));
    others.forEach((other, i) => assert.deepStrictEqual(scanDocument(other, partition()), inside[i]));
  });

  test("memoised values follow their inputs", () => {
    const text = TRICKY[2][1];
    let computed = 0;
    const a = {};
    const b = {};
    const compute = () => ++computed;
    assert.strictEqual(memoForText(text, "test", [a], compute), 1);
    assert.strictEqual(memoForText(text, "test", [a], compute), 1);
    assert.strictEqual(memoForText(text, "test", [b], compute), 2);
    assert.strictEqual(memoForText(text, "test", [b, a], compute), 3);
  });

  test("an equal text held in another string is compared once, not on every lookup", function () {
    this.timeout(120000);
    // Simulate providers reading separate strings with identical document contents.
    const text = elementTable(7000) + "\n-- another string";
    scanDocument(text, partition());
    const calls = findAllCreateElementCalls(text, partition());
    assert.ok(calls.length > 13000, `${calls.length} calls`);
    const copy = Buffer.from(text, "utf8").toString("utf8");
    const start = Date.now();
    for (const call of findAllCreateElementCalls(copy, partition())) {
      if (call.propsBraceStart !== undefined && call.propsBraceEnd !== undefined) {
        extractPropEntriesFromDocument(copy, call.propsBraceStart + 1, call.propsBraceEnd);
      }
    }
    const elapsed = Date.now() - start;
    assert.strictEqual(findAllCreateElementCalls(copy, partition()), calls, "the copy shares the analysis");
    assert.ok(elapsed < 1500, `${elapsed} ms`);
  });

  test("the cache keeps a bounded amount of text, and always the newest", () => {
    const budget = _scanInternals.ANALYSES_CHARS_MAX;
    const big = (salt: number) => `local value${salt} = 1\n`.repeat(Math.ceil(budget / 3 / 18));
    for (let i = 0; i < 6; i++) {
      scanDocument(big(i), partition());
      assert.ok(_scanInternals.cachedChars().documents <= budget, `${_scanInternals.cachedChars().documents} characters`);
      assert.ok(_scanInternals.isCached(big(i)), "the newest text stays cached");
    }
    const huge = "local huge = 1\n".repeat(Math.ceil(budget / 15) + 10);
    assert.ok(huge.length > budget);
    const scan = scanDocument(huge, partition());
    assert.strictEqual(scanDocument(huge, partition()), scan, "a text over the budget is still kept while it is the newest");
    assert.strictEqual(_scanInternals.cachedTexts().documents, 1);
  });

  test("direct calls follow the workspace index's names", () => {
    const text = 'local view = Card { Title = "x" }';
    let names = new Set<string>();
    const index = { knownComponentNames: () => names };
    const before = documentDirectCalls(text, index);
    assert.strictEqual(documentDirectCalls(text, index), before);
    assert.strictEqual(findDocumentCalls(text, index).length, 0);
    names = new Set(["Card"]);
    assert.notStrictEqual(documentDirectCalls(text, index), before);
    assert.strictEqual(findDocumentCalls(text, index)[0]?.className, "Card");
  });
});

suite("Scan time on big files", function () {
  this.timeout(120000);
  const BOUND_MS = 1500;
  let salt = 0;
  const fresh = (text: string) => `${text}\n-- edit ${++salt}`;

  function timed(work: () => void): number {
    const start = Date.now();
    work();
    return Date.now() - start;
  }

  for (const ifExpr of [false, true]) {
    test(`a 20,000-line UI module, ${ifExpr ? "with" : "without"} if-expressions, scans cold within ${BOUND_MS} ms`, () => {
      const module = uiModule(20000, ifExpr);
      for (let round = 0; round < 3; round++) {
        // Each edit must be parsed without a cache hit.
        const text = fresh(module);
        const elapsed = timed(() => {
          scanDocument(text, getAliasPartition());
          findDocumentCalls(text);
        });
        assert.ok(elapsed < BOUND_MS, `round ${round}: ${elapsed} ms`);
      }
    });
  }

  test(`a type-definition file of 6,000 bodiless declarations scans within ${BOUND_MS} ms`, () => {
    const text = fresh(declarations(6000));
    const elapsed = timed(() => {
      scanDocument(text, getAliasPartition());
      findDocumentCalls(text);
    });
    assert.ok(elapsed < BOUND_MS, `${elapsed} ms`);
  });

  test(`a diagnostics pass on a 20,000-line module stays within ${BOUND_MS} ms`, async () => {
    const text = fresh(uiModule(20000, true));
    const document = await vscode.workspace.openTextDocument({ content: text, language: "luau" });
    const elapsed = timed(() => {
      computePropValidationDiagnostics(text, document);
      computeMissingRichTextDiagnostics(text, document);
      computeContrastDiagnostics(text, document);
    });
    assert.ok(elapsed < BOUND_MS, `${elapsed} ms`);
  });

  test(`a diagnostics pass over 20,000 element calls, on the document's own text, stays within ${BOUND_MS} ms`, async () => {
    const text = fresh(elementTable(7000));
    const document = await vscode.workspace.openTextDocument({ content: text, language: "luau" });
    // Reuse analysis created from another provider's string.
    scanDocument(text, getAliasPartition());
    findDocumentCalls(text);
    const elapsed = timed(() => {
      const own = document.getText();
      computePropValidationDiagnostics(own, document);
      computeMissingRichTextDiagnostics(own, document);
      computeContrastDiagnostics(own, document);
    });
    assert.ok(elapsed < BOUND_MS, `${elapsed} ms`);
  });
});
