import * as vscode from "vscode";
import { configChangeAffects, getConfig } from "./configCompat";
import {
  ensureThumbnailFile,
  findAssetReferences,
  getThumbnailCacheDir,
} from "./assetThumbnails";

const FIRST_DOWNLOAD_NOTIFIED_KEY = "luix.imageGutter.firstDownloadNotified";

export class ImageGutterDecorator implements vscode.Disposable {
  private typesByAsset = new Map<string, vscode.TextEditorDecorationType>();
  private pendingAssets = new Map<string, number>();
  private generation = 0;
  private disposables: vscode.Disposable[] = [];
  // Debounce editors independently so split views cannot cancel each other.
  private refreshTimers = new WeakMap<vscode.TextEditor, NodeJS.Timeout>();
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) {this.refreshSoon(e);}
      }),
      vscode.window.onDidChangeVisibleTextEditors((eds) => {
        for (const e of eds) {
          this.refreshSoon(e);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!isLuaDoc(e.document)) {
          return;
        }
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === e.document) {
            this.refreshSoon(editor);
          }
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (configChangeAffects(e, "imageGutter")) {
          this.generation++;
          this.pendingAssets.clear();
          this.refreshAll();
        }
      })
    );
    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshSoon(editor);
    }
  }

  private refreshSoon(editor: vscode.TextEditor): void {
    if (!isLuaDoc(editor.document)) {
      return;
    }
    const existing = this.refreshTimers.get(editor);
    if (existing) {
      clearTimeout(existing);
    }
    this.refreshTimers.set(
      editor,
      setTimeout(() => {
        this.refreshTimers.delete(editor);
        if (this.disposed) {return;}
        void this.refresh(editor);
      }, 200)
    );
  }

  private refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      void this.refresh(editor);
    }
  }

  private async refresh(editor: vscode.TextEditor): Promise<void> {
    if (this.disposed || !isLuaDoc(editor.document)) {
      return;
    }
    const enabled = getConfig<boolean>("imageGutter.enabled", true);

    if (!enabled) {
      for (const type of this.typesByAsset.values()) {
        editor.setDecorations(type, []);
      }
      return;
    }

    const text = editor.document.getText();
    const refs = findAssetReferences(text);

    const rangesByAsset = new Map<string, vscode.Range[]>();
    const seenLines = new Set<string>();
    for (const ref of refs) {
      const pos = editor.document.positionAt(ref.offset);
      // Multiple references on one line share a gutter slot.
      const lineKey = `${ref.assetId}@${pos.line}`;
      if (seenLines.has(lineKey)) {
        continue;
      }
      seenLines.add(lineKey);
      const range = new vscode.Range(pos.line, 0, pos.line, 0);
      const arr = rangesByAsset.get(ref.assetId) ?? [];
      arr.push(range);
      rangesByAsset.set(ref.assetId, arr);
    }

    for (const assetId of rangesByAsset.keys()) {
      if (this.typesByAsset.has(assetId)) {
        continue;
      }
      if (this.pendingAssets.has(assetId)) {
        continue;
      }
      const generation = this.generation;
      const isCurrent = () => !this.disposed && generation === this.generation &&
        getConfig<boolean>("imageGutter.enabled", true);
      this.pendingAssets.set(assetId, generation);
      void (async () => {
        try {
          const fileUri = await ensureThumbnailFile(this.context, assetId, isCurrent);
          if (!isCurrent()) {return;}
          if (!fileUri) {
            return;
          }
          const dataUri = await readAsDataUri(fileUri);
          if (!dataUri || !isCurrent()) {
            return;
          }
          void this.disclosureOnce();
          // Data URIs avoid renderer CSP blocking file URIs; disk files remain cached.
          const type = vscode.window.createTextEditorDecorationType({
            gutterIconPath: dataUri,
            gutterIconSize: "contain",
          });
          this.typesByAsset.set(assetId, type);
          // typesByAsset owns these decorations; do not also add them to disposables.
          for (const ed of vscode.window.visibleTextEditors) {
            if (!isLuaDoc(ed.document)) {continue;}
            this.applyTypeIfPresent(ed, assetId, type);
          }
        } finally {
          if (this.pendingAssets.get(assetId) === generation) {
            this.pendingAssets.delete(assetId);
          }
        }
      })().catch(() => {});
    }

    // Empty ranges clear icons for assets no longer in the document.
    for (const [assetId, type] of this.typesByAsset) {
      editor.setDecorations(type, rangesByAsset.get(assetId) ?? []);
    }
  }

  private applyTypeIfPresent(
    editor: vscode.TextEditor,
    assetId: string,
    type: vscode.TextEditorDecorationType
  ): void {
    const text = editor.document.getText();
    const refs = findAssetReferences(text).filter((r) => r.assetId === assetId);
    if (refs.length === 0) {
      editor.setDecorations(type, []);
      return;
    }
    const ranges: vscode.Range[] = [];
    const seenLines = new Set<number>();
    for (const ref of refs) {
      const pos = editor.document.positionAt(ref.offset);
      if (seenLines.has(pos.line)) {continue;}
      seenLines.add(pos.line);
      ranges.push(new vscode.Range(pos.line, 0, pos.line, 0));
    }
    editor.setDecorations(type, ranges);
  }

  resetDisclosure(): void {
    void this.context.globalState.update(
      FIRST_DOWNLOAD_NOTIFIED_KEY,
      undefined
    );
  }

  clearAllDecorations(): void {
    this.generation++;
    this.pendingAssets.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      for (const type of this.typesByAsset.values()) {
        editor.setDecorations(type, []);
      }
    }
    for (const type of this.typesByAsset.values()) {
      type.dispose();
    }
    this.typesByAsset.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshSoon(editor);
    }
  }

  private async disclosureOnce(): Promise<void> {
    const seen = this.context.globalState.get<boolean>(
      FIRST_DOWNLOAD_NOTIFIED_KEY,
      false
    );
    if (seen) {
      return;
    }
    await this.context.globalState.update(FIRST_DOWNLOAD_NOTIFIED_KEY, true);
    const dir = getThumbnailCacheDir(this.context);
    const choice = await vscode.window.showInformationMessage(
      `Luix: image previews download Roblox asset thumbnails to disk and keep them so reopens are instant. Cached under \`${shortenPath(
        dir.fsPath
      )}\`.`,
      "Open settings",
      "Purge cache",
      "Got it"
    );
    if (choice === "Open settings") {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:ericplane.luix-roblox imageGutter"
      );
    } else if (choice === "Purge cache") {
      void vscode.commands.executeCommand("luix.imageGutter.purgeCache");
    }
  }

  dispose(): void {
    // WeakMap timers cannot be iterated; disposed guards their callbacks.
    this.disposed = true;
    this.generation++;
    this.pendingAssets.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    for (const type of this.typesByAsset.values()) {
      type.dispose();
    }
    this.typesByAsset.clear();
  }
}

function shortenPath(p: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && p.startsWith(home)) {
    return "~" + p.slice(home.length);
  }
  return p;
}

async function readAsDataUri(
  fileUri: vscode.Uri
): Promise<vscode.Uri | undefined> {
  try {
    const buffer = await vscode.workspace.fs.readFile(fileUri);
    const base64 = Buffer.from(buffer).toString("base64");
    return vscode.Uri.parse(`data:image/png;base64,${base64}`);
  } catch {
    return undefined;
  }
}

function isLuaDoc(d: vscode.TextDocument): boolean {
  return d.languageId === "lua" || d.languageId === "luau";
}
