# Change Log

All notable changes to **Luix** will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.5.2]

### Fusion 0.3 and StyLua-formatted calls are recognised ([#3](https://github.com/ericplane/Luix/issues/3))

Luix only understood curried element calls written with Lua's call
sugar — `New "Frame" { … }`. Two very common ways of writing the exact
same call went completely undetected, taking prop completions, hover
docs, inlay hints, colour previews, diagnostics and every refactor with
them.

**Fusion 0.3 scopes.** The constructor now takes a scope, either
threaded as a leading argument or bound to a receiver by `scoped()`:

```lua
New(scope, "Frame") { … }     -- explicit scope
scope:New "Frame" { … }       -- scoped() receiver
```

**Parenthesised calls.** The Roblox Lua Style Guide requires
parentheses when calling a function, and StyLua's default
`call_parentheses = "Always"` rewrites every sugar call to match. So a
formatted codebase never contains the sugar form at all:

```lua
New("Frame")({ … })
scope:New("Frame")({ … })
```

The two are independent, and every combination now parses. The
class-name stage accepts `"Frame"` or `(… , "Frame")`; the props stage
accepts `{ … }` or `({ … })`; and a `scope:` / `MyFusion.` receiver is
accepted in front of any alias, so a `require` bound to a local name
other than `Fusion` works too. The same widening applies to Vide's
`create("Frame")({ … })`.

Accepting a class-name completion inside a parenthesised call now
closes it the same way — `New("Frame")({ … })`, not the sugar form.

### Fusion 0.3 components read props from the right parameter

A Fusion 0.3 component takes its scope first and its props second:

```lua
local function Card(scope: Scope<typeof(Fusion)>, props: CardProps)
```

Luix treated the first parameter as the props table, so `CardProps`
never reached prop completions at call sites and the hardcoded-prop
diagnostic compared against the wrong identifier. The scope parameter is
now skipped when the second parameter exists. Detection is deliberately
narrow — the parameter's name or annotated type has to actually say
`scope` — so a component whose props parameter comes first is unaffected.

Fusion 0.3's component call convention `MyButton(scope, { … })` is
detected too, alongside the existing `MyButton { … }` and
`MyButton({ … })`.

### Fixed

- **Extract to component** and **wrap in container** failed to identify
  the framework whenever the class name was a string literal — the alias
  was derived by slicing up to the class name, which left the call's
  punctuation attached (`e("`, `New "`). Both now read the alias the
  parser already resolved.
- **Wrap in container** dropped the `scope:` receiver when rebuilding a
  Fusion 0.3 call, producing a `New` with no scope to construct into.
- A call's reported range now spans the receiver, so refactors that
  rewrite a call no longer leave a stray `scope:` behind.

## [1.5.1]

Two of Roblox's content URL schemes are painful to type by hand and
easy to get subtly wrong. 1.5.1 adds autocomplete (and validation) for
both, inside any string literal — plus a batch of fixes and new snippet
toggles from early user feedback.

### `rbxthumb://` — dynamic thumbnails with per-type valid sizes

Typing `rbxthumb://` now offers a completion per thumbnail type
(`AvatarHeadShot`, `Avatar`, `GameIcon`, `GroupIcon`, `BadgeIcon`,
`GamePass`, `Asset`, `BundleThumbnail`, `Outfit`). Picking one inserts a
complete skeleton:

```
rbxthumb://type=AvatarHeadShot&id=${userId}&w=${48|60|150}&h=…
```

The crucial part: **the `w` / `h` dropdown only offers the sizes that
type actually renders.** Each thumbnail type supports a fixed set of
square sizes (e.g. `AvatarHeadShot` → 48 / 60 / 150, `GameIcon` →
50 / 150, `Outfit` → 150 / 420) — a size Roblox doesn't support for that
type silently fails at runtime. The size is mirrored into both `w` and
`h` via a shared snippet choice, so you pick once. Sizes are the
documented/known-rendering set (corroborated against Roblox's docs and
Quenty's `RbxThumbUtils`).

Editing an existing `w=` / `h=` re-offers that type's valid sizes, and
hovering any `rbxthumb://` URL shows its type, supported sizes, and any
problems.

**Diagnostic:** hand-typed URLs with an unsupported size, an unknown
type, or a bad `filters=` value get a warning (e.g. _"AvatarHeadShot
doesn't support 200×200. Supported: 48×48, 60×60, 150×150."_). The
diagnostic only fires on clearly-wrong values, never on half-typed URLs.

### `rbxasset://` — bundled content files (official icons / textures)

Typing `rbxasset://` now completes paths to the client's bundled
content — `rbxasset://textures/ui/common/robux_color.png`, fonts,
sounds, meshes, etc. — **one folder at a time, like a file explorer**.
At `rbxasset://` you see `textures/`, `fonts/`, `sounds/`, …; accept a
folder and the next level opens automatically; at a leaf folder you get
just the file names (no full paths to memorise). Paths come from your
**local Roblox install's `content` folder**, discovered automatically:

- **Windows** — newest `%LOCALAPPDATA%\Roblox\Versions\<version>\content`
- **macOS** — `~/Library/Application Support/Roblox/Versions/<version>/content`
  or `RobloxStudio.app/Contents/Resources/content`

The folder is scanned once per session (async, cached) and filtered to
completable asset extensions (images, fonts, sounds, meshes). Point
`luix.robloxContent.path` at a specific `content` / version / `Versions`
folder to override discovery. If no install is found, `rbxasset://`
completion is silently inactive (`rbxthumb://` still works — it needs no
local files).

### Settings

- **`luix.robloxContent.enabled`** — `true` (default). Master toggle for
  both completions, the hover, and the diagnostic.
- **`luix.robloxContent.path`** — override the auto-discovered Roblox
  `content` directory used for `rbxasset://` paths.

### Added — `UIShadow` class support

Luix now knows about Roblox's new `UIShadow` (the drop-shadow UI
modifier). Inside `e("UIShadow", { … })` / `New "UIShadow" { … }` /
`create "UIShadow" { … }` / `UIShadow({ … })` you get prop completion,
type-aware value templates, hover docs, and no more "unknown property"
warnings on its props: `BlurRadius`, `Color`, `Offset`, `Spread`,
`Transparency`, `ZIndex`, `Enabled`. `UIShadow` also shows up in the
class-name picker (`e("UISh…"`) and Vide's direct-instance calls.

The type-aware templates respect `UIShadow`'s quirks — `Offset` and
`Spread` are `UDim2` (not the global `Offset: Vector2`), and
`BlurRadius` is a `UDim` — so accepting them inserts the right
constructor.

- **Element snippets** — `eUIShadow` / `nUIShadow` / `cUIShadow` /
  `rUIShadow` (React / Fusion / Vide / Roact), matching the other UI
  modifiers' snippets.
- **Hover preview** — hovering an `e("UIShadow", …)` class name renders
  an SVG of the shadow (offset, blur, spread, colour, transparency),
  alongside the existing UIPadding / UICorner / UIStroke previews.

### Added — UICorner per-corner radius support

`UICorner` gained individual per-corner radius properties
(`BottomLeftRadius`, `BottomRightRadius`, `TopLeftRadius`,
`TopRightRadius`) alongside the uniform `CornerRadius`. Three things to
go with them:

- **Conflict warning** — setting `CornerRadius` _and_ any individual
  corner radius is a mistake: `CornerRadius` overrides all four, so the
  individual ones silently do nothing. Each dead individual prop now
  gets a warning (_"`BottomLeftRadius` has no effect — `CornerRadius`
  overrides all four corners…"_). Part of the prop-validation suite
  (`luix.propValidation.enabled`).
- **Collapse suggestion** — when all four individual radii are set to
  the _same_ value and there's no `CornerRadius`, an **info-level hint**
  underlines them (like the AnchorPoint hint) with a **"Collapse to a
  single CornerRadius"** quick-fix that replaces the four lines with
  one.
- **Expand refactor** (lightbulb) — on a lone `CornerRadius`, **"Expand
  to individual corner radii"** rewrites it into the four per-corner
  props (each seeded with the original value) as a starting point for
  per-corner tweaks.
- **Hover preview** now renders **per-corner rounding** — the UICorner
  hover SVG draws each corner from its own `*Radius` prop (via an SVG
  path instead of a uniform `<rect>` corner), so a shape using only the
  individual radii no longer previews as a plain square. `CornerRadius`
  still shows uniform rounding (and overrides the individual ones).

The conflict and collapse hints stay quiet when both forms are
present — that's a mistake to fix, not a shape to convert between.

### Fixed — `Font` wrongly flagged as an "unknown property"

`Font` was intentionally left out of the text-class prop lists to nudge
users toward `FontFace` — but that made the prop-validation diagnostic
report `Font = …` on a `TextLabel` / `TextButton` / `TextBox` as
**"Unknown property `Font`"**, a false positive on valid, working code
(issue #2). Worse, the "Did you mean? `FontFace`" quick-fix broke the
code when the value was an `Enum.Font` (which `FontFace` doesn't
accept).

`Font` is now modelled as a **deprecated-but-valid** property: the
validator recognises it (no more "unknown property" error), but it
stays out of completion suggestions so `FontFace` is still what gets
suggested. A `Font` on a non-text class (e.g. `Frame`) is still
correctly flagged as unknown.

The **deprecation warning now fires for _every_ value form**, not just
`Font = Enum.Font.X` — `Font = "Gotham"`, `Font = someVariable`, etc.
all get the info-level _"`Font` is deprecated; prefer `FontFace`"_ hint
(scoped to text classes, since that's where `Font` actually exists).
The `FontFace = Font.fromName(...)` **auto-fix is offered only for the
`Enum.Font.X` form**, where the conversion is reliable — for string /
variable values it warns without a fix rather than silently swapping in
a default and discarding your value.

### Fixed — auto-imports fired even when disabled

`luix.autoImport.enabled` (default **off**) only ever gated the
diagnostic + quick-fix path. The _completion-time_ auto-import — the
`require` line that gets inserted when you accept a workspace-component
completion — never checked the setting, so it ran for everyone
regardless. Reported as _"I disabled auto imports but I'm still getting
auto import suggestions."_

Now the require insertion is gated on `luix.autoImport.enabled`. When
it's off, the component completion still appears and still inserts the
framework-correct call shape (`e(GameCard, { … })` / `GameCard { … }`) —
it just no longer adds the `require` line, and its detail no longer
says "auto-imports …".

### Added — snippet toggles

- **`luix.snippets.enabled`** (default `true`) — master switch for
  Luix's context-aware snippets (element snippets, scaffolds, event
  shorthands, state primitives, hooks, `cfangles`). Turn it off for a
  quieter completion list. Doesn't affect workspace-component or prop
  completions.
- **`luix.snippets.hooks`** (default `true`) — hide just the React hook
  snippets (`useState`, `useEffect`, `useRef`, `useMemo`,
  `useCallback`) while keeping everything else. Answers _"I can't find a
  way to disable those hook snippets."_
- **`luix.snippets.state`** (default `true`) — the cross-framework
  parallel to `luix.snippets.hooks`: hide each framework's state /
  reactivity primitive snippets (Fusion `value` / `computed` / `spring`
  / `tween` / `observer` / `for*`, Vide `source` / `derive` / `effect`
  / `cleanup` / …) while keeping everything else. Hooks are React's
  equivalent of this category, so the two toggles give every framework
  its own off-switch for "reactive snippets."

### Files

`src/robloxContent.ts` (new — data table, parser, validator,
completion / hover providers, diagnostic, content discovery + scan),
`src/uiCorner.ts` (new — expand refactor + collapse plan helper),
`src/data.ts` (deprecated-but-valid props, UICorner radius data +
conflict helper, `UIShadow` class + prop-type overrides),
`src/diagnostics.ts` (skip deprecated-valid props in the unknown-prop
check, UICorner conflict + collapse diagnostics, `Font` deprecation
broadened to all value forms), `src/codeActions.ts` (`Font` auto-fix
only for the `Enum.Font.X` form, collapse-CornerRadius quick-fix),
`src/hoverPreviews.ts` (`UIShadow` SVG preview, UICorner per-corner
rounding), `src/elementSnippets.ts` (snippet toggles, `*UIShadow`
element snippets), `src/completion.ts` (auto-import gated on the
setting), `src/extension.ts` (registration), `package.json` (new
settings, version `1.5.0 → 1.5.1`), `src/test/extension.test.ts`
(**248 passing**).

## [1.5.0]

### Active-framework detection + status-bar picker

Every Lua / Luau file now has an active framework, picked per file
in this priority order:

1. **Explicit override** — the new `luix.activeFramework` setting
   (default `auto`). Set to `react` / `roact` / `fusion` / `vide` to
   force everything everywhere.
2. **In-file `require(…)`** — first match wins, in
   `roact → vide → fusion → react` order (Roact tested first because
   its name contains "react").
3. **In-file factory call** — alias of the first
   `e(...)` / `New "..."` / `create "..."` etc. → its framework.
4. **Workspace fallback** — at activation Luix samples up to 25
   indexed files and uses the most-represented framework as the
   tie-breaker for brand-new files.
5. **None** — no UI signal → snippets and completions stay quiet
   (same gate the existing `looksLikeUIFile` policy used).

A new status-bar item on the right (`$(symbol-namespace) Luix:
Vide`) shows the current pick with a tooltip explaining where it
came from ("detected from `require(…)` import", "set by
`luix.activeFramework`", etc.). Click it to open a quickpick of
`Auto, React, Roact, Fusion, Vide`; the choice writes
`luix.activeFramework` to workspace settings. The picker is also
available via the command palette as
**`Luix: Set active framework…`**.

### Vide parens form — `Vide.create("Frame", { … })`

Vide accepts both `create "Frame" { … }` and
`create("Frame", { … })` / `Vide.create("Frame", { … })`. Until
1.5.0 Luix only recognised the curried shape — the parens form
silently fell out of every detector, so prop completions, hover
docs, and call-tree inlay hints all stopped firing inside it.

- New `recognizedCallShapes?: CallShape[]` on `FrameworkSpec`. Vide
  registers both `"parens"` and `"curried"`, so its aliases now land
  in both partition buckets.
- `getAliasPartition()` iterates `recognizedCallShapes` (defaulting
  to `[callShape]` for backward compatibility), so other frameworks
  behave exactly as before.
- `Vide.create` added to Vide's aliases.
- `findAllCreateElementCallsImpl`'s parens regex now captures the
  matched alias. When the alias is also in the curried bucket
  (Vide), the props brace doubles as the inline-children container —
  `Vide.create("Frame", { Child(...) })` parses with `Child(...)`
  as a child, not as a stray prop.

Three new tests cover the cases (`findEnclosingPropsCall`,
`findAllCreateElementCalls` nested-tree, `findEnclosingFactoryStringArg`).

Thank you to [@Zyntion]("https://github.com/Zyntion") for the idea!

### Snippet / scaffold parity across all four frameworks

With per-file gating in place, every framework gets the same
snippet matrix without polluting the dropdown for the others:

- **Roact in the scaffold quickpick** — Explorer right-click → New
  component now lists Roact alongside React / Fusion / Vide.
  Template mirrors React's but uses `Roact.createElement` and drops
  the `React.ReactNode` return annotation.
- **Element snippets** — Fusion (`n*`), Vide (`c*`), and Roact (`r*`)
  now have the same 11-snippet baseline React (`e*`) always had:
  Frame, ScrollingFrame, TextLabel, TextButton, ImageLabel,
  ImageButton, UIListLayout, UIGridLayout, UIPadding, UICorner,
  UIStroke. Bodies use each framework's idiomatic call shape and
  event syntax (`[OnEvent "Activated"]` for Fusion, plain
  `Activated = function() … end` for Vide).
- **Function-component scaffolds** — `rfc` (React), new `rofc`
  (Roact), new `nfc` (Fusion), new `vfc` (Vide). Each is gated to
  its framework — typing `rfc` in a Vide file no longer surfaces a
  React scaffold.
- **Event-handler shorthand snippets** — `reactEvent` (React),
  new `roactEvent` (Roact), new `onEvent` (Fusion), new `videEvent`
  (Vide). Each emits the right syntax for its framework — Fusion
  gets `[OnEvent "Activated"]`, Vide gets bare `Activated =
function() … end`, etc.
- **State-primitive snippets** — new for both Fusion (`value`,
  `computed`, `spring`, `tween`, `observer`, `forKeys`,
  `forValues`, `forPairs`) and Vide (`source`, `derive`, `effect`,
  `cleanup`, `untrack`, `batch`, `show`, `switch`, `indexes`,
  `values`). Each gated to its framework.

### Computed-key fast-paths for all event-bearing frameworks

The `[React.Event.X|]` / `[React.Change.X|]` autocomplete used to
be hard-coded to the React prefix. Extended to:

- **Roact** — `[Roact.Event.X|]` / `[Roact.Change.X|]` (identical
  regex shape, just the `React|Roact` alternation).
- **Fusion** — `[OnEvent "X|"]` / `[OnChange "X|"]` / `[Out "X|"]`
  (the quoted-string shape Fusion uses). Property choice lists are
  pulled from the resolved class the same way the React fast-path
  does.

The dynamic computed-key _starter_ snippets (`React.Event` /
`React.Change` choice-list entries shown inside an empty `[|]`)
now emit the right shape for the active framework:
`Roact.Event` / `Roact.Change` for Roact files,
`OnEvent` / `OnChange` / `Out` for Fusion files. Vide files don't
get any computed-key starters because events are plain prop keys
there (no `[…]` shape exists).

### Setting

- **`luix.activeFramework`** — `"auto"` (default) /
  `"react"` / `"roact"` / `"fusion"` / `"vide"`. Documented in the
  Settings UI with the full precedence ladder.

### Files changed

`src/frameworks.ts` (CallShape, recognizedCallShapes, Vide aliases,
partition logic), `src/parser.ts` (capturing alias, inline-children
on parens), `src/activeFramework.ts` (new), `src/statusBar.ts`
(new), `src/extension.ts` (status bar + picker + workspace
fallback wiring), `src/completion.ts` (per-framework fast-paths +
active-framework gating), `src/elementSnippets.ts` (per-framework
gating, 27 new element snippets, 18 new state snippets, 3 new
scaffolds, 3 new event shorthands), `src/scaffolds.ts` (Roact
template + quickpick entry), `src/test/extension.test.ts` (fork's
3 Vide-parens tests + updated VIDE_PARTITION), `package.json` (new
setting, new command, version `1.4.5 → 1.5.0`).

## [1.4.5]

### `UDim2.fromScale` ↔ `UDim2.fromOffset` conversion that resolves through the parent chain

The existing `UDim2` quick-fix can only flip forms when the value is
lossless — `UDim2.new(0.5, 0, 0.3, 0)` ↔ `UDim2.fromScale(0.5, 0.3)`,
etc. It can't help when you want to materialise
`UDim2.fromScale(1, 0.15)` as concrete pixels because that requires
knowing the _parent's_ size.

New refactor action: place the cursor on any
`UDim2.fromScale(…)` / `UDim2.fromOffset(…)` literal that's the value
of an element's `Size =` prop, hit Ctrl+. (or click the lightbulb),
and pick "**Convert to UDim2.fromOffset(…)**" (or **fromScale**). Luix
walks up the source-order parent element chain, multiplies through
each ancestor's scale until it hits a concrete pixel `Size`, and
emits the resolved value.

```lua
e("Frame", { Size = UDim2.fromOffset(800, 600) }, {
  e("Frame", { Size = UDim2.fromScale(0.5, 0.5) }, {
    e("Frame", { Size = UDim2.fromScale(1, 0.15) }), -- cursor here
  }),
})
```

→ Convert to `UDim2.fromOffset(400, 45)`. The action's title shows
the computed value so you can confirm before accepting.

Recognises **reactive `:map(...)` Sizes** when walking the parent
chain — `Size = popupScale:map(function(s) return UDim2.fromOffset(460

- s, 360 _ s) end)`is treated as a 460×360 anchor, not as
"non-literal, give up", because the coefficient comes straight out of
the inner`UDim2.fromOffset`call. Accepts the three strict
shapes for each axis:`<NUM>`, `<NUM> _ <IDENT>`, and `<IDENT> _
  <NUM>`(so`460 _ s`and`s _ 460` both work). Anything more
elaborate (`460 + bonus`, `clamp(s, 0, 1) _ 460`) skips that
  ancestor rather than guessing — same "no fallback" principle as
  below.

**No invented numbers.** When the parent chain can't be resolved
(no parent in source, every ancestor uses `fromScale` with no
`fromOffset` / `:map(fromOffset(...))` anchor, a mixed-axis
`UDim2.new(0.5, 10, …)` somewhere in the chain, or a non-literal
`Size = props.size`), the action stays _hidden_ rather than emitting
a plausible-looking-but-wrong fallback value. A missing lightbulb is
better than silently shifting your layout.

### "Calculate Size from children" — the second UDim2 action

Companion action that fires on a parent element whose `Size` is
`UDim2.fromScale(…)` (or `fromOffset(…)`) and computes the implied
pixel size from its children. Handles:

- **Children with literal `UDim2.fromOffset(W, H)` Sizes** — pooled
  according to the layout rule (see below).
- **`UIListLayout`** — `FillDirection` (Vertical / Horizontal) and
  the `Padding = UDim.new(0, N)` gap. Children are summed along the
  fill axis, max-pooled across.
- **`UIPadding`** — `Padding{Top,Bottom,Left,Right} = UDim.new(0,
N)` margins added to the pooled total.
- **Layout decorators** (`UICorner`, `UIStroke`, `UIGradient`,
  `UIFlexItem`, `UIScale`, the `UI*Constraint` family) are
  recognised and skipped — they don't take up content space.

Without a `UIListLayout`, falls back to the bounding-box rule
(`max(child.size)` on both axes), suitable for free-positioned
children. The action stays hidden when any contentful child has a
Size we can't reduce to pixels (mixed scale, a variable, a `:map(...)`
binding without a clean coefficient) — same honest-or-quiet principle
as the chain-walking action.

### Component completions now auto-import the require

Accepting a workspace-component suggestion (`DailyQuestCard`,
`StylizedButton`, …) from Luix's completion dropdown used to insert
just the identifier, leaving the file broken until the user manually
added `local DailyQuestCard = require(…)` at the top. The completion
item now carries an `additionalTextEdits` entry that inserts the
require line — at the same position the existing
`luix.autoImport` quick-fix would — whenever:

- The component lives in a different file than the current one
  (same-file definitions need no import).
- A `local <Name> = require(…)` for it isn't already present.

The import path respects `luix.autoImport.style` (relative /
alias) and the `luix.autoImport.aliases` mapping, identical to the
existing diagnostic-driven quick-fix. The item's detail line shows
the resolved path so you can see what's about to be inserted before
accepting.

### Workspace components only surface in files that look like UI code

Typing a single letter in a server script, a pure-logic module, or
anywhere else with no UI in sight used to fuzzy-match every workspace
function starting with that letter (`Pro` → `PopularGamepasses`,
`ProductRegistry.GetGamepassProduct`, …) as if they were Luix
components. Two compounding bugs:

- **`looksLikeUIFile` was too permissive** — the "file has at least
  one function" check fired on any file, since the parser indexes
  every function definition (not just component-shaped ones). A
  server-side `ProductRegistry` module with utility functions counts
  as "has functions" → falsely flagged as UI. Now relies on the
  precise signals only: an actual factory call (`e(...)`,
  `New "..."`, `create "..."`, `Roact.createElement(...)`) or a
  `require()` of a known UI framework. Files without either —
  server scripts, DataStore utilities, plain libraries — won't
  surface workspace components.
- **`knownComponentNames` didn't filter by `looksLikeComponent`** —
  the workspace index stored every function definition under its
  last-segment name, and the completion provider treated all of
  them as components. Now filtered to functions that either return
  an element call (`detectedBase` set) or carry an explicit
  `@extends ClassName` annotation, matching the rule the sidebar
  already uses.

### Suppress workspace components inside Luau `type X = …` declarations

Typing `export type Gamepass|` to write a type alias used to dump
every workspace component starting with `Gamepass` into the dropdown
(`GamepassCard`, `GamepassHero`, `GamepassInfoOverlay`, …) because
the direct-call detector treated a bare identifier with no preceding
keyword as a value-position function call. Both the type-name slot
(`export type X|`) and the RHS (`type X = MyComp|`) are now
detected as type-position and the workspace-component suggestions
are suppressed. Covers `type`, `export type`, and the (uncommon)
`local type` prefixes.

### Rect editor — X / Y now accept negative values

Roblox treats negative `ImageRectOffset` as panning the visible rect
to the right / down relative to the source texture origin — a
legitimate use case, especially when scroll-zooming out (below 100%)
to position a rect that extends past the top-left of the source. The
editor used to hard-clamp X and Y to `[0, maxRect()]`, so dragging
or arrow-stepping past the left / top edge silently snapped back to
zero. Both axes now use the symmetric range `[-maxRect(), maxRect()]`
across all four input paths: numeric field, wheel step, arrow step,
and drag + resize handles. W and H stay non-negative (Roblox doesn't
accept negative `ImageRectSize`).

## [1.4.4]

### Workspace-wide component rename (`F2`)

Pressing `F2` on a component identifier now renames the definition
**and every call site across the workspace** — including the Vide and
Fusion direct-call shapes (`MyButton({ … })`, `MyButton { … }`) that
luau-lsp's rename frequently can't see because the call isn't tied to
the function definition through types.

- **Conservative gate.** `prepareRename` only accepts identifiers
  Luix's workspace index has already classified as a component
  (functions that return an element call or carry a Luix annotation).
  Pressing `F2` on a random local variable falls back to luau-lsp.
- **Three reference shapes covered:** the `local function MyButton(…)`
  / `local MyButton = function(…)` definition, every
  `e(MyButton, …)` / `Roact.createElement(MyButton, …)` parens-form
  call site, and every direct `MyButton({ … })` / `MyButton { … }`
  curried-form call site.
- **Skipped by design:** member-access references like
  `obj:MyButton(…)` and `Module.MyButton`, and the
  `require("…/MyButton")` path basename — the path is a filename, not
  an identifier, and renaming the file is a separate workflow.
- **Refuses same-name collisions** so two definitions don't end up
  indexed under one key.

### Performance & correctness sweep

A small audit shipped a stack of perf and bug fixes that mostly
matter on big files and large workspaces:

- **Memoised the workspace component-name views**
  (`WorkspaceIndex.knownComponentNames` / `knownDirectCallTargets`) —
  previously rebuilt by walking every indexed file every time a
  provider asked for them, and 4+ providers ask per keystroke. Now
  cached and invalidated only on real cache mutations / relevant
  config changes.
- **Memoised `getAliasPartition` and `getEnabledFrameworks`** — same
  problem at a smaller scale (~34 call sites, 3–5× per completion
  invocation). Cache busts on `luix.frameworks`, the per-framework
  `*.aliases` keys, and `luix.vide.directInstanceCalls`.
- **Capped the backward brace-walk in `findEnclosingPropsCall`** at
  16 KB. With the cursor outside any table in a 50K-line file, the
  unbounded walk used to scan the full document on every keystroke for
  every provider that calls it. Also cached the compiled `RegExp`
  objects per alias-key (previously only the alias alternation
  _string_ was cached; the `RegExp` was allocated fresh each call).
- **Faster `extractPropEntries` for diagnostics / hover previews /
  rect / gradient.** Added `extractPropEntriesFromDocument(text,
start, end)` that reuses the document-level mask cache — the
  per-substring path always missed the cache, causing ~400+ redundant
  mask builds per diagnostic recompute on a busy file.
- **Replaced the per-match brace-walk in deprecation diagnostics
  with interval-containment** against a single precomputed list of
  props-table ranges. Was O(matches × document), now O(N + matches ·
  log C).
- **Deduped repeated work in
  `ReactLuauPropsCompletionProvider`** — the `[React.Event.…]`
  fast-path used to re-detect the enclosing call and re-fetch
  `getAliasPartition` + `knownDirectCallTargets` after falling
  through to the normal prop path. One setup pass now, reused.
- **`scanCache` length-pre-check + size bump** (4 → 8 entries). On
  big files the value-equality string compare was the dominant cache
  check cost; length and alias-key are checked first so misses now
  short-circuit in O(1).
- **CodeLens references — synchronous count + lazy peek.**
  `ComponentReferencesLensProvider` used to open every workspace file
  with a hit for every component, every refresh. Now it computes a
  synchronous count via `WorkspaceIndex.countCallSites`, and only
  fetches the actual locations when the user clicks the lens
  (`luix.peekComponentReferences` command). Also honours the
  `CancellationToken` VS Code passes in.
- **Fixed `sortProps.onSave` silently breaking on nested elements.**
  The previous implementation emitted one TextEdit per call's props
  body, and nested calls (the textbook UI shape — `Frame > TextLabel
  > UIPadding`) produced overlapping ranges that VS Code rejects,
aborting the whole save formatter. Now emits one edit per
outer-most call with the nested sorts spliced in via
`sortBodyRecursive`.
- **Fixed API-dump cache invalidation.** Enabling
  `luix.useRobloxApiDump` and merging new props for e.g. `Frame` used
  to leave `ScrollingFrame` / `TextLabel` / etc. with their stale
  pre-merge flattened prop lists, so descendants never saw the new
  props until reload. The merge now writes to the _source_ hierarchy
  and rebuilds the derived caches.
- **Cleared `WorkspaceIndex._persistTimer` in `dispose()`.** A
  timer armed within 5 s of window close held a closure on the cache
  and wrote to disk after the extension shut down. One-line fix.
- **Plugged `imageGutter` double-dispose.** Decoration types were
  being tracked in both the disposables list _and_
  `typesByAsset`; `clearAllDecorations` disposed via the map, then
  `dispose()` later double-disposed via the list. Now tracked only in
  the map.
- **Expanded `DiagnosticsManager`'s config-change watch list** to
  include `frameworks`, the per-framework `*.aliases` keys, and
  `vide.directInstanceCalls`. Enabling Vide at runtime now refreshes
  diagnostics on every open file instead of leaving them stale until
  the next keystroke.
- **`Luix` output channel** — wired into the asset-thumbnail fetch /
  CDN failure paths so background failures stop being silent. Open
  via _Output → Luix_.
- **Bug fix: workspace-component completions inside a props table.**
  Typing `e("Frame", { Name = "Test", eTextButt|` used to surface
  `eTextButton` as a component suggestion even though the cursor was
  at a prop-key slot. Now suppressed when the cursor is at a key
  position inside a props table, except for Vide (which allows inline
  child expressions in that position).
- **Bug fix: workspace-component completions inside string literals.**
  Typing `Text = "WEEKLY m|"` used to surface workspace components
  whose names start with `m` (`Minimap`, `MoneyDisplay`, …) even
  though the cursor was inside a string. Now suppressed by checking
  the code mask. Also patched the opt-in
  `FactoryOpenParenCompletionProvider` against the same edge case
  (`"some(` inside a string used to look like a factory call to the
  walker).
- **Bug fix: all Luix snippets used to fire inside string literals.**
  Static VS Code snippets fuzzy-match against any character in their
  prefix — typing a single `r` inside `Text = "Resets in 00:12:34 r"`
  surfaced `reactEvent`, `rfc`, and `useRef`; typing `eFra` at a
  prop-key slot inside a props table offered to expand into a full
  `e("Frame", { ... })` call. _Every_ Luix snippet —
  element constructors (`eFrame`, `nFrame`, `cFrame`, `eTextLabel`,
  …), hooks (`useState`, `useEffect`, `useRef`, `useMemo`,
  `useCallback`), `rfc`, `reactEvent`, `cfangles`, `cfanglesrad` —
  is now served by `ElementSnippetCompletionProvider` and gated:
  - **Code-mask check** suppresses every snippet inside string
    literals.
  - **Prop-key-position check** suppresses _element_ snippets at key
    slots, except when the parent framework allows inline child
    expressions (Vide). Hooks / scaffold / `reactEvent` /
    `cfangles*` skip this gate because they don't collide with
    plausible prop-name typing.
  - **Enabled-frameworks filter** — Fusion-only projects no longer
    see `eFrame` / `cFrame`, Vide-only projects don't see `eFrame` /
    `nFrame`, etc. React/Roact-style patterns (hooks, `rfc`,
    `reactEvent`) only surface when React or Roact is enabled.
    Framework-agnostic value expressions (`cfangles*`) are
    unrestricted.

  `snippets/luix.code-snippets` is now empty (kept as a placeholder
  for the manifest's `contributes.snippets` registration).

- **Bug fix: completions inside `[…]` computed-key brackets.**
  Typing `[Reac|` (to write `[React.Event.Activated]` by hand)
  surfaced workspace components like `ReactCharm` /
  `ReactErrorBoundary` / `ReactRoblox` because
  `isAtPropKeyPosition` walked back through `[` and `]`
  indiscriminately and the providers thought the cursor was at a
  fresh key slot. Worse, typing `[React.|` then surfaced Frame's
  `Archivable` / `Name` / `AutoLocalize` / etc. as if it were the
  start of a prop name in the outer table. Added a new
  `isInsideComputedKey` helper and gated three providers on it:
  - `ReactLuauPropsCompletionProvider` — bails after the
    `[React.Event.X|]` / `[React.Change.X|]` fast-path (so those
    still fire correctly) so the general prop-name path doesn't
    pollute the dropdown.
  - `FactoryComponentCompletionProvider` — no workspace components
    inside `[…]`.
  - `ElementSnippetCompletionProvider` — no `eFrame` / `reactEvent`
    / etc. inside `[…]` (the `reactEvent` snippet _expands_ to a
    `[React.Event.…] = function() … end` entry, so triggering it
    inside an existing `[…]` would have produced nested brackets).

  Also added two **dynamic computed-key starter snippets** that fire
  _only_ inside `[…]` and _only_ when React or Roact is enabled:
  - `React.Event` — expands to
    `React.Event.${1|<every event on the resolved class>|}`. The
    choice list is built from `flattenClassEvents` on the element
    Luix detects you're inside (e.g. a `TextButton` gets `Activated`,
    `MouseButton1Click`, `MouseEnter`, …; a `Frame` gets the
    `GuiObject` event set). Falls back to `GuiObject` when the class
    can't be resolved (custom component without an `@extends`).
  - `React.Change` — same shape, body is
    `React.Change.${1|<every property on the resolved class>|}`,
    so any prop you could listen to is one tab away.

  Useful when luau-lsp isn't surfacing the `React` import (it can
  miss it for various scope / cache reasons), and faster than
  hand-typing the full key.

- **Bug fix: factory class-name pickers at outer prop-key positions.**
  Typing `e("Frame", { e("Te|" })` used to surface the Roblox
  class-name picker (`Frame`, `TextLabel`, …) inside the inner
  string, even though the inner `e(...)` call sits at a prop-key
  slot of the outer table — invalid Lua. Both
  `ClassNameCompletionProvider` (the `"`-triggered picker) and the
  opt-in `FactoryOpenParenCompletionProvider` (the `(`-triggered
  picker) now walk back to the alias of the call they're suggesting
  for and, if that alias sits at a key slot of an outer props
  table whose framework doesn't allow inline child expressions
  (i.e. anything other than Vide), suppress the suggestion. Vide's
  inline-children rule still lets the picker fire inside
  `create "Frame" { e("Te|" }`.

### Accepted factory snippets add a trailing `,` when they're a list element

Accepting any of Luix's factory-call snippets — `e("Frame", …)`,
`Roact.createElement("…", …)`, `New "Frame" …`, `create "Frame" …`,
or the workspace-component shapes from this release — used to land
the closing `})` / `}` without a trailing comma, so adding a sibling
element on the next line surfaced a red squiggle until you went back
and typed `,` yourself.

Luix now appends `,$0` after the close when the call sits as a list
element of a parent table (its alias is preceded by `{` or `,`), and
leaves it off in top-level, `return`, assignment, and function-arg
positions where a trailing comma would be a Lua syntax error.

- **All call shapes covered.** Parens form (`e(...)`,
  `React.createElement(...)`, `Roact.createElement(...)`) and curried
  form (`New "..." {...}`, `create "..." {...}`) both pick up the
  trailing comma when in list context.
- **All three providers updated.** The string-literal class-name
  picker (`e("Fr|"`), the open-paren picker
  (`luix.classNameCompletion.triggerOnOpenParen`), and the
  workspace-component picker (1.4.4's React + Vide/Fusion paths) all
  share the same `isPrecededByListElementSeparator` heuristic.
- **Conservative gate.** Only fires for the textbook
  "child element inside a parent table" case. Multi-level wrapping
  (`tab = { foo = e(...) }`) falls through to no-comma, which keeps
  the snippet safe at the cost of one keystroke in rare cases.

### Workspace components no longer auto-call to `Comp(props)`

luau-lsp sees workspace components as functions with a
`(props) -> ReactNode` signature, so accepting one in the suggestion
list expanded it to a _call_ — `DailyQuestCard(props)` — which is
never the form any of the supported frameworks actually want.

Luix now contributes a parallel completion that materialises the
framework-correct shape in a single keystroke, ranked above luau-lsp's
call form so Enter does the right thing by default. luau-lsp's
suggestion still appears beneath ours so you can pick the call form
when you want it.

- **React / Roact** — fires inside the first-arg slot of a factory
  call (`e(`, `createElement(`, `React.createElement(`,
  `Roact.createElement(`). Accepting expands to
  `e(DailyQuestCard, { $1 })` and lands the cursor inside the props
  table. Existing auto-paired `)` is consumed; existing trailing
  `, { ... }` is left intact and only the identifier is inserted.
- **Vide / Fusion** — fires whenever you type a workspace-component
  identifier at a value-expression position (no factory prefix
  needed, since both frameworks invoke custom components directly).
  Accepting expands to the curried form `DailyQuestCard { $1 }`,
  which is the idiomatic shape in both. Suppressed when the next
  char is `(`, `{`, `.`, `:`, or `=` — i.e. when the identifier is
  already being extended into a call / access / assignment.
- **Strict prefix-match gate.** Items only surface when your typed
  prefix matches a component name (case-insensitively), so the
  dropdown isn't polluted with every workspace component on every
  identifier keystroke.
- **Member-access skip.** `obj.MyComp` and `self:MyComp` deliberately
  don't trigger — those are references, not component calls.

## [1.4.3]

### `Size` / `Position` completion now hands you the constructor picker

Accepting a UDim2-typed prop (`Size`, `Position`, `CanvasSize`,
`CellSize`, `TileSize`, `PageSize`, `CellPadding`) used to insert the
full `Size = UDim2.new(0, 0, 0, 0),` template with tab stops in each
channel — fine if you wanted `.new`, annoying if you wanted
`.fromScale` or `.fromOffset` (which are at least as common in modern
Vide / React-Luau code), because you had to delete and retype.

Now UDim2 follows the same pattern as `Color3`, `UDim`, and `Font`:
Luix inserts `Size = UDim2.` and immediately opens the suggest
dropdown, so you can pick `.new` / `.fromScale` / `.fromOffset` /
`.fromAxis` (or any spacing token you've defined under
`luix.spacing`). Picking a constructor still inserts its full
per-channel snippet, so the original Tab-through-each-value workflow
is preserved for the cases where you do want `.new`.

### Direct instance-call detection — `Frame({...})` etc. for Vide

Vide lets you construct built-in Roblox UI instances by calling the
class name directly — `Frame({ Size = … })`,
`TextButton({ Activated = … })`, `ScrollingFrame { CanvasSize = … }` —
instead of going through `create "Frame" { … }`. Luix now recognises
these as instance-creation sites and surfaces the matching class's
prop + event completions inside the table.

- **`luix.vide.directInstanceCalls`** (default `true`) — opt-out
  setting in case you have local variables named after Roblox UI
  classes that you call with a table for unrelated reasons. Only
  applies when Vide is in `luix.frameworks` — React-only / Roact-only
  projects are unaffected.
- **Curated allowlist.** Re-uses Luix's existing class hierarchy
  (Frame, ScrollingFrame, TextLabel, TextButton, ImageLabel,
  ImageButton, ScreenGui, BillboardGui, every `UI*` constraint /
  layout / decorator), minus the abstract bases (`Instance`,
  `GuiObject`, `GuiButton`, …). Non-UI Roblox class names (`Camera`,
  `Sound`, `Tween`, `Workspace`, …) are deliberately absent — Luix
  doesn't model them, and they're common local-variable names.
- **Events get merged just like `create "Frame" {…}`.** Direct
  instance calls are attributed to Vide downstream, so `Activated`,
  `MouseEnter`, etc. surface as suggestions on instance classes that
  have them — matching the canonical curried form.
- **Workspace components shadow built-in class names.** If you've
  defined your own `local function Frame(props)` somewhere, _that_
  component's declared props win over Roblox's `Frame`.

### Direct component-call detection for Vide / Fusion

Custom Vide and Fusion components are typically invoked directly with
a props table — `StylizedButton({ Theme = "Green", Text = "..." })` or
the curried `StylizedButton { Theme = "Green", ... }` — rather than
wrapped in a factory call. Luix's parser previously only recognised
the alias-prefixed forms (`e(Comp, { … })`, `create "Frame" { … }`,
`New "Frame" { … }`), so prop completions, hover docs, anchor presets,
and prop-validation diagnostics all silently bailed inside the props
table of a direct component call. luau-lsp's word-based suggestions
then filled the gap with unrelated identifiers (`TextLabel`,
`TextService`, etc.).

- **`findEnclosingPropsCall` now accepts a `directComponents` set.**
  When the cursor is in a `{ … }` table preceded by `<Identifier>(`
  or `<Identifier> ` and the identifier appears in that set, the call
  is treated as a direct component call. The result carries a new
  `isDirectComponentCall: true` flag so callers can branch (e.g.
  skip merging built-in-instance events).
- **`WorkspaceIndex.knownComponentNames()`** exposes a synchronous
  snapshot of every component the index has seen, which is what the
  completion / hover / anchor-preset / diagnostics paths now pass in.
  The set is the entire safety gate — without it the curried regex
  would match every `f { … }` table-call in the language.
- **Method calls and qualified accesses stay quiet.**
  `obj:Card({ … })` and `Mod.Card({ … })` are deliberately excluded
  via the leading char-class so non-UI code can't accidentally
  trigger prop completions.
- **Framework-mediated calls take precedence.** The existing
  parens / curried alias paths run first; the direct-call detection is
  a strict fallback. Mixing styles in one file (`e("Frame", { …
StylizedButton({ … }) … })`) keeps each call's framework attribution
  intact.

9 unit tests added (`Direct component-call detection` suite) covering
the happy path, the safety cases (unknown identifier, no-set
back-compat, method calls, qualified accesses), and the
mixed-framework nesting case.

## [1.4.2]

### Asset thumbnail hover / gutter — false "moderated" after edits

Changing an `rbxassetid://…` value (or hovering one Roblox has just
started thumbnailing) often showed _"Thumbnail unavailable (asset may
be moderated, deleted, or the API is unreachable)"_ for a full minute,
even when the asset was fine — only a window reload would clear it.

- **Stop caching transient API states.** Roblox's thumbnails API
  returns `Pending` / `InReview` while it's still generating the
  image (typical for freshly-referenced assets), and
  `Error` / `TemporarilyUnavailable` during backend hiccups. The
  previous implementation only treated `Completed` as success and
  cached every other state — transient or not — as a failure for
  60 seconds. Now transient states bypass the cache entirely so the
  next hover or gutter refresh retries against the (usually
  now-Completed) response.
- **10 s settled-failure TTL** (was 60 s). Even when a fetch
  genuinely fails — typo'd ID, network blip — fixing it gets a fresh
  fetch on the next interaction instead of stranding the user behind
  a minute-long cache.
- **State-aware hover message.** Instead of always saying _"asset
  may be moderated, deleted, or the API is unreachable"_, the hover
  now reflects the actual API state: _"Roblox is still generating
  the thumbnail — hover again in a few seconds"_ for Pending /
  InReview, _"temporarily unavailable"_ for Error /
  TemporarilyUnavailable, _"asset has been moderated or removed"_
  for Blocked / Moderated.

## [1.4.1]

### Regenerate Wally types — Windows PowerShell + Defender fix

The **Regenerate Wally types** button (and the
`luix.wally.regenerateTypes` command) chained its three steps with
`&&`, which Windows PowerShell 5.1 — the default shell on Windows —
rejects as an invalid statement separator, so the command failed
before `wally install` even started.

- **Shell-aware chaining.** On Windows PowerShell 5.1 the chain
  is now emitted as `cmd1; if ($?) { cmd2; … }`. PowerShell 7+,
  cmd.exe, and POSIX shells continue to use `&&`.
- **300 → 1500 ms breather between `wally install` and
  `rojo sourcemap`.** Windows Defender briefly locks the freshly
  written `Packages/*.lua` link files for real-time scanning. Without
  a pause, rojo's sourcemap silently misses them and
  `wally-package-types` then reports `Linker node 'Packages/X.lua'
not found in sourcemap` for every top-level package. The delay is
  emitted in the active shell's syntax (`Start-Sleep` /
  `timeout /nobreak` / `sleep`).

## [1.4.0]

This release adds three full-fledged visual editors (gradient,
sprite-rect, plus four hover previews), a new diagnostic, and a
sort-props action. Editors are marked **Preview** in the UI so
users know they're still being polished.

### Gradient editor (`luix.gradient.*`)

A single **Edit UIGradient** CodeLens above every
`e("UIGradient", { … })` element opens a combined side-panel editor
with Color, Transparency, and Rotation. Standalone
`ColorSequence.new(...)` and `NumberSequence.new(...)` literals (not
inside a UIGradient) get a focused per-literal editor instead.

- **Colour ramp** — drag triangle stops, click the strip to add,
  per-stop colour picker, hover-indicator pill showing the offset.
- **Transparency curve** — grid canvas with draggable circle stops
  (X = time, Y = value), envelope shading when non-zero.
- **Rotation slider** — −180° to 180°, slider + numeric input.
- **Preview square** — combines colour + transparency + rotation
  and multiplies by the parent element's `BackgroundColor3`
  (Roblox's `UIGradient` semantics), so what you see matches what
  Roblox renders.
- **Output respects `luix.color3.defaultFormat`** for `fromRGB` /
  `fromHex` / `new`. Default `Color = ColorSequence.new(white)`,
  `Transparency = NumberSequence.new(0)`, and `Rotation = 0` are
  _omitted_ from the written-back props block — no noise.
- **Hover previews** — `ColorSequence` shows the gradient strip,
  `NumberSequence` shows the value curve. Toggles:
  `luix.gradient.codeLensEnabled` (on),
  `luix.gradient.previewOnHover` (on).
- **Polish** — `Shift` snaps drag/click to 0.05, hover indicator
  on strip and curve, scroll-wheel + arrow stepping on numeric
  fields, decimal input always renders `.` regardless of locale,
  blur-revert on invalid input.

### Rect editor (`luix.rectEditor.*`)

An **Edit sprite rect** CodeLens appears above every
`e("ImageLabel" | "ImageButton", { … })` whose `Image` prop is a
literal `rbxassetid://…`. Opens a side-panel editor:

- Thumbnail fetched from `thumbnails.roblox.com` at the largest
  available size, with a fallback ladder (768 → 512 → 420 → 256 → 150).
- Draggable rectangle with 8 resize handles; dimmed mask shows
  what gets cropped.
- X / Y / W / H number fields with `Shift` = 10× step.
- **Aspect-ratio auto-detect** — reads a sibling
  `UIAspectRatioConstraint` or a fixed-pixel `Size = UDim2.fromOffset(…)`
  and pre-fills the **Frame aspect** input.
- **Crop preview overlay** — a dashed yellow box inside the
  selection showing exactly what `ScaleType.Crop` will actually
  render given the frame aspect. Hidden for other ScaleTypes.
- **Native dimension auto-detect via Open Cloud** — when
  `luix.openCloud.apiKey` is set (key needs the `legacy-asset:manage`
  permission), the editor hits
  `apis.roblox.com/asset-delivery-api/v1/assetId/{id}`, downloads the
  returned CDN location, and reads the PNG/JPEG header to extract the
  true pixel dimensions. One call per asset, ever — results are
  persisted to `globalState`.
- **Source dimensions fallback** — without an API key (or if the
  lookup fails) the editor uses the thumbnail's natural size and lets
  you type `Source W` / `Source H` manually. Manual values are also
  cached per asset, so the typing cost is one-time.
- **Scroll-to-zoom** — wheel on the canvas zooms (15% – 300%),
  with a discoverable **🔍 zoom bar** (− / % / +) in the corner.
- **Rect can exceed source dimensions** — W and H accept up to 4×
  source; the rect can be dragged past the image edge. Overflow is
  signalled with a dashed amber border.
- **Stripped on the "full image" default** — `ImageRectOffset = (0,0)`
  and `ImageRectSize = (0,0)` are omitted on Apply.

### Unused-prop diagnostic (`luix.unusedProps.enabled`, on by default)

Props declared in a component's parameter type
(`props: { Foo: …, Bar: … }`) or its `@luix-props` annotation that
are never read in the body are flagged with the unused-declaration
grey-out style (`Hint` severity, `Unnecessary` tag — same treatment
TypeScript uses for unused locals).

Skipped automatically when the body forwards `props` wholesale
(`e(Base, props)`, `for k, v in props do`, computed-key indexing)
since static analysis can't determine downstream usage. Squiggle
lands on the field name inside the type annotation when possible,
otherwise on the function definition line.

### Visual hover previews (`luix.hoverPreviews.enabled`, on by default)

Inline SVG previews rendered straight from your literal values —
no network requests, no caching:

- **`TweenInfo.new(...)`** — 240×140 graph of the easing curve.
  All 12 `EasingStyle` × 4 `EasingDirection` combinations are
  implemented as math functions. Below the curve: duration,
  repeat-count, reverses, and delay summary.
- **`e("UIPadding", { … })`** — box visualisation with the inner
  content area indented by the configured `PaddingTop` / `Right` /
  `Bottom` / `Left`. Each non-zero side gets its pixel value labeled.
- **`e("UICorner", { … })`** — rounded rectangle rendered at the
  configured `CornerRadius`.
- **`e("UIStroke", { … })`** — sample box with the stroke applied
  at the configured `Thickness` / `Color` / `Transparency`.

### Sort props by category (`luix.sortProps.*`)

- **Code action** — Right-click anywhere inside a props table → 💡
  **Sort props by category**. Reorders props by category (then by
  canonical order within each category, stable on ties).
- **Format-on-save** — `luix.sortProps.onSave` (default `false`).
  When enabled, every props table in the document is sorted on
  save. Off by default so saving a teammate's file doesn't
  reshape their layout.
- **Configurable order** — `luix.sortProps.categoryOrder` (string
  array) lets you reorder _or remove_ categories. Defaults:
  Identification → Layout → Style → Visibility → Image → Text →
  Behavior → Events → Refs → Children → Other.
- **Computed-key aware** — captures `[React.Event.Activated]`,
  `[OnEvent "…"]`, `[Children]`, etc. Vide-style plain identifier
  events (`Activated = function() … end`) are recognised too.
- **Comment-safe** — tables containing `--` comments are skipped
  so comments never get detached. Idempotent: re-sorting a sorted
  table is a no-op (no spurious save edits).

### Per-class prop type overrides

Some Roblox prop names mean different things on different classes
(e.g. `Frame.Style → Enum.FrameStyle`, but
`GuiButton.Style → Enum.ButtonStyle`). 1.3.0's global `PROP_TYPES`
map could only hold one value per prop name and silently picked
the wrong enum on Frame.

New `PROP_TYPE_OVERRIDES` map keyed by class, plus a
`getPropType(className, propName)` helper that walks the class
hierarchy. The hover tooltip, completion value-snippet, and the
wrong-enum diagnostic now all resolve `Style` (and any future
conflicts) per-class. Adding more is a one-line entry per class.

### Wrap-in code action — fixes (regressions from 1.3.0)

- **Multi-element selection** — selecting `UIPadding + TextLabel`
  now wraps _those two siblings_ in a new container, instead of
  wrapping their parent `Frame` (the previous behaviour found the
  smallest call containing the selection, which is always the
  parent for multi-element selections).
- **Indentation** — wrapped lines no longer get double-indented.
  The previous `indentLines(text, baseIndent + step)` prepended
  both the base AND the new step to lines that already had their
  original indent baked in, producing 4-tab-deep `Name = …` etc.

### Expanded class & prop catalogue ([src/data.ts](src/data.ts))

Built-in `classHierarchy` and `PROP_TYPES` significantly expanded
to track newer Roblox additions and previously-missing props:

- **GuiBase2d** — `RootLocalizationTable`, `SelectionBehaviorDown/Left/Right/Up`, `SelectionGroup`, `SelectionChanged` event.
- **GuiObject** — `InputSink`, `NextSelection*`, `SelectionImageObject`.
- **GuiButton** — `HoverHapticEffect`, `PressHapticEffect`, `Style`.
- **Frame** — `Style`.
- **VideoFrame** — `MaximumResolution`, `RollOffMaxDistance/MinDistance/Mode`.
- **TextLabel / TextButton** — `OpenTypeFeatures`.
- **TextBox** — re-rooted under `GuiObject` (was `TextLabel`) to
  match Roblox's actual hierarchy; full text-prop set mirrored.
- **BillboardGui** — `Adornee`, `ResetOnSpawn`, `TabKeyboardNavigation`.
- **SurfaceGui** — `Active`, `TabKeyboardNavigation`.
- **ScreenGui** — `TabKeyboardNavigation`.
- **UIStroke** — `BorderOffset`, `BorderStrokePosition`, `StrokeSizingMode`, `ZIndex`.
- **Instance** — `Archivable`.
- And 40+ new `PROP_TYPES` entries for the above, covering
  `Rect`, `Camera`, `Player`, `LocalizationTable`, plus several
  new enum types (`BorderStrokePosition`, `HapticEffect`,
  `InputSink`, `NormalId`, `RollOffMode`, `SelectionBehavior`,
  `StrokeSizingMode`, `VideoSampleSize`).

## [1.3.0]

### New diagnostics (gated by `luix.propValidation.enabled`, on by default)

- **Numeric-range warnings** — `Transparency = 1.5`, `Rotation = 720`,
  `BorderSizePixel = 100`, etc. Per-prop bounds.
- **TextScaled gotcha** — `TextScaled = true` with a pure-scale `Size`
  (or no `Size`) collapses text to zero — now flagged with a fix
  recommendation.

### Color contrast warnings (off by default)

`luix.contrastWarnings.enabled` — flags any `TextColor3` whose
WCAG-AA contrast ratio against the nearest ancestor's
`BackgroundColor3` falls below 4.5:1. Both colors must be literal
Color3 expressions; reactive Fusion/Vide values are skipped.

### Design tokens beyond color

Mirror of `luix.palette` for two more types:

- **`luix.spacing`** — type `UDim.` to surface entries like
  `spacing.md` → `UDim.new(0, 16)`.
- **`luix.fonts`** — type `Font.` to surface entries like
  `fonts.display` → `Font.fromName("Gotham", Enum.FontWeight.Bold)`.

Empty by default; opt-in via user config.

### Color3 → palette extractor

Cursor on any Color3 literal → 💡 _Save Color3 to `luix.palette`…_ —
prompts for a token name and a target (User / Workspace settings).
The literal is added to `luix.palette` so it surfaces in future
`Color3.` completions.

### Frame-stats CodeLens (off by default)

`luix.frameStatsLens.enabled` — `▸ Frame — 24 descendants, 4 layers
deep` above every meaty subtree. `luix.frameStatsLens.minDescendants`
(default `5`) controls the threshold.

### Workspace-wide validation summary (off by default)

`luix.workspaceValidation.enabled` — the Luix sidebar shows
_"Project diagnostics — N warnings · M errors across X files"_.
Click jumps to the Problems panel. Aggregates Luix + every other
publisher's diagnostics.

### Class picker on `(` (off by default)

`luix.classNameCompletion.triggerOnOpenParen` — typing `e(` (without
a quote) opens the class picker; accepting inserts the full
`"ClassName", { … })` body. Off by default because `(` is a broad
trigger; on saves one keystroke per element when enabled.

### CFrame.Angles snippets

`cfangles` → `CFrame.Angles(math.rad(…), math.rad(…), math.rad(…))`
`cfanglesrad` → `CFrame.Angles(…, …, …)` (radians form)

### Background — workspace index persistence (on by default)

`luix.indexPersistence.enabled` — the parsed component index is now
saved to disk between sessions; unchanged files skip re-parsing on
cold start. Speeds up activation on large workspaces with no
behavioral difference. Disable to keep Luix offline.

### Background — opt-in Roblox API-dump augmentation

`luix.useRobloxApiDump` — fetch the community-maintained
Mini-API-Dump JSON once a day and _add_ any new properties Roblox has
shipped to existing classes' completion lists. Additive only — the
hand-curated built-in data still wins on conflicts.

### Roblox font family + weight autocomplete

- Inside `Font.fromName("…")`, the family dropdown surfaces 36
  built-in Roblox families with their supported weights. Popular UI
  families (BuilderSans, Gotham, Roboto, SourceSansPro, …) sort first.
- After `Enum.FontWeight.` inside a `Font.fromName(...)` call, the
  weight dropdown shows ONLY the weights the family actually ships.
  `Font.fromName("Cartoon", Enum.FontWeight.|)` lists just `Regular`;
  `Font.fromName("Roboto", Enum.FontWeight.|)` lists all nine.
- **`luix.customFonts`** lets you register custom font families and
  their supported weights — they merge into the same completions,
  surface above built-ins, and weight-filter the same way.

### `Font` (deprecated) removed from TextLabel / TextButton / TextBox

These classes no longer suggest the deprecated `Font` property —
only `FontFace` shows up in the completion list. The existing
deprecation diagnostic still catches anyone who writes
`Font = Enum.Font.X` and offers the _Replace with `FontFace = …`_
quick-fix.

### Smarter value completion for Color3 / UDim / Font props

Accepting `BackgroundColor3` / `TextColor3` / `Padding` / `FontFace`
now inserts a `Color3.` / `UDim.` / `Font.` prefix and auto-opens
the suggest dropdown. The dropdown lists:

- **Built-in constructors** first — `fromRGB`, `fromHex`, `new`,
  `fromHSV` (for Color3); `new` (for UDim); `fromName`, `fromId` (for
  Font). Picking one inserts the full call with per-channel tab stops
  preserved.
- **Tokens defined in your settings** below — `palette.primary`,
  `spacing.md`, `fonts.display`, … swap the prefix for the literal
  expression.

Type `f` to filter to constructors; type `p` (or `s` / `fonts`) to
filter to tokens.

### RichText `<font>` / `<stroke>` / `<mark>` — no more presumptuous defaults

Accepting one of these tags now leaves the attribute slot empty and
parks the cursor inside the tag. Type any letter and the attribute
completion fires — pick `color`, `size`, `weight`, etc. and the
value-with-quote pair fills in. Previously the snippet always
pre-filled `color="…"` regardless of intent.

### Other improvements

- Prop completion no longer doubles trailing commas: typing `Bac,`
  then accepting `BackgroundColor3` produces a single trailing comma
  with the cursor after it, regardless of the existing `,`.
- Prop / anchor-preset completions are now gated to _key_ position —
  typing `FontFace = Font.|` no longer surfaces `BackgroundColor3` /
  `anchor:c` / etc. alongside the font constructors.
- All settings now live under the `luix.*` prefix. The silent
  fallback to legacy `reactLuauPropsHelper.*` keys has been removed
  because VS Code's `inspect()` could mistake a user-set `{}` (equal
  to the default) for "not set" and quietly pick up the old keys.
  Anyone with stale `reactLuauPropsHelper.*` entries needs to rename
  them to `luix.*` (the format is identical).
- All user-visible strings, diagnostic codes, and the diagnostic
  collection have been re-branded from `react-luau-props-helper` to
  `luix` so the Problems panel and hover tooltips show the right
  source.
- `.vscodeignore` extended to exclude `devforum-post/`, design SVG /
  PNG drafts, `PUBLISHING.md`, lockfile, and tooling configs.
  Marketplace package size stays under ~135 KB.

## [1.2.0]

### Anchor preset completion

Inside any props table, type `anchor:` and pick one of nine presets —
`tl`, `t`, `tr`, `l`, `c`, `r`, `bl`, `b`, `br`. Accepting `anchor:br`
expands to:

```lua
AnchorPoint = Vector2.new(1, 1),
Position = UDim2.fromScale(1, 1),
```

Kills the constant AnchorPoint mental math.

### AnchorPoint auto-detect

When `Position` uses `UDim2.fromScale(0.5, …)` / `UDim2.new(1, 0, 1, 0)`
/ similar _without_ a matching `AnchorPoint`, you get an Information-
level diagnostic with a _Add `AnchorPoint = Vector2.new(0.5, 0.5)`_
quick-fix that inserts the correct AnchorPoint at the right indentation.

### Wrap-in code actions

Cursor in any element call → lightbulb offers _Wrap in Frame_ / _Wrap
in ScrollingFrame_ / _Wrap in Frame + UIListLayout_. Framework-aware —
parens form for React/Roact, curried form (with `[Children] = { … }`)
for Fusion, inline children for Vide.

### UDim2 form conversion

Mirror of the Color3 convert action — cursor on any
`UDim2.new(…)` / `UDim2.fromOffset(…)` / `UDim2.fromScale(…)` →
lightbulb offers conversions between the three forms, but only when
the value is actually expressible in the target form (e.g. only offers
`fromOffset` if all scales are 0).

### Image-asset thumbnail in hover

Hover any string of the form `"rbxassetid://NNNN"` (Image prop, Icon
prop, anywhere) to see the actual asset image fetched from Roblox's
CDN via `thumbnails.roblox.com`. Cached per session. Catches "did I
paste the right ID?" bugs before you reload Studio.

### Image-asset gutter previews (opt-in)

Every `"rbxassetid://NNNN"` reference can also get a tiny thumbnail in
the gutter next to its line. Downloads once per asset and persists so
reopens are instant.

- **`luix.imageGutter.enabled`** (default `false`) — toggle the
  feature. The hover preview always works either way.
- **`luix.imageGutter.cacheLocation`** (default `"global"`) — either
  VS Code's extension storage or `.luix/assetThumbs/` inside the
  workspace (with `.luix/.gitignore` auto-written).
- The Luix sidebar shows a one-click **Enable image gutter previews**
  entry while the feature is off so it stays discoverable.
- Once enabled, sidebar surfaces **Purge image preview cache**
  (`N assets — X MB` readout) and **Open image cache folder**.
- Purge wipes both global and workspace cache locations so flipping
  `cacheLocation` mid-project never strands stale files.

### Extract-to-component refactor

Right-click any element call → **Luix: Extract to component…** Prompts
for a name, writes a new `.luau` file alongside the source with just
the imports the extracted code actually uses, and rewrites the call
site to invoke the new component. Imports are pulled transitively so
common patterns like `local e = React.createElement` correctly bring
`React` along too. Framework-aware — emits `e(NewComp, {})` for
React/Roact and `NewComp {}` for Fusion/Vide (which compose components
by direct call rather than via the `New`/`create` keyword).

### Custom-component hover

Hovering the class slot of `e(MyButton, …)` / `New "MyButton" {…}` /
`create "MyButton" {…}` surfaces a tooltip with the component's
inferred props, base class, and `---@extends` chain. Hovering a prop
key inside the call shows whether the prop is component-defined or
forwarded from the base class.

### Color3 picker now recognizes `fromHex` and `fromHSV`

The color swatch + picker fires on all four Color3 constructors —
`fromRGB`, `new`, `fromHex`, `fromHSV`. The picker presentation order
puts your existing notation first so editing visually never silently
flips your codebase from hex to RGB or vice versa.

### Convert Color3 between formats

Cursor on any Color3 literal → lightbulb offers _Convert to
`Color3.fromRGB(...)` / `fromHex(...)` / `new(...)` / `fromHSV(...)`_.
Resolves the actual color and rewrites the constructor.

### Reference CodeLens

Every component definition gets a `▸ N references` CodeLens above it.
Click to peek every workspace call site of `e(MyButton, …)`. Toggle
via **`luix.componentReferencesLens.enabled`**.

## [1.1.1]

### RichText color picker

VS Code's inline color swatch + picker now fires on
`color="#FF0000"` and `color="rgb(255, 0, 0)"` values inside `<font>`,
`<stroke>`, and `<mark>` tags — both forms parse, and editing via the
picker preserves whichever form you originally wrote (no surprise
hex↔rgb conversions). Gated by the new **`luix.richText.colorPicker`**
(default `true`) so users who disable Luix's Color3 picker
(`luix.colorPreview.enabled`) for extension-conflict reasons can still
keep the RichText one.

### Format settings for default color placeholders

- **`luix.color3.defaultFormat`** (default `"fromRGB"`) — pick the
  constructor Luix inserts when accepting a `BackgroundColor3` /
  `TextColor3` / etc. completion. Enum: `fromRGB`, `fromHex`, `new`,
  `fromHSV`.
- **`luix.richText.defaultColorFormat`** (default `"hex"`) — controls
  the `<font color="…">` / `<stroke color="…">` / `<mark color="…">`
  placeholder form. Enum: `hex`, `rgb`.

Two separate settings because Color3 has four constructors while
RichText only supports two formats.

### Missing-RichText warning

If a props table sets `Text = "…<font…>…"` (or any other RichText tag)
but doesn't also set `RichText = true`, Roblox renders the tags as
literal characters. Luix now flags this with a Warning on the `Text`
key and offers a _Set `RichText = true`_ quick-fix that inserts the
line right above. Only fires on string-literal Text values — `Text =
someVar` stays silent because we can't see inside.

## [1.1.0]

### RichText tag completion + auto-close

Typing `<` inside a single-line string surfaces Roblox's RichText tags
(`<b>`, `<i>`, `<u>`, `<s>`, `<sc>`, `<smallcaps>`, `<uppercase>`,
`<sub>`, `<sup>`, `<comment>`, `<br/>`, `<font …>`, `<stroke …>`,
`<mark …>`). The accepted snippet includes the matching close tag with
the cursor placed inside, so picking `<font>` gives you
`<font color="…">|</font>` in one keystroke.

Inside an open `<font …>`, `<stroke …>`, or `<mark …>`, attribute-name
completion fires so multiple attributes can be combined the way Roblox
allows — `<font color="#FF0000" size="18" weight="Bold">`. Picking
`<font>` parks a tab stop right before the `>` so the user can type a
space, get the next attribute suggested, and chain as many as needed
before tabbing into the tag body.

Finishing an opening tag manually — typing the `>` of `<font size="18">`
— inserts the matching `</font>` after the cursor. Triggers only for
known RichText tag names, so unrelated `<` / `>` in code are left alone.

Inner attribute quotes adapt to the outer Lua string's quote
(`Text = "<font color='#FF0000'>..."`,
`Text = '<font color="#FF0000">...'`, or Luau backtick template strings
`` Text = `<font color="#FF0000">...` ``) so attribute values never need
backslash escaping.

Gated by **`luix.richText.enabled`** (default `true`).

### Prop validation diagnostics

Four new bug-catching diagnostics under a single
**`luix.propValidation.enabled`** flag (default `true`):

- **Unknown property** on a known Roblox class — `e("Frame", {
ScrollingDirection = … })` warns "Unknown property `ScrollingDirection`
  on `Frame`. Did you mean `Position`?" with a _Rename to `Position`_
  quick-fix.
- **Duplicate key** in the same props table — `Size = …, Size = …`
  warns that the second assignment silently overwrites the first.
- **Wrong enum type** — `BorderMode = Enum.Font.X` warns because
  `BorderMode` expects `Enum.BorderMode`.
- **Overridden by component** — when a custom component's root element
  hardcodes a prop (`Position = UDim2.new(0,0,0,0)` rather than
  `Position = props.Position`), passing that same prop at the call site
  surfaces an Information-level "won't be overridden" hint. Detection
  is purely textual on the component's `props` parameter, so the hint
  errs on the side of silence — only flags clear cases where the root
  element makes no reference to `props` for that key.

### Roblox private-use-area glyph support

Roblox's icon set (Robux `U+E002`, Premium `U+E001`, Verified `U+E000`,
Roblox Plus `U+E003`) lives in the Unicode private-use area, which means
VS Code's default fonts render them as `[]` boxes. Luix now:

- Annotates each occurrence with an inlay-hint label so you can tell
  which glyph is which while reading code.
- Provides a hover with the name, codepoint, and Luau `\u{…}` escape.
- Lets you insert the literal glyph from inside a string by typing
  `:robux:`, `:premium:`, `:verified:`, or `:roblox-plus:`.

Gated by **`luix.robloxGlyphs.enabled`** (default `true`).

User-defined shortcuts go in **`luix.robloxGlyphs.custom`** (empty by
default) — a `slug → string` map. Example: setting `{ "gbp": "£" }`
makes `:gbp:` insert `£` from inside a string. Useful for any character
your keyboard can't reach. Built-in slugs can't be shadowed.

### Class-name completion in factory calls

Typing `e("Fr|"`, `Roact.createElement("Fr|"`, `New "Fr|"`,
`create "Fr|"`, or the Luau backtick form ``e(`Fr|`)`` now surfaces
Roblox class names. Accepting inserts the class name _and_, if the call
doesn't already have a props table, adds the `, { … }` block with the
cursor placed inside. Works for all four enabled frameworks.

### Misc

- Props completion now also opens on `{` so common props (`Name`,
  `Size`, …) appear the instant you type the props brace.
- Ships a `configurationDefaults` setting that turns on
  `editor.quickSuggestions.strings` for `lua` / `luau` files, so
  class-name and RichText suggestions filter live as you type inside a
  string literal.
- The legacy `reactLuauPropsHelper.*` migration notification that fired
  every VS Code startup has been removed. Legacy keys are still read as
  a silent fallback so nothing breaks, but the prompt is gone. The
  matching `luix.suppressLegacySettingsWarning` setting has been removed
  too — if you had it set, you can delete the orphaned line from your
  `settings.json`.
- `npm run package` produces the `.vsix`.

## [1.0.0]

Initial release.

### Multi-framework prop completion

- **React-Luau** — `e("Frame", { … })`, `React.createElement(...)`.
- **Roact** — `Roact.createElement("Frame", { … })`.
- **Fusion** — `New "Frame" { … }`, `Fusion.New "Frame" { … }`.
- **Vide** — `create "Frame" { … }`, `vide.create "Frame" { … }`.

For each, Luix offers context-aware property completion with type-aware
value snippets (`BackgroundColor3 = Color3.fromRGB(255, 255, 255),` and
similar for `UDim2`, `Vector2`, `Font`, booleans, enums, …).

### In-file & cross-file inference for custom components

Components defined as `local function MyCard(props) … end` get prop
suggestions inferred from four signals:

1. **Auto-detection** from the return statement (`return e("Frame", …)`,
   `return New "Frame" { … }`, etc).
2. **`---@extends ClassName` and `---@prop NAME [type]` annotations**
   above the function definition.
3. **Typed `props` parameter** — inline literal type or same-file `type`
   alias.
4. **`luix.props`** central config for components that live outside the
   workspace or need a global override.

The workspace is indexed at activation and kept fresh via the file
watcher and live document-change events, so the lookup works whether
you're editing the component itself or a file that `require`s it.

### Sidebar (Activity Bar)

- **Workspace view** — one-click access to the chores every Roblox UI
  dev runs constantly:
  - Regenerate Wally types (runs `wally install` → `rojo sourcemap` →
    `wally-package-types` as a chained command in a reusable named
    terminal). Visible when `wally.toml` is detected.
  - `wally install`.
  - Generate Rojo sourcemap. Visible when a `*.project.json` is
    detected.
  - New component scaffolds: React, Fusion, or Vide. Prompts for a
    name, writes the file next to the active editor, opens it.
- **Components view** — every component the workspace indexes,
  alphabetised. Each row shows the source file and the class it extends.
  Click to jump straight to the definition.

### Color palette

- New setting `luix.palette` — define named project colors. They
  appear as completions when you type `Color3.`. Accepting one replaces
  the prefix with the full configured `Color3.fromRGB(...)` expression,
  so you get design-token consistency without sacrificing greppability.

### Editor integrations

- **Outline + breadcrumbs** that mirror the React tree of the current
  document.
- **Inlay hints** at the closing `})` / `}` of every multi-line element,
  showing the class name (and `Name` prop when present). Defaults to
  "ancestors-only" mode so the file stays clean; the labels surface only
  on the chain containing the cursor.
- **Color preview.** `Color3.fromRGB(...)` and `Color3.new(...)` get a
  swatch in the gutter plus VS Code's color picker.
- **Hover docs.** Hovering any prop inside an element table shows the
  type, the class it's introduced on, and a deep link to the Roblox
  reference page.
- **`[React.Event.X]` / `[React.Change.X]` completion.** Inside event
  bracket syntax, the suggestion list switches to the available events
  / observable properties for the enclosing class.
- **Annotation completion** for `---@extends ` (class names) and
  `---@prop NAME ` (Roblox/Luau types).
- **Snippet library** — `eFrame` / `nFrame` / `cFrame` (React / Fusion
  / Vide), `eTextLabel` / `nTextLabel` / `cTextLabel`, button variants,
  `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `rfc`
  (function component scaffold), and more.

### Diagnostics + quick fixes

- **Deprecation warnings** (default on): `Font = Enum.Font.X` → `FontFace
= Font.fromName(...)` quick-fix; `TextColor = …` → rename to
  `TextColor3`. Toggle with `luix.deprecationDiagnostics`.
- **Reserved-name warning** (opt-in via `luix.warnReservedPropNames`):
  flags `---@prop` declarations that shadow a property of the declared
  base class.
- **Auto-import** (opt-in via `luix.autoImport.enabled`): for
  `e(MyComponent, { … })` where the component is in the workspace but
  not yet `require`d locally, surface an Information diagnostic with a
  one-click quick-fix that inserts the require line. Two path styles:
  `relative` (`script.Parent…X` chain) and `alias` (configurable
  filesystem → Roblox prefix mappings).

### Performance

All hot pure functions (mask + masked text, `findAllCreateElementCalls`,
`scanDocument`, `buildAliasAlternation`) are memoised with small LRU
caches so a single keystroke causes at most one parse pass across all
providers. The class hierarchy is flattened lazily and the result cached
permanently.

### Configuration

Toggle frameworks with `luix.frameworks` (default: all). Override
factory aliases per-framework via `luix.<framework>.aliases` for
codebases that locally alias the factory (e.g. `local n = Fusion.New`).
Inlay hint scope, position, and per-provider toggles are all
configurable; see the settings UI under "Luix".
