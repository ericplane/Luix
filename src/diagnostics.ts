import * as vscode from "vscode";
import {
  getPropType,
  defaultPropsMap,
  flattenClassProps,
  flattenClassEvents,
  isDeprecatedValidProp,
  cornerRadiusConflicts,
} from "./data";
import {
  applyMask,
  buildCallTree,
  buildCodeMask,
  CallTreeNode,
  CreateElementCall,
  extractColorLiterals,
  extractPropEntries,
  extractPropEntriesFromDocument,
  scanDocument,
  collectLocalBindings,
} from "./parser";
import { getAutoImportConfig } from "./config";
import { configChangeAffects, getConfig } from "./configCompat";
import { FRAMEWORKS, findFrameworkForAlias, getAliasPartition } from "./frameworks";
import { WorkspaceIndex } from "./workspaceIndex";
import { planUICornerRefactor } from "./uiCorner";
import { findDocumentCalls } from "./documentCalls";

export const DIAGNOSTIC_CODE = {
  ReservedName: "luix.reserved-name",
  DeprecatedFont: "luix.deprecated-font",
  TypoTextColor: "luix.typo-textcolor",
  MissingImport: "luix.missing-import",
  UnknownProp: "luix.unknown-prop",
  DuplicateProp: "luix.duplicate-prop",
  WrongEnumType: "luix.wrong-enum-type",
  OverriddenByComponent: "luix.overridden-by-component",
  MissingRichText: "luix.missing-richtext",
  MissingAnchorPoint: "luix.missing-anchorpoint",
  NumericRange: "luix.numeric-range",
  LowContrast: "luix.low-contrast",
  UnusedProp: "luix.unused-prop",
  CornerRadiusConflict: "luix.corner-radius-conflict",
  CornerRadiusCollapsible: "luix.corner-radius-collapsible",
} as const;

const REFRESH_DELAY_MS = 200;
/** Visible documents need only a brief coalescing delay. */
const SHOWN_DELAY_MS = 30;
/** Wait for quiet before linting unseen documents. */
const BACKGROUND_DELAY_MS = 1000;
const BACKGROUND_GAP_MS = 50;
/** Maximum time per pass before yielding the event loop. */
const PASS_SLICE_MS = 8;

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export class DiagnosticsManager implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;
  private disposables: vscode.Disposable[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private publishedVersions = new Map<string, number>();
  /** A newer pass supersedes any older result for the same document. */
  private passes = new Map<string, number>();
  /** Run ready passes serially so their time slices do not accumulate in one event-loop turn. */
  private ready = new Map<string, { document: vscode.TextDocument; background: boolean }>();
  private working = false;
  /** Unseen documents wait in arrival order until foreground work is idle. */
  private background = new Map<string, vscode.TextDocument>();
  private backgroundTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly workspaceIndex: WorkspaceIndex) {
    this.collection = vscode.languages.createDiagnosticCollection("luix");
    this.disposables.push(this.collection);
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.documentChanged(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.documentChanged(e.document)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          const doc = editor.document;
          if (isLuaDocument(doc) && this.publishedVersions.get(doc.uri.toString()) !== doc.version) {
            this.scheduleRefresh(doc, SHOWN_DELAY_MS);
          }
        }
      }),
      vscode.workspace.onDidCloseTextDocument((d) => {
        const key = d.uri.toString();
        this.collection.delete(d.uri);
        const timer = this.debounceTimers.get(key);
        if (timer) {
          clearTimeout(timer);
          this.debounceTimers.delete(key);
        }
        this.ready.delete(key);
        this.background.delete(key);
        this.publishedVersions.delete(key);
        this.passes.delete(key);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          configChangeAffects(e, "warnReservedPropNames") ||
          configChangeAffects(e, "deprecationDiagnostics") ||
          configChangeAffects(e, "autoImport") ||
          configChangeAffects(e, "propValidation") ||
          configChangeAffects(e, "richText") ||
          configChangeAffects(e, "contrastWarnings") ||
          configChangeAffects(e, "unusedProps") ||
          configChangeAffects(e, "frameworks") ||
          configChangeAffects(e, "react.aliases") ||
          configChangeAffects(e, "roact.aliases") ||
          configChangeAffects(e, "fusion.aliases") ||
          configChangeAffects(e, "vide.aliases") ||
          configChangeAffects(e, "createElementAliases") ||
          configChangeAffects(e, "vide.directInstanceCalls")
        ) {
          this.refreshAllOpenDocuments();
        }
      })
    );

    this.refreshAllOpenDocuments();
  }

  private refreshAllOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (this.isWanted(doc)) {
        this.scheduleRefresh(doc, 0);
      } else {
        this.queueBackground(doc);
      }
    }
  }

  private documentChanged(document: vscode.TextDocument): void {
    if (this.isWanted(document)) {
      this.scheduleRefresh(document, REFRESH_DELAY_MS);
    } else {
      this.queueBackground(document);
    }
  }

  private queueBackground(document: vscode.TextDocument): void {
    if (!isLuaDocument(document) || document.isClosed || this.disposed) {
      return;
    }
    const key = document.uri.toString();
    this.background.delete(key);
    this.background.set(key, document);
    this.scheduleBackground(BACKGROUND_DELAY_MS);
  }

  private scheduleBackground(delay: number): void {
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
    }
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = undefined;
      this.lintNextBackground();
    }, delay);
  }

  /** Start background work only when no shown document is waiting. */
  private lintNextBackground(): void {
    if (this.disposed || this.background.size === 0) {
      return;
    }
    if (this.debounceTimers.size > 0 || this.ready.size > 0 || this.working) {
      this.scheduleBackground(BACKGROUND_DELAY_MS);
      return;
    }
    const next = this.background.entries().next();
    if (next.done) {
      return;
    }
    const [key, document] = next.value;
    this.background.delete(key);
    this.enqueue(document, true);
  }

  private enqueue(document: vscode.TextDocument, background = false): void {
    if (this.disposed) {
      return;
    }
    const key = document.uri.toString();
    if (!background) {
      this.background.delete(key);
    }
    this.ready.delete(key);
    this.ready.set(key, { document, background });
    void this.work();
  }

  private shownPassWaiting(): boolean {
    for (const entry of this.ready.values()) {
      if (!entry.background) {
        return true;
      }
    }
    return false;
  }

  private async work(): Promise<void> {
    if (this.working) {
      return;
    }
    this.working = true;
    try {
      // Let timers settle first so shown documents receive priority.
      await yieldToEventLoop();
      for (let next = this.takeReady(); next; next = this.takeReady()) {
        const { document, background } = next;
        // Pause background work when a shown document needs a pass.
        const done = await this.maybeRefresh(document, background ? () => this.shownPassWaiting() : undefined);
        if (!done && background && !document.isClosed && !this.ready.has(document.uri.toString())) {
          this.queueBackground(document);
        }
        await yieldToEventLoop();
      }
    } finally {
      this.working = false;
    }
    if (this.background.size > 0 && !this.backgroundTimer) {
      this.scheduleBackground(BACKGROUND_GAP_MS);
    }
  }

  /** Prefer shown documents, then foreground work, then oldest background work. */
  private takeReady(): { document: vscode.TextDocument; background: boolean } | undefined {
    if (this.disposed || this.ready.size === 0) {
      return undefined;
    }
    let key: string | undefined;
    if (this.ready.size > 1) {
      const shown = new Set(vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()));
      let firstShown: string | undefined;
      let firstWanted: string | undefined;
      for (const [candidate, entry] of this.ready) {
        if (shown.has(candidate)) {
          firstShown = candidate;
          break;
        }
        if (!entry.background) {
          firstWanted ??= candidate;
        }
      }
      key = firstShown ?? firstWanted;
    }
    key ??= this.ready.keys().next().value as string;
    const entry = this.ready.get(key);
    this.ready.delete(key);
    return entry;
  }

  /** Prioritize visible tabs and documents already carrying diagnostics. */
  private isWanted(document: vscode.TextDocument): boolean {
    if (!isLuaDocument(document)) {
      return false;
    }
    const key = document.uri.toString();
    if (this.publishedVersions.has(key)) {
      return true;
    }
    if (vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === key)) {
      return true;
    }
    for (const group of vscode.window.tabGroups?.all ?? []) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && input.uri.toString() === key) {
          return true;
        }
        if (
          input instanceof vscode.TabInputTextDiff &&
          (input.original.toString() === key || input.modified.toString() === key)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private scheduleRefresh(document: vscode.TextDocument, delay: number): void {
    // Reject non-Lua documents before allocating debounce timers.
    if (!isLuaDocument(document) || this.disposed) {
      return;
    }
    const key = document.uri.toString();
    this.background.delete(key);
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const t = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.enqueue(document);
    }, delay);
    this.debounceTimers.set(key, t);
  }

  /** Return false only when yielding to foreground work; stale edits schedule their own replacement pass. */
  private async maybeRefresh(document: vscode.TextDocument, giveWay?: () => boolean): Promise<boolean> {
    if (!isLuaDocument(document) || document.isClosed) {
      return true;
    }
    const key = document.uri.toString();
    const pass = (this.passes.get(key) ?? 0) + 1;
    this.passes.set(key, pass);
    const version = document.version;
    const isStale = () =>
      this.disposed || document.isClosed || document.version !== version ||
      this.passes.get(key) !== pass;
    let gaveWay = false;
    const stop = giveWay
      ? () => isStale() || (gaveWay = giveWay())
      : isStale;
    let diags: vscode.Diagnostic[] | undefined;
    try {
      diags = await this.computeDiagnostics(document, stop);
    } catch {
      // One failed rule must not stop later passes.
      return true;
    }
    if (!diags || isStale()) {
      return !gaveWay;
    }
    this.collection.set(document.uri, diags);
    this.publishedVersions.set(key, version);
    return true;
  }

  /** Yield between rule families; return undefined when the pass becomes stale. */
  private async computeDiagnostics(
    document: vscode.TextDocument,
    isStale: () => boolean = () => false
  ): Promise<vscode.Diagnostic[] | undefined> {
    let sliceStart = Date.now();
    const pause = async (): Promise<boolean> => {
      if (Date.now() - sliceStart >= PASS_SLICE_MS) {
        await yieldToEventLoop();
        sliceStart = Date.now();
      }
      return isStale();
    };
    const warnReserved = getConfig<boolean>(
      "warnReservedPropNames",
      false
    );
    const warnDeprecation = getConfig<boolean>(
      "deprecationDiagnostics",
      true
    );
    const autoImport = getAutoImportConfig();

    const text = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    // Prepare shared analysis in stages to keep large files from holding the event loop.
    applyMask(text, buildCodeMask(text));
    if (await pause()) {return undefined;}
    scanDocument(text, getAliasPartition());
    if (await pause()) {return undefined;}
    findDocumentCalls(text, this.workspaceIndex);
    if (await pause()) {return undefined;}

    if (warnReserved) {
      diagnostics.push(...computeReservedNameDiagnostics(text));
      if (await pause()) {return undefined;}
    }
    if (warnDeprecation) {
      diagnostics.push(
        ...computeDeprecationDiagnostics(text, document, this.workspaceIndex)
      );
      if (await pause()) {return undefined;}
    }
    if (autoImport.enabled) {
      diagnostics.push(
        ...(await computeMissingImportDiagnostics(
          text,
          document,
          this.workspaceIndex
        ))
      );
      if (await pause()) {return undefined;}
    }
    if (getConfig<boolean>("propValidation.enabled", true)) {
      diagnostics.push(...computePropValidationDiagnostics(text, document, this.workspaceIndex));
      if (await pause()) {return undefined;}
    }
    if (getConfig<boolean>("richText.enabled", true)) {
      diagnostics.push(...computeMissingRichTextDiagnostics(text, document, this.workspaceIndex));
      if (await pause()) {return undefined;}
    }
    if (getConfig<boolean>("contrastWarnings.enabled", false)) {
      diagnostics.push(...computeContrastDiagnostics(text, document, this.workspaceIndex));
      if (await pause()) {return undefined;}
    }
    if (getConfig<boolean>("unusedProps.enabled", true)) {
      diagnostics.push(...computeUnusedPropDiagnostics(text, document));
    }

    return diagnostics;
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.debounceTimers.values()) {
      clearTimeout(t);
    }
    this.debounceTimers.clear();
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = undefined;
    }
    this.background.clear();
    this.ready.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function isLuaDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "lua" || document.languageId === "luau";
}

async function computeMissingImportDiagnostics(
  text: string,
  document: vscode.TextDocument,
  workspaceIndex: WorkspaceIndex
): Promise<vscode.Diagnostic[]> {
  const out: vscode.Diagnostic[] = [];
  const calls = findDocumentCalls(text, workspaceIndex);

  const localBindings = collectLocalBindings(text);
  const reported = new Set<string>();

  for (const call of calls) {
    if (call.isStringLiteralName) {
      continue;
    }
    const name = call.className.split(".")[0];
    if (defaultPropsMap[name]) {
      continue;
    }
    if (localBindings.has(name)) {
      continue;
    }
    if (reported.has(name)) {
      continue;
    }

    const found = await workspaceIndex.findComponentFile(
      call.className,
      document.uri.toString()
    );
    if (!found) {
      continue;
    }

    reported.add(name);
    const range = new vscode.Range(
      document.positionAt(call.classNameStart),
      document.positionAt(call.classNameEnd)
    );
    const d = new vscode.Diagnostic(
      range,
      `\`${call.className}\` isn't imported in this file.`,
      vscode.DiagnosticSeverity.Information
    );
    d.code = DIAGNOSTIC_CODE.MissingImport;
    d.source = "luix";
    out.push(d);
  }

  return out;
}

function computeReservedNameDiagnostics(text: string): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  const scan = scanDocument(text, getAliasPartition());
  let lines: string[] | undefined;

  for (const info of scan.values()) {
    const base = info.annotations.extendsClass ?? info.detectedBase;
    if (!base) {
      continue;
    }
    const baseProps = new Set(flattenClassProps(base));
    if (baseProps.size === 0) {
      continue;
    }

    const annotatedNames = new Set(info.annotations.props);
    if (annotatedNames.size === 0) {
      continue;
    }

    lines ??= text.split("\n");
    for (let i = info.defLineIndex - 1; i >= 0; i--) {
      const line = lines[i];
      const m = /^(\s*)---\s*@prop\s+([A-Za-z_]\w*)/.exec(line);
      if (!m) {
        if (line.trimStart().startsWith("---")) {
          continue;
        }
        break;
      }
      const propName = m[2];
      if (!annotatedNames.has(propName) || !baseProps.has(propName)) {
        continue;
      }
      const start = line.indexOf(propName, m[1].length);
      const range = new vscode.Range(
        new vscode.Position(i, start),
        new vscode.Position(i, start + propName.length)
      );
      const d = new vscode.Diagnostic(
        range,
        `Prop \`${propName}\` shadows \`${base}.${propName}\` — when forwarded to the instance it'll set the property instead of staying as a component prop.`,
        vscode.DiagnosticSeverity.Warning
      );
      d.code = DIAGNOSTIC_CODE.ReservedName;
      d.source = "luix";
      out.push(d);
    }
  }

  return out;
}

function computeDeprecationDiagnostics(
  text: string,
  document: vscode.TextDocument,
  workspaceIndex: WorkspaceIndex
): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  const masked = applyMask(text, buildCodeMask(text));

  const propsRanges = collectPropsRanges(findDocumentCalls(text, workspaceIndex));
  const inProps = (offset: number) => containedIn(propsRanges, offset);

  // Deprecate all Font assignments on text classes; only enum literals support automatic conversion.
  for (const call of findDocumentCalls(text, workspaceIndex)) {
    if (
      !(call.isStringLiteralName || call.isDirectInstanceCall) ||
      call.propsBraceStart === undefined ||
      call.propsBraceEnd === undefined ||
      !isDeprecatedValidProp(call.className, "Font")
    ) {
      continue;
    }
    const bodyStart = call.propsBraceStart + 1;
    const entries = extractPropEntriesFromDocument(
      text,
      bodyStart,
      call.propsBraceEnd
    );
    for (const entry of entries) {
      if (entry.key !== "Font") {
        continue;
      }
      const range = new vscode.Range(
        document.positionAt(bodyStart + entry.keyStart),
        document.positionAt(bodyStart + entry.valueEnd)
      );
      const d = new vscode.Diagnostic(
        range,
        "`Font` is deprecated; prefer `FontFace` (`Font.fromName(...)`).",
        vscode.DiagnosticSeverity.Information
      );
      d.code = DIAGNOSTIC_CODE.DeprecatedFont;
      d.source = "luix";
      d.tags = [vscode.DiagnosticTag.Deprecated];
      out.push(d);
    }
  }

  const typoRe = /(?<![A-Za-z0-9_])TextColor(?!\d)\s*=/g;
  let t: RegExpExecArray | null;
  while ((t = typoRe.exec(masked)) !== null) {
    if (!inProps(t.index)) {
      continue;
    }
    const propStart = t.index;
    const propEnd = propStart + "TextColor".length;
    const range = new vscode.Range(
      document.positionAt(propStart),
      document.positionAt(propEnd)
    );
    const d = new vscode.Diagnostic(
      range,
      "`TextColor` is not a Roblox property — did you mean `TextColor3`?",
      vscode.DiagnosticSeverity.Warning
    );
    d.code = DIAGNOSTIC_CODE.TypoTextColor;
    d.source = "luix";
    out.push(d);
  }

  return out;
}

/** Props-table intervals sorted by start offset. */
interface PropsRange {
  start: number;
  end: number;
}

function collectPropsRanges(
  calls: CreateElementCall[]
): PropsRange[] {
  const out: PropsRange[] = [];
  for (const call of calls) {
    if (
      call.propsBraceStart === undefined ||
      call.propsBraceEnd === undefined
    ) {
      continue;
    }
    out.push({ start: call.propsBraceStart, end: call.propsBraceEnd });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

function containedIn(ranges: PropsRange[], offset: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = ranges[mid];
    if (offset < r.start) {
      hi = mid - 1;
    } else if (offset > r.end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  // Nested calls overlap, so an earlier range may still contain the offset.
  for (let i = Math.min(lo, ranges.length - 1); i >= 0; i--) {
    const r = ranges[i];
    if (r.start <= offset && offset <= r.end) {return true;}
    if (r.end < offset && i < ranges.length - 1) {break;}
  }
  return false;
}

export function computePropValidationDiagnostics(
  text: string,
  document: vscode.TextDocument,
  workspaceIndex?: WorkspaceIndex
): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  const aliases = getAliasPartition();
  const calls = findDocumentCalls(text, workspaceIndex);
  const components = scanDocument(text, aliases);

  for (const call of calls) {
    if (
      call.propsBraceStart === undefined ||
      call.propsBraceEnd === undefined
    ) {
      continue;
    }
    const bodyStart = call.propsBraceStart + 1;
    const propsBody = text.slice(bodyStart, call.propsBraceEnd);
    const entries = extractPropEntriesFromDocument(
      text,
      bodyStart,
      call.propsBraceEnd
    );
    if (entries.length === 0) {
      continue;
    }

    const seen = new Map<string, number>();
    for (const entry of entries) {
      const prev = seen.get(entry.key);
      if (prev !== undefined) {
        const start = document.positionAt(bodyStart + entry.keyStart);
        const end = document.positionAt(bodyStart + entry.keyEnd);
        const d = new vscode.Diagnostic(
          new vscode.Range(start, end),
          `Duplicate prop \`${entry.key}\` — the second assignment overwrites the first.`,
          vscode.DiagnosticSeverity.Warning
        );
        d.code = DIAGNOSTIC_CODE.DuplicateProp;
        d.source = "luix";
        out.push(d);
      } else {
        seen.set(entry.key, entry.keyStart);
      }
    }

    // CornerRadius overrides all individual corner radii.
    if ((call.isStringLiteralName || call.isDirectInstanceCall) && call.className === "UICorner") {
      const overridden = new Set(
        cornerRadiusConflicts(entries.map((e) => e.key))
      );
      if (overridden.size > 0) {
        for (const entry of entries) {
          if (!overridden.has(entry.key)) {
            continue;
          }
          const start = document.positionAt(bodyStart + entry.keyStart);
          const end = document.positionAt(bodyStart + entry.keyEnd);
          const d = new vscode.Diagnostic(
            new vscode.Range(start, end),
            `\`${entry.key}\` has no effect — \`CornerRadius\` overrides all four corners on \`UICorner\`. Use either \`CornerRadius\` or the individual corner radii, not both.`,
            vscode.DiagnosticSeverity.Warning
          );
          d.code = DIAGNOSTIC_CODE.CornerRadiusConflict;
          d.source = "luix";
          out.push(d);
        }
      } else {
        const plan = planUICornerRefactor(
          entries.map((e) => ({
            key: e.key,
            valueText: propsBody.slice(e.valueStart, e.valueEnd),
          }))
        );
        if (plan?.kind === "collapse") {
          const spanStart =
            bodyStart + Math.min(...entries.map((e) => e.keyStart));
          const spanEnd =
            bodyStart + Math.max(...entries.map((e) => e.valueEnd));
          const d = new vscode.Diagnostic(
            new vscode.Range(
              document.positionAt(spanStart),
              document.positionAt(spanEnd)
            ),
            "All four corner radii are equal — collapse to a single `CornerRadius`?",
            vscode.DiagnosticSeverity.Information
          );
          d.code = DIAGNOSTIC_CODE.CornerRadiusCollapsible;
          d.source = "luix";
          (d as vscode.Diagnostic & { _luixData?: unknown })._luixData = {
            value: plan.value,
          };
          out.push(d);
        }
      }
    }

    if ((call.isStringLiteralName || call.isDirectInstanceCall) && defaultPropsMap[call.className]) {
      const known = new Set(flattenClassProps(call.className));
      // Vide event names are valid plain props; computed event keys are excluded by the scanner.
      const framework = call.isDirectInstanceCall ? FRAMEWORKS.vide
        : call.alias ? findFrameworkForAlias(call.alias) : undefined;
      if (framework?.eventsAsProps) {
        for (const event of flattenClassEvents(call.className)) {
          known.add(event);
        }
      }
      // Parent is accepted per framework rather than through the shared class hierarchy.
      if (framework?.parentAsProp) {
        known.add("Parent");
      }
      for (const entry of entries) {
        if (known.has(entry.key)) {
          // Prop types can differ by class, such as Frame.Style and GuiButton.Style.
          const expected = getPropType(call.className, entry.key);
          if (expected && expected.startsWith("Enum.")) {
            const valueText = propsBody
              .slice(entry.valueStart, entry.valueEnd)
              .trim();
            const m = /^Enum\.([A-Za-z_]\w*)/.exec(valueText);
            if (m && `Enum.${m[1]}` !== expected) {
              const vStart = document.positionAt(bodyStart + entry.valueStart);
              const vEnd = document.positionAt(bodyStart + entry.valueEnd);
              const d = new vscode.Diagnostic(
                new vscode.Range(vStart, vEnd),
                `\`${call.className}.${entry.key}\` expects \`${expected}\`, got \`Enum.${m[1]}\`.`,
                vscode.DiagnosticSeverity.Warning
              );
              d.code = DIAGNOSTIC_CODE.WrongEnumType;
              d.source = "luix";
              out.push(d);
            }
          }
          continue;
        }
        if (isFrameworkSpecialKey(entry.key)) {
          continue;
        }
        // Deprecated properties remain valid; the deprecation rule handles their migration hints.
        if (isDeprecatedValidProp(call.className, entry.key)) {
          continue;
        }
        const suggestion = closestMatch(entry.key, known);
        const start = document.positionAt(bodyStart + entry.keyStart);
        const end = document.positionAt(bodyStart + entry.keyEnd);
        let msg = suggestion
          ? `Unknown property \`${entry.key}\` on \`${call.className}\`. Did you mean \`${suggestion}\`?`
          : `Unknown property \`${entry.key}\` on \`${call.className}\`.`;
        // Parent is real, but React/Roact mount through roots or portals.
        if (entry.key === "Parent" && framework && !framework.parentAsProp) {
          msg = `Unknown property \`Parent\` on \`${call.className}\`. ${
            framework.id === "roact" ? "Roact" : "React"
          } mounts through a root or portal instead of a \`Parent\` key.`;
        }
        const d = new vscode.Diagnostic(
          new vscode.Range(start, end),
          msg,
          vscode.DiagnosticSeverity.Warning
        );
        d.code = DIAGNOSTIC_CODE.UnknownProp;
        d.source = "luix";
        out.push(d);
      }
    }

    for (const entry of entries) {
      const range = NUMERIC_RANGES[entry.key];
      if (!range) {continue;}
      const value = propsBody
        .slice(entry.valueStart, entry.valueEnd)
        .trim();
      const num = Number(value);
      if (!Number.isFinite(num)) {continue;}
      if (num < range.min || num > range.max) {
        const start = document.positionAt(bodyStart + entry.valueStart);
        const end = document.positionAt(bodyStart + entry.valueEnd);
        const d = new vscode.Diagnostic(
          new vscode.Range(start, end),
          `\`${entry.key}\` is typically in \`${range.min}..${range.max}\` — got \`${num}\`.`,
          vscode.DiagnosticSeverity.Warning
        );
        d.code = DIAGNOSTIC_CODE.NumericRange;
        d.source = "luix";
        out.push(d);
      }
    }

    {
      const posEntry = entries.find((e) => e.key === "Position");
      const apEntry = entries.find((e) => e.key === "AnchorPoint");
      if (posEntry && !apEntry) {
        const value = propsBody
          .slice(posEntry.valueStart, posEntry.valueEnd)
          .trim();
        const detected = detectExtremeScale(value);
        if (detected) {
          const start = document.positionAt(bodyStart + posEntry.keyStart);
          const end = document.positionAt(bodyStart + posEntry.keyEnd);
          const d = new vscode.Diagnostic(
            new vscode.Range(start, end),
            `\`Position\` uses scale ${formatPair(detected)} but no \`AnchorPoint\` is set — the element's top-left will land there instead of its center/corner. Add \`AnchorPoint = Vector2.new(${formatPair(detected)})\`?`,
            vscode.DiagnosticSeverity.Information
          );
          d.code = DIAGNOSTIC_CODE.MissingAnchorPoint;
          d.source = "luix";
          // Carry the suggested values to the quick-fix without reparsing.
          (d as vscode.Diagnostic & { _luixData?: unknown })._luixData = {
            anchorX: detected.x,
            anchorY: detected.y,
          };
          out.push(d);
        }
      }
    }

    if (!call.isStringLiteralName && !call.isDirectInstanceCall) {
      const component = components.get(
        call.className.split(".").pop() ?? call.className
      );
      const hardcoded = component?.hardcodedProps;
      if (hardcoded && hardcoded.size > 0) {
        for (const entry of entries) {
          if (!hardcoded.has(entry.key)) {
            continue;
          }
          const start = document.positionAt(bodyStart + entry.keyStart);
          const end = document.positionAt(bodyStart + entry.keyEnd);
          const d = new vscode.Diagnostic(
            new vscode.Range(start, end),
            `\`${entry.key}\` is hard-coded inside \`${component.name}\` and won't be overridden by this value.`,
            vscode.DiagnosticSeverity.Information
          );
          d.code = DIAGNOSTIC_CODE.OverriddenByComponent;
          d.source = "luix";
          out.push(d);
        }
      }
    }
  }

  return out;
}

/** Return scale channels at 0.5 or 1, where a matching AnchorPoint is usually needed. */
function detectExtremeScale(
  value: string
): { x: number; y: number } | undefined {
  const e = value.replace(/\s+/g, "");
  let m = /^UDim2\.fromScale\((-?[\d.]+),(-?[\d.]+)\)$/.exec(e);
  if (m) {
    const x = parseFloat(m[1]);
    const y = parseFloat(m[2]);
    return looksWorthFlagging(x, y) ? { x, y } : undefined;
  }
  m = /^UDim2\.new\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)$/.exec(e);
  if (m) {
    const x = parseFloat(m[1]);
    const y = parseFloat(m[3]);
    return looksWorthFlagging(x, y) ? { x, y } : undefined;
  }
  return undefined;
}

function looksWorthFlagging(x: number, y: number): boolean {
  const isExtreme = (n: number) => n === 0.5 || n === 1;
  return isExtreme(x) || isExtreme(y);
}

function formatPair(p: { x: number; y: number }): string {
  const fmt = (n: number) =>
    Number.isInteger(n) ? n.toString() : n.toString();
  return `${fmt(p.x)}, ${fmt(p.y)}`;
}

/** Mostly Roblox limits; Rotation and ZIndex bounds are conservative typo thresholds. */
const NUMERIC_RANGES: Record<string, { min: number; max: number }> = {
  BackgroundTransparency: { min: 0, max: 1 },
  TextTransparency: { min: 0, max: 1 },
  TextStrokeTransparency: { min: 0, max: 1 },
  ImageTransparency: { min: 0, max: 1 },
  ScrollBarImageTransparency: { min: 0, max: 1 },
  GroupTransparency: { min: 0, max: 1 },
  Transparency: { min: 0, max: 1 },
  TextSize: { min: 1, max: 100 },
  MinTextSize: { min: 1, max: 100 },
  MaxTextSize: { min: 1, max: 100 },
  Rotation: { min: -360, max: 360 },
  LineHeight: { min: 1, max: 3 },
  BorderSizePixel: { min: 0, max: 32 },
  ScrollBarThickness: { min: 0, max: 50 },
  ZIndex: { min: -2_000_000, max: 2_000_000 },
  LayoutOrder: { min: -1_000_000, max: 1_000_000 },
};

// WCAG AA contrast threshold for normal text.

const WCAG_AA_THRESHOLD = 4.5;

export function computeContrastDiagnostics(
  text: string,
  document: vscode.TextDocument,
  workspaceIndex?: WorkspaceIndex
): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  const calls = findDocumentCalls(text, workspaceIndex);
  if (calls.length === 0) {return out;}
  const tree = buildCallTree(calls);

  const visit = (
    node: CallTreeNode,
    inheritedBg: { r: number; g: number; b: number } | undefined
  ): void => {
    const host = node.call.isStringLiteralName || node.call.isDirectInstanceCall;
    const ownBg = readColor3Prop(node.call, text, "BackgroundColor3");
    const transparency = readTransparency(node.call, text, "BackgroundTransparency");
    // Custom components and runtime opacity obscure the background; transparent hosts inherit it.
    const bgForChildren = !host ? undefined
      : transparency === 1 ? inheritedBg
        : compositeColor(ownBg, inheritedBg, transparency);
    if (host && isTextClass(node.call.className)) {
      const fg = readColor3Prop(node.call, text, "TextColor3");
      const textTransparency = readTransparency(node.call, text, "TextTransparency");
      const visibleFg = compositeColor(fg, bgForChildren, textTransparency);
      if (visibleFg && bgForChildren && textTransparency !== 1) {
        const ratio = contrastRatio(visibleFg, bgForChildren);
        if (ratio < WCAG_AA_THRESHOLD) {
          const key = findKeyRange(node.call, text, "TextColor3");
          if (key) {
            const start = document.positionAt(key.start);
            const end = document.positionAt(key.end);
            const d = new vscode.Diagnostic(
              new vscode.Range(start, end),
              `Low contrast: text vs visible background = ${ratio.toFixed(2)}:1 (WCAG-AA requires ≥ 4.5:1 for normal text).`,
              vscode.DiagnosticSeverity.Warning
            );
            d.code = DIAGNOSTIC_CODE.LowContrast;
            d.source = "luix";
            out.push(d);
          }
        }
      }
    }
    for (const child of node.children) {
      visit(child, bgForChildren);
    }
  };
  for (const root of tree) {
    visit(root, undefined);
  }
  return out;
}

const TEXT_CLASSES = new Set(["TextLabel", "TextButton", "TextBox"]);

type RGB = { r: number; g: number; b: number };

function compositeColor(
  foreground: RGB | undefined,
  background: RGB | undefined,
  transparency: number | undefined
): RGB | undefined {
  if (transparency === 1) {return background;}
  if (!foreground || transparency === undefined) {return undefined;}
  if (transparency === 0) {return foreground;}
  if (!background) {return undefined;}
  const channel = (key: keyof RGB) =>
    foreground[key] * (1 - transparency) + background[key] * transparency;
  return { r: channel("r"), g: channel("g"), b: channel("b") };
}

function readTransparency(call: CreateElementCall, text: string, key: string): number | undefined {
  if (call.propsBraceStart === undefined || call.propsBraceEnd === undefined) {return undefined;}
  const bodyStart = call.propsBraceStart + 1;
  const entry = extractPropEntriesFromDocument(text, bodyStart, call.propsBraceEnd)
    .find((value) => value.key === key);
  if (!entry) {return 0;}
  const value = text.slice(bodyStart + entry.valueStart, bodyStart + entry.valueEnd).trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) {return undefined;}
  const number = Number(value);
  return number >= 0 && number <= 1 ? number : undefined;
}
function isTextClass(name: string): boolean {
  return TEXT_CLASSES.has(name);
}

function readColor3Prop(
  call: CreateElementCall,
  text: string,
  key: string
): { r: number; g: number; b: number } | undefined {
  if (call.propsBraceStart === undefined || call.propsBraceEnd === undefined) {
    return undefined;
  }
  const body = text.slice(call.propsBraceStart + 1, call.propsBraceEnd);
  const entries = extractPropEntriesFromDocument(
    text,
    call.propsBraceStart + 1,
    call.propsBraceEnd
  );
  const entry = entries.find((e) => e.key === key);
  if (!entry) {return undefined;}
  const value = body.slice(entry.valueStart, entry.valueEnd).trim();
  if (!/^Color3\./.test(value)) {return undefined;}
  const masked = applyMask(value, buildCodeMask(value));
  const lits = extractColorLiterals(masked, value);
  if (lits[0]) {
    return { r: lits[0].r, g: lits[0].g, b: lits[0].b };
  }
  return undefined;
}

function findKeyRange(
  call: CreateElementCall,
  text: string,
  key: string
): { start: number; end: number } | undefined {
  if (call.propsBraceStart === undefined || call.propsBraceEnd === undefined) {
    return undefined;
  }
  const entries = extractPropEntriesFromDocument(
    text,
    call.propsBraceStart + 1,
    call.propsBraceEnd
  );
  const entry = entries.find((e) => e.key === key);
  if (!entry) {return undefined;}
  return {
    start: call.propsBraceStart + 1 + entry.keyStart,
    end: call.propsBraceStart + 1 + entry.keyEnd,
  };
}

function relativeLuminance(c: { r: number; g: number; b: number }): number {
  const f = (x: number) =>
    x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrastRatio(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Computed keys are filtered by the scanner; bare framework keys still need an exemption. */
function isFrameworkSpecialKey(key: string): boolean {
  return key === "Children" || key === "key" || key === "ref";
}

/** Find the nearest prop name within max edits, or return undefined. */
function closestMatch(
  input: string,
  candidates: Set<string>
): string | undefined {
  let best: string | undefined;
  let bestDist = Math.min(3, Math.floor(input.length / 2) + 1);
  for (const c of candidates) {
    if (Math.abs(c.length - input.length) > bestDist) {
      continue;
    }
    const d = levenshtein(input, c, bestDist);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function levenshtein(a: string, b: string, limit: number): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > limit) {
    return limit + 1;
  }
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
      if (curr[j] < rowMin) {
        rowMin = curr[j];
      }
    }
    if (rowMin > limit) {
      return limit + 1;
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

const RICH_TEXT_TAG_PATTERN =
  /<\s*\/?\s*(b|i|u|s|sc|smallcaps|uppercase|sub|sup|comment|br|font|stroke|mark)\b/i;

export function computeMissingRichTextDiagnostics(
  text: string,
  document: vscode.TextDocument,
  workspaceIndex?: WorkspaceIndex
): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  const calls = findDocumentCalls(text, workspaceIndex);
  for (const call of calls) {
    if (
      call.propsBraceStart === undefined ||
      call.propsBraceEnd === undefined
    ) {
      continue;
    }
    const bodyStart = call.propsBraceStart + 1;
    const propsBody = text.slice(bodyStart, call.propsBraceEnd);
    const entries = extractPropEntriesFromDocument(
      text,
      bodyStart,
      call.propsBraceEnd
    );

    let textEntry: { keyStart: number; keyEnd: number } | undefined;
    // RichText may be reactive, so any explicit value suppresses this warning.
    let hasRichTextKey = false;
    for (const entry of entries) {
      if (entry.key === "Text") {
        const value = propsBody
          .slice(entry.valueStart, entry.valueEnd)
          .trim();
        const isStringLiteral =
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith("`") && value.endsWith("`"));
        if (isStringLiteral && RICH_TEXT_TAG_PATTERN.test(value)) {
          textEntry = { keyStart: entry.keyStart, keyEnd: entry.keyEnd };
        }
      } else if (entry.key === "RichText") {
        hasRichTextKey = true;
      }
    }
    if (!textEntry || hasRichTextKey) {
      continue;
    }
    const start = document.positionAt(bodyStart + textEntry.keyStart);
    const end = document.positionAt(bodyStart + textEntry.keyEnd);
    const d = new vscode.Diagnostic(
      new vscode.Range(start, end),
      "`Text` contains RichText tags but `RichText = true` isn't set — Roblox will render the tags as literal characters.",
      vscode.DiagnosticSeverity.Warning
    );
    d.code = DIAGNOSTIC_CODE.MissingRichText;
    d.source = "luix";
    out.push(d);
  }
  return out;
}

// Skip unused-prop warnings when the entire props table is forwarded.
function computeUnusedPropDiagnostics(
  text: string,
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  const aliases = getAliasPartition();
  const components = scanDocument(text, aliases);
  const mask = buildCodeMask(text);
  const masked = applyMask(text, mask);

  for (const component of components.values()) {
    const paramName = component.paramName;
    if (
      !paramName ||
      component.bodyStart === undefined ||
      component.bodyEnd === undefined
    ) {
      continue;
    }

    const declared = new Set<string>();
    if (component.paramTypeFields) {
      for (const f of component.paramTypeFields) {
        declared.add(f);
      }
    }
    for (const f of component.annotations.props) {
      declared.add(f);
    }
    if (declared.size === 0) {
      continue;
    }

    const bodyMasked = masked.slice(component.bodyStart, component.bodyEnd);
    const bodyOriginal = text.slice(component.bodyStart, component.bodyEnd);
    if (forwardsPropsWholesale(bodyMasked, bodyOriginal, paramName)) {
      continue;
    }

    const used = collectPropAccesses(bodyMasked, bodyOriginal, paramName);

    const typeAnnotation =
      component.paramTypeStart !== undefined &&
      component.paramTypeEnd !== undefined
        ? masked.slice(component.paramTypeStart, component.paramTypeEnd)
        : "";
    const typeAnnotationBase = component.paramTypeStart ?? 0;

    for (const prop of declared) {
      if (used.has(prop)) {
        continue;
      }
      let range: vscode.Range | undefined;
      if (typeAnnotation) {
        const re = new RegExp(
          `\\b${escapeRegExp(prop)}\\b(?=\\s*\\??\\s*:)`
        );
        const m = re.exec(typeAnnotation);
        if (m) {
          const startOff = typeAnnotationBase + m.index;
          range = new vscode.Range(
            document.positionAt(startOff),
            document.positionAt(startOff + prop.length)
          );
        }
      }
      if (!range) {
        const line = document.lineAt(component.defLineIndex);
        range = line.range;
      }

      const d = new vscode.Diagnostic(
        range,
        `Prop \`${prop}\` is declared on \`${component.name}\` but never read in its body.`,
        vscode.DiagnosticSeverity.Hint
      );
      d.code = DIAGNOSTIC_CODE.UnusedProp;
      d.source = "luix";
      d.tags = [vscode.DiagnosticTag.Unnecessary];
      out.push(d);
    }
  }

  return out;
}

/** Detect forwarding or dynamic indexing that prevents proving which props are read. */
function forwardsPropsWholesale(
  bodyMasked: string,
  bodyOriginal: string,
  paramName: string
): boolean {
  const pn = escapeRegExp(paramName);
  const re = new RegExp(`(?<![A-Za-z0-9_])${pn}(?![A-Za-z0-9_])`, "g");
  const len = bodyMasked.length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyMasked)) !== null) {
    // Avoid repeated slicing, which makes large-body scans quadratic.
    let i = m.index + paramName.length;
    while (i < len) {
      const ch = bodyMasked.charCodeAt(i);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        i++;
        continue;
      }
      break;
    }
    const c = bodyMasked[i];
    if (c === "." || c === ":") {
      continue;
    }
    if (c === "[") {
      // Only static string keys can be tracked; other indexing counts as wholesale forwarding.
      let j = i + 1;
      while (j < len) {
        const ch = bodyOriginal.charCodeAt(j);
        if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
          j++;
          continue;
        }
        break;
      }
      const opener = bodyOriginal[j];
      if (opener === '"' || opener === "'" || opener === "`") {
        continue;
      }
      return true;
    }
    return true;
  }
  return false;
}

function collectPropAccesses(
  bodyMasked: string,
  bodyOriginal: string,
  paramName: string
): Set<string> {
  const used = new Set<string>();
  const pn = escapeRegExp(paramName);

  const dotRe = new RegExp(
    `(?<![A-Za-z0-9_])${pn}\\.([A-Za-z_][A-Za-z0-9_]*)`,
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = dotRe.exec(bodyMasked)) !== null) {
    used.add(m[1]);
  }

  // Read string keys from the original text because masking removes their contents.
  const bracketRe = new RegExp(
    `(?<![A-Za-z0-9_])${pn}\\s*\\[\\s*(["'\`])([^"'\`\\n]+)\\1\\s*\\]`,
    "g"
  );
  while ((m = bracketRe.exec(bodyOriginal)) !== null) {
    used.add(m[2]);
  }

  return used;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
