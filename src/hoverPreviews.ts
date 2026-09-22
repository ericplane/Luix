import * as vscode from "vscode";
import {
  extractPropEntriesFromDocument,
  findAllCreateElementCalls,
} from "./parser";
import { getAliasPartition } from "./frameworks";
import { getConfig } from "./configCompat";
import { findMatchingParen } from "./textUtils";

// ============================================================================
// Visual hover previews — TweenInfo easing curves, UIPadding box,
// UICorner radius, UIStroke thickness. Each renders a small SVG as a
// data URI inside the markdown hover, so the user sees what the value
// actually looks like without leaving the editor.
// ============================================================================

export class UIHoverPreviewsProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    if (!getConfig<boolean>("hoverPreviews.enabled", true)) {
      return undefined;
    }
    const text = document.getText();
    const offset = document.offsetAt(position);

    // 1) TweenInfo.new(...) anywhere under the cursor.
    const tween = tryTweenInfoHover(text, offset, document);
    if (tween) {
      return tween;
    }

    // 2) Cursor on the className of e("UIPadding"|"UICorner"|"UIStroke", …).
    const elem = tryElementPreviewHover(text, offset, document);
    if (elem) {
      return elem;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// TweenInfo
// ---------------------------------------------------------------------------
const TWEEN_INFO_RE = /\bTweenInfo\.new\s*\(/g;

function tryTweenInfoHover(
  text: string,
  offset: number,
  document: vscode.TextDocument
): vscode.Hover | undefined {
  // Fast reject: skip the regex scan entirely for documents that don't
  // mention TweenInfo at all (the common case in pure-UI files).
  if (!text.includes("TweenInfo.new")) {
    return undefined;
  }
  // Scan backwards & forwards for the nearest TweenInfo.new(...) call
  // whose range contains the cursor.
  TWEEN_INFO_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TWEEN_INFO_RE.exec(text)) !== null) {
    const start = m.index;
    const openParen = m.index + m[0].length - 1;
    const end = findMatchingParen(text, openParen);
    if (end === -1) {
      continue;
    }
    if (offset < start || offset > end + 1) {
      continue;
    }
    const argsText = text.slice(openParen + 1, end);
    const parsed = parseTweenInfoArgs(argsText);
    const md = renderTweenInfoMarkdown(parsed);
    return new vscode.Hover(
      md,
      new vscode.Range(
        document.positionAt(start),
        document.positionAt(end + 1)
      )
    );
  }
  return undefined;
}

interface ParsedTweenInfo {
  duration: number;
  style: string;
  direction: string;
  repeatCount: number;
  reverses: boolean;
  delayTime: number;
}

function parseTweenInfoArgs(argsText: string): ParsedTweenInfo {
  // TweenInfo.new(time, style?, direction?, repeatCount?, reverses?, delayTime?)
  // Split at top-level commas — easy here since args are simple values.
  const args = splitTopLevelCommas(argsText).map((s) => s.trim());
  const duration = Number(args[0]);
  const styleMatch = args[1] && /Enum\.EasingStyle\.(\w+)/.exec(args[1]);
  const dirMatch = args[2] && /Enum\.EasingDirection\.(\w+)/.exec(args[2]);
  const repeatCount = args[3] !== undefined ? Number(args[3]) : 0;
  const reverses = args[4] !== undefined ? args[4] === "true" : false;
  const delayTime = args[5] !== undefined ? Number(args[5]) : 0;
  return {
    duration: Number.isFinite(duration) ? duration : 1,
    style: styleMatch ? styleMatch[1] : "Quad",
    direction: dirMatch ? dirMatch[1] : "Out",
    repeatCount: Number.isFinite(repeatCount) ? repeatCount : 0,
    reverses,
    delayTime: Number.isFinite(delayTime) ? delayTime : 0,
  };
}

function renderTweenInfoMarkdown(p: ParsedTweenInfo): vscode.MarkdownString {
  const svg = renderTweenCurveSvg(p.style, p.direction);
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

  const lines: string[] = [];
  lines.push(`**TweenInfo** · \`${p.style}\` · \`${p.direction}\``);
  lines.push("");
  lines.push(`![](${dataUri})`);
  lines.push("");
  const parts: string[] = [`${p.duration}s`];
  if (p.repeatCount !== 0) {
    parts.push(
      p.repeatCount === -1 ? "repeats ∞" : `repeats ${p.repeatCount}×`
    );
  }
  if (p.reverses) {
    parts.push("reverses");
  }
  if (p.delayTime !== 0) {
    parts.push(`delay ${p.delayTime}s`);
  }
  lines.push(parts.join(" · "));

  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

function renderTweenCurveSvg(style: string, direction: string): string {
  const W = 240;
  const H = 140;
  const PAD_L = 14;
  const PAD_R = 6;
  const PAD_T = 6;
  const PAD_B = 14;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const base = EASINGS[style] || EASINGS.Quad;
  const fn = applyDirection(base, direction);

  // Sample the curve.
  const STEPS = 60;
  const pts: string[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    // Roblox curves can exceed [0..1] (Back / Elastic overshoot). Clamp
    // VISUALLY to [-0.25 .. 1.25] so we still see the overshoot.
    const v = fn(t);
    const x = PAD_L + t * plotW;
    const y = PAD_T + (1 - (v + 0.25) / 1.5) * plotH;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }

  // Grid lines + reference [0..1] band
  const yAt0 = PAD_T + (1 - (0 + 0.25) / 1.5) * plotH;
  const yAt1 = PAD_T + (1 - (1 + 0.25) / 1.5) * plotH;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" rx="4" fill="rgba(127,127,127,0.08)"/>` +
    // Reference horizontal bars at value=0 and value=1
    `<line x1="${PAD_L}" y1="${yAt0}" x2="${W - PAD_R}" y2="${yAt0}" stroke="rgba(255,255,255,0.18)" stroke-width="0.5" stroke-dasharray="2 2"/>` +
    `<line x1="${PAD_L}" y1="${yAt1}" x2="${W - PAD_R}" y2="${yAt1}" stroke="rgba(255,255,255,0.18)" stroke-width="0.5" stroke-dasharray="2 2"/>` +
    // Axes
    `<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" stroke="rgba(255,255,255,0.25)" stroke-width="0.7"/>` +
    `<line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" stroke="rgba(255,255,255,0.25)" stroke-width="0.7"/>` +
    // Curve
    `<polyline points="${pts.join(" ")}" fill="none" stroke="#7C5CFF" stroke-width="1.7" stroke-linejoin="round"/>` +
    // Labels
    `<text x="3" y="${yAt1 + 3}" font-family="sans-serif" font-size="8" fill="rgba(255,255,255,0.5)">1</text>` +
    `<text x="3" y="${yAt0 + 3}" font-family="sans-serif" font-size="8" fill="rgba(255,255,255,0.5)">0</text>` +
    `<text x="${PAD_L}" y="${H - 3}" font-family="sans-serif" font-size="8" fill="rgba(255,255,255,0.5)">t=0</text>` +
    `<text x="${W - 24}" y="${H - 3}" font-family="sans-serif" font-size="8" fill="rgba(255,255,255,0.5)">t=1</text>` +
    `</svg>`
  );
}

type EasingFn = (t: number) => number;

const EASINGS: Record<string, EasingFn> = {
  Linear: (t) => t,
  Sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  Quad: (t) => t * t,
  Cubic: (t) => t * t * t,
  Quart: (t) => t * t * t * t,
  Quint: (t) => t * t * t * t * t,
  Exponential: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, 10 * (t - 1)),
  Circular: (t) => 1 - Math.sqrt(1 - t * t),
  Back: (t) => {
    const c = 1.70158;
    return t * t * ((c + 1) * t - c);
  },
  Bounce: (t) => 1 - bounceOut(1 - t),
  Elastic: (t) => {
    if (t === 0 || t === 1) {
      return t;
    }
    return (
      -Math.pow(2, 10 * (t - 1)) *
      Math.sin(((t - 1.075) * (2 * Math.PI)) / 0.3)
    );
  },
};

function bounceOut(t: number): number {
  if (t < 1 / 2.75) {
    return 7.5625 * t * t;
  } else if (t < 2 / 2.75) {
    t -= 1.5 / 2.75;
    return 7.5625 * t * t + 0.75;
  } else if (t < 2.5 / 2.75) {
    t -= 2.25 / 2.75;
    return 7.5625 * t * t + 0.9375;
  }
  t -= 2.625 / 2.75;
  return 7.5625 * t * t + 0.984375;
}

function applyDirection(fn: EasingFn, dir: string): EasingFn {
  if (dir === "Out") {
    return (t) => 1 - fn(1 - t);
  }
  if (dir === "InOut") {
    return (t) =>
      t < 0.5 ? fn(2 * t) / 2 : 1 - fn(2 - 2 * t) / 2;
  }
  return fn; // In (or default)
}

// ---------------------------------------------------------------------------
// Element previews — UIPadding, UICorner, UIStroke
// ---------------------------------------------------------------------------
function tryElementPreviewHover(
  text: string,
  offset: number,
  document: vscode.TextDocument
): vscode.Hover | undefined {
  // Fast reject: only UIPadding / UICorner / UIStroke get a preview.
  // Hover fires every time the cursor settles for ~300ms, so a full
  // createElement scan on a 10k-line file with none of these wastes a
  // measurable amount of time on every hover.
  if (
    text.indexOf("UIPadding") === -1 &&
    text.indexOf("UICorner") === -1 &&
    text.indexOf("UIStroke") === -1 &&
    text.indexOf("UIShadow") === -1
  ) {
    return undefined;
  }
  const aliases = getAliasPartition();
  const calls = findAllCreateElementCalls(text, aliases);
  // Find the call whose CLASS NAME the cursor is over.
  const call = calls.find(
    (c) =>
      c.isStringLiteralName &&
      offset >= c.classNameStart &&
      offset <= c.classNameEnd
  );
  if (!call) {
    return undefined;
  }
  if (
    call.propsBraceStart === undefined ||
    call.propsBraceEnd === undefined
  ) {
    return undefined;
  }
  const propsBody = text.slice(
    call.propsBraceStart + 1,
    call.propsBraceEnd
  );
  const entries = extractPropEntriesFromDocument(
    text,
    call.propsBraceStart + 1,
    call.propsBraceEnd
  );
  const propMap = new Map<string, string>();
  for (const entry of entries) {
    propMap.set(
      entry.key,
      propsBody.slice(entry.valueStart, entry.valueEnd).trim()
    );
  }

  let md: vscode.MarkdownString | undefined;
  switch (call.className) {
    case "UIPadding":
      md = renderUIPaddingMarkdown(propMap);
      break;
    case "UICorner":
      md = renderUICornerMarkdown(propMap);
      break;
    case "UIStroke":
      md = renderUIStrokeMarkdown(propMap);
      break;
    case "UIShadow":
      md = renderUIShadowMarkdown(propMap);
      break;
  }
  if (!md) {
    return undefined;
  }
  return new vscode.Hover(
    md,
    new vscode.Range(
      document.positionAt(call.classNameStart),
      document.positionAt(call.classNameEnd)
    )
  );
}

function parseUDimOffset(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const m = /UDim\.new\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(
    value
  );
  if (!m) {
    return 0;
  }
  // Treat scale = 0, offset only — for visualization purposes use offset.
  return Number(m[2]);
}

function parseColor3Hex(value: string | undefined): string {
  if (!value) {
    return "#FFFFFF";
  }
  let m = /Color3\.fromRGB\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(
    value
  );
  if (m) {
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    const h = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  m = /Color3\.fromHex\s*\(\s*["']?(#?[0-9a-fA-F]{3,8})["']?\s*\)/.exec(value);
  if (m) {
    let s = m[1].replace(/^#/, "");
    if (s.length === 3) {
      s = s
        .split("")
        .map((c) => c + c)
        .join("");
    }
    return `#${s.toUpperCase()}`;
  }
  return "#FFFFFF";
}

function renderUIPaddingMarkdown(
  props: Map<string, string>
): vscode.MarkdownString {
  const top = parseUDimOffset(props.get("PaddingTop"));
  const right = parseUDimOffset(props.get("PaddingRight"));
  const bottom = parseUDimOffset(props.get("PaddingBottom"));
  const left = parseUDimOffset(props.get("PaddingLeft"));

  const W = 200;
  const H = 140;
  // Scale padding values to fit visually. Cap visible padding at 35% of
  // each side so the inner box doesn't collapse.
  const maxScale = (px: number, side: number) =>
    px <= 0 ? 0 : Math.min(0.35, px / 80) * side;
  const tPx = maxScale(top, H);
  const rPx = maxScale(right, W);
  const bPx = maxScale(bottom, H);
  const lPx = maxScale(left, W);

  const innerX = lPx;
  const innerY = tPx;
  const innerW = W - lPx - rPx;
  const innerH = H - tPx - bPx;

  const label = (x: number, y: number, val: number) =>
    val > 0
      ? `<text x="${x}" y="${y}" font-family="sans-serif" font-size="10" font-weight="600" fill="#FFFFFF" text-anchor="middle">${val}</text>`
      : "";

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" rx="4" fill="rgba(124,92,255,0.18)" stroke="#7C5CFF" stroke-width="1"/>` +
    `<rect x="${innerX}" y="${innerY}" width="${innerW}" height="${innerH}" rx="3" fill="rgba(127,127,127,0.15)" stroke="rgba(255,255,255,0.35)" stroke-width="0.7" stroke-dasharray="3 2"/>` +
    label(W / 2, tPx > 0 ? tPx / 2 + 4 : 14, top) +
    label(W / 2, H - (bPx > 0 ? bPx / 2 - 4 : 6), bottom) +
    `<text x="${lPx > 0 ? lPx / 2 : 6}" y="${H / 2 + 4}" font-family="sans-serif" font-size="10" font-weight="600" fill="#FFFFFF" text-anchor="middle">${left || ""}</text>` +
    `<text x="${W - (rPx > 0 ? rPx / 2 : 6)}" y="${H / 2 + 4}" font-family="sans-serif" font-size="10" font-weight="600" fill="#FFFFFF" text-anchor="middle">${right || ""}</text>` +
    `</svg>`;
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

  const lines: string[] = [];
  lines.push("**UIPadding**");
  lines.push("");
  lines.push(`![](${uri})`);
  lines.push("");
  lines.push(`T \`${top}\` · R \`${right}\` · B \`${bottom}\` · L \`${left}\``);
  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

export interface CornerRadii {
  tl: number;
  tr: number;
  br: number;
  bl: number;
  /** True when the radii came from a uniform `CornerRadius` (which
   *  overrides the individual props at runtime). */
  fromCornerRadius: boolean;
}

/**
 * Resolve the four effective corner radii (offset px) from a UICorner's
 * props. `CornerRadius` — when present — sets all four and overrides the
 * individual props (matching Roblox). Otherwise each corner reads its
 * own `*Radius` prop (missing → 0). Pure — unit-tested.
 */
export function cornerRadiiFromProps(props: Map<string, string>): CornerRadii {
  const cornerRadius = props.get("CornerRadius");
  if (cornerRadius) {
    const r = Math.max(0, parseUDimOffset(cornerRadius));
    return { tl: r, tr: r, br: r, bl: r, fromCornerRadius: true };
  }
  return {
    tl: Math.max(0, parseUDimOffset(props.get("TopLeftRadius"))),
    tr: Math.max(0, parseUDimOffset(props.get("TopRightRadius"))),
    br: Math.max(0, parseUDimOffset(props.get("BottomRightRadius"))),
    bl: Math.max(0, parseUDimOffset(props.get("BottomLeftRadius"))),
    fromCornerRadius: false,
  };
}

/**
 * SVG path for a rectangle with independent corner radii. A `<rect>`
 * only supports a single `rx`/`ry`, so per-corner rounding needs a path
 * with an arc at each rounded corner (and a sharp line where the radius
 * is 0). Drawn clockwise from the top edge. Pure — unit-tested.
 */
export function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number
): string {
  const parts: string[] = [];
  parts.push(`M ${x + tl} ${y}`);
  parts.push(`H ${x + w - tr}`);
  if (tr > 0) {parts.push(`A ${tr} ${tr} 0 0 1 ${x + w} ${y + tr}`);}
  parts.push(`V ${y + h - br}`);
  if (br > 0) {parts.push(`A ${br} ${br} 0 0 1 ${x + w - br} ${y + h}`);}
  parts.push(`H ${x + bl}`);
  if (bl > 0) {parts.push(`A ${bl} ${bl} 0 0 1 ${x} ${y + h - bl}`);}
  parts.push(`V ${y + tl}`);
  if (tl > 0) {parts.push(`A ${tl} ${tl} 0 0 1 ${x + tl} ${y}`);}
  parts.push("Z");
  return parts.join(" ");
}

function renderUICornerMarkdown(
  props: Map<string, string>
): vscode.MarkdownString {
  const W = 200;
  const H = 110;
  const x = 10;
  const y = 10;
  const w = W - 20;
  const h = H - 20;
  // Cap each visual radius so the box keeps a recognisable shape (and
  // can't exceed half the side, which would distort the path).
  const maxR = Math.min(40, Math.min(w, h) / 2);
  const clamp = (n: number) => Math.max(0, Math.min(maxR, n));

  const radii = cornerRadiiFromProps(props);
  const path = roundedRectPath(
    x,
    y,
    w,
    h,
    clamp(radii.tl),
    clamp(radii.tr),
    clamp(radii.br),
    clamp(radii.bl)
  );

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<path d="${path}" fill="#7C5CFF" opacity="0.85" stroke="#FFFFFF" stroke-width="1"/>` +
    `</svg>`;
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const lines: string[] = [];
  lines.push("**UICorner**");
  lines.push("");
  lines.push(`![](${uri})`);
  lines.push("");
  if (radii.fromCornerRadius) {
    // Surface a scale component in the label when CornerRadius uses one.
    const m = /UDim\.new\s*\(\s*(-?\d+(?:\.\d+)?)\s*,/.exec(
      props.get("CornerRadius") ?? ""
    );
    const scale = m ? Number(m[1]) : 0;
    const label =
      scale !== 0 ? `${scale} × parent + ${radii.tl} px` : `${radii.tl} px`;
    lines.push(`CornerRadius \`${label}\``);
  } else {
    lines.push(
      `TL \`${radii.tl}\` · TR \`${radii.tr}\` · BR \`${radii.br}\` · BL \`${radii.bl}\` px`
    );
  }
  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

function renderUIStrokeMarkdown(
  props: Map<string, string>
): vscode.MarkdownString {
  const thickness = Number(props.get("Thickness") ?? "1") || 1;
  const color = parseColor3Hex(props.get("Color"));
  const transparency = Number(props.get("Transparency") ?? "0") || 0;
  const applyStrokeMode = props.get("ApplyStrokeMode") ?? "Enum.ApplyStrokeMode.Contextual";
  const mode = /\.(\w+)$/.exec(applyStrokeMode)?.[1] ?? "Contextual";

  const W = 200;
  const H = 110;
  // Visual stroke — cap at 12 px so it doesn't dominate.
  const t = Math.min(12, Math.max(0, thickness));

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect x="${10 + t / 2}" y="${10 + t / 2}" width="${W - 20 - t}" height="${H - 20 - t}" rx="6" fill="rgba(127,127,127,0.12)" stroke="${color}" stroke-width="${t}" stroke-opacity="${1 - transparency}"/>` +
    `</svg>`;
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const lines: string[] = [];
  lines.push("**UIStroke**");
  lines.push("");
  lines.push(`![](${uri})`);
  lines.push("");
  lines.push(`Thickness \`${thickness}\` · Color \`${color}\` · Mode \`${mode}\``);
  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

/** Pull the offset (pixel) components out of a `UDim2` value —
 *  `UDim2.fromOffset(x, y)` or `UDim2.new(sx, ox, sy, oy)`. Scale-only
 *  forms read as 0 (we visualise pixels). */
function parseUDim2Offset(value: string | undefined): { x: number; y: number } {
  if (!value) {
    return { x: 0, y: 0 };
  }
  let m = /UDim2\.fromOffset\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(
    value
  );
  if (m) {
    return { x: Number(m[1]), y: Number(m[2]) };
  }
  m = /UDim2\.new\s*\(\s*-?\d+(?:\.\d+)?\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*-?\d+(?:\.\d+)?\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/.exec(
    value
  );
  if (m) {
    return { x: Number(m[1]), y: Number(m[2]) };
  }
  return { x: 0, y: 0 };
}

function renderUIShadowMarkdown(
  props: Map<string, string>
): vscode.MarkdownString {
  const offset = parseUDim2Offset(props.get("Offset"));
  const spread = parseUDim2Offset(props.get("Spread")).x;
  const blur = parseUDimOffset(props.get("BlurRadius"));
  const color = parseColor3Hex(props.get("Color"));
  const transparency = Number(props.get("Transparency") ?? "0") || 0;
  const shadowOpacity = Math.max(0, Math.min(1, 1 - transparency));

  const W = 200;
  const H = 140;
  // The element casting the shadow — centred with generous margins so
  // the shadow has room to render.
  const ex = 60;
  const ey = 42;
  const ew = 80;
  const eh = 56;
  // Clamp the visual magnitudes so a large blur/offset/spread doesn't
  // spill out of the preview box.
  const cap = (n: number, max: number) =>
    Math.max(-max, Math.min(max, n));
  const ox = cap(offset.x, 24);
  const oy = cap(offset.y, 24);
  const sp = cap(spread, 16);
  const bl = Math.max(0, cap(blur, 16));

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><filter id="luixshadow" x="-60%" y="-60%" width="220%" height="220%">` +
    `<feGaussianBlur stdDeviation="${(bl / 2).toFixed(2)}"/></filter></defs>` +
    // Background panel so the shadow reads against something.
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#1E1E26"/>` +
    // The shadow: element rect, expanded by spread, translated by offset, blurred.
    `<rect x="${ex - sp + ox}" y="${ey - sp + oy}" width="${ew + 2 * sp}" height="${eh + 2 * sp}" rx="8" fill="${color}" fill-opacity="${shadowOpacity.toFixed(2)}" filter="url(#luixshadow)"/>` +
    // The element on top.
    `<rect x="${ex}" y="${ey}" width="${ew}" height="${eh}" rx="8" fill="#7C5CFF" stroke="#FFFFFF" stroke-width="1"/>` +
    `</svg>`;
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const lines: string[] = [];
  lines.push("**UIShadow**");
  lines.push("");
  lines.push(`![](${uri})`);
  lines.push("");
  lines.push(
    `Offset \`${offset.x}, ${offset.y}\` · Blur \`${blur}\` · Spread \`${spread}\` · Color \`${color}\` · Transparency \`${transparency}\``
  );
  const md = new vscode.MarkdownString(lines.join("\n"));
  md.isTrusted = false;
  md.supportHtml = false;
  return md;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
// `findMatchingParen` lives in `./textUtils` — same implementation
// formerly duplicated here.

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "{" || c === "[") {
      depth++;
    } else if (c === ")" || c === "}" || c === "]") {
      depth--;
    } else if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) {
    out.push(cur);
  }
  return out;
}
