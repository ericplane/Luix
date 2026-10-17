import { rewriteLiteralProps } from "./propEdits";
import * as vscode from "vscode";
import {
  applyMask,
  buildCodeMask,
  extractPropEntriesFromDocument,
  findAllCreateElementCalls,
} from "./parser";
import { getAliasPartition } from "./frameworks";
import { getConfig } from "./configCompat";
import { fetchAssetThumbnailUrl } from "./assetThumbnails";

// Edit crop rectangles for image elements with literal asset IDs.

const IMAGE_CLASSES = new Set(["ImageLabel", "ImageButton"]);

export interface RectImageCall {
  aliasStart: number;
  fullEnd: number;
  propsBraceStart: number;
  propsBraceEnd: number;
  assetId: string;
  imageRectOffset?: { x: number; y: number };
  imageRectSize?: { x: number; y: number };
  /** ScaleType enum name. */
  scaleType?: string;
  /** Aspect ratio from a literal pixel Size. */
  sizeAspect?: number;
  /** Aspect ratio from a sibling constraint. */
  aspectConstraint?: number;
}

interface RectCacheEntry {
  text: string;
  result: RectImageCall[];
}
const rectCache: RectCacheEntry[] = [];
const RECT_CACHE_MAX = 4;

export function findRectImageCalls(text: string): RectImageCall[] {
  for (let i = rectCache.length - 1; i >= 0; i--) {
    if (rectCache[i].text === text) {
      const hit = rectCache.splice(i, 1)[0];
      rectCache.push(hit);
      return hit.result;
    }
  }

  if (!/rbxasset(?:id)?:\/\//.test(text)) {
    const empty: RectImageCall[] = [];
    rectCache.push({ text, result: empty });
    if (rectCache.length > RECT_CACHE_MAX) {
      rectCache.shift();
    }
    return empty;
  }

  const aliases = getAliasPartition();
  const calls = findAllCreateElementCalls(text, aliases);
  const out: RectImageCall[] = [];
  for (const c of calls) {
    if (!c.isStringLiteralName || !IMAGE_CLASSES.has(c.className)) {
      continue;
    }
    if (c.propsBraceStart === undefined || c.propsBraceEnd === undefined) {
      continue;
    }
    const bodyStart = c.propsBraceStart + 1;
    const propsBody = text.slice(bodyStart, c.propsBraceEnd);
    const entries = extractPropEntriesFromDocument(
      text,
      bodyStart,
      c.propsBraceEnd
    );
    let assetId: string | undefined;
    let imageRectOffset: { x: number; y: number } | undefined;
    let imageRectSize: { x: number; y: number } | undefined;
    let scaleType: string | undefined;
    let sizeAspect: number | undefined;
    for (const entry of entries) {
      const valueText = propsBody
        .slice(entry.valueStart, entry.valueEnd)
        .trim();
      if (entry.key === "Image") {
        const m = /^["'`]rbxasset(?:id)?:\/\/(\d+)["'`]$/.exec(valueText);
        if (m) {
          assetId = m[1];
        }
      } else if (entry.key === "ImageRectOffset") {
        const v = parseVector2(valueText);
        if (v) {
          imageRectOffset = v;
        }
      } else if (entry.key === "ImageRectSize") {
        const v = parseVector2(valueText);
        if (v) {
          imageRectSize = v;
        }
      } else if (entry.key === "ScaleType") {
        const m = /Enum\.ScaleType\.(\w+)/.exec(valueText);
        if (m) {
          scaleType = m[1];
        }
      } else if (entry.key === "Size") {
        const m = /UDim2\.fromOffset\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)/.exec(
          valueText
        );
        if (m) {
          const w = Number(m[1]);
          const h = Number(m[2]);
          if (w > 0 && h > 0) {
            sizeAspect = w / h;
          }
        }
      }
    }
    if (assetId) {
      out.push({
        aliasStart: c.aliasStart,
        fullEnd: c.fullEnd,
        propsBraceStart: c.propsBraceStart,
        propsBraceEnd: c.propsBraceEnd,
        assetId,
        imageRectOffset,
        imageRectSize,
        scaleType,
        sizeAspect,
        aspectConstraint: findSiblingAspectConstraint(text, c, calls),
      });
    }
  }
  rectCache.push({ text, result: out });
  if (rectCache.length > RECT_CACHE_MAX) {
    rectCache.shift();
  }
  return out;
}

/** Use a sibling aspect constraint as the parent's aspect ratio. */
function findSiblingAspectConstraint(
  text: string,
  target: { aliasStart: number; fullEnd: number },
  allCalls: ReturnType<typeof findAllCreateElementCalls>
): number | undefined {
  const findParent = (start: number, end: number) => {
    let parent: typeof allCalls[number] | undefined;
    for (const c of allCalls) {
      if (c.aliasStart === start && c.fullEnd === end) {
        continue;
      }
      if (c.aliasStart < start && c.fullEnd > end) {
        if (
          !parent ||
          c.fullEnd - c.aliasStart < parent.fullEnd - parent.aliasStart
        ) {
          parent = c;
        }
      }
    }
    return parent;
  };
  const targetParent = findParent(target.aliasStart, target.fullEnd);
  if (!targetParent) {
    return undefined;
  }
  for (const c of allCalls) {
    if (c.className !== "UIAspectRatioConstraint") {
      continue;
    }
    if (
      c.propsBraceStart === undefined ||
      c.propsBraceEnd === undefined
    ) {
      continue;
    }
    const cParent = findParent(c.aliasStart, c.fullEnd);
    if (!cParent || cParent.aliasStart !== targetParent.aliasStart) {
      continue;
    }
    const propsBody = text.slice(c.propsBraceStart + 1, c.propsBraceEnd);
    const entries = extractPropEntriesFromDocument(
      text,
      c.propsBraceStart + 1,
      c.propsBraceEnd
    );
    const ar = entries.find((e) => e.key === "AspectRatio");
    if (ar) {
      const num = Number(
        propsBody.slice(ar.valueStart, ar.valueEnd).trim()
      );
      if (Number.isFinite(num) && num > 0) {
        return num;
      }
    }
  }
  return undefined;
}

function parseVector2(
  value: string
): { x: number; y: number } | undefined {
  const m = /^Vector2\.new\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/.exec(
    value
  );
  if (!m) {
    return undefined;
  }
  return { x: Number(m[1]), y: Number(m[2]) };
}

export class RectCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("luix.rectEditor")) {
          this._onDidChange.fire();
        }
      })
    );
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!getConfig<boolean>("rectEditor.codeLensEnabled", true)) {
      return [];
    }
    const text = document.getText();
    const out: vscode.CodeLens[] = [];
    for (const c of findRectImageCalls(text)) {
      const range = new vscode.Range(
        document.positionAt(c.aliasStart),
        document.positionAt(c.fullEnd)
      );
      out.push(
        new vscode.CodeLens(range, {
          title: "$(symbol-array) Edit sprite rect",
          command: "luix.openRectEditor",
          arguments: [document.uri, range],
        })
      );
    }
    return out;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}

export class RectEditorManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  open(uri: vscode.Uri, range: vscode.Range): void {
    const key = `${uri.toString()}#${range.start.line}:${range.start.character}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }
    void this.openImpl(uri, range, key);
  }

  private async openImpl(
    uri: vscode.Uri,
    range: vscode.Range,
    key: string
  ): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    const startOff = document.offsetAt(range.start);
    const endOff = document.offsetAt(range.end);
    const hit = findRectImageCalls(text).find(
      (c) => c.aliasStart === startOff && c.fullEnd === endOff
    );
    if (!hit) {
      void vscode.window.showWarningMessage(
        "Luix: couldn't find a sprite-rect-editable Image at this location."
      );
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "luix.rectEditor",
      "Luix · Rect editor",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "assets",
      "icon.png"
    );
    this.panels.set(key, panel);
    let disposed = false;
    panel.onDidDispose(() => {
      disposed = true;
      this.panels.delete(key);
    });

    // Attach the message handler before HTML can send ready.
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (disposed) {return;}
      if (msg?.type === "ready") {
        // Prefer cached dimensions, then Open Cloud, then thumbnail size.
        let cachedDims = readCachedAssetDims(this.context, hit.assetId);
        const apiKeySet =
          !!getConfig<string>("openCloud.apiKey", "").trim();
        const [imageUrl, freshDims] = await Promise.all([
          fetchLargestAvailableThumbnail(hit.assetId),
          // Asset dimensions are immutable; reuse cached or manual values.
          cachedDims ? Promise.resolve(undefined) : fetchAssetNativeDimensions(this.context, hit.assetId),
        ]);
        if (disposed) {return;}
        if (!cachedDims && freshDims) {
          cachedDims = freshDims;
        }
        // Prefer a sibling aspect constraint over a literal Size.
        const frameAspect =
          hit.aspectConstraint ?? hit.sizeAspect ?? undefined;
        panel.webview.postMessage({
          type: "init",
          assetId: hit.assetId,
          imageUrl,
          cachedDims,
          apiKeySet,
          rectOffset: hit.imageRectOffset ?? { x: 0, y: 0 },
          // Zero offset and size mean the whole image.
          rectSize: hit.imageRectSize ?? { x: 0, y: 0 },
          frameAspect,
          frameAspectSource: hit.aspectConstraint
            ? "UIAspectRatioConstraint"
            : hit.sizeAspect
              ? "Size"
              : "default",
          scaleType: hit.scaleType ?? "Stretch",
        });
        return;
      }
      if (msg?.type === "saveDims") {
        // Persist manual dimensions so later opens avoid the API.
        if (
          typeof msg.width === "number" &&
          typeof msg.height === "number" &&
          msg.width > 0 &&
          msg.height > 0
        ) {
          await writeCachedAssetDims(this.context, hit.assetId, {
            width: Math.round(msg.width),
            height: Math.round(msg.height),
            source: "manual",
          });
        }
        return;
      }
      if (msg?.type === "apply") {
        await applyRectEdit(uri, hit, msg.offset, msg.size);
        panel.dispose();
      }
      if (msg?.type === "cancel") {
        panel.dispose();
      }
    });

    panel.webview.html = renderRectEditorHtml();
  }

  dispose(): void {
    for (const p of this.panels.values()) {
      p.dispose();
    }
    this.panels.clear();
  }
}

async function applyRectEdit(
  uri: vscode.Uri,
  original: RectImageCall,
  newOffset: { x: number; y: number },
  newSize: { x: number; y: number }
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  const call = findRectImageCalls(text).find(
    (c) =>
      c.aliasStart === original.aliasStart && c.fullEnd === original.fullEnd
  );
  if (!call) {
    void vscode.window.showWarningMessage(
      "Luix: couldn't relocate the Image element to apply the rect."
    );
    return;
  }
  const bodyStart = call.propsBraceStart + 1;
  const propsBody = text.slice(bodyStart, call.propsBraceEnd);
  const entries = extractPropEntriesFromDocument(
    text,
    bodyStart,
    call.propsBraceEnd
  );
  const lineText = document.lineAt(
    document.positionAt(call.aliasStart).line
  ).text;
  const outerIndent = /^[\t ]*/.exec(lineText)?.[0] ?? "";
  const editorConfig = vscode.workspace.getConfiguration("editor", uri);
  const insertSpaces = editorConfig.get<boolean>("insertSpaces", true);
  const tabSize = editorConfig.get<number>("tabSize", 4);
  const innerStep = insertSpaces ? " ".repeat(tabSize) : "\t";
  const propIndent = outerIndent + innerStep;

  // Zero offset and size mean the whole image; omit both props.
  const isWholeImage =
    Math.round(newOffset.x) === 0 &&
    Math.round(newOffset.y) === 0 &&
    Math.round(newSize.x) === 0 &&
    Math.round(newSize.y) === 0;

  const offsetLiteral = `Vector2.new(${Math.round(newOffset.x)}, ${Math.round(newOffset.y)})`;
  const sizeLiteral = `Vector2.new(${Math.round(newSize.x)}, ${Math.round(newSize.y)})`;

  let replacement: string;
  try {
    replacement = rewriteLiteralProps(propsBody, entries, [
      { key: "ImageRectOffset", value: offsetLiteral, remove: isWholeImage },
      { key: "ImageRectSize", value: sizeLiteral, remove: isWholeImage },
    ], propIndent);
  } catch (err) {
    void vscode.window.showWarningMessage(`Luix: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(
    document.positionAt(bodyStart), document.positionAt(call.propsBraceEnd)
  ), replacement);

  await vscode.workspace.applyEdit(edit);
}

/** Try smaller thumbnails until one is available; cache each size separately. */
async function fetchLargestAvailableThumbnail(
  assetId: string
): Promise<string | null> {
  const sizes = ["768x768", "512x512", "420x420", "256x256", "150x150"];
  for (const size of sizes) {
    const url = await fetchAssetThumbnailUrl(assetId, size);
    if (url) {
      return url;
    }
  }
  return null;
}

// Persist native or manual dimensions per asset across workspaces.

const ASSET_DIMS_PREFIX = "luix.rectAssetDims.";

interface CachedDims {
  width: number;
  height: number;
  /** Dimension source controls overwrite priority. */
  source?: "openCloud" | "manual";
}

export function readCachedAssetDims(
  context: vscode.ExtensionContext,
  assetId: string
): CachedDims | undefined {
  return context.globalState.get<CachedDims>(ASSET_DIMS_PREFIX + assetId);
}

export async function writeCachedAssetDims(
  context: vscode.ExtensionContext,
  assetId: string,
  dims: CachedDims
): Promise<void> {
  await context.globalState.update(ASSET_DIMS_PREFIX + assetId, dims);
}

export async function purgeAllCachedAssetDims(
  context: vscode.ExtensionContext
): Promise<number> {
  let removed = 0;
  for (const key of context.globalState.keys()) {
    if (key.startsWith(ASSET_DIMS_PREFIX)) {
      await context.globalState.update(key, undefined);
      removed++;
    }
  }
  return removed;
}

/** Return undefined when dimensions cannot be fetched or decoded. */
export async function fetchAssetNativeDimensions(
  context: vscode.ExtensionContext,
  assetId: string
): Promise<CachedDims | undefined> {
  const apiKey = getConfig<string>("openCloud.apiKey", "").trim();
  if (!apiKey) {
    return undefined;
  }
  try {
    const metaRes = await fetch(
      `https://apis.roblox.com/asset-delivery-api/v1/assetId/${assetId}`,
      {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!metaRes.ok) {
      return undefined;
    }
    const meta = (await metaRes.json()) as {
      location?: string;
      errors?: Array<{ Code?: number; Message?: string }>;
    };
    if (!meta?.location || (meta.errors && meta.errors.length > 0)) {
      return undefined;
    }
    const assetRes = await fetch(meta.location, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!assetRes.ok) {
      return undefined;
    }
    const bytes = new Uint8Array(await assetRes.arrayBuffer());
    const dims = readImageDimensions(bytes);
    if (!dims) {
      return undefined;
    }
    const cached: CachedDims = {
      width: dims.width,
      height: dims.height,
      source: "openCloud",
    };
    await writeCachedAssetDims(context, assetId, cached);
    return cached;
  } catch {
    return undefined;
  }
}

/** Read PNG IHDR or JPEG SOF dimensions; reject other formats. */
function readImageDimensions(
  bytes: Uint8Array
): { width: number; height: number } | undefined {
  // PNG: signature 89 50 4E 47, then 4-byte length + "IHDR" + width(4) + height(4)
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const w =
      ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>>
      0;
    const h =
      ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>>
      0;
    if (w > 0 && h > 0) {
      return { width: w, height: h };
    }
  }
  // JPEG segments include a big-endian length; skip non-SOF markers.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      while (i < bytes.length && bytes[i] === 0xff) {
        i++;
      }
      const marker = bytes[i];
      i++;
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        continue;
      }
      if (i + 1 >= bytes.length) {
        break;
      }
      const segLen = (bytes[i] << 8) | bytes[i + 1];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        const h = (bytes[i + 3] << 8) | bytes[i + 4];
        const w = (bytes[i + 5] << 8) | bytes[i + 6];
        if (w > 0 && h > 0) {
          return { width: w, height: h };
        }
        return undefined;
      }
      i += segLen;
    }
  }
  return undefined;
}

function renderRectEditorHtml(): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Luix rect editor</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';"/>
<style>
  :root {
    color-scheme: dark light;
    --luix: #7C5CFF;
    --luix-soft: rgba(124, 92, 255, 0.18);
    --panel-bg: rgba(255, 255, 255, 0.03);
    --panel-border: rgba(255, 255, 255, 0.06);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 22px 26px;
    user-select: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }
  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    opacity: 0.78;
  }
  .badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--luix-soft);
    color: var(--luix);
    border: 1px solid rgba(124, 92, 255, 0.35);
  }
  .stage {
    position: relative;
    width: 100%;
    max-width: 560px;
    /* Match the source aspect ratio so the selection aligns with the image. */
    aspect-ratio: 1 / 1;
    margin: 0 auto 14px;
    border-radius: 8px;
    background:
      linear-gradient(45deg, #2a2a2a 25%, transparent 25%),
      linear-gradient(-45deg, #2a2a2a 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #2a2a2a 75%),
      linear-gradient(-45deg, transparent 75%, #2a2a2a 75%);
    background-size: 14px 14px;
    background-position: 0 0, 0 7px, 7px -7px, -7px 0;
    background-color: #1d1d1d;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
    touch-action: none;
  }
  /* Leave room for selections beyond the image when zoomed out. */
  .image-layer {
    position: absolute;
    pointer-events: none;
    image-rendering: pixelated;
  }
  .image-layer img {
    display: block;
    width: 100%;
    height: 100%;
  }
  .zoom-bar {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: rgba(20, 20, 24, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 5px;
    backdrop-filter: blur(4px);
    z-index: 3;
    user-select: none;
    font-size: 11px;
  }
  .zoom-bar svg {
    width: 13px;
    height: 13px;
    opacity: 0.6;
    flex-shrink: 0;
  }
  .zoom-bar button {
    width: 22px;
    height: 22px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.06);
    color: var(--vscode-foreground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
  }
  .zoom-bar button:hover {
    background: rgba(124, 92, 255, 0.25);
  }
  .zoom-bar button:disabled {
    opacity: 0.35;
    cursor: not-allowed;
    background: none;
  }
  .zoom-label {
    min-width: 44px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    padding: 0 4px;
    border-radius: 3px;
  }
  .zoom-label:hover { background: rgba(255, 255, 255, 0.06); }
  .mask {
    position: absolute;
    inset: 0;
    pointer-events: none;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55) inset;
    /* The selection shadow leaves its interior undimmed. */
  }
  .rect {
    position: absolute;
    border: 2px solid var(--luix);
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
    cursor: move;
    touch-action: none;
  }
  .rect.dragging { cursor: grabbing; }
  .rect.overflow {
    border-style: dashed;
    border-color: #FFB454;
  }
  .crop-preview {
    position: absolute;
    border: 1.5px dashed #FFD166;
    pointer-events: none;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
  }
  .crop-preview-label {
    position: absolute;
    top: -22px;
    right: 0;
    padding: 1px 5px;
    background: #FFD166;
    color: #000;
    font-size: 9.5px;
    font-weight: 700;
    border-radius: 2px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .handle {
    position: absolute;
    width: 10px;
    height: 10px;
    background: var(--luix);
    border: 2px solid #fff;
    border-radius: 2px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
    touch-action: none;
  }
  .h-nw { top: -6px; left: -6px; cursor: nwse-resize; }
  .h-ne { top: -6px; right: -6px; cursor: nesw-resize; }
  .h-sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
  .h-se { bottom: -6px; right: -6px; cursor: nwse-resize; }
  .h-n  { top: -6px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
  .h-s  { bottom: -6px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
  .h-w  { left: -6px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }
  .h-e  { right: -6px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }
  .rect-label {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    padding: 2px 6px;
    background: var(--luix);
    color: #fff;
    font-size: 10.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    border-radius: 3px;
    white-space: nowrap;
    pointer-events: none;
  }
  .controls {
    display: flex;
    gap: 14px;
    align-items: center;
    flex-wrap: wrap;
    padding: 12px 16px;
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    margin-bottom: 14px;
  }
  .controls label {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 11.5px;
    opacity: 0.85;
  }
  input[type="text"] {
    width: 70px;
    padding: 4px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
    user-select: text;
  }
  button {
    padding: 5px 11px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    font-size: 11.5px;
  }
  button.primary {
    background: var(--luix);
    color: #fff;
  }
  button:hover { filter: brightness(1.1); }
  .hint {
    font-size: 10.5px;
    opacity: 0.55;
    margin: -6px 0 14px;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  .info {
    font-size: 11px;
    opacity: 0.65;
    margin-bottom: 12px;
    font-variant-numeric: tabular-nums;
  }
  .err {
    padding: 14px;
    border-radius: 6px;
    background: rgba(255, 80, 80, 0.1);
    border: 1px solid rgba(255, 80, 80, 0.3);
    color: #ff8585;
    font-size: 12px;
    margin-bottom: 14px;
  }
</style>
</head>
<body>
<header>
  <h2>Rect editor</h2>
  <span class="badge" title="Actively being worked on">Preview</span>
</header>

<div class="info" id="info">Loading image…</div>
<div class="err" id="err" style="display:none"></div>

<div class="stage" id="stage">
  <div class="image-layer"><img id="image" alt=""/></div>
  <div class="zoom-bar" id="zoomBar" title="Zoom in / out · scroll on the canvas also zooms">
    <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/>
      <path d="M10.5 10.5 L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <button id="zoomOut" title="Zoom out (scroll down)">−</button>
    <span class="zoom-label" id="zoomLabel" title="Click to reset to 100%">100%</span>
    <button id="zoomIn" title="Zoom in (scroll up)">+</button>
  </div>
  <div class="rect" id="rect">
    <span class="rect-label" id="rectLabel"></span>
    <div class="crop-preview" id="cropPreview" style="display:none">
      <span class="crop-preview-label">Crop</span>
    </div>
    <div class="handle h-nw" data-h="nw"></div>
    <div class="handle h-n"  data-h="n" ></div>
    <div class="handle h-ne" data-h="ne"></div>
    <div class="handle h-w"  data-h="w" ></div>
    <div class="handle h-e"  data-h="e" ></div>
    <div class="handle h-sw" data-h="sw"></div>
    <div class="handle h-s"  data-h="s" ></div>
    <div class="handle h-se" data-h="se"></div>
  </div>
</div>

<div class="controls">
  <label>X <input type="text" inputmode="numeric" id="inX" maxlength="5"/></label>
  <label>Y <input type="text" inputmode="numeric" id="inY" maxlength="5"/></label>
  <label>W <input type="text" inputmode="numeric" id="inW" maxlength="5"/></label>
  <label>H <input type="text" inputmode="numeric" id="inH" maxlength="5"/></label>
  <button id="reset">Reset (full image)</button>
</div>

<div class="controls" style="margin-top:-6px">
  <label title="The image you see here is a thumbnail. Set this to the asset's actual pixel dimensions so the X/Y/W/H values match what Roblox renders in-game.">
    Source W <input type="text" inputmode="numeric" id="srcW" maxlength="6"/>
  </label>
  <label title="The image you see here is a thumbnail. Set this to the asset's actual pixel dimensions so the X/Y/W/H values match what Roblox renders in-game.">
    Source H <input type="text" inputmode="numeric" id="srcH" maxlength="6"/>
  </label>
  <label title="Aspect ratio of the destination ImageLabel (width / height). Auto-detected from a sibling UIAspectRatioConstraint or a fixed-pixel Size, when available. With ScaleType.Crop, anything outside the dashed inner box gets cropped away — drag the selection so the dashed box covers what you want shown.">
    Frame aspect <input type="text" inputmode="decimal" id="frameAspect" maxlength="7"/>
  </label>
  <span id="frameAspectLabel" style="font-size:10.5px; opacity:0.5"></span>
</div>

<div class="hint">
  Drag the rectangle to move · drag handles to resize · scroll fields or ↑/↓ to nudge · <strong>Shift</strong> = 10× step · dashed inner box = what Roblox actually renders under <code>ScaleType.Crop</code>
</div>

<div class="actions">
  <button id="cancel">Cancel</button>
  <button class="primary" id="apply">Apply</button>
</div>

<script>
  const vscode = acquireVsCodeApi();

  // Store rectangle coordinates in source pixels; scale only the preview.
  let srcW = 0, srcH = 0;
  let rectX = 0, rectY = 0, rectW = 0, rectH = 0; // All zeros mean the whole image.
  let frameAspect = 1.0; // Destination frame width/height.
  let scaleType = "Stretch";
  let viewScale = 1.0;

  const stage = document.getElementById("stage");
  const imageLayer = document.querySelector(".image-layer");
  const imageEl = document.getElementById("image");
  const rectEl = document.getElementById("rect");
  const rectLabel = document.getElementById("rectLabel");
  const cropPreview = document.getElementById("cropPreview");
  const inX = document.getElementById("inX");
  const inY = document.getElementById("inY");
  const inW = document.getElementById("inW");
  const inH = document.getElementById("inH");
  const srcWInput = document.getElementById("srcW");
  const srcHInput = document.getElementById("srcH");
  const frameAspectInput = document.getElementById("frameAspect");
  const frameAspectLabel = document.getElementById("frameAspectLabel");
  const info = document.getElementById("info");
  const err = document.getElementById("err");

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  // Allow oversized rectangles, capped at four times the source or 65535.
  const maxRect = () => Math.max(srcW * 4, 65535);

  // Apply the same scale and centering to the image and selection.
  function imageOriginPct() {
    return (1 - viewScale) / 2 * 100;
  }

  function paintImage() {
    if (!srcW || !srcH) return;
    stage.style.aspectRatio = srcW + " / " + srcH;
    const off = imageOriginPct();
    const size = viewScale * 100;
    imageLayer.style.left = off + "%";
    imageLayer.style.top = off + "%";
    imageLayer.style.width = size + "%";
    imageLayer.style.height = size + "%";
  }

  function paintRect() {
    if (!srcW || !srcH) return;
    const effectiveW = rectW > 0 ? rectW : srcW;
    const effectiveH = rectH > 0 ? rectH : srcH;
    const off = imageOriginPct();
    rectEl.style.left = (off + rectX / srcW * viewScale * 100).toFixed(3) + "%";
    rectEl.style.top  = (off + rectY / srcH * viewScale * 100).toFixed(3) + "%";
    rectEl.style.width  = (effectiveW / srcW * viewScale * 100).toFixed(3) + "%";
    rectEl.style.height = (effectiveH / srcH * viewScale * 100).toFixed(3) + "%";
    rectLabel.textContent =
      Math.round(rectX) + ", " + Math.round(rectY) + " · " +
      Math.round(effectiveW) + " × " + Math.round(effectiveH);
    const overflows =
      rectX + effectiveW > srcW || rectY + effectiveH > srcH ||
      rectX < 0 || rectY < 0;
    rectEl.classList.toggle("overflow", overflows);
    paintCropPreview(effectiveW, effectiveH);
  }

  /** Show the visible area after ScaleType.Crop fits the destination frame. */
  function paintCropPreview(effectiveW, effectiveH) {
    if (scaleType !== "Crop" || !frameAspect || !effectiveW || !effectiveH) {
      cropPreview.style.display = "none";
      return;
    }
    const rectAspect = effectiveW / effectiveH;
    let cropOffX = 0, cropOffY = 0, cropW = effectiveW, cropH = effectiveH;
    if (rectAspect > frameAspect) {
      cropH = effectiveH;
      cropW = effectiveH * frameAspect;
      cropOffX = (effectiveW - cropW) / 2;
    } else if (rectAspect < frameAspect) {
      cropW = effectiveW;
      cropH = effectiveW / frameAspect;
      cropOffY = (effectiveH - cropH) / 2;
    }
    cropPreview.style.display = "block";
    cropPreview.style.left = (cropOffX / effectiveW * 100).toFixed(3) + "%";
    cropPreview.style.top  = (cropOffY / effectiveH * 100).toFixed(3) + "%";
    cropPreview.style.width  = (cropW / effectiveW * 100).toFixed(3) + "%";
    cropPreview.style.height = (cropH / effectiveH * 100).toFixed(3) + "%";
  }

  function paintInputs() {
    if (document.activeElement !== inX) inX.value = String(Math.round(rectX));
    if (document.activeElement !== inY) inY.value = String(Math.round(rectY));
    if (document.activeElement !== inW) inW.value = String(Math.round(rectW));
    if (document.activeElement !== inH) inH.value = String(Math.round(rectH));
    if (document.activeElement !== srcWInput) srcWInput.value = String(srcW);
    if (document.activeElement !== srcHInput) srcHInput.value = String(srcH);
    if (document.activeElement !== frameAspectInput) {
      frameAspectInput.value = frameAspect.toFixed(4).replace(/\.?0+$/, "");
    }
    paintZoomBar();
  }

  const ZOOM_MIN = 0.15;
  const ZOOM_MAX = 3.0;
  const zoomLabel = document.getElementById("zoomLabel");
  const zoomInBtn = document.getElementById("zoomIn");
  const zoomOutBtn = document.getElementById("zoomOut");

  function paintZoomBar() {
    zoomLabel.textContent = Math.round(viewScale * 100) + "%";
    zoomInBtn.disabled = viewScale >= ZOOM_MAX - 0.001;
    zoomOutBtn.disabled = viewScale <= ZOOM_MIN + 0.001;
  }

  function setZoom(next) {
    viewScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    paint();
  }
  zoomInBtn.addEventListener("click", () => setZoom(viewScale * 1.25));
  zoomOutBtn.addEventListener("click", () => setZoom(viewScale * 0.8));
  zoomLabel.addEventListener("click", () => setZoom(1.0));

  function paint() { paintImage(); paintRect(); paintInputs(); }

  [inX, inY, inW, inH, srcWInput, srcHInput].forEach((el) =>
    el.addEventListener("beforeinput", (ev) => {
      if (!ev.data) return;
      if (!/^[0-9]+$/.test(ev.data)) ev.preventDefault();
    })
  );
  frameAspectInput.addEventListener("beforeinput", (ev) => {
    if (!ev.data) return;
    if (!/^[0-9.:,]+$/.test(ev.data)) ev.preventDefault();
  });

  // Offsets may be negative; dimensions must remain non-negative.
  function wireField(el, get, set, minFn = () => 0) {
    el.addEventListener("input", () => {
      const n = Number(el.value);
      if (!Number.isFinite(n) || n < minFn()) return;
      set(n);
      paintRect();
    });
    el.addEventListener("blur", () => { el.value = String(get()); });
    el.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const step = ev.shiftKey ? 10 : 1;
      const dir = ev.deltaY > 0 ? -1 : 1;
      set(Math.max(minFn(), get() + dir * step));
      el.value = String(get());
      paintRect();
    }, { passive: false });
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
      ev.preventDefault();
      const step = ev.shiftKey ? 10 : 1;
      const dir = ev.key === "ArrowUp" ? 1 : -1;
      set(Math.max(minFn(), get() + dir * step));
      el.value = String(get());
      paintRect();
    });
  }

  const negMaxRect = () => -maxRect();
  wireField(inX,
    () => Math.round(rectX),
    (v) => { rectX = clamp(v, -maxRect(), maxRect()); },
    negMaxRect);
  wireField(inY,
    () => Math.round(rectY),
    (v) => { rectY = clamp(v, -maxRect(), maxRect()); },
    negMaxRect);
  wireField(inW,
    () => Math.round(rectW),
    (v) => { rectW = clamp(v, 0, maxRect()); });
  wireField(inH,
    () => Math.round(rectH),
    (v) => { rectH = clamp(v, 0, maxRect()); });
  // Source dimensions rescale the preview without changing rectangle values.
  wireField(srcWInput,
    () => srcW,
    (v) => { srcW = Math.max(1, v); });
  wireField(srcHInput,
    () => srcH,
    (v) => { srcH = Math.max(1, v); });
  const persistDims = () => vscode.postMessage({
    type: "saveDims",
    width: srcW,
    height: srcH,
  });
  srcWInput.addEventListener("blur", persistDims);
  srcHInput.addEventListener("blur", persistDims);
  frameAspectInput.addEventListener("input", () => {
    const raw = frameAspectInput.value.trim();
    let v;
    const colon = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(raw);
    if (colon) {
      const w = Number(colon[1]), h = Number(colon[2]);
      v = h > 0 ? w / h : NaN;
    } else {
      v = Number(raw.replace(",", "."));
    }
    if (!Number.isFinite(v) || v <= 0) return;
    frameAspect = v;
    paintRect();
  });
  frameAspectInput.addEventListener("blur", () => {
    frameAspectInput.value = frameAspect.toFixed(4).replace(/\.?0+$/, "");
  });

  let drag = null;

  rectEl.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.classList.contains("handle")) return;
    ev.stopPropagation();
    drag = {
      kind: "move",
      pointerId: ev.pointerId,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      startX: rectX,
      startY: rectY,
    };
    rectEl.classList.add("dragging");
    rectEl.setPointerCapture(ev.pointerId);
    rectEl.addEventListener("pointermove", onDragMove);
    rectEl.addEventListener("pointerup", onDragEnd);
    rectEl.addEventListener("pointercancel", onDragEnd);
  });

  rectEl.querySelectorAll(".handle").forEach((h) => {
    h.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      drag = {
        kind: "resize",
        handle: h.dataset.h,
        pointerId: ev.pointerId,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        startX: rectX,
        startY: rectY,
        startW: rectW > 0 ? rectW : srcW,
        startH: rectH > 0 ? rectH : srcH,
      };
      h.setPointerCapture(ev.pointerId);
      h.addEventListener("pointermove", onDragMove);
      h.addEventListener("pointerup", onDragEnd);
      h.addEventListener("pointercancel", onDragEnd);
    });
  });

  function onDragMove(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const rect = stage.getBoundingClientRect();
    const dxPx = ev.clientX - drag.startClientX;
    const dyPx = ev.clientY - drag.startClientY;
    // Convert stage pixels to source pixels at the current zoom.
    const dx = (dxPx / (rect.width * viewScale)) * srcW;
    const dy = (dyPx / (rect.height * viewScale)) * srcH;
    // Allow selections beyond the image, within the configured limits.
    const M = maxRect();
    if (drag.kind === "move") {
      rectX = clamp(Math.round(drag.startX + dx), -M, M);
      rectY = clamp(Math.round(drag.startY + dy), -M, M);
    } else {
      const h = drag.handle;
      let nx = drag.startX, ny = drag.startY, nw = drag.startW, nh = drag.startH;
      if (h.includes("w")) { nx = drag.startX + dx; nw = drag.startW - dx; }
      if (h.includes("e")) { nw = drag.startW + dx; }
      if (h.includes("n")) { ny = drag.startY + dy; nh = drag.startH - dy; }
      if (h.includes("s")) { nh = drag.startH + dy; }
      const MIN = 1;
      nx = clamp(Math.round(nx), -M, M);
      ny = clamp(Math.round(ny), -M, M);
      nw = clamp(Math.round(nw), MIN, M);
      nh = clamp(Math.round(nh), MIN, M);
      rectX = nx; rectY = ny; rectW = nw; rectH = nh;
    }
    paint();
  }
  function onDragEnd(ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    try { ev.currentTarget.releasePointerCapture(ev.pointerId); } catch (e) {}
    ev.currentTarget.removeEventListener("pointermove", onDragMove);
    ev.currentTarget.removeEventListener("pointerup", onDragEnd);
    ev.currentTarget.removeEventListener("pointercancel", onDragEnd);
    rectEl.classList.remove("dragging");
    drag = null;
  }

  document.getElementById("reset").addEventListener("click", () => {
    rectX = 0; rectY = 0; rectW = 0; rectH = 0;
    paint();
  });

  stage.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const factor = ev.shiftKey ? 0.6 : 0.88;
    const delta = ev.deltaY > 0 ? factor : 1 / factor;
    viewScale = Math.max(0.15, Math.min(3.0, viewScale * delta));
    paint();
  }, { passive: false });

  document.getElementById("apply").addEventListener("click", () => {
    vscode.postMessage({
      type: "apply",
      offset: { x: rectX, y: rectY },
      size: { x: rectW, y: rectH },
    });
  });
  document.getElementById("cancel").addEventListener("click", () => {
    vscode.postMessage({ type: "cancel" });
  });

  window.addEventListener("keydown", (ev) => {
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (ev.key === "Enter") {
      vscode.postMessage({
        type: "apply",
        offset: { x: rectX, y: rectY },
        size: { x: rectW, y: rectH },
      });
      ev.preventDefault();
    } else if (ev.key === "Escape") {
      vscode.postMessage({ type: "cancel" });
      ev.preventDefault();
    }
  });

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg?.type !== "init") return;
    if (!msg.imageUrl) {
      err.style.display = "block";
      err.textContent =
        "Couldn't fetch the thumbnail for rbxassetid://" + msg.assetId +
        ". The asset may be moderated, deleted, or the API is unreachable.";
      info.style.display = "none";
      return;
    }
    imageEl.src = msg.imageUrl;
    imageEl.onload = () => {
      const tnW = imageEl.naturalWidth;
      const tnH = imageEl.naturalHeight;
      let originLabel;
      // Prefer cached manual or native dimensions over the thumbnail size.
      if (msg.cachedDims && msg.cachedDims.width && msg.cachedDims.height) {
        srcW = msg.cachedDims.width;
        srcH = msg.cachedDims.height;
        originLabel =
          msg.cachedDims.source === "openCloud"
            ? "auto-detected via Open Cloud"
            : msg.cachedDims.source === "manual"
              ? "remembered from your last edit"
              : "remembered from your last edit";
      } else {
        srcW = tnW;
        srcH = tnH;
        originLabel = msg.apiKeySet
          ? "Open Cloud lookup failed — type Source W/H if needed"
          : "thumbnail default — set luix.openCloud.apiKey for auto-detect, or type Source W/H";
      }
      rectX = msg.rectOffset?.x || 0;
      rectY = msg.rectOffset?.y || 0;
      rectW = msg.rectSize?.x || 0;
      rectH = msg.rectSize?.y || 0;
      frameAspect = (typeof msg.frameAspect === "number" && msg.frameAspect > 0)
        ? msg.frameAspect : 1.0;
      scaleType = msg.scaleType || "Stretch";
      const aspectFrom = msg.frameAspectSource || "default";
      frameAspectLabel.textContent =
        "← from " + aspectFrom + " · ScaleType." + scaleType +
        (scaleType === "Crop"
          ? " (dashed inner box shows visible area)"
          : " (dashed crop overlay only applies to ScaleType.Crop)");
      info.textContent =
        "rbxassetid://" + msg.assetId + " · thumbnail " + tnW + "×" + tnH +
        " px · source " + srcW + "×" + srcH + " px · " + originLabel;
      paint();
    };
    imageEl.onerror = () => {
      err.style.display = "block";
      err.textContent = "Failed to load thumbnail image.";
      info.style.display = "none";
    };
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}
