import * as vscode from "vscode";
import {
  CreateElementCall,
  extractPropEntriesFromDocument,
  findAllCreateElementCalls,
} from "./parser";
import { getAliasPartition } from "./frameworks";
import { UICORNER_INDIVIDUAL_RADII } from "./data";

// Collapse equal per-corner radii or expand a uniform radius; skip conflicts.

interface CornerEntry {
  key: string;
  /** Trimmed value. */
  valueText: string;
  /** Absolute document offsets. */
  keyStart: number;
  valueEnd: number;
}

export type UICornerPlan =
  | { kind: "collapse"; value: string }
  | { kind: "expand"; value: string };

export function planUICornerRefactor(
  entries: { key: string; valueText: string }[]
): UICornerPlan | undefined {
  const byKey = new Map(entries.map((e) => [e.key, e.valueText.trim()]));
  const cornerValue = byKey.get("CornerRadius");
  const individualPresent = UICORNER_INDIVIDUAL_RADII.filter((k) =>
    byKey.has(k)
  );

  if (cornerValue !== undefined && individualPresent.length === 0) {
    if (cornerValue.length === 0) {return undefined;}
    return { kind: "expand", value: cornerValue };
  }

  // Collapse only when the four equal radii are the entire prop table.
  if (
    cornerValue === undefined &&
    individualPresent.length === 4 &&
    entries.length === 4
  ) {
    const values = individualPresent.map((k) => byKey.get(k) ?? "");
    if (values[0].length === 0) {return undefined;}
    if (values.every((v) => v === values[0])) {
      return { kind: "collapse", value: values[0] };
    }
  }

  return undefined;
}

function findEnclosingUICorner(
  calls: readonly CreateElementCall[],
  offset: number
): CreateElementCall | undefined {
  let best: CreateElementCall | undefined;
  let bestSize = Infinity;
  for (const c of calls) {
    if (c.className !== "UICorner" || !c.isStringLiteralName) {continue;}
    if (c.aliasStart <= offset && offset <= c.fullEnd) {
      const size = c.fullEnd - c.aliasStart;
      if (size < bestSize) {
        best = c;
        bestSize = size;
      }
    }
  }
  return best;
}

function lineIndentAt(text: string, offset: number): string {
  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== "\n") {lineStart--;}
  let i = lineStart;
  while (i < offset && (text[i] === " " || text[i] === "\t")) {i++;}
  return text.slice(lineStart, i);
}

export class UICornerCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorRewrite,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    const text = document.getText();
    const cursorOffset = document.offsetAt(range.start);

    const aliases = getAliasPartition();
    const calls = findAllCreateElementCalls(text, aliases);
    const call = findEnclosingUICorner(calls, cursorOffset);
    if (
      !call ||
      call.propsBraceStart === undefined ||
      call.propsBraceEnd === undefined
    ) {
      return [];
    }

    const bodyStart = call.propsBraceStart + 1;
    const raw = extractPropEntriesFromDocument(
      text,
      bodyStart,
      call.propsBraceEnd
    );
    if (raw.length === 0) {return [];}

    const entries: CornerEntry[] = raw.map((e) => ({
      key: e.key,
      valueText: text.slice(bodyStart + e.valueStart, bodyStart + e.valueEnd).trim(),
      keyStart: bodyStart + e.keyStart,
      valueEnd: bodyStart + e.valueEnd,
    }));

    const plan = planUICornerRefactor(
      entries.map((e) => ({ key: e.key, valueText: e.valueText }))
    );
    if (!plan) {return [];}

    // Collapse is a diagnostic quick fix; offer only expansion here.
    if (plan.kind !== "expand") {return [];}

    const corner = entries.find((e) => e.key === "CornerRadius");
    if (!corner) {return [];}
    const indent = lineIndentAt(text, corner.keyStart);
    const replacement = UICORNER_INDIVIDUAL_RADII.map(
      (k) => `${k} = ${plan.value}`
    ).join(`,\n${indent}`);
    const action = new vscode.CodeAction(
      "Expand to individual corner radii",
      vscode.CodeActionKind.RefactorRewrite
    );
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(corner.keyStart),
        document.positionAt(corner.valueEnd)
      ),
      replacement
    );
    return [action];
  }
}
