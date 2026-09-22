import * as vscode from "vscode";
import { configChangeAffects, getConfig } from "./configCompat";

// ============================================================================
// Workspace-wide validation aggregator
// ============================================================================
//
// Off by default. When enabled, periodically walks every Lua/Luau file
// in the workspace and tallies the diagnostics VS Code has recorded
// for them (Luix's own diagnostics + anything else that publishes to
// the editor). Surfaces an `N warnings · M errors across X files`
// summary the sidebar can show.
//
// Cheap because we only LOOK at existing diagnostics; we don't run our
// computation against unopened files. VS Code lazily produces
// diagnostics for opened-but-since-closed documents and keeps them
// around per URI. For documents that have never been opened in the
// session, their count stays at zero (an honest understatement until
// the user touches them).

export interface ValidationSummary {
  warnings: number;
  errors: number;
  info: number;
  fileCount: number;
}

export class WorkspaceValidation implements vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;
  private summary: ValidationSummary = {
    warnings: 0,
    errors: 0,
    info: 0,
    fileCount: 0,
  };
  private refreshTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (configChangeAffects(e, "workspaceValidation")) {
          this.scheduleRefresh();
        }
      })
    );
    this.scheduleRefresh();
  }

  getSummary(): ValidationSummary {
    return this.summary;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {clearTimeout(this.refreshTimer);}
    // Aggressively debounced — diagnostic events fire constantly while
    // the user types and the totals don't change meaningfully per
    // keystroke.
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, 1000);
  }

  private refresh(): void {
    if (!getConfig<boolean>("workspaceValidation.enabled", false)) {
      const wasNonZero =
        this.summary.warnings + this.summary.errors + this.summary.info + this.summary.fileCount > 0;
      this.summary = { warnings: 0, errors: 0, info: 0, fileCount: 0 };
      if (wasNonZero) {
        this._onDidChange.fire();
      }
      return;
    }
    let warnings = 0;
    let errors = 0;
    let info = 0;
    let fileCount = 0;
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (!vscode.workspace.getWorkspaceFolder(uri)) {continue;}
      // Only count Lua/Luau files. The languageId isn't directly
      // available on the URI alone, so we filter by extension.
      const fsPath = uri.fsPath;
      if (!fsPath.endsWith(".lua") && !fsPath.endsWith(".luau")) {
        continue;
      }
      if (diags.length === 0) {continue;}
      fileCount++;
      for (const d of diags) {
        switch (d.severity) {
          case vscode.DiagnosticSeverity.Error:
            errors++;
            break;
          case vscode.DiagnosticSeverity.Warning:
            warnings++;
            break;
          case vscode.DiagnosticSeverity.Information:
            info++;
            break;
        }
      }
    }
    const changed =
      warnings !== this.summary.warnings ||
      errors !== this.summary.errors ||
      info !== this.summary.info ||
      fileCount !== this.summary.fileCount;
    if (changed) {
      this.summary = { warnings, errors, info, fileCount };
      this._onDidChange.fire();
    }
  }

  dispose(): void {
    if (this.refreshTimer) {clearTimeout(this.refreshTimer);}
    for (const d of this.disposables) {d.dispose();}
    this.disposables = [];
    this._onDidChange.dispose();
  }
}
