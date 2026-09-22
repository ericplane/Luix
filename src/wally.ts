import * as vscode from "vscode";

interface ProjectRoot {
  folder: vscode.WorkspaceFolder;
  hasWally: boolean;
  projects: string[];
}

let nextRunId = 0;

/** ProcessExecution keeps filenames out of shell grammar and gives each
 * task an explicit root, independent of a previously used terminal's cwd. */
async function runTask(
  folder: vscode.WorkspaceFolder,
  command: string,
  args: string[]
): Promise<boolean> {
  const runId = `${Date.now()}-${++nextRunId}`;
  const task = new vscode.Task(
    { type: "luix", runId },
    folder,
    `${command} ${args[0] ?? ""}`.trim(),
    "Luix",
    new vscode.ProcessExecution(command, args, { cwd: folder.uri.fsPath }),
    []
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Shared,
    focus: false,
  };
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) {return;}
      settled = true;
      processEnd.dispose();
      taskEnd.dispose();
      resolve(success);
    };
    const processEnd = vscode.tasks.onDidEndTaskProcess((event) => {
      if (event.execution.task.definition.runId === runId) {
        finish(event.exitCode === 0);
      }
    });
    // Launch failures and terminated tasks may have no process exit code.
    const taskEnd = vscode.tasks.onDidEndTask((event) => {
      if (event.execution.task.definition.runId === runId) {finish(false);}
    });
    void vscode.tasks.executeTask(task).then(undefined, (error: unknown) => {
      finish(false);
      void vscode.window.showErrorMessage(`Luix: could not start ${command}: ${String(error)}`);
    });
  });
}

async function inspectRoots(): Promise<ProjectRoot[]> {
  return Promise.all((vscode.workspace.workspaceFolders ?? []).map(async (folder) => {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(folder.uri);
    } catch {
      return { folder, hasWally: false, projects: [] };
    }
    const files = entries.filter(([, type]) => (type & vscode.FileType.File) !== 0)
      .map(([name]) => name);
    return {
      folder,
      hasWally: files.includes("wally.toml"),
      projects: files.filter((name) => name.endsWith(".project.json")).sort(),
    };
  }));
}

async function selectRoot(
  needsWally: boolean,
  needsProject: boolean
): Promise<ProjectRoot | undefined> {
  const roots = (await inspectRoots()).filter((root) =>
    (!needsWally || root.hasWally) && (!needsProject || root.projects.length > 0));
  if (roots.length === 0) {
    const required = needsWally && needsProject
      ? "wally.toml and a *.project.json in the same workspace root"
      : needsWally ? "wally.toml in a workspace root" : "*.project.json in a workspace root";
    void vscode.window.showWarningMessage(`Luix: no ${required} found.`);
    return undefined;
  }
  if (roots.length === 1) {return roots[0];}
  const active = vscode.window.activeTextEditor?.document.uri;
  const activeRoot = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
  const picked = await vscode.window.showQuickPick(roots.map((root) => ({
    label: root.folder.name,
    description: root.folder.uri.fsPath,
    picked: root.folder.uri.toString() === activeRoot?.uri.toString(),
    root,
  })), { placeHolder: "Choose the workspace for this Luix action" });
  return picked?.root;
}

async function selectProject(root: ProjectRoot): Promise<string | undefined> {
  if (root.projects.includes("default.project.json")) {return "default.project.json";}
  if (root.projects.length === 1) {return root.projects[0];}
  return vscode.window.showQuickPick(root.projects, {
    placeHolder: `Choose the Rojo project in ${root.folder.name}`,
  });
}

export async function wallyInstall(): Promise<void> {
  const root = await selectRoot(true, false);
  if (root) {await runTask(root.folder, "wally", ["install"]);}
}

export async function generateRojoSourcemap(): Promise<void> {
  const root = await selectRoot(false, true);
  if (!root) {return;}
  const project = await selectProject(root);
  if (project) {await runTask(root.folder, "rojo", ["sourcemap", project, "-o", "sourcemap.json"]);}
}

export async function regenerateWallyTypes(): Promise<void> {
  const root = await selectRoot(true, true);
  if (!root) {return;}
  const project = await selectProject(root);
  if (!project) {return;}
  if (!await runTask(root.folder, "wally", ["install"])) {return;}
  // Allow Windows Defender to release Wally's freshly written links.
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
  }
  if (!await runTask(root.folder, "rojo", ["sourcemap", project, "-o", "sourcemap.json"])) {return;}
  await runTask(root.folder, "wally-package-types", ["--sourcemap", "sourcemap.json", "Packages/"]);
}

/** Used by the sidebar to show actions available in any workspace root. */
export interface WorkspaceCapabilities {
  hasWally: boolean;
  hasRojoProject: boolean;
}

export async function detectWorkspaceCapabilities(): Promise<WorkspaceCapabilities> {
  const roots = await inspectRoots();
  return {
    hasWally: roots.some((root) => root.hasWally),
    hasRojoProject: roots.some((root) => root.projects.length > 0),
  };
}
