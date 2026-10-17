# Changelog

## 1.5.5

Faster editing and less background work in large projects.

### Fixed

- Reduced extension-host freezes when opening and editing large Luau files.
- Indexing, framework detection, rename and references now read files without opening
  editor documents, preventing unnecessary Selene and other linter processes.

### Changed

- Editor features share bounded parsing caches and scan function boundaries in one pass.
- Diagnostics prioritize visible files, process background files when the editor is idle,
  and yield or cancel when newer edits arrive. Diagnostic results are unchanged.
- Workspace indexing limits concurrent reads, skips tool folders and files over 2 MB,
  reuses unchanged parses, and saves pending index updates when the window closes.
- Wrap actions build their edits only when selected.

## 1.5.4

Stability and compatibility fixes across editing tools and frameworks.

### Fixed

- Incomplete props tables no longer freeze the extension host or leave stale element labels.
  Closing labels also stay within the requested editor range.
- Sorting, wrapping, extraction, and sprite/gradient edits preserve valid syntax,
  callback bodies, multiline strings and line endings.
- Rename respects bindings and imports. Extraction passes captured inputs explicitly,
  and wrapping preserves Fusion scopes and child layouts.
- Completion preserves existing arguments and function references, without adding invalid
  commas or rewriting declarations.
- Persisted indexes discard stale entries and never restore discarded unsaved buffers as saved data.
- Framework detection ignores comments and strings, handles multiline imports, and respects
  disabled frameworks.
- Fusion scaffolds and snippets support 0.3 scopes while retaining 0.2 compatibility.
- Vide direct calls receive consistent diagnostics, symbols and hints, with custom
  component bindings taking precedence.
- Removed the incorrect TextScaled warning; contrast checks account for transparency.
- Wally/Rojo actions use the selected workspace and handle filenames safely.
- Thumbnail downloads respect disabled previews and cache purges; diagnostic totals
  exclude files outside the workspace.
- Roblox asset discovery supports nested folders on VS Code 1.85.

## 1.5.3

### Added

- Event data for Instance, VideoFrame and UIPageLayout, plus GuiButton.SecondaryActivated.
- Event hover documentation and Vide handler snippets, with specific events suggested first.
- Parent completion and hover support for Fusion/Vide, with a clearer warning for React/Roact.

### Fixed

- Vide event keys no longer produce unknown-property warnings; misspellings get suggestions.
  Thanks to @WaleedAmer for the report and fix ([#4](https://github.com/ericplane/Luix/issues/4)).
- Prop sorting preserves Vide children and actions, recognizes events by class, and works
  in files containing only curried calls.

## 1.5.2

### Fixed

- Recognize Fusion 0.3 scopes and parenthesized Fusion/Vide calls, including StyLua output
  ([#3](https://github.com/ericplane/Luix/issues/3)). Completion preserves the call's style.
- Infer Fusion 0.3 props from the second parameter and recognize scoped component calls.
- Extraction and wrapping resolve the correct framework and preserve receivers and call ranges.

## 1.5.1

Content URL completion, UIShadow support and more control over snippets.

### Added

- rbxthumb URL completion, size choices, hover details and validation, with size data checked
  against Roblox documentation and Quenty's RbxThumbUtils.
- rbxasset path completion from local Roblox content on Windows and macOS. Configure
  `luix.robloxContent.path` to override discovery or `luix.robloxContent.enabled` to disable it.
- UIShadow properties, snippets and hover previews.
- UICorner per-corner previews, conflict warnings, and expand/collapse refactors.
- Snippet controls: `luix.snippets.enabled`, `luix.snippets.hooks` and `luix.snippets.state`.

### Fixed

- Font is recognized as deprecated but valid on text classes. Automatic conversion is
  offered only for Enum.Font values that can be safely converted to FontFace.
- Completion-time auto-imports now respect `luix.autoImport.enabled`.

## 1.5.0

Framework-aware completion, snippets and scaffolds.

### Added

- Per-file framework detection and a status-bar picker, with `luix.activeFramework` overrides.
- Roact scaffolds and matching element, component, event and state snippets across frameworks.
- Roact and Fusion computed-key completion for events and property changes.

### Fixed

- Vide's parenthesized create calls now receive completion, hover and element-tree support.
  Thanks to [@Zyntion](https://github.com/Zyntion) for the suggestion.
- Snippets and computed-key suggestions follow the active framework.

## 1.4.5

### Added

- Convert UDim2 scale/offset sizes using resolvable parent sizes, including supported bindings.
- Calculate parent sizes from children, list layouts and padding when dimensions are known.
- Workspace-component completion can insert the required import.

### Fixed

- Component suggestions stay out of non-UI files and Luau type declarations.
- The sprite editor accepts negative X/Y offsets while keeping dimensions non-negative.

## 1.4.4

Component rename and improvements for large workspaces.

### Added

- Workspace-wide component rename with collision checks and direct-call support.
- Framework-specific component completions and dynamic event/change key snippets.
- A Luix output channel for thumbnail and download errors.

### Changed

- Cached component/framework lookups and shared parsing reduce repeated work.
- Reference lenses calculate counts first and load locations only when clicked.

### Fixed

- Sorting nested props on save no longer creates overlapping edits.
- API-dump updates refresh inherited properties; framework changes refresh diagnostics.
- Fixed index-timer cleanup and duplicate disposal of image decorations.
- Suppressed unrelated completions and snippets inside strings, computed keys and prop-key slots.
- Factory snippets add commas only in list positions and preserve existing arguments.

## 1.4.3

### Added

- Vide direct-instance calls and Fusion/Vide direct-component calls receive props support.
  Built-in instance detection can be disabled with `luix.vide.directInstanceCalls`.

### Changed

- UDim2 property completion opens the constructor picker instead of assuming UDim2.new.

## 1.4.2

### Fixed

- Transient thumbnail failures no longer remain cached; settled failures retry after 10 seconds.
- Hover messages distinguish pending, unavailable and moderated thumbnails.

## 1.4.1

### Fixed

- Wally type regeneration works with Windows PowerShell 5.1.
- Added a delay before Rojo generation to avoid files temporarily locked by Windows Defender.

## 1.4.0

Visual editors, prop sorting and expanded Roblox property support.

### Added

- Preview editors for UIGradient, ColorSequence, NumberSequence and sprite rectangles.
- Gradient and sprite controls include dragging, snapping, numeric inputs and previews.
  Sprite dimensions can use Open Cloud or be entered manually.
- Hover previews for sequences, TweenInfo, UIPadding, UICorner and UIStroke.
- Unused-prop diagnostics that skip components forwarding their props.
- Prop sorting by configurable categories, with optional sorting on save.
- More Roblox classes, properties, events and per-class property types.

### Fixed

- Wrapping respects multi-element selections and avoids double indentation.
- Style enums resolve per class, and TextBox uses the correct inheritance.

## 1.3.0

More diagnostics, design tokens and completion options.

### Added

- Numeric-range diagnostics and a TextScaled warning (removed in 1.5.4).
- Optional contrast warnings, frame-stat lenses, workspace diagnostic summaries and
  a class picker triggered by an opening parenthesis.
- Spacing/font tokens and a command to save Color3 literals to the palette.
- Font-family and supported-weight completion, including `luix.customFonts`.
- CFrame.Angles snippets, persistent workspace indexes and optional Roblox API-dump updates.

### Changed

- Color3, UDim and Font properties open constructor/token choices on completion.
- RichText tag snippets leave attributes for the user to choose.
- FontFace replaces deprecated Font in suggestions.
- Renamed user-facing labels and diagnostic identifiers to Luix.
- Removed legacy setting fallbacks. Rename `reactLuauPropsHelper.*` settings to `luix.*`.

### Fixed

- Prop completion avoids duplicate commas and stays out of value positions.
- Marketplace packages exclude local drafts and development files.

## 1.2.0

### Added

- Anchor presets and missing-AnchorPoint suggestions.
- Framework-aware wrapping and component extraction, with required imports.
- Lossless UDim2 conversions and Color3 format conversions.
- Asset thumbnails on hover and optional gutter previews with cache controls.
- Custom-component hover details and reference lenses.

### Changed

- The color picker supports fromHex/fromHSV and preserves the existing notation.

## 1.1.1

### Added

- RichText color picking with hex/RGB format preservation.
- Default color format settings for Color3 and RichText.
- A warning and quick-fix for tagged Text literals missing RichText = true.

## 1.1.0

### Added

- RichText tag/attribute completion and automatic closing tags.
- Diagnostics for unknown or duplicate props, wrong enum types and hardcoded component props.
- Roblox glyph hints, hovers and shortcuts, including custom shortcuts.
- Class-name completion inside framework factory calls.

### Changed

- Prop suggestions open on the props brace, and string suggestions are enabled for Lua/Luau.
- Removed the legacy-settings migration prompt while retaining silent fallback support.
  The obsolete `luix.suppressLegacySettingsWarning` setting can be deleted.

## 1.0.0

Initial release.

### Added

- React-Luau, Roact, Fusion and Vide prop completion with typed value snippets.
- Custom-component prop inference from returns, annotations, types and configuration.
- Workspace component indexing and navigation.
- Sidebar actions for Wally, Rojo and component scaffolding.
- Color palettes, outline symbols, element hints, color previews and hover documentation.
- Event/annotation completion and element, component and hook snippets.
- Deprecation diagnostics, reserved-name warnings and optional auto-imports.
- Framework aliases, per-feature settings and shared parsing caches.
