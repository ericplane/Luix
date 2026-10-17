// Pure data helpers; keep independent of vscode for use outside the extension host.

export interface ClassDef {
  inherits?: string;
  own: string[];
  events?: string[];
}

// The hierarchy groups shared UI properties and includes synthetic base classes.
export const classHierarchy: Record<string, ClassDef> = {
  Instance: {
    own: ["Archivable", "Name"],
    // Changed belongs to Object in Roblox; all Instances inherit it, so include it here.
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

  // Synthetic base shared by TextButton and ImageButton.
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

  TextLabel: {
    inherits: "GuiObject",
    own: [
      // Font remains valid but is omitted from suggestions in favor of FontFace.
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

  // TextButton inherits button behavior and copies text properties from TextLabel.
  TextButton: {
    inherits: "GuiButton",
    own: [
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

  // ImageButton inherits button behavior and copies ImageLabel properties.
  ImageButton: {
    inherits: "GuiButton",
    own: [
      "HoverImage",
      "PressedImage",
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

// Treat memoized property arrays as immutable.
const propsCache = new Map<string, string[]>();

export function flattenClassProps(
  className: string,
  seen: Set<string> = new Set(),
): string[] {
  if (seen.has(className)) {
    return [];
  }
  // Only memoize top-level calls; recursive calls share cycle detection.
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

// Deprecated properties remain valid but are excluded from completion suggestions.
const DEPRECATED_VALID_PROPS: Record<string, string[]> = {
  TextLabel: ["Font"],
  TextButton: ["Font"],
  TextBox: ["Font"],
};

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

// CornerRadius overrides all four individual radii.
export const UICORNER_INDIVIDUAL_RADII = [
  "BottomLeftRadius",
  "BottomRightRadius",
  "TopLeftRadius",
  "TopRightRadius",
];

export function cornerRadiusConflicts(keys: Iterable<string>): string[] {
  const set = new Set(keys);
  if (!set.has("CornerRadius")) {
    return [];
  }
  return UICORNER_INDIVIDUAL_RADII.filter((k) => set.has(k));
}

const eventsCache = new Map<string, string[]>();

// List specific events before inherited ones to prioritize relevant completions.
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

export function findIntroducingClass(
  className: string,
  propName: string,
): string | undefined {
  return findIntroducing(className, propName, (def) => def.own);
}

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

export const defaultPropsMap: Record<string, string[]> = Object.fromEntries(
  Object.keys(classHierarchy).map((name) => [name, flattenClassProps(name)]),
);

const ABSTRACT_CLASS_NAMES: ReadonlySet<string> = new Set([
  "Instance",
  "GuiBase2d",
  "GuiObject",
  "GuiButton",
  // Synthetic grouping, not a constructible Roblox class.
  "UILayout",
]);

export const DIRECT_INSTANTIABLE_CLASS_NAMES: ReadonlySet<string> = new Set(
  Object.keys(classHierarchy).filter((name) => !ABSTRACT_CLASS_NAMES.has(name)),
);

// Invalidate derived caches after any hierarchy mutation so descendants pick up changes.
export function rebuildDerivedClassData(): void {
  propsCache.clear();
  eventsCache.clear();
  getPropTypeCache.clear();
  for (const name of Object.keys(classHierarchy)) {
    defaultPropsMap[name] = flattenClassProps(name);
  }
}

export const DEFAULT_ALIASES = [
  "e",
  "createElement",
  "React.createElement",
  "Roact.createElement",
];

// Only types shared unambiguously across classes belong here.
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

  // Numbers
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

  // Booleans
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

  // Strings
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

  // Fonts
  FontFace: "Font",

  // Instance references
  Adornee: "Instance",
  CurrentCamera: "Camera",
  NextSelectionDown: "GuiObject",
  NextSelectionLeft: "GuiObject",
  NextSelectionRight: "GuiObject",
  NextSelectionUp: "GuiObject",
  PlayerToHideFrom: "Player",
  RootLocalizationTable: "LocalizationTable",
  SelectionImageObject: "GuiObject",

  // Enums
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

// Resolve class-specific type conflicts from the nearest ancestor before using PROP_TYPES.
export const PROP_TYPE_OVERRIDES: Record<string, Record<string, string>> = {
  Frame: {
    Style: "Enum.FrameStyle",
  },
  GuiButton: {
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
    BlurRadius: "UDim",
    Color: "Color3",
    Offset: "UDim2",
    Spread: "UDim2",
    Transparency: "number",
  },
};

// Cache missing types too, avoiding repeated hierarchy walks.
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

// Callers append the final tabstop and optional comma.
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

export const ANNOTATION_TYPE_HINTS = [
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
  "number",
  "string",
  "boolean",
  "nil",
  "any",
  "unknown",
  "React.ReactNode",
  "React.Ref",
];

// Unknown Enum.Font values fall back to the suffix as the family name.
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
