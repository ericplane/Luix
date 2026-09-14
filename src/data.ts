// Constants, lookup tables, and pure data helpers.
//
// Nothing in this file imports from `vscode`; it's safe to consume from
// tests without spinning up the extension host.

// ============================================================================
// Roblox class hierarchy
// ============================================================================

export interface ClassDef {
  inherits?: string;
  own: string[];
  events?: string[];
}

// Hierarchy roughly mirrors Roblox's actual one (see
// https://create.roblox.com/docs/reference/engine/classes/GuiObject), with a
// few pragmatic shortcuts:
//   - TextButton / TextBox extend TextLabel for sharing text props (Roblox
//     keeps them as siblings, but the prop sets overlap entirely).
//   - ImageButton extends ImageLabel for the same reason.
//   - The various UILayout subclasses share `FillDirection`,
//     `HorizontalAlignment`, etc. via a `UILayout` base.
export const classHierarchy: Record<string, ClassDef> = {
  // ---- roots ----
  Instance: {
    own: ["Archivable", "Name"],
    // Signals every Instance exposes. Vide connects any signal-valued
    // key (`Destroying = function() … end`), so these must be known
    // for the unknown-prop diagnostic and the events-as-props
    // completion; React/Roact/Fusion reach them via `[React.Event.X]`
    // / `[OnEvent "X"]`. `Changed` is really declared on `Object`, the
    // engine's root above `Instance`; it lives here because every
    // Instance inherits it and nothing else in this hierarchy needs
    // that extra level.
    events: [
      "AncestryChanged",
      "AttributeChanged",
      "Changed",
      "ChildAdded",
      "ChildRemoved",
      "DescendantAdded",
      "DescendantRemoving",
      "Destroying",
      "StyledPropertiesChanged",
    ],
  },

  GuiBase2d: {
    inherits: "Instance",
    own: [
      "AutoLocalize",
      "RootLocalizationTable",
      "SelectionBehaviorDown",
      "SelectionBehaviorLeft",
      "SelectionBehaviorRight",
      "SelectionBehaviorUp",
      "SelectionGroup",
    ],
    events: ["SelectionChanged"],
  },

  // ---- 2D UI base ----
  GuiObject: {
    inherits: "GuiBase2d",
    own: [
      "Active",
      "AnchorPoint",
      "AutomaticSize",
      "BackgroundColor3",
      "BackgroundTransparency",
      "BorderColor3",
      "BorderMode",
      "BorderSizePixel",
      "ClipsDescendants",
      "InputSink",
      "Interactable",
      "LayoutOrder",
      "NextSelectionDown",
      "NextSelectionLeft",
      "NextSelectionRight",
      "NextSelectionUp",
      "Position",
      "Rotation",
      "Selectable",
      "SelectionImageObject",
      "SelectionOrder",
      "Size",
      "SizeConstraint",
      "Visible",
      "ZIndex",
    ],
    events: [
      "InputBegan",
      "InputChanged",
      "InputEnded",
      "MouseEnter",
      "MouseLeave",
      "MouseMoved",
      "MouseWheelBackward",
      "MouseWheelForward",
      "SelectionGained",
      "SelectionLost",
      "TouchLongPress",
      "TouchPan",
      "TouchPinch",
      "TouchRotate",
      "TouchSwipe",
      "TouchTap",
    ],
  },

  // Synthetic level: shared by TextButton and ImageButton.
  GuiButton: {
    inherits: "GuiObject",
    own: [
      "AutoButtonColor",
      "HoverHapticEffect",
      "Modal",
      "PressHapticEffect",
      "Selected",
      "Style",
    ],
    events: [
      "Activated",
      "SecondaryActivated",
      "MouseButton1Click",
      "MouseButton1Down",
      "MouseButton1Up",
      "MouseButton2Click",
      "MouseButton2Down",
      "MouseButton2Up",
    ],
  },

  // ---- Frame family ----
  Frame: { inherits: "GuiObject", own: ["Style"] },

  ScrollingFrame: {
    inherits: "GuiObject",
    own: [
      "AutomaticCanvasSize",
      "BottomImage",
      "CanvasPosition",
      "CanvasSize",
      "ElasticBehavior",
      "HorizontalScrollBarInset",
      "MidImage",
      "ScrollBarImageColor3",
      "ScrollBarImageTransparency",
      "ScrollBarThickness",
      "ScrollingDirection",
      "ScrollingEnabled",
      "TopImage",
      "VerticalScrollBarInset",
      "VerticalScrollBarPosition",
    ],
  },

  ViewportFrame: {
    inherits: "GuiObject",
    own: [
      "Ambient",
      "CurrentCamera",
      "ImageColor3",
      "ImageTransparency",
      "LightColor",
      "LightDirection",
    ],
  },

  VideoFrame: {
    inherits: "GuiObject",
    own: [
      "Looped",
      "MaximumResolution",
      "Playing",
      "RollOffMaxDistance",
      "RollOffMinDistance",
      "RollOffMode",
      "TimePosition",
      "Video",
      "Volume",
    ],
    events: ["DidLoop", "Ended", "Loaded", "Paused", "Played"],
  },

  CanvasGroup: {
    inherits: "GuiObject",
    own: ["GroupColor3", "GroupTransparency"],
  },

  // ---- Text family ----
  // TextLabel acts as the shared base for everything that renders text;
  // TextButton and TextBox add their own extras on top.
  TextLabel: {
    inherits: "GuiObject",
    own: [
      // `Font` is intentionally omitted — it's deprecated in favor of
      // `FontFace`. The deprecation diagnostic still catches anyone
      // who writes `Font = Enum.Font.X` and offers the quick-fix.
      "FontFace",
      "LineHeight",
      "MaxVisibleGraphemes",
      "OpenTypeFeatures",
      "RichText",
      "Text",
      "TextColor3",
      "TextDirection",
      "TextScaled",
      "TextSize",
      "TextStrokeColor3",
      "TextStrokeTransparency",
      "TextTransparency",
      "TextTruncate",
      "TextWrapped",
      "TextXAlignment",
      "TextYAlignment",
    ],
  },

  // TextButton acts like a button + a label. We model it as inheriting
  // GuiButton (for the button extras and click events) and bolt the
  // text-rendering props on directly.
  TextButton: {
    inherits: "GuiButton",
    own: [
      // Mirrored from TextLabel for the prop list. `Font` is
      // intentionally omitted — deprecated in favor of `FontFace`.
      "FontFace",
      "LineHeight",
      "MaxVisibleGraphemes",
      "OpenTypeFeatures",
      "RichText",
      "Text",
      "TextColor3",
      "TextDirection",
      "TextScaled",
      "TextSize",
      "TextStrokeColor3",
      "TextStrokeTransparency",
      "TextTransparency",
      "TextTruncate",
      "TextWrapped",
      "TextXAlignment",
      "TextYAlignment",
    ],
  },

  TextBox: {
    inherits: "GuiObject",
    own: [
      "ClearTextOnFocus",
      "CursorPosition",
      "FontFace",
      "LineHeight",
      "MaxVisibleGraphemes",
      "MultiLine",
      "OpenTypeFeatures",
      "PlaceholderColor3",
      "PlaceholderText",
      "RichText",
      "SelectionStart",
      "ShowNativeInput",
      "Text",
      "TextColor3",
      "TextDirection",
      "TextEditable",
      "TextScaled",
      "TextSize",
      "TextStrokeColor3",
      "TextStrokeTransparency",
      "TextTransparency",
      "TextTruncate",
      "TextWrapped",
      "TextXAlignment",
      "TextYAlignment",
    ],
    events: ["Focused", "FocusLost", "ReturnPressedFromOnScreenKeyboard"],
  },

  // ---- Image family ----
  ImageLabel: {
    inherits: "GuiObject",
    own: [
      "Image",
      "ImageColor3",
      "ImageRectOffset",
      "ImageRectSize",
      "ImageTransparency",
      "ResampleMode",
      "ScaleType",
      "SliceCenter",
      "SliceScale",
      "TileSize",
    ],
  },

  // ImageButton: GuiButton + ImageLabel props bolted on.
  ImageButton: {
    inherits: "GuiButton",
    own: [
      "HoverImage",
      "PressedImage",
      // Mirrored from ImageLabel:
      "Image",
      "ImageColor3",
      "ImageRectOffset",
      "ImageRectSize",
      "ImageTransparency",
      "ResampleMode",
      "ScaleType",
      "SliceCenter",
      "SliceScale",
      "TileSize",
    ],
  },

  // ---- LayerCollectors (root containers — not GuiObjects) ----
  ScreenGui: {
    inherits: "Instance",
    own: [
      "AutoLocalize",
      "ClipToDeviceSafeArea",
      "DisplayOrder",
      "Enabled",
      "IgnoreGuiInset",
      "ResetOnSpawn",
      "SafeAreaCompatibility",
      "ScreenInsets",
      "TabKeyboardNavigation",
      "ZIndexBehavior",
    ],
  },

  BillboardGui: {
    inherits: "Instance",
    own: [
      "Active",
      "Adornee",
      "AlwaysOnTop",
      "Brightness",
      "ClipsDescendants",
      "DistanceStep",
      "Enabled",
      "ExtentsOffset",
      "ExtentsOffsetWorldSpace",
      "LightInfluence",
      "MaxDistance",
      "PlayerToHideFrom",
      "ResetOnSpawn",
      "Size",
      "SizeOffset",
      "StudsOffset",
      "StudsOffsetWorldSpace",
      "TabKeyboardNavigation",
      "ZIndexBehavior",
    ],
  },

  SurfaceGui: {
    inherits: "Instance",
    own: [
      "Active",
      "Adornee",
      "AlwaysOnTop",
      "Brightness",
      "CanvasSize",
      "ClipsDescendants",
      "Enabled",
      "Face",
      "LightInfluence",
      "PixelsPerStud",
      "ResetOnSpawn",
      "SizingMode",
      "TabKeyboardNavigation",
      "ToolPunchThroughDistance",
      "ZIndexBehavior",
    ],
  },

  // ---- UI utilities ----
  UICorner: {
    inherits: "Instance",
    own: [
      "CornerRadius",
      "BottomLeftRadius",
      "BottomRightRadius",
      "TopLeftRadius",
      "TopRightRadius",
    ],
  },

  UIGradient: {
    inherits: "Instance",
    own: ["Color", "Enabled", "Offset", "Rotation", "Transparency"],
  },

  // Renders a shadow below the parent UI instance. Currently
  // "Not Browsable" but live — props per the API. `Offset` / `Spread`
  // are `UDim2` and `BlurRadius` is `UDim` here (see PROP_TYPE_OVERRIDES;
  // they collide with the global `Offset: Vector2`).
  UIShadow: {
    inherits: "Instance",
    own: [
      "BlurRadius",
      "Color",
      "Enabled",
      "Offset",
      "Spread",
      "Transparency",
      "ZIndex",
    ],
  },

  UIStroke: {
    inherits: "Instance",
    own: [
      "ApplyStrokeMode",
      "BorderOffset",
      "BorderStrokePosition",
      "Color",
      "Enabled",
      "LineJoinMode",
      "StrokeSizingMode",
      "Thickness",
      "Transparency",
      "ZIndex",
    ],
  },

  UIPadding: {
    inherits: "Instance",
    own: ["PaddingBottom", "PaddingLeft", "PaddingRight", "PaddingTop"],
  },

  UIScale: { inherits: "Instance", own: ["Scale"] },

  UIFlexItem: {
    inherits: "Instance",
    own: ["FlexMode", "GrowRatio", "ItemLineAlignment", "ShrinkRatio"],
  },

  // ---- Layout family ----
  UILayout: {
    inherits: "Instance",
    own: [
      "FillDirection",
      "HorizontalAlignment",
      "Padding",
      "SortOrder",
      "VerticalAlignment",
    ],
  },

  UIListLayout: {
    inherits: "UILayout",
    own: ["HorizontalFlex", "ItemLineAlignment", "VerticalFlex", "Wraps"],
  },

  UIGridLayout: {
    inherits: "UILayout",
    own: ["CellPadding", "CellSize", "FillDirectionMaxCells", "StartCorner"],
  },

  UIPageLayout: {
    inherits: "UILayout",
    own: [
      "Animated",
      "Circular",
      "EasingDirection",
      "EasingStyle",
      "GamepadInputEnabled",
      "PageSize",
      "ScrollWheelInputEnabled",
      "TouchInputEnabled",
    ],
    events: ["PageEnter", "PageLeave", "Stopped"],
  },

  UITableLayout: {
    inherits: "UILayout",
    own: [
      "ColumnSpacing",
      "FillEmptySpaceColumns",
      "FillEmptySpaceRows",
      "MajorAxis",
      "RowSpacing",
    ],
  },

  // ---- Constraints ----
  UIAspectRatioConstraint: {
    inherits: "Instance",
    own: ["AspectRatio", "AspectType", "DominantAxis"],
  },

  UISizeConstraint: { inherits: "Instance", own: ["MaxSize", "MinSize"] },

  UITextSizeConstraint: {
    inherits: "Instance",
    own: ["MaxTextSize", "MinTextSize"],
  },
};

// Memoized; the hierarchy is static, so the result for a given class never
// changes. Callers must treat the returned array as immutable.
const propsCache = new Map<string, string[]>();

export function flattenClassProps(
  className: string,
  seen: Set<string> = new Set(),
): string[] {
  if (seen.has(className)) {
    return [];
  }
  // Only memoize the top-level call (when no parent passed `seen` in).
  const topLevel = seen.size === 0;
  if (topLevel) {
    const hit = propsCache.get(className);
    if (hit !== undefined) {
      return hit;
    }
  }
  seen.add(className);

  const def = classHierarchy[className];
  if (!def) {
    if (topLevel) {
      propsCache.set(className, []);
    }
    return [];
  }
  const inherited = def.inherits ? flattenClassProps(def.inherits, seen) : [];
  // Use a Set for O(1) dedup. The prior `out.includes(p)` was O(N²) on
  // classes with many props (GuiObject + TextLabel + TextButton inherit
  // chain regularly exceeds 50 props).
  const out: string[] = [];
  const known = new Set<string>();
  for (const p of inherited) {
    if (!known.has(p)) {
      known.add(p);
      out.push(p);
    }
  }
  for (const p of def.own) {
    if (!known.has(p)) {
      known.add(p);
      out.push(p);
    }
  }
  if (topLevel) {
    propsCache.set(className, out);
  }
  return out;
}

// ----------------------------------------------------------------------
// Deprecated-but-valid properties
// ----------------------------------------------------------------------
//
// Some legacy properties are intentionally kept OUT of the prop lists
// above so completion nudges users toward the modern replacement
// (`Font` → `FontFace`, …). But those props are still *real* — the code
// compiles and runs. Omitting them from `flattenClassProps` made the
// unknown-prop validator report `Font = …` as "Unknown property", a
// false positive on perfectly valid code (issue #2). This set lets the
// validator treat them as known (so no error) while keeping them out of
// the suggestion list. The deprecation diagnostic handles the migration
// nudge separately.
const DEPRECATED_VALID_PROPS: Record<string, string[]> = {
  TextLabel: ["Font"],
  TextButton: ["Font"],
  TextBox: ["Font"],
};

/**
 * True when `prop` is a deprecated-but-still-valid property of
 * `className` (walking the inheritance chain). Consumed by the
 * prop-validation diagnostic so legacy props like `Font` aren't flagged
 * "unknown". Kept separate from `flattenClassProps` on purpose:
 * deprecated props are *valid* but should not be *suggested*.
 */
export function isDeprecatedValidProp(
  className: string,
  prop: string,
): boolean {
  let current: string | undefined = className;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (DEPRECATED_VALID_PROPS[current]?.includes(prop)) {
      return true;
    }
    current = classHierarchy[current]?.inherits;
  }
  return false;
}

// `UICorner`'s per-corner radius properties (Roblox 2024+). When
// `CornerRadius` is also set it overrides all four, so they conflict —
// the diagnostic flags that, and the code actions collapse four equal
// corners into one `CornerRadius` / expand one into four.
export const UICORNER_INDIVIDUAL_RADII = [
  "BottomLeftRadius",
  "BottomRightRadius",
  "TopLeftRadius",
  "TopRightRadius",
];

/**
 * Given the prop keys present on a `UICorner`, return the individual
 * corner-radius props that are overridden by a co-present
 * `CornerRadius` (which sets all four). Empty when there's no conflict.
 * Pure — unit-tested and shared by the diagnostic + code action.
 */
export function cornerRadiusConflicts(keys: Iterable<string>): string[] {
  const set = new Set(keys);
  if (!set.has("CornerRadius")) {
    return [];
  }
  return UICORNER_INDIVIDUAL_RADII.filter((k) => set.has(k));
}

const eventsCache = new Map<string, string[]>();

/**
 * Every event a class can fire, most-specific first: the class's own
 * events, then its parent's, up to `Instance`. Unlike
 * `flattenClassProps` (base-first) this is ordered so the events users
 * actually reach for on a button (`Activated`, `MouseButton1Click`)
 * lead the `[React.Event.|` / `[OnEvent "|` / Vide suggestion lists and
 * the generic `Instance` signals (`AncestryChanged`, `Destroying`, …)
 * bring up the rear.
 */
export function flattenClassEvents(
  className: string,
  seen: Set<string> = new Set(),
): string[] {
  if (seen.has(className)) {
    return [];
  }
  const topLevel = seen.size === 0;
  if (topLevel) {
    const hit = eventsCache.get(className);
    if (hit !== undefined) {
      return hit;
    }
  }
  seen.add(className);

  const def = classHierarchy[className];
  if (!def) {
    if (topLevel) {
      eventsCache.set(className, []);
    }
    return [];
  }
  const inherited = def.inherits ? flattenClassEvents(def.inherits, seen) : [];
  const out: string[] = [];
  const known = new Set<string>();
  for (const e of def.events ?? []) {
    if (!known.has(e)) {
      known.add(e);
      out.push(e);
    }
  }
  for (const e of inherited) {
    if (!known.has(e)) {
      known.add(e);
      out.push(e);
    }
  }
  if (topLevel) {
    eventsCache.set(className, out);
  }
  return out;
}

/**
 * Returns the class in the hierarchy where `propName` is first declared
 * (its `own` array contains it). Useful for hover docs.
 */
export function findIntroducingClass(
  className: string,
  propName: string,
): string | undefined {
  return findIntroducing(className, propName, (def) => def.own);
}

/**
 * Event counterpart of `findIntroducingClass`: the class whose `events`
 * array first declares `eventName` (e.g. `Activated` on `TextButton` →
 * `GuiButton`).
 */
export function findIntroducingEventClass(
  className: string,
  eventName: string,
): string | undefined {
  return findIntroducing(className, eventName, (def) => def.events ?? []);
}

function findIntroducing(
  className: string,
  member: string,
  membersOf: (def: ClassDef) => string[],
): string | undefined {
  let current: string | undefined = className;
  while (current) {
    const def: ClassDef | undefined = classHierarchy[current];
    if (!def) {
      return undefined;
    }
    if (membersOf(def).includes(member)) {
      return current;
    }
    current = def.inherits;
  }
  return undefined;
}

// Built-in defaults derived from the hierarchy. Same flat shape downstream
// code already expects (Record<string, string[]>).
export const defaultPropsMap: Record<string, string[]> = Object.fromEntries(
  Object.keys(classHierarchy).map((name) => [name, flattenClassProps(name)]),
);

// Abstract / intermediate classes Roblox doesn't let you `Instance.new(...)`.
// Used to filter the hierarchy down to the names users can actually
// construct directly (Vide's `Frame({...})` idiom).
const ABSTRACT_CLASS_NAMES: ReadonlySet<string> = new Set([
  "Instance",
  "GuiBase2d",
  "GuiObject",
  "GuiButton",
  // Luix-internal grouping under which UIListLayout / UIGridLayout / …
  // share `FillDirection` etc. Not a real Roblox class.
  "UILayout",
]);

/**
 * Roblox UI class names that Vide users can call directly as functions —
 * `Frame({ Size = … })`, `TextButton({ Activated = … })`, etc. This is the
 * full hierarchy minus the small handful of abstract / synthetic bases
 * that aren't constructible. Naturally limited to GUI types because the
 * extension's `classHierarchy` only contains GUI types — no `Camera`,
 * `Sound`, `Tween`, etc., so the allowlist can't accidentally fire on a
 * local variable named after a non-UI Roblox class.
 */
export const DIRECT_INSTANTIABLE_CLASS_NAMES: ReadonlySet<string> = new Set(
  Object.keys(classHierarchy).filter((name) => !ABSTRACT_CLASS_NAMES.has(name)),
);

/**
 * Clear every derived cache and rebuild `defaultPropsMap` from the
 * current `classHierarchy`. Call this whenever the hierarchy itself
 * has been mutated (today: only the Roblox API-dump merge in
 * `apiDump.ts`). Without it, descendants of any class we extended
 * would keep returning their pre-merge flattened prop list, so e.g.
 * adding a prop to `Frame` wouldn't surface on `ScrollingFrame` or
 * `TextLabel` until the extension reloaded.
 */
export function rebuildDerivedClassData(): void {
  propsCache.clear();
  eventsCache.clear();
  getPropTypeCache.clear();
  for (const name of Object.keys(classHierarchy)) {
    defaultPropsMap[name] = flattenClassProps(name);
  }
}

// ============================================================================
// createElement aliases
// ============================================================================

export const DEFAULT_ALIASES = [
  "e",
  "createElement",
  "React.createElement",
  "Roact.createElement",
];

// ============================================================================
// Prop types + value snippet templates
// ============================================================================

// Map of prop name → Roblox type. Used to insert a value snippet when the
// user accepts a completion. Conservative — only props whose type is
// unambiguous across all classes that have them.
export const PROP_TYPES: Record<string, string> = {
  // Color3
  Ambient: "Color3",
  BackgroundColor3: "Color3",
  BorderColor3: "Color3",
  GroupColor3: "Color3",
  ImageColor3: "Color3",
  LightColor: "Color3",
  PlaceholderColor3: "Color3",
  ScrollBarImageColor3: "Color3",
  TextColor3: "Color3",
  TextStrokeColor3: "Color3",

  // UDim2
  CanvasSize: "UDim2",
  CellPadding: "UDim2",
  CellSize: "UDim2",
  PageSize: "UDim2",
  Position: "UDim2",
  Size: "UDim2",
  TileSize: "UDim2",

  // UDim
  BorderOffset: "UDim",
  ColumnSpacing: "UDim",
  CornerRadius: "UDim",
  Padding: "UDim",
  PaddingBottom: "UDim",
  PaddingLeft: "UDim",
  PaddingRight: "UDim",
  PaddingTop: "UDim",
  RowSpacing: "UDim",
  BottomLeftRadius: "UDim",
  BottomRightRadius: "UDim",
  TopLeftRadius: "UDim",
  TopRightRadius: "UDim",

  // Vector2
  AnchorPoint: "Vector2",
  CanvasPosition: "Vector2",
  ExtentsOffset: "Vector2",
  ExtentsOffsetWorldSpace: "Vector2",
  ImageRectOffset: "Vector2",
  ImageRectSize: "Vector2",
  MaxSize: "Vector2",
  MinSize: "Vector2",
  Offset: "Vector2",
  SizeOffset: "Vector2",

  // Vector3
  LightDirection: "Vector3",
  StudsOffset: "Vector3",
  StudsOffsetWorldSpace: "Vector3",

  // Rect
  SliceCenter: "Rect",

  // number
  AspectRatio: "number",
  BackgroundTransparency: "number",
  BorderSizePixel: "number",
  Brightness: "number",
  CursorPosition: "number",
  DisplayOrder: "number",
  DistanceLowerLimit: "number",
  DistanceStep: "number",
  DistanceUpperLimit: "number",
  FillDirectionMaxCells: "number",
  GroupTransparency: "number",
  GrowRatio: "number",
  ImageTransparency: "number",
  LayoutOrder: "number",
  LightInfluence: "number",
  LineHeight: "number",
  MaxDistance: "number",
  MaxTextSize: "number",
  MaxVisibleGraphemes: "number",
  MinTextSize: "number",
  PixelsPerStud: "number",
  RollOffMaxDistance: "number",
  RollOffMinDistance: "number",
  Rotation: "number",
  Scale: "number",
  ScrollBarImageTransparency: "number",
  ScrollBarThickness: "number",
  SelectionOrder: "number",
  SelectionStart: "number",
  ShrinkRatio: "number",
  SliceScale: "number",
  TextSize: "number",
  TextStrokeTransparency: "number",
  TextTransparency: "number",
  Thickness: "number",
  TimePosition: "number",
  ToolPunchThroughDistance: "number",
  Volume: "number",
  ZIndex: "number",

  // boolean
  Active: "boolean",
  AlwaysOnTop: "boolean",
  Animated: "boolean",
  Archivable: "boolean",
  AutoButtonColor: "boolean",
  AutoLocalize: "boolean",
  Circular: "boolean",
  ClearTextOnFocus: "boolean",
  ClipsDescendants: "boolean",
  ClipToDeviceSafeArea: "boolean",
  Enabled: "boolean",
  FillEmptySpaceColumns: "boolean",
  FillEmptySpaceRows: "boolean",
  GamepadInputEnabled: "boolean",
  IgnoreGuiInset: "boolean",
  Interactable: "boolean",
  Looped: "boolean",
  Modal: "boolean",
  MultiLine: "boolean",
  Playing: "boolean",
  ResetOnSpawn: "boolean",
  RichText: "boolean",
  ScrollingEnabled: "boolean",
  ScrollWheelInputEnabled: "boolean",
  Selectable: "boolean",
  Selected: "boolean",
  SelectionGroup: "boolean",
  ShowNativeInput: "boolean",
  TabKeyboardNavigation: "boolean",
  TextEditable: "boolean",
  TextScaled: "boolean",
  TextWrapped: "boolean",
  TouchInputEnabled: "boolean",
  Visible: "boolean",
  Wraps: "boolean",

  // string
  BottomImage: "string",
  HoverImage: "string",
  Image: "string",
  MidImage: "string",
  Name: "string",
  OpenTypeFeatures: "string",
  PlaceholderText: "string",
  PressedImage: "string",
  Text: "string",
  TopImage: "string",
  Video: "string",

  // Font (struct)
  FontFace: "Font",

  // Instance refs
  Adornee: "Instance",
  CurrentCamera: "Camera",
  NextSelectionDown: "GuiObject",
  NextSelectionLeft: "GuiObject",
  NextSelectionRight: "GuiObject",
  NextSelectionUp: "GuiObject",
  PlayerToHideFrom: "Player",
  RootLocalizationTable: "LocalizationTable",
  SelectionImageObject: "GuiObject",

  // Enum.* — generic-enum templates rendered as Enum.<X>.${1}
  ApplyStrokeMode: "Enum.ApplyStrokeMode",
  AspectType: "Enum.AspectType",
  AutomaticCanvasSize: "Enum.AutomaticSize",
  AutomaticSize: "Enum.AutomaticSize",
  BorderMode: "Enum.BorderMode",
  BorderStrokePosition: "Enum.BorderStrokePosition",
  DominantAxis: "Enum.DominantAxis",
  EasingDirection: "Enum.EasingDirection",
  EasingStyle: "Enum.EasingStyle",
  ElasticBehavior: "Enum.ElasticBehavior",
  Face: "Enum.NormalId",
  FillDirection: "Enum.FillDirection",
  FlexMode: "Enum.UIFlexMode",
  HorizontalAlignment: "Enum.HorizontalAlignment",
  HorizontalFlex: "Enum.UIFlexAlignment",
  HorizontalScrollBarInset: "Enum.ScrollBarInset",
  HoverHapticEffect: "Enum.HapticEffect",
  InputSink: "Enum.InputSink",
  ItemLineAlignment: "Enum.ItemLineAlignment",
  LineJoinMode: "Enum.LineJoinMode",
  MajorAxis: "Enum.TableMajorAxis",
  MaximumResolution: "Enum.VideoSampleSize",
  PressHapticEffect: "Enum.HapticEffect",
  ResampleMode: "Enum.ResamplerMode",
  RollOffMode: "Enum.RollOffMode",
  SafeAreaCompatibility: "Enum.SafeAreaCompatibility",
  ScaleType: "Enum.ScaleType",
  ScreenInsets: "Enum.ScreenInsets",
  ScrollingDirection: "Enum.ScrollingDirection",
  SelectionBehaviorDown: "Enum.SelectionBehavior",
  SelectionBehaviorLeft: "Enum.SelectionBehavior",
  SelectionBehaviorRight: "Enum.SelectionBehavior",
  SelectionBehaviorUp: "Enum.SelectionBehavior",
  SizeConstraint: "Enum.SizeConstraint",
  SizingMode: "Enum.SurfaceGuiSizingMode",
  SortOrder: "Enum.SortOrder",
  StartCorner: "Enum.StartCorner",
  StrokeSizingMode: "Enum.StrokeSizingMode",
  TextDirection: "Enum.TextDirection",
  TextTruncate: "Enum.TextTruncate",
  TextXAlignment: "Enum.TextXAlignment",
  TextYAlignment: "Enum.TextYAlignment",
  VerticalAlignment: "Enum.VerticalAlignment",
  VerticalFlex: "Enum.UIFlexAlignment",
  VerticalScrollBarInset: "Enum.ScrollBarInset",
  VerticalScrollBarPosition: "Enum.VerticalScrollBarPosition",
  ZIndexBehavior: "Enum.ZIndexBehavior",
};

// ============================================================================
// Per-class type overrides
//
// Some prop names are reused across classes with DIFFERENT types. The
// canonical case is `Style`:
//   - Frame.Style      → Enum.FrameStyle
//   - GuiButton.Style  → Enum.ButtonStyle  (inherited by TextButton, ImageButton)
//
// Looking up by prop name alone (`PROP_TYPES.Style`) can only return one
// answer, which would always be wrong for half of the call sites. The
// override map below is keyed by the class that *defines* the divergent
// type — `getPropType(className, propName)` walks the class hierarchy
// from the leaf upward, returning the first override that matches and
// falling back to the global `PROP_TYPES` map.
//
// To handle a future conflict, add another entry like:
//   GuiObject: { Foo: "Enum.SomeOtherFoo" },
// — the closest ancestor wins, so leaf-level overrides take precedence.
// ============================================================================
export const PROP_TYPE_OVERRIDES: Record<string, Record<string, string>> = {
  Frame: {
    Style: "Enum.FrameStyle",
  },
  GuiButton: {
    // Inherited by TextButton + ImageButton via the class hierarchy
    Style: "Enum.ButtonStyle",
  },
  UIStroke: {
    Color: "Color3",
    Transparency: "number",
  },
  UIGradient: {
    Color: "ColorSequence",
    Transparency: "NumberSequence",
  },
  UIShadow: {
    // `Offset` is globally `Vector2`; on UIShadow it's `UDim2`. The rest
    // are either absent globally (`BlurRadius`, `Spread`) or ambiguous
    // (`Color`, `Transparency`), so pin them here. `ZIndex` (number) and
    // `Enabled` (boolean) resolve correctly from the global map.
    BlurRadius: "UDim",
    Color: "Color3",
    Offset: "UDim2",
    Spread: "UDim2",
    Transparency: "number",
  },
};

/**
 * Resolve a prop's Roblox type, honouring per-class overrides defined
 * in `PROP_TYPE_OVERRIDES`. Walks the class hierarchy from the supplied
 * class up to its roots, returning the first override that matches the
 * prop name. Falls back to the global `PROP_TYPES` map when no override
 * applies (or when `className` is undefined, which is the case for
 * custom components where we only know the prop name).
 */
// Memoize per (className, propName) — the class hierarchy and
// PROP_TYPE_OVERRIDES are static at module load, so a hit answer is
// permanent. We use a sentinel for "no value" so `undefined` results
// still cache and avoid re-walking the inheritance chain.
const getPropTypeCache = new Map<string, string | typeof NO_TYPE>();
const NO_TYPE = Symbol("no-type");

export function getPropType(
  className: string | undefined,
  propName: string,
): string | undefined {
  const key = `${className ?? ""}|${propName}`;
  const hit = getPropTypeCache.get(key);
  if (hit !== undefined) {
    return hit === NO_TYPE ? undefined : hit;
  }
  let result: string | undefined;
  if (className) {
    let cls: string | undefined = className;
    while (cls) {
      const override = PROP_TYPE_OVERRIDES[cls]?.[propName];
      if (override !== undefined) {
        result = override;
        break;
      }
      cls = classHierarchy[cls]?.inherits;
    }
  }
  if (result === undefined) {
    result = PROP_TYPES[propName];
  }
  getPropTypeCache.set(key, result === undefined ? NO_TYPE : result);
  return result;
}

// Snippet templates per type. `${1:…}`, `${2:…}` become tab stops; the
// caller appends `$0` (and a `,` if value-with-comma mode) after the
// rendered template.
export const TYPE_SNIPPETS: Record<string, string> = {
  Color3: "Color3.fromRGB(${1:255}, ${2:255}, ${3:255})",
  UDim2: "UDim2.new(${1:0}, ${2:0}, ${3:0}, ${4:0})",
  UDim: "UDim.new(${1:0}, ${2:0})",
  Vector2: "Vector2.new(${1:0}, ${2:0})",
  Vector3: "Vector3.new(${1:0}, ${2:0}, ${3:0})",
  CFrame: "CFrame.new(${1:0}, ${2:0}, ${3:0})",
  number: "${1:0}",
  string: '"${1}"',
  boolean: "${1|true,false|}",
  Font: 'Font.fromName("${1:Montserrat}", Enum.FontWeight.${2:Regular})',
  Rect: "Rect.new(${1:0}, ${2:0}, ${3:0}, ${4:0})",
  ColorSequence: "ColorSequence.new(${1})",
  NumberSequence: "NumberSequence.new(${1})",
};

export function renderTypeSnippet(typeName: string): string | undefined {
  const direct = TYPE_SNIPPETS[typeName];
  if (direct) {
    return direct;
  }
  if (typeName.startsWith("Enum.")) {
    return `Enum.${typeName.slice("Enum.".length)}.\${1}`;
  }
  return undefined;
}

// ============================================================================
// Annotation completion: types offered after `---@prop NAME `
// ============================================================================

export const ANNOTATION_TYPE_HINTS = [
  // Roblox value types
  "Color3",
  "UDim",
  "UDim2",
  "Vector2",
  "Vector3",
  "CFrame",
  "Font",
  "ColorSequence",
  "NumberSequence",
  "NumberRange",
  "Rect",
  "Region3",
  "BrickColor",
  "Instance",
  "LocalizationTable",
  // Primitives
  "number",
  "string",
  "boolean",
  "nil",
  "any",
  "unknown",
  // Common React-Luau types
  "React.ReactNode",
  "React.Ref",
];

// ============================================================================
// Font.fromName replacement table (for the Font → FontFace quick-fix)
// ============================================================================

// Conservative Enum.Font.* → (family, weight, italic?) translation for the
// Font → FontFace quick fix. Unknown values fall back to the original
// suffix as the family name; users can edit afterwards.
export const FONT_FACE_MAP: Record<
  string,
  { family: string; weight: string; italic?: boolean }
> = {
  SourceSans: { family: "Source Sans Pro", weight: "Regular" },
  SourceSansBold: { family: "Source Sans Pro", weight: "Bold" },
  SourceSansLight: { family: "Source Sans Pro", weight: "Light" },
  SourceSansSemibold: { family: "Source Sans Pro", weight: "SemiBold" },
  SourceSansItalic: {
    family: "Source Sans Pro",
    weight: "Regular",
    italic: true,
  },
  Gotham: { family: "Gotham", weight: "Regular" },
  GothamMedium: { family: "Gotham", weight: "Medium" },
  GothamBold: { family: "Gotham", weight: "Bold" },
  GothamBlack: { family: "Gotham", weight: "Heavy" },
  GothamSemibold: { family: "Gotham", weight: "SemiBold" },
  Arial: { family: "Arial", weight: "Regular" },
  ArialBold: { family: "Arial", weight: "Bold" },
  Cartoon: { family: "Bangers", weight: "Regular" },
  Code: { family: "Source Code Pro", weight: "Regular" },
  Highway: { family: "Highway Gothic", weight: "Regular" },
  SciFi: { family: "Zekton", weight: "Regular" },
  Bodoni: { family: "Bodoni", weight: "Regular" },
  Garamond: { family: "Garamond", weight: "Regular" },
  Fantasy: { family: "Fantasy", weight: "Regular" },
  Antique: { family: "Antique", weight: "Regular" },
  Legacy: { family: "Legacy", weight: "Regular" },
  Michroma: { family: "Michroma", weight: "Regular" },
  Roboto: { family: "Roboto", weight: "Regular" },
  RobotoCondensed: { family: "Roboto Condensed", weight: "Regular" },
  RobotoMono: { family: "Roboto Mono", weight: "Regular" },
  Merriweather: { family: "Merriweather", weight: "Regular" },
  Nunito: { family: "Nunito", weight: "Regular" },
  Oswald: { family: "Oswald", weight: "Regular" },
  PatrickHand: { family: "Patrick Hand", weight: "Regular" },
  PermanentMarker: { family: "Permanent Marker", weight: "Regular" },
  Ubuntu: { family: "Ubuntu", weight: "Regular" },
};

export function buildFontFaceReplacement(enumName: string): string {
  const mapped = FONT_FACE_MAP[enumName];
  if (!mapped) {
    return `Font.fromName("${enumName}", Enum.FontWeight.Regular)`;
  }
  if (mapped.italic) {
    return `Font.new(Font.fromName("${mapped.family}", Enum.FontWeight.${mapped.weight}).Family, Enum.FontWeight.${mapped.weight}, Enum.FontStyle.Italic)`;
  }
  return `Font.fromName("${mapped.family}", Enum.FontWeight.${mapped.weight})`;
}
