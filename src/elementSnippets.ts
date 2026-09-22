import * as vscode from "vscode";
import { buildCodeMask, findEnclosingPropsCall } from "./parser";
import { flattenClassEvents, flattenClassProps } from "./data";
import {
  FrameworkId,
  findFrameworkForAlias,
  getAliasPartition,
} from "./frameworks";
import {
  isAtPropKeyPosition,
  isInsideComputedKey,
  resolveEffectiveClass,
} from "./completion";
import { WorkspaceIndex } from "./workspaceIndex";
import { detectFrameworkForDocument } from "./activeFramework";
import { getConfig } from "./configCompat";
import { fusionSnippetBody } from "./fusionSnippets";

// ============================================================================
// Luix snippets — context-aware completion items
// ============================================================================
//
// These used to live in `snippets/luix.code-snippets` as static VS Code
// snippets. Static snippets have no context awareness: VS Code's fuzzy
// matcher fires them anywhere their prefix's chars appear, so typing
// `Fra` inside a string surfaced every `*Frame` snippet, typing `r`
// inside a string surfaced `reactEvent` / `rfc` / `useRef`, and typing
// `eFra` at a prop-key slot offered to expand into a full
// createElement call. Migrated to dynamic completions so we can gate
// by code mask + prop-key position + enabled frameworks.
//
// Gates applied per `kind` (as of 1.5.0):
//
//   - `element`  — Framework-gated to the *active* framework for the
//     document (per-file detection). Suppressed inside strings and at
//     prop-key positions (except in Vide where inline children are
//     valid props-table entries).
//   - `hook`     — React-only (Roact 1.x has no hooks API). Statement-
//     slot only — body is `local … = React.…`, would corrupt a table.
//   - `scaffold` — Per-framework (rfc/rofc/nfc/vfc each gate to their
//     own framework). Statement-slot only — body is a function decl.
//   - `event`    — Per-framework (reactEvent/roactEvent/onEvent/
//     videEvent). REQUIRES a props-table key position — body is a
//     `[Key] = function() … end` table entry.
//   - `state`    — Per-framework (Fusion Value/Computed/…, Vide
//     source/derive/…). Statement-slot only — body is `local … = …`.
//   - `expr`     — Framework-agnostic (cfangles, cfanglesrad).
//     Suppressed inside strings; surfaces in any UI file.
//   - `computed` — Generated dynamically inside `[…]` keys; framework-
//     specific bodies (React.Event / Roact.Event / OnEvent / OnChange
//     / Out) emitted only when active framework matches.

type SnippetKind =
  | "element"
  | "hook"
  | "scaffold"
  | "event"
  | "expr"
  | "computed"
  | "state";

interface LuixSnippet {
  /** Trigger prefix shown as the completion label. */
  prefix: string;
  /** What kind of snippet this is — drives the gating logic. */
  kind: SnippetKind;
  /** Framework whose factory the snippet expands to. Required for
   *  `kind: "element"`, ignored for the others (which use framework
   *  buckets internally). */
  framework?: FrameworkId;
  /** Snippet body (joined with `\n`). */
  body: string[];
  /** Hover description. */
  description: string;
}

const SNIPPETS: LuixSnippet[] = [
  // ---- React / Roact (parens form) ----
  {
    prefix: "eFrame",
    kind: "element",
    framework: "react",
    description: "Frame element with children slot",
    body: [
      'e("Frame", {',
      "\tSize = UDim2.fromScale(${1:1}, ${2:1}),",
      "\tBackgroundTransparency = ${3:1},",
      "\t$4",
      "}, {",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "eScrollingFrame",
    kind: "element",
    framework: "react",
    description: "ScrollingFrame element",
    body: [
      'e("ScrollingFrame", {',
      "\tSize = UDim2.fromScale(1, 1),",
      "\tBackgroundTransparency = 1,",
      "\tScrollBarThickness = ${1:6},",
      "\tCanvasSize = UDim2.new(${2:0, 0, 0, 0}),",
      "\t$3",
      "}, {",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "eTextLabel",
    kind: "element",
    framework: "react",
    description: "TextLabel element",
    body: [
      'e("TextLabel", {',
      '\tText = "${1:Hello}",',
      "\tTextColor3 = Color3.fromRGB(${2:255}, ${3:255}, ${4:255}),",
      "\tTextSize = ${5:18},",
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 0),",
      "\tAutomaticSize = Enum.AutomaticSize.Y,",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "eTextButton",
    kind: "element",
    framework: "react",
    description: "TextButton with Activated handler",
    body: [
      'e("TextButton", {',
      '\tText = "${1:Click me}",',
      "\tTextColor3 = Color3.fromRGB(${2:255}, ${3:255}, ${4:255}),",
      "\tTextSize = ${5:18},",
      "\tBackgroundTransparency = ${6:0},",
      "\tSize = UDim2.fromOffset(${7:120}, ${8:40}),",
      "\tAutoButtonColor = ${9:true},",
      "\t[React.Event.Activated] = function()",
      "\t\t$0",
      "\tend,",
      "})",
    ],
  },
  {
    prefix: "eImageLabel",
    kind: "element",
    framework: "react",
    description: "ImageLabel element",
    body: [
      'e("ImageLabel", {',
      '\tImage = "${1:rbxassetid://0}",',
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 1),",
      "\tScaleType = Enum.ScaleType.Fit,",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "eImageButton",
    kind: "element",
    framework: "react",
    description: "ImageButton with Activated handler",
    body: [
      'e("ImageButton", {',
      '\tImage = "${1:rbxassetid://0}",',
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 1),",
      "\tScaleType = Enum.ScaleType.Fit,",
      "\tAutoButtonColor = false,",
      "\t[React.Event.Activated] = function()",
      "\t\t$0",
      "\tend,",
      "})",
    ],
  },
  {
    prefix: "eUIListLayout",
    kind: "element",
    framework: "react",
    description: "UIListLayout",
    body: [
      'e("UIListLayout", {',
      "\tFillDirection = Enum.FillDirection.${1|Vertical,Horizontal|},",
      "\tHorizontalAlignment = Enum.HorizontalAlignment.${2|Left,Center,Right|},",
      "\tVerticalAlignment = Enum.VerticalAlignment.${3|Top,Center,Bottom|},",
      "\tSortOrder = Enum.SortOrder.LayoutOrder,",
      "\tPadding = UDim.new(0, ${4:8}),",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "eUIGridLayout",
    kind: "element",
    framework: "react",
    description: "UIGridLayout",
    body: [
      'e("UIGridLayout", {',
      "\tCellSize = UDim2.fromOffset(${1:100}, ${2:100}),",
      "\tCellPadding = UDim2.fromOffset(${3:8}, ${4:8}),",
      "\tHorizontalAlignment = Enum.HorizontalAlignment.Left,",
      "\tSortOrder = Enum.SortOrder.LayoutOrder,",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "eUIPadding",
    kind: "element",
    framework: "react",
    description: "UIPadding (all sides)",
    body: [
      'e("UIPadding", {',
      "\tPaddingTop = UDim.new(0, ${1:8}),",
      "\tPaddingBottom = UDim.new(0, ${2:8}),",
      "\tPaddingLeft = UDim.new(0, ${3:8}),",
      "\tPaddingRight = UDim.new(0, ${4:8}),",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "eUICorner",
    kind: "element",
    framework: "react",
    description: "UICorner",
    body: ['e("UICorner", {', "\tCornerRadius = UDim.new(0, ${1:8}),", "})$0"],
  },
  {
    prefix: "eUIStroke",
    kind: "element",
    framework: "react",
    description: "UIStroke",
    body: [
      'e("UIStroke", {',
      "\tColor = Color3.fromRGB(${1:255}, ${2:255}, ${3:255}),",
      "\tThickness = ${4:1},",
      "\tApplyStrokeMode = Enum.ApplyStrokeMode.Contextual,",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "eUIShadow",
    kind: "element",
    framework: "react",
    description: "UIShadow",
    body: [
      'e("UIShadow", {',
      "\tColor = Color3.fromRGB(${1:0}, ${2:0}, ${3:0}),",
      "\tOffset = UDim2.fromOffset(${4:0}, ${5:4}),",
      "\tBlurRadius = UDim.new(0, ${6:8}),",
      "\tTransparency = ${7:0.5},",
      "\t$0",
      "})",
    ],
  },

  // ---- Fusion (curried form, table-key children) ----
  {
    prefix: "nFrame",
    kind: "element",
    framework: "fusion",
    description: "Fusion Frame element with [Children]",
    body: [
      'New "Frame" {',
      "\tSize = UDim2.fromScale(${1:1}, ${2:1}),",
      "\tBackgroundTransparency = ${3:1},",
      "\t$4",
      "\t[Children] = {",
      "\t\t$0",
      "\t},",
      "}",
    ],
  },
  {
    prefix: "nTextLabel",
    kind: "element",
    framework: "fusion",
    description: "Fusion TextLabel",
    body: [
      'New "TextLabel" {',
      '\tText = "${1:Hello}",',
      "\tTextColor3 = Color3.fromRGB(${2:255}, ${3:255}, ${4:255}),",
      "\tTextSize = ${5:18},",
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 0),",
      "\tAutomaticSize = Enum.AutomaticSize.Y,",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "nTextButton",
    kind: "element",
    framework: "fusion",
    description: 'Fusion TextButton with [OnEvent "Activated"]',
    body: [
      'New "TextButton" {',
      '\tText = "${1:Click me}",',
      "\tSize = UDim2.fromOffset(${2:120}, ${3:40}),",
      "\tBackgroundColor3 = Color3.fromRGB(${4:80}, ${5:80}, ${6:80}),",
      "\tAutoButtonColor = true,",
      '\t[OnEvent "Activated"] = function()',
      "\t\t$0",
      "\tend,",
      "}",
    ],
  },

  // ---- Vide (curried form, inline children) ----
  {
    prefix: "cFrame",
    kind: "element",
    framework: "vide",
    description: "Vide Frame element (inline children)",
    body: [
      'create "Frame" {',
      "\tSize = UDim2.fromScale(${1:1}, ${2:1}),",
      "\tBackgroundTransparency = ${3:1},",
      "\t$4",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "cTextLabel",
    kind: "element",
    framework: "vide",
    description: "Vide TextLabel",
    body: [
      'create "TextLabel" {',
      '\tText = "${1:Hello}",',
      "\tTextColor3 = Color3.fromRGB(${2:255}, ${3:255}, ${4:255}),",
      "\tTextSize = ${5:18},",
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 0),",
      "\tAutomaticSize = Enum.AutomaticSize.Y,",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "cTextButton",
    kind: "element",
    framework: "vide",
    description: "Vide TextButton (events as plain props)",
    body: [
      'create "TextButton" {',
      '\tText = "${1:Click me}",',
      "\tSize = UDim2.fromOffset(${2:120}, ${3:40}),",
      "\tBackgroundColor3 = Color3.fromRGB(${4:80}, ${5:80}, ${6:80}),",
      "\tAutoButtonColor = true,",
      "\tActivated = function()",
      "\t\t$0",
      "\tend,",
      "}",
    ],
  },

  // ---- Fusion — remaining element types to match React's 11-set ----
  {
    prefix: "nScrollingFrame",
    kind: "element",
    framework: "fusion",
    description: "Fusion ScrollingFrame with [Children]",
    body: [
      'New "ScrollingFrame" {',
      "\tSize = UDim2.fromScale(1, 1),",
      "\tBackgroundTransparency = 1,",
      "\tScrollBarThickness = ${1:6},",
      "\tCanvasSize = UDim2.new(${2:0, 0, 0, 0}),",
      "\t$3",
      "\t[Children] = {",
      "\t\t$0",
      "\t},",
      "}",
    ],
  },
  {
    prefix: "nImageLabel",
    kind: "element",
    framework: "fusion",
    description: "Fusion ImageLabel",
    body: [
      'New "ImageLabel" {',
      '\tImage = "${1:rbxassetid://0}",',
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 1),",
      "\tScaleType = Enum.ScaleType.Fit,",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "nImageButton",
    kind: "element",
    framework: "fusion",
    description: 'Fusion ImageButton with [OnEvent "Activated"]',
    body: [
      'New "ImageButton" {',
      '\tImage = "${1:rbxassetid://0}",',
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 1),",
      "\tScaleType = Enum.ScaleType.Fit,",
      "\tAutoButtonColor = false,",
      '\t[OnEvent "Activated"] = function()',
      "\t\t$0",
      "\tend,",
      "}",
    ],
  },
  {
    prefix: "nUIListLayout",
    kind: "element",
    framework: "fusion",
    description: "Fusion UIListLayout",
    body: [
      'New "UIListLayout" {',
      "\tFillDirection = Enum.FillDirection.${1|Vertical,Horizontal|},",
      "\tHorizontalAlignment = Enum.HorizontalAlignment.${2|Left,Center,Right|},",
      "\tVerticalAlignment = Enum.VerticalAlignment.${3|Top,Center,Bottom|},",
      "\tSortOrder = Enum.SortOrder.LayoutOrder,",
      "\tPadding = UDim.new(0, ${4:8}),",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "nUIGridLayout",
    kind: "element",
    framework: "fusion",
    description: "Fusion UIGridLayout",
    body: [
      'New "UIGridLayout" {',
      "\tCellSize = UDim2.fromOffset(${1:100}, ${2:100}),",
      "\tCellPadding = UDim2.fromOffset(${3:8}, ${4:8}),",
      "\tHorizontalAlignment = Enum.HorizontalAlignment.Left,",
      "\tSortOrder = Enum.SortOrder.LayoutOrder,",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "nUIPadding",
    kind: "element",
    framework: "fusion",
    description: "Fusion UIPadding (all sides)",
    body: [
      'New "UIPadding" {',
      "\tPaddingTop = UDim.new(0, ${1:8}),",
      "\tPaddingBottom = UDim.new(0, ${2:8}),",
      "\tPaddingLeft = UDim.new(0, ${3:8}),",
      "\tPaddingRight = UDim.new(0, ${4:8}),",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "nUICorner",
    kind: "element",
    framework: "fusion",
    description: "Fusion UICorner",
    body: ['New "UICorner" {', "\tCornerRadius = UDim.new(0, ${1:8}),", "}$0"],
  },
  {
    prefix: "nUIStroke",
    kind: "element",
    framework: "fusion",
    description: "Fusion UIStroke",
    body: [
      'New "UIStroke" {',
      "\tColor = Color3.fromRGB(${1:255}, ${2:255}, ${3:255}),",
      "\tThickness = ${4:1},",
      "\tApplyStrokeMode = Enum.ApplyStrokeMode.Contextual,",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "nUIShadow",
    kind: "element",
    framework: "fusion",
    description: "Fusion UIShadow",
    body: [
      'New "UIShadow" {',
      "\tColor = Color3.fromRGB(${1:0}, ${2:0}, ${3:0}),",
      "\tOffset = UDim2.fromOffset(${4:0}, ${5:4}),",
      "\tBlurRadius = UDim.new(0, ${6:8}),",
      "\tTransparency = ${7:0.5},",
      "\t$0",
      "}",
    ],
  },

  // ---- Vide — remaining element types to match React's 11-set ----
  {
    prefix: "cScrollingFrame",
    kind: "element",
    framework: "vide",
    description: "Vide ScrollingFrame (inline children)",
    body: [
      'create "ScrollingFrame" {',
      "\tSize = UDim2.fromScale(1, 1),",
      "\tBackgroundTransparency = 1,",
      "\tScrollBarThickness = ${1:6},",
      "\tCanvasSize = UDim2.new(${2:0, 0, 0, 0}),",
      "\t$3",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "cImageLabel",
    kind: "element",
    framework: "vide",
    description: "Vide ImageLabel",
    body: [
      'create "ImageLabel" {',
      '\tImage = "${1:rbxassetid://0}",',
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 1),",
      "\tScaleType = Enum.ScaleType.Fit,",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "cImageButton",
    kind: "element",
    framework: "vide",
    description: "Vide ImageButton (events as plain props)",
    body: [
      'create "ImageButton" {',
      '\tImage = "${1:rbxassetid://0}",',
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 1),",
      "\tScaleType = Enum.ScaleType.Fit,",
      "\tAutoButtonColor = false,",
      "\tActivated = function()",
      "\t\t$0",
      "\tend,",
      "}",
    ],
  },
  {
    prefix: "cUIListLayout",
    kind: "element",
    framework: "vide",
    description: "Vide UIListLayout",
    body: [
      'create "UIListLayout" {',
      "\tFillDirection = Enum.FillDirection.${1|Vertical,Horizontal|},",
      "\tHorizontalAlignment = Enum.HorizontalAlignment.${2|Left,Center,Right|},",
      "\tVerticalAlignment = Enum.VerticalAlignment.${3|Top,Center,Bottom|},",
      "\tSortOrder = Enum.SortOrder.LayoutOrder,",
      "\tPadding = UDim.new(0, ${4:8}),",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "cUIGridLayout",
    kind: "element",
    framework: "vide",
    description: "Vide UIGridLayout",
    body: [
      'create "UIGridLayout" {',
      "\tCellSize = UDim2.fromOffset(${1:100}, ${2:100}),",
      "\tCellPadding = UDim2.fromOffset(${3:8}, ${4:8}),",
      "\tHorizontalAlignment = Enum.HorizontalAlignment.Left,",
      "\tSortOrder = Enum.SortOrder.LayoutOrder,",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "cUIPadding",
    kind: "element",
    framework: "vide",
    description: "Vide UIPadding (all sides)",
    body: [
      'create "UIPadding" {',
      "\tPaddingTop = UDim.new(0, ${1:8}),",
      "\tPaddingBottom = UDim.new(0, ${2:8}),",
      "\tPaddingLeft = UDim.new(0, ${3:8}),",
      "\tPaddingRight = UDim.new(0, ${4:8}),",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "cUICorner",
    kind: "element",
    framework: "vide",
    description: "Vide UICorner",
    body: [
      'create "UICorner" {',
      "\tCornerRadius = UDim.new(0, ${1:8}),",
      "}$0",
    ],
  },
  {
    prefix: "cUIStroke",
    kind: "element",
    framework: "vide",
    description: "Vide UIStroke",
    body: [
      'create "UIStroke" {',
      "\tColor = Color3.fromRGB(${1:255}, ${2:255}, ${3:255}),",
      "\tThickness = ${4:1},",
      "\tApplyStrokeMode = Enum.ApplyStrokeMode.Contextual,",
      "\t$0",
      "}",
    ],
  },
  {
    prefix: "cUIShadow",
    kind: "element",
    framework: "vide",
    description: "Vide UIShadow",
    body: [
      'create "UIShadow" {',
      "\tColor = Color3.fromRGB(${1:0}, ${2:0}, ${3:0}),",
      "\tOffset = UDim2.fromOffset(${4:0}, ${5:4}),",
      "\tBlurRadius = UDim.new(0, ${6:8}),",
      "\tTransparency = ${7:0.5},",
      "\t$0",
      "}",
    ],
  },

  // ---- Roact — full 11-set (parens form, Roact.createElement) ----
  {
    prefix: "rFrame",
    kind: "element",
    framework: "roact",
    description: "Roact Frame element with children slot",
    body: [
      'Roact.createElement("Frame", {',
      "\tSize = UDim2.fromScale(${1:1}, ${2:1}),",
      "\tBackgroundTransparency = ${3:1},",
      "\t$4",
      "}, {",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "rScrollingFrame",
    kind: "element",
    framework: "roact",
    description: "Roact ScrollingFrame element",
    body: [
      'Roact.createElement("ScrollingFrame", {',
      "\tSize = UDim2.fromScale(1, 1),",
      "\tBackgroundTransparency = 1,",
      "\tScrollBarThickness = ${1:6},",
      "\tCanvasSize = UDim2.new(${2:0, 0, 0, 0}),",
      "\t$3",
      "}, {",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "rTextLabel",
    kind: "element",
    framework: "roact",
    description: "Roact TextLabel element",
    body: [
      'Roact.createElement("TextLabel", {',
      '\tText = "${1:Hello}",',
      "\tTextColor3 = Color3.fromRGB(${2:255}, ${3:255}, ${4:255}),",
      "\tTextSize = ${5:18},",
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 0),",
      "\tAutomaticSize = Enum.AutomaticSize.Y,",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "rTextButton",
    kind: "element",
    framework: "roact",
    description: "Roact TextButton with [Roact.Event.Activated]",
    body: [
      'Roact.createElement("TextButton", {',
      '\tText = "${1:Click me}",',
      "\tTextColor3 = Color3.fromRGB(${2:255}, ${3:255}, ${4:255}),",
      "\tTextSize = ${5:18},",
      "\tBackgroundTransparency = ${6:0},",
      "\tSize = UDim2.fromOffset(${7:120}, ${8:40}),",
      "\tAutoButtonColor = ${9:true},",
      "\t[Roact.Event.Activated] = function()",
      "\t\t$0",
      "\tend,",
      "})",
    ],
  },
  {
    prefix: "rImageLabel",
    kind: "element",
    framework: "roact",
    description: "Roact ImageLabel element",
    body: [
      'Roact.createElement("ImageLabel", {',
      '\tImage = "${1:rbxassetid://0}",',
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 1),",
      "\tScaleType = Enum.ScaleType.Fit,",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "rImageButton",
    kind: "element",
    framework: "roact",
    description: "Roact ImageButton with [Roact.Event.Activated]",
    body: [
      'Roact.createElement("ImageButton", {',
      '\tImage = "${1:rbxassetid://0}",',
      "\tBackgroundTransparency = 1,",
      "\tSize = UDim2.fromScale(1, 1),",
      "\tScaleType = Enum.ScaleType.Fit,",
      "\tAutoButtonColor = false,",
      "\t[Roact.Event.Activated] = function()",
      "\t\t$0",
      "\tend,",
      "})",
    ],
  },
  {
    prefix: "rUIListLayout",
    kind: "element",
    framework: "roact",
    description: "Roact UIListLayout",
    body: [
      'Roact.createElement("UIListLayout", {',
      "\tFillDirection = Enum.FillDirection.${1|Vertical,Horizontal|},",
      "\tHorizontalAlignment = Enum.HorizontalAlignment.${2|Left,Center,Right|},",
      "\tVerticalAlignment = Enum.VerticalAlignment.${3|Top,Center,Bottom|},",
      "\tSortOrder = Enum.SortOrder.LayoutOrder,",
      "\tPadding = UDim.new(0, ${4:8}),",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "rUIGridLayout",
    kind: "element",
    framework: "roact",
    description: "Roact UIGridLayout",
    body: [
      'Roact.createElement("UIGridLayout", {',
      "\tCellSize = UDim2.fromOffset(${1:100}, ${2:100}),",
      "\tCellPadding = UDim2.fromOffset(${3:8}, ${4:8}),",
      "\tHorizontalAlignment = Enum.HorizontalAlignment.Left,",
      "\tSortOrder = Enum.SortOrder.LayoutOrder,",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "rUIPadding",
    kind: "element",
    framework: "roact",
    description: "Roact UIPadding (all sides)",
    body: [
      'Roact.createElement("UIPadding", {',
      "\tPaddingTop = UDim.new(0, ${1:8}),",
      "\tPaddingBottom = UDim.new(0, ${2:8}),",
      "\tPaddingLeft = UDim.new(0, ${3:8}),",
      "\tPaddingRight = UDim.new(0, ${4:8}),",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "rUICorner",
    kind: "element",
    framework: "roact",
    description: "Roact UICorner",
    body: [
      'Roact.createElement("UICorner", {',
      "\tCornerRadius = UDim.new(0, ${1:8}),",
      "})$0",
    ],
  },
  {
    prefix: "rUIStroke",
    kind: "element",
    framework: "roact",
    description: "Roact UIStroke",
    body: [
      'Roact.createElement("UIStroke", {',
      "\tColor = Color3.fromRGB(${1:255}, ${2:255}, ${3:255}),",
      "\tThickness = ${4:1},",
      "\tApplyStrokeMode = Enum.ApplyStrokeMode.Contextual,",
      "\t$0",
      "})",
    ],
  },
  {
    prefix: "rUIShadow",
    kind: "element",
    framework: "roact",
    description: "Roact UIShadow",
    body: [
      'Roact.createElement("UIShadow", {',
      "\tColor = Color3.fromRGB(${1:0}, ${2:0}, ${3:0}),",
      "\tOffset = UDim2.fromOffset(${4:0}, ${5:4}),",
      "\tBlurRadius = UDim.new(0, ${6:8}),",
      "\tTransparency = ${7:0.5},",
      "\t$0",
      "})",
    ],
  },

  // ---- React / Roact hooks ----
  {
    prefix: "useState",
    kind: "hook",
    description: "React.useState",
    body: [
      "local ${1:value}, set${1/(.)/${1:/upcase}/} = React.useState(${2:nil})$0",
    ],
  },
  {
    prefix: "useEffect",
    kind: "hook",
    description: "React.useEffect",
    body: ["React.useEffect(function()", "\t$0", "end, { $1 })"],
  },
  {
    prefix: "useRef",
    kind: "hook",
    description: "React.useRef",
    body: ["local ${1:ref} = React.useRef(${2:nil})$0"],
  },
  {
    prefix: "useMemo",
    kind: "hook",
    description: "React.useMemo",
    body: [
      "local ${1:value} = React.useMemo(function()",
      "\treturn $0",
      "end, { $2 })",
    ],
  },
  {
    prefix: "useCallback",
    kind: "hook",
    description: "React.useCallback",
    body: [
      "local ${1:onCallback} = React.useCallback(function($2)",
      "\t$0",
      "end, { $3 })",
    ],
  },

  // ---- Function component scaffolds — one per framework ----
  {
    prefix: "rfc",
    kind: "scaffold",
    framework: "react",
    description: "React-Luau function component scaffold",
    body: [
      "local function ${1:Name}(props): React.ReactNode",
      '\treturn e("${2:Frame}", {',
      "\t\tSize = UDim2.fromScale(1, 1),",
      "\t\tBackgroundTransparency = 1,",
      "\t\t$3",
      "\t}, {",
      "\t\t$0",
      "\t})",
      "end",
      "",
      "return $1",
    ],
  },
  {
    prefix: "rofc",
    kind: "scaffold",
    framework: "roact",
    description: "Roact function component scaffold",
    body: [
      "local function ${1:Name}(props)",
      '\treturn Roact.createElement("${2:Frame}", {',
      "\t\tSize = UDim2.fromScale(1, 1),",
      "\t\tBackgroundTransparency = 1,",
      "\t\t$3",
      "\t}, {",
      "\t\t$0",
      "\t})",
      "end",
      "",
      "return $1",
    ],
  },
  {
    prefix: "nfc",
    kind: "scaffold",
    framework: "fusion",
    description: "Fusion function component scaffold",
    body: [
      "local function ${1:Name}(props)",
      '\treturn New "${2:Frame}" {',
      "\t\tSize = UDim2.fromScale(1, 1),",
      "\t\tBackgroundTransparency = 1,",
      "\t\t$3",
      "\t\t[Children] = {",
      "\t\t\t$0",
      "\t\t},",
      "\t}",
      "end",
      "",
      "return $1",
    ],
  },
  {
    prefix: "vfc",
    kind: "scaffold",
    framework: "vide",
    description: "Vide function component scaffold",
    body: [
      "local function ${1:Name}(props)",
      '\treturn create "${2:Frame}" {',
      "\t\tSize = UDim2.fromScale(1, 1),",
      "\t\tBackgroundTransparency = 1,",
      "\t\t$3",
      "\t\t$0",
      "\t}",
      "end",
      "",
      "return $1",
    ],
  },

  // ---- Per-framework event handler shorthand snippets ----
  // Each fires only when that framework is active, so a Vide file
  // won't surface `reactEvent` and a React file won't surface
  // Fusion's `onEvent`.
  {
    prefix: "reactEvent",
    kind: "event",
    framework: "react",
    description: "React.Event handler entry",
    body: [
      "[React.Event.${1|Activated,MouseEnter,MouseLeave,MouseButton1Click,InputBegan,InputEnded|}] = function(${2:rbx})",
      "\t$0",
      "end,",
    ],
  },
  {
    prefix: "roactEvent",
    kind: "event",
    framework: "roact",
    description: "Roact.Event handler entry",
    body: [
      "[Roact.Event.${1|Activated,MouseEnter,MouseLeave,MouseButton1Click,InputBegan,InputEnded|}] = function(${2:rbx})",
      "\t$0",
      "end,",
    ],
  },
  {
    prefix: "onEvent",
    kind: "event",
    framework: "fusion",
    description: 'Fusion [OnEvent "Name"] handler entry',
    body: [
      '[OnEvent "${1|Activated,MouseEnter,MouseLeave,MouseButton1Click,InputBegan,InputEnded|}"] = function(${2:rbx})',
      "\t$0",
      "end,",
    ],
  },
  {
    prefix: "videEvent",
    kind: "event",
    framework: "vide",
    description: "Vide event-as-prop handler entry",
    body: [
      "${1|Activated,MouseEnter,MouseLeave,MouseButton1Click,InputBegan,InputEnded|} = function(${2:rbx})",
      "\t$0",
      "end,",
    ],
  },

  // Computed-key starters (`React.Event.X` / `React.Change.X` inside
  // `[…]`) are generated *dynamically* in the provider so the choice
  // list reflects the actual element's events / properties — see the
  // `inComputed` branch in `provideCompletionItems`.

  // ---- Fusion state primitives ----
  {
    prefix: "value",
    kind: "state",
    framework: "fusion",
    description: "Fusion Value(...)",
    body: ["local ${1:name} = Value(${2:nil})$0"],
  },
  {
    prefix: "computed",
    kind: "state",
    framework: "fusion",
    description: "Fusion Computed(function() ... end)",
    body: [
      "local ${1:name} = Computed(function()",
      "\treturn $0",
      "end)",
    ],
  },
  {
    prefix: "spring",
    kind: "state",
    framework: "fusion",
    description: "Fusion Spring(state, speed, damping)",
    body: ["Spring(${1:state}, ${2:speed}, ${3:damping})$0"],
  },
  {
    prefix: "tween",
    kind: "state",
    framework: "fusion",
    description: "Fusion Tween(state, TweenInfo)",
    body: ["Tween(${1:state}, TweenInfo.new(${2:0.25}))$0"],
  },
  {
    prefix: "observer",
    kind: "state",
    framework: "fusion",
    description: "Fusion Observer with onChange handler",
    body: [
      "Observer(${1:target}):onChange(function()",
      "\t$0",
      "end)",
    ],
  },
  {
    prefix: "forKeys",
    kind: "state",
    framework: "fusion",
    description: "Fusion ForKeys(...)",
    body: [
      "ForKeys(${1:source}, function(key)",
      "\treturn $0",
      "end)",
    ],
  },
  {
    prefix: "forValues",
    kind: "state",
    framework: "fusion",
    description: "Fusion ForValues(...)",
    body: [
      "ForValues(${1:source}, function(value)",
      "\treturn $0",
      "end)",
    ],
  },
  {
    prefix: "forPairs",
    kind: "state",
    framework: "fusion",
    description: "Fusion ForPairs(...)",
    body: [
      "ForPairs(${1:source}, function(key, value)",
      "\treturn $0",
      "end)",
    ],
  },

  // ---- Vide state primitives ----
  {
    prefix: "source",
    kind: "state",
    framework: "vide",
    description: "Vide source(initial)",
    body: ["local ${1:name} = source(${2:nil})$0"],
  },
  {
    prefix: "derive",
    kind: "state",
    framework: "vide",
    description: "Vide derive(function() ... end)",
    body: [
      "local ${1:name} = derive(function()",
      "\treturn $0",
      "end)",
    ],
  },
  {
    prefix: "effect",
    kind: "state",
    framework: "vide",
    description: "Vide effect(function() ... end)",
    body: ["effect(function()", "\t$0", "end)"],
  },
  {
    prefix: "cleanup",
    kind: "state",
    framework: "vide",
    description: "Vide cleanup(function() ... end)",
    body: ["cleanup(function()", "\t$0", "end)"],
  },
  {
    prefix: "untrack",
    kind: "state",
    framework: "vide",
    description: "Vide untrack(function() ... end)",
    body: [
      "untrack(function()",
      "\treturn $0",
      "end)",
    ],
  },
  {
    prefix: "batch",
    kind: "state",
    framework: "vide",
    description: "Vide batch(function() ... end)",
    body: ["batch(function()", "\t$0", "end)"],
  },
  {
    prefix: "show",
    kind: "state",
    framework: "vide",
    description: "Vide show(source, function() ... end)",
    body: [
      "show(${1:source}, function()",
      "\treturn $0",
      "end)",
    ],
  },
  {
    prefix: "switch",
    kind: "state",
    framework: "vide",
    description: "Vide switch(source) { ... }",
    body: [
      "switch(${1:source}) {",
      "\t[${2:case}] = function()",
      "\t\treturn $0",
      "\tend,",
      "}",
    ],
  },
  {
    prefix: "indexes",
    kind: "state",
    framework: "vide",
    description: "Vide indexes(source, function(value, index) ... end)",
    body: [
      "indexes(${1:source}, function(${2:value}, ${3:index})",
      "\treturn $0",
      "end)",
    ],
  },
  {
    prefix: "values",
    kind: "state",
    framework: "vide",
    description: "Vide values(source, function(value, index) ... end)",
    body: [
      "values(${1:source}, function(${2:value}, ${3:index})",
      "\treturn $0",
      "end)",
    ],
  },

  // ---- Framework-agnostic expressions ----
  {
    prefix: "cfangles",
    kind: "expr",
    description:
      "Rotation-only CFrame, Euler angles in degrees (wrapped in math.rad)",
    body: [
      "CFrame.Angles(math.rad(${1:0}), math.rad(${2:0}), math.rad(${3:0}))$0",
    ],
  },
  {
    prefix: "cfanglesrad",
    kind: "expr",
    description: "Rotation-only CFrame, Euler angles in radians",
    body: ["CFrame.Angles(${1:0}, ${2:0}, ${3:0})$0"],
  },
];

export class ElementSnippetCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private readonly workspaceIndex: WorkspaceIndex) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    // (0) Master toggle — `luix.snippets.enabled` (default true) turns
    // off every Luix dynamic snippet (element / hook / scaffold / event
    // / state / expr) for users who want a quieter completion list. The
    // workspace-component completions (a separate provider) are
    // unaffected.
    if (!getConfig<boolean>("snippets.enabled", true)) {return undefined;}

    const text = document.getText();
    const offset = document.offsetAt(position);

    // (1) Gate: not inside a string literal. Applies to every snippet
    // kind — `useEffect`, `cfangles`, `eFrame`, etc. — because none of
    // them are valid inside a Lua string. The code mask flags string
    // interiors as false; the partial's last char is at offset-1.
    if (offset > 0) {
      const mask = buildCodeMask(text);
      if (mask[offset - 1] === false) {return undefined;}
    }

    // (1b) Computed-key context split. Inside an unclosed `[…]` we
    // *only* fire the `computed` kind (which scaffolds the inner
    // expression, e.g. `React.Event.Activated`); every other kind
    // would either nest its own `[…]` (`reactEvent`) or land inside a
    // key expression rather than at a fresh slot (`eFrame`, hooks).
    // Outside `[…]`, we fire everything except `computed`.
    const inComputed = isInsideComputedKey(document, position);

    // Walk back to find the partial identifier under the cursor.
    let identStart = offset;
    while (identStart > 0 && /[A-Za-z0-9_]/.test(text[identStart - 1])) {
      identStart--;
    }
    if (identStart === offset) {return undefined;}
    const partial = text.slice(identStart, offset);

    // Skip member-access tails — `obj.eFrame` / `self:useState` should
    // not surface the snippets.
    if (identStart > 0) {
      const ch = text[identStart - 1];
      if (ch === "." || ch === ":") {return undefined;}
    }

    // Enclosing-call + prop-key-position lookups — used only by
    // `element` snippets. Computed once and shared.
    const aliases = getAliasPartition();
    const enclosing = findEnclosingPropsCall(
      text,
      offset,
      aliases,
      this.workspaceIndex.knownDirectCallTargets()
    );
    const atKey = enclosing
      ? isAtPropKeyPosition(document, position)
      : false;
    const enclosingFw =
      enclosing && enclosing.alias
        ? findFrameworkForAlias(enclosing.alias)
        : undefined;

    // Active framework for this document — detected per-file in 1.5+
    // (previously every enabled framework's snippets surfaced
    // simultaneously, polluting the dropdown). Hooks / scaffold /
    // `reactEvent` / computed-key starters are React-or-Roact
    // patterns; element snippets are framework-specific.
    const active = detectFrameworkForDocument(document).effective;
    if (!active) {return undefined;}
    const isReactish = active === "react" || active === "roact";

    const wordRange = new vscode.Range(
      document.positionAt(identStart),
      position
    );
    const lowerPartial = partial.toLowerCase();
    const out: vscode.CompletionItem[] = [];
    let idx = 0;

    // ---- Inside `[…]` — dynamic React.Event / React.Change starters ----
    //
    // Build the choice list from the *actual element*'s events and
    // properties (resolved through `resolveEffectiveClass`, which also
    // handles user-defined components via `---@extends ClassName` /
    // detected-base inference). Falls back to GuiObject for unknown
    // classes so the snippet still does something useful.
    if (inComputed && enclosing) {
      const baseClass = await resolveEffectiveClass(
        enclosing.className,
        document,
        this.workspaceIndex
      );
      const resolved = baseClass ?? "GuiObject";
      const events = flattenClassEvents(resolved);
      const props = flattenClassProps(resolved);
      const eventChoices = events.length > 0 ? events : ["Activated"];
      // VS Code's `${…|choice|}` snippet syntax doesn't tolerate `,`,
      // `}` or `|` inside option names; class events / props never
      // contain those, but escape defensively in case future data
      // includes weird entries.
      const eventList = eventChoices.map(escapeChoice).join(",");
      const propList = (props.length > 0 ? props : ["Property"])
        .map(escapeChoice)
        .join(",");
      // Per-framework computed-key starter forms:
      //   • React  — `[React.Event.X]`, `[React.Change.X]`
      //   • Roact  — `[Roact.Event.X]`, `[Roact.Change.X]`
      //   • Fusion — `[OnEvent "X"]`, `[OnChange "X"]`, `[Out "X"]`
      //   • Vide   — no computed-key event syntax (events are plain
      //              prop keys via `eventsAsProps`); skip.
      if (active === "react") {
        pushComputed("React.Event", `React.Event.\${1|${eventList}|}$0`, `React.Event handler key — ${resolved} (${eventChoices.length} events)`);
        pushComputed("React.Change", `React.Change.\${1|${propList}|}$0`, `React.Change listener key — ${resolved} (${props.length} props)`);
      } else if (active === "roact") {
        pushComputed("Roact.Event", `Roact.Event.\${1|${eventList}|}$0`, `Roact.Event handler key — ${resolved} (${eventChoices.length} events)`);
        pushComputed("Roact.Change", `Roact.Change.\${1|${propList}|}$0`, `Roact.Change listener key — ${resolved} (${props.length} props)`);
      } else if (active === "fusion") {
        pushComputed("OnEvent", `OnEvent "\${1|${eventList}|}"$0`, `Fusion OnEvent handler key — ${resolved} (${eventChoices.length} events)`);
        pushComputed("OnChange", `OnChange "\${1|${propList}|}"$0`, `Fusion OnChange listener key — ${resolved} (${props.length} props)`);
        pushComputed("Out", `Out "\${1|${propList}|}"$0`, `Fusion Out binding key — ${resolved} (${props.length} props)`);
      }

      function pushComputed(label: string, body: string, detail: string) {
        if (!label.toLowerCase().startsWith(lowerPartial)) {return;}
        out.push(makeComputedItem(label, detail, body, wordRange, idx++));
      }
    }

    // STRUCTURAL POSITION — derived once for the per-kind gates below.
    //
    //   inPropsTableKey  = cursor is at a fresh key slot inside an open
    //                      element call's props table. Snippets whose
    //                      bodies are `[Key] = value` table entries
    //                      (event shorthands) belong here, AND ONLY here.
    //                      Snippets whose bodies are top-level Lua
    //                      statements (`local x = …`, `function foo()`)
    //                      would corrupt the table on accept and must
    //                      stay out.
    //
    //   inStatementSlot  = the inverse — we're at function-body or
    //                      module-level statement position, where
    //                      `local` and `function` are valid.
    //
    // Without this gate the snippet menu happily surfaces `useState` /
    // `value` / `source` / `rfc` / `nfc` inside `New "Frame" { val| }`
    // and they accept as `local name = Value(nil)` — invalid Lua.
    // Likewise the event shorthands `reactEvent` / `onEvent` etc. would
    // surface at statement scope and accept as a bare `[Key] = …`,
    // which is also a syntax error. Found in the 1.5.0 review.
    const inPropsTableKey = !!(enclosing && atKey);
    const inStatementSlot = !inPropsTableKey;

    for (const snip of SNIPPETS) {
      // Per-kind framework gating + prop-key + computed-key
      // suppression. Computed-context split is enforced first so the
      // existing switch only sees the relevant kinds.
      if (inComputed && snip.kind !== "computed") {continue;}
      if (!inComputed && snip.kind === "computed") {continue;}

      let allowed: boolean;
      switch (snip.kind) {
        case "element": {
          // Framework must match the *active* one for this file —
          // an `eFrame` snippet in a Vide file would brick the file
          // when accepted, so the dropdown stays one-framework-clean.
          if (!snip.framework || snip.framework !== active) {
            allowed = false;
            break;
          }
          // Prop-key position: only OK when the parent supports inline
          // children (Vide). Otherwise we'd offer a snippet that would
          // brick the table when accepted.
          if (
            enclosing &&
            atKey &&
            (!enclosingFw || enclosingFw.childrenLayout !== "inline")
          ) {
            allowed = false;
            break;
          }
          allowed = true;
          break;
        }
        case "hook":
          // React hooks (useState / useEffect / etc.). The bodies all
          // start with `local … = React.…`, which only makes sense at
          // a statement slot — never inside a props-table key.
          //
          // Gated to React-only (not Roact): Roact 1.x has no built-in
          // hooks, and the common Roact-Hooks libraries expose a
          // different API (`hooks.useState(...)` from the curried
          // `Hooks.new(Roact)` factory) — surfacing `React.useState`
          // for them would be wrong. A Roact user can still hand-roll
          // the call.
          //
          // Also independently disable-able via `luix.snippets.hooks`
          // for users who don't want the hook entries in their list.
          allowed =
            active === "react" &&
            inStatementSlot &&
            getConfig<boolean>("snippets.hooks", true);
          break;
        case "event":
          // Per-framework event-shorthand entries (reactEvent /
          // roactEvent / onEvent / videEvent). Each declares its
          // own `framework` so a Vide file won't surface `reactEvent`.
          // Body is a `[Key] = function() … end,` table entry, so
          // they only make sense AT a props-table key slot.
          allowed =
            !!snip.framework &&
            snip.framework === active &&
            inPropsTableKey;
          break;
        case "scaffold":
          // Per-framework function-component scaffold (`rfc` / `rofc`
          // / `nfc` / `vfc`). Each is gated to its own framework so
          // a Vide file won't surface React's `rfc` and vice versa.
          // Body is `local function Name(props) … end` — only valid
          // at a statement slot, never inside a table key.
          allowed =
            !!snip.framework &&
            snip.framework === active &&
            inStatementSlot;
          break;
        case "expr":
          // Framework-agnostic value expressions (`cfangles*`).
          // Already protected from string context by the gate above;
          // no further restriction.
          allowed = true;
          break;
        case "state": {
          // Per-framework state primitives — Fusion `Value` /
          // `Computed` / etc., Vide `source` / `derive` / etc. Only
          // surface for the matching framework. Bodies are `local x
          // = Value(…)` / `effect(function() … end)` style, which
          // are statement-position constructs — never a props key.
          //
          // Independently disable-able via `luix.snippets.state` — the
          // cross-framework parallel to `luix.snippets.hooks` (React's
          // hooks are this category's equivalent).
          allowed =
            !!snip.framework &&
            snip.framework === active &&
            inStatementSlot &&
            getConfig<boolean>("snippets.state", true);
          break;
        }
        case "computed":
          // Static `kind: "computed"` entries are currently absent
          // (the computed-key starters are generated dynamically per
          // framework above). Keep the branch wired so future
          // additions don't fall through.
          allowed = !!snip.framework && snip.framework === active;
          break;
      }
      if (!allowed) {continue;}
      if (!snip.prefix.toLowerCase().startsWith(lowerPartial)) {continue;}
      const item = new vscode.CompletionItem(
        snip.prefix,
        vscode.CompletionItemKind.Snippet
      );
      item.detail = snip.description;
      item.filterText = snip.prefix;
      // Sort under luau-lsp's word matches but above the long
      // alphabetical tail. Preserves the static-snippet ranking so
      // muscle memory still works.
      item.sortText = `08_${String(idx).padStart(4, "0")}`;
      item.range = wordRange;
      const body = snip.body.join("\n");
      item.insertText = new vscode.SnippetString(snip.framework === "fusion"
        ? fusionSnippetBody(snip.prefix, body, text, offset)
        : body);
      out.push(item);
      idx++;
    }
    return out;
  }
}

/**
 * Build a Luix completion item for a dynamic computed-key snippet
 * (`React.Event.<choice>` / `React.Change.<choice>`). The body is
 * generated from the resolved class's events / props so the choice
 * list reflects what's actually available on the element.
 */
function makeComputedItem(
  label: string,
  detail: string,
  body: string,
  range: vscode.Range,
  idx: number
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    label,
    vscode.CompletionItemKind.Snippet
  );
  item.detail = detail;
  item.filterText = label;
  item.sortText = `07_${String(idx).padStart(4, "0")}`;
  item.range = range;
  item.insertText = new vscode.SnippetString(body);
  return item;
}

/** Escape a choice-list entry so the `${1|...|}` snippet syntax
 *  doesn't get confused by `,`, `|`, or `}` inside an event / prop
 *  name. Class data shouldn't contain those, but a `.replace` here
 *  is cheap insurance against future additions. */
function escapeChoice(name: string): string {
  return name.replace(/[,|}\\]/g, (c) => "\\" + c);
}

// Exposed for tests so the suite can assert framework-specific bag
// coverage without round-tripping through the VS Code completion API.
export const _internal = {
  SNIPPETS: SNIPPETS as readonly LuixSnippet[],
};
export type { LuixSnippet, SnippetKind };
