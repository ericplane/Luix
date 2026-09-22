import * as vscode from "vscode";
import { WorkspaceIndex } from "./workspaceIndex";
import { detectWorkspaceCapabilities } from "./wally";
import { DocumentComponentInfo } from "./parser";
import { configChangeAffects, getConfig } from "./configCompat";
import { getCacheStats } from "./assetThumbnails";
import { WorkspaceValidation } from "./workspaceValidation";

// ============================================================================
// Workspace view — Wally / Rojo / scaffold entries
// ============================================================================

interface WorkspaceItemDef {
  label: string;
  description?: string;
  tooltip?: string;
  iconId?: string;
  command: string;
  groupOrder: number;
}

export class WorkspaceTreeProvider
  implements vscode.TreeDataProvider<WorkspaceTreeItem>, vscode.Disposable
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData: vscode.Event<void> = this._onDidChange.event;
  private capabilities = { hasWally: false, hasRojoProject: false };
  private cacheStats: { count: number; bytes: number } = { count: 0, bytes: 0 };
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceValidation?: WorkspaceValidation
  ) {
    void this.refreshCapabilities();
    void this.refreshCacheStats();
    const watcher = vscode.workspace.createFileSystemWatcher(
      "**/{wally.toml,*.project.json}"
    );
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.refreshCapabilities()),
      watcher.onDidDelete(() => this.refreshCapabilities()),
      watcher.onDidChange(() => this.refreshCapabilities()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          configChangeAffects(e, "imageGutter") ||
          configChangeAffects(e, "workspaceValidation")
        ) {
          void this.refreshCacheStats();
          this._onDidChange.fire();
        }
      })
    );
    if (this.workspaceValidation) {
      this.disposables.push(
        this.workspaceValidation.onDidChange(() => this._onDidChange.fire())
      );
    }
  }

  /** Re-tally the cache size & fire a tree refresh. Called by the
   *  purge command after a successful wipe. */
  refreshCache(): void {
    void this.refreshCacheStats();
  }

  private async refreshCacheStats(): Promise<void> {
    this.cacheStats = await getCacheStats(this.context);
    this._onDidChange.fire();
  }

  private async refreshCapabilities(): Promise<void> {
    this.capabilities = await detectWorkspaceCapabilities();
    this._onDidChange.fire();
  }

  getTreeItem(element: WorkspaceTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorkspaceTreeItem): WorkspaceTreeItem[] {
    if (element) {
      return [];
    }
    const items: WorkspaceItemDef[] = [];

    if (this.capabilities.hasWally) {
      items.push({
        label: "Regenerate Wally types",
        description: "wally + sourcemap + types",
        tooltip:
          "Runs `wally install` → `rojo sourcemap` → `wally-package-types`.",
        iconId: "sync",
        command: "luix.wally.regenerateTypes",
        groupOrder: 0,
      });
      items.push({
        label: "wally install",
        tooltip: "Run `wally install` in the Luix terminal.",
        iconId: "package",
        command: "luix.wally.install",
        groupOrder: 1,
      });
    }
    if (this.capabilities.hasRojoProject) {
      items.push({
        label: "Generate Rojo sourcemap",
        tooltip:
          "Run `rojo sourcemap <project>.project.json -o sourcemap.json`.",
        iconId: "file-symlink-file",
        command: "luix.rojo.generateSourcemap",
        groupOrder: 2,
      });
    }

    items.push(
      {
        label: "New React component",
        tooltip:
          "Scaffold a new React-Luau component file in the current directory.",
        iconId: "file-add",
        command: "luix.newComponent.react",
        groupOrder: 10,
      },
      {
        label: "New Fusion component",
        tooltip:
          "Scaffold a new Fusion component file in the current directory.",
        iconId: "file-add",
        command: "luix.newComponent.fusion",
        groupOrder: 11,
      },
      {
        label: "New Vide component",
        tooltip:
          "Scaffold a new Vide component file in the current directory.",
        iconId: "file-add",
        command: "luix.newComponent.vide",
        groupOrder: 12,
      }
    );

    // Image-gutter entries: a one-click *enable* prompt when the
    // feature is off (so users can discover it without hunting through
    // settings), or the purge / open-folder pair when it's on AND
    // there's a cache to manage.
    const gutterOn = getConfig<boolean>("imageGutter.enabled", false);
    if (!gutterOn) {
      items.push({
        label: "Enable image gutter previews",
        description: "downloads asset thumbnails to disk",
        tooltip:
          "Show a thumbnail in the gutter next to every `rbxassetid://NNNN` reference. Downloads each asset's preview to disk once — instant on subsequent opens.",
        iconId: "eye",
        command: "luix.imageGutter.enableFromSidebar",
        groupOrder: 20,
      });
    } else if (this.cacheStats.count > 0) {
      items.push(
        {
          label: "Purge image preview cache",
          description: `${this.cacheStats.count} asset${this.cacheStats.count === 1 ? "" : "s"} — ${formatBytes(this.cacheStats.bytes)}`,
          tooltip:
            "Delete every cached Roblox asset thumbnail. They'll re-download on demand the next time you view the relevant files.",
          iconId: "trash",
          command: "luix.imageGutter.purgeCache",
          groupOrder: 20,
        },
        {
          label: "Open image cache folder",
          tooltip:
            "Reveal the cache directory in your OS file manager.",
          iconId: "folder-opened",
          command: "luix.imageGutter.openCacheFolder",
          groupOrder: 21,
        }
      );
    }

    // Workspace-wide validation summary — only shown when the user
    // has opted in.
    if (
      getConfig<boolean>("workspaceValidation.enabled", false) &&
      this.workspaceValidation
    ) {
      const s = this.workspaceValidation.getSummary();
      const total = s.warnings + s.errors + s.info;
      const description =
        total === 0
          ? "no issues"
          : `${s.errors > 0 ? `${s.errors} error${s.errors === 1 ? "" : "s"} · ` : ""}${s.warnings} warning${s.warnings === 1 ? "" : "s"}${s.info > 0 ? ` · ${s.info} hint${s.info === 1 ? "" : "s"}` : ""}`;
      items.push({
        label: "Project diagnostics",
        description: `${description} across ${s.fileCount} file${s.fileCount === 1 ? "" : "s"}`,
        tooltip:
          "Workspace-wide tally of Luix + other publishers' diagnostics. Click to open the Problems panel.",
        iconId: s.errors > 0 ? "error" : s.warnings > 0 ? "warning" : "check",
        command: "workbench.actions.view.problems",
        groupOrder: 22,
      });
    }

    items.sort((a, b) => a.groupOrder - b.groupOrder);
    return items.map((def) => new WorkspaceTreeItem(def));
  }

  refresh(): void {
    void this.refreshCapabilities();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}

class WorkspaceTreeItem extends vscode.TreeItem {
  constructor(def: WorkspaceItemDef) {
    super(def.label, vscode.TreeItemCollapsibleState.None);
    this.description = def.description;
    this.tooltip = def.tooltip;
    if (def.iconId) {
      this.iconPath = new vscode.ThemeIcon(def.iconId);
    }
    this.command = { command: def.command, title: def.label };
  }
}

// ============================================================================
// Components view — folder tree (default) + flat alphabetical toggle
// ============================================================================

type ViewMode = "tree" | "flat";

interface ComponentEntry {
  name: string;
  uri: vscode.Uri;
  info: DocumentComponentInfo;
}

type TreeNode =
  | {
      kind: "folder";
      label: string;
      relPath: string;
      children: TreeNode[];
    }
  | {
      kind: "component";
      entry: ComponentEntry;
    };

const VIEW_MODE_KEY = "luix.componentsViewMode";

export class ComponentsTreeProvider
  implements vscode.TreeDataProvider<ComponentNode>, vscode.Disposable
{
  private _onDidChange = new vscode.EventEmitter<ComponentNode | void>();
  readonly onDidChangeTreeData: vscode.Event<ComponentNode | void> =
    this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly workspaceIndex: WorkspaceIndex,
    private readonly context: vscode.ExtensionContext
  ) {
    this.disposables.push(
      workspaceIndex.onDidChangeIndex(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("luix.componentsRoot")) {
          this.refresh();
        }
      })
    );
  }

  getMode(): ViewMode {
    return (
      this.context.workspaceState.get<ViewMode>(VIEW_MODE_KEY) ?? "tree"
    );
  }

  async setMode(mode: ViewMode): Promise<void> {
    await this.context.workspaceState.update(VIEW_MODE_KEY, mode);
    void vscode.commands.executeCommand(
      "setContext",
      "luix.componentsViewMode",
      mode
    );
    this.refresh();
  }

  async toggleMode(): Promise<void> {
    await this.setMode(this.getMode() === "tree" ? "flat" : "tree");
  }

  getTreeItem(element: ComponentNode): vscode.TreeItem {
    if (element.kind === "folder") {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "luix.folder";
      item.tooltip = element.relPath || element.label;
      return item;
    }
    const c = element.entry;
    const item = new vscode.TreeItem(
      c.name,
      vscode.TreeItemCollapsibleState.None
    );
    const path = require("path") as typeof import("path");
    item.description = path.basename(c.uri.fsPath);
    const base = c.info.annotations.extendsClass ?? c.info.detectedBase;
    item.tooltip = new vscode.MarkdownString(
      base ? `**${c.name}**\n\nExtends \`${base}\`` : `**${c.name}**`
    );
    item.iconPath = new vscode.ThemeIcon("symbol-method");
    item.command = {
      command: "vscode.open",
      title: "Open component",
      arguments: [
        c.uri,
        {
          selection: new vscode.Range(
            new vscode.Position(c.info.defLineIndex, 0),
            new vscode.Position(c.info.defLineIndex, 0)
          ),
        },
      ],
    };
    return item;
  }

  async getChildren(element?: ComponentNode): Promise<ComponentNode[]> {
    if (element) {
      return element.kind === "folder" ? element.children : [];
    }
    const components = await this.workspaceIndex.getAllComponents();
    if (components.length === 0) {
      return [];
    }
    if (this.getMode() === "flat") {
      return [...components]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry): ComponentNode => ({ kind: "component", entry }));
    }
    return buildFolderTree(components, getComponentsRoot()).children;
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}

type ComponentNode = TreeNode;

function getComponentsRoot(): string | undefined {
  const setting = getConfig<string>("componentsRoot", "");
  return setting && setting.length > 0 ? setting : undefined;
}

/**
 * Group components by their containing directory. Returns a synthetic
 * root folder whose children are the top-level entries in display
 * order. If `componentsRoot` is set, paths are stripped of that prefix
 * (so the tree feels rooted there).
 */
export function buildFolderTree(
  components: ComponentEntry[],
  componentsRoot: string | undefined
): { kind: "folder"; label: string; relPath: string; children: TreeNode[] } {
  const path = require("path") as typeof import("path");

  // Determine the base each component path is relative to: the workspace
  // folder that contains it (or the workspace folder its componentsRoot
  // sits under, when set).
  const root: ReturnType<typeof buildFolderTree> = {
    kind: "folder",
    label: "",
    relPath: "",
    children: [],
  };

  for (const entry of components) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(entry.uri);
    if (!workspaceFolder) {
      // Component lives outside any workspace folder — drop it at the root.
      root.children.push({ kind: "component", entry });
      continue;
    }
    let rel = path.relative(workspaceFolder.uri.fsPath, entry.uri.fsPath);

    if (componentsRoot) {
      const normalizedRoot = componentsRoot.replace(/\\/g, "/");
      const normalizedRel = rel.replace(/\\/g, "/");
      if (
        normalizedRel === normalizedRoot ||
        normalizedRel.startsWith(normalizedRoot + "/")
      ) {
        rel = normalizedRel.slice(normalizedRoot.length).replace(/^\/+/, "");
      } else {
        // Outside the configured root — skip it in tree mode so the
        // root stays focused on the user's UI tree. They can switch to
        // flat mode to see everything.
        continue;
      }
    }

    const parts = rel.split(/[/\\]/);
    const dirs = parts.slice(0, -1);

    let cursor = root;
    for (const dir of dirs) {
      let next = cursor.children.find(
        (c) => c.kind === "folder" && c.label === dir
      ) as
        | { kind: "folder"; label: string; relPath: string; children: TreeNode[] }
        | undefined;
      if (!next) {
        next = {
          kind: "folder",
          label: dir,
          relPath: cursor.relPath
            ? `${cursor.relPath}/${dir}`
            : dir,
          children: [],
        };
        cursor.children.push(next);
      }
      cursor = next;
    }
    cursor.children.push({ kind: "component", entry });
  }

  // Sort: folders first (alphabetical), then components (alphabetical).
  sortFolder(root);
  return root;
}

function sortFolder(
  folder: { kind: "folder"; children: TreeNode[] }
): void {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "folder" ? -1 : 1;
    }
    const aName = a.kind === "folder" ? a.label : a.entry.name;
    const bName = b.kind === "folder" ? b.label : b.entry.name;
    return aName.localeCompare(bName);
  });
  for (const child of folder.children) {
    if (child.kind === "folder") {
      sortFolder(child);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {return `${bytes} B`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
