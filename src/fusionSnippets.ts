import { analyzeLuaBindings, LuaBindings } from "./editSyntax";
import { applyMask, buildCodeMask, findAllCreateElementCalls, memoForText } from "./parser";

/** Cached bindings, or undefined for incomplete syntax; callers must not mutate the result. */
export function documentLuaBindings(text: string): LuaBindings | undefined {
  return memoForText(text, "luaBindings", [], () => {
    try {
      return analyzeLuaBindings(text);
    } catch {
      return undefined;
    }
  });
}

export function usesLegacyFusionSyntax(text: string): boolean {
  return memoForText(text, "usesLegacyFusionSyntax", [], () => computeUsesLegacyFusionSyntax(text));
}

function computeUsesLegacyFusionSyntax(text: string): boolean {
  const masked = applyMask(text, buildCodeMask(text));
  if (/\b(?:scoped|Scope)\b|\b\w+\s*:\s*New\b/.test(masked)) {
    return false;
  }
  const calls = findAllCreateElementCalls(text, { parens: [], curried: ["New", "Fusion.New"] });
  if (calls.some((call) => /\([^)]*,/.test(text.slice(call.aliasStart, call.classNameStart)))) {
    return false;
  }
  return calls.some((call) => !call.receiver && /^\s*(?:["']|\(\s*["'])/.test(text.slice(call.aliasStart + (call.alias?.length ?? 0))));
}

/** Generate Fusion 0.3 scope-aware code while retaining legacy syntax where required. */
export function fusionSnippetBody(
  prefix: string,
  body: string,
  text: string,
  offset: number
): string {
  if (usesLegacyFusionSyntax(text)) {
    return body;
  }
  if (prefix === "nfc") {
    return body
      .replace("(props)", "(scope: Fusion.Scope<typeof(Fusion)>, props)")
      .replace(/\bNew\s+("[^"\n]*")/g, "scope:New $1");
  }

  const scope = memoForText(text, "fusionScope", [offset], () => fusionScopeAt(text, offset));
  if (!scope) {
    return body;
  }

  const name = scope.name;
  const constructors = "Value|Computed|Spring|Tween|Observer|ForKeys|ForValues|ForPairs";
  let rendered = body.replace(/\bNew\s+("[^"\n]*")/g,
    (_match, className: string) => scope!.methods
      ? `${name}:New ${className}` : `New(${name}, ${className})`);
  rendered = rendered.replace(new RegExp(`\\b(${constructors})\\(`, "g"),
    (_match, constructor: string) => scope!.methods
      ? `${name}:${constructor}(` : `${constructor}(${name}, `);
  if (prefix === "computed") {
    rendered = rendered.replace("function()", "function(use, scope)");
  } else if (prefix === "forKeys") {
    rendered = rendered.replace("function(key)", "function(use, scope, key)");
  } else if (prefix === "forValues") {
    rendered = rendered.replace("function(value)", "function(use, scope, value)");
  } else if (prefix === "forPairs") {
    rendered = rendered.replace("function(key, value)", "function(use, scope, key, value)");
  }
  return rendered;
}

/** Find the nearest visible binding typed as Scope, created by scoped/deriveScope, or named scope. */
function fusionScopeAt(text: string, offset: number): { name: string; methods: boolean } | undefined {
  // Incomplete syntax must not borrow a scope from another function.
  const parsed = documentLuaBindings(text);
  if (!parsed) {
    return undefined;
  }
  const bindings = parsed.bindings
    .filter((binding) => binding.activeFrom <= offset && binding.scope.start <= offset && binding.scope.end >= offset)
    .sort((a, b) => b.scope.start - a.scope.start || b.declaration.start - a.declaration.start);
  const shadowed = new Set<string>();
  for (const binding of bindings) {
    if (shadowed.has(binding.name)) {
      continue;
    }
    shadowed.add(binding.name);
    const suffix = text.slice(binding.declaration.end);
    const typed = /^\s*:\s*(?:[A-Za-z_]\w*\.)?Scope\b/.test(suffix);
    const scoped = /^\s*=\s*(?:[A-Za-z_]\w*\.)?(?:scoped|deriveScope)\s*\(/.test(suffix);
    if (!typed && !scoped && !/^scope$/i.test(binding.name)) {
      continue;
    }
    return {
      name: binding.name,
      methods: /^\s*=\s*(?:[A-Za-z_]\w*\.)?scoped\s*\(\s*Fusion\s*\)/.test(suffix)
        || /^\s*:\s*(?:[A-Za-z_]\w*\.)?Scope\s*<\s*typeof\s*\(\s*Fusion\s*\)/.test(suffix),
    };
  }
  return undefined;
}
