import * as vscode from "vscode";

let _channel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel("Luix");
  }
  return _channel;
}

export function logWarn(message: string, err?: unknown): void {
  try {
    const channel = getOutputChannel();
    const stamp = new Date().toISOString().slice(11, 19);
    const errSuffix =
      err === undefined
        ? ""
        : err instanceof Error
          ? ` — ${err.name}: ${err.message}`
          : ` — ${String(err)}`;
    channel.appendLine(`[${stamp}] ${message}${errSuffix}`);
  } catch {
    // VS Code APIs may be unavailable during test bootstrap.
  }
}

export function getOutputChannelDisposable(): vscode.Disposable {
  return getOutputChannel();
}
