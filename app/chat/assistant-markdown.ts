export type MarkdownTail = {
  completed: string;
  tail: string;
};

type Fence = {
  character: "`" | "~";
  length: number;
};

function fenceFor(line: string): Fence | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  return match ? { character: match[1][0] as Fence["character"], length: match[1].length } : null;
}

function closesFence(line: string, fence: Fence): boolean {
  const pattern = new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`);
  return pattern.test(line);
}

function isListOrQuoteLine(line: string): boolean {
  return /^(?: {0,3}(?:[-+*]|\d+[.)])\s+| {0,3}>)/.test(line);
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") || trimmed.endsWith("|") || /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed);
}

function isIndentedLine(line: string): boolean {
  return /^(?: {4}|\t)/.test(line);
}

function isSafeBoundary(previousLine: string, nextLine: string): boolean {
  return !(isListOrQuoteLine(previousLine) && isListOrQuoteLine(nextLine))
    && !(isTableLine(previousLine) && isTableLine(nextLine))
    && !isIndentedLine(previousLine)
    && !isIndentedLine(nextLine);
}

function updateDisplayMath(line: string, inDisplayMath: boolean): boolean {
  let next = inDisplayMath;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "\\" && (line[index + 1] === "[" || line[index + 1] === "]")) {
      if (line[index + 1] === "[") next = true;
      else next = false;
      index += 1;
      continue;
    }
    if (line[index] !== "$" || line[index + 1] !== "$" || line[index - 1] === "\\") continue;
    next = !next;
    index += 1;
  }
  return next;
}

/**
 * Keep complete Markdown blocks out of the frequently changing streaming
 * tail. Boundaries are deliberately conservative so lists, tables, quotes,
 * indented code, fenced code, and display math stay in one Markdown tree.
 */
export function splitMarkdownTail(markdown: string, streaming: boolean): MarkdownTail {
  if (!streaming || !markdown) return { completed: markdown, tail: "" };

  const lines = markdown.split("\n");
  const boundaries: number[] = [];
  let offset = 0;
  let fence: Fence | null = null;
  let inDisplayMath = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1];
    const lineEnd = offset + line.length;

    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else {
      const nextFence = fenceFor(line);
      if (nextFence) fence = nextFence;
      else inDisplayMath = updateDisplayMath(line, inDisplayMath);
    }

    if (line === "" && nextLine !== undefined && !fence && !inDisplayMath) {
      const previousLine = lines[index - 1] ?? "";
      if (isSafeBoundary(previousLine, nextLine)) boundaries.push(lineEnd + 1);
    }
    offset = lineEnd + 1;
  }

  const splitAt = boundaries.at(-1);
  if (splitAt === undefined) return { completed: "", tail: markdown };
  if (splitAt >= markdown.length) return { completed: markdown, tail: "" };
  return { completed: markdown.slice(0, splitAt), tail: markdown.slice(splitAt) };
}
