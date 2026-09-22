import * as vscode from "vscode";
import {
  ActiveFrameworkChoice,
  detectFrameworkForDocument,
  readActiveFrameworkSetting,
  resetDocumentDetectionCache,
} from "./activeFramework";
import { FrameworkId, getEnabledFrameworks } from "./frameworks";

// ============================================================================
// Status-bar item — "Luix: <framework>" with click-to-pick
// ============================================================================
//
// Always-visible (in Lua / Luau files) indicator of which framework
// Luix considers active for the current document, and a one-click
// picker to override.
//
// Right-aligned at priority 100 so it sits near other language
// indicators rather than getting buried in the left status bar with
// errors and git info.

const FRAMEWORK_LABELS: Record<FrameworkId, string> = {
  react: "React",
  roact: "Roact",
  fusion: "Fusion",
  vide: "Vide",
};

const SOURCE_LABELS: Record<
  ReturnType<typeof detectFrameworkForDocument>["source"],
  string
> = {
  override: "set by `luix.activeFramework`",
  import: "detected from `require(…)` import",
  call: "detected from factory call",
  workspace: "workspace default",
  none: "no UI framework detected",
};

const PICK_COMMAND = "luix.pickActiveFramework";

export class ActiveFrameworkStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  // Set in `dispose()` so post-await callers (the async workspace-
  // fallback refresh in extension.ts, debounced refresh timers) skip
  // touching the StatusBarItem after VS Code has disposed it.
  private disposed = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = PICK_COMMAND;
    this.disposables.push(this.item);

    // Refresh whenever the user moves between files or the active
    // file's content changes (debounced — typing fires
    // onDidChangeTextDocument hundreds of times).
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("luix")) {
          // Override changed — bust the per-document cache so every
          // subsequent detection picks up the new override, then
          // refresh the label.
          resetDocumentDetectionCache();
          this.refresh();
        }
      })
    );

    this.refresh();
  }

  /** Public re-render — useful after a setWorkspaceFallback() call. */
  refresh(): void {
    if (this.disposed) {return;}
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isLuaDoc(editor.document)) {
      this.item.hide();
      return;
    }
    const detection = detectFrameworkForDocument(editor.document);
    // Three visual states — distinct so a user can tell "Luix found
    // nothing" apart from "Luix is in auto mode and found React".
    //   - effective set                                 → "Luix: React" with namespace icon
    //   - effective undefined, override is "auto"       → "Luix: —" with circle-slash icon
    //                                                     (UI signals are off, no snippets fire)
    // Previously both cases rendered as "Luix: Auto" with no visual
    // distinction — confusing when snippets silently stopped working
    // in a brand-new empty file.
    const fwName = detection.effective
      ? FRAMEWORK_LABELS[detection.effective]
      : "—";
    const icon = detection.effective ? "symbol-namespace" : "circle-slash";
    this.item.text = `$(${icon}) Luix: ${fwName}`;
    const tooltipLines = [
      `**Luix active framework: ${fwName}**`,
      `*(${SOURCE_LABELS[detection.source]})*`,
    ];
    // Only show "auto-detection would pick X" when the override is
    // actually overriding something different — otherwise it's a
    // redundant restatement of the active framework.
    if (
      detection.source === "override" &&
      detection.detected &&
      detection.detected !== detection.effective
    ) {
      tooltipLines.push(
        "",
        `Auto-detection would pick **${FRAMEWORK_LABELS[detection.detected]}**.`
      );
    }
    // Warn when the user's override names a framework that isn't in
    // `luix.frameworks` — readOverride() ignores those, but the
    // setting itself still has the value, so we have to tell them.
    const requested = readActiveFrameworkSetting();
    if (
      requested &&
      detection.source !== "override" &&
      !getEnabledFrameworks().some((f) => f.id === requested)
    ) {
      tooltipLines.push(
        "",
        `⚠️ \`luix.activeFramework\` is set to **${FRAMEWORK_LABELS[requested]}** but that framework isn't in \`luix.frameworks\`, so it's been ignored.`
      );
    }
    tooltipLines.push("", "Click to override.");
    const tooltip = new vscode.MarkdownString(tooltipLines.join("\n"));
    tooltip.isTrusted = false;
    this.item.tooltip = tooltip;
    this.item.show();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {clearTimeout(this.refreshTimer);}
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, 250);
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const d of this.disposables) {d.dispose();}
    this.disposables = [];
  }

  /** True after dispose() — callers chained off async work check this
   *  before calling refresh() to avoid touching a disposed item. */
  isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * Command: prompt the user to pick a framework override, then write
 * it to `luix.activeFramework` at workspace scope. Falls back to
 * global scope when no workspace is open (with an explicit notice so
 * the user understands the scope they just bound).
 */
export async function pickActiveFrameworkCommand(): Promise<void> {
  type Pick = vscode.QuickPickItem & { value: ActiveFrameworkChoice };
  // Current selection + the auto-detected framework for the active
  // editor, so each option's description shows what it'll do
  // *relative to now* — and the current value is marked.
  const current = vscode.workspace
    .getConfiguration("luix")
    .get<ActiveFrameworkChoice>("activeFramework", "auto");
  const editor = vscode.window.activeTextEditor;
  const autoDetected =
    editor && (editor.document.languageId === "lua" || editor.document.languageId === "luau")
      ? detectFrameworkForDocument(editor.document).detected
      : undefined;
  const enabledIds = new Set(getEnabledFrameworks().map((f) => f.id));

  function describe(
    id: ActiveFrameworkChoice,
    base: string
  ): string {
    const parts: string[] = [base];
    if (id === current) {parts.push("• current");}
    if (id !== "auto" && !enabledIds.has(id as FrameworkId)) {
      parts.push("• not in luix.frameworks");
    }
    return parts.join("  ");
  }

  const items: Pick[] = [
    {
      label: "$(sparkle) Auto",
      description: describe(
        "auto",
        autoDetected
          ? `Detect per file — currently picks ${FRAMEWORK_LABELS[autoDetected]} here`
          : "Detect per file from imports / factory calls"
      ),
      value: "auto",
      picked: current === "auto",
    },
    {
      label: `$(symbol-namespace) ${FRAMEWORK_LABELS.react}`,
      description: describe("react", "Force React-Luau snippets and completions"),
      value: "react",
      picked: current === "react",
    },
    {
      label: `$(symbol-namespace) ${FRAMEWORK_LABELS.roact}`,
      description: describe("roact", "Force Roact snippets and completions"),
      value: "roact",
      picked: current === "roact",
    },
    {
      label: `$(symbol-namespace) ${FRAMEWORK_LABELS.fusion}`,
      description: describe("fusion", "Force Fusion snippets and completions"),
      value: "fusion",
      picked: current === "fusion",
    },
    {
      label: `$(symbol-namespace) ${FRAMEWORK_LABELS.vide}`,
      description: describe("vide", "Force Vide snippets and completions"),
      value: "vide",
      picked: current === "vide",
    },
  ];
  const choice = await vscode.window.showQuickPick(items, {
    title: "Luix: Active framework override",
    placeHolder:
      "Auto detects per file; the four named options force one framework everywhere.",
  });
  if (!choice) {return;}

  const config = vscode.workspace.getConfiguration("luix");
  const hasWorkspace = !!vscode.workspace.workspaceFolders?.length;
  const target = hasWorkspace
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  try {
    await config.update("activeFramework", choice.value, target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `Luix: couldn't save active-framework override — ${msg}`
    );
    return;
  }

  // Loud notification when writing to Global scope — otherwise a user
  // investigating one standalone .luau file who picks Roact has
  // silently set Roact globally for every other project they open.
  if (!hasWorkspace) {
    void vscode.window.showInformationMessage(
      `Luix: active framework set globally to ${
        choice.value === "auto" ? "Auto" : FRAMEWORK_LABELS[choice.value as FrameworkId]
      } (no workspace folder open to scope to).`,
      "Open Settings"
    ).then((action) => {
      if (action === "Open Settings") {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "luix.activeFramework"
        );
      }
    });
  }

  // Warn when the chosen framework isn't in `luix.frameworks` — the
  // override would be ignored downstream (readOverride() filters), so
  // the user would otherwise see no behaviour change at all.
  if (
    choice.value !== "auto" &&
    !enabledIds.has(choice.value as FrameworkId)
  ) {
    void vscode.window.showWarningMessage(
      `Luix: ${FRAMEWORK_LABELS[choice.value as FrameworkId]} isn't in \`luix.frameworks\`. Enable it there for the override to take effect.`,
      "Open Settings"
    ).then((action) => {
      if (action === "Open Settings") {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "luix.frameworks"
        );
      }
    });
  }
}

export const PICK_ACTIVE_FRAMEWORK_COMMAND = PICK_COMMAND;

function isLuaDoc(doc: vscode.TextDocument): boolean {
  return doc.languageId === "lua" || doc.languageId === "luau";
}
