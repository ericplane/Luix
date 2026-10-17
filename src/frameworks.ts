import * as vscode from "vscode";
import { configChangeAffects, getConfig } from "./configCompat";
import { DIRECT_INSTANTIABLE_CLASS_NAMES } from "./data";

export type FrameworkId = "react" | "roact" | "fusion" | "vide";

export type CallShape = "parens" | "curried";

export interface FrameworkSpec {
  id: FrameworkId;
  aliases: string[];
  /** Canonical shape used for generated calls: parens or Lua call sugar. */
  callShape: CallShape;
  /** Accepted parser shapes; defaults to the canonical callShape. */
  recognizedCallShapes?: CallShape[];
  /** Children are keyed under childrenKey or inline with props. */
  childrenLayout?: "table-key" | "inline";
  childrenKey?: string;
  /** Include event names as plain prop keys. */
  eventsAsProps: boolean;
  /** Accept Parent as a prop; defaults to false. */
  parentAsProp?: boolean;
}

export const FRAMEWORKS: Record<FrameworkId, FrameworkSpec> = {
  react: {
    id: "react",
    aliases: ["e", "createElement", "React.createElement"],
    callShape: "parens",
    eventsAsProps: false,
  },
  roact: {
    id: "roact",
    aliases: ["Roact.createElement"],
    callShape: "parens",
    eventsAsProps: false,
  },
  fusion: {
    id: "fusion",
    aliases: ["New", "Fusion.New"],
    callShape: "curried",
    childrenLayout: "table-key",
    childrenKey: "Children",
    eventsAsProps: false,
    parentAsProp: true,
  },
  vide: {
    id: "vide",
    aliases: ["create", "vide.create", "Vide.create"],
    callShape: "curried",
    recognizedCallShapes: ["parens", "curried"],
    childrenLayout: "inline",
    eventsAsProps: true,
    parentAsProp: true,
  },
};

const ALL_FRAMEWORK_IDS: FrameworkId[] = ["react", "roact", "fusion", "vide"];

let _enabledFrameworks: FrameworkSpec[] | undefined;
let _aliasPartition: AliasPartition | undefined;
// null caches a disabled feature; undefined means not yet computed.
let _directInstanceClasses: ReadonlySet<string> | null | undefined;

function resetFrameworkCaches(): void {
  _enabledFrameworks = undefined;
  _aliasPartition = undefined;
  _directInstanceClasses = undefined;
}

try {
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      configChangeAffects(e, "frameworks") ||
      configChangeAffects(e, "react.aliases") ||
      configChangeAffects(e, "roact.aliases") ||
      configChangeAffects(e, "fusion.aliases") ||
      configChangeAffects(e, "vide.aliases") ||
      configChangeAffects(e, "vide.directInstanceCalls")
    ) {
      resetFrameworkCaches();
    }
  });
} catch {
  // Unit-test bootstraps may lack vscode.workspace.
}

/** Enabled specs with alias overrides, cached until settings change. */
export function getEnabledFrameworks(): FrameworkSpec[] {
  if (_enabledFrameworks) {return _enabledFrameworks;}
  const enabled = getConfig<FrameworkId[]>("frameworks", ALL_FRAMEWORK_IDS);
  const ids = Array.isArray(enabled)
    ? enabled.filter((id): id is FrameworkId =>
        ALL_FRAMEWORK_IDS.includes(id as FrameworkId)
      )
    : ALL_FRAMEWORK_IDS;

  _enabledFrameworks = ids.map((id) => {
    const base = FRAMEWORKS[id];
    const override = getConfig<string[]>(`${id}.aliases`, []);
    if (Array.isArray(override) && override.length > 0) {
      return { ...base, aliases: override };
    }
    return base;
  });
  return _enabledFrameworks;
}

export interface AliasPartition {
  parens: string[];
  curried: string[];
  /** Parens aliases whose props tables also contain children. If omitted, parsers fall back to curried aliases. */
  parensWithInlineChildren?: string[];
}

export function getAliasPartition(): AliasPartition {
  if (_aliasPartition) {return _aliasPartition;}
  const parens: string[] = [];
  const curried: string[] = [];
  const parensWithInlineChildren: string[] = [];
  for (const framework of getEnabledFrameworks()) {
    const shapes = framework.recognizedCallShapes ?? [framework.callShape];
    const recognisesParens = shapes.includes("parens");
    const inlineChildren = framework.childrenLayout === "inline";
    for (const shape of shapes) {
      const bucket = shape === "parens" ? parens : curried;
      for (const alias of framework.aliases) {
        if (!bucket.includes(alias)) {
          bucket.push(alias);
        }
      }
    }
    // Use the owning spec so cross-framework alias collisions do not enable inline children.
    if (recognisesParens && inlineChildren) {
      for (const alias of framework.aliases) {
        if (!parensWithInlineChildren.includes(alias)) {
          parensWithInlineChildren.push(alias);
        }
      }
    }
  }
  _aliasPartition = { parens, curried, parensWithInlineChildren };
  return _aliasPartition;
}

export function findFrameworkForAlias(
  alias: string
): FrameworkSpec | undefined {
  for (const framework of getEnabledFrameworks()) {
    if (framework.aliases.includes(alias)) {
      return framework;
    }
  }
  return undefined;
}

/** Curated UI classes for Vide direct calls, or undefined when disabled. */
export function getDirectInstanceClassNames(): ReadonlySet<string> | undefined {
  if (_directInstanceClasses !== undefined) {
    return _directInstanceClasses ?? undefined;
  }
  const frameworks = getEnabledFrameworks();
  if (!frameworks.some((f) => f.id === "vide")) {
    _directInstanceClasses = null;
    return undefined;
  }
  if (!getConfig<boolean>("vide.directInstanceCalls", true)) {
    _directInstanceClasses = null;
    return undefined;
  }
  _directInstanceClasses = DIRECT_INSTANTIABLE_CLASS_NAMES;
  return _directInstanceClasses;
}
