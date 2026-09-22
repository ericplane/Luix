import * as vscode from "vscode";
import { usesLegacyFusionSyntax } from "./fusionSnippets";

const TEMPLATES = {
  react: (name: string) =>
    [
      `local ReplicatedStorage = game:GetService("ReplicatedStorage")`,
      ``,
      `local React = require(ReplicatedStorage.Packages.React)`,
      `local e = React.createElement`,
      ``,
      `local function ${name}(props): React.ReactNode`,
      `\treturn e("Frame", {`,
      `\t\tSize = UDim2.fromScale(1, 1),`,
      `\t\tBackgroundTransparency = 1,`,
      `\t}, {`,
      `\t\t-- children`,
      `\t})`,
      `end`,
      ``,
      `return ${name}`,
      ``,
    ].join("\n"),

  roact: (name: string) =>
    [
      `local ReplicatedStorage = game:GetService("ReplicatedStorage")`,
      ``,
      `local Roact = require(ReplicatedStorage.Packages.Roact)`,
      ``,
      // No `local e = Roact.createElement` alias — the matching `rofc`
      // snippet body in src/elementSnippets.ts calls
      // `Roact.createElement` directly, so both entry points (this
      // template + the rofc snippet) emit identical files.
      `local function ${name}(props)`,
      `\treturn Roact.createElement("Frame", {`,
      `\t\tSize = UDim2.fromScale(1, 1),`,
      `\t\tBackgroundTransparency = 1,`,
      `\t}, {`,
      `\t\t-- children`,
      `\t})`,
      `end`,
      ``,
      `return ${name}`,
      ``,
    ].join("\n"),

  fusion: (name: string, legacy = false) =>
    [
      `local ReplicatedStorage = game:GetService("ReplicatedStorage")`,
      ``,
      `local Fusion = require(ReplicatedStorage.Packages.Fusion)`,
      ``,
      ...(legacy ? [`local New = Fusion.New`] : []),
      `local Children = Fusion.Children`,
      ``,
      legacy ? `local function ${name}(props)` : `local function ${name}(scope: Fusion.Scope<typeof(Fusion)>, props)`,
      legacy ? `\treturn New "Frame" {` : `\treturn scope:New "Frame" {`,
      `\t\tSize = UDim2.fromScale(1, 1),`,
      `\t\tBackgroundTransparency = 1,`,
      `\t\t[Children] = {`,
      `\t\t\t-- children`,
      `\t\t},`,
      `\t}`,
      `end`,
      ``,
      `return ${name}`,
      ``,
    ].join("\n"),

  vide: (name: string) =>
    [
      `local ReplicatedStorage = game:GetService("ReplicatedStorage")`,
      ``,
      `local vide = require(ReplicatedStorage.Packages.vide)`,
      `local create = vide.create`,
      ``,
      `local function ${name}(props)`,
      `\treturn create "Frame" {`,
      `\t\tSize = UDim2.fromScale(1, 1),`,
      `\t\tBackgroundTransparency = 1,`,
      `\t\t-- children`,
      `\t}`,
      `end`,
      ``,
      `return ${name}`,
      ``,
    ].join("\n"),
};

export type Framework = keyof typeof TEMPLATES;

const PROMPT_TITLES: Record<Framework, string> = {
  react: "New React component",
  roact: "New Roact component",
  fusion: "New Fusion component",
  vide: "New Vide component",
};

/**
 * Best-effort default folder: the directory of the active editor's file
 * if any, otherwise the first workspace folder. Used as the starting
 * point for the folder picker.
 */
function inferDefaultDir(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === "file") {
    const path = require("path") as typeof import("path");
    return vscode.Uri.file(path.dirname(editor.document.uri.fsPath));
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * Resolve the target directory.
 *   - If the caller already supplied one (explorer right-click, etc.),
 *     use it as-is.
 *   - Otherwise show a folder picker rooted at a sensible default.
 */
async function resolveTargetDir(
  explicit: vscode.Uri | undefined,
  framework: Framework
): Promise<vscode.Uri | undefined> {
  if (explicit) {
    return explicit;
  }
  const defaultUri = inferDefaultDir();
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showWarningMessage(
      "Luix: open a workspace folder before creating a new component."
    );
    return undefined;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri,
    openLabel: "Create here",
    title: `${PROMPT_TITLES[framework]} — choose folder`,
  });
  return picked?.[0];
}

export async function scaffoldComponent(
  framework: Framework,
  targetDirUri?: vscode.Uri
): Promise<void> {
  const targetDir = await resolveTargetDir(targetDirUri, framework);
  if (!targetDir) {
    return; // user canceled or no workspace
  }

  const name = await vscode.window.showInputBox({
    title: PROMPT_TITLES[framework],
    prompt: "Component name (e.g. GamepassCard)",
    placeHolder: "ComponentName",
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return "Name can't be empty.";
      }
      if (!/^[A-Z][A-Za-z0-9_]*$/.test(trimmed)) {
        return "Name should start with a capital letter and contain only letters / digits / underscores.";
      }
      return undefined;
    },
  });
  if (!name) {
    return;
  }

  const trimmed = name.trim();
  const fileUri = vscode.Uri.joinPath(targetDir, `${trimmed}.luau`);

  try {
    await vscode.workspace.fs.stat(fileUri);
    const overwrite = await vscode.window.showWarningMessage(
      `Luix: \`${trimmed}.luau\` already exists. Overwrite?`,
      { modal: true },
      "Overwrite"
    );
    if (overwrite !== "Overwrite") {
      return;
    }
  } catch {
    // File doesn't exist — good.
  }

  const legacyFusion = framework === "fusion" && await prefersLegacyFusion(targetDir);
  const body = TEMPLATES[framework](trimmed, legacyFusion);
  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(fileUri, encoder.encode(body));

  const doc = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(doc);
}

/**
 * Right-click-on-folder entry point. Quickpicks the framework, then
 * delegates to `scaffoldComponent` with the clicked folder URI.
 */
export async function pickFrameworkAndScaffold(
  targetUri?: vscode.Uri
): Promise<void> {
  type Pick = vscode.QuickPickItem & { framework: Framework };
  const items: Pick[] = [
    { label: "React component", description: "e(\"Frame\", { … })", framework: "react" },
    { label: "Roact component", description: "Roact.createElement(\"Frame\", { … })", framework: "roact" },
    { label: "Fusion component", description: "New \"Frame\" { … }", framework: "fusion" },
    { label: "Vide component", description: "create \"Frame\" { … }", framework: "vide" },
  ];
  const choice = await vscode.window.showQuickPick(items, {
    title: "Luix: New component",
    placeHolder: "Pick a framework",
  });
  if (!choice) {
    return;
  }
  await scaffoldComponent(choice.framework, targetUri);
}

// Exported for tests.
export function _renderTemplate(framework: Framework, name: string, legacyFusion = false): string {
  return TEMPLATES[framework](name, legacyFusion);
}

async function prefersLegacyFusion(targetDir: vscode.Uri): Promise<boolean> {
  const folder = vscode.workspace.getWorkspaceFolder(targetDir);
  if (folder) {
    try {
      const manifest = new TextDecoder().decode(await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(folder.uri, "wally.toml")
      ));
      const dependency = /^\s*[^#\n=]+\s*=\s*["'][^"'\n]*\/fusion@[^\d"'\n]*(0\.[23])(?:\.|["'])/im.exec(manifest);
      if (dependency) {
        return dependency[1] === "0.2";
      }
    } catch {
      // A manifest is optional; use the active file's established syntax.
    }
  }
  const active = vscode.window.activeTextEditor?.document;
  return !!active && vscode.workspace.getWorkspaceFolder(active.uri)?.uri.toString() === folder?.uri.toString()
    && usesLegacyFusionSyntax(active.getText());
}
