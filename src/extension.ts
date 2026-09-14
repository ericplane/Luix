import * as vscode from "vscode";
import {
  AnnotationCompletionProvider,
  ClassNameCompletionProvider,
  FactoryComponentCompletionProvider,
  FactoryOpenParenCompletionProvider,
  ReactLuauPropsCompletionProvider,
} from "./completion";
import {
  Color3DocumentColorProvider,
  PropHoverProvider,
  CreateElementInlayHintsProvider,
  CreateElementSymbolProvider,
} from "./editor";
import { DiagnosticsManager } from "./diagnostics";
import {
  AutoImportCodeActionProvider,
  Color3ConvertCodeActionProvider,
  Color3PaletteExtractorProvider,
  DeprecationCodeActionProvider,
  UDim2ConvertCodeActionProvider,
  WrapInCodeActionProvider,
  buildRelativePath,
  resolveViaAlias,
} from "./codeActions";
import { AnchorPresetCompletionProvider } from "./anchorPresets";
import {
  ComponentReferencesLensProvider,
  FrameStatsLensProvider,
} from "./codeLens";
import { maybeAugmentFromApiDump } from "./apiDump";
import { WorkspaceValidation } from "./workspaceValidation";
import {
  FontsCompletionProvider,
  SpacingCompletionProvider,
} from "./palette";
import { extractToComponentCommand } from "./extractComponent";
import { ImageGutterDecorator } from "./imageGutter";
import {
  getCacheStats,
  getThumbnailCacheDir,
  purgeAllThumbnails,
} from "./assetThumbnails";
import { WorkspaceIndex } from "./workspaceIndex";
import { getOutputChannelDisposable } from "./output";
import { ComponentRenameProvider } from "./rename";
import { ElementSnippetCompletionProvider } from "./elementSnippets";
import {
  UDim2FromChildrenCodeActionProvider,
  UDim2ResolveCodeActionProvider,
} from "./udim2Convert";
import { UICornerCodeActionProvider } from "./uiCorner";
import {
  DEFAULT_ALIASES,
  PROP_TYPES,
  TYPE_SNIPPETS,
  buildFontFaceReplacement,
  classHierarchy,
  defaultPropsMap,
  findIntroducingClass,
  findIntroducingEventClass,
  flattenClassEvents,
  flattenClassProps,
  getPropType,
  renderTypeSnippet,
} from "./data";
import { collectLocalBindings } from "./parser";
import { PaletteCompletionProvider } from "./palette";
import {
  FontFamilyCompletionProvider,
  FontWeightCompletionProvider,
} from "./robloxFonts";
import {
  RichTextColorProvider,
  RichTextCompletionProvider,
  registerRichTextAutoClose,
} from "./richText";
import {
  RobloxGlyphCompletionProvider,
  RobloxGlyphHoverProvider,
  RobloxGlyphInlayHintsProvider,
} from "./robloxGlyphs";
import {
  RbxAssetCompletionProvider,
  RbxThumbCompletionProvider,
  RbxThumbDiagnostics,
  RbxThumbHoverProvider,
  resetContentCache,
} from "./robloxContent";
import {
  ComponentsTreeProvider,
  WorkspaceTreeProvider,
} from "./sidebar";
import {
  generateRojoSourcemap,
  regenerateWallyTypes,
  wallyInstall,
} from "./wally";
import { pickFrameworkAndScaffold, scaffoldComponent } from "./scaffolds";
import {
  GradientCodeLensProvider,
  GradientEditorManager,
  GradientHoverProvider,
} from "./gradient";
import {
  RectCodeLensProvider,
  RectEditorManager,
  purgeAllCachedAssetDims,
} from "./rect";
import { UIHoverPreviewsProvider } from "./hoverPreviews";
import {
  SortPropsCodeActionProvider,
  SortPropsOnSaveListener,
} from "./sortProps";
import {
  ActiveFrameworkStatusBar,
  PICK_ACTIVE_FRAMEWORK_COMMAND,
  pickActiveFrameworkCommand,
} from "./statusBar";
import {
  inferWorkspaceFramework,
  setWorkspaceFallback,
} from "./activeFramework";

export function activate(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = [
    { language: "lua", scheme: "file" },
    { language: "luau", scheme: "file" },
  ];

  // Register the Luix output channel up-front so background failures
  // (asset thumbnail fetches, API-dump downloads, persist writes) have
  // somewhere visible to log. Users can open it via "Output: Show
  // Output Channels…" → Luix.
  context.subscriptions.push(getOutputChannelDisposable());

  const workspaceIndex = new WorkspaceIndex(context);

  // Kick off the optional Roblox API-dump fetch (no-op when the
  // setting is off — see `apiDump.ts`).
  maybeAugmentFromApiDump(context);
  context.subscriptions.push(workspaceIndex);

  // Active-framework status bar — the always-visible "Luix: React /
  // Roact / Fusion / Vide / Auto" indicator. Click flips
  // `luix.activeFramework`. The picker command is also exposed via
  // the command palette ("Luix: Set active framework…").
  const statusBar = new ActiveFrameworkStatusBar();
  const refreshWorkspaceFallback = async () => {
    const fw = await inferWorkspaceFramework(workspaceIndex.indexedUris());
    // The infer call awaits up to 25 openTextDocument round-trips —
    // can take hundreds of ms. If deactivate fired in the meantime,
    // touching the disposed status bar throws "Illegal access to
    // disposed object" in some VS Code versions. The disposed flag
    // (added in statusBar.ts) makes both writes idempotent on a
    // dead instance.
    if (statusBar.isDisposed()) return;
    setWorkspaceFallback(fw);
    statusBar.refresh();
  };
  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand(
      PICK_ACTIVE_FRAMEWORK_COMMAND,
      pickActiveFrameworkCommand
    ),
    // Workspace fallback for the framework detector: take the
    // most-represented framework across indexed files and expose it
    // via `setWorkspaceFallback`. Recomputed on every settled index
    // change, so brand-new files inherit the project's convention
    // even before they have their own imports / calls.
    workspaceIndex.onDidChangeIndex(() => {
      void refreshWorkspaceFallback();
    })
  );
  // Initial inference at activation — non-blocking so the rest of
  // activate() can finish without waiting on file reads.
  void refreshWorkspaceFallback();

  // Props provider — `.` is needed for `[React.Event.|` and
  // `[React.Change.|`; `{` makes the suggestion list open the moment you
  // type the props brace so common props (`Name`, `Size`, …) appear
  // without an extra Ctrl+Space. Space/newline are deliberately *not*
  // triggers; that would steal Tab from GitHub Copilot's inline ghost text.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new ReactLuauPropsCompletionProvider(workspaceIndex),
      ".",
      "{"
    )
  );

  // Class-name provider — fires inside the string-literal first arg of a
  // factory call (`e("Fr|"`, `New "Fr|"`, …). Trigger chars are the
  // quotes themselves so the list opens the instant the user types `e("`.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new ClassNameCompletionProvider(workspaceIndex),
      '"',
      "'"
    )
  );
  // Optional companion: fire the class picker on `(` so typing `e(`
  // opens the list without needing to also type the opening quote.
  // Off by default — many users won't want the trigger to fire on
  // every function call. Suppression handled inside the provider.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new FactoryOpenParenCompletionProvider(workspaceIndex),
      "("
    )
  );

  // Element-construction snippets (`eFrame`, `nFrame`, `cFrame`, etc.).
  // Migrated from `snippets/luix.code-snippets` because the static
  // snippet system had no awareness of strings or prop-key positions —
  // typing `Fra` inside a string used to surface every `*Frame`
  // snippet. The provider gates by code mask, prop-key position, and
  // enabled frameworks (Fusion users don't see `eFrame`/`cFrame`, etc.).
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new ElementSnippetCompletionProvider(workspaceIndex)
    )
  );

  // Workspace-component completion inside `e(<partial>|`. Sidesteps
  // luau-lsp's "insert function as call" behaviour, which expands an
  // accepted `DailyQuestCard` into `DailyQuestCard(props)` rather than
  // leaving it as a reference for React's factory call. No explicit
  // trigger char — VS Code re-evaluates completions as identifier
  // chars are typed, which is when this needs to fire. The provider
  // self-gates on `<alias>(<partial>|` so it stays quiet outside the
  // first-arg slot of a factory call.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new FactoryComponentCompletionProvider(workspaceIndex)
    )
  );

  // Annotation provider — completes `---@extends <Class>` and
  // `---@prop NAME <Type>`. Only fires inside `---` comment lines.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new AnnotationCompletionProvider(),
      " "
    )
  );

  // Color preview — gutter swatches and VS Code's color picker.
  context.subscriptions.push(
    vscode.languages.registerColorProvider(
      selector,
      new Color3DocumentColorProvider()
    )
  );

  // Hover docs — prop type, inherited-from class, Roblox docs link; also
  // surfaces a "what is this custom component?" tooltip on the class slot
  // of `e(MyButton, …)` style calls.
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      selector,
      new PropHoverProvider(workspaceIndex)
    )
  );

  // Inlay hints — labels at the closing `)` of every multi-line
  // createElement call.
  const inlayHints = new CreateElementInlayHintsProvider();
  context.subscriptions.push(
    inlayHints,
    vscode.languages.registerInlayHintsProvider(selector, inlayHints)
  );

  // Document symbols — Outline panel, breadcrumbs, Go to Symbol.
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      selector,
      new CreateElementSymbolProvider()
    )
  );

  // Diagnostics — reserved-name, deprecations, opt-in missing imports.
  const diagnostics = new DiagnosticsManager(workspaceIndex);
  context.subscriptions.push(diagnostics);

  // Code actions — Font → FontFace, TextColor → TextColor3, auto-import.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new DeprecationCodeActionProvider(),
      {
        providedCodeActionKinds:
          DeprecationCodeActionProvider.providedCodeActionKinds,
      }
    )
  );
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new AutoImportCodeActionProvider(workspaceIndex),
      {
        providedCodeActionKinds:
          AutoImportCodeActionProvider.providedCodeActionKinds,
      }
    )
  );
  // Convert Color3 between fromRGB / fromHex / new / fromHSV.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new Color3ConvertCodeActionProvider(),
      {
        providedCodeActionKinds:
          Color3ConvertCodeActionProvider.providedCodeActionKinds,
      }
    )
  );
  // Convert UDim2 between new / fromOffset / fromScale (lossless,
  // purely syntactic — only fires when scales OR offsets are zero).
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new UDim2ConvertCodeActionProvider(),
      {
        providedCodeActionKinds:
          UDim2ConvertCodeActionProvider.providedCodeActionKinds,
      }
    )
  );
  // Convert fromScale ↔ fromOffset by deducing the parent element's
  // pixel size from the source-order parent chain. Fires when the
  // chain resolves to a concrete pixel value; otherwise stays hidden.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new UDim2ResolveCodeActionProvider(),
      {
        providedCodeActionKinds:
          UDim2ResolveCodeActionProvider.providedCodeActionKinds,
      }
    )
  );
  // "Calculate Size from children" — compute the parent's pixel size
  // from its children's literal `UDim2.fromOffset` Sizes, plus any
  // `UIListLayout` Padding + FillDirection and `UIPadding` margins.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new UDim2FromChildrenCodeActionProvider(),
      {
        providedCodeActionKinds:
          UDim2FromChildrenCodeActionProvider.providedCodeActionKinds,
      }
    )
  );
  // UICorner — collapse four equal individual corner radii into one
  // `CornerRadius`, or expand a `CornerRadius` into the four individual
  // props. Fires when the cursor is inside a `UICorner` element call.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new UICornerCodeActionProvider(),
      {
        providedCodeActionKinds:
          UICornerCodeActionProvider.providedCodeActionKinds,
      }
    )
  );
  // Wrap selection in Frame / ScrollingFrame / container w/ UIListLayout.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new WrapInCodeActionProvider(),
      {
        providedCodeActionKinds:
          WrapInCodeActionProvider.providedCodeActionKinds,
      }
    )
  );

  // `anchor:tl|t|tr|l|c|r|bl|b|br` typed completion inside props tables.
  // Trigger char `:` overlaps with the Roblox-glyph completion (which only
  // fires inside strings) — both providers context-check and return
  // undefined when they aren't relevant.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new AnchorPresetCompletionProvider(workspaceIndex),
      ":"
    )
  );

  // Workspace-wide component rename — `F2` on a component identifier
  // renames the definition + every createElement-style call site + every
  // Vide/Fusion direct-call site (`MyComp({ … })`, `MyComp { … }`) across
  // the workspace. Covers the call shapes luau-lsp's rename can't see.
  context.subscriptions.push(
    vscode.languages.registerRenameProvider(
      selector,
      new ComponentRenameProvider(workspaceIndex)
    )
  );

  // "N references" CodeLens above every component definition.
  // The lens displays a synchronous workspace-wide count; the actual
  // call-site Locations are resolved lazily by the command below when
  // the user clicks. This avoids opening every workspace file on every
  // lens refresh — previously dominated CPU on large projects.
  const referencesLens = new ComponentReferencesLensProvider(workspaceIndex);
  context.subscriptions.push(
    referencesLens,
    vscode.languages.registerCodeLensProvider(selector, referencesLens),
    vscode.commands.registerCommand(
      "luix.peekComponentReferences",
      async (
        sourceUri: vscode.Uri,
        position: vscode.Position,
        componentName: string
      ) => {
        const sites = await workspaceIndex.findCallSites(componentName);
        const locations = sites.map(
          (s) => new vscode.Location(s.uri, s.range)
        );
        await vscode.commands.executeCommand(
          "editor.action.showReferences",
          sourceUri,
          position,
          locations
        );
      }
    )
  );
  // Frame-stats CodeLens — `▸ N descendants, D layers` above heavy
  // subtrees. Off by default (visual noise).
  const frameStatsLens = new FrameStatsLensProvider();
  context.subscriptions.push(
    frameStatsLens,
    vscode.languages.registerCodeLensProvider(selector, frameStatsLens)
  );

  // Gradient editor — CodeLens above each `ColorSequence.new(...)`, a
  // hover-preview of the gradient strip, and a webview panel with
  // draggable stops + per-stop colour picker.
  const gradientLens = new GradientCodeLensProvider();
  const gradientEditor = new GradientEditorManager(context);
  context.subscriptions.push(
    gradientLens,
    gradientEditor,
    vscode.languages.registerCodeLensProvider(selector, gradientLens),
    vscode.languages.registerHoverProvider(
      selector,
      new GradientHoverProvider()
    ),
    // Visual hover previews for TweenInfo, UIPadding, UICorner, UIStroke.
    vscode.languages.registerHoverProvider(
      selector,
      new UIHoverPreviewsProvider()
    ),
    vscode.commands.registerCommand(
      "luix.openGradientEditor",
      (uri: vscode.Uri, range: vscode.Range, mode?: "color" | "number") => {
        gradientEditor.open(uri, range, mode ?? "color");
      }
    )
  );

  // Rect editor — CodeLens "Edit sprite rect" above every
  // ImageLabel/ImageButton whose Image prop is a literal rbxassetid.
  // Opens a side-panel editor showing the actual thumbnail with a
  // draggable rectangle for picking ImageRectOffset/ImageRectSize.
  const rectLens = new RectCodeLensProvider();
  const rectEditor = new RectEditorManager(context);
  context.subscriptions.push(
    rectLens,
    rectEditor,
    vscode.languages.registerCodeLensProvider(selector, rectLens),
    vscode.commands.registerCommand(
      "luix.openRectEditor",
      (uri: vscode.Uri, range: vscode.Range) => {
        rectEditor.open(uri, range);
      }
    )
  );

  // Color3-to-palette extractor — code action on any Color3 literal.
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new Color3PaletteExtractorProvider(),
      {
        providedCodeActionKinds:
          Color3PaletteExtractorProvider.providedCodeActionKinds,
      }
    )
  );

  // Sort props by category — code action, plus an opt-in on-save formatter
  // (luix.sortProps.onSave, default off).
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      selector,
      new SortPropsCodeActionProvider(),
      {
        providedCodeActionKinds:
          SortPropsCodeActionProvider.providedCodeActionKinds,
      }
    ),
    new SortPropsOnSaveListener()
  );

  // Workspace-wide diagnostic aggregator. The summary surfaces through
  // the sidebar; the provider does nothing while disabled.
  const workspaceValidation = new WorkspaceValidation();
  context.subscriptions.push(workspaceValidation);

  // Gutter image previews next to `Image = "rbxassetid://..."` lines —
  // downloads and caches a tiny thumbnail per asset under the
  // extension's global storage (or `.luix/assetThumbs/` when the user
  // has opted in to workspace-local caching).
  const imageGutter = new ImageGutterDecorator(context);
  context.subscriptions.push(imageGutter);

  // Palette completion — triggers on `.` and only fires when the cursor
  // is right after `Color3.`.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new PaletteCompletionProvider(),
      "."
    )
  );
  // Design-token completion — `luix.spacing` shows after `UDim.`,
  // `luix.fonts` after `Font.`. Both empty by default — opt-in via
  // user config.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new SpacingCompletionProvider(),
      "."
    ),
    vscode.languages.registerCompletionItemProvider(
      selector,
      new FontsCompletionProvider(),
      "."
    )
  );

  // Roblox font catalogue — family names inside `Font.fromName("…")`,
  // weight names after `Enum.FontWeight.`, filtered by the active
  // family when we can detect it from the surrounding call.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new FontFamilyCompletionProvider(),
      '"',
      "'",
      "`"
    ),
    vscode.languages.registerCompletionItemProvider(
      selector,
      new FontWeightCompletionProvider(),
      "."
    )
  );

  // RichText completion — `<` inside any single-line string surfaces the
  // Roblox tag list (`<b>`, `<font ...>`, `<stroke ...>`, …). The snippet
  // also inserts the matching close tag. Paired with an auto-close handler
  // so typing the `>` of an opening tag (`<font size="18">`) drops in the
  // matching `</font>` after the cursor. Both gated by `luix.richText.enabled`.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new RichTextCompletionProvider(),
      "<"
    )
  );
  context.subscriptions.push(
    vscode.languages.registerColorProvider(
      selector,
      new RichTextColorProvider()
    )
  );
  registerRichTextAutoClose(context);

  // Roblox private-use-area glyph support — Robux / Premium / Verified /
  // Roblox Plus render as missing-glyph boxes in VS Code's default fonts.
  // Inlay hints name each occurrence; the hover gives codepoint + Luau
  // escape; the `:slug:` completion lets users insert the literal glyph
  // from inside a string. All gated by `luix.robloxGlyphs.enabled`.
  const robloxGlyphHints = new RobloxGlyphInlayHintsProvider();
  context.subscriptions.push(
    robloxGlyphHints,
    vscode.languages.registerInlayHintsProvider(selector, robloxGlyphHints),
    vscode.languages.registerHoverProvider(
      selector,
      new RobloxGlyphHoverProvider()
    ),
    vscode.languages.registerCompletionItemProvider(
      selector,
      new RobloxGlyphCompletionProvider(),
      ":"
    )
  );

  // Roblox content-URL autocomplete — `rbxthumb://` (dynamic thumbnails
  // with per-type valid sizes) and `rbxasset://` (bundled content files
  // scanned from the local install). The thumbnail diagnostic flags
  // hand-typed unsupported sizes / types. All gated by
  // `luix.robloxContent.enabled`; the content scan honours
  // `luix.robloxContent.path`.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new RbxThumbCompletionProvider(),
      "/",
      "=",
      "&"
    ),
    vscode.languages.registerCompletionItemProvider(
      selector,
      new RbxAssetCompletionProvider(),
      "/"
    ),
    vscode.languages.registerHoverProvider(
      selector,
      new RbxThumbHoverProvider()
    ),
    new RbxThumbDiagnostics(),
    // Re-scan the content folder when the override path / toggle changes.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("luix.robloxContent")) {
        resetContentCache();
      }
    })
  );

  // ---- Sidebar (Workspace + Components views) ----
  const workspaceTreeProvider = new WorkspaceTreeProvider(
    context,
    workspaceValidation
  );
  const componentsTreeProvider = new ComponentsTreeProvider(
    workspaceIndex,
    context
  );
  // Seed the context key so the title-bar toggle shows the right icon.
  void vscode.commands.executeCommand(
    "setContext",
    "luix.componentsViewMode",
    componentsTreeProvider.getMode()
  );
  context.subscriptions.push(
    workspaceTreeProvider,
    componentsTreeProvider,
    vscode.window.registerTreeDataProvider(
      "luix.workspace",
      workspaceTreeProvider
    ),
    vscode.window.registerTreeDataProvider(
      "luix.components",
      componentsTreeProvider
    )
  );

  // ---- Commands wired up by the sidebar entries ----
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "luix.wally.regenerateTypes",
      regenerateWallyTypes
    ),
    vscode.commands.registerCommand("luix.wally.install", wallyInstall),
    vscode.commands.registerCommand(
      "luix.rojo.generateSourcemap",
      generateRojoSourcemap
    ),
    vscode.commands.registerCommand(
      "luix.newComponent.react",
      (uri?: vscode.Uri) => scaffoldComponent("react", uri)
    ),
    vscode.commands.registerCommand(
      "luix.newComponent.roact",
      (uri?: vscode.Uri) => scaffoldComponent("roact", uri)
    ),
    vscode.commands.registerCommand(
      "luix.newComponent.fusion",
      (uri?: vscode.Uri) => scaffoldComponent("fusion", uri)
    ),
    vscode.commands.registerCommand(
      "luix.newComponent.vide",
      (uri?: vscode.Uri) => scaffoldComponent("vide", uri)
    ),
    vscode.commands.registerCommand(
      "luix.newComponentHere",
      (uri?: vscode.Uri) => pickFrameworkAndScaffold(uri)
    ),
    vscode.commands.registerCommand("luix.refreshComponents", () =>
      componentsTreeProvider.refresh()
    ),
    vscode.commands.registerCommand("luix.refreshWorkspace", () =>
      workspaceTreeProvider.refresh()
    ),
    vscode.commands.registerCommand("luix.componentsView.toggleMode", () =>
      componentsTreeProvider.toggleMode()
    ),
    vscode.commands.registerCommand(
      "luix.extractToComponent",
      extractToComponentCommand
    ),
    vscode.commands.registerCommand(
      "luix.imageGutter.purgeCache",
      async () => {
        const { count } = await getCacheStats(context);
        if (count === 0) {
          void vscode.window.showInformationMessage(
            "Luix: image preview cache is already empty."
          );
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          `Purge ${count} cached Roblox asset thumbnail${count === 1 ? "" : "s"}? They'll re-download on demand.`,
          { modal: true },
          "Purge"
        );
        if (choice !== "Purge") return;
        await purgeAllThumbnails(context);
        const dimsRemoved = await purgeAllCachedAssetDims(context);
        imageGutter.clearAllDecorations();
        workspaceTreeProvider.refreshCache();
        const dimsNote =
          dimsRemoved > 0
            ? ` (also cleared ${dimsRemoved} cached asset dimension${dimsRemoved === 1 ? "" : "s"})`
            : "";
        void vscode.window.showInformationMessage(
          `Luix: image preview cache purged${dimsNote}.`
        );
      }
    ),
    vscode.commands.registerCommand(
      "luix.imageGutter.enableFromSidebar",
      async () => {
        await vscode.workspace
          .getConfiguration("luix")
          .update(
            "imageGutter.enabled",
            true,
            vscode.ConfigurationTarget.Global
          );
        // The sidebar entry IS the disclosure — suppress the
        // post-first-download notification so users don't get the
        // same message twice.
        await context.globalState.update(
          "luix.imageGutter.firstDownloadNotified",
          true
        );
        const choice = await vscode.window.showInformationMessage(
          "Luix: image gutter previews are now on. Thumbnails download once per asset and live under VS Code's extension storage by default — flip `luix.imageGutter.cacheLocation` to `workspace` if you'd rather they live in `.luix/assetThumbs/` per project.",
          "Open settings",
          "Got it"
        );
        if (choice === "Open settings") {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@ext:ericplane.luix-roblox imageGutter"
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      "luix.palette.addEntry",
      async (literal?: string) => {
        if (typeof literal !== "string") return;
        const name = await vscode.window.showInputBox({
          title: "Luix: save Color3 to palette",
          prompt:
            "Token name (e.g. `primary`, `surface`, `text`). The literal will be added to `luix.palette` so it surfaces in `Color3.` completions.",
          validateInput: (v) =>
            /^[A-Za-z_][A-Za-z0-9_-]*$/.test(v)
              ? undefined
              : "Use a simple identifier (letters/digits/dash/underscore).",
        });
        if (!name) return;
        const target = await vscode.window.showQuickPick(
          [
            { label: "User settings (global)", target: vscode.ConfigurationTarget.Global },
            { label: "Workspace settings", target: vscode.ConfigurationTarget.Workspace },
          ],
          { title: "Where should the palette entry live?" }
        );
        if (!target) return;
        const cfg = vscode.workspace.getConfiguration("luix");
        const current = cfg.get<Record<string, string>>("palette", {}) ?? {};
        if (current[name] && current[name] !== literal) {
          const overwrite = await vscode.window.showWarningMessage(
            `Luix: \`palette.${name}\` already exists with value \`${current[name]}\`. Overwrite?`,
            { modal: true },
            "Overwrite"
          );
          if (overwrite !== "Overwrite") return;
        }
        await cfg.update("palette", { ...current, [name]: literal }, target.target);
        void vscode.window.showInformationMessage(
          `Luix: added \`palette.${name}\` → \`${literal}\`.`
        );
      }
    ),
    vscode.commands.registerCommand(
      "luix.imageGutter.openCacheFolder",
      async () => {
        const dir = getThumbnailCacheDir(context);
        try {
          await vscode.workspace.fs.stat(dir);
        } catch {
          void vscode.window.showInformationMessage(
            `Luix: cache directory \`${dir.fsPath}\` doesn't exist yet — view a file with an asset reference first.`
          );
          return;
        }
        await vscode.commands.executeCommand(
          "revealFileInOS",
          dir
        );
      }
    )
  );
}

export function deactivate() {}

// ============================================================================
// Re-exports for tests
// ============================================================================
//
// The test file imports from `../extension`. To keep tests unchanged after
// the refactor, re-export each helper/type from its new home.

export {
  buildCodeMask,
  applyMask,
  extractPropEntries,
  findEnclosingFactoryStringArg,
  findEnclosingPropsCall,
  extractTypeFields,
  parseAnnotationsForComponent,
  scanDocument,
  detectReturnedClass,
  findAllCreateElementCalls,
  buildCallTree,
  extractColorLiterals,
  collectLocalBindings,
} from "./parser";

export type {
  EnclosingCall,
  EnclosingStringArg,
  ComponentAnnotations,
  DocumentComponentInfo,
  CreateElementCall,
  CallTreeNode,
  ColorLiteral,
} from "./parser";

export const _internal = {
  defaultPropsMap,
  DEFAULT_ALIASES,
};

export const _testing = {
  PROP_TYPES,
  TYPE_SNIPPETS,
  getPropType,
  renderTypeSnippet,
  classHierarchy,
  flattenClassProps,
  flattenClassEvents,
  findIntroducingClass,
  findIntroducingEventClass,
  buildFontFaceReplacement,
  collectLocalBindings,
  buildRelativePath,
  resolveViaAlias,
};
