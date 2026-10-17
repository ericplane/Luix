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

  // Register logging before starting background work.
  context.subscriptions.push(getOutputChannelDisposable());

  const workspaceIndex = new WorkspaceIndex(context);

  maybeAugmentFromApiDump(context);
  context.subscriptions.push(workspaceIndex);

  const statusBar = new ActiveFrameworkStatusBar();
  let frameworkRefreshVersion = 0;
  const refreshWorkspaceFallback = async () => {
    const refreshVersion = ++frameworkRefreshVersion;
    // Stop sampling when a newer refresh supersedes this one.
    const superseded = () =>
      statusBar.isDisposed() || refreshVersion !== frameworkRefreshVersion;
    const fw = await inferWorkspaceFramework(workspaceIndex, superseded);
    if (superseded()) {return;}
    setWorkspaceFallback(fw);
    statusBar.refresh();
  };
  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand(
      PICK_ACTIVE_FRAMEWORK_COMMAND,
      pickActiveFrameworkCommand
    ),
    // Files without local framework signals inherit the workspace convention.
    workspaceIndex.onDidChangeIndex(() => {
      void refreshWorkspaceFallback();
    })
  );
  void refreshWorkspaceFallback();

  // Avoid space/newline triggers: they steal Tab from inline suggestions.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new ReactLuauPropsCompletionProvider(workspaceIndex),
      ".",
      "{"
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new ClassNameCompletionProvider(workspaceIndex),
      '"',
      "'"
    )
  );
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new FactoryOpenParenCompletionProvider(workspaceIndex),
      "("
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new ElementSnippetCompletionProvider(workspaceIndex)
    )
  );

  // Insert component references without luau-lsp expanding them into calls.
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new FactoryComponentCompletionProvider(workspaceIndex)
    )
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new AnnotationCompletionProvider(),
      " "
    )
  );

  context.subscriptions.push(
    vscode.languages.registerColorProvider(
      selector,
      new Color3DocumentColorProvider()
    )
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      selector,
      new PropHoverProvider(workspaceIndex)
    )
  );

  const inlayHints = new CreateElementInlayHintsProvider(workspaceIndex);
  context.subscriptions.push(
    inlayHints,
    vscode.languages.registerInlayHintsProvider(selector, inlayHints)
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      selector,
      new CreateElementSymbolProvider(workspaceIndex)
    )
  );

  const diagnostics = new DiagnosticsManager(workspaceIndex);
  context.subscriptions.push(diagnostics);

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

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new AnchorPresetCompletionProvider(workspaceIndex),
      ":"
    )
  );

  context.subscriptions.push(
    vscode.languages.registerRenameProvider(
      selector,
      new ComponentRenameProvider(workspaceIndex)
    )
  );

  // Resolve reference locations on click to avoid reading files on every lens refresh.
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
  const frameStatsLens = new FrameStatsLensProvider();
  context.subscriptions.push(
    frameStatsLens,
    vscode.languages.registerCodeLensProvider(selector, frameStatsLens)
  );

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

  const workspaceValidation = new WorkspaceValidation();
  context.subscriptions.push(workspaceValidation);

  const imageGutter = new ImageGutterDecorator(context);
  context.subscriptions.push(imageGutter);

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new PaletteCompletionProvider(),
      "."
    )
  );
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("luix.robloxContent")) {
        resetContentCache();
      }
    })
  );

  const workspaceTreeProvider = new WorkspaceTreeProvider(
    context,
    workspaceValidation
  );
  const componentsTreeProvider = new ComponentsTreeProvider(
    workspaceIndex,
    context
  );
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
        if (choice !== "Purge") {return;}
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
        // The sidebar already disclosed the cache location.
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
        if (typeof literal !== "string") {return;}
        const name = await vscode.window.showInputBox({
          title: "Luix: save Color3 to palette",
          prompt:
            "Token name (e.g. `primary`, `surface`, `text`). The literal will be added to `luix.palette` so it surfaces in `Color3.` completions.",
          validateInput: (v) =>
            /^[A-Za-z_][A-Za-z0-9_-]*$/.test(v)
              ? undefined
              : "Use a simple identifier (letters/digits/dash/underscore).",
        });
        if (!name) {return;}
        const target = await vscode.window.showQuickPick(
          [
            { label: "User settings (global)", target: vscode.ConfigurationTarget.Global },
            { label: "Workspace settings", target: vscode.ConfigurationTarget.Workspace },
          ],
          { title: "Where should the palette entry live?" }
        );
        if (!target) {return;}
        const cfg = vscode.workspace.getConfiguration("luix");
        const current = cfg.get<Record<string, string>>("palette", {}) ?? {};
        if (current[name] && current[name] !== literal) {
          const overwrite = await vscode.window.showWarningMessage(
            `Luix: \`palette.${name}\` already exists with value \`${current[name]}\`. Overwrite?`,
            { modal: true },
            "Overwrite"
          );
          if (overwrite !== "Overwrite") {return;}
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

// Test-facing exports.

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
