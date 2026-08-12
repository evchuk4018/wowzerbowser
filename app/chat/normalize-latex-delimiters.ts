type ProtectedRange = {
  start: number;
  end: number;
};

function protectedRangesFor(content: string): ProtectedRange[] {
  const protectedRanges: ProtectedRange[] = [];
  let index = 0;

  while (index < content.length) {
    const isLineStart = index === 0 || content[index - 1] === "\n";
    if (isLineStart) {
      let markerIndex = index;
      let indentation = 0;
      while (indentation < 4 && content[markerIndex] === " ") {
        markerIndex += 1;
        indentation += 1;
      }

      const marker = content[markerIndex];
      if (indentation < 4 && (marker === "`" || marker === "~")) {
        let markerLength = 0;
        while (content[markerIndex + markerLength] === marker) markerLength += 1;

        if (markerLength >= 3) {
          let lineEnd = content.indexOf("\n", markerIndex);
          if (lineEnd === -1) lineEnd = content.length;
          let closingEnd = -1;
          let candidate = lineEnd < content.length ? lineEnd + 1 : content.length;

          while (candidate < content.length) {
            let candidateMarkerIndex = candidate;
            let candidateIndentation = 0;
            while (candidateIndentation < 4 && content[candidateMarkerIndex] === " ") {
              candidateMarkerIndex += 1;
              candidateIndentation += 1;
            }

            let candidateMarkerLength = 0;
            while (content[candidateMarkerIndex + candidateMarkerLength] === marker) {
              candidateMarkerLength += 1;
            }

            let candidateLineEnd = content.indexOf("\n", candidateMarkerIndex);
            if (candidateLineEnd === -1) candidateLineEnd = content.length;
            let trailingIndex = candidateMarkerIndex + candidateMarkerLength;
            while (/[ \t\r]/.test(content[trailingIndex] ?? "")) trailingIndex += 1;

            if (
              candidateIndentation < 4
              && candidateMarkerLength >= markerLength
              && candidateMarkerLength >= 3
              && trailingIndex === candidateLineEnd
            ) {
              closingEnd = candidateLineEnd < content.length ? candidateLineEnd + 1 : candidateLineEnd;
              break;
            }

            candidate = candidateLineEnd < content.length ? candidateLineEnd + 1 : content.length;
          }

          protectedRanges.push({ start: index, end: closingEnd === -1 ? content.length : closingEnd });
          index = closingEnd === -1 ? content.length : closingEnd;
          continue;
        }
      }
    }

    if (content[index] === "`") {
      let codeLength = 0;
      while (content[index + codeLength] === "`") codeLength += 1;
      const codeMarker = "`".repeat(codeLength);
      const closingIndex = content.indexOf(codeMarker, index + codeLength);
      if (closingIndex !== -1) {
        protectedRanges.push({ start: index, end: closingIndex + codeLength });
        index = closingIndex + codeLength;
        continue;
      }
    }

    index += 1;
  }

  return protectedRanges;
}

function isEscaped(content: string, index: number): boolean {
  let backslashCount = 0;
  for (let backslashIndex = index - 1; backslashIndex >= 0 && content[backslashIndex] === "\\"; backslashIndex -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function isLikelyCurrencyMarker(content: string, index: number): boolean {
  if (content[index] !== "$" || content[index + 1] === "$" || isEscaped(content, index)) return false;
  if (!/\d/.test(content[index + 1] ?? "")) return false;

  let amountEnd = index + 1;
  while (/[\d,]/.test(content[amountEnd] ?? "")) amountEnd += 1;
  if (content[amountEnd] === "." && /\d/.test(content[amountEnd + 1] ?? "")) {
    amountEnd += 1;
    while (/\d/.test(content[amountEnd] ?? "")) amountEnd += 1;
  }

  const amount = content.slice(index + 1, amountEnd);
  const remainder = content.slice(amountEnd);
  if (!amount || content[amountEnd] === "$" || content[index - 1] === "$") return false;
  if (/^[A-Za-z]/.test(remainder) && amount.length >= 2) return true;
  if (/^\s*[-–—]\s*\$?\d/.test(remainder)) return true;
  if (/^\s+[A-Za-z]/.test(remainder)) return true;
  if (!remainder || /^[.,;:!?)]/.test(remainder) || /^\s*[.,;:!?)]/.test(remainder)) return true;
  const startsMathOperator = /^\s*[+\-/=^_]/.test(remainder) || /^\s*\*(?!\*)/.test(remainder);
  if (amount.includes(",") && !startsMathOperator) return true;
  return false;
}

function escapeCurrencyMarkers(content: string): string {
  const protectedRanges = protectedRangesFor(content);
  let protectedIndex = 0;
  let index = 0;
  let result = "";

  while (index < content.length) {
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && index >= protectedRange.start) {
      result += content.slice(protectedRange.start, protectedRange.end);
      index = protectedRange.end;
      protectedIndex += 1;
      continue;
    }

    if (isLikelyCurrencyMarker(content, index)) result += "\\";
    result += content[index];
    index += 1;
  }

  return result;
}

export function normalizeLatexDelimiters(content: string): string {
  const protectedRanges = protectedRangesFor(content);
  const replacements = new Map<number, string>();
  let protectedIndex = 0;
  let index = 0;

  while (index < content.length) {
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && index >= protectedRange.start) {
      index = protectedRange.end;
      protectedIndex += 1;
      continue;
    }

    if (content[index] !== "\\" || (content[index + 1] !== "[" && content[index + 1] !== "(")) {
      index += 1;
      continue;
    }

    let backslashCount = 0;
    for (let backslashIndex = index; backslashIndex >= 0 && content[backslashIndex] === "\\"; backslashIndex -= 1) {
      backslashCount += 1;
    }
    if (backslashCount % 2 === 0) {
      index += 2;
      continue;
    }

    const closingDelimiter = content[index + 1] === "[" ? "\\]" : "\\)";
    let searchIndex = index + 2;
    let searchProtectedIndex = protectedIndex;
    let closingIndex = -1;

    while (searchIndex < content.length) {
      const searchRange = protectedRanges[searchProtectedIndex];
      if (searchRange && searchIndex >= searchRange.start) {
        searchIndex = searchRange.end;
        searchProtectedIndex += 1;
        continue;
      }

      if (content.startsWith(closingDelimiter, searchIndex)) {
        let closingBackslashCount = 0;
        for (
          let backslashIndex = searchIndex;
          backslashIndex >= 0 && content[backslashIndex] === "\\";
          backslashIndex -= 1
        ) {
          closingBackslashCount += 1;
        }
        if (closingBackslashCount % 2 === 1) {
          closingIndex = searchIndex;
          break;
        }
      }
      searchIndex += 1;
    }

    if (closingIndex !== -1) {
      const replacement = content[index + 1] === "[" ? "$$" : "$";
      replacements.set(index, replacement);
      replacements.set(closingIndex, replacement);
    }
    index += 2;
  }

  if (replacements.size === 0) return escapeCurrencyMarkers(content);

  let result = "";
  let resultIndex = 0;
  protectedIndex = 0;
  while (resultIndex < content.length) {
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && resultIndex >= protectedRange.start) {
      result += content.slice(protectedRange.start, protectedRange.end);
      resultIndex = protectedRange.end;
      protectedIndex += 1;
      continue;
    }

    const replacement = replacements.get(resultIndex);
    if (replacement) {
      result += replacement;
      resultIndex += 2;
    } else {
      result += content[resultIndex];
      resultIndex += 1;
    }
  }

  return escapeCurrencyMarkers(result);
}
