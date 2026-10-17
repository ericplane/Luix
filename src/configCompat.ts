import * as vscode from "vscode";

const NEW_PREFIX = "luix";
const LEGACY_PREFIX = "reactLuauPropsHelper";

export function getConfig<T>(key: string, defaultValue: T): T {
  return vscode.workspace
    .getConfiguration(NEW_PREFIX)
    .get<T>(key, defaultValue);
}

/** Check current and legacy setting paths so migrations also trigger refreshes. */
export function configChangeAffects(
  event: vscode.ConfigurationChangeEvent,
  key: string
): boolean {
  return (
    event.affectsConfiguration(`${NEW_PREFIX}.${key}`) ||
    event.affectsConfiguration(`${LEGACY_PREFIX}.${key}`)
  );
}
