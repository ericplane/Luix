import { PropEntry } from "./parser";
import { applyTextChanges, luaTokens } from "./editSyntax";

/** Rewrite existing literal fields and append new ones in a single replacement.
 * Separator decisions use the resulting body, so additions never duplicate a
 * missing comma or put it inside a trailing comment. */
export function rewriteLiteralProps(
  body: string,
  entries: PropEntry[],
  updates: Array<{ key: string; value: string; remove: boolean }>,
  indent: string
): string {
  const changes: Array<{ start: number; end: number; text: string }> = [];
  const additions: string[] = [];
  for (const update of updates) {
    const existing = entries.filter(e => e.key === update.key);
    if (existing.length > 1) {throw new Error(`Remove duplicate ${update.key} fields before editing.`);}
    const entry = existing[0];
    if (!entry) {
      if (!update.remove) {additions.push(`${update.key} = ${update.value},`);}
      continue;
    }
    if (!update.remove) {
      changes.push({ start: entry.valueStart, end: entry.valueEnd, text: update.value });
      continue;
    }
    let end = entry.valueEnd;
    while (end < body.length && /[ \t]/.test(body[end])) {end++;}
    if (body[end] === "," || body[end] === ";") {end++;}
    changes.push({ start: entry.keyStart, end, text: "" });
  }
  let result = applyTextChanges(body, changes);
  if (additions.length === 0) {return result;}
  const last = luaTokens(result, false).at(-1);
  if (last && last.value !== "," && last.value !== ";") {
    result = result.slice(0, last.end) + "," + result.slice(last.end);
  }
  const closingIndent = /\n([ \t]*)$/.exec(body)?.[1] ?? "";
  return result.trimEnd() + "\n" + additions.map(s => indent + s).join("\n") + "\n" + closingIndent;
}
