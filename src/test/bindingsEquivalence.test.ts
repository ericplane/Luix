// Reference implementation for binding equivalence and performance checks.
import * as assert from "assert";
import {
  analyzeLuaBindings,
  LUA_KEYWORDS,
  LuaBinding,
  LuaBindings,
  LuaReference,
  LuaScope,
  LuaToken,
  luaTokens,
} from "../editSyntax";
import { documentLuaBindings, fusionSnippetBody } from "../fusionSnippets";

function expressionIf(tokens: LuaToken[], i: number): boolean {
  return i === 0 || ["=", "return", "(", "[", "{", ",", "and", "or"].includes(tokens[i - 1].value);
}

const EXPRESSION_CONTINUATIONS = new Set([
  ",", "=", ".", ":", "+", "-", "*", "/", "%", "^", "<", ">", "<=", ">=", "==", "~=", "and", "or", "not", "..", "then", "else", "elseif",
]);

function referenceAnalyzeLuaBindings(text: string): LuaBindings {
  const tokens = luaTokens(text);
  const root: LuaScope = { start: 0, end: text.length, kind: "root" };
  let scope = root;
  const scopes: LuaScope[] = [root];
  const bindings: LuaBinding[] = [];
  const declared = new Map<number, LuaBinding>();
  const ignored = new Set<number>();
  const tokenScopes = new Map<number, LuaScope>();
  const add = (token: LuaToken, owner = scope, activeFrom = token.end) => {
    const b = { name: token.value, declaration: token, scope: owner, activeFrom };
    bindings.push(b); declared.set(token.start, b);
  };
  const open = (kind: string, start: number) => {
    scope = { kind, start, end: text.length, parent: scope }; scopes.push(scope);
  };
  const close = (end: number) => {
    if (!scope.parent) {throw new Error("Unbalanced block; finish the code before refactoring.");}
    scope.end = end; scope = scope.parent;
  };
  const skipType = (from: number, stop: Set<string>): number => {
    let depth = 0;
    let j = from;
    let valueDepth: number | undefined;
    const continuesType = new Set(["|", "&", "?", ".", "->", "<"]);
    const requiresType = new Set(["|", "&", ".", "->"]);
    for (; j < tokens.length; j++) {
      const v = tokens[j].value;
      if (depth === 0 && stop.has(v)) {break;}
      if (depth === 0 && j > from) {
        const previous = tokens[j - 1];
        // Newlines can end declarations; union and intersection operators continue types.
        if (!requiresType.has(previous.value) && !continuesType.has(v) &&
            (/\n/.test(text.slice(previous.end, tokens[j].start)) ||
             tokens[j].kind === "word") &&
            !(previous.value === "typeof" && v === "(")) {break;}
      }
      if (v === "typeof" && tokens[j + 1]?.value === "(") {
        valueDepth = depth + 1;
        ignored.add(tokens[j].start);
      } else if (valueDepth === undefined || depth < valueDepth) {
        ignored.add(tokens[j].start);
      }
      if (["(", "[", "{", "<"].includes(v)) {depth++;}
      if ([")", "]", "}", ">"].includes(v)) {depth--;}
      if (valueDepth !== undefined && depth < valueDepth && v === ")") {valueDepth = undefined;}
    }
    if (j === from || depth !== 0) {throw new Error("Finish the type annotation before refactoring.");}
    return j;
  };
  let pendingFor: LuaToken[] = [];
  const conditionals: Array<"expression" | "statement"> = [];
  const pendingRepeatClosures: Array<{ scope: LuaScope; end: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], v = t.value;
    // Repeat bindings remain visible to functions inside the until condition.
    while (pendingRepeatClosures.at(-1)?.scope === scope &&
        t.start >= pendingRepeatClosures[pendingRepeatClosures.length - 1].end) {
      close(pendingRepeatClosures.pop()!.end);
    }
    tokenScopes.set(t.start, scope);
    if (ignored.has(t.start) || t.kind !== "word") {continue;}
    if (v === "local" && tokens[i + 1]?.value !== "function") {
      let j = i + 1;
      const locals: LuaToken[] = [];
      while (tokens[j]?.kind === "word") {
        locals.push(tokens[j++]);
        if (tokens[j]?.value === ":") {j = skipType(j + 1, new Set([",", "=", ";"]));}
        if (tokens[j]?.value !== ",") {break;}
        j++;
      }
      // A local is not in scope in its own initializer.
      let activeFrom = tokens[j]?.start ?? text.length;
      if (tokens[j]?.value === "=") {
        let depth = 0;
        for (let k = j + 1; k < tokens.length; k++) {
          const current = tokens[k], prev = tokens[k - 1];
          const previousEndsExpression = prev.kind === "string" || prev.kind === "number" ||
            (prev.kind === "word" && (!LUA_KEYWORDS.has(prev.value) || ["nil", "true", "false", "end"].includes(prev.value))) ||
            [")", "]", "}"].includes(prev.value);
          const startsStatement = ["local", "return", "for", "while", "repeat", "do", "break", "continue"].includes(current.value) ||
            (current.value === "if" && !expressionIf(tokens, k)) ||
            (current.kind === "word" && !LUA_KEYWORDS.has(current.value) && previousEndsExpression);
          if (depth === 0 && (current.value === ";" || current.value === "end" || current.value === "until" ||
              (k > j + 1 && startsStatement) ||
              (k > j + 1 && /\n/.test(text.slice(prev.end, current.start)) &&
                !EXPRESSION_CONTINUATIONS.has(prev.value) &&
                current.value !== "(" && !EXPRESSION_CONTINUATIONS.has(current.value)))) {
            activeFrom = current.start; break;
          }
          if (["(", "[", "{", "function", "do", "repeat"].includes(current.value) ||
              (current.value === "if" && !expressionIf(tokens, k))) {depth++;}
          else if ([")", "]", "}", "end", "until"].includes(current.value)) {depth--;}
          activeFrom = current.end;
        }
      }
      for (const local of locals) {add(local, scope, activeFrom);}
    } else if (v === "function") {
      let j = i + 1;
      if (tokens[j]?.kind === "word") {
        if (tokens[i - 1]?.value === "local") {add(tokens[j], scope, tokens[j].start);}
        // Named global functions are writes.
        while (j < tokens.length && tokens[j].value !== "(") {
          if (tokens[j].value === "<") {throw new Error("Generic functions need the language server's refactor.");}
          j++;
        }
      }
      if (tokens[j]?.value === "<") {throw new Error("Generic functions need the language server's refactor.");}
      if (tokens[j]?.value !== "(") {throw new Error("Finish the function signature before refactoring.");}
      open("function", t.start);
      j++;
      while (j < tokens.length && tokens[j].value !== ")") {
        if (tokens[j].kind === "word") {add(tokens[j], scope, scope.start);}
        j++;
        if (tokens[j]?.value === ":") {j = skipType(j + 1, new Set([",", ")"]));}
        if (tokens[j]?.value === ",") {j++;}
      }
      // Parameters belong to the new function scope.
      for (let k = i + 1; k <= j; k++) {if (tokens[k]) {tokenScopes.set(tokens[k].start, scope);}}
      if (tokens[j + 1]?.value === ":") {
        skipType(j + 2, new Set(["return", "local", "if", "for", "while", "repeat", "do", "end", ";"]));
      }
    } else if (v === "for") {
      pendingFor = [];
      let j = i + 1;
      while (tokens[j]?.kind === "word") {
        pendingFor.push(tokens[j]); ignored.add(tokens[j].start); j++;
        if (tokens[j]?.value !== ",") {break;}
        j++;
      }
    } else if (v === "do") {
      open("do", t.end);
      for (const variable of pendingFor) { ignored.delete(variable.start); add(variable, scope, t.end); }
      pendingFor = [];
    } else if (v === "repeat") {open("repeat", t.end);}
    else if (v === "if") {
      if (expressionIf(tokens, i)) {conditionals.push("expression");}
      else { conditionals.push("statement"); open("if", t.end); }
    } else if (v === "else" || v === "elseif") {
      if (conditionals.at(-1) === "expression") {
        if (v === "else") {conditionals.pop();}
      } else if (scope.kind === "if") {
        close(t.start); open("if", t.end);
      }
    } else if (v === "end") {
      if (scope.kind === "if") {conditionals.pop();}
      close(t.end);
    }
    else if (v === "until") {
      if (scope.kind !== "repeat") {throw new Error("Unbalanced repeat block.");}
      // Repeat locals remain visible throughout the condition.
      let end = text.length, depth = 0;
      for (let j = i + 1; j < tokens.length; j++) {
        const current = tokens[j], previous = tokens[j - 1];
        const adjacentStatement = current.kind === "word" && !LUA_KEYWORDS.has(current.value) &&
          ((previous.kind === "word" && !LUA_KEYWORDS.has(previous.value)) ||
            previous.kind === "number" || previous.kind === "string" || [")", "]", "}"].includes(previous.value));
        if (depth === 0 && j > i + 1 && (
          [";", "local", "return", "for", "while", "repeat", "do", "end"].includes(current.value) ||
          adjacentStatement ||
          (/\n/.test(text.slice(previous.end, current.start)) &&
            !EXPRESSION_CONTINUATIONS.has(previous.value) && current.value !== "(" &&
            !EXPRESSION_CONTINUATIONS.has(current.value)))) { end = current.start; break; }
        if (["(", "[", "{"].includes(current.value)) {depth++;}
        if ([")", "]", "}"].includes(current.value)) {depth--;}
      }
      pendingRepeatClosures.push({ scope, end });
    }
  }
  while (pendingRepeatClosures.at(-1)?.scope === scope) {
    close(pendingRepeatClosures.pop()!.end);
  }
  if (scope !== root || conditionals.length > 0) {throw new Error("Finish the block before refactoring.");}
  const references: LuaReference[] = [];
  const delimiters: Array<{ value: string; scope: LuaScope }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const owner = scopes.filter(s => s.start <= t.start && t.start < s.end)
      .sort((a, b) => b.start - a.start)[0] ?? root;
    if (t.kind === "symbol") {
      if (["(", "[", "{"].includes(t.value)) {delimiters.push({ value: t.value, scope: owner });}
      else if ([")", "]", "}"].includes(t.value)) {delimiters.pop();}
    }
    if (t.kind !== "word" || LUA_KEYWORDS.has(t.value) || ignored.has(t.start)) {continue;}
    const declaration = declared.get(t.start);
    if (declaration) { references.push({ token: t, scope: declaration.scope, binding: declaration, declaration: true }); continue; }
    const prev = tokens[i - 1]?.value, next = tokens[i + 1]?.value;
    if (prev === "." || prev === ":") {continue;}
    // Table keys are labels; assignments inside table callbacks are references.
    const delimiter = delimiters.at(-1);
    if (delimiter?.value === "{" && delimiter.scope === owner &&
        (next === "=" || next === ":") && (prev === "{" || prev === "," || prev === ";")) {continue;}
    let current: LuaScope | undefined = owner;
    let binding: LuaBinding | undefined;
    while (current && !binding) {
      binding = bindings.filter(b => b.scope === current && b.name === t.value && b.activeFrom <= t.start)
        .sort((a, b) => b.activeFrom - a.activeFrom)[0];
      current = current.parent;
    }
    references.push({ token: t, scope: owner, binding });
  }
  return { tokens, bindings, references, root };
}

function scopeKey(scope: LuaScope | undefined): string {
  if (!scope) {
    return "-";
  }
  return `${scopeKey(scope.parent)}>${scope.kind}@${scope.start}-${scope.end}`;
}

function summary(parsed: LuaBindings): unknown {
  return {
    tokens: parsed.tokens,
    bindings: parsed.bindings.map((b) => [b.name, b.declaration.start, scopeKey(b.scope), b.activeFrom]),
    references: parsed.references.map((r) => [
      r.token.start,
      scopeKey(r.scope),
      r.binding ? [r.binding.declaration.start, scopeKey(r.binding.scope)] : null,
      r.declaration ?? false,
    ]),
    root: scopeKey(parsed.root),
  };
}

function outcome(analyze: (text: string) => LuaBindings, text: string): unknown {
  try {
    return summary(analyze(text));
  } catch (error) {
    return { error: (error as Error).message };
  }
}

const CORPUS: Array<[string, string]> = [
  ["function at offset 0", "function Card(props)\n\tlocal x = props.x\n\treturn x\nend\nreturn Card\n"],
  ["local function at offset 0", "local function Card(props)\n\treturn props.Title\nend\n"],
  ["shadowing", "local a = 1\nlocal a = a + 1\ndo\n\tlocal a = a\n\tprint(a)\nend\nprint(a)\n"],
  ["multiple locals", "local a, a = 1, 2\nprint(a)\nlocal b, c = c, b\nreturn b, c\n"],
  ["repeat until", "local i = 0\nrepeat\n\tlocal done = i > 3\n\ti += 1\nuntil done\nprint(i)\n"],
  ["repeat with a function in until", "repeat\n\tlocal x = 1\nuntil (function() return x end)()\nreturn 1\n"],
  ["if chains", "local v = 1\nif v then\n\tlocal w = v\nelseif w then\n\tlocal w = 2\nelse\n\tprint(w)\nend\n"],
  ["if expressions", "local a = if b then c else d\nlocal f = function() return if a then 1 else 2 end\nreturn f\n"],
  ["for loops", "for i = 1, 10 do\n\tprint(i)\nend\nfor k, v in pairs(t) do\n\tprint(k, v)\nend\nprint(i)\n"],
  ["while", "local n = 3\nwhile n > 0 do\n\tlocal m = n\n\tn -= m\nend\n"],
  ["table keys", "local Children = Fusion.Children\nreturn New \"Frame\" {\n\tName = Name,\n\t[Children] = { Size = Size },\n}\n"],
  ["callback in a table", "local t = {\n\tfn = function(a)\n\t\tlocal b = a; b = 2\n\t\treturn b\n\tend,\n}\n"],
  ["types", "type Props = { Title: string, Size: UDim2? }\nlocal function Card(props: Props): Instance\n\tlocal x: number = 1\n\treturn x\nend\n"],
  ["typeof", "local scope: Fusion.Scope<typeof(Fusion)> = scoped(Fusion)\nreturn scope:New \"Frame\" {}\n"],
  ["interpolation", "local name = 'x'\nlocal s = `hello {name} {`nested {name}`}`\nreturn s\n"],
  ["long strings", "local s = [==[ local x = 1 ]==]\n--[[ local y = 2 ]]\nlocal z = s\n"],
  ["methods", "local Controller = {}\nfunction Controller.new(owner)\n\tlocal self = setmetatable({}, Controller)\n\tself.owner = owner\n\treturn self\nend\nfunction Controller:Destroy()\n\tself.owner = nil\nend\n"],
  ["generic function (rejected)", "local function id<T>(x: T): T return x end\n"],
  ["unbalanced (rejected)", "local function f()\n\tif x then\nend\n"],
  ["unfinished string (rejected)", "local s = \"abc\n"],
  ["empty", ""],
  ["only a comment", "-- nothing here\n"],
];

/** Build a Fusion module with nested scopes and shadowed names. */
function fusionModule(lines: number): string {
  const parts = ["local Fusion = require(Packages.Fusion)\nlocal Children, OnEvent = Fusion.Children, Fusion.OnEvent\nlocal scoped = Fusion.scoped\n"];
  for (let i = 0, count = 4; count < lines; i++) {
    const chunk = `
local function Card${i}(scope: Fusion.Scope<typeof(Fusion)>, props)
	local hovered = scope:Value(false)
	local function onEnter()
		hovered:set(true)
	end
	for index, item in props.Items do
		local label = item.Label
		print(index, label)
	end
	return scope:New "Frame" {
		Name = "Card${i}",
		Size = props.Size or UDim2.fromScale(1, 0),
		[OnEvent "MouseEnter"] = onEnter,
		[Children] = {
			scope:New "TextLabel" {
				Text = scope:Computed(function(use, scope)
					local text = if use(hovered) then props.Title else "..."
					return text
				end),
			},
		},
	}
end
`;
    parts.push(chunk);
    count += chunk.split("\n").length - 1;
  }
  return parts.join("") + "\nreturn {}\n";
}

/** Generate incomplete and altered inputs for equivalent error handling. */
function mutations(text: string, count: number, seed: number): string[] {
  const out: string[] = [];
  let x = seed;
  const rnd = (m: number) => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x % Math.max(1, m); };
  for (let k = 0; k < count; k++) {
    const p = rnd(text.length);
    if (k % 4 === 0) {
      out.push(text.slice(0, p));
    } else if (k % 4 === 1) {
      const e = text.indexOf("end", p);
      out.push(e === -1 ? text : text.slice(0, e) + text.slice(e + 3));
    } else if (k % 4 === 2) {
      const nl = text.indexOf("\n", p);
      out.push(nl === -1 ? text : text.slice(0, nl) + "\n\tdo local shadow = 1 end" + text.slice(nl));
    } else {
      const nl = text.indexOf("\n", p);
      out.push(nl === -1 ? text : text.slice(0, nl) + "\n\trepeat local r = 1 until r" + text.slice(nl));
    }
  }
  return out;
}

suite("analyzeLuaBindings matches the filter-based lookups", () => {
  for (const [name, text] of CORPUS) {
    test(name, () => {
      assert.deepStrictEqual(outcome(analyzeLuaBindings, text), outcome(referenceAnalyzeLuaBindings, text));
    });
  }

  test("a Fusion module and its mutations", () => {
    const text = fusionModule(300);
    const expected = outcome(referenceAnalyzeLuaBindings, text);
    assert.ok(!(expected as { error?: string }).error, "the module itself analyses");
    assert.deepStrictEqual(outcome(analyzeLuaBindings, text), expected);
    for (const variant of mutations(text, 120, 7)) {
      assert.deepStrictEqual(outcome(analyzeLuaBindings, variant), outcome(referenceAnalyzeLuaBindings, variant));
    }
  });

  test("the corpus with every line prefix", () => {
    for (const [, text] of CORPUS) {
      const lines = text.split("\n");
      for (let n = 0; n <= lines.length; n++) {
        const prefix = lines.slice(0, n).join("\n");
        assert.deepStrictEqual(outcome(analyzeLuaBindings, prefix), outcome(referenceAnalyzeLuaBindings, prefix));
      }
    }
  });
});

suite("Lexical bindings on big files", function () {
  this.timeout(120000);
  const BOUND_MS = 1500;

  test(`a 40,000-line Fusion module is analysed within ${BOUND_MS} ms`, () => {
    const text = fusionModule(40000);
    const start = Date.now();
    const parsed = analyzeLuaBindings(text);
    const elapsed = Date.now() - start;
    assert.ok(parsed.references.length > 45000, `${parsed.references.length} references`);
    assert.ok(elapsed < BOUND_MS, `${elapsed} ms`);
  });

  test("a document's bindings are worked out once per text", () => {
    const text = fusionModule(400) + "\n-- once";
    const parsed = documentLuaBindings(text);
    assert.ok(parsed);
    assert.strictEqual(documentLuaBindings(text), parsed);
    assert.strictEqual(documentLuaBindings(text.slice(0, -1) + "e"), parsed, "an equal text in another string");
    assert.strictEqual(documentLuaBindings("local function f()\n"), undefined, "an unfinished block analyses to nothing");
  });

  test(`snippet bodies for one completion request inside a 10,000-line module take under ${BOUND_MS} ms`, () => {
    const text = fusionModule(10000);
    const offset = text.indexOf("[Children] = {", text.length >> 1) + "[Children] = {".length;
    const start = Date.now();
    const bodies: string[] = [];
    for (let i = 0; i < 13; i++) {
      bodies.push(fusionSnippetBody(`snippet${i}`, 'New "Frame" {\n\t$0\n}', text, offset));
    }
    const elapsed = Date.now() - start;
    assert.ok(bodies.every((body) => body === 'scope:New "Frame" {\n\t$0\n}'), bodies[0]);
    assert.ok(elapsed < BOUND_MS, `${elapsed} ms`);
  });
});
