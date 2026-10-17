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

// Gate snippets by the active framework and whether their bodies fit the cursor's syntax position.

type SnippetKind =
  | "element"
  | "hook"
  | "scaffold"
  | "event"
  | "expr"
  | "computed"
  | "state";

interface LuixSnippet {
  prefix: string;
  kind: SnippetKind;
  /** Framework restriction, when applicable. */
  framework?: FrameworkId;
  body: string[];
  description: string;
}

const SNIPPETS: LuixSnippet[] = [
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
    if (!getConfig<boolean>("snippets.enabled", true)) {return undefined;}

    const text = document.getText();
    const offset = document.offsetAt(position);

    if (offset > 0) {
      const mask = buildCodeMask(text);
      if (mask[offset - 1] === false) {return undefined;}
    }

    // Inside computed keys, offer only key expressions, not statements or nested table entries.
    const inComputed = isInsideComputedKey(document, position);

    let identStart = offset;
    while (identStart > 0 && /[A-Za-z0-9_]/.test(text[identStart - 1])) {
      identStart--;
    }
    if (identStart === offset) {return undefined;}
    const partial = text.slice(identStart, offset);

    if (identStart > 0) {
      const ch = text[identStart - 1];
      if (ch === "." || ch === ":") {return undefined;}
    }

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

    // Use the resolved class for event and property choices; fall back to GuiObject.
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
      const eventList = eventChoices.map(escapeChoice).join(",");
      const propList = (props.length > 0 ? props : ["Property"])
        .map(escapeChoice)
        .join(",");
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

    // Table entries and Lua statements require separate snippet positions.
    const inPropsTableKey = !!(enclosing && atKey);
    const inStatementSlot = !inPropsTableKey;

    for (const snip of SNIPPETS) {
      if (inComputed && snip.kind !== "computed") {continue;}
      if (!inComputed && snip.kind === "computed") {continue;}

      let allowed: boolean;
      switch (snip.kind) {
        case "element": {
          if (!snip.framework || snip.framework !== active) {
            allowed = false;
            break;
          }
          // Only inline-child frameworks allow element snippets at a prop-key position.
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
          // Roact 1.x has no built-in hooks API.
          allowed =
            active === "react" &&
            inStatementSlot &&
            getConfig<boolean>("snippets.hooks", true);
          break;
        case "event":
          allowed =
            !!snip.framework &&
            snip.framework === active &&
            inPropsTableKey;
          break;
        case "scaffold":
          allowed =
            !!snip.framework &&
            snip.framework === active &&
            inStatementSlot;
          break;
        case "expr":
          allowed = true;
          break;
        case "state": {
          allowed =
            !!snip.framework &&
            snip.framework === active &&
            inStatementSlot &&
            getConfig<boolean>("snippets.state", true);
          break;
        }
        case "computed":
          // Computed snippets are generated above; retain the gate for any static entries.
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
      // Rank below language-server word matches.
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

/** Escape separators and closing braces in VS Code snippet choices. */
function escapeChoice(name: string): string {
  return name.replace(/[,|}\\]/g, (c) => "\\" + c);
}

export const _internal = {
  SNIPPETS: SNIPPETS as readonly LuixSnippet[],
};
export type { LuixSnippet, SnippetKind };
