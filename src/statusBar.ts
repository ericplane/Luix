import * as vscode from "vscode";
import {
  ActiveFrameworkChoice,
  detectFrameworkForDocument,
  readActiveFrameworkSetting,
  resetDocumentDetectionCache,
} from "./activeFramework";
import { FrameworkId, getEnabledFrameworks } from "./frameworks";

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
  // Guard async refreshes after disposal.
  private disposed = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = PICK_COMMAND;
    this.disposables.push(this.item);

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("luix")) {
          resetDocumentDetectionCache();
          this.refresh();
        }
      })
    );

    this.refresh();
  }

  refresh(): void {
    if (this.disposed) {return;}
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isLuaDoc(editor.document)) {
      this.item.hide();
      return;
    }
    const detection = detectFrameworkForDocument(editor.document);
    const fwName = detection.effective
      ? FRAMEWORK_LABELS[detection.effective]
      : "—";
    const icon = detection.effective ? "symbol-namespace" : "circle-slash";
    this.item.text = `$(${icon}) Luix: ${fwName}`;
    const tooltipLines = [
      `**Luix active framework: ${fwName}**`,
      `*(${SOURCE_LABELS[detection.source]})*`,
    ];
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
    // Report disabled overrides even though detection ignores them.
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

  isDisposed(): boolean {
    return this.disposed;
  }
}

export async function pickActiveFrameworkCommand(): Promise<void> {
  type Pick = vscode.QuickPickItem & { value: ActiveFrameworkChoice };
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

  // Make the global scope explicit when no workspace is open.
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

  // A disabled framework would make this override ineffective.
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
