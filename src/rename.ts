import * as vscode from "vscode";
import * as path from "path";
import { WorkspaceIndex, decodeFileText, positionsInText } from "./workspaceIndex";
import { analyzeLuaBindings, LuaBinding, LuaBindings, LUA_KEYWORDS } from "./editSyntax";

export interface RenameChange { start: number; end: number; text: string }

export interface RenameSource {
  readonly uri: vscode.Uri;
  getText(): string;
}

/** Rename only references bound to the selected local. */
export function planBindingRename(text: string, offset: number, newName: string): RenameChange[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName) || LUA_KEYWORDS.has(newName)) {
    throw new Error("Choose a Lua identifier that is not a reserved keyword.");
  }
  const parsed = analyzeLuaBindings(text);
  const selected = parsed.references.find(r => offset >= r.token.start && offset < r.token.end);
  if (!selected?.binding) {
    throw new Error("Luix cannot prove this name's local binding. Rename it through the language server.");
  }
  const binding = selected.binding;
  if (binding.name === newName) {return [];}
  // Value renames must not alter the separate type namespace.
  if (parsed.tokens.some((t, i) => t.value === "type" &&
      [binding.name, newName].includes(parsed.tokens[i + 1]?.value))) {
    throw new Error("This name is also a type alias; use the language server's rename.");
  }
  if (parsed.references.some(r => r.token.value === newName)) {
    throw new Error(`'${newName}' is already used in this document; choose a name that cannot capture another binding.`);
  }
  return parsed.references.filter(r => r.binding === binding)
    .map(r => ({ start: r.token.start, end: r.token.end, text: newName }));
}

function selectedBinding(text: string, offset: number): { parsed: LuaBindings; binding: LuaBinding } {
  const parsed = analyzeLuaBindings(text);
  const binding = parsed.references.find(r => offset >= r.token.start && offset < r.token.end)?.binding;
  if (!binding) {throw new Error("Luix cannot resolve this component to a local binding.");}
  return { parsed, binding };
}

function directExport(parsed: LuaBindings): LuaBinding | undefined {
  const tokens = parsed.tokens.filter(t => t.value !== ";");
  const last = tokens.at(-1), before = tokens.at(-2);
  if (!last || before?.value !== "return") {return undefined;}
  const ref = parsed.references.find(r => r.token.start === last.start);
  return ref?.scope === parsed.root ? ref.binding : undefined;
}

/** Resolve relative module paths only; basenames cannot prove ownership. */
function requiredFile<T extends RenameSource>(
  document: RenameSource,
  parsed: LuaBindings,
  binding: LuaBinding,
  files: T[]
): T | undefined {
  const index = parsed.tokens.findIndex(t => t.start === binding.declaration.start);
  const tokens = parsed.tokens.slice(index + 1);
  if (tokens[0]?.value !== "=" || tokens[1]?.value !== "require" || tokens[2]?.value !== "(") {return undefined;}
  let modulePath: string;
  let end = 3;
  if (tokens[3]?.kind === "string" && /^["']\.\.?\//.test(tokens[3].value)) {
    modulePath = path.resolve(path.dirname(document.uri.fsPath), tokens[3].value.slice(1, -1));
    end = 4;
  } else if (tokens[3]?.value === "script") {
    modulePath = document.uri.fsPath.replace(/\.(lua|luau)$/i, "");
    if (/[/\\]init$/i.test(modulePath)) {modulePath = path.dirname(modulePath);}
    end = 4;
    while (tokens[end]?.value === "." && tokens[end + 1]?.kind === "word") {
      const segment = tokens[end + 1].value;
      modulePath = segment === "Parent" ? path.dirname(modulePath) : path.join(modulePath, segment);
      end += 2;
    }
  } else {return undefined;}
  if (tokens[end]?.value !== ")") {return undefined;}
  const candidates = new Set([
    modulePath, modulePath + ".lua", modulePath + ".luau",
    path.join(modulePath, "init.lua"), path.join(modulePath, "init.luau"),
  ].map(p => path.normalize(p)));
  const matches = files.filter(d => candidates.has(path.normalize(d.uri.fsPath)));
  if (matches.length > 1) {throw new Error("The component import resolves to multiple files. Resolve the module ambiguity before renaming.");}
  return matches[0];
}

export function planComponentRenameDocuments<T extends RenameSource>(
  document: T, offset: number, newName: string,
  documents: T[]
): Map<T, RenameChange[]> {
  const selected = selectedBinding(document.getText(), offset);
  const oldName = selected.binding.name;
  let owner = document;
  let ownerBinding = selected.binding;
  const imported = requiredFile(document, selected.parsed, selected.binding, documents);
  if (imported) {
    const exportBinding = directExport(analyzeLuaBindings(imported.getText()));
    // Renaming an import alias need not rename its exported function.
    if (exportBinding?.name === oldName) { owner = imported; ownerBinding = exportBinding; }
  }
  const ownerParsed = owner === document ? selected.parsed : analyzeLuaBindings(owner.getText());
  const ownerExportsBinding = directExport(ownerParsed)?.declaration.start === ownerBinding.declaration.start;
  const targets = new Map<T, number>([[document, offset], [owner, ownerBinding.declaration.start]]);
  if (ownerExportsBinding) {
    for (const candidate of documents) {
      if (targets.has(candidate)) {continue;}
      if (!candidate.getText().includes(oldName)) {continue;}
      const parsed = analyzeLuaBindings(candidate.getText());
      const imports = parsed.bindings.filter(b => b.name === oldName && b.scope === parsed.root);
      for (const binding of imports) {
        if (requiredFile(candidate, parsed, binding, documents) === owner) {
          if (targets.has(candidate)) {throw new Error("Multiple component imports in one file are ambiguous.");}
          targets.set(candidate, binding.declaration.start);
        }
      }
    }
  }
  return new Map([...targets].map(([target, location]) =>
    [target, planBindingRename(target.getText(), location, newName)]
  ));
}

export class ComponentRenameProvider implements vscode.RenameProvider {
  constructor(private readonly workspaceIndex: WorkspaceIndex) {}

  async prepareRename(document: vscode.TextDocument, position: vscode.Position): Promise<{ range: vscode.Range; placeholder: string }> {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!range) {throw new Error("Place the cursor on a component identifier.");}
    const name = document.getText(range);
    if (!this.workspaceIndex.knownComponentNames().has(name)) {
      throw new Error(`'${name}' is not an indexed component.`);
    }
    selectedBinding(document.getText(), document.offsetAt(position));
    return { range, placeholder: name };
  }

  async provideRenameEdits(
    document: vscode.TextDocument, position: vscode.Position, newName: string,
    token: vscode.CancellationToken
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const offset = document.offsetAt(position);
    const selected = selectedBinding(document.getText(), offset);
    const oldName = selected.binding.name;
    if (oldName === newName) {return undefined;}
    planBindingRename(document.getText(), offset, newName);
    const uris = await vscode.workspace.findFiles(
      "**/*.{lua,luau}", "**/{Packages,DevPackages,ServerPackages,_Index,node_modules}/**"
    );
    const others = await readRenameFiles(uris, document.uri.toString(), token);
    if (!others) {return undefined;}
    const documents: RenameFile[] = [document, ...others];
    const changesByDocument = planComponentRenameDocuments(document, offset, newName, documents);
    const edit = new vscode.WorkspaceEdit();
    for (const [target, changes] of changesByDocument) {
      if (token.isCancellationRequested) {return undefined;}
      for (const change of changes) {
        edit.replace(target.uri, new vscode.Range(target.positionAt(change.start), target.positionAt(change.end)), change.text);
      }
    }
    return edit;
  }
}

type RenameFile = RenameSource & { positionAt(offset: number): vscode.Position };

const MAX_PARALLEL_RENAME_READS = 8;

/** Read unopened files from disk to avoid extension-wide document-open events. */
async function readRenameFiles(
  uris: vscode.Uri[], skip: string, token: vscode.CancellationToken
): Promise<RenameFile[] | undefined> {
  const open = new Map<string, vscode.TextDocument>();
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isClosed) {open.set(doc.uri.toString(), doc);}
  }
  const files: Array<RenameFile | undefined> = new Array(uris.length);
  let next = 0;
  const worker = async () => {
    while (next < uris.length && !token.isCancellationRequested) {
      const i = next++;
      const uri = uris[i];
      const key = uri.toString();
      if (key === skip) {continue;}
      const doc = open.get(key);
      if (doc) {
        files[i] = doc;
        continue;
      }
      try {
        const text = decodeFileText(await vscode.workspace.fs.readFile(uri));
        let positions: ((offset: number) => vscode.Position) | undefined;
        files[i] = { uri, getText: () => text, positionAt: (offset) => (positions ??= positionsInText(text))(offset) };
      } catch {
        // Skip files that were deleted or became unreadable.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_RENAME_READS, uris.length) }, worker));
  if (token.isCancellationRequested) {return undefined;}
  return files.filter((file): file is RenameFile => file !== undefined);
}
