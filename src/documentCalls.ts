import {
  applyMask,
  buildCodeMask,
  collectLocalBindings,
  DirectCallOptions,
  findAllCreateElementCalls,
  scanDocument,
} from "./parser";
import {
  getAliasPartition,
  getDirectInstanceClassNames,
  getEnabledFrameworks,
} from "./frameworks";
import type { WorkspaceIndex } from "./workspaceIndex";

/** Resolve direct constructors separately from user-defined component names. */
export function documentDirectCalls(
  text: string,
  workspaceIndex?: Pick<WorkspaceIndex, "knownComponentNames">
): DirectCallOptions {
  const frameworks = getEnabledFrameworks();
  const supportsDirectComponents = frameworks.some(
    (framework) => framework.id === "vide" || framework.id === "fusion"
  );
  const componentNames = new Set<string>();
  if (supportsDirectComponents) {
    for (const name of workspaceIndex?.knownComponentNames() ?? []) {
      componentNames.add(name);
    }
    for (const name of scanDocument(text, getAliasPartition()).keys()) {
      componentNames.add(name);
    }
  }
  const instanceNames = new Set(getDirectInstanceClassNames());
  const mask = buildCodeMask(text);
  const masked = applyMask(text, mask);
  const bindings = collectLocalBindings(text);
  for (const declaration of masked.matchAll(/\blocal\s+(?!function\b)([^=\n]+)=/g)) {
    for (const binding of declaration[1].split(",")) {
      const name = /^\s*([A-Za-z_]\w*)/.exec(binding)?.[1];
      if (name) {
        bindings.add(name);
      }
    }
  }
  // Parameters can shadow a built-in constructor too. Be conservative when
  // a name is reused in the document instead of linting it as a Roblox class.
  const parameters = /\bfunction(?:\s+[A-Za-z_][\w.:]*)?\s*\(([^)]*)\)/g;
  const parameterNames = new Set<string>();
  for (const match of masked.matchAll(parameters)) {
    for (const parameter of match[1].split(",")) {
      const name = /^\s*([A-Za-z_]\w*)/.exec(parameter)?.[1];
      if (name) {
        parameterNames.add(name);
      }
    }
  }
  const aliases = frameworks.find((framework) => framework.id === "vide")?.aliases ?? [];
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const name of instanceNames) {
    if (componentNames.has(name) || parameterNames.has(name)) {
      instanceNames.delete(name);
      continue;
    }
    if (!bindings.has(name)) {
      continue;
    }
    // `local Frame = create "Frame"` is the usual Vide constructor alias.
    // Other local bindings (including require'd components) take precedence.
    const pattern = new RegExp(
      `\\blocal\\s+${escape(name)}\\s*=\\s*(?:${aliases.map(escape).join("|")})` +
      `\\s*(?:\\(\\s*)?["']${escape(name)}["']`, "g"
    );
    const constructor = aliases.length > 0 && [...text.matchAll(pattern)]
      .some((match) => mask[match.index]);
    if (!constructor) {
      instanceNames.delete(name);
    }
  }
  return { componentNames, instanceNames };
}

export function findDocumentCalls(
  text: string,
  workspaceIndex?: Pick<WorkspaceIndex, "knownComponentNames">
) {
  return findAllCreateElementCalls(text, getAliasPartition(), documentDirectCalls(text, workspaceIndex));
}
