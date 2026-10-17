import * as vscode from "vscode";
import { configChangeAffects, getConfig } from "./configCompat";
import { getAliasPartition } from "./frameworks";
import {
  buildCallTree,
  CallTreeNode,
  findAllCreateElementCalls,
  scanDocument,
} from "./parser";
import { WorkspaceIndex } from "./workspaceIndex";

export class ComponentReferencesLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly workspaceIndex: WorkspaceIndex) {
    this.disposables.push(
      this.workspaceIndex.onDidChangeIndex(() => this._onDidChange.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (configChangeAffects(e, "componentReferencesLens")) {
          this._onDidChange.fire();
        }
      })
    );
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    if (!getConfig<boolean>("componentReferencesLens.enabled", true)) {
      return [];
    }
    const text = document.getText();
    const components = scanDocument(text, getAliasPartition());
    if (components.size === 0) {
      return [];
    }
    const lines = text.split("\n");
    const out: vscode.CodeLens[] = [];
    for (const [name, info] of components) {
      if (token.isCancellationRequested) {return [];}
      const line = lines[info.defLineIndex] ?? "";
      const indent = /^\s*/.exec(line)?.[0] ?? "";
      const pos = new vscode.Position(info.defLineIndex, indent.length);
      const range = new vscode.Range(pos, pos);

      // Counts include self-references; locations resolve only on demand.
      const totalCount = this.workspaceIndex.countCallSites(name);

      const title =
        totalCount === 0
          ? "No references"
          : totalCount === 1
            ? "1 reference"
            : `${totalCount} references`;

      const lens = new vscode.CodeLens(range, {
        title,
        command: totalCount === 0 ? "" : "luix.peekComponentReferences",
        arguments: totalCount === 0 ? [] : [document.uri, pos, name],
      });
      out.push(lens);
    }
    return out;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this._onDidChange.dispose();
  }
}

export class FrameStatsLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (configChangeAffects(e, "frameStatsLens")) {
          this._onDidChange.fire();
        }
      })
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!getConfig<boolean>("frameStatsLens.enabled", false)) {
      return [];
    }
    const minDescendants = getConfig<number>(
      "frameStatsLens.minDescendants",
      5
    );
    const text = document.getText();
    const calls = findAllCreateElementCalls(text, getAliasPartition());
    if (calls.length === 0) {return [];}
    const tree = buildCallTree(calls);
    const out: vscode.CodeLens[] = [];
    for (const root of tree) {
      this.walk(root, document, out, minDescendants);
    }
    return out;
  }

  private walk(
    node: CallTreeNode,
    document: vscode.TextDocument,
    out: vscode.CodeLens[],
    minDescendants: number
  ): void {
    const stats = countStats(node);
    if (stats.descendants >= minDescendants) {
      const pos = document.positionAt(node.call.aliasStart);
      const lineIndent = /^\s*/.exec(
        document.lineAt(pos.line).text
      )?.[0] ?? "";
      const lensPos = new vscode.Position(pos.line, lineIndent.length);
      const lens = new vscode.CodeLens(new vscode.Range(lensPos, lensPos), {
        title: `▸ ${node.call.className} — ${stats.descendants} descendant${stats.descendants === 1 ? "" : "s"}, ${stats.depth} layer${stats.depth === 1 ? "" : "s"} deep`,
        command: "",
      });
      out.push(lens);
    }
    for (const child of node.children) {
      this.walk(child, document, out, minDescendants);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {d.dispose();}
    this.disposables = [];
    this._onDidChange.dispose();
  }
}

function countStats(
  node: CallTreeNode
): { descendants: number; depth: number } {
  let descendants = 0;
  let maxChildDepth = 0;
  for (const child of node.children) {
    descendants++;
    const s = countStats(child);
    descendants += s.descendants;
    if (s.depth > maxChildDepth) {maxChildDepth = s.depth;}
  }
  return { descendants, depth: 1 + maxChildDepth };
}
