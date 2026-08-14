# Luix

[![Install — VS Code Marketplace](https://img.shields.io/badge/install-VS%20Code%20Marketplace-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=ericplane.luix-roblox)
[![GitHub stars](https://img.shields.io/github/stars/ericplane/Luix?style=flat-square&logo=github&logoColor=white&color=24292F)](https://github.com/ericplane/Luix/stargazers)
[![License](https://img.shields.io/badge/license-MIT-3DA639?style=flat-square)](https://github.com/ericplane/Luix/blob/main/LICENSE)

**All-in-one Roblox UI authoring helper for VS Code.** Luix understands
the call shapes of every popular Roblox UI framework — React-Luau,
Roact, Fusion, and Vide — and provides one consistent layer of editor
intelligence on top: prop completion, hover docs, inlay hints, color
preview, deprecation diagnostics, workspace-wide component inference,
and more.

Whether you write:

```lua
-- React-Luau / Roact
e("TextLabel", {
    Text = "Hello",
    -- type "Back" → suggest BackgroundColor3, BackgroundTransparency, …
})

-- Fusion
New "TextLabel" {
    Text = "Hello",
    -- same suggestions
    [OnEvent "MouseEnter"] = onHover,
}

-- Vide
create "TextLabel" {
    Text = "Hello",
    -- same suggestions, plus event names (Activated, MouseEnter, …)
    -- appear as regular props
}
```

— Luix offers the same prop completions, the same hover docs, the same
color picker, the same inlay hints. **One extension, every framework.**

---

## Highlights

A whirlwind tour of what you get out of the box — full details
further down.

- **Prop completion** for every Roblox host class, with type-aware
  value snippets (`BackgroundColor3 = Color3.fromRGB(…)`,
  `Size = UDim2.new(…)`, etc.). Works inside `e("Frame", { … })`,
  `New "Frame" { … }`, `create "Frame" { … }`, and Luau backtick
  template strings. Color3 / UDim / Font props auto-open a suggest
  dropdown with both built-in constructors *and* your defined
  `luix.palette` / `luix.spacing` / `luix.fonts` tokens.
- **Class-name completion** the instant you type the opening quote of
  a factory call — picks the class *and* sets up the props braces.
- **Anchor preset shortcut** — type `anchor:tl|t|tr|l|c|r|bl|b|br`
  inside any props table and expand to a paired `AnchorPoint` +
  `Position`. Plus an *auto-detect* diagnostic that flags
  `Position = UDim2.fromScale(0.5, …)` without a matching anchor.
- **RichText support** — typing `<` inside `Text = "…"` opens a tag
  picker (`<b>`, `<font color="…" size="…">`, `<stroke>`, …), the
  matching close tag is inserted on accept, attribute completion
  chains multiple attributes per tag, and the color picker fires on
  `color="…"` values. Warns when `RichText = true` is missing.
- **Roblox custom-glyph display** — Robux / Premium / Verified /
  Roblox-Plus PUA characters get inlay-hint labels so you can read
  what each `[]`-box is. Type `:robux:` to insert the literal glyph.
  Add your own (`:gbp:` → `£`) via `luix.robloxGlyphs.custom`.
- **Image-asset hover preview** — hover any `"rbxassetid://NNNN"` to
  see the actual Roblox CDN thumbnail in the tooltip.
- **Image-asset gutter previews (opt-in)** — once enabled, every
  asset reference also gets a tiny thumbnail in the gutter. Thumbnails
  are downloaded once and cached. One-click enable from the Luix
  sidebar.
- **Color picker** for every `Color3.fromRGB/new/fromHex/fromHSV`
  literal, plus a *convert between forms* code action.
- **Gradient editor** — single **Edit UIGradient** CodeLens on
  `e("UIGradient", …)` opens a combined side-panel for colour ramp +
  transparency curve + rotation, with a preview square that multiplies
  by the parent's `BackgroundColor3`. Standalone
  `ColorSequence.new(...)` / `NumberSequence.new(...)` literals get
  focused per-literal editors. Both kinds get a strip / curve preview
  on hover.
- **Rect editor** — every `ImageLabel` / `ImageButton` with a literal
  `rbxassetid://…` `Image` gets an **Edit sprite rect** CodeLens.
  Opens a side panel showing the asset's thumbnail with a draggable
  rectangle for `ImageRectOffset` / `ImageRectSize`, auto-detected
  frame aspect, dashed inner box showing what `ScaleType.Crop` will
  actually render, scroll-to-zoom canvas, and per-asset memory of the
  source dimensions you typed.
- **Visual hover previews** — hover any `TweenInfo.new(...)` for an
  easing-curve graph; hover an `e("UIPadding", …)` / `e("UICorner", …)` /
  `e("UIStroke", …)` for a sample box visualising the configured
  values.
- **`UDim2` form conversion** — swap between
  `new` / `fromOffset` / `fromScale` when the value is expressible.
- **Wrap-in code actions** — wrap any element in a `Frame`,
  `ScrollingFrame`, or `Frame + UIListLayout`. Framework-aware.
- **Extract-to-component refactor** — right-click an element tree →
  pulls it out into a new file with *only the imports it actually
  uses*, transitively resolved.
- **`N references` CodeLens** above every component definition.
  Hover-style component docs on the call site (`e(MyButton, …)` →
  inferred props + extends chain).
- **Prop validation diagnostics** — unknown prop on a host class
  (with did-you-mean), duplicate key, wrong enum type, prop hardcoded
  in a custom component, missing `AnchorPoint`, missing `RichText`,
  numeric-range warnings (`Transparency = 1.5`), `TextScaled` gotcha
  (collapses to zero without a fixed-offset `Size`), deprecated
  `Font = Enum.Font.X`, typo-d `TextColor`. Optional WCAG-AA
  **color-contrast** warnings (`luix.contrastWarnings.enabled`).
- **Unused-prop diagnostic** — props declared on a component but
  never read in its body get the TS-style grey-out treatment.
  Skipped when `props` is forwarded wholesale.
- **Design tokens** — `luix.palette` (colors), `luix.spacing` (UDim),
  `luix.fonts` (Font). Type `Color3.` / `UDim.` / `Font.` to surface
  your named tokens.
- **Roblox font catalogue** — typing inside `Font.fromName("…")`
  surfaces 36 built-in Roblox families with their supported weights;
  the `Enum.FontWeight.` dropdown then filters to only the weights
  *that family* actually ships. Custom families via
  `luix.customFonts`.
- **Color3 → palette extractor** — cursor on any Color3 literal →
  *Save to `luix.palette`* code action.
- **Sort props by category** — code action that reorders any props
  table into a clean category order (Identification → Layout → Style
  → Image → Text → Behavior → Events → …). Optional opt-in
  format-on-save via `luix.sortProps.onSave`. Order is configurable.
- **Frame-stats CodeLens** (off by default) — `▸ N descendants, D
  layers deep` over heavy subtrees so you spot layout bloat.
- **Project-wide diagnostic summary** (off by default) — sidebar
  shows `N warnings · M errors across X files`.
- **Workspace-wide component inference** — `e(MyButton, …)` gets prop
  completions inferred from the component's annotations, typed
  parameter, root element, or central `luix.props` config — even
  across files.
- **Sidebar** — Wally / Rojo / scaffold actions, component browser
  (tree or flat), and image-cache controls.

---

## Supported frameworks

| Framework | Call shape | Children | Events |
| --- | --- | --- | --- |
| **React-Luau** | `e("Frame", { … }, { children })` | 3rd argument | `[React.Event.X] = fn` |
| **Roact** | `Roact.createElement("Frame", { … })` | 3rd argument | `[Roact.Event.X] = fn` |
| **Fusion** | `New "Frame" { … }` | `[Children] = { … }` | `[OnEvent "X"] = fn` |
| **Vide** | `create "Frame" { … }` | inline in same table | plain props (`X = fn`) |

Toggle which frameworks Luix recognizes via `luix.frameworks` (default:
all four). Override the factory aliases per-framework via
`luix.<framework>.aliases` — useful if your codebase aliases the factory
locally, e.g. `local r = React.createElement` or `local n = Fusion.New`.

The first argument can be a string (`"TextLabel"`) or an identifier
(`MyButton`, `Components.Button`) — Luix handles both.

### Curried calls: every spelling works

The table shows each framework's canonical shape, but the curried
frameworks (Fusion, Vide) are recognized however the call is actually
written. Both stages are independent, and Luix accepts all four
combinations:

| | Sugar props | Parenthesized props |
| --- | --- | --- |
| **Sugar name** | `New "Frame" { … }` | `New "Frame" ({ … })` |
| **Parenthesized name** | `New("Frame") { … }` | `New("Frame")({ … })` |

That matters if you run **StyLua**: its default `call_parentheses =
"Always"` (which the [Roblox Lua Style
Guide](https://roblox.github.io/lua-style-guide/) requires) rewrites
every sugar call into `New("Frame")({ … })`, so a formatted codebase
contains only the bottom-right cell.

**Fusion 0.3 scopes** work in both places the scope can appear — as a
leading argument, or as a receiver from `scoped()`:

```lua
New(scope, "Frame") { … }
scope:New "Frame" { … }
scope:New("Frame")({ … })     -- …and StyLua'd
```

A receiver is accepted in front of any curried alias, so a `require`
bound to a local name other than `Fusion` (`MyFusion.New "Frame" { … }`)
resolves without adding it to `luix.fusion.aliases`.

Components follow the same rule: `MyButton { … }`, `MyButton({ … })`,
and Fusion 0.3's `MyButton(scope, { … })` are all detected. A component
whose first parameter is the scope has its props read from the second
parameter, so `props`' type still drives call-site completions:

```lua
local function Card(scope: Scope<typeof(Fusion)>, props: CardProps)
```

---

## Feature tour

### Prop completion with type-aware value snippets

Type any prop name inside an element table and accept the completion to
get a snippet wired up with tab stops:

| What you type | Inserted snippet |
| --- | --- |
| `BackgroundColor3` | `BackgroundColor3 = Color3.fromRGB(255, 255, 255),` |
| `Size` | `Size = UDim2.new(0, 0, 0, 0),` |
| `Interactable` | `Interactable = true\|false,` *(a toggleable choice)* |
| `FontFace` | `FontFace = Font.fromName("Montserrat", Enum.FontWeight.Regular),` |
| `Text` | `Text = "",` *(cursor inside the quotes)* |
| `HorizontalAlignment` | `HorizontalAlignment = Enum.HorizontalAlignment.,` |

Works identically across all four frameworks. Toggle with
`luix.typeAwareValues`.

Color3 placeholders honour **`luix.color3.defaultFormat`** — pick
`fromRGB` (default), `fromHex`, `new`, or `fromHSV` so the inserted
template matches your house style.

**Two smart-completion behaviors worth knowing about:**

- **Trailing-comma awareness.** If the line already has a `,` after
  the partial prop name (e.g. you typed `Bac,` then went back to fill
  it in), the snippet's own comma replaces the existing one rather
  than doubling it. The cursor still lands cleanly *after* the comma.
- **Key-position gating.** Prop completions and the `anchor:` preset
  shortcut only surface in *key* position (start of a new entry).
  Typing inside a value expression like `FontFace = Font.|` doesn't
  pollute the dropdown with `BackgroundColor3` / `Size` / etc. —
  those only show up when you're typing a fresh prop name.

**For Color3 / UDim / Font props specifically**, accepting the prop
inserts just the namespace prefix and auto-opens the suggest dropdown
so you can pick a constructor *or* one of your defined tokens —
covered in the [Design tokens](#design-tokens--color-spacing-fonts)
section below.

### Anchor preset completion

Type `anchor:` inside any props table and pick one of nine presets:

| Slug | Anchor + Position |
| --- | --- |
| `anchor:tl` | top-left `(0, 0)` |
| `anchor:t` | top `(0.5, 0)` |
| `anchor:tr` | top-right `(1, 0)` |
| `anchor:l` | left `(0, 0.5)` |
| `anchor:c` | center `(0.5, 0.5)` |
| `anchor:r` | right `(1, 0.5)` |
| `anchor:bl` | bottom-left `(0, 1)` |
| `anchor:b` | bottom `(0.5, 1)` |
| `anchor:br` | bottom-right `(1, 1)` |

Accepting `anchor:br` expands to:

```lua
AnchorPoint = Vector2.new(1, 1),
Position = UDim2.fromScale(1, 1),
```

Kills the constant AnchorPoint mental math. Pairs with the
**AnchorPoint auto-detect** diagnostic below — if you write
`Position = UDim2.fromScale(0.5, 0.5)` first and forget the
AnchorPoint, Luix flags it with a one-click fix.

### Wrap-in code actions

Cursor anywhere in an element call → 💡 lightbulb offers:

- *Wrap in Frame* — transparent passthrough container.
- *Wrap in ScrollingFrame* — vertical scroll with `AutomaticCanvasSize`.
- *Wrap in Frame + UIListLayout* — vertical stack container with sane defaults.

Framework-aware. Emits parens form (`e(...)`) for React/Roact, curried
form (`New "..." { [Children] = { ... } }`) for Fusion, inline children
for Vide.

### Extract-to-component refactor

Right-click an element call → **Luix: Extract to component…**

```lua
-- Before
local function HomeScreen()
    return e("Frame", { Size = ... }, {
        e("Frame", { -- cursor here
            Size = ...,
            BackgroundColor3 = ...,
        }, {
            e("UICorner", { CornerRadius = UDim.new(0, 8) }),
            e("TextLabel", { Text = "Welcome" }),
        })
    })
end
```

```lua
-- After (HomeScreen.luau)
local Card = require(script.Parent.Card)

local function HomeScreen()
    return e("Frame", { Size = ... }, {
        e(Card, {})
    })
end
```

```lua
-- After (Card.luau, freshly written)
local React = require(Packages.react)
local e = React.createElement

local function Card(props)
    return e("Frame", {
        Size = ...,
        BackgroundColor3 = ...,
    }, {
        e("UICorner", { CornerRadius = UDim.new(0, 8) }),
        e("TextLabel", { Text = "Welcome" }),
    })
end

return Card
```

Imports are pulled across **transitively** — `local e =
React.createElement` brings `React` along too, so the new file
compiles immediately. Anything the extracted code *doesn't* use stays
behind. The new file is written in the same folder as the source; the
component is invoked as `e(Card, {})` (React/Roact) or `Card {}`
(Fusion/Vide — which compose components by direct call rather than via
`New`/`create`).

### Class-name completion inside factory calls

The moment you type `e("`, `Roact.createElement("`, `New "`, `create "`,
or the Luau backtick form `` e(` ``, Luix opens a class picker:

```lua
e("Fr|")        --> accept "Frame" → e("Frame", { <cursor> })
New "Fr|"       --> accept "Frame" → New "Frame" { <cursor> }
create "Fr|"    --> accept "Frame" → create "Frame" { <cursor> }
```

When the call has no props table yet, accepting also inserts `, { … }`
(parens form) or `{ … }` (curried form) with the cursor parked inside
ready for prop completion. When a props table already exists, accepting
swaps just the class name. Synthetic intermediate classes (`GuiObject`,
`UILayout`, …) are hidden — only types you can actually instantiate
show up.

### Outline + breadcrumbs

The VS Code Outline panel and breadcrumbs bar reflect the **React tree**
of the current file, not just its Lua function structure. Components
named via the `Name` prop are labeled with that name. `Cmd+Shift+O`
jumps straight to any element by name.

### Inlay hints at closing brackets

Every multi-line element gets a small label at its closing punctuation
so you can tell what just closed even ten levels deep:

```lua
e("Frame", {
    Name = "Container",
}, {
    e("Frame", {
        Name = "Inner",
    }, {
        e("TextLabel", { Text = "Hi" })  -- ▸ TextLabel
    })  -- ▸ Frame (Inner)
})  -- ▸ Frame (Container)
```

```lua
New "Frame" {
    Name = "Container",
    [Children] = {
        New "TextLabel" { Text = "Hi" }   -- ▸ TextLabel
    },
}                                          -- ▸ Frame (Container)
```

Default scope is `"ancestors"` — hints surface only on the chain
containing the cursor, so the file stays uncluttered. Switch to `"all"`
via `luix.inlayHints.scope`.

### Color preview

`Color3.fromRGB(R, G, B)`, `Color3.new(R, G, B)`, `Color3.fromHex("#…")`,
and `Color3.fromHSV(h, s, v)` all get a swatch in the gutter; click it
for VS Code's color picker. The picker surfaces all four constructor
forms — your existing notation is always offered first so editing
visually never silently flips your codebase from hex to RGB (or vice
versa).

Toggle the Color3 picker via **`luix.colorPreview.enabled`** — handy if
another Roblox-API extension provides its own picker and you'd rather
not see two. The RichText color picker (see below) is on a separate
**`luix.richText.colorPicker`** toggle so you can keep one without the
other.

### Convert Color3 between formats

Put the cursor on any `Color3.fromRGB(…)`, `Color3.fromHex(…)`,
`Color3.new(…)`, or `Color3.fromHSV(…)` literal and the lightbulb
offers:

```
💡 Convert to `Color3.fromRGB(...)`
💡 Convert to `Color3.fromHex(...)`
💡 Convert to `Color3.new(...)`
💡 Convert to `Color3.fromHSV(...)`
```

Picks any of the four and the actual color is preserved.

### Gradient editor (Preview)

Three editor modes triggered by a single command, picked
automatically based on what you click:

- **UIGradient** — a single **Edit UIGradient** CodeLens above every
  `e("UIGradient", { … })` opens a combined editor with the colour
  ramp, transparency curve, rotation slider, and a preview square
  that multiplies by the parent element's `BackgroundColor3`
  (Roblox's actual `UIGradient` semantics).
- **ColorSequence** — standalone `ColorSequence.new(...)` literals
  get a focused editor: colour band with draggable triangle stops,
  per-stop HTML5 colour picker, time/offset input.
- **NumberSequence** — standalone `NumberSequence.new(...)` literals
  get a grid canvas with draggable circle stops (X = time, Y = value),
  value + envelope inputs.

All three editors share:

- Click the strip / canvas to add a stop; Shift snaps drag/click to
  0.05 increments. Hover indicator shows where the next stop would
  land.
- Scroll-wheel + arrow stepping on every numeric field, with Shift =
  5× step. Decimal point always renders `.` regardless of OS locale.
- Output respects `luix.color3.defaultFormat`, so workspace pinned to
  `fromHex` gets `Color3.fromHex(...)` keypoints.
- Two-stop edge cases collapse into the short form
  (`ColorSequence.new(c1, c2)`); three or more produce the
  keypoint-array form.
- Default values (`Color = white`, `Transparency = 0`, `Rotation = 0`)
  are *omitted* from the written-back UIGradient props — no noise.

Reactive sources (Fusion `Value`, Vide source, `Computed`) and
gradients built from variables stay inert — only fully literal
gradients get the CodeLens.

Toggles: **`luix.gradient.codeLensEnabled`** (on),
**`luix.gradient.previewOnHover`** (on).

### Rect editor (Preview)

Every `e("ImageLabel", { … })` or `e("ImageButton", { … })` whose
`Image` prop is a literal `rbxassetid://…` gets an **Edit sprite
rect** CodeLens. Opens a side-panel editor:

- **Thumbnail canvas** at the largest size the API actually serves
  (768 → 512 → 420 → 256 → 150 fallback ladder).
- **Draggable rectangle** with 8 resize handles for picking
  `ImageRectOffset` / `ImageRectSize` visually. Dimmed mask outside
  the rect; amber dashed border when the rect extends past the
  source bounds.
- **Aspect-ratio auto-detect** — reads a sibling
  `UIAspectRatioConstraint` or a fixed-pixel `Size = UDim2.fromOffset(…)`
  and pre-fills the **Frame aspect** input.
- **Crop preview overlay** — dashed yellow inner box showing exactly
  what `ScaleType.Crop` will render given the frame aspect. Hidden
  for `Fit / Stretch / Tile / Slice`.
- **Native dimensions via Open Cloud (opt-in)** — set
  `luix.openCloud.apiKey` to a Roblox API key with the
  `legacy-asset:manage` permission and the editor auto-detects the
  asset's real pixel dimensions by hitting
  `apis.roblox.com/asset-delivery-api/v1/assetId/{id}`, downloading
  the returned location, and reading the PNG/JPEG header. One call
  per asset, ever — results cached in `globalState`.
- **Manual override fallback** — without an API key (or if the
  lookup fails) the editor uses the thumbnail's natural dimensions
  and lets you type `Source W` / `Source H` manually per asset. The
  values you type are also cached, so manual setup is one-time too.
- **Scroll-to-zoom** — wheel on the canvas zooms 15% – 300%, with a
  discoverable **🔍 zoom bar** (− / % / +) in the corner.
- **Rect can exceed source dimensions** — W and H accept up to 4×
  source; the rect can be dragged past the image edge.
- Resetting to the whole image strips both `ImageRectOffset` and
  `ImageRectSize` props since `Vector2.new(0, 0)` is Roblox's default.

Toggle: **`luix.rectEditor.codeLensEnabled`** (on).

### Visual hover previews

Hover any of the following to see a tiny SVG rendered straight from
your literal values — no network requests, no caching:

- **`TweenInfo.new(...)`** — a 240×140 graph of the easing curve,
  with reference bars at `value = 0` and `value = 1` so overshoots
  (Back, Elastic) are visible. Summary line below: duration,
  repeat-count, reverses, delay.
- **`e("UIPadding", { … })`** — sample box with the inner content
  area indented by the configured `PaddingTop` / `Right` / `Bottom` /
  `Left`. Each non-zero side gets its pixel value labelled.
- **`e("UICorner", { … })`** — sample rectangle rendered at the
  configured `CornerRadius`.
- **`e("UIStroke", { … })`** — sample box with the stroke applied
  at the configured `Thickness` / `Color` / `Transparency`, plus
  the resolved `ApplyStrokeMode`.

Toggle: **`luix.hoverPreviews.enabled`** (on).

### Sort props by category

Right-click anywhere inside a props table → 💡 **Sort props by
category**. The editor reorders props into the configured category
order:

```
Identification → Layout → Style → Visibility → Image → Text →
Behavior → Events → Refs → Children → Other
```

- Within each category, props are placed in their canonical Roblox
  order; ties keep their original order (stable sort).
- Computed-key aware: `[React.Event.Activated]`, `[OnEvent "…"]`,
  `[Children]` are recognised. Vide-style plain identifier events
  (`Activated = function() … end`) are mapped to **Events** too.
- Tables containing `--` comments are skipped to avoid detaching
  comments from their props.
- **Idempotent** — re-sorting a sorted table is a no-op (no
  spurious save edits).

Optional format-on-save via **`luix.sortProps.onSave`** (default
`false` — your teammates' files aren't reshaped on save unless
they opt in too).

Order is fully customisable via **`luix.sortProps.categoryOrder`**
(string array) — reorder or remove categories to taste.

### Convert UDim2 between forms

Cursor on any `UDim2.new(...)`, `UDim2.fromOffset(...)`, or
`UDim2.fromScale(...)` literal → lightbulb offers conversion to the
other two forms — but only when the value is actually expressible. For
example, `UDim2.new(0.5, 10, 0.5, 5)` won't offer `fromOffset` or
`fromScale` (it mixes both), but `UDim2.new(0, 100, 0, 50)` will offer
*Convert to `UDim2.fromOffset(100, 50)`*.

### Image-asset thumbnail in hover

Hover any string of the form `"rbxassetid://NNNN"` to see the actual
asset image fetched from Roblox's CDN:

```lua
Image = "rbxassetid://1234567",  -- hover → 150×150 preview of the asset
```

Catches "did I paste the right ID?" bugs without bouncing into the
Roblox website. Works on any string literal, not just `Image` props.
The thumbnail URL is resolved via Roblox's public
`thumbnails.roblox.com` API and cached per session.

### Image-asset gutter previews (opt-in)

In addition to the hover, every `"rbxassetid://NNNN"` reference can
get a tiny thumbnail in the gutter next to its line — same pattern as
`vscode-gutter-preview` for local `.png` files. Each thumbnail is
downloaded once and persisted to disk; reopens are instant.

**Off by default** because it persists files to disk and changes
every editor's visual layout. The Luix sidebar shows a one-click
*Enable image gutter previews* entry while the feature is off; click
it to flip the setting and see a one-time disclosure of where the
cache lives.

**Settings:**

- **`luix.imageGutter.enabled`** (default `false`) — toggles the
  feature. The hover preview keeps working either way.
- **`luix.imageGutter.cacheLocation`** (default `"global"`) —
  - `"global"`: cache lives under VS Code's extension storage, shared
    across every workspace.
  - `"workspace"`: cache lives at `.luix/assetThumbs/` inside the
    current workspace, with a `.luix/.gitignore` auto-written so it
    doesn't leak into commits.

**Sidebar:** once enabled and there's anything cached, the Workspace
view shows two entries — *"Purge image preview cache"* (with a live
`N assets — X.X MB` size readout) and *"Open image cache folder"*
(reveals the cache directory in your OS file manager). Both also
available via `Cmd+Shift+P` → "Luix:". Purging wipes both the global
and workspace locations so flipping `cacheLocation` mid-project never
strands stale files.

### Hover documentation

Hover any prop name inside an element table to see its type, the class
it was introduced on (walking the Roblox hierarchy), and a deep link to
the Roblox reference docs.

Hover a **custom-component name** (`e(MyButton, …)` → hover `MyButton`)
to see what Luix has inferred about it: its declared props
(`@prop`/typed param/auto-detected), the base class it extends, and a
list of forwardable props. Hovering a prop key inside `e(MyButton, …)`
shows whether the prop is component-defined or inherited from the base
class.

### RichText support

Typing `<` inside a string literal opens a tag picker for every Roblox
RichText tag (`<b>`, `<i>`, `<u>`, `<s>`, `<sc>`, `<smallcaps>`,
`<uppercase>`, `<sub>`, `<sup>`, `<comment>`, `<br/>`, `<font …>`,
`<stroke …>`, `<mark …>`):

```lua
Text = "Hello <|"
              ^-- type `<` to surface the tag list
```

Accepting includes the matching close tag with the cursor inside:

```lua
Text = "Hello <font color=\"#FF0000\"><cursor></font>"
```

Inside an open `<font …>`, `<stroke …>`, or `<mark …>`, an
attribute-name completion (`color`, `size`, `face`, `family`, `weight`,
`transparency`, `thickness`, `joins`) fires so you can chain multiple
attributes the way Roblox supports them:

```lua
Text = "<font color=\"#FF0000\" size=\"24\" weight=\"Bold\">Hi</font>"
```

Typing the `>` that closes an opening tag manually auto-inserts the
matching `</font>`. Inner attribute quotes adapt to whichever outer Lua
string delimiter you use (`"…"`, `'…'`, or Luau's `` `…` `` template
strings) so attribute values never need backslash escaping.

`color="…"` values inside `<font>`, `<stroke>`, and `<mark>` get an
inline color picker that recognizes both `#RRGGBB` and `rgb(R, G, B)`
forms — the round-trip preserves whichever you wrote.

If `Text = "<font…>…"` references a RichText tag but the same props
table doesn't also set `RichText = true`, Luix flags it with a warning
and a *Set `RichText = true`* quick-fix that inserts the line with
matching indentation. Only fires on string-literal `Text` values, so
`Text = someVar` stays silent.

Default snippet color format toggles via
**`luix.richText.defaultColorFormat`** (`hex` / `rgb`, default `hex`).
Disable the whole feature via **`luix.richText.enabled`**.

### Roblox custom-glyph support

Roblox's icon set (Robux `U+E002`, Premium `U+E001`, Verified `U+E000`,
Roblox Plus `U+E003`) lives in the Unicode private-use area — VS Code's
default fonts render them as `[]` boxes. Luix adds:

- **Inlay-hint labels** next to each occurrence so you can tell which
  box is which while reading code.
- **Hover tooltips** with the codepoint and Luau `\u{…}` escape.
- A **completion**: type `:robux:`, `:premium:`, `:verified:`, or
  `:roblox-plus:` inside a string and accept to insert the literal
  glyph.

Add your own keyboard-unreachable shortcuts via
**`luix.robloxGlyphs.custom`**:

```jsonc
{
  "luix.robloxGlyphs.custom": {
    "gbp":   "£",
    "euro":  "€",
    "yen":   "¥",
    "shrug": "¯\\_(ツ)_/¯"
  }
}
```

Typing `:gbp:` then expands to `£`. Built-in slugs can't be shadowed.

### Event completion

- **React/Roact** — typing `[React.Event.` (or `[Roact.Event.`) inside a
  props table lists the events available on the enclosing class
  (`Activated`, `MouseEnter`, `MouseButton1Click`, …). Same for
  `[React.Change.X]` listening to property changes.
- **Fusion** — typing `[OnEvent "M` suggests events as plain strings.
  *(Curried call detection is in place; richer in-bracket completion
  ships alongside it.)*
- **Vide** — events are plain table keys; Luix already merges the
  class's events into the prop suggestion list for you.

### Workspace-wide component inference

Use a component the way you use a host class:

```lua
local GamepassCard = require(script.Parent.GamepassCard)

-- Luix indexes every .lua/.luau file in the workspace at activation.
-- Typing inside e(GamepassCard, { … }) offers the props it can detect.
e(GamepassCard, {
    -- suggestions come from GamepassCard.lua's signature, annotations,
    -- or its root element. Works whether GamepassCard is React, Fusion,
    -- or Vide.
})
```

Four inference signals are checked, listed from least to most explicit:

1. **Auto-detection** from the component's root element. If the
   function returns `e("Frame", ...)`, `New "Frame" { … }`, or
   `create "Frame" { … }`, Luix uses that class's props.
2. **`---@extends ClassName` and `---@prop NAME [type]` annotations**
   placed above the function. Lua-LS–style triple-dash comments — read
   by Luix, ignored as a regular comment by every other tool.
3. **Typed `props` parameter** — inline literal type
   (`props: { gamepassId: number }`) or a same-file `type` alias.
4. **`luix.props`** central config — for components that live outside
   the workspace or need a global override.

> **Caveat: suggesting ≠ forwarding.** A suggested prop only takes
> effect if your component actually forwards it. If `GamepassCard`
> hardcodes all its `Frame` props, writing `BackgroundColor3 = …` at
> the call site does nothing. You'd merge `props` into the inner table
> (via `table.clone` or a dictionary-join helper) to make it pass
> through.

### Diagnostics + quick fixes

Yellow squigglies, one-click fixes:

**Deprecation** — toggle with `luix.deprecationDiagnostics` (default
`true`):

- `Font = Enum.Font.GothamBold` → quick-fix replaces with
  `FontFace = Font.fromName("Gotham", Enum.FontWeight.Bold)`.
- `TextColor = …` (missing the trailing `3`) → quick-fix renames to
  `TextColor3`.

**Prop validation** — toggle with `luix.propValidation.enabled`
(default `true`):

- **Unknown property** on a known Roblox class —
  `e("Frame", { ScrollingDirection = … })` warns *"Unknown property
  `ScrollingDirection` on `Frame`. Did you mean `Position`?"* with a
  *Rename to `Position`* quick-fix (Levenshtein-based suggestion).
- **Duplicate key** in the same props table — `Size = …, Size = …`
  flags the second assignment as silently overwriting the first.
- **Wrong enum type** — `BorderMode = Enum.Font.X` warns because
  `BorderMode` expects `Enum.BorderMode`.
- **Overridden by component** — passing a prop to a custom component
  whose root element hardcodes the same prop (and doesn't forward
  `props.X`) surfaces an Information-level hint that the call-site
  value won't take effect.
- **Missing AnchorPoint** — `Position` set to `UDim2.fromScale(0.5, …)`
  / `(1, …)` / etc. with no `AnchorPoint` flagged with an Info-level
  *"add `AnchorPoint = Vector2.new(0.5, 0.5)`"* quick-fix. Stops the
  classic "why isn't my element centered?" bug at the source.
- **Numeric-range warnings** — `Transparency = 1.5`,
  `Rotation = 720`, `BorderSizePixel = 100`, etc. Per-prop bounds.
- **`TextScaled` gotcha** — `TextScaled = true` with a pure-scale
  `Size` (or no `Size`) collapses text to zero; flagged with a clear
  explanation.

**Unused-prop diagnostic** (`luix.unusedProps.enabled`, default `true`):

- Props declared in a component's parameter type
  (`props: { Foo: …, Bar: … }`) or its `@luix-props` annotation
  that are never read in the body are flagged with the same
  grey-out treatment TypeScript uses for unused locals (`Hint`
  severity, `Unnecessary` tag).
- Skipped automatically when the body forwards `props` wholesale
  (`e(Base, props)`, `for k, v in props do`, computed-key indexing)
  since static analysis can't determine downstream usage.
- The squiggle targets the field name inside the type annotation
  when possible, otherwise the function definition line.

**Optional WCAG color-contrast warnings** (`luix.contrastWarnings.enabled`):

- Walks the element tree and flags any `TextColor3` whose contrast
  ratio against the nearest ancestor's `BackgroundColor3` is below
  4.5:1 (WCAG-AA for normal text). Off by default because it's strict
  and can pile up on existing codebases. Both colors must be literal
  Color3 expressions — reactive Fusion/Vide values are skipped to
  avoid false positives.

**RichText** (gated by `luix.richText.enabled`):

- `Text = "<font…>"` without `RichText = true` in the same props table
  warns that the tags will render as literal text, with a *Set
  `RichText = true`* quick-fix.

### Auto-import (opt-in)

When enabled, `e(GamepassCard, { … })` for a component the workspace
knows about but the current file doesn't `require` gets an Information
diagnostic plus a quick-fix that inserts the require line near your
existing imports.

```jsonc
{
  "luix.autoImport.enabled": true,
  "luix.autoImport.style": "alias",
  "luix.autoImport.aliases": [
    {
      "filesystemPath": "src/Client/UI/Components",
      "robloxPath": "script.Components"
    },
    {
      "filesystemPath": "src/Shared/Packages",
      "robloxPath": "ReplicatedStorage.Packages"
    }
  ]
}
```

`"style": "relative"` produces `script.Parent…X` chains based on
filesystem position; `"style": "alias"` substitutes the prefixes above.

### Reference CodeLens

Every component definition gets an inline `▸ N references` CodeLens
above it. Click to peek every workspace call site (`e(MyButton, …)` and
friends) — handy for figuring out blast radius before changing a
component's props.

Toggle with **`luix.componentReferencesLens.enabled`** (default `true`).

### Frame-stats CodeLens (off by default)

When enabled, every element call gets a `▸ Frame — N descendants, D
layers deep` CodeLens. Useful for spotting subtrees that have grown
out of hand (Roblox slows down once you nest too many UI instances).

- **`luix.frameStatsLens.enabled`** (default `false`).
- **`luix.frameStatsLens.minDescendants`** (default `5`) — only show
  the lens for elements with at least this many descendants. Stops
  trivial elements from cluttering the gutter.

### Workspace-wide diagnostic summary (off by default)

When enabled, the Luix sidebar shows a line summarising every
diagnostic VS Code currently knows about for Lua/Luau files in the
workspace:

```
✓ Project diagnostics — 0 warnings across 12 files       (clean)
⚠ Project diagnostics — 8 warnings across 4 files        (issues)
✗ Project diagnostics — 2 errors · 5 warnings ...        (errors)
```

Click to open VS Code's Problems panel. Aggregates Luix's own
diagnostics plus anything any other extension publishes — useful as a
"how clean is my project?" gauge during cleanup passes.

Toggle with **`luix.workspaceValidation.enabled`** (default `false`).

### Sidebar (Activity Bar)

Luix adds an Activity Bar entry with two views:

**Workspace** — context-sensitive project actions:

| Entry | Visible when | What it does |
| --- | --- | --- |
| ▸ Regenerate Wally types | `wally.toml` exists | Runs `wally install` → `rojo sourcemap` → `wally-package-types` in one chained command. |
| ▸ wally install | `wally.toml` exists | Just `wally install`. |
| ▸ Generate Rojo sourcemap | `*.project.json` exists | `rojo sourcemap <project> -o sourcemap.json` |
| ▸ New React component | always | Prompts for a name, creates `<Name>.luau` with a React-Luau scaffold, opens it. |
| ▸ New Fusion component | always | Same, Fusion `New "Frame" { [Children] = { … } }` template. |
| ▸ New Vide component | always | Same, Vide `create "Frame" { … }` template. |

All Wally/Rojo commands stream to a reusable named terminal ("Luix") so
you can watch and interrupt them.

**Components** — every UI component the workspace indexes. Two view
modes, toggled via the title-bar button:

- **Tree** (default): grouped by folder, mirroring how the files are
  organized on disk. Click an entry to jump to the function definition.
- **Flat**: alphabetical list of every component.

Only functions Luix is confident are UI components show up here — i.e.
those that either return an `e("…", …)` / `New "…" { … }` /
`create "…" { … }` element at the top level, **or** carry an explicit
`---@extends ClassName` annotation. Helper functions that happen to
take a `props` parameter are skipped.

Optionally pin the tree to a subfolder via `luix.componentsRoot`:

```jsonc
{
  "luix.componentsRoot": "src/Client/UI/Components"
}
```

When set, tree mode is rooted there; anything outside is hidden in
tree mode (flat mode still shows everything).

To create a new component in a *specific* folder, right-click that
folder in VS Code's Explorer and pick **Luix: New component here…** —
Luix prompts for the framework (React / Fusion / Vide) and the name,
then writes the file directly into that folder. The sidebar's
"New … component" buttons still work too; they open a folder picker
first.

Both views are also available via `Cmd+Shift+P` → search "Luix:".

### Design tokens — color, spacing, fonts

Three central tables let you name design tokens once and surface them
as completions wherever they're relevant:

| Setting | Triggers after | Suggests entries like |
| --- | --- | --- |
| `luix.palette` | `Color3.` | `palette.primary` → `Color3.fromRGB(124, 92, 255)` |
| `luix.spacing` | `UDim.` | `spacing.md` → `UDim.new(0, 16)` |
| `luix.fonts` | `Font.` | `fonts.display` → `Font.fromName("Gotham", Enum.FontWeight.Bold)` |

```jsonc
{
  "luix.palette": {
    "primary": "Color3.fromRGB(124, 92, 255)",
    "surface": "Color3.fromRGB(28, 30, 38)"
  },
  "luix.spacing": {
    "xs": "UDim.new(0, 4)",
    "sm": "UDim.new(0, 8)",
    "md": "UDim.new(0, 16)",
    "lg": "UDim.new(0, 24)"
  },
  "luix.fonts": {
    "display": "Font.fromName(\"Gotham\", Enum.FontWeight.Bold)",
    "body":    "Font.fromName(\"SourceSansPro\", Enum.FontWeight.Regular)"
  }
}
```

The accepted suggestion replaces the trigger keyword with the literal
expression, so the on-disk code stays canonical Luau — no runtime
`palette.primary` references to resolve.

**Save Color3 to palette** — cursor on any `Color3.fromRGB(...)` /
`fromHex(...)` / `new(...)` / `fromHSV(...)` → 💡 *Save Color3 to
`luix.palette`…*. Prompts for a name and a target (User / Workspace
settings); the literal becomes a permanent palette entry. Doesn't
modify the existing call site — it just makes the color reusable
going forward.

```jsonc
{
  "luix.palette": {
    "primary":    "Color3.fromRGB(124, 92, 255)",
    "background": "Color3.fromRGB(21, 21, 26)",
    "surface":    "Color3.fromRGB(28, 30, 38)",
    "text":       "Color3.fromRGB(255, 255, 255)"
  }
}
```

In a Lua file:

```lua
BackgroundColor3 = Color3.|     -- typing `.` shows:
                                --   ── built-in constructors ──
                                --   fromRGB    Color3 from 0-255 RGB channels
                                --   fromHex    Color3 from a "#RRGGBB" hex string
                                --   new        Color3 from 0-1 RGB channels
                                --   fromHSV    Color3 from 0-1 H/S/V
                                --   ── palette tokens ──
                                --   palette.primary
                                --   palette.surface
                                --   …
-- Picking a constructor (e.g. `fromRGB`) inserts the full call with
-- per-channel tab stops so you can quickly type 124, 92, 255.
-- Picking `palette.surface` replaces `Color3.` with the full
-- `Color3.fromRGB(28, 30, 38)` expression.
```

Same pattern applies to `UDim.` (constructors + `luix.spacing`
tokens) and `Font.` (constructors + `luix.fonts` tokens).

### Roblox font catalogue — family + weight autocomplete

Inside `Font.fromName("…")`, the family dropdown surfaces 36 built-in
Roblox families with their supported weights tagged in the detail line.
The most-used UI families (BuilderSans, Gotham, Roboto, SourceSansPro,
…) sort first:

```lua
FontFace = Font.fromName("|", Enum.FontWeight.Regular)
                         ^-- dropdown:
                            BuilderSans       Roblox font · 7 weights
                            Gotham            Roblox font · 6 weights
                            Roboto            Roblox font · 9 weights
                            SourceSansPro     Roblox font · 6 weights
                            …
```

The `Enum.FontWeight.` dropdown then filters to **only** the weights
the active family actually ships:

```lua
FontFace = Font.fromName("Cartoon", Enum.FontWeight.|)
                                                     ^-- Regular   (decorative font, only ships Regular)

FontFace = Font.fromName("Roboto", Enum.FontWeight.|)
                                                    ^-- Thin, ExtraLight, Light, Regular,
                                                        Medium, SemiBold, Bold, ExtraBold, Heavy
                                                        (all nine)
```

**Custom families.** Roblox supports custom font assets — register
yours via **`luix.customFonts`** and they'll surface in the same
completions, tagged *Custom font*, sorted above built-ins:

```jsonc
{
  "luix.customFonts": {
    "MyBrandSans":  ["Light", "Regular", "Medium", "Bold"],
    "MyBrandSerif": ["Regular", "Bold"]
  }
}
```

Weight names must be valid `Enum.FontWeight` members (the JSON schema
enforces this in VS Code's settings UI). If a custom family shares a
name with a built-in, the custom weight list wins.

### Snippets

Type the prefix, press `Tab`:

| Prefix | Frameworks | What it inserts |
| --- | --- | --- |
| `eFrame` / `eTextLabel` / `eTextButton` / `eImageLabel` / `eImageButton` / `eScrollingFrame` | React-Luau | `e("X", { … }, { … })` |
| `nFrame` / `nTextLabel` / `nTextButton` | Fusion | `New "X" { … }` with `[Children]` slot |
| `cFrame` / `cTextLabel` / `cTextButton` | Vide | `create "X" { … }` with inline children |
| `eUIListLayout` / `eUIGridLayout` / `eUIPadding` / `eUICorner` / `eUIStroke` | any | the corresponding utility |
| `useState` / `useEffect` / `useMemo` / `useCallback` / `useRef` | React-Luau hooks | the hook call |
| `reactEvent` | React-Luau | `[React.Event.X] = function(rbx) … end,` |
| `rfc` | React-Luau | function-component scaffold |

---

## Custom component annotations

Two forms work, and they compose:

```lua
---@extends Frame
---@prop gamepassId number
---@prop layoutOrder number?
local function GamepassCard(props): React.ReactNode
    return e("Frame", { … })
end
```

```lua
type GamepassCardProps = {
    gamepassId: number,
    layoutOrder: number?,
}

local function GamepassCard(props: GamepassCardProps)
    return New "Frame" { … }
end
```

The `---@extends` directive declares the class the component conceptually
extends — its prop list gets merged into the component's suggestions.
`---@prop` adds explicit per-component props on top. The typed parameter
form does the same thing via Luau types.

---

## Configuration

All settings live under the `luix.*` prefix. Open `Cmd+,` and search
"Luix" to see them in the UI, or write them directly into your
`settings.json`.

### Framework toggles

```jsonc
{
  // Toggle which frameworks Luix scans for.
  "luix.frameworks": ["react", "roact", "fusion", "vide"],

  // Override per-framework factory aliases (leave empty to use defaults).
  "luix.react.aliases":   [],  // defaults: ["e", "createElement", "React.createElement"]
  "luix.roact.aliases":   [],  // defaults: ["Roact.createElement"]
  "luix.fusion.aliases":  [],  // defaults: ["New", "Fusion.New"]
  "luix.vide.aliases":    []   // defaults: ["create", "vide.create"]
}
```

### Per-class prop overrides

```jsonc
{
  "luix.props": {
    // Array form — override the prop list for a class.
    "Frame": ["Size", "Position", "BackgroundColor3"],

    // Empty array disables suggestions for that class.
    "TextBox": [],

    // Custom component, flat list.
    "MyButton": ["label", "onClick", "disabled"],

    // Custom component that extends a Roblox class plus extras.
    "GamepassCard": {
      "extends": "Frame",
      "props": ["gamepassId", "layoutOrder"]
    }
  }
}
```

### Editor integrations

```jsonc
{
  "luix.documentSymbols.enabled": true,
  "luix.colorPreview.enabled":    true,
  "luix.inlayHints.enabled":      true,
  "luix.inlayHints.scope":        "ancestors",   // or "all"
  "luix.inlayHints.position":     "after-comma", // or "before-comma"
  "luix.deprecationDiagnostics":  true,
  "luix.warnReservedPropNames":   false,
  "luix.typeAwareValues":         true,
  "luix.snippetMode":             "value-with-comma"  // or "value" / "name-only"
}
```

### Auto-import (opt-in)

```jsonc
{
  "luix.autoImport.enabled": false,
  "luix.autoImport.style":   "relative",  // or "alias"
  "luix.autoImport.aliases": [
    { "filesystemPath": "src/Client/UI/Components", "robloxPath": "script.Components" }
  ]
}
```

### Background / performance

- **`luix.indexPersistence.enabled`** (default `true`) — persists the
  parsed component index across sessions; unchanged files skip
  re-parsing on cold start. No behavioral difference; speeds up
  activation on large workspaces. Disable to keep Luix offline.
- **`luix.useRobloxApiDump`** (default `false`) — fetch the
  community-maintained Mini-API-Dump once a day and *add* any new
  properties Roblox has shipped to the existing completion lists.
  Additive only — the hand-curated built-in data still wins on
  conflicts so a stale or partial fetch never breaks existing
  completions.

---

## Known limitations

- **Parsing is text-based**, not AST-based. Strings, comments, and Luau
  block structure are tracked, but pathological inputs (very unusual
  macro/codegen output, type intersections like `Frame & Foo`,
  generics like `Props<T>`) can confuse the detector.
- **Cross-file lookups are name-based.** If two files declare a
  component called `Button`, the first one scanned wins. Pin the
  intended one via `luix.props` if it matters.
- **First top-level return wins.** Components that conditionally
  return different element classes have the first one used as the
  implicit base.
- **Suggesting ≠ forwarding.** Luix shows what a component *could*
  accept; making it actually accept those props is on the
  implementation.

---

## Development

```sh
npm install
npm run compile       # one-shot
npm run watch         # rebuild on save
npm run lint
npm test              # headless VS Code with the extension loaded
npm run build-icon    # rerender assets/icon.png from assets/icon.svg
```

Press **F5** from this folder in VS Code to launch an Extension
Development Host with Luix loaded.
