import * as vscode from "vscode";
import { applyMask, buildCodeMask } from "./parser";
import { findDocumentCalls } from "./documentCalls";
import { luaTokens } from "./editSyntax";
import {
  findFrameworkForAlias,
  FrameworkId,
  getEnabledFrameworks,
} from "./frameworks";
import { getConfig, configChangeAffects } from "./configCompat";

// ============================================================================
// Active-framework detection — "which UI framework is *this* file using?"
// ============================================================================
//
// Luix supports four frameworks (React, Roact, Fusion, Vide). Before
// 1.5.0, every snippet provider showed items for *every* framework in
// `luix.frameworks`, so a Vide-only file's dropdown was cluttered
// with React's `eFrame` / `eTextLabel` / Fusion's `nFrame` / etc.
//
// Per-file detection picks one framework as the "active" one for the
// document at hand. Providers gate their items on it so a Vide file
// only surfaces Vide snippets, a React file only React, etc.
//
// Priority ladder (first match wins):
//
//   1. EXPLICIT OVERRIDE — `luix.activeFramework` setting, if set to a
//      concrete framework id (not `"auto"`). Workspace-scope writes
//      from the status-bar picker land here.
//
//   2. IN-FILE REQUIRE — scan the document for `require(…)` calls
//      whose path names a known framework. Specific wins over generic:
//      "roact" before "react", and "vide" / "fusion" are unambiguous.
//
//   3. IN-FILE FACTORY CALL — first `e(...)` / `New "..."` /
//      `create "..."` / etc. — look up the framework via the alias.
//
//   4. WORKSPACE FALLBACK — when activated, the workspace index has
//      a sampled best-guess framework for the project as a whole.
//      Lets brand-new files inherit the project's convention.
//
//   5. NONE — undefined. Providers stay quiet (matches the existing
//      `looksLikeUIFile` policy: no UI context, no UI suggestions).

export type ActiveFrameworkChoice = "auto" | FrameworkId;

export interface DocumentDetection {
  /** What auto-detection would pick, ignoring any user override. */
  detected: FrameworkId | undefined;
  /** What providers should actually use — honours the override. */
  effective: FrameworkId | undefined;
  /** How we got there. Used by the status-bar tooltip. */
  source: "override" | "import" | "call" | "workspace" | "none";
}

// ----------------------------------------------------------------------
// Per-document cache. Keyed by `${uri}#${version}` so a fresh keystroke
// on the same document doesn't re-scan — the detection regexes are
// cheap individually but get hit by every snippet provider on every
// keystroke, which adds up on big files.
// ----------------------------------------------------------------------

const docCache = new Map<string, DocumentDetection>();
// 64 entries: with a typical session holding ~10-20 open tabs and the
// cache key including doc.version, each tab's first keystroke per edit
// is a miss anyway — the cap mostly bounds memory, not throughput. 64
// covers heavy multi-doc sessions without ever evicting an active tab
// mid-keystroke.
const DOC_CACHE_MAX = 64;

function cacheKey(doc: vscode.TextDocument): string {
  return `${doc.uri.toString()}#${doc.version}`;
}

function rememberDetection(
  doc: vscode.TextDocument,
  detection: DocumentDetection
): void {
  const key = cacheKey(doc);
  docCache.set(key, detection);
  if (docCache.size > DOC_CACHE_MAX) {
    // FIFO eviction: drop the oldest entry by insertion order. (The
    // `firstKey !== key` guard would never trigger here because we
    // JUST inserted `key` at the tail, so `firstKey` is always older.)
    const firstKey = docCache.keys().next().value;
    if (firstKey !== undefined) {
      docCache.delete(firstKey);
    }
  }
}

// Wire a workspace-config listener so the per-document cache is
// invalidated when any setting that feeds detection changes — not just
// `luix.activeFramework` (which `statusBar.ts` already handles), but
// also `luix.frameworks` and the per-framework `*.aliases` arrays,
// which feed `getAliasPartition()` consumed by `detectFromCalls`.
// Without this, after toggling `luix.frameworks` to remove a framework
// the detector would keep returning the stale cached id for every
// already-open document until the user types into it.
//
// Mirrors the key list in `frameworks.ts`'s own cache invalidator
// (intentionally — they're the same inputs).
let _configListener: vscode.Disposable | undefined;
function ensureConfigListener(): void {
  if (_configListener) {return;}
  _configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      configChangeAffects(e, "frameworks") ||
      configChangeAffects(e, "activeFramework") ||
      configChangeAffects(e, "react.aliases") ||
      configChangeAffects(e, "roact.aliases") ||
      configChangeAffects(e, "fusion.aliases") ||
      configChangeAffects(e, "vide.aliases") ||
      configChangeAffects(e, "vide.directInstanceCalls") ||
      configChangeAffects(e, "createElementAliases")
    ) {
      docCache.clear();
    }
  });
}

// ----------------------------------------------------------------------
// Workspace fallback. Computed lazily and refreshed by callers that
// have visibility into the workspace index changes (extension activate
// wires `WorkspaceIndex.onDidChangeIndex` to `setWorkspaceFallback`).
// ----------------------------------------------------------------------

let _workspaceFallback: FrameworkId | undefined;

export function setWorkspaceFallback(fw: FrameworkId | undefined): void {
  if (_workspaceFallback === fw) {
    return;
  }
  _workspaceFallback = fw;
  docCache.clear();
}

export function getWorkspaceFallback(): FrameworkId | undefined {
  return _workspaceFallback;
}

// ----------------------------------------------------------------------
// Import detection balances parentheses and masks comments / strings:
//
//   require(ReplicatedStorage.Packages.React)
//   require(script.Parent.Vide)
//   require(game:GetService("ReplicatedStorage").Packages.Fusion)
//   require("@Packages/vide")
//
// Mixed imports retain the established framework preference order.
// ----------------------------------------------------------------------

function detectFromRequires(
  text: string,
  enabled: ReadonlySet<FrameworkId> = new Set(["roact", "react", "fusion", "vide"])
): FrameworkId | undefined {
  const masked = applyMask(text, buildCodeMask(text));
  const matches = new Set<FrameworkId>();
  const requirePattern = /\brequire\s*\(/g;
  for (const match of masked.matchAll(requirePattern)) {
    const start = match.index!;
    let previous = start - 1;
    while (previous >= 0 && /\s/.test(masked[previous])) {
      previous--;
    }
    if (previous >= 0 && /[.:]/.test(masked[previous])) {
      continue;
    }
    const argumentStart = start + match[0].length;
    let depth = 1;
    let end = argumentStart;
    for (; end < masked.length; end++) {
      if (masked[end] === "(") {
        depth++;
      } else if (masked[end] === ")" && --depth === 0) {
        break;
      }
    }
    if (depth !== 0) {
      continue;
    }
    // Only a literal module path needs its string contents. For instance
    // paths, mask comments and nested string arguments such as GetService.
    let argument = masked.slice(argumentStart, end);
    try {
      const tokens = luaTokens(text.slice(argumentStart, end), false);
      if (tokens.length === 1 && tokens[0].kind === "string") {
        argument = tokens[0].value;
      }
    } catch {
      continue;
    }
    for (const fw of ["roact", "react", "fusion", "vide"] as FrameworkId[]) {
      if (new RegExp(`\\b${fw}\\b`, "i").test(argument)) {
        matches.add(fw);
      }
    }
  }
  return (["roact", "vide", "fusion", "react"] as FrameworkId[])
    .find((fw) => matches.has(fw) && enabled.has(fw));
}

function detectFromCalls(text: string): FrameworkId | undefined {
  const calls = findDocumentCalls(text);
  for (const call of calls) {
    if (call.isDirectInstanceCall) {
      return "vide";
    }
    // The parser hands us the resolved alias. Reading it back out of
    // the text at `aliasStart` no longer works: that offset points at
    // the receiver for Fusion 0.3's `scope:New "Frame" { … }`, and
    // `scope` owns no framework.
    const alias = call.alias;
    if (!alias) {continue;}
    const fw = findFrameworkForAlias(alias);
    if (fw) {return fw.id;}
  }
  return undefined;
}

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

/**
 * Detect the framework Luix should treat as "active" for a given
 * document. Memoised per `(uri, version)` — repeated calls within
 * one keystroke return the same answer without re-scanning.
 */
export function detectFrameworkForDocument(
  doc: vscode.TextDocument
): DocumentDetection {
  ensureConfigListener();
  const key = cacheKey(doc);
  const cached = docCache.get(key);
  if (cached) {return cached;}

  const override = readOverride();
  const text = doc.getText();
  const enabled = new Set(getEnabledFrameworks().map((fw) => fw.id));

  // Run each pure-text detector ONCE and remember which one matched —
  // previously we re-ran `detectFromRequires` just to label the source
  // string, doubling the full-document scan on every cache miss.
  const fromRequires = detectFromRequires(text, enabled);
  const fromCalls = fromRequires ? undefined : detectFromCalls(text);
  const candidate = fromRequires ?? fromCalls;
  const detected = candidate && enabled.has(candidate) ? candidate : undefined;

  let effective: FrameworkId | undefined;
  let source: DocumentDetection["source"];
  if (override) {
    effective = override;
    source = "override";
  } else if (detected) {
    effective = detected;
    source = fromRequires ? "import" : "call";
  } else if (_workspaceFallback && enabled.has(_workspaceFallback)) {
    effective = _workspaceFallback;
    source = "workspace";
  } else {
    effective = undefined;
    source = "none";
  }

  const result: DocumentDetection = { detected, effective, source };
  rememberDetection(doc, result);
  return result;
}

/**
 * Drop the per-document cache. Wire to
 * `vscode.workspace.onDidChangeConfiguration` when
 * `luix.activeFramework` changes so a flipped override takes effect
 * without waiting for each open document to be edited.
 */
export function resetDocumentDetectionCache(): void {
  docCache.clear();
}

function readOverride(): FrameworkId | undefined {
  const raw = getConfig<ActiveFrameworkChoice>("activeFramework", "auto");
  if (raw !== "react" && raw !== "roact" && raw !== "fusion" && raw !== "vide") {
    return undefined;
  }
  // Cross-check against `luix.frameworks` — if the user set the
  // override to a framework they've removed from the parser's enabled
  // set, the snippets would surface but the parser would never
  // recognise the inserted call, silently breaking completions on the
  // generated code. Ignore the override in that case (fall through to
  // auto-detection); the status-bar picker now warns about this when
  // the user selects an inactive framework.
  if (!getEnabledFrameworks().some((f) => f.id === raw)) {
    return undefined;
  }
  return raw;
}

/** Read the override even when the named framework is not in
 *  `luix.frameworks`. Used by the status-bar tooltip so users can see
 *  what they asked for, distinct from what `readOverride()` actually
 *  applied. Returns the raw override value or `undefined` when set to
 *  `auto`. */
export function readActiveFrameworkSetting(): FrameworkId | undefined {
  const raw = getConfig<ActiveFrameworkChoice>("activeFramework", "auto");
  if (raw === "react" || raw === "roact" || raw === "fusion" || raw === "vide") {
    return raw;
  }
  return undefined;
}

/**
 * Sample up to N indexed file URIs, open each as a text document,
 * and tally which framework signals appear. Returns the most-common
 * framework, or undefined when nothing was detected. Async because
 * `openTextDocument` is async; intended to run once per index-settle,
 * not per keystroke.
 *
 * Caps the sample at 25 files to keep activation snappy on huge
 * workspaces — that's enough to break any tie that matters.
 */
export async function inferWorkspaceFramework(
  uris: vscode.Uri[]
): Promise<FrameworkId | undefined> {
  const SAMPLE_LIMIT = 25;
  // Sort by fsPath so the sample is deterministic across sessions.
  // `indexedUris()` returns Map insertion order, which is whichever
  // file's async scan settled first — non-deterministic, and meant a
  // cold start could resolve the fallback to a different framework on
  // each launch for mixed-framework workspaces.
  const sample = [...uris]
    .sort((a, b) => a.fsPath.localeCompare(b.fsPath))
    .slice(0, SAMPLE_LIMIT);
  const counts: Record<FrameworkId, number> = {
    react: 0,
    roact: 0,
    fusion: 0,
    vide: 0,
  };
  const enabled = new Set(getEnabledFrameworks().map((fw) => fw.id));
  for (const uri of sample) {
    let text: string;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      text = doc.getText();
    } catch {
      continue;
    }
    const fw = detectFromRequires(text, enabled) ?? detectFromCalls(text);
    if (fw && enabled.has(fw)) {
      counts[fw]++;
    }
  }
  // Pick the framework with the highest count, keeping a stable priority
  // when workspace files use several frameworks equally often.
  let best: FrameworkId | undefined;
  let bestCount = 0;
  for (const fw of ["roact", "react", "fusion", "vide"] as FrameworkId[]) {
    if (counts[fw] > bestCount) {
      best = fw;
      bestCount = counts[fw];
    }
  }
  return best;
}

// Exposed for tests so the suite can drive the pure text-only
// detection helpers without needing to instantiate a real
// `vscode.TextDocument` or read `luix.activeFramework` from a real
// workspace configuration.
export const _internal = {
  detectFromRequires,
  detectFromCalls,
};
