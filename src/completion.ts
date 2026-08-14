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

// ----------------------------------------------------------------------
// Computed-key fast-path regexes
// ----------------------------------------------------------------------
//
// Pulled to module scope so the test suite can assert each shape
// directly. Each one matches "cursor just past the dot / opening
// quote of a computed-key handler key", with the partial identifier
// (or empty) in capture group 1.
//
//   React  — `[React.Event.X|]`   `[React.Change.X|]`
//   Roact  — `[Roact.Event.X|]`   `[Roact.Change.X|]`
//   Fusion — `[OnEvent "X|"]`     `[OnChange "X|"]`   `[Out "X|"]`
//
// Vide has no computed-key event syntax (events are plain prop keys
// via `eventsAsProps`) so there's nothing to fast-path here.
//
// React and Roact get separate regexes (not a merged `(?:React|Roact)`
// alternation) so the active-framework gate downstream can suppress
// the Roact shape in React files and vice versa — otherwise typing
// `[Roact.Event.A` in a React-only file would surface Roact suggestions
// the user can't actually use.
const COMPUTED_KEY_FAST_PATHS = {
  reactEvent: /\[\s*React\.Event\.([A-Za-z_]\w*)?$/,
  reactChange: /\[\s*React\.Change\.([A-Za-z_]\w*)?$/,
  roactEvent: /\[\s*Roact\.Event\.([A-Za-z_]\w*)?$/,
  roactChange: /\[\s*Roact\.Change\.([A-Za-z_]\w*)?$/,
  fusionEvent: /\[\s*OnEvent\s+"([A-Za-z_]\w*)?$/,
  fusionChange: /\[\s*OnChange\s+"([A-Za-z_]\w*)?$/,
  fusionOut: /\[\s*Out\s+"([A-Za-z_]\w*)?$/,
} as const;

// Exposed for tests so the suite can verify each fast-path regex
// shape without spinning up a real `TextDocument` + workspace index.
export const _internal = {
  COMPUTED_KEY_FAST_PATHS,
};

// ============================================================================
// Main completion provider — props inside e(...) tables + [React.Event.X]
// ============================================================================

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
    // Single setup pass — both code paths below need these, and each
    // helper does enough work that calling them twice per keystroke
    // (which is how this used to work — the React.Event fast-path
    // re-detected after falling through) was a real cost on big files.
    const aliases = getAliasPartition();
    const directTargets = this.workspaceIndex.knownDirectCallTargets();
    const detected = findEnclosingPropsCall(
      text,
      cursorOffset,
      aliases,
      directTargets
    );
    if (!detected) {
      return undefined;
    }

    // Fast-path: per-framework computed-key event / change / out
    // key completions inside a props table. The cursor must be in
    // the inside of `[...] = ...` for this to fire.
    //
    //   React  — `[React.Event.X|]`   `[React.Change.X|]`
    //   Roact  — `[Roact.Event.X|]`   `[Roact.Change.X|]`
    //   Fusion — `[OnEvent "X|"]`     `[OnChange "X|"]`   `[Out "X|"]`
    //
    // Vide doesn't have a computed-key event syntax — events are
    // plain prop keys via `eventsAsProps`, so there's nothing to
    // fast-path here.
    const lineText = document.lineAt(position.line).text;
    const before = lineText.slice(0, position.character);
    // Active-framework gate — only run the fast-path regexes whose
    // shape belongs to the document's current framework. Without this,
    // typing `[OnEvent "A` in a React file would surface Frame's
    // event list and encourage Fusion syntax in React code (and vice
    // versa). 1.5.0 review finding.
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
        this.workspaceIndex
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

    // Only fire when the cursor is at a *key* slot — not mid-value.
    // Otherwise typing `FontFace = Font.|` would surface every prop
    // name (BackgroundColor3, …) in the suggest list alongside the
    // `Font.fromName` / `Font.fromId` constructors.
    if (!isAtPropKeyPosition(document, position)) {
      return undefined;
    }
    // Also bail when the cursor is inside an unclosed `[` — typing
    // `[React.|` is *not* a fresh key slot, it's the middle of a
    // computed-key expression, and we'd otherwise pollute the
    // suggest list with Frame's `Archivable` / `Name` / etc. The
    // `[React.Event.X|]` / `[React.Change.X|]` fast-path above
    // already returned its own list for those specific shapes; this
    // catches the leftover cases (`[Reac|`, `[myExpr|`, etc.).
    if (isInsideComputedKey(document, position)) {
      return undefined;
    }

    let props = await getPropsForClass(
      detected.className,
      document,
      this.workspaceIndex
    );
    if (!props || props.length === 0) {
      return undefined;
    }

    // Vide-style frameworks treat event handlers as plain table keys
    // (e.g. `Activated = function() … end`). Merge the events of the
    // resolved class into the suggestion list when the matched framework
    // opts in.
    //
    // Vide also lets users construct built-in instances by calling the
    // class name directly — `Frame({ … })`, `TextButton({ … })`. The
    // detector flags those with `isDirectComponentCall=true` and a
    // className that matches Roblox's hierarchy; we attribute them to
    // Vide here so events get merged identically to the canonical
    // `create "Frame" { … }` form.
    let framework =
      detected.alias && findFrameworkForAlias(detected.alias);
    if (
      !framework &&
      detected.isDirectComponentCall &&
      classHierarchy[detected.className]
    ) {
      framework = FRAMEWORKS.vide;
    }
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
          props = merged;
        }
      }
    }

    const wordRange = document.getWordRangeAtPosition(
      position,
      /[A-Za-z_][A-Za-z0-9_]*/
    );

    // If the user is RENAMING an existing entry — i.e. `Pad| = UDim.new(0, 4)` —
    // we shouldn't emit our own `= …,` template; just insert the prop name and
    // keep the existing value intact.
    const hasExistingValue = isFollowedByEquals(
      document,
      wordRange?.end ?? position
    );

    // If the cursor's line already has a trailing `,`, extend the
    // replace range to include it. The snippet still inserts its own
    // comma, so the existing one is naturally overwritten rather than
    // doubled — and `$0` (the snippet's final cursor position) lands
    // AFTER the comma, not between `)` and `,`. Skip this when the
    // user is renaming — we don't want to swallow their value's
    // trailing comma either.
    const effectiveRange = hasExistingValue
      ? wordRange
      : extendRangeOverTrailingComma(document, wordRange, position);

    return buildItemsForProps(
      detected.className,
      props,
      effectiveRange,
      hasExistingValue
    );
  }
}

/**
 * Is the next non-whitespace char after `endPosition` on the same
 * line an `=` (single-assignment, not `==`)? Used to detect that the
 * user is renaming an existing prop entry rather than starting a
 * fresh one.
 */
function isFollowedByEquals(
  document: vscode.TextDocument,
  endPosition: vscode.Position
): boolean {
  const lineText = document.lineAt(endPosition.line).text;
  for (let i = endPosition.character; i < lineText.length; i++) {
    const c = lineText[i];
    if (c === "=") {
      // Skip `==` (comparison) — that's not an assignment.
      return lineText[i + 1] !== "=";
    }
    if (c !== " " && c !== "\t") {
      return false;
    }
  }
  return false;
}

/**
 * If a `,` appears as the next non-whitespace char on the cursor's line
 * after `wordRange`, return a new range covering through that comma.
 * Otherwise return the input range unchanged.
 */
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

// ============================================================================
// Class-name completion — inside `e("Fr|"`, `New "Fr|"`, etc.
// ============================================================================
//
// When the cursor is in the string-literal first argument of a factory
// call, suggest Roblox class names (Frame, TextLabel, …). On accept, also
// add the props braces when they're missing and drop the cursor inside.

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

    // Suppress when the whole `e("…"|)` call is itself at a prop-key
    // slot of an *outer* props table — typing `e("Frame", { e("Te|" })`
    // is invalid Lua (function call as a table key), and we shouldn't
    // pollute the suggest list with class names there. Exception: when
    // the outer framework allows inline children (Vide), the inner
    // call IS a valid child expression at that slot.
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

    // Range starts AFTER the opening quote so VS Code's filter sees the
    // partial class name without the leading `"` (otherwise the filter
    // matches awkwardly and the suggest widget can fail to open while in
    // a string literal).
    const replaceStart = ctx.stringStart + 1;
    let replaceEnd = cursorOffset;
    if (ctx.stringEnd !== -1) {
      replaceEnd = ctx.stringEnd + 1;
      // `closeParen` is only ever set when the paren is ours to
      // rewrite — the call's own `)` for the parens form, the name
      // stage's `)` for `New("Fr|")`.
      if (ctx.closeParen !== -1 && !ctx.hasPropsAfter) {
        replaceEnd = ctx.closeParen + 1;
      }
    }
    const range = new vscode.Range(
      document.positionAt(replaceStart),
      document.positionAt(replaceEnd)
    );

    // Build the trailing chunk that follows the class name in the snippet.
    // The opening quote stays in the document (it's outside the range), so
    // the snippet never re-emits it.
    const q = ctx.quote;
    // Append `,$0` after the closing `}` / `})` *only* when the call sits
    // in a list-element context (its alias is preceded by `{` or `,`) so
    // a following sibling element doesn't need the user to manually add
    // the separator. Skipped in top-level / assignment / function-arg
    // contexts where a trailing comma would be a Lua syntax error.
    const openParenBeforeString =
      ctx.callShape === "parens" || !!ctx.nameStageParens;
    const tailComma =
      !ctx.hasPropsAfter &&
      isInListElementContext(text, ctx.stringStart, openParenBeforeString)
        ? ",$0"
        : "";
    const trailing = (() => {
      if (ctx.hasPropsAfter) {
        // Just re-emit the closing quote — props table already exists.
        return q;
      }
      if (ctx.callShape === "parens") {
        return `${q}, {\n\t$1,\n})${tailComma}`;
      }
      if (ctx.nameStageParens) {
        // Curried, but the class name sits in a parenthesised name
        // stage — close it, then open the props stage the same way
        // StyLua would: `New("Frame")({ … })`.
        return `${q})({\n\t$1,\n})${tailComma}`;
      }
      // Curried form, Lua call sugar (Fusion / Vide).
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

// Synthetic intermediate classes (Instance, GuiBase2d, GuiObject,
// GuiButton, UILayout) exist in the hierarchy for prop inheritance only —
// you can't actually pass them as a factory's first arg, so hide them.
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

/**
 * From a `findEnclosingFactoryStringArg` context, walk back through
 * the call's punctuation (parens or whitespace, then the alias chars)
 * to return the offset where the alias identifier begins. Used by
 * `ClassNameCompletionProvider` to anchor an outer-context check at
 * the same position that `findEnclosingPropsCall` would treat as the
 * "inner element" for prop-key gating.
 *
 * Returns undefined when the structure doesn't look right — caller
 * should treat that as "no outer-context check possible" and fall
 * through to suggestion.
 */
function findCallAliasOffset(
  text: string,
  ctx: import("./parser").EnclosingStringArg
): number | undefined {
  let i = ctx.stringStart - 1;
  // Skip whitespace between the alias's punctuation and the string.
  while (i >= 0 && /[ \t]/.test(text[i])) i--;
  if (ctx.callShape === "parens" || ctx.nameStageParens) {
    // The `(` sits between alias and string — and for Fusion 0.3's
    // `New(scope, "Fr|")` there are leading arguments to step over too.
    i = skipBackOverLeadingArgs(text, i);
    if (text[i] !== "(") return undefined;
    i--;
    while (i >= 0 && /[ \t]/.test(text[i])) i--;
  }
  // Walk back across the alias identifier — dotted forms like
  // `React.createElement` / `Fusion.New`, plus any `scope:` receiver.
  while (i >= 0 && /[A-Za-z0-9_.:]/.test(text[i])) i--;
  const aliasStart = i + 1;
  return aliasStart < ctx.stringStart ? aliasStart : undefined;
}

/**
 * From just left of the class-name string, step back over any
 * preceding arguments in the same call (`New(scope, "Fr|")`) so `i`
 * lands on the call's `(`. Single-line and paren-free by design — the
 * only real-world leading argument is a plain scope variable. Returns
 * `i` unchanged when there's nothing to skip.
 */
function skipBackOverLeadingArgs(text: string, from: number): number {
  if (text[from] !== ",") return from;
  let i = from;
  while (i >= 0 && text[i] !== "(" && text[i] !== "\n" && text[i] !== ")") {
    i--;
  }
  return i >= 0 && text[i] === "(" ? i : from;
}

/**
 * Returns true when the char immediately preceding `pos` (skipping
 * whitespace / newlines) is `{` or `,` — i.e. the construct starting
 * at `pos` is appearing as a list element in a Lua table constructor,
 * where a trailing comma after it is both valid and useful (lets the
 * user drop in a sibling on the next line without manually adding the
 * separator).
 *
 * False otherwise: in `local x = X`, `return X`, `f(X)`, etc., a
 * trailing comma would be a Lua syntax error.
 *
 * The check is intentionally conservative — it only fires the comma
 * for the textbook "child element inside a table" case. Multi-level
 * indirection (`tab = { foo = X }` etc.) falls through to no-comma,
 * which is the safe default.
 */
function isPrecededByListElementSeparator(
  text: string,
  pos: number
): boolean {
  let i = pos - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return false;
  const prev = text[i];
  return prev === "{" || prev === ",";
}

/**
 * Variant for the string-literal class-name path: walks back from the
 * opening quote, across the call's punctuation (an opening `(` when the
 * class name sits in a parenthesised argument list, just whitespace for
 * the curried sugar form) and the alias identifier, then defers to
 * `isPrecededByListElementSeparator` for the actual decision.
 */
function isInListElementContext(
  text: string,
  stringStart: number,
  openParenBeforeString: boolean
): boolean {
  let i = stringStart - 1;
  // Skip whitespace between the alias punctuation and the opening quote.
  while (i >= 0 && /[ \t]/.test(text[i])) i--;
  // Step over the `(` (and any leading `scope,` argument) when present.
  if (openParenBeforeString) {
    i = skipBackOverLeadingArgs(text, i);
    if (text[i] !== "(") return false;
    i--;
    while (i >= 0 && /[ \t]/.test(text[i])) i--;
  }
  // Skip the alias identifier — dotted forms like `React.createElement`,
  // and any `scope:` receiver Fusion 0.3 puts in front of it.
  while (i >= 0 && /[A-Za-z0-9_.:]/.test(text[i])) i--;
  // `i` now points just before the alias's first char.
  return isPrecededByListElementSeparator(text, i + 1);
}

// ============================================================================
// Class-name completion right after `e(` — opt-in, off by default
// ============================================================================
//
// When the user types `e(` (without a quote yet), open the class
// picker and have accept insert the full `"ClassName", { … })` body
// in one go. Off by default because the trigger char `(` fires very
// broadly — every function call in Lua — and the provider has to
// suppress itself in non-factory contexts. Users who want the one-
// keystroke save can opt in via `luix.classNameCompletion.triggerOnOpenParen`.

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
    // We need the cursor to be sitting right after a known factory
    // alias's `(` — possibly with a paired `)` immediately after if
    // the editor auto-paired the bracket.
    const aliases = getAliasPartition();
    if (aliases.parens.length === 0) return undefined;
    // Walk back from cursor: must be `(`.
    if (text[offset - 1] !== "(") return undefined;
    // Suppress when the `(` is inside a string literal — `"some(text"`
    // would otherwise look indistinguishable from a real `e(` call to
    // this walker. The code mask marks string interiors as `false`.
    const mask = buildCodeMask(text);
    if (mask[offset - 1] === false) return undefined;
    // Walk further back over the alias identifier (allow dotted).
    let i = offset - 2;
    const end = i + 1;
    while (i >= 0 && /[A-Za-z0-9_.]/.test(text[i])) i--;
    const alias = text.slice(i + 1, end);
    if (!aliases.parens.includes(alias)) return undefined;
    const aliasOffset = i + 1;

    // Suppress when this call sits at a prop-key slot of an outer
    // props table — same rationale as ClassNameCompletionProvider:
    // typing `e(` at a key position is invalid Lua. Exception: Vide
    // and other inline-children frameworks allow it as a child
    // expression.
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
    // Make sure what's between the `(` and the cursor is empty (we
    // walked back from offset-1 = `(`, so that's already guaranteed).
    // Check what's immediately after the cursor: empty, whitespace, or
    // an auto-paired `)`.
    const afterCursor = text[offset] ?? "";
    const autoPairedCloseParen = afterCursor === ")";
    const isEmptyAfter =
      afterCursor === "" ||
      afterCursor === "\n" ||
      autoPairedCloseParen;
    if (!isEmptyAfter) return undefined;

    // Range covers from the cursor to the auto-paired `)` (if present)
    // so accepting overwrites both rather than leaving a stray `)`.
    const replaceEnd = autoPairedCloseParen ? offset + 1 : offset;
    const range = new vscode.Range(
      position,
      document.positionAt(replaceEnd)
    );

    // Same list-element heuristic the string-literal class-name path
    // uses: trailing comma only when the call is a child element of a
    // table constructor (preceding non-whitespace char is `{` or `,`).
    // The alias starts at `i + 1` (where the loop above left off), so
    // we look at what precedes that.
    const tailComma = isPrecededByListElementSeparator(text, i + 1)
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

// ============================================================================
// Workspace-component completion — every framework's call shape
// ============================================================================
//
// luau-lsp sees workspace components as functions with a
// `(props) -> ReactNode` signature, so accepting one expands it to a
// *call* — `DailyQuestCard(props)`. That's never the form any of the
// supported frameworks actually want:
//
//   - React / Roact (parens):  `e(DailyQuestCard, { … })`
//   - Vide / Fusion (curried): `DailyQuestCard { … }`  (or  `DailyQuestCard({ … })`)
//
// This provider contributes a parallel completion that materialises
// the framework-correct form in one keystroke, ranked above luau-lsp's
// call form so Enter does the right thing by default. luau-lsp's
// suggestion still appears beneath ours, so the choice stays yours.

interface CallShapeContext {
  /** Where the *replacement* range starts (the partial identifier). */
  identStart: number;
  /** Where the *replacement* range ends. May consume an auto-paired close. */
  replaceEnd: number;
  /** Snippet trailing text appended after the component name. */
  trailing: string;
  /** Used in the completion-item detail line for clarity. */
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

    // Walk back over the partial identifier the user has typed so far.
    let identStart = offset;
    while (identStart > 0 && /[A-Za-z0-9_]/.test(text[identStart - 1])) {
      identStart--;
    }
    const partial = text.slice(identStart, offset);
    if (partial.length === 0) return undefined;

    // Suppress when the cursor is inside a string literal — typing
    // `Text = "WEEKLY m|"` shouldn't surface workspace components
    // whose names happen to start with `m`. The code mask flags
    // string interiors as `false`; the partial's last char is what
    // sits immediately before the cursor.
    if (identStart > 0) {
      const mask = buildCodeMask(text);
      if (mask[offset - 1] === false) return undefined;
    }
    // Suppress when the cursor is inside an unclosed `[` — typing
    // `[Reac|` to start `[React.Event.Activated]` shouldn't surface
    // workspace components like `ReactCharm` / `ReactRoblox`. The
    // user is writing a key expression, not invoking a component.
    if (isInsideComputedKey(document, position)) return undefined;

    // Skip when the partial is the tail of a member access (`obj.MyComp`,
    // `self:MyComp`, `Mod.SubMod.MyComp`). The user isn't *invoking* the
    // component there — they're either referencing it or calling a method.
    if (identStart > 0) {
      const before = text[identStart - 1];
      if (before === "." || before === ":") return undefined;
    }

    // Suppress when the cursor is inside a Luau `type X = …` /
    // `export type X = …` declaration. Both the identifier slot
    // (`export type Gamepass|`) and the RHS (`type X = MyComp|`)
    // are TYPE positions, not value positions — surfacing workspace
    // components there is meaningless and pollutes the dropdown when
    // typing type-alias names that share a prefix with components.
    if (isInTypeDeclaration(document, position)) return undefined;

    // File-context gate: workspace-component suggestions only fire in
    // files where Luix has detected an active framework — same
    // precision as the per-document framework detector used by every
    // other 1.5+ provider. A server script / pure-logic module with
    // no UI imports or factory calls returns undefined and the
    // dropdown stays quiet.
    const aliases = getAliasPartition();
    const activeFw = detectFrameworkForDocument(document).effective;
    if (!activeFw) return undefined;

    // Suppress when the cursor is at a prop-*key* slot inside a props
    // table (`e("Frame", { Name = ..., eTextButt|` ). The user is
    // naming a prop, not invoking a component. Exception: Vide allows
    // inline children as table entries (`create "Frame" { eTextButt|`
    // is a valid child expression), so the suppression is gated to
    // frameworks whose `childrenLayout` isn't `"inline"`.
    const enclosing = findEnclosingPropsCall(
      text,
      offset,
      aliases,
      this.workspaceIndex.knownDirectCallTargets()
    );
    if (enclosing && isAtPropKeyPosition(document, position)) {
      const framework = enclosing.alias
        ? findFrameworkForAlias(enclosing.alias)
        : undefined;
      if (!framework || framework.childrenLayout !== "inline") {
        return undefined;
      }
    }

    // Match workspace components by case-insensitive prefix so the
    // dropdown only carries plausibly-relevant entries. Keeps us from
    // dumping all N workspace components on every identifier keystroke.
    const components = this.workspaceIndex.knownComponentNames();
    if (components.size === 0) return undefined;
    const matches: string[] = [];
    const lowerPartial = partial.toLowerCase();
    for (const name of components) {
      if (name.toLowerCase().startsWith(lowerPartial)) {
        matches.push(name);
      }
    }
    if (matches.length === 0) return undefined;
    matches.sort();

    // Figure out which call shape to materialise. The parens-form
    // factories (React, Roact) require `<alias>(<partial>|` — if we're
    // there, that wins. Otherwise we fall back to the direct-call
    // (Vide/Fusion) shape, if a curried framework is enabled.
    const ctx =
      detectReactParensContext(text, identStart, offset) ??
      detectDirectCallContext(text, identStart, offset);
    if (!ctx) return undefined;

    const range = new vscode.Range(
      document.positionAt(ctx.identStart),
      document.positionAt(ctx.replaceEnd)
    );

    // ---- Auto-import setup -------------------------------------------
    //
    // When the user accepts a component that lives in another file
    // and isn't `require`d in the current one, also insert the require
    // line at the top — otherwise the inserted call would compile to a
    // missing-global. Computed *once* for all matches (the
    // import-insertion position + the set of already-required names
    // don't change per item) so this stays cheap on big workspaces.
    //
    // Same-file components are excluded: typing the name of a function
    // declared above in the same file doesn't need an import.
    const importConfig = getAutoImportConfig();
    // Honour `luix.autoImport.enabled` (default off). When disabled the
    // component completion still appears and still materialises the
    // framework-correct call shape — it just doesn't insert a `require`.
    // Previously the require was attached regardless of this setting,
    // which is the "I disabled auto-imports but still get them" report.
    // Skip the (non-trivial) require-scan work entirely when disabled.
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
      // Rank above luau-lsp's call-form so the framework-shape insertion
      // is the default Enter target.
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

/**
 * Whether accepting a component completion should ALSO insert a
 * `require` for it. Gated on `luix.autoImport.enabled` — previously the
 * require was attached regardless of the setting, so disabling
 * auto-imports didn't actually disable them on the completion path.
 * Also skipped when the component is already required or declared in
 * the same file. Pure — unit-tested.
 */
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

/**
 * Collect every locally-bound require'd name from the current file,
 * so the auto-import path doesn't insert a duplicate `local Card =
 * require(...)` when one already exists.
 *
 * Matches `local Name = require(...)` — the canonical Luau import
 * shape Luix already scaffolds. Doesn't try to parse multi-line
 * destructured requires; those are rare and a duplicate require for
 * such cases is at worst harmless code duplication, not a crash.
 */
function collectExistingRequires(text: string): Set<string> {
  const out = new Set<string>();
  const re = /^\s*local\s+([A-Za-z_]\w*)\s*=\s*require\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Find the line index to insert a new `local X = require(...)` on —
 * mirrors `findImportInsertionLine` in `src/codeActions.ts` (kept as
 * a private copy so the completion path doesn't have to reach across
 * module boundaries for this one helper). Returns the line *after*
 * the last existing require, or — if there are no requires — line 0.
 */
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

/**
 * React/Roact case: cursor is in `<parens-alias>(<partial>|`.
 *   `e(D|`              → insert `Name, {\n\t$1,\n})`
 *   `e(D|)`             → same, consume the auto-paired `)`
 *   `e(D|, { ... })`    → insert just `Name` — props arg already exists
 *   `e(D|<other>`       → bail (broken / unfamiliar structure)
 */
function detectReactParensContext(
  text: string,
  identStart: number,
  cursor: number
): CallShapeContext | undefined {
  // Look back across optional whitespace, then expect `(`.
  let i = identStart - 1;
  while (i >= 0 && /[ \t]/.test(text[i])) i--;
  if (text[i] !== "(") return undefined;
  const parenIdx = i;

  // Alias identifier (possibly dotted) directly before the `(`.
  let aliasStart = parenIdx - 1;
  while (aliasStart >= 0 && /[A-Za-z0-9_.]/.test(text[aliasStart])) {
    aliasStart--;
  }
  const alias = text.slice(aliasStart + 1, parenIdx);
  if (alias.length === 0) return undefined;
  if (!getAliasPartition().parens.includes(alias)) return undefined;

  // Append `,$0` after the closing `})` only when this call sits as a
  // list element of a parent table — otherwise a trailing comma after
  // a top-level / assigned / return-value call would be a syntax
  // error. Same heuristic as the string-literal class-name path.
  const tailComma = isPrecededByListElementSeparator(text, aliasStart + 1)
    ? ",$0"
    : "";

  // Inspect what follows the cursor to decide between full expansion,
  // identifier-only, and bail-out.
  let after = cursor;
  while (after < text.length && /[ \t]/.test(text[after])) after++;
  const nextChar = text[after] ?? "";
  if (nextChar === ")") {
    return {
      identStart,
      replaceEnd: after + 1,
      trailing: `, {\n\t$1,\n})${tailComma}`,
      shapeLabel: alias + "(...)",
    };
  }
  if (nextChar === ",") {
    return {
      identStart,
      replaceEnd: cursor,
      trailing: "",
      shapeLabel: alias + "(...)",
    };
  }
  if (nextChar === "" || nextChar === "\n" || nextChar === "\r") {
    return {
      identStart,
      replaceEnd: cursor,
      trailing: `, {\n\t$1,\n})${tailComma}`,
      shapeLabel: alias + "(...)",
    };
  }
  return undefined;
}

/**
 * Vide/Fusion case: bare `<partial>|` at a value-expression position.
 * Inserts the curried form `Name {\n\t$1,\n}` because it's the
 * idiomatic shape in both frameworks. Suppressed when:
 *
 *   - Neither Vide nor Fusion is enabled (no point — direct calls
 *     aren't a React/Roact idiom).
 *   - The next non-whitespace char is `(`, `{`, `.`, `:`, or `=` —
 *     the user is already extending the identifier into a call /
 *     access / assignment, our snippet would conflict.
 */
function detectDirectCallContext(
  text: string,
  identStart: number,
  cursor: number
): CallShapeContext | undefined {
  const frameworks = getEnabledFrameworks();
  const hasCurried = frameworks.some((f) => f.callShape === "curried");
  if (!hasCurried) return undefined;

  let after = cursor;
  while (after < text.length && /[ \t]/.test(text[after])) after++;
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

  // Trailing-comma decision: bare `Comp {…}` inside a parent table
  // ought to end with `,` so a following sibling doesn't trip a parse
  // error. Skipped for top-level / return / assignment positions.
  const tailComma = isPrecededByListElementSeparator(text, identStart)
    ? ",$0"
    : "";

  return {
    identStart,
    replaceEnd: cursor,
    trailing: ` {\n\t$1,\n}${tailComma}`,
    shapeLabel: "curried",
  };
}

// ============================================================================
// Annotation completion — `---@extends X` and `---@prop NAME Type`
// ============================================================================

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

// ============================================================================
// getPropsForClass — async resolver with extends chain + workspace fallback
// ============================================================================

export type UserPropsEntry =
  | string[]
  | { extends?: string; props?: string[] };

export async function getPropsForClass(
  className: string,
  document?: vscode.TextDocument,
  workspaceIndex?: WorkspaceIndex
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
    0
  );
}

async function resolveProps(
  className: string,
  userMap: Record<string, UserPropsEntry>,
  document: vscode.TextDocument | undefined,
  workspaceIndex: WorkspaceIndex | undefined,
  aliases: AliasPartition,
  visited: Set<string>,
  depth: number
): Promise<string[] | undefined> {
  if (depth > 8 || visited.has(className)) {
    return undefined;
  }
  visited.add(className);

  // 1. User config wins outright.
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

  // 2. Built-in defaults win outright.
  if (defaultPropsMap[className]) {
    return defaultPropsMap[className];
  }

  // 3. Custom component: same-file inference first, then workspace-wide.
  let info = document
    ? scanDocument(document.getText(), aliases).get(className)
    : undefined;
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

/**
 * Used by the Event/Change completion path: resolve a component name down
 * to the Roblox host class it ultimately extends.
 */
export async function resolveEffectiveClass(
  className: string,
  document: vscode.TextDocument | undefined,
  workspaceIndex: WorkspaceIndex | undefined
): Promise<string | undefined> {
  if (defaultPropsMap[className]) {
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

// ============================================================================
// CompletionItem builders
// ============================================================================

function buildItemsForProps(
  className: string,
  props: string[],
  range: vscode.Range | undefined,
  hasExistingValue: boolean
): vscode.CompletionItem[] {
  // When the user is renaming an existing entry (`Pad| = UDim.new(...)`),
  // override the configured snippet mode and emit just the prop name —
  // anything else would inject a duplicate `= …` and corrupt the line.
  const snippetMode = hasExistingValue
    ? "name-only"
    : getConfig<string>("snippetMode", "value-with-comma");
  const typeAware = getConfig<boolean>("typeAwareValues", true);

  return props.map((name, index) => {
    const item = new vscode.CompletionItem(
      name,
      vscode.CompletionItemKind.Property
    );
    const propType = typeAware ? getPropType(className, name) : undefined;
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
    // For Color3 / UDim / Font props in fresh-entry mode, the snippet
    // drops a namespace prefix (`Color3.`) and parks the cursor right
    // after the dot — auto-open the suggest dropdown so the user can
    // pick a constructor or token. Skip the auto-trigger in
    // rename mode since we only emit the name, no value.
    if (!hasExistingValue && shouldAutoTriggerSuggest(propType)) {
      item.command = {
        command: "editor.action.triggerSuggest",
        title: "Show value completions",
      };
    }
    return item;
  });
}

/**
 * Resolve the snippet body for a Color3 value, honouring
 * `luix.color3.defaultFormat`. Defaults to `fromRGB` so existing
 * behavior is preserved.
 */
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

/**
 * Types where the snippet should drop a namespace prefix (`Color3.`,
 * `UDim.`, `UDim2.`, `Font.`) and immediately open the suggest dropdown
 * so the user can pick from constructors AND palette/spacing/fonts
 * tokens.
 *
 * Picking a constructor (e.g. `fromRGB` for Color3, `fromScale` for
 * UDim2) inserts its own snippet with per-channel tab stops, so the
 * Tab-through-each-value workflow is preserved if the user wants it.
 * Picking a token (e.g. `palette.primary`) replaces the prefix with
 * the full literal.
 *
 * UDim2 lives here because `.fromScale(x, y)` and `.fromOffset(x, y)`
 * are at least as common as `.new(0, 0, 0, 0)` in modern Vide/React
 * code — auto-inserting `.new` was forcing users to delete-and-retype.
 */
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
    // For these types, hand control over to the suggest dropdown
    // immediately after insertion. The $1 marks the cursor; the
    // accompanying `command` on the completion item fires
    // `editor.action.triggerSuggest` so the user sees both constructor
    // options and any defined palette/spacing/fonts tokens.
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

/** True for props whose accepted completion should auto-open the suggest
 *  dropdown so the user can immediately pick a constructor or token. */
export function shouldAutoTriggerSuggest(propType: string | undefined): boolean {
  return propType !== undefined && propType in PREFIX_TRIGGER_TYPES;
}

/**
 * True when the cursor is at a position where a *key* (prop name)
 * would be typed in a table — i.e. the start of a new line, right
 * after the props `{`, or right after a preceding `,` / `;`. Returns
 * false when the cursor is inside a value expression: walking back
 * across the same line and prior lines hits `=` before any
 * key-introducing token.
 *
 * Exported so the anchor-preset provider can apply the same check.
 */
export function isAtPropKeyPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  // Walk back line by line until we hit a significant boundary char.
  // Identifier chars, dots, brackets, parens etc. are ignored — they
  // may be the partial token the user is currently typing.
  for (let line = position.line; line >= 0; line--) {
    const lineText = document.lineAt(line).text;
    const startCol =
      line === position.line ? position.character - 1 : lineText.length - 1;
    for (let i = startCol; i >= 0; i--) {
      const c = lineText[i];
      if (c === "=") return false; // value position
      if (c === "," || c === ";" || c === "{") return true;
    }
  }
  // No boundary found — assume key position (top of file, no `=`).
  return true;
}

/**
 * True when the cursor sits inside an unclosed `[` on the current
 * line — i.e. somewhere inside a computed-key expression like
 * `[React.Event.Foo|]`. Used by the prop / component / snippet
 * providers to bail when they'd otherwise treat the inside of the
 * brackets as a fresh key slot (because `isAtPropKeyPosition` walks
 * back through `[` and `]` indiscriminately) and pollute the
 * suggest list with prop names that would land inside the expression.
 *
 * The dedicated `[React.Event.X|]` / `[React.Change.X|]` fast-path
 * in `ReactLuauPropsCompletionProvider` deliberately *does* fire
 * inside computed keys; callers gating on this helper run *after*
 * that fast-path so it stays unaffected.
 */
export function isInsideComputedKey(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  const line = document.lineAt(position.line).text;
  let depth = 0;
  for (let i = 0; i < position.character && i < line.length; i++) {
    const c = line[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  return depth > 0;
}

// Note (1.5.0): the previous `looksLikeUIFile()` helper and its
// `UI_REQUIRE_RE` regex used to gate the component-completion path.
// They were removed when the per-file framework detector replaced
// that gate: callers now use `detectFrameworkForDocument(doc).effective`
// instead, which is strictly more precise (it also tells us *which*
// framework, not just "yes this is UI"). Kept this note so a future
// refactor doesn't reintroduce the helper without realising the
// detector already covers it.

/**
 * True when the current line is a Luau `type X = …` /
 * `export type X = …` declaration. Both the identifier slot
 * (cursor on the X) and the RHS (cursor after the `=`) are TYPE
 * positions, not value positions — Luix's workspace-component
 * suggestions are meaningless there and would otherwise pollute the
 * dropdown with components that share a prefix with the type name
 * the user is typing (the common case: `type Gamepass|` surfacing
 * `GamepassCard`, `GamepassHero`, … because every component is
 * detected as a potential direct-call target).
 *
 * Lookbehind is line-scoped — multi-line type aliases (a record
 * type wrapped onto several lines) aren't detected, but the only
 * way to land workspace-component suggestions inside one is to
 * type a bare identifier mid-record, which doesn't match any
 * component name in practice.
 */
export function isInTypeDeclaration(
  document: vscode.TextDocument,
  position: vscode.Position
): boolean {
  const before = document
    .lineAt(position.line)
    .text.slice(0, position.character);
  // `(local )?(export )?type IDENT` — the `IDENT` is the alias name;
  // anything after the alias's `=` is still inside the declaration.
  return /\b(?:export\s+|local\s+)?type\s+[A-Za-z_]\w*/.test(before);
}
