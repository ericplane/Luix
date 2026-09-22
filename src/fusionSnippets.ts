import { analyzeLuaBindings } from "./editSyntax";
import { applyMask, buildCodeMask, findAllCreateElementCalls } from "./parser";

export function usesLegacyFusionSyntax(text: string): boolean {
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

/** Keep legacy files usable while generating scope-aware code in Fusion 0.3. */
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

  let scope: { name: string; methods: boolean } | undefined;
  try {
    const bindings = analyzeLuaBindings(text).bindings
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
      scope = {
        name: binding.name,
        methods: /^\s*=\s*(?:[A-Za-z_]\w*\.)?scoped\s*\(\s*Fusion\s*\)/.test(suffix)
          || /^\s*:\s*(?:[A-Za-z_]\w*\.)?Scope\s*<\s*typeof\s*\(\s*Fusion\s*\)/.test(suffix),
      };
      break;
    }
  } catch {
    // While a function is being typed its blocks may be incomplete. Do not
    // guess a scope from a different function; normal snippets remain editable.
  }
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
