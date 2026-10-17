/** Match parentheses or return -1; callers must mask strings first. */
export function findMatchingParen(text: string, openIdx: number): number {
  let depth = 1;
  for (let i = openIdx + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** Match braces or return -1; callers must mask strings first. */
export function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 1;
  for (let i = openIdx + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

export function skipWs(text: string, start: number, end: number): number {
  let i = start;
  while (i < end && /\s/.test(text[i])) {
    i++;
  }
  return i;
}

/** Trim a [start, end) range without allocating a string. */
export function trimRange(
  text: string,
  start: number,
  end: number
): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) {
    s++;
  }
  while (e > s && /\s/.test(text[e - 1])) {
    e--;
  }
  return { start: s, end: e };
}

/** Split and trim top-level arguments, ignoring commas nested in parentheses or braces. */
export function splitTopLevelArgs(
  text: string,
  start: number,
  end: number
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let pDepth = 0;
  let bDepth = 0;
  let argStart = start;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === "(") {
      pDepth++;
    } else if (c === ")") {
      pDepth--;
    } else if (c === "{") {
      bDepth++;
    } else if (c === "}") {
      bDepth--;
    } else if (c === "," && pDepth === 0 && bDepth === 0) {
      const trimmed = trimRange(text, argStart, i);
      if (trimmed.start < trimmed.end) {
        out.push(trimmed);
      }
      argStart = i + 1;
    }
  }
  const last = trimRange(text, argStart, end);
  if (last.start < last.end) {
    out.push(last);
  }
  return out;
}
