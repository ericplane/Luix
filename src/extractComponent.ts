import * as vscode from "vscode";
import * as path from "path";
import { CreateElementCall, findAllCreateElementCalls } from "./parser";
import { FrameworkSpec, findFrameworkForAlias, getAliasPartition } from "./frameworks";
import { analyzeLuaBindings, applyTextChanges, LuaReference } from "./editSyntax";

const SHARED_GLOBALS = new Set((
  "assert error getmetatable ipairs next pairs pcall print rawequal rawget rawlen rawset select setmetatable tonumber tostring type typeof unpack xpcall " +
  "bit32 buffer coroutine debug math os string table task utf8 game workspace shared _G Enum " +
  "Axes BrickColor CFrame Color3 ColorSequence ColorSequenceKeypoint DateTime DockWidgetPluginGuiInfo Faces Font Instance " +
  "NumberRange NumberSequence NumberSequenceKeypoint OverlapParams PathWaypoint PhysicalProperties Random Ray RaycastParams Rect " +
  "Region3 Region3int16 TweenInfo UDim UDim2 Vector2 Vector2int16 Vector3 Vector3int16"
).split(" "));

export interface ExtractionPlan { content: string; replacement: string; captures: string[] }

/** Keep dependencies at their existing call site. Copying local initializers
 * into another module can recreate reactive state and loses lexical inputs. */
export function planComponentExtraction(
  text: string, target: CreateElementCall, name: string, spec: FrameworkSpec
): ExtractionPlan {
  const source = analyzeLuaBindings(text);
  if (source.references.some(r => r.token.value === name)) {
    throw new Error(`'${name}' is already used in this file; choose a name that cannot shadow an existing value.`);
  }
  const body = text.slice(target.aliasStart, target.fullEnd);
  const selected = analyzeLuaBindings(body);
  // A type alias cannot be transported as a runtime prop. Support plain
  // callbacks and method calls; leave type-dependent selections for the LSP.
  for (let i = 0; i < selected.tokens.length; i++) {
    const token = selected.tokens[i];
    const argument = selected.tokens[i + 2];
    const methodCall = argument?.value === "(" || argument?.value === "{" || argument?.kind === "string";
    if (token.value === "::" || (token.value === ":" && !methodCall)) {
      throw new Error("This selection contains a type annotation. Use the language server to extract its type dependencies.");
    }
    if (token.value === "...") {throw new Error("Extract a selection without captured varargs first.");}
  }
  const captures = new Set<string>();
  const external = selected.references.filter(r => !r.binding && !r.declaration);
  const originalReference = (r: LuaReference) => source.references.find(s => s.token.start === target.aliasStart + r.token.start);
  for (const reference of external) {
    const id = reference.token.value;
    const original = originalReference(reference);
    if (original?.binding || !SHARED_GLOBALS.has(id)) {captures.add(id);}
  }
  const isWrite = (tokens: typeof selected.tokens, tokenStart: number): boolean => {
    const i = tokens.findIndex(t => t.start === tokenStart);
    if (tokens[i - 1]?.value === "function") {return true;}
    let j = i + 1;
    if (tokens[j]?.value === ",") {
      // A comma after a value (a prop, argument or return value) is not an
      // assignment. Tuple assignment tails may themselves be t.x / t[index].
      let first = i;
      while (tokens[first - 1]?.value === "," && tokens[first - 2]?.kind === "word") {first -= 2;}
      if (["=", "return", "(", "[", "{", "and", "or"].includes(tokens[first - 1]?.value)) {return false;}
      while (tokens[j]?.value === "," && tokens[j + 1]?.kind === "word") {
        j += 2;
        while (tokens[j]?.value === "." || tokens[j]?.value === "[") {
          if (tokens[j].value === ".") {
            if (tokens[j + 1]?.kind !== "word") {return false;}
            j += 2;
          } else {
            let depth = 1; j++;
            while (j < tokens.length && depth > 0) {
              if (tokens[j].value === "[") {depth++;}
              if (tokens[j].value === "]") {depth--;}
              j++;
            }
          }
        }
      }
    }
    return ["=", "+=", "-=", "*=", "/=", "%=", "^=", "..="].includes(tokens[j]?.value);
  };
  for (const reference of external) {
    if (!captures.has(reference.token.value)) {continue;}
    if (isWrite(selected.tokens, reference.token.start)) {
      throw new Error(`The selection assigns to captured '${reference.token.value}'. Extract the handler or state owner together instead.`);
    }
    const binding = originalReference(reference)?.binding;
    if (binding && source.references.some(r => r.binding === binding && !r.declaration && isWrite(source.tokens, r.token.start))) {
      throw new Error(`Captured '${binding.name}' is reassigned outside the selection. Extract its state owner or pass an explicit accessor first.`);
    }
  }
  let scopeName: string | undefined;
  if (spec.id === "fusion") {
    scopeName = /^([A-Za-z_]\w*)\s*:/.exec(target.receiver ?? "")?.[1];
    if (!scopeName) {
      const beforeClass = text.slice(target.aliasStart, target.classNameStart);
      scopeName = /\(\s*([A-Za-z_]\w*)\s*,\s*["']?$/.exec(beforeClass)?.[1];
    }
  }
  if (scopeName) {captures.delete(scopeName);}
  const names = [...captures];
  let inputName = "__luixInputs";
  while (selected.tokens.some(t => t.value === inputName) || inputName === scopeName) {inputName += "_";}
  const parameters = scopeName ? `${scopeName}, ${inputName}` : inputName;
  // React reserves key/ref props. A generated namespace keeps every capture
  // available even when the original local is called key or ref.
  const locals = names.map(id => `\tlocal ${id} = ${inputName}.__luix_${id}`);
  // Reindenting subsequent lines also changes multiline string contents.
  // Keep the selected expression byte-for-byte intact after the return prefix.
  const returned = `\treturn ${body}`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const content = [
    `local function ${name}(${parameters})`, ...locals, returned, "end", "", `return ${name}`, "",
  ].join(eol);
  const props = names.length ? `{ ${names.map(id => `__luix_${id} = ${id}`).join(", ")} }` : "{}";
  const replacement = spec.callShape === "parens"
    ? `${target.alias}(${name}, ${props})`
    : scopeName ? `${name}(${scopeName}, ${props})` : `${name}(${props})`;
  return { content, replacement, captures: names };
}

/** A single WorkspaceEdit makes file creation and replacement one undo step. */
export function buildExtractionEdit(
  document: vscode.TextDocument, target: CreateElementCall, name: string,
  newUri: vscode.Uri, plan: ExtractionPlan, overwrite = false
): vscode.WorkspaceEdit {
  const text = document.getText();
  const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
  const requireBase = /^init\.(lua|luau)$/i.test(path.basename(document.uri.fsPath)) ? "script" : "script.Parent";
  const requireLine = `local ${name} = require(${requireBase}.${name})${eol}`;
  // Keep --!strict and leading comments at the top of the module.
  const first = analyzeLuaBindings(text).tokens[0]?.start ?? 0;
  const lineStart = text.lastIndexOf("\n", first - 1) + 1;
  const rewritten = applyTextChanges(text, [
    { start: target.aliasStart, end: target.fullEnd, text: plan.replacement },
    { start: lineStart, end: lineStart, text: requireLine },
  ]);
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(newUri, { overwrite });
  edit.insert(newUri, new vscode.Position(0, 0), plan.content);
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), rewritten);
  return edit;
}

export async function extractToComponentCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !["lua", "luau"].includes(editor.document.languageId)) {
    void vscode.window.showInformationMessage("Luix: place the cursor inside an element call in a Lua/Luau file.");
    return;
  }
  const document = editor.document;
  if (document.uri.scheme !== "file") {
    void vscode.window.showWarningMessage("Luix: save this file before extracting a sibling component.");
    return;
  }
  const text = document.getText(), version = document.version;
  const cursor = document.offsetAt(editor.selection.active);
  const target = findAllCreateElementCalls(text, getAliasPartition())
    .filter(c => cursor >= c.aliasStart && cursor < c.fullEnd)
    .sort((a, b) => (a.fullEnd - a.aliasStart) - (b.fullEnd - b.aliasStart))[0];
  const spec = target && findFrameworkForAlias(target.alias ?? "");
  if (!target || !spec) {
    void vscode.window.showInformationMessage("Luix: place the cursor inside a supported element call.");
    return;
  }
  const name = await vscode.window.showInputBox({
    title: "Luix: extract to component",
    prompt: "Component name. Captured inputs stay at this call site and are passed to the new component.",
    value: target.nameProp ?? (target.isStringLiteralName ? target.className : "ExtractedComponent"),
    validateInput: value => /^[A-Z][A-Za-z0-9_]*$/.test(value) ? undefined : "Use a PascalCase identifier.",
  });
  if (!name) {return;}
  try {
    const plan = planComponentExtraction(text, target, name, spec);
    const extension = document.uri.fsPath.endsWith(".luau") ? ".luau" : ".lua";
    const newUri = vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), name + extension));
    const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    if (comparable(newUri.fsPath) === comparable(document.uri.fsPath)) {throw new Error("Choose a component name different from the source file.");}
    let overwrite = false;
    try { await vscode.workspace.fs.stat(newUri); overwrite = true; }
    catch (err) {
      if (!(err instanceof vscode.FileSystemError) || err.code !== "FileNotFound") {throw err;}
    }
    if (overwrite) {
      const answer = await vscode.window.showWarningMessage(
        `Luix: ${name}${extension} already exists. Overwrite?`, { modal: true }, "Overwrite"
      );
      if (answer !== "Overwrite") {return;}
    }
    if (document.version !== version) {throw new Error("The source changed while extraction was open. Run extraction again.");}
    if (!await vscode.workspace.applyEdit(buildExtractionEdit(document, target, name, newUri, plan, overwrite))) {
      throw new Error("The extraction could not be applied. No successful extraction was recorded.");
    }
    await vscode.window.showTextDocument(newUri, { preview: false });
  } catch (err) {
    void vscode.window.showWarningMessage(`Luix: ${err instanceof Error ? err.message : String(err)}`);
  }
}
