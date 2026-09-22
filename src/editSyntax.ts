// Deliberately small lexical helpers for refactors. Unlike presentation parsers,
// these preserve every byte and reject syntax whose bindings we cannot prove.
export interface LuaToken {
  value: string;
  start: number;
  end: number;
  kind: "word" | "string" | "symbol" | "number";
}

export const LUA_KEYWORDS = new Set(
  "and break continue do else elseif end false for function if in local nil not or repeat return then true until while export type".split(" ")
);

/** Strings, long strings and comments are consumed as units. Interpolation
 * expressions remain visible so captures and renames include their references. */
export function luaTokens(text: string, interpolate = true): LuaToken[] {
  const out: LuaToken[] = [];
  let i = 0;
  const emit = (start: number, kind: LuaToken["kind"]) =>
    out.push({ value: text.slice(start, i), start, end: i, kind });
  const longEnd = (start: number): number | undefined => {
    const m = /^\[(=*)\[/.exec(text.slice(start));
    if (!m) {return undefined;}
    const close = text.indexOf(`]${m[1]}]`, start + m[0].length);
    if (close < 0) {throw new Error("Finish the long string or comment before refactoring.");}
    return close + m[0].length;
  };
  const quoted = () => {
    const start = i;
    const quote = text[i++];
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i++] === quote) { emit(start, "string"); return; }
    }
    throw new Error("Finish the string before refactoring.");
  };
  const template = () => {
    const fullStart = i, outputStart = out.length;
    let start = i++;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i] === "`") {
        i++;
        if (!interpolate) { out.splice(outputStart); emit(fullStart, "string"); }
        else {emit(start, "string");}
        return;
      }
      if (text[i] === "{") {
        if (interpolate) {emit(start, "string");}
        i++; // interpolation delimiters are not Lua table delimiters
        code(true);
        start = i;
      } else { i++; }
    }
    throw new Error("Finish the interpolated string before refactoring.");
  };
  const code = (interpolation = false) => {
    let braces = 0;
    while (i < text.length) {
      const start = i;
      const c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      if (text.startsWith("--", i)) {
        const end = longEnd(i + 2);
        if (end !== undefined) {i = end;}
        else { const nl = text.indexOf("\n", i); i = nl < 0 ? text.length : nl; }
        continue;
      }
      if (c === '"' || c === "'") { quoted(); continue; }
      if (c === "`") { template(); continue; }
      if (c === "[") {
        const end = longEnd(i);
        if (end !== undefined) { i = end; emit(start, "string"); continue; }
      }
      if (interpolation && c === "}" && braces === 0) { i++; return; }
      if (c === "{") {braces++;}
      if (c === "}") {braces--;}
      if (/[A-Za-z_]/.test(c)) {
        while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) {i++;}
        emit(start, "word");
      } else if (/[0-9]/.test(c)) {
        while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) {i++;}
        emit(start, "number");
      } else {
        const multi = /^(?:\.\.\.|\.\.=|::|==|~=|<=|>=|\+=|-=|\*=|\/=|%=|\^=|\.\.|->)/.exec(text.slice(i));
        i += multi?.[0].length ?? 1;
        emit(start, "symbol");
      }
    }
    if (interpolation) {throw new Error("Finish the interpolation before refactoring.");}
  };
  code();
  return out;
}

function expressionIf(tokens: LuaToken[], i: number): boolean {
  return i === 0 || ["=", "return", "(", "[", "{", ",", "and", "or"].includes(tokens[i - 1].value);
}

const EXPRESSION_CONTINUATIONS = new Set([
  ",", "=", ".", ":", "+", "-", "*", "/", "%", "^", "<", ">", "<=", ">=", "==", "~=", "and", "or", "not", "..", "then", "else", "elseif",
]);

/** Find a table field's terminator without splitting callback statements. */
export function luaValueEnd(text: string, start: number): number {
  const tokens = luaTokens(text.slice(start), false);
  let brackets = 0;
  let blocks = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "string") {continue;}
    const v = t.value;
    if (brackets === 0 && blocks === 0 && [",", ";", "}"].includes(v)) {return start + t.start;}
    if (["(", "[", "{"].includes(v)) {brackets++;}
    else if ([")", "]", "}"].includes(v)) {brackets--;}
    else if (["function", "do", "repeat"].includes(v) || (v === "if" && !expressionIf(tokens, i))) {blocks++;}
    else if (v === "end" || v === "until") {blocks--;}
    if (brackets < 0 || blocks < 0) {throw new Error("Unbalanced expression; finish the code before sorting.");}
  }
  if (brackets !== 0 || blocks !== 0) {throw new Error("Unbalanced expression; finish the code before sorting.");}
  return text.length;
}

export interface LuaScope { start: number; end: number; parent?: LuaScope; kind: string }
export interface LuaBinding { name: string; declaration: LuaToken; scope: LuaScope; activeFrom: number }
export interface LuaReference { token: LuaToken; scope: LuaScope; binding?: LuaBinding; declaration?: boolean }
export interface LuaBindings {
  tokens: LuaToken[];
  bindings: LuaBinding[];
  references: LuaReference[];
  root: LuaScope;
}

/** Resolve lexical value names. Types are skipped; generic/type declarations
 * sharing the renamed name are rejected by the caller rather than guessed. */
export function analyzeLuaBindings(text: string): LuaBindings {
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
        // A declaration can end at a newline without an initializer; a
        // function body can also begin immediately after its return type.
        // Union/intersection continuations are still part of the type.
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
    // `until` closes only after its expression. In particular, functions
    // inside that expression must still inherit the repeat's local bindings.
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
      // A local isn't in scope in its own initializer. With multiline or
      // compound initializers, delimiters and blocks identify its end.
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
        // Named global functions are writes; leave their name visible.
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
      // Parameters are declarations, never references in the enclosing scope.
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
      // Repeat locals remain visible through the whole condition, including
      // a condition formatted over several lines.
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
    // Literal table keys and type fields are labels, not value references.
    // An enclosing table can contain a callback. Its statements are not
    // table fields, even when an assignment follows a semicolon or comma.
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

/** Apply non-overlapping edits against the same immutable input. */
export function applyTextChanges(text: string, changes: Array<{ start: number; end: number; text: string }>): string {
  let previous = text.length + 1;
  for (const change of [...changes].sort((a, b) => b.start - a.start)) {
    if (change.end > previous) {throw new Error("Overlapping refactor edits.");}
    text = text.slice(0, change.start) + change.text + text.slice(change.end);
    previous = change.start;
  }
  return text;
}
