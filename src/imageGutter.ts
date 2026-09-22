import * as vscode from "vscode";
import { configChangeAffects, getConfig } from "./configCompat";
import {
  ensureThumbnailFile,
  findAssetReferences,
  getThumbnailCacheDir,
} from "./assetThumbnails";

const FIRST_DOWNLOAD_NOTIFIED_KEY = "luix.imageGutter.firstDownloadNotified";

// ============================================================================
// Image-asset gutter previews
// ============================================================================
//
// For every `"rbxassetid://NNNN"` reference in a Lua/Luau file, show
// the asset's thumbnail as a tiny icon in the gutter next to the line
// — same idea as the popular `vscode-gutter-preview` extension for
// `.png` asset paths, adapted to Roblox CDN assets.
//
// VS Code's `gutterIconPath` only accepts local file URIs, so we
// download each thumbnail PNG to the extension's global storage and
// keep it there forever. Repeated openings of the same file are
// instant after the first.
//
// One decoration type per unique asset ID (a single
// `TextEditorDecorationType` carries exactly one `gutterIconPath`).
// Types are cached so we don't rebuild them on every refresh — only the
// per-editor `setDecorations` call needs to run.

export class ImageGutterDecorator implements vscode.Disposable {
  private typesByAsset = new Map<string, vscode.TextEditorDecorationType>();
  private pendingAssets = new Map<string, number>();
  private generation = 0;
  private disposables: vscode.Disposable[] = [];
  // One pending timer per editor — a single shared timer would let a
  // change in editor A cancel the pending refresh of editor B (common
  // in split-view), so the second editor never gets its gutter icons
  // until further changes.
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
    // Kick off any editors already open at activation.
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
    // Debounce per editor — typing fires onDidChangeTextDocument
    // hundreds of times, and each refresh touches the network on first
    // sight of a new asset.
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

    // Always call `setDecorations` for every known type so disabling the
    // feature also clears existing gutter icons.
    if (!enabled) {
      for (const type of this.typesByAsset.values()) {
        editor.setDecorations(type, []);
      }
      return;
    }

    const text = editor.document.getText();
    const refs = findAssetReferences(text);

    // Group ranges by assetId.
    const rangesByAsset = new Map<string, vscode.Range[]>();
    const seenLines = new Set<string>();
    for (const ref of refs) {
      const pos = editor.document.positionAt(ref.offset);
      // One icon per line — multiple references on the same line would
      // stack into the same gutter slot.
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

    // Resolve decoration types for every asset present in the file,
    // downloading thumbnails as needed. Skip assets already in flight
    // so a flurry of edits doesn't fire duplicate downloads.
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
          // First successful download in this install — disclose where
          // the files are landing.
          void this.disclosureOnce();
          // Pass the data URI to `gutterIconPath` rather than the file
          // URI. Some VS Code builds enforce CSP on `file://` images in
          // the editor renderer and silently block them with a
          // `blocked:csp` error; data URIs sidestep that because they're
          // inlined. The disk cache is still useful — we re-read it on
          // the next session.
          const type = vscode.window.createTextEditorDecorationType({
            gutterIconPath: dataUri,
            gutterIconSize: "contain",
          });
          this.typesByAsset.set(assetId, type);
          // NOTE: decoration types are owned exclusively by `typesByAsset`
          // so `clearAllDecorations()` can dispose + drop them without
          // `dispose()` later double-disposing the same types via
          // `this.disposables`. The dispose method below handles them.
          // After the thumbnail lands, re-apply for any visible editor that
          // currently shows the same asset.
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

    // Apply / clear all known types. A type whose asset isn't present
    // in the current file gets an empty range list, clearing its icons.
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

  /** Reset the once-per-install disclosure so the next download fires it again. */
  resetDisclosure(): void {
    void this.context.globalState.update(
      FIRST_DOWNLOAD_NOTIFIED_KEY,
      undefined
    );
  }

  /** Clear all gutter decorations and forget our asset → type map.
   *  Called after a cache purge so stale icons disappear immediately. */
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
    // Re-decorate (any thumbnails that just got re-downloaded will
    // re-populate the type map on the next refresh).
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
    // WeakMap can't be iterated, so we can't clear pending timers
    // directly. The `disposed` flag short-circuits them when they fire.
    this.disposed = true;
    this.generation++;
    this.pendingAssets.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    // Decoration types are owned by `typesByAsset` exclusively (not
    // mirrored into `disposables`) so this is the only place they get
    // disposed. `clearAllDecorations()` empties the map, so anything
    // still here is live and needs disposing.
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

/**
 * Read a PNG file from disk and return its `data:image/png;base64,…`
 * URI. Used in place of a `file://` URI for `gutterIconPath` so VS
 * Code's renderer CSP can't block it.
 */
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
