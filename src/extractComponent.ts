import * as vscode from "vscode";
import * as path from "path";
import {
  applyMask,
  buildCodeMask,
  findAllCreateElementCalls,
} from "./parser";
import { findFrameworkForAlias, getAliasPartition } from "./frameworks";

// ============================================================================
// Extract-to-component refactor
// ============================================================================
//
// Right-click an element call (or run the command with the cursor in
// one) and Luix will:
//   1. Detect the element call's full range.
//   2. Prompt for a component name (default derived from `Name = "..."`
//      prop or, failing that, the class name).
//   3. Scan the extracted text for every identifier it references.
//   4. Re-locate `local X = require(...)` / `local X = ...` lines in
//      the source file for each referenced identifier — copy only the
//      ones the extracted code actually uses, none of the rest.
//   5. Write a new file alongside the source with the imports, the
//      component function, and a return of the extracted tree.
//   6. Replace the call site with `e(NewComponent)` / framework
//      equivalent, *and* insert a `local NewComponent = require(...)`
//      line at the source file's import block so the rewrite resolves
//      immediately.
//
// Heuristics-only — no full Lua parse. Variables introduced by
// `for x, y in ...`, function parameters other than `props`, or
// destructuring aren't pulled across; they'd need to be hoisted by
// hand. The command makes its assumptions visible by always offering
// a confirmation step before writing files.

export async function extractToComponentCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage(
      "Luix: open a Lua/Luau file and place the cursor inside an element call."
    );
    return;
  }
  const doc = editor.document;
  if (doc.languageId !== "lua" && doc.languageId !== "luau") {
    vscode.window.showInformationMessage(
      "Luix: this command only works in `.lua` / `.luau` files."
    );
    return;
  }

  const text = doc.getText();
  const aliases = getAliasPartition();
  const calls = findAllCreateElementCalls(text, aliases);
  const cursorOffset = doc.offsetAt(editor.selection.active);

  // Pick the innermost element call that contains the cursor (smallest
  // `fullEnd - aliasStart` so nested calls win over their parents).
  const containing = calls
    .filter((c) => cursorOffset >= c.aliasStart && cursorOffset <= c.fullEnd)
    .sort((a, b) => a.fullEnd - a.aliasStart - (b.fullEnd - b.aliasStart));
  const target = containing[0];
  if (!target) {
    vscode.window.showInformationMessage(
      "Luix: place the cursor inside an element call to extract."
    );
    return;
  }

  // Identify the framework (alias) for the new call site. The parser
  // hands the alias over directly — slicing `[aliasStart, classNameStart)`
  // instead dragged in the call's punctuation (`e("`, `New "`,
  // `New(scope, "`), which never resolved to a framework.
  const aliasText = target.alias ?? "";
  const spec = findFrameworkForAlias(aliasText);
  if (!spec) {
    vscode.window.showWarningMessage(
      `Luix: couldn't identify which framework owns the alias \`${aliasText}\` — extract aborted.`
    );
    return;
  }

  // Default name: from `Name = "X"` in the call's props table, falling
  // back to the class name itself.
  const defaultName =
    target.nameProp ??
    (target.isStringLiteralName ? target.className : "ExtractedComponent");
  const name = await vscode.window.showInputBox({
    title: "Luix: extract to component",
    prompt: "Component name (PascalCase). The file will be created alongside the current one.",
    value: defaultName,
    validateInput: (v) => {
      if (!/^[A-Z][A-Za-z0-9_]*$/.test(v)) {
        return "Use PascalCase: starts with a capital letter, letters/digits/underscore only.";
      }
      return undefined;
    },
  });
  if (!name) {
    return;
  }

  const extractedText = text.slice(target.aliasStart, target.fullEnd);
  const masked = applyMask(text, buildCodeMask(text));
  const extractedMasked = masked.slice(target.aliasStart, target.fullEnd);

  // Discover every top-level `local X = ...` binding in the file and
  // remember its line text + line index. Used to copy only the imports
  // the extracted snippet actually references.
  const bindings = collectFileBindings(text, masked);
  const usedIdentifiers = collectIdentifiers(extractedMasked);

  // Iteratively expand the set of "needed" bindings: anything the
  // extracted code references, plus anything those bindings reference
  // in their RHS, transitively. Handles the common `local e =
  // React.createElement` pattern where the extracted code uses `e` but
  // its definition pulls in `React`, which itself is a `require(...)`.
  const needed = new Set<string>(usedIdentifiers);
  // The factory alias itself almost always lives in a require — make
  // sure it's seeded even if it wasn't textually mentioned.
  needed.add(aliasText);
  // Also seed the head of any dotted alias (e.g. `Roact.createElement`
  // needs `Roact`).
  const head = aliasText.split(".")[0];
  if (head) needed.add(head);

  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const b of bindings) {
      if (!needed.has(b.name)) {
        continue;
      }
      // Pull every identifier out of this binding's RHS and add it to
      // the needed set.
      for (const id of collectIdentifiers(b.lineText)) {
        if (!needed.has(id)) {
          needed.add(id);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }

  const importsToCopy = bindings
    .filter((b) => needed.has(b.name))
    .sort((a, b) => a.lineIndex - b.lineIndex);

  // Build the new file's body.
  const newFileContent = renderComponentFile(name, importsToCopy, extractedText);

  // Write the new file beside the active document.
  const dir = path.dirname(doc.uri.fsPath);
  const extension = doc.uri.fsPath.endsWith(".luau") ? ".luau" : ".lua";
  const newFsPath = path.join(dir, `${name}${extension}`);
  const newUri = vscode.Uri.file(newFsPath);
  try {
    await vscode.workspace.fs.stat(newUri);
    const overwrite = await vscode.window.showWarningMessage(
      `Luix: \`${name}${extension}\` already exists. Overwrite?`,
      { modal: true },
      "Overwrite"
    );
    if (overwrite !== "Overwrite") {
      return;
    }
  } catch {
    // File doesn't exist — happy path.
  }
  await vscode.workspace.fs.writeFile(
    newUri,
    Buffer.from(newFileContent, "utf8")
  );

  // Rewrite the call site:
  //   - Replace the extracted range with `e(NewComponent)` etc.
  //   - Insert `local NewComponent = require(script.Parent.NewComponent)`
  //     at the existing import block (best-effort: top of file, after
  //     any leading comments).
  const callSiteText = renderCallSite(name, aliasText, spec.callShape);
  const requireLine = `local ${name} = require(script.Parent.${name})\n`;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    doc.uri,
    new vscode.Range(
      doc.positionAt(target.aliasStart),
      doc.positionAt(target.fullEnd)
    ),
    callSiteText
  );
  // Insert the new require near the existing requires. Heuristic:
  // place it directly after the LAST existing `local X = require(...)`
  // line in the file, or at line 0 if there are none.
  let insertLine = 0;
  for (const b of bindings) {
    if (/require\s*\(/.test(b.lineText)) {
      insertLine = b.lineIndex + 1;
    }
  }
  edit.insert(doc.uri, new vscode.Position(insertLine, 0), requireLine);
  await vscode.workspace.applyEdit(edit);

  // Open the new file so the user can verify and tweak immediately.
  await vscode.window.showTextDocument(newUri, { preview: false });
}

// ============================================================================
// Helpers
// ============================================================================

interface ImportLine {
  name: string;
  lineText: string;
  lineIndex: number;
}

/**
 * Capture every top-level `local X = ...` (any RHS, not just require)
 * in the document along with its full line text and 0-based line
 * index. Top-level only — bindings inside function bodies are scoped
 * locally and not safe to copy.
 */
function collectFileBindings(
  text: string,
  masked: string
): ImportLine[] {
  const lines = text.split("\n");
  const maskedLines = masked.split("\n");
  const out: ImportLine[] = [];
  // Track block depth so we skip bindings that live inside functions /
  // do-blocks / if-blocks.
  let depth = 0;
  for (let i = 0; i < maskedLines.length; i++) {
    const ml = maskedLines[i];
    const orig = lines[i];
    // Top-level only: bindings nested in functions get a stale module
    // reference if we copy them.
    if (depth === 0) {
      const m = /^[\s]*local\s+(?:function\s+)?([A-Za-z_]\w*)\b/.exec(ml);
      if (m && !/^[\s]*local\s+function\s+/.test(ml)) {
        out.push({ name: m[1], lineText: orig, lineIndex: i });
      }
    }
    // Update depth using tokens visible on this line.
    const tokenRe = /\b(function|if|do|repeat|then|end|until)\b/g;
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(ml)) !== null) {
      const t = tm[0];
      if (t === "function" || t === "if" || t === "do" || t === "repeat") {
        depth++;
      } else if (t === "end" || t === "until") {
        depth = Math.max(0, depth - 1);
      } else if (t === "then") {
        // `then` closes the conditional opener but we already
        // increment depth on `if`/`elseif` — leave depth alone.
      }
    }
  }
  return out;
}

function collectIdentifiers(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1]);
  }
  return out;
}

function renderComponentFile(
  name: string,
  imports: ImportLine[],
  body: string
): string {
  const lines: string[] = [];
  for (const imp of imports) {
    lines.push(imp.lineText);
  }
  if (imports.length > 0) {
    lines.push("");
  }
  lines.push(`local function ${name}(props)`);
  // Indent the body one tab under the function.
  const indented = body
    .split("\n")
    .map((l, i) => (i === 0 ? `\treturn ${l}` : `\t${l}`))
    .join("\n");
  lines.push(indented);
  lines.push("end");
  lines.push("");
  lines.push(`return ${name}`);
  lines.push("");
  return lines.join("\n");
}

function renderCallSite(
  name: string,
  alias: string,
  callShape: "parens" | "curried"
): string {
  // Fusion / Vide compose component functions by calling them
  // directly (`MyComp { ... }`) rather than threading them through the
  // `New` / `create` keyword (which is reserved for native instances).
  if (callShape === "curried") {
    return `${name} {}`;
  }
  return `${alias}(${name}, {})`;
}
