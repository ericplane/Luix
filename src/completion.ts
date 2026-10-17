import * as vscode from "vscode";
import {
  ANNOTATION_TYPE_HINTS,
  classHierarchy,
  getPropType,
  defaultPropsMap,
  flattenClassEvents,
  flattenClassProps,
  renderTypeSnippet,
} from "./data";
import {
  AliasPartition,
  buildCodeMask,
  findEnclosingFactoryStringArg,
  findEnclosingPropsCall,
  pushUnique,
  scanDocument,
} from "./parser";
import {
  FRAMEWORKS,
  findFrameworkForAlias,
  getAliasPartition,
  getEnabledFrameworks,
} from "./frameworks";
import { getConfig } from "./configCompat";
import { WorkspaceIndex } from "./workspaceIndex";
import { buildImportPath } from "./codeActions";
import { getAutoImportConfig } from "./config";
import { detectFrameworkForDocument } from "./activeFramework";
import { documentDirectCalls } from "./documentCalls";
import { luaTokens } from "./editSyntax";

// Computed-key prefixes, separated by framework; capture group 1 is the partial identifier.
const COMPUTED_KEY_FAST_PATHS = {
  reactEvent: /\[\s*React\.Event\.([A-Za-z_]\w*)?$/,
  reactChange: /\[\s*React\.Change\.([A-Za-z_]\w*)?$/,
  roactEvent: /\[\s*Roact\.Event\.([A-Za-z_]\w*)?$/,
  roactChange: /\[\s*Roact\.Change\.([A-Za-z_]\w*)?$/,
  fusionEvent: /\[\s*OnEvent\s+"([A-Za-z_]\w*)?$/,
  fusionChange: /\[\s*OnChange\s+"([A-Za-z_]\w*)?$/,
  fusionOut: /\[\s*Out\s+"([A-Za-z_]\w*)?$/,
} as const;

export const _internal = {
  COMPUTED_KEY_FAST_PATHS,
};

export class ReactLuauPropsCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private readonly workspaceIndex: WorkspaceIndex) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    const text = document.getText();
    const cursorOffset = document.offsetAt(position);
    const aliases = getAliasPartition();
    const directCalls = documentDirectCalls(text, this.workspaceIndex);
    const directTargets = new Set([
      ...(directCalls.componentNames ?? []), ...(directCalls.instanceNames ?? []),
    ]);
    const detected = findEnclosingPropsCall(
      text,
      cursorOffset,
      aliases,
      directTargets
    );
    if (!detected) {
      return undefined;
    }
    const customDirect = detected.isDirectComponentCall === true &&
      directCalls.componentNames?.has(detected.className) === true;

    const lineText = document.lineAt(position.line).text;
    const before = lineText.slice(0, position.character);
    const active = detectFrameworkForDocument(document).effective;
    const reactEventMatch =
      active === "react"
        ? COMPUTED_KEY_FAST_PATHS.reactEvent.exec(before)
        : null;
    const reactChangeMatch =
      active === "react"
        ? COMPUTED_KEY_FAST_PATHS.reactChange.exec(before)
        : null;
    const roactEventMatch =
      active === "roact"
        ? COMPUTED_KEY_FAST_PATHS.roactEvent.exec(before)
        : null;
    const roactChangeMatch =
      active === "roact"
        ? COMPUTED_KEY_FAST_PATHS.roactChange.exec(before)
        : null;
    const fusionEventMatch =
      active === "fusion"
        ? COMPUTED_KEY_FAST_PATHS.fusionEvent.exec(before)
        : null;
    const fusionChangeMatch =
      active === "fusion"
        ? COMPUTED_KEY_FAST_PATHS.fusionChange.exec(before)
        : null;
    const fusionOutMatch =
      active === "fusion"
        ? COMPUTED_KEY_FAST_PATHS.fusionOut.exec(before)
        : null;
    const wantsEvents =
      reactEventMatch !== null ||
      roactEventMatch !== null ||
      fusionEventMatch !== null;
    const wantsChanges =
      reactChangeMatch !== null ||
      roactChangeMatch !== null ||
      fusionChangeMatch !== null;
    const wantsOut = fusionOutMatch !== null;
    if (wantsEvents || wantsChanges || wantsOut) {
      const baseClass = await resolveEffectiveClass(
        detected.className,
        document,
        this.workspaceIndex,
        customDirect
      );
      if (!baseClass) {
        return undefined;
      }
      const names = wantsEvents
        ? flattenClassEvents(baseClass)
        : flattenClassProps(baseClass);
      const wordRange = document.getWordRangeAtPosition(
        position,
        /[A-Za-z_][A-Za-z0-9_]*/
      );
      const detailKind = wantsEvents
        ? "event"
        : wantsOut
          ? "property (Out binding)"
          : "property (Change listener)";
      const itemKind = wantsEvents
        ? vscode.CompletionItemKind.Event
        : vscode.CompletionItemKind.Property;
      return names.map((name, index) => {
        const item = new vscode.CompletionItem(name, itemKind);
        item.filterText = name;
        item.sortText = String(index).padStart(4, "0");
        item.detail = `${baseClass} ${detailKind}`;
        if (wordRange) {
          item.range = wordRange;
        }
        return item;
      });
    }

    if (!isAtPropKeyPosition(document, position)) {
      return undefined;
    }
    // Other computed-key expressions must not receive ordinary prop names.
    if (isInsideComputedKey(document, position)) {
      return undefined;
    }

    let props = await getPropsForClass(
      detected.className,
      document,
      this.workspaceIndex,
      customDirect
    );
    if (!props || props.length === 0) {
      return undefined;
    }

    // Direct instance calls use Vide's plain event-key syntax.
    let framework =
      detected.alias && findFrameworkForAlias(detected.alias);
    if (
      !framework &&
      !customDirect &&
      detected.isDirectComponentCall &&
      classHierarchy[detected.className]
    ) {
      framework = FRAMEWORKS.vide;
    }
    const eventNames = new Set<string>();
    if (framework && framework.eventsAsProps) {
      const baseClass = await resolveEffectiveClass(
        detected.className,
        document,
        this.workspaceIndex
      );
      if (baseClass) {
        const events = flattenClassEvents(baseClass);
        if (events.length > 0) {
          const merged: string[] = [];
          pushUnique(merged, props);
          pushUnique(merged, events);
          for (const event of events) {
            if (!props.includes(event)) {
              eventNames.add(event);
            }
          }
          props = merged;
        }
      }
    }
    // Parent is a host prop in Fusion/Vide, not an implicit custom-component prop.
    if (
      framework &&
      framework.parentAsProp &&
      classHierarchy[detected.className] &&
      !props.includes("Parent")
    ) {
      props = [...props, "Parent"];
    }

    const wordRange = document.getWordRangeAtPosition(
      position,
      /[A-Za-z_][A-Za-z0-9_]*/
    );

    // Renaming a key must preserve its existing value.
    const hasExistingValue = isFollowedByEquals(
      document,
      wordRange?.end ?? position
    );

    // Consume an existing comma only when the snippet supplies its replacement.
    const effectiveRange = hasExistingValue
      ? wordRange
      : extendRangeOverTrailingComma(document, wordRange, position);

    return buildItemsForProps(
      detected.className,
      props,
      effectiveRange,
      hasExistingValue,
      eventNames
    );
  }
}

function isFollowedByEquals(
  document: vscode.TextDocument,
  endPosition: vscode.Position
): boolean {
  const lineText = document.lineAt(endPosition.line).text;
  for (let i = endPosition.character; i < lineText.length; i++) {
    const c = lineText[i];
    if (c === "=") {
      return lineText[i + 1] !== "=";
    }
    if (c !== " " && c !== "\t") {
      return false;
    }
  }
  return false;
}

function extendRangeOverTrailingComma(
  document: vscode.TextDocument,
  wordRange: vscode.Range | undefined,
  cursor: vscode.Position
): vscode.Range | undefined {
  const searchFrom = wordRange?.end ?? cursor;
  const lineText = document.lineAt(searchFrom.line).text;
  for (let i = searchFrom.character; i < lineText.length; i++) {
    const c = lineText[i];
    if (c === ",") {
      const afterComma = new vscode.Position(searchFrom.line, i + 1);
      return new vscode.Range(wordRange?.start ?? cursor, afterComma);
    }
    if (c !== " " && c !== "\t") {
      return wordRange;
    }
  }
  return wordRange;
}

export class ClassNameCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private readonly workspaceIndex?: WorkspaceIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const text = document.getText();
    const cursorOffset = document.offsetAt(position);
    const aliases = getAliasPartition();
    const ctx = findEnclosingFactoryStringArg(
      text,
      cursorOffset,
      aliases
    );
    if (!ctx) {
      return undefined;
    }

    // Only inline-child frameworks allow an element at a props-table key slot.
    const aliasOffset = findCallAliasOffset(text, ctx);
    if (aliasOffset !== undefined) {
      const outer = findEnclosingPropsCall(
        text,
        aliasOffset,
        aliases,
        this.workspaceIndex?.knownDirectCallTargets()
      );
      if (
        outer &&
        isAtPropKeyPosition(document, document.positionAt(aliasOffset))
      ) {
        const outerFw = outer.alias
          ? findFrameworkForAlias(outer.alias)
          : undefined;
        if (!outerFw || outerFw.childrenLayout !== "inline") {
          return undefined;
        }
      }
    }

    // Exclude the opening quote so VS Code filters against the class name.
    const replaceStart = ctx.stringStart + 1;
    let replaceEnd = cursorOffset;
    if (ctx.stringEnd !== -1) {
      replaceEnd = ctx.stringEnd + 1;
      if (ctx.closeParen !== -1 && !ctx.hasPropsAfter && !ctx.preserveSuffix) {
        replaceEnd = ctx.closeParen + 1;
      }
    }
    const range = new vscode.Range(
      document.positionAt(replaceStart),
      document.positionAt(replaceEnd)
    );

    const q = ctx.quote;
    // Trailing commas are valid for table children, not return values or function arguments.
    const openParenBeforeString =
      ctx.callShape === "parens" || !!ctx.nameStageParens;
    const tailComma =
      !ctx.hasPropsAfter && !ctx.preserveSuffix &&
      isInListElementContext(text, ctx.stringStart, openParenBeforeString) &&
      !hasFollowingListSeparator(text, replaceEnd)
        ? ",$0"
        : "";
    const trailing = (() => {
      if (ctx.hasPropsAfter || ctx.preserveSuffix) {
        return q;
      }
      if (ctx.callShape === "parens") {
        return `${q}, {\n\t$1,\n})${tailComma}`;
      }
      if (ctx.nameStageParens) {
        return `${q})({\n\t$1,\n})${tailComma}`;
      }
      return `${q} {\n\t$1,\n}${tailComma}`;
    })();

    return INSERTABLE_CLASS_NAMES.map((name, index) => {
      const item = new vscode.CompletionItem(
        name,
        vscode.CompletionItemKind.Class
      );
      item.detail = "Roblox class";
      item.sortText = String(index).padStart(4, "0");
      item.filterText = name;
      item.range = range;
      item.insertText = new vscode.SnippetString(`${name}${trailing}`);
      return item;
    });
  }
}

// These inheritance-only classes cannot be constructed.
const SYNTHETIC_CLASSES = new Set([
  "Instance",
  "GuiBase2d",
  "GuiObject",
  "GuiButton",
  "UILayout",
]);

const INSERTABLE_CLASS_NAMES = Object.keys(defaultPropsMap)
  .filter((name) => !SYNTHETIC_CLASSES.has(name))
  .sort();

/** Locate the factory alias for the enclosing props-table check. */
function findCallAliasOffset(
  text: string,
  ctx: import("./parser").EnclosingStringArg
): number | undefined {
  let i = ctx.stringStart - 1;
  while (i >= 0 && /[ \t]/.test(text[i])) {i--;}
  if (ctx.callShape === "parens" || ctx.nameStageParens) {
    i = skipBackOverLeadingArgs(text, i);
    if (text[i] !== "(") {return undefined;}
    i--;
    while (i >= 0 && /[ \t]/.test(text[i])) {i--;}
  }
  while (i >= 0 && /[A-Za-z0-9_.:]/.test(text[i])) {i--;}
  const aliasStart = i + 1;
  return aliasStart < ctx.stringStart ? aliasStart : undefined;
}

/** Skip simple, same-line leading arguments such as New(scope, ...); leave other shapes unchanged. */
function skipBackOverLeadingArgs(text: string, from: number): number {
  if (text[from] !== ",") {return from;}
  let i = from;
  while (i >= 0 && text[i] !== "(" && text[i] !== "\n" && text[i] !== ")") {
    i--;
  }
  return i >= 0 && text[i] === "(" ? i : from;
}

function isPrecededByListElementSeparator(
  text: string,
  pos: number
): boolean {
  const mask = buildCodeMask(text);
  let i = pos - 1;
  while (i >= 0 && (!mask[i] || /\s/.test(text[i]))) {i--;}
  if (i < 0) {return false;}
  const prev = text[i];
  if (prev !== "{" && prev !== ",") {return false;}
  // A comma can separate arguments or assignments; require an enclosing table before appending one.
  const stack: string[] = [];
  const tokens = /[A-Za-z_]\w*|[(){}\[\]]/g;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(text)) && token.index < pos) {
    if (!mask[token.index]) {continue;}
    const c = token[0];
    if (c === "(" || c === "{" || c === "[" ||
        c === "function" || c === "if" || c === "do" || c === "repeat") {
      stack.push(c);
    } else if (c === ")" || c === "}" || c === "]" || c === "end" || c === "until") {
      stack.pop();
    }
  }
  return stack[stack.length - 1] === "{";
}

function hasFollowingListSeparator(text: string, offset: number): boolean {
  const mask = buildCodeMask(text);
  let i = offset;
  while (i < text.length && (!mask[i] || /\s/.test(text[i]))) {
    i++;
  }
  return text[i] === "," || text[i] === ";";
}

/** Resolve the call's start before checking whether it is a table child. */
function isInListElementContext(
  text: string,
  stringStart: number,
  openParenBeforeString: boolean
): boolean {
  let i = stringStart - 1;
  while (i >= 0 && /[ \t]/.test(text[i])) {i--;}
  if (openParenBeforeString) {
    i = skipBackOverLeadingArgs(text, i);
    if (text[i] !== "(") {return false;}
    i--;
    while (i >= 0 && /[ \t]/.test(text[i])) {i--;}
  }
  while (i >= 0 && /[A-Za-z0-9_.:]/.test(text[i])) {i--;}
  return isPrecededByListElementSeparator(text, i + 1);
}

export class FactoryOpenParenCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private readonly workspaceIndex?: WorkspaceIndex) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (
      !getConfig<boolean>(
        "classNameCompletion.triggerOnOpenParen",
        false
      )
    ) {
      return undefined;
    }
    const text = document.getText();
    const offset = document.offsetAt(position);
    const aliases = getAliasPartition();
    if (aliases.parens.length === 0) {return undefined;}
    if (text[offset - 1] !== "(") {return undefined;}
    const mask = buildCodeMask(text);
    if (mask[offset - 1] === false) {return undefined;}
    let i = offset - 2;
    const end = i + 1;
    while (i >= 0 && /[A-Za-z0-9_.]/.test(text[i])) {i--;}
    const alias = text.slice(i + 1, end);
    if (!aliases.parens.includes(alias)) {return undefined;}
    const aliasOffset = i + 1;

    // Only inline-child frameworks permit elements at prop-key positions.
    const outer = findEnclosingPropsCall(
      text,
      aliasOffset,
      aliases,
      this.workspaceIndex?.knownDirectCallTargets()
    );
    if (
      outer &&
      isAtPropKeyPosition(document, document.positionAt(aliasOffset))
    ) {
      const outerFw = outer.alias
        ? findFrameworkForAlias(outer.alias)
        : undefined;
      if (!outerFw || outerFw.childrenLayout !== "inline") {
        return undefined;
      }
    }
    const afterCursor = text[offset] ?? "";
    const autoPairedCloseParen = afterCursor === ")";
    const isEmptyAfter =
      afterCursor === "" ||
      afterCursor === "\n" ||
      autoPairedCloseParen;
    if (!isEmptyAfter) {return undefined;}

    // Consume an auto-paired close so the snippet does not duplicate it.
    const replaceEnd = autoPairedCloseParen ? offset + 1 : offset;
    const range = new vscode.Range(
      position,
      document.positionAt(replaceEnd)
    );

    const tailComma = isPrecededByListElementSeparator(text, i + 1) &&
      !hasFollowingListSeparator(text, replaceEnd)
      ? ",$0"
      : "";

    return INSERTABLE_CLASS_NAMES.map((name, index) => {
      const item = new vscode.CompletionItem(
        name,
        vscode.CompletionItemKind.Class
      );
      item.detail = "Roblox class";
      item.filterText = name;
      item.sortText = String(index).padStart(4, "0");
      item.range = range;
      item.insertText = new vscode.SnippetString(
        `"${name}", {\n\t$1,\n})${tailComma}`
      );
      return item;
    });
  }
}

interface CallShapeContext {
  identStart: number;
  /** Replacement end; may include an auto-paired close. */
  replaceEnd: number;
  trailing: string;
  shapeLabel: string;
}

export class FactoryComponentCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private readonly workspaceIndex: WorkspaceIndex) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    const text = document.getText();
    const offset = document.offsetAt(position);

    let identStart = offset;
    while (identStart > 0 && /[A-Za-z0-9_]/.test(text[identStart - 1])) {
      identStart--;
    }
    const partial = text.slice(identStart, offset);
    if (partial.length === 0) {return undefined;}
    let identEnd = offset;
    while (identEnd < text.length && /[A-Za-z0-9_]/.test(text[identEnd])) {
      identEnd++;
    }

    if (identStart > 0) {
      const mask = buildCodeMask(text);
      if (mask[offset - 1] === false) {return undefined;}
    }
    if (isInsideComputedKey(document, position)) {return undefined;}

    // Member-access tails are not standalone component names.
    if (identStart > 0) {
      const before = text[identStart - 1];
      if (before === "." || before === ":") {return undefined;}
    }

    if (isInTypeDeclaration(document, position)) {return undefined;}
    if (!isComponentValuePosition(text, identStart)) {return undefined;}

    const aliases = getAliasPartition();
    const activeFw = detectFrameworkForDocument(document).effective;
    if (!activeFw) {return undefined;}

    // Only inline-child frameworks allow components at prop-key positions.
    const enclosing = findEnclosingPropsCall(
      text,
      offset,
      aliases,
      this.workspaceIndex.knownDirectCallTargets()
    );
    let directChildSlot = false;
    if (enclosing && isAtPropKeyPosition(document, position)) {
      let framework = enclosing.alias
        ? findFrameworkForAlias(enclosing.alias)
        : undefined;
      if (!framework && enclosing.isDirectComponentCall &&
          documentDirectCalls(text, this.workspaceIndex).instanceNames?.has(enclosing.className)) {
        framework = FRAMEWORKS.vide;
      }
      if (!framework || framework.childrenLayout !== "inline") {
        return undefined;
      }
      directChildSlot = activeFw === "vide";
    }

    const components = this.workspaceIndex.knownComponentNames();
    if (components.size === 0) {return undefined;}
    const matches: string[] = [];
    const lowerPartial = partial.toLowerCase();
    for (const name of components) {
      if (name.toLowerCase().startsWith(lowerPartial)) {
        matches.push(name);
      }
    }
    if (matches.length === 0) {return undefined;}
    matches.sort();

    // Expand known calls; other value expressions may refer to the component function itself.
    const ctx =
      detectReactParensContext(text, identStart, identEnd) ??
      detectDirectCallContext(text, identStart, identEnd, directChildSlot);
    if (!ctx) {return undefined;}

    const range = new vscode.Range(
      document.positionAt(ctx.identStart),
      document.positionAt(ctx.replaceEnd)
    );

    const importConfig = getAutoImportConfig();
    const autoImportEnabled = importConfig.enabled;
    const existingRequires = autoImportEnabled
      ? collectExistingRequires(text)
      : new Set<string>();
    const sameFileComponents = autoImportEnabled
      ? new Set(scanDocument(text, aliases).keys())
      : new Set<string>();
    const insertionLine = autoImportEnabled ? findRequireInsertionLine(text) : 0;
    const insertionPosition = new vscode.Position(insertionLine, 0);

    const out: vscode.CompletionItem[] = [];
    for (let idx = 0; idx < matches.length; idx++) {
      const name = matches[idx];
      const item = new vscode.CompletionItem(
        name,
        vscode.CompletionItemKind.Class
      );
      item.detail = `Luix component (${ctx.shapeLabel})`;
      // Rank above language-server call snippets so the framework form is the default.
      item.sortText = `00_${String(idx).padStart(4, "0")}`;
      item.filterText = name;
      item.range = range;
      item.insertText = new vscode.SnippetString(`${name}${ctx.trailing}`);

      if (
        shouldInsertAutoImport(
          autoImportEnabled,
          name,
          existingRequires,
          sameFileComponents
        )
      ) {
        const found = await this.workspaceIndex.findComponentFile(
          name,
          document.uri.toString()
        );
        if (found) {
          const importPath = buildImportPath(
            document.uri,
            found.uri,
            importConfig
          );
          if (importPath) {
            const importLine = `local ${name} = require(${importPath})\n`;
            item.additionalTextEdits = [
              vscode.TextEdit.insert(insertionPosition, importLine),
            ];
            item.detail = `Luix component (${ctx.shapeLabel}) — auto-imports ${importPath}`;
          }
        }
      }
      out.push(item);
    }
    return out;
  }
}

export function shouldInsertAutoImport(
  autoImportEnabled: boolean,
  name: string,
  existingRequires: ReadonlySet<string>,
  sameFileComponents: ReadonlySet<string>
): boolean {
  return (
    autoImportEnabled &&
    !existingRequires.has(name) &&
    !sameFileComponents.has(name)
  );
}

/** Recognize canonical local Name = require(...) imports; destructuring is not handled. */
function collectExistingRequires(text: string): Set<string> {
  const out = new Set<string>();
  const re = /^\s*local\s+([A-Za-z_]\w*)\s*=\s*require\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1]);
  }
  return out;
}

function findRequireInsertionLine(text: string): number {
  const lines = text.split("\n");
  let lastRequireLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*local\s+[A-Za-z_]\w*\s*=\s*require\b/.test(lines[i])) {
      lastRequireLine = i;
    }
  }
  return lastRequireLine !== -1 ? lastRequireLine + 1 : 0;
}

/** Expand an explicit factory argument only when no props argument or multiline suffix exists. */
function detectReactParensContext(
  text: string,
  identStart: number,
  cursor: number
): CallShapeContext | undefined {
  let i = identStart - 1;
  while (i >= 0 && /[ \t]/.test(text[i])) {i--;}
  if (text[i] !== "(") {return undefined;}
  const parenIdx = i;

  let aliasStart = parenIdx - 1;
  while (aliasStart >= 0 && /[A-Za-z0-9_.]/.test(text[aliasStart])) {
    aliasStart--;
  }
  const alias = text.slice(aliasStart + 1, parenIdx);
  if (alias.length === 0) {return undefined;}
  if (!getAliasPartition().parens.includes(alias)) {return undefined;}

  const tailComma = (end: number) => isPrecededByListElementSeparator(text, aliasStart + 1) &&
    !hasFollowingListSeparator(text, end)
    ? ",$0"
    : "";

  let after = cursor;
  while (after < text.length && /[ \t]/.test(text[after])) {after++;}
  const nextChar = text[after] ?? "";
  if (nextChar === ")") {
    return {
      identStart,
      replaceEnd: after + 1,
      trailing: `, {\n\t$1,\n})${tailComma(after + 1)}`,
      shapeLabel: alias + "(...)",
    };
  }
  if (nextChar === "," || nextChar === "\n" || nextChar === "\r") {
    return {
      identStart,
      replaceEnd: cursor,
      trailing: "",
      shapeLabel: alias + "(...)",
    };
  }
  if (nextChar === "") {
    return {
      identStart,
      replaceEnd: cursor,
      trailing: `, {\n\t$1,\n})${tailComma(cursor)}`,
      shapeLabel: alias + "(...)",
    };
  }
  return undefined;
}

function detectDirectCallContext(
  text: string,
  identStart: number,
  cursor: number,
  expandChild: boolean
): CallShapeContext | undefined {
  const frameworks = getEnabledFrameworks();
  const hasCurried = frameworks.some((f) => f.callShape === "curried");
  if (!hasCurried) {return undefined;}

  let after = cursor;
  while (after < text.length && /[ \t]/.test(text[after])) {after++;}
  const nextChar = text[after] ?? "";
  if (
    nextChar === "(" ||
    nextChar === "{" ||
    nextChar === "." ||
    nextChar === ":" ||
    nextChar === "="
  ) {
    return undefined;
  }

  // Exports, callbacks and assignments must keep function references intact.
  if (!expandChild) {
    return { identStart, replaceEnd: cursor, trailing: "", shapeLabel: "reference" };
  }

  const tailComma = isPrecededByListElementSeparator(text, identStart) &&
    !hasFollowingListSeparator(text, cursor)
    ? ",$0"
    : "";

  return {
    identStart,
    replaceEnd: cursor,
    trailing: ` {\n\t$1,\n}${tailComma}`,
    shapeLabel: "curried",
  };
}

/** Exclude signatures and type positions, including unfinished declarations. */
function isComponentValuePosition(text: string, identStart: number): boolean {
  let tokens: ReturnType<typeof luaTokens>;
  try {
    tokens = luaTokens(text.slice(0, identStart), false);
  } catch {
    return false;
  }
  let declaring = false;
  let awaitingSignature = false;
  let inType = false;
  const delimiters: Array<{ value: string; signature: boolean }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "string") {continue;}
    const value = token.value;
    if (["return", "local", "for", "while", "if", "do", "repeat", "end", ";"].includes(value)) {
      inType = false;
      declaring = value === "local" || value === "for";
    }
    if (value === "type" && tokens[i + 1]?.kind === "word") {inType = true;}
    if (value === "::") {inType = true;}
    if (value === "=" || value === "in") {declaring = false;}
    if (value === "function") {awaitingSignature = true;}
    if (["(", "{", "["].includes(value)) {
      delimiters.push({ value, signature: value === "(" && awaitingSignature });
      if (value === "(") {awaitingSignature = false;}
    } else if ([")", "}", "]"].includes(value)) {
      const closed = delimiters.pop();
      if (closed?.signature) {
        declaring = false;
        if (tokens[i + 1]?.value === ":") {inType = true;}
      }
    }
  }
  if (declaring || awaitingSignature || inType || delimiters.some((entry) => entry.signature)) {
    return false;
  }
  const previous = tokens[tokens.length - 1]?.value;
  return previous !== undefined && new Set([
    "=", "return", "(", "{", ",", ";", "and", "or", "then", "else",
    "+", "-", "*", "/", "%", "^", "..", "==", "~=", "<", ">", "<=", ">=",
  ]).has(previous);
}

export class AnnotationCompletionProvider
  implements vscode.CompletionItemProvider
{
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const lineText = document.lineAt(position.line).text;
    const before = lineText.slice(0, position.character);

    const extendsMatch = /^\s*---\s*@extends\s+([A-Za-z_][A-Za-z0-9_.]*)?$/.exec(
      before
    );
    if (extendsMatch) {
      return this.classNameItems();
    }

    const propMatch =
      /^\s*---\s*@prop\s+[A-Za-z_][A-Za-z0-9_]*\s+([A-Za-z_][A-Za-z0-9_.?]*)?$/.exec(
        before
      );
    if (propMatch) {
      return this.typeNameItems();
    }

    return undefined;
  }

  private classNameItems(): vscode.CompletionItem[] {
    return Object.keys(defaultPropsMap)
      .sort()
      .map((name, index) => {
        const item = new vscode.CompletionItem(
          name,
          vscode.CompletionItemKind.Class
        );
        item.detail = "Roblox class";
        item.sortText = String(index).padStart(4, "0");
        return item;
      });
  }

  private typeNameItems(): vscode.CompletionItem[] {
    return ANNOTATION_TYPE_HINTS.map((name, index) => {
      const item = new vscode.CompletionItem(
        name,
        vscode.CompletionItemKind.TypeParameter
      );
      item.detail = "Luau type";
      item.sortText = String(index).padStart(4, "0");
      return item;
    });
  }
}

export type UserPropsEntry =
  | string[]
  | { extends?: string; props?: string[] };

export async function getPropsForClass(
  className: string,
  document?: vscode.TextDocument,
  workspaceIndex?: WorkspaceIndex,
  preferComponent = false
): Promise<string[] | undefined> {
  const userMap = getConfig<Record<string, UserPropsEntry>>("props", {}) ?? {};
  const aliases = getAliasPartition();
  return resolveProps(
    className,
    userMap,
    document,
    workspaceIndex,
    aliases,
    new Set(),
    0,
    preferComponent
  );
}

async function resolveProps(
  className: string,
  userMap: Record<string, UserPropsEntry>,
  document: vscode.TextDocument | undefined,
  workspaceIndex: WorkspaceIndex | undefined,
  aliases: AliasPartition,
  visited: Set<string>,
  depth: number,
  preferComponent = false
): Promise<string[] | undefined> {
  if (depth > 8 || visited.has(className)) {
    return undefined;
  }
  visited.add(className);

  if (Object.prototype.hasOwnProperty.call(userMap, className)) {
    return resolveUserEntry(
      userMap[className],
      userMap,
      document,
      workspaceIndex,
      aliases,
      visited,
      depth
    );
  }

  // Direct component bindings can shadow Roblox constructor names.
  let info = preferComponent && document
    ? scanDocument(document.getText(), aliases).get(className) : undefined;
  if (preferComponent && !info && workspaceIndex) {
    info = await workspaceIndex.findComponent(className, document?.uri.toString());
  }
  // Quoted host classes retain their built-in defaults.
  if (!info && defaultPropsMap[className]) {
    return defaultPropsMap[className];
  }

  info ??= document ? scanDocument(document.getText(), aliases).get(className) : undefined;
  if (!info && workspaceIndex) {
    info = await workspaceIndex.findComponent(
      className,
      document?.uri.toString()
    );
  }
  if (!info) {
    return undefined;
  }

  const merged: string[] = [];
  pushUnique(merged, info.annotations.props);
  pushUnique(merged, info.paramTypeFields ?? []);
  const base = info.annotations.extendsClass ?? info.detectedBase;
  if (base) {
    const baseProps = await resolveProps(
      base,
      userMap,
      document,
      workspaceIndex,
      aliases,
      visited,
      depth + 1
    );
    if (baseProps) {
      pushUnique(merged, baseProps);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

async function resolveUserEntry(
  entry: UserPropsEntry,
  userMap: Record<string, UserPropsEntry>,
  document: vscode.TextDocument | undefined,
  workspaceIndex: WorkspaceIndex | undefined,
  aliases: AliasPartition,
  visited: Set<string>,
  depth: number
): Promise<string[] | undefined> {
  if (Array.isArray(entry)) {
    return entry.filter((x): x is string => typeof x === "string");
  }
  if (entry && typeof entry === "object") {
    const merged: string[] = [];
    if (Array.isArray(entry.props)) {
      pushUnique(
        merged,
        entry.props.filter((x): x is string => typeof x === "string")
      );
    }
    if (typeof entry.extends === "string") {
      const baseProps = await resolveProps(
        entry.extends,
        userMap,
        document,
        workspaceIndex,
        aliases,
        visited,
        depth + 1
      );
      if (baseProps) {
        pushUnique(merged, baseProps);
      }
    }
    return merged;
  }
  return undefined;
}

/** Resolve a component's extends chain to its Roblox host class. */
export async function resolveEffectiveClass(
  className: string,
  document: vscode.TextDocument | undefined,
  workspaceIndex: WorkspaceIndex | undefined,
  preferComponent = false
): Promise<string | undefined> {
  if (!preferComponent && defaultPropsMap[className]) {
    return className;
  }
  if (!document) {
    return undefined;
  }
  const aliases = getAliasPartition();
  let info = scanDocument(document.getText(), aliases).get(className);
  if (!info && workspaceIndex) {
    info = await workspaceIndex.findComponent(
      className,
      document.uri.toString()
    );
  }
  if (!info) {
    return undefined;
  }
  return info.annotations.extendsClass ?? info.detectedBase;
}

function buildItemsForProps(
  className: string,
  props: string[],
  range: vscode.Range | undefined,
  hasExistingValue: boolean,
  eventNames: ReadonlySet<string> = new Set()
): vscode.CompletionItem[] {
  // Renaming a key must not insert another assignment.
  const snippetMode = hasExistingValue
    ? "name-only"
    : getConfig<string>("snippetMode", "value-with-comma");
  const typeAware = getConfig<boolean>("typeAwareValues", true);

  return props.map((name, index) => {
    if (eventNames.has(name)) {
      const item = new vscode.CompletionItem(
        name,
        vscode.CompletionItemKind.Event
      );
      item.insertText = buildEventHandlerSnippet(name, snippetMode);
      item.detail = `${className} event`;
      item.documentation = new vscode.MarkdownString(
        `\`${className}.${name}\` — event handler — suggested by Luix.`
      );
      item.filterText = name;
      item.sortText = String(index).padStart(4, "0");
      if (range) {
        item.range = range;
      }
      return item;
    }
    const item = new vscode.CompletionItem(
      name,
      vscode.CompletionItemKind.Property
    );
    // Parent is admitted per framework and has no class-hierarchy type entry.
    const propType = !typeAware
      ? undefined
      : name === "Parent"
        ? "Instance"
        : getPropType(className, name);
    item.insertText = buildSnippet(name, snippetMode, propType);
    item.detail = propType
      ? `${className} property — ${propType}`
      : `${className} property`;
    item.documentation = new vscode.MarkdownString(
      `\`${className}.${name}\`${
        propType ? ` — type \`${propType}\`` : ""
      } — suggested by Luix.`
    );
    item.filterText = name;
    item.sortText = String(index).padStart(4, "0");
    if (range) {
      item.range = range;
    }
    // Fresh namespace prefixes open suggestions for constructors and tokens.
    if (!hasExistingValue && shouldAutoTriggerSuggest(propType)) {
      item.command = {
        command: "editor.action.triggerSuggest",
        title: "Show value completions",
      };
    }
    return item;
  });
}

function color3Template(): string {
  const fmt = getConfig<string>("color3.defaultFormat", "fromRGB");
  switch (fmt) {
    case "fromHex":
      return 'Color3.fromHex("${1:#FFFFFF}")';
    case "new":
      return "Color3.new(${1:1}, ${2:1}, ${3:1})";
    case "fromHSV":
      return "Color3.fromHSV(${1:0}, ${2:0}, ${3:1})";
    case "fromRGB":
    default:
      return "Color3.fromRGB(${1:255}, ${2:255}, ${3:255})";
  }
}

/** Insert namespace prefixes so users can choose a constructor or configured token. */
const PREFIX_TRIGGER_TYPES: Record<string, string> = {
  Color3: "Color3.",
  UDim: "UDim.",
  UDim2: "UDim2.",
  Font: "Font.",
};

function buildSnippet(
  name: string,
  mode: string,
  propType: string | undefined
): vscode.SnippetString {
  let valueTemplate = propType ? renderTypeSnippet(propType) : undefined;
  if (propType === "Color3" && valueTemplate) {
    valueTemplate = color3Template();
  }
  const prefix = propType ? PREFIX_TRIGGER_TYPES[propType] : undefined;
  if (prefix) {
    valueTemplate = `${prefix}\${1}`;
  }

  switch (mode) {
    case "name-only":
      return new vscode.SnippetString(name);
    case "value":
      if (valueTemplate) {
        return new vscode.SnippetString(`${name} = ${valueTemplate}$0`);
      }
      return new vscode.SnippetString(`${name} = $0`);
    case "value-with-comma":
    default:
      if (valueTemplate) {
        return new vscode.SnippetString(`${name} = ${valueTemplate},$0`);
      }
      return new vscode.SnippetString(`${name} = $1,$0`);
  }
}

function buildEventHandlerSnippet(
  name: string,
  mode: string
): vscode.SnippetString {
  switch (mode) {
    case "name-only":
      return new vscode.SnippetString(name);
    case "value":
      return new vscode.SnippetString(
        `${name} = function()\n\t$1\nend$0`
      );
    case "value-with-comma":
    default:
      return new vscode.SnippetString(
        `${name} = function()\n\t$1\nend,$0`
      );
  }
}

export function shouldAutoTriggerSuggest(propType: string | undefined): boolean {
  return propType !== undefined && propType in PREFIX_TRIGGER_TYPES;
}

/** Detect a likely prop-key slot by scanning backward to an assignment or table separator. */
export function isAtPropKeyPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  for (let line = position.line; line >= 0; line--) {
    const lineText = document.lineAt(line).text;
    const startCol =
      line === position.line ? position.character - 1 : lineText.length - 1;
    for (let i = startCol; i >= 0; i--) {
      const c = lineText[i];
      if (c === "=") {return false;}
      if (c === "," || c === ";" || c === "{") {return true;}
    }
  }
  return true;
}

/** Detect an unclosed computed key on this line; ordinary prop and snippet providers must stay out. */
export function isInsideComputedKey(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  const line = document.lineAt(position.line).text;
  let depth = 0;
  for (let i = 0; i < position.character && i < line.length; i++) {
    const c = line[i];
    if (c === "[") {depth++;}
    else if (c === "]") {depth--;}
  }
  return depth > 0;
}

/** Detect a type declaration on the current line. */
export function isInTypeDeclaration(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  const before = document
    .lineAt(position.line)
    .text.slice(0, position.character);
  return /\b(?:export\s+|local\s+)?type\s+[A-Za-z_]\w*/.test(before);
}
