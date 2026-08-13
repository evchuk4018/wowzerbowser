const LIST_ITEM_PATTERN = /^[ \t]*(?:\d+[.)]|[-+*•])(?:[ \t]+|$)/;
const LIST_MARKER_ONLY_PATTERN = /^[ \t]*(?:\d+[.)]|[-+*•])[ \t]*$/;

function isListItem(line: string): boolean {
  return LIST_ITEM_PATTERN.test(line);
}

function isListMarkerOnly(line: string): boolean {
  return LIST_MARKER_ONLY_PATTERN.test(line);
}

function mergeFragmentedListMarkers(lines: string[]): string[] {
  const merged: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1];
    if (isListMarkerOnly(line) && next !== undefined && next.trim() && !isListItem(next)) {
      merged.push(`${line.trimEnd()} ${next.trimStart()}`);
      index += 1;
    } else {
      merged.push(line);
    }
  }

  return merged;
}

function normalizeParagraph(paragraph: string): string {
  const lines = mergeFragmentedListMarkers(paragraph.split("\n"));
  return lines.reduce((result, line, index) => {
    if (!line.trim()) return result;
    if (index === 0 || !result) return line;
    return isListItem(line)
      ? `${result.trimEnd()}\n${line}`
      : `${result.trimEnd()} ${line.trimStart()}`;
  }, "");
}

/** Normalize reasoning only at the display boundary; stored text stays raw. */
export function normalizeReasoningText(text: string): string {
  const normalizedLineEndings = text.replace(/\r\n?/g, "\n");
  const repairedListPunctuation = normalizedLineEndings.replace(
    /(^|\n)([ \t]*\d+)[ \t]*\n[ \t]*([.)])(?=$|[ \t\n])/g,
    "$1$2$3",
  );

  return repairedListPunctuation
    .split(/(?:[ \t]*\n){2,}/)
    .map(normalizeParagraph)
    .join("\n\n");
}
