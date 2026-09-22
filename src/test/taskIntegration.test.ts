import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

suite("Process task integration", () => {
  test("Luix process tasks preserve lifecycle identity, literal arguments, and cwd", async function () {
    this.timeout(20000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "Run this integration test with an isolated workspace folder");
    const executable = process.env.LUIX_TEST_NODE;
    assert.ok(executable, "Run this integration test with LUIX_TEST_NODE set to the standalone Node executable");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "luix-task-integration-"));
    const output = path.join(directory, "result.json");
    const literalArgument = "client ui; echo unsafe.project.json";
    const runId = `integration-${Date.now()}-${Math.random()}`;
    const script = "require('fs').writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), argument: process.argv[2] }))";
    const task = new vscode.Task(
      { type: "luix", runId },
      folder,
      "Luix process integration",
      "Luix",
      new vscode.ProcessExecution(executable, ["-e", script, output, literalArgument], {
        cwd: directory,
      }),
      []
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Never,
      focus: false,
      panel: vscode.TaskPanelKind.New,
    };
    let execution: vscode.TaskExecution | undefined;
    let terminal: vscode.Terminal | undefined;
    let processId: number | undefined;
    let terminalExit: vscode.TerminalExitStatus | undefined;
    const subscriptions: vscode.Disposable[] = [];
    let timer: NodeJS.Timeout | undefined;
    try {
      const ended = new Promise<{ exitCode: number | undefined; runId: unknown; type: string; taskEnded: boolean }>((resolve, reject) => {
        let processEvent: vscode.TaskProcessEndEvent | undefined;
        let taskEnded = false;
        const finish = () => {
          if (processEvent && taskEnded) {
            resolve({
              exitCode: processEvent.exitCode,
              runId: processEvent.execution.task.definition.runId,
              type: processEvent.execution.task.definition.type,
              taskEnded,
            });
          }
        };
        subscriptions.push(
          vscode.window.onDidOpenTerminal((opened) => {
            if (opened.name === task.name) { terminal = opened; }
          }),
          vscode.window.onDidCloseTerminal((closed) => {
            if (closed.name === task.name) { terminalExit = closed.exitStatus; }
          }),
          vscode.tasks.onDidStartTaskProcess((event) => {
            if (event.execution.task.name === task.name) { processId = event.processId; }
          }),
          vscode.tasks.onDidEndTaskProcess((event) => {
            // Match by the public task name too: if VS Code drops the custom
            // runId, assert that explicitly instead of merely timing out.
            if (event.execution.task.name === task.name) { processEvent = event; finish(); }
          }),
          vscode.tasks.onDidEndTask((event) => {
            if (event.execution.task.name === task.name) { taskEnded = true; finish(); }
          })
        );
        timer = setTimeout(() => reject(new Error("Process task did not emit both lifecycle events within 15 seconds")), 15000);
      });
      execution = await vscode.tasks.executeTask(task);
      const event = await ended;
      const outputText = await fs.readFile(output, "utf8").catch(() => undefined);
      assert.strictEqual(event.exitCode, 0, JSON.stringify({
        event, processId, terminalExit, executable,
        outputWritten: outputText !== undefined,
      }));
      assert.strictEqual(event.runId, runId);
      assert.strictEqual(event.type, "luix");
      assert.strictEqual(event.taskEnded, true);
      assert.ok(outputText, "task must write the argument/cwd result");
      const result = JSON.parse(outputText) as { cwd: string; argument: string };
      assert.strictEqual(await fs.realpath(result.cwd), await fs.realpath(directory));
      assert.strictEqual(result.argument, literalArgument);
    } finally {
      if (timer) { clearTimeout(timer); }
      subscriptions.forEach((subscription) => subscription.dispose());
      if (execution && vscode.tasks.taskExecutions.includes(execution)) { execution.terminate(); }
      terminal?.dispose();
      // Only remove this test's own mkdtemp child, never a workspace root.
      assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith("luix-task-integration-"));
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
