import * as vscode from "vscode";
import { applyMask, buildCodeMask, withTransientAnalyses } from "./parser";
import { findDocumentCalls } from "./documentCalls";
import { luaTokens } from "./editSyntax";
import {
  findFrameworkForAlias,
  FrameworkId,
  getDirectInstanceClassNames,
  getEnabledFrameworks,
} from "./frameworks";
import { getConfig, configChangeAffects } from "./configCompat";
import { decodeFileText } from "./workspaceIndex";

// Detection priority: override, document import, factory call, workspace fallback.

export type ActiveFrameworkChoice = "auto" | FrameworkId;

export interface DocumentDetection {
  /** Auto-detection result, ignoring the override. */
  detected: FrameworkId | undefined;
  /** Framework providers should use, including the override. */
  effective: FrameworkId | undefined;
  source: "override" | "import" | "call" | "workspace" | "none";
}

// Cache by document URI and version to share scans across providers.

const docCache = new Map<string, DocumentDetection>();
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
    const firstKey = docCache.keys().next().value;
    if (firstKey !== undefined) {
      docCache.delete(firstKey);
    }
  }
}

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
    // Read string contents only for literal module paths, not nested calls such as GetService.
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
    // aliasStart can point to a Fusion scope receiver; use the resolved alias.
    const alias = call.alias;
    if (!alias) {continue;}
    const fw = findFrameworkForAlias(alias);
    if (fw) {return fw.id;}
  }
  return undefined;
}

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

export function resetDocumentDetectionCache(): void {
  docCache.clear();
}

function readOverride(): FrameworkId | undefined {
  const raw = getConfig<ActiveFrameworkChoice>("activeFramework", "auto");
  if (raw !== "react" && raw !== "roact" && raw !== "fusion" && raw !== "vide") {
    return undefined;
  }
  // Disabled frameworks cannot parse their generated snippets, so ignore their overrides.
  if (!getEnabledFrameworks().some((f) => f.id === raw)) {
    return undefined;
  }
  return raw;
}

/** Read the requested override, including disabled frameworks, for the status tooltip. */
export function readActiveFrameworkSetting(): FrameworkId | undefined {
  const raw = getConfig<ActiveFrameworkChoice>("activeFramework", "auto");
  if (raw === "react" || raw === "roact" || raw === "fusion" || raw === "vide") {
    return raw;
  }
  return undefined;
}

export interface FrameworkSampleSource {
  /** The first limit indexed files by path. */
  frameworkSample(limit: number): vscode.Uri[];
  /** Read without opening a document. */
  readText(uri: vscode.Uri): Promise<string | undefined>;
  /** Changes whenever the file's indexed contents change. */
  entryStamp(uri: vscode.Uri): number | undefined;
}

const SAMPLE_LIMIT = 25;

/** Reuse sampled detections until file contents or framework settings change. */
const sampleDetections = new Map<string, {
  stamp: number;
  frameworks: unknown;
  instances: unknown;
  framework: FrameworkId | undefined;
}>();

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function readSampleText(uri: vscode.Uri): Promise<string | undefined> {
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((doc) => !doc.isClosed && doc.uri.toString() === key);
  if (open) {
    return open.getText();
  }
  try {
    return decodeFileText(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Infer from up to 25 indexed files without opening documents; return undefined if superseded. */
export async function inferWorkspaceFramework(
  source: vscode.Uri[] | FrameworkSampleSource,
  isCancelled: () => boolean = () => false
): Promise<FrameworkId | undefined> {
  // Sort by path for a deterministic sample.
  const sample = Array.isArray(source)
    ? [...source].sort((a, b) => a.fsPath.localeCompare(b.fsPath)).slice(0, SAMPLE_LIMIT)
    : source.frameworkSample(SAMPLE_LIMIT);
  const read = Array.isArray(source) ? readSampleText : (uri: vscode.Uri) => source.readText(uri);
  const counts: Record<FrameworkId, number> = {
    react: 0,
    roact: 0,
    fusion: 0,
    vide: 0,
  };
  const frameworks = getEnabledFrameworks();
  const instances = getDirectInstanceClassNames();
  const enabled = new Set(frameworks.map((fw) => fw.id));
  const sampled = new Set<string>();
  for (const uri of sample) {
    if (isCancelled()) {
      return undefined;
    }
    const key = uri.toString();
    sampled.add(key);
    const stamp = Array.isArray(source) ? undefined : source.entryStamp(uri);
    const known = sampleDetections.get(key);
    let fw: FrameworkId | undefined;
    if (known && stamp !== undefined && known.stamp === stamp &&
      known.frameworks === frameworks && known.instances === instances) {
      fw = known.framework;
    } else {
      const text = await read(uri);
      if (text === undefined || isCancelled()) {
        continue;
      }
      // Background reads must not evict analyses used by open-document providers.
      fw = withTransientAnalyses(() => detectFromRequires(text, enabled) ?? detectFromCalls(text));
      if (stamp !== undefined) {
        sampleDetections.set(key, { stamp, frameworks, instances, framework: fw });
      }
      await yieldToEventLoop();
    }
    if (fw && enabled.has(fw)) {
      counts[fw]++;
    }
  }
  if (isCancelled()) {
    return undefined;
  }
  if (!Array.isArray(source)) {
    for (const key of [...sampleDetections.keys()]) {
      if (!sampled.has(key)) {
        sampleDetections.delete(key);
      }
    }
  }
  // Break count ties with a stable framework priority.
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

export const _internal = {
  detectFromRequires,
  detectFromCalls,
};
