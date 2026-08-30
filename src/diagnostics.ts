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
  AliasPartition,
  applyMask,
  buildCallTree,
  buildCodeMask,
  CallTreeNode,
  CreateElementCall,
  extractColorLiterals,
  extractPropEntries,
  extractPropEntriesFromDocument,
  findAllCreateElementCalls,
  scanDocument,
  collectLocalBindings,
} from "./parser";
import { getAutoImportConfig } from "./config";
import { configChangeAffects, getConfig } from "./configCompat";
import { findFrameworkForAlias, getAliasPartition } from "./frameworks";
import { WorkspaceIndex } from "./workspaceIndex";
import { planUICornerRefactor } from "./uiCorner";

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
  TextScaledGotcha: "luix.text-scaled-gotcha",
  LowContrast: "luix.low-contrast",
  UnusedProp: "luix.unused-prop",
  CornerRadiusConflict: "luix.corner-radius-conflict",
  CornerRadiusCollapsible: "luix.corner-radius-collapsible",
} as const;

export class DiagnosticsManager implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;
  private disposables: vscode.Disposable[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly workspaceIndex: WorkspaceIndex) {
    this.collection = vscode.languages.createDiagnosticCollection("luix");
    this.disposables.push(this.collection);
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((d) => {
        void this.maybeRefresh(d);
      }),
      vscode.workspace.onDidChangeTextDocument((e) =>
        this.scheduleRefresh(e.document)
      ),
      vscode.workspace.onDidCloseTextDocument((d) =>
        this.collection.delete(d.uri)
      ),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          // Diagnostic-feature toggles.
          configChangeAffects(e, "warnReservedPropNames") ||
          configChangeAffects(e, "deprecationDiagnostics") ||
          configChangeAffects(e, "autoImport") ||
          configChangeAffects(e, "propValidation") ||
          configChangeAffects(e, "richText") ||
          configChangeAffects(e, "contrastWarnings") ||
          configChangeAffects(e, "unusedProps") ||
          // Framework / alias keys — without these, enabling Vide at
          // runtime wouldn't make `New "Frame" { … }` start linting
          // until the next keystroke in each open file. Union with the
          // list `WorkspaceIndex` watches so the two stay aligned.
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
      void this.maybeRefresh(doc);
    }
  }

  private scheduleRefresh(document: vscode.TextDocument): void {
    // Filter at scheduling time so non-Lua keystrokes don't spin up
    // (and leak) debounce timers in `debounceTimers` forever.
    if (document.languageId !== "lua" && document.languageId !== "luau") {
      return;
    }
    const key = document.uri.toString();
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const t = setTimeout(() => {
      this.debounceTimers.delete(key);
      void this.maybeRefresh(document);
    }, 200);
    this.debounceTimers.set(key, t);
  }

  private async maybeRefresh(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== "lua" && document.languageId !== "luau") {
      return;
    }
    const diags = await this.computeDiagnostics(document);
    this.collection.set(document.uri, diags);
  }

  private async computeDiagnostics(
    document: vscode.TextDocument
  ): Promise<vscode.Diagnostic[]> {
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

    if (warnReserved) {
      diagnostics.push(...computeReservedNameDiagnostics(text));
    }
    if (warnDeprecation) {
      diagnostics.push(
        ...computeDeprecationDiagnostics(text, document, this.workspaceIndex)
      );
    }
    if (autoImport.enabled) {
      diagnostics.push(
        ...(await computeMissingImportDiagnostics(
          text,
          document,
          this.workspaceIndex
        ))
      );
    }
    if (getConfig<boolean>("propValidation.enabled", true)) {
      diagnostics.push(...computePropValidationDiagnostics(text, document));
    }
    if (getConfig<boolean>("richText.enabled", true)) {
      diagnostics.push(...computeMissingRichTextDiagnostics(text, document));
    }
    if (getConfig<boolean>("contrastWarnings.enabled", false)) {
      diagnostics.push(...computeContrastDiagnostics(text, document));
    }
    if (getConfig<boolean>("unusedProps.enabled", true)) {
      diagnostics.push(...computeUnusedPropDiagnostics(text, document));
    }

    return diagnostics;
  }

  dispose(): void {
    for (const t of this.debounceTimers.values()) {
      clearTimeout(t);
    }
    this.debounceTimers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

async function computeMissingImportDiagnostics(
  text: string,
  document: vscode.TextDocument,
  workspaceIndex: WorkspaceIndex
): Promise<vscode.Diagnostic[]> {
  const out: vscode.Diagnostic[] = [];
  const aliases = getAliasPartition();
  const calls = findAllCreateElementCalls(text, aliases);

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

    const lines = text.split("\n");
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
  const aliases = getAliasPartition();

  // Compute every props-table range *once* up front instead of doing a
  // backward brace-walk per regex match. The old `findEnclosingPropsCall`
  // dispatch inside the loop was O(matches × N) per keystroke on big
  // files; this is O(N + matches·log(C)).
  const propsRanges = collectPropsRanges(text, aliases);
  const inProps = (offset: number) => containedIn(propsRanges, offset);

  // `Font` is deprecated in favour of `FontFace` — flag ANY assignment
  // to it (`Font = Enum.Font.X`, `Font = "Gotham"`, `Font = someVar`),
  // not just the enum-literal form. Scoped to classes that actually
  // HAVE a `Font` property (the text family) via `isDeprecatedValidProp`
  // — on other classes `Font` is genuinely unknown and the prop
  // validator handles it. The quick-fix only offers the auto-convert for
  // the `Enum.Font.X` form (see `DeprecationCodeActionProvider`).
  for (const call of findAllCreateElementCalls(text, aliases)) {
    if (
      !call.isStringLiteralName ||
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

  // `TextColor = ...` (missing the trailing `3`) inside a props table.
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

/**
 * Sorted intervals (by `start`) of every props-table body in the
 * document — one entry per createElement-style call that has a props
 * brace. Built once per diagnostic recompute and queried via
 * `containedIn` for each diagnostic regex match. Replaces a per-match
 * `findEnclosingPropsCall` walk that was O(matches × document).
 */
interface PropsRange {
  start: number;
  end: number;
}

function collectPropsRanges(
  text: string,
  aliases: AliasPartition
): PropsRange[] {
  const out: PropsRange[] = [];
  for (const call of findAllCreateElementCalls(text, aliases)) {
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

/**
 * Binary-search containment check — returns true iff `offset` is
 * inside at least one of the (sorted-by-start) ranges. Used by the
 * diagnostic regex loops above; runs in O(log N) per query versus the
 * old O(N) brace walk.
 */
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
  // Nested calls mean ranges can overlap — if the binary search landed
  // in a sibling, walk back through any earlier range that still
  // contains the offset. In practice this loops at most O(nesting
  // depth) ≈ 5-10.
  for (let i = Math.min(lo, ranges.length - 1); i >= 0; i--) {
    const r = ranges[i];
    if (r.start <= offset && offset <= r.end) return true;
    if (r.end < offset && i < ranges.length - 1) break;
  }
  return false;
}

// ============================================================================
// Prop validation — unknown / duplicate / wrong-enum / overridden-by-component
// ============================================================================

function computePropValidationDiagnostics(
  text: string,
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  const aliases = getAliasPartition();
  const calls = findAllCreateElementCalls(text, aliases);
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

    // ---- Duplicate keys ----
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

    // ---- UICorner: CornerRadius vs individual corner radii ----
    // `CornerRadius` sets all four corners and overrides the individual
    // `BottomLeftRadius` / … properties, so setting both is a mistake —
    // the individual ones silently do nothing. Flag each dead one.
    if (call.isStringLiteralName && call.className === "UICorner") {
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
        // No conflict — if all four individual radii are equal (and
        // there's no CornerRadius), suggest collapsing them into one
        // `CornerRadius`, the way the AnchorPoint hint nudges a fix. The
        // quick-fix (in DeprecationCodeActionProvider) reads the stashed
        // value and replaces this range.
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

    // ---- Unknown / wrong-enum (Roblox host class only) ----
    if (call.isStringLiteralName && defaultPropsMap[call.className]) {
      const known = new Set(flattenClassProps(call.className));
      // Frameworks that take events as plain table keys (Vide:
      // `Activated = function() … end`) put event names in the same
      // props table. Completion already merges them (see
      // `completion.ts`); mirror that here so they aren't flagged
      // "Unknown property" (issue #4). React/Roact/Fusion spell events
      // as computed keys, which the entry scanner never yields.
      const framework = call.alias
        ? findFrameworkForAlias(call.alias)
        : undefined;
      if (framework?.eventsAsProps) {
        for (const event of flattenClassEvents(call.className)) {
          known.add(event);
        }
      }
      for (const entry of entries) {
        if (known.has(entry.key)) {
          // Check enum type, if we know one. Use class-aware lookup so
          // props with class-specific types (e.g. Frame.Style vs
          // GuiButton.Style) get the right expected enum.
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
        // Unknown — but skip framework-special keys.
        if (isFrameworkSpecialKey(entry.key)) {
          continue;
        }
        // Skip deprecated-but-valid props (e.g. `Font` on text classes).
        // They're real properties kept out of the suggestion list to
        // nudge `FontFace`, but the code is valid — flagging them
        // "Unknown property" is a false positive (issue #2). The
        // separate deprecation diagnostic handles the migration hint.
        if (isDeprecatedValidProp(call.className, entry.key)) {
          continue;
        }
        const suggestion = closestMatch(entry.key, known);
        const start = document.positionAt(bodyStart + entry.keyStart);
        const end = document.positionAt(bodyStart + entry.keyEnd);
        const msg = suggestion
          ? `Unknown property \`${entry.key}\` on \`${call.className}\`. Did you mean \`${suggestion}\`?`
          : `Unknown property \`${entry.key}\` on \`${call.className}\`.`;
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

    // ---- Numeric-range warnings ----
    for (const entry of entries) {
      const range = NUMERIC_RANGES[entry.key];
      if (!range) continue;
      const value = propsBody
        .slice(entry.valueStart, entry.valueEnd)
        .trim();
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
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

    // ---- TextScaled gotcha ----
    // `TextScaled = true` requires at least one Size axis to be a
    // fixed pixel offset (or `AutomaticSize` covering the other axis).
    // When Size is `UDim2.fromScale(...)` only — or missing entirely
    // — the text auto-scales toward zero and disappears.
    {
      const textScaledEntry = entries.find((e) => e.key === "TextScaled");
      if (textScaledEntry) {
        const value = propsBody
          .slice(textScaledEntry.valueStart, textScaledEntry.valueEnd)
          .trim();
        if (value === "true") {
          const sizeEntry = entries.find((e) => e.key === "Size");
          const sizeValue = sizeEntry
            ? propsBody
                .slice(sizeEntry.valueStart, sizeEntry.valueEnd)
                .trim()
            : "";
          if (looksScaleOnly(sizeValue) && !hasAutomaticSize(entries, propsBody)) {
            const startPos = document.positionAt(
              bodyStart + textScaledEntry.keyStart
            );
            const endPos = document.positionAt(
              bodyStart + textScaledEntry.keyEnd
            );
            const d = new vscode.Diagnostic(
              new vscode.Range(startPos, endPos),
              "`TextScaled = true` needs a `Size` with at least one fixed-offset axis (e.g. `UDim2.new(0, X, 0, Y)`) or `AutomaticSize` to render text — pure-scale sizes can collapse to zero.",
              vscode.DiagnosticSeverity.Warning
            );
            d.code = DIAGNOSTIC_CODE.TextScaledGotcha;
            d.source = "luix";
            out.push(d);
          }
        }
      }
    }

    // ---- Missing AnchorPoint (Position uses scale 0.5 or 1) ----
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
          // Stash the suggested AnchorPoint values on the diagnostic so
          // the quick-fix doesn't have to re-parse the Position value.
          (d as vscode.Diagnostic & { _luixData?: unknown })._luixData = {
            anchorX: detected.x,
            anchorY: detected.y,
          };
          out.push(d);
        }
      }
    }

    // ---- Overridden-by-component ----
    if (!call.isStringLiteralName) {
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

/**
 * Inspect a Position RHS expression and return the scale pair if either
 * channel is `0.5` or `1` — those land the element's top-left at the
 * center / far edge, which is almost never what the author meant
 * without a matching AnchorPoint. Returns undefined for
 * `UDim2.fromOffset(...)` (no scale at all) and for `(0, 0)` scales
 * (already aligns with the default AnchorPoint).
 */
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

/**
 * Per-prop sensible numeric bounds. Anything outside warns. The ranges
 * are conservative — most are exact Roblox limits, a few (Rotation,
 * ZIndex) are "almost certainly a typo" thresholds rather than hard
 * caps.
 */
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

function looksScaleOnly(sizeValue: string): boolean {
  // Empty / missing → also scale-only for our purposes.
  if (!sizeValue) return true;
  const e = sizeValue.replace(/\s+/g, "");
  // `UDim2.fromScale(0.X, 0.Y)` or `(1, 1)` etc. — no offsets at all.
  if (/^UDim2\.fromScale\([-\d.]+,[-\d.]+\)$/.test(e)) {
    return true;
  }
  // `UDim2.new(s, 0, s, 0)` — explicit zero offsets.
  const m = /^UDim2\.new\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)$/.exec(e);
  if (m) {
    const xOffset = parseFloat(m[2]);
    const yOffset = parseFloat(m[4]);
    return xOffset === 0 && yOffset === 0;
  }
  return false;
}

function hasAutomaticSize(
  entries: Array<{ key: string; valueStart: number; valueEnd: number }>,
  body: string
): boolean {
  const entry = entries.find((e) => e.key === "AutomaticSize");
  if (!entry) return false;
  const v = body.slice(entry.valueStart, entry.valueEnd).trim();
  // Any non-`None` value covers at least one axis.
  return !/Enum\.AutomaticSize\.None\b/.test(v);
}

// ============================================================================
// Color contrast warnings (WCAG)
// ============================================================================
//
// Off by default. When enabled, scan each Text element's `TextColor3`
// against the nearest ancestor's `BackgroundColor3` and warn if the
// WCAG-AA contrast ratio is below 4.5:1 (the spec's threshold for
// "normal text"). Both colors must be literal Color3 expressions —
// reactive Fusion `Value`/`Computed` and Vide sources are skipped.

const WCAG_AA_THRESHOLD = 4.5;

function computeContrastDiagnostics(
  text: string,
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  const aliases = getAliasPartition();
  const calls = findAllCreateElementCalls(text, aliases);
  if (calls.length === 0) return out;
  const tree = buildCallTree(calls);

  // Walk the tree, carrying the nearest ancestor `BackgroundColor3`
  // down to each Text* element.
  const visit = (
    node: CallTreeNode,
    inheritedBg: { r: number; g: number; b: number } | undefined
  ): void => {
    const ownBg = readColor3Prop(node.call, text, "BackgroundColor3");
    const bgForChildren = ownBg ?? inheritedBg;
    if (isTextClass(node.call.className)) {
      const fg = readColor3Prop(node.call, text, "TextColor3");
      if (fg && bgForChildren) {
        const ratio = contrastRatio(fg, bgForChildren);
        if (ratio < WCAG_AA_THRESHOLD) {
          const key = findKeyRange(node.call, text, "TextColor3");
          if (key) {
            const start = document.positionAt(key.start);
            const end = document.positionAt(key.end);
            const d = new vscode.Diagnostic(
              new vscode.Range(start, end),
              `Low contrast: \`TextColor3\` vs ancestor \`BackgroundColor3\` = ${ratio.toFixed(2)}:1 (WCAG-AA requires ≥ 4.5:1 for normal text).`,
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
  if (!entry) return undefined;
  const value = body.slice(entry.valueStart, entry.valueEnd).trim();
  if (!/^Color3\./.test(value)) return undefined;
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
  if (!entry) return undefined;
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

/**
 * Keys that aren't real Roblox properties but appear in framework
 * idioms — `[Children]`, `[React.Event.X]`, `[React.Change.X]`, etc.
 * These show up as positional `[expr] = …` entries in the props table
 * (already filtered out by `extractPropEntries`), but identifier-shaped
 * keys like `Children` (Fusion's bare-name form) need an explicit pass.
 */
function isFrameworkSpecialKey(key: string): boolean {
  return key === "Children" || key === "key" || key === "ref";
}

/**
 * Levenshtein distance with an early exit. Returns the prop name that
 * differs from `input` by at most `max` edits, or undefined if no
 * candidate is close enough.
 */
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

// ============================================================================
// Missing-RichText warning
// ============================================================================
//
// If a props table sets `Text = "<...rich tags...>"` but the same table
// doesn't enable `RichText = true`, Roblox renders the tags as literal
// characters. We catch the obvious cases here so it stops biting people
// on first paste-from-docs.

const RICH_TEXT_TAG_PATTERN =
  /<\s*\/?\s*(b|i|u|s|sc|smallcaps|uppercase|sub|sup|comment|br|font|stroke|mark)\b/i;

function computeMissingRichTextDiagnostics(
  text: string,
  document: vscode.TextDocument
): vscode.Diagnostic[] {
  const out: vscode.Diagnostic[] = [];
  const aliases = getAliasPartition();
  const calls = findAllCreateElementCalls(text, aliases);
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
    // Suppress the warning whenever `RichText` appears at all — it
    // might be `true`, a Fusion `Value`, a Vide source, or a `Computed`
    // expression. We can't statically tell what those resolve to, and a
    // false positive is worse than a missed catch here.
    let hasRichTextKey = false;
    for (const entry of entries) {
      if (entry.key === "Text") {
        const value = propsBody
          .slice(entry.valueStart, entry.valueEnd)
          .trim();
        // Only flag string-literal Text values; if Text is a variable
        // or function call we can't tell what's inside, so stay silent.
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

// ============================================================================
// Unused-prop diagnostic
//
// For each component defined in the document, gather its declared props
// (from the parameter's type annotation or the `@luix-props` comment),
// then scan the body for `props.<Name>` / `props["<Name>"]` accesses. Any
// declared prop that's never read is flagged as Unnecessary (greyed-out
// like an unused-import in TS).
//
// Skipped when the component forwards `props` wholesale (e.g.
// `e(Base, props)`, `for k, v in props do`) since we can't tell which
// props the downstream code reads.
// ============================================================================
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

    // Locate each declared prop's position in the type annotation, if any.
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
      // Try to find the prop's declaration in the type annotation so
      // the squiggle/grey-out lands on the field name itself.
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
        // Fall back to the function definition line.
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

/**
 * Returns `true` if the component body uses `paramName` in a way that
 * prevents us from statically determining which props are read — e.g.
 * passing the table itself as an argument, iterating it, or indexing
 * with a non-literal key.
 */
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
    // Walk forward without slicing (slicing in a loop turns this into
    // O(N^2) on large bodies).
    let i = m.index + paramName.length;
    while (i < len) {
      const ch = bodyMasked.charCodeAt(i);
      // Skip ASCII whitespace inline.
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
      // Allow only static-string bracket access (handled later in
      // `collectPropAccesses`). Anything else (computed keys, numeric
      // indices) is wholesale forwarding.
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

/**
 * Collect every prop name read off of `paramName`:
 *   - `paramName.Foo`
 *   - `paramName["Foo"]` / `paramName['Foo']` / `paramName[\`Foo\`]`
 */
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

  // Bracket access with a static string key. The masked body has the
  // string interior blanked, so read from the original text instead.
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
