import * as vscode from "vscode";
import { findEnclosingPropsCall } from "./parser";
import { getAliasPartition } from "./frameworks";
import { isAtPropKeyPosition } from "./completion";
import { WorkspaceIndex } from "./workspaceIndex";

// Complete anchor presets with matching AnchorPoint and scale Position.

interface Preset {
  slug: string;
  label: string;
  anchorX: number;
  anchorY: number;
}

const PRESETS: Preset[] = [
  { slug: "tl", label: "top-left", anchorX: 0, anchorY: 0 },
  { slug: "t", label: "top", anchorX: 0.5, anchorY: 0 },
  { slug: "tr", label: "top-right", anchorX: 1, anchorY: 0 },
  { slug: "l", label: "left", anchorX: 0, anchorY: 0.5 },
  { slug: "c", label: "center", anchorX: 0.5, anchorY: 0.5 },
  { slug: "r", label: "right", anchorX: 1, anchorY: 0.5 },
  { slug: "bl", label: "bottom-left", anchorX: 0, anchorY: 1 },
  { slug: "b", label: "bottom", anchorX: 0.5, anchorY: 1 },
  { slug: "br", label: "bottom-right", anchorX: 1, anchorY: 1 },
];

export class AnchorPresetCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private readonly workspaceIndex?: WorkspaceIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const text = document.getText();
    const cursorOffset = document.offsetAt(position);
    const detected = findEnclosingPropsCall(
      text,
      cursorOffset,
      getAliasPartition(),
      this.workspaceIndex?.knownDirectCallTargets()
    );
    if (!detected) {
      return undefined;
    }
    // Offer presets only in prop-key positions.
    if (!isAtPropKeyPosition(document, position)) {
      return undefined;
    }

    // Replace the entire partial anchor token.
    let start = cursorOffset;
    while (start > 0 && /[A-Za-z:]/.test(text[start - 1])) {
      start--;
    }
    const typed = text.slice(start, cursorOffset);
    if (!/^[Aa]/.test(typed) && typed.length > 0) {
      return undefined;
    }

    const replaceRange = new vscode.Range(
      document.positionAt(start),
      position
    );

    return PRESETS.map((preset, index) => {
      const item = new vscode.CompletionItem(
        `anchor:${preset.slug}`,
        vscode.CompletionItemKind.Snippet
      );
      item.detail = `Anchor preset — ${preset.label}`;
      item.documentation = new vscode.MarkdownString(
        [
          "Inserts a paired `AnchorPoint` + `Position` so the element ",
          `anchors to **${preset.label}** of its parent.\n\n`,
          "```lua\n",
          renderSnippet(preset, /*forDocs=*/ true),
          "\n```",
        ].join("")
      );
      item.filterText = `anchor:${preset.slug}`;
      item.sortText = String(index).padStart(4, "0");
      item.range = replaceRange;
      item.insertText = new vscode.SnippetString(
        renderSnippet(preset, /*forDocs=*/ false)
      );
      return item;
    });
  }
}

function renderSnippet(preset: Preset, forDocs: boolean): string {
  const ax = fmt(preset.anchorX);
  const ay = fmt(preset.anchorY);
  // Matching scales place the anchor at the same point in the parent.
  const px = fmt(preset.anchorX);
  const py = fmt(preset.anchorY);
  const tail = forDocs ? "" : "$0";
  return (
    `AnchorPoint = Vector2.new(${ax}, ${ay}),\n` +
    `Position = UDim2.fromScale(${px}, ${py}),${tail}`
  );
}

function fmt(n: number): string {
  return Number.isInteger(n) ? n.toString() : n.toString();
}
