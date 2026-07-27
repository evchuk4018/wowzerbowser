import type { ChatToolCall } from "../../../lib/chat-protocol";

const DSML_BAR = "[|\uFF5C]";
const DSML_BAR_RUN = `${DSML_BAR}(?:\\s*${DSML_BAR})?`;
const DSML_BLOCK_NAMES = "(?:tool_calls|function_calls)";
const DSML_TAG_PREFIX = `<\\s*${DSML_BAR_RUN}\\s*DSML\\s*${DSML_BAR_RUN}\\s*`;
const DSML_CLOSE_TAG_PREFIX = `</\\s*${DSML_BAR_RUN}\\s*DSML\\s*${DSML_BAR_RUN}\\s*`;

const BLOCK_START_RE = new RegExp(
  `${DSML_TAG_PREFIX}(${DSML_BLOCK_NAMES})\\s*>`,
  "u",
);
const BLOCK_END_RE = new RegExp(
  `${DSML_CLOSE_TAG_PREFIX}(${DSML_BLOCK_NAMES})\\s*>`,
  "gu",
);
const INVOKE_OPEN_RE = new RegExp(
  `${DSML_TAG_PREFIX}invoke\\b([^>]*)>`,
  "u",
);
const INVOKE_END_RE = new RegExp(`${DSML_CLOSE_TAG_PREFIX}invoke\\s*>`, "u");
const PARAMETER_OPEN_RE = new RegExp(
  `${DSML_TAG_PREFIX}parameter\\b([^>]*)>`,
  "u",
);
const PARAMETER_END_RE = new RegExp(`${DSML_CLOSE_TAG_PREFIX}parameter\\s*>`, "gu");

const DSML_BAR_VARIANTS = ["|", "\uFF5C", "||", "\uFF5C\uFF5C", "|\uFF5C", "\uFF5C|"];
const BLOCK_START_TOKENS = DSML_BAR_VARIANTS.flatMap((openingBar) =>
  DSML_BAR_VARIANTS.flatMap((closingBar) => [
    `<${openingBar}DSML${closingBar}tool_calls>`,
    `<${openingBar}DSML${closingBar}function_calls>`,
  ]),
);
const DSML_PREFIX_RE = /^<\/?[|\uFF5C]{0,2}(?:D(?:S(?:M(?:L)?)?)?)?$/u;
const INVALID_DSML_BAR_RUN_RE = /<\s*\/?\s*(?:[|\uFF5C]\s*){3}/u;
const DSML_LIKE_RE = /<\s*\/?\s*[|\uFF5C\s]*DSML\b/giu;

type ParsedAttributeMap = Map<string, string>;

export type DeepSeekDsmlParseResult = {
  content: string;
  toolCalls: ChatToolCall[];
  /** True when a complete or truncated DSML block was rejected. */
  rejected: boolean;
};

let nextDsmlCallId = 0;

function nextCallId(): string {
  nextDsmlCallId += 1;
  return `dsml_call_${nextDsmlCallId}`;
}

function skipWhitespace(value: string, offset: number, limit = value.length): number {
  while (offset < limit && /\s/u.test(value[offset] ?? "")) offset += 1;
  return offset;
}

function parseAttributes(source: string): ParsedAttributeMap | null {
  const attributes = new Map<string, string>();
  let offset = 0;

  while (offset < source.length) {
    offset = skipWhitespace(source, offset);
    if (offset >= source.length) break;

    const nameMatch = /^[A-Za-z_][A-Za-z0-9_-]*/u.exec(source.slice(offset));
    if (!nameMatch) return null;
    const name = nameMatch[0];
    offset += name.length;
    offset = skipWhitespace(source, offset);
    if (source[offset] !== "=") return null;
    offset = skipWhitespace(source, offset + 1);

    const quote = source[offset];
    if (quote !== '"' && quote !== "'") return null;
    const valueStart = offset + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0) return null;
    if (attributes.has(name)) return null;
    attributes.set(name, source.slice(valueStart, valueEnd));
    offset = valueEnd + 1;
  }

  return attributes;
}

function matchAt(regex: RegExp, value: string, offset: number): RegExpExecArray | null {
  regex.lastIndex = 0;
  const match = regex.exec(value.slice(offset));
  return match && match.index === 0 ? match : null;
}

function partialMarkerOverlap(value: string): number {
  for (let start = value.length - 1; start >= 0; start -= 1) {
    if (value[start] !== "<") continue;
    const suffix = value.slice(start);
    const normalized = suffix.replace(/\s+/gu, "");
    if (BLOCK_START_TOKENS.some((token) => token.startsWith(normalized))) return suffix.length;
    if (DSML_PREFIX_RE.test(normalized)) return suffix.length;
  }
  return 0;
}

function findDsmlLikeTag(value: string): RegExpExecArray | null {
  DSML_LIKE_RE.lastIndex = 0;
  return DSML_LIKE_RE.exec(value);
}

function findInvalidDsmlBarRun(value: string): RegExpExecArray | null {
  return INVALID_DSML_BAR_RUN_RE.exec(value);
}

function parseBlock(block: string): ChatToolCall[] | null {
  const start = block.match(BLOCK_START_RE);
  BLOCK_END_RE.lastIndex = 0;
  const endMatches = [...block.matchAll(BLOCK_END_RE)];
  const end = endMatches.at(-1);
  if (!start || !end || end.index === undefined || start[1] !== end[1]) return null;

  const bodyStart = start[0].length;
  const bodyEnd = end.index;
  if (bodyEnd < bodyStart) return null;

  const calls: ChatToolCall[] = [];
  let offset = bodyStart;

  while (offset < bodyEnd) {
    offset = skipWhitespace(block, offset, bodyEnd);
    if (offset >= bodyEnd) break;

    const invoke = matchAt(INVOKE_OPEN_RE, block, offset);
    if (!invoke) return null;
    const invokeAttributes = parseAttributes(invoke[1] ?? "");
    const name = invokeAttributes?.size === 1 ? invokeAttributes.get("name") : undefined;
    if (!name) return null;
    offset += invoke[0].length;

    const parameters: Record<string, unknown> = {};
    let invokeClosed = false;
    while (offset < bodyEnd) {
      offset = skipWhitespace(block, offset, bodyEnd);
      const invokeEnd = matchAt(INVOKE_END_RE, block, offset);
      if (invokeEnd) {
        offset += invokeEnd[0].length;
        invokeClosed = true;
        break;
      }

      const parameter = matchAt(PARAMETER_OPEN_RE, block, offset);
      if (!parameter) return null;
      const parameterAttributes = parseAttributes(parameter[1] ?? "");
      const parameterName = parameterAttributes?.get("name");
      const stringMode = parameterAttributes?.get("string");
      if (
        !parameterAttributes ||
        parameterAttributes.size !== 2 ||
        !parameterName ||
        (stringMode !== "true" && stringMode !== "false") ||
        Object.prototype.hasOwnProperty.call(parameters, parameterName)
      ) {
        return null;
      }
      offset += parameter[0].length;

      PARAMETER_END_RE.lastIndex = offset;
      const parameterEnd = PARAMETER_END_RE.exec(block);
      if (!parameterEnd || parameterEnd.index >= bodyEnd) return null;
      const invokeEndBeforeParameter = matchAt(INVOKE_END_RE, block, offset);
      if (invokeEndBeforeParameter && invokeEndBeforeParameter.index === 0) return null;

      const rawValue = block.slice(offset, parameterEnd.index);
      if (stringMode === "true") {
        parameters[parameterName] = rawValue;
      } else {
        try {
          parameters[parameterName] = JSON.parse(rawValue);
        } catch {
          return null;
        }
      }
      offset = parameterEnd.index + parameterEnd[0].length;
    }

    if (!invokeClosed) return null;
    let argumentsJson: string;
    try {
      argumentsJson = JSON.stringify(parameters);
    } catch {
      return null;
    }
    calls.push({ id: nextCallId(), name, arguments: argumentsJson });
  }

  return calls.length ? calls : null;
}

function emptyResult(): DeepSeekDsmlParseResult {
  return { content: "", toolCalls: [], rejected: false };
}

/**
 * Incremental parser for DeepSeek V4's DSML tool-call content format.
 *
 * DSML is intentionally parsed as a small protocol rather than XML: parameter
 * values are opaque until their closing DSML token, and non-string values are
 * parsed as JSON only after the complete invoke is available.
 */
export class DeepSeekDsmlParser {
  private buffer = "";
  private inBlock = false;
  private finished = false;

  feed(content: string): DeepSeekDsmlParseResult {
    if (this.finished || !content) return emptyResult();
    this.buffer += content;
    return this.drain(false);
  }

  finish(): DeepSeekDsmlParseResult {
    if (this.finished) return emptyResult();
    this.finished = true;
    return this.drain(true);
  }

  private drain(final: boolean): DeepSeekDsmlParseResult {
    const result = emptyResult();

    while (this.buffer) {
      if (!this.inBlock) {
        BLOCK_START_RE.lastIndex = 0;
        const start = BLOCK_START_RE.exec(this.buffer);
        if (start) {
          result.content += this.buffer.slice(0, start.index);
          this.buffer = this.buffer.slice(start.index);
          this.inBlock = true;
          continue;
        }

        if (!final) {
          const overlap = partialMarkerOverlap(this.buffer);
          const dsmlLike = findDsmlLikeTag(this.buffer);
          const invalidBarRun = findInvalidDsmlBarRun(this.buffer);
          const partialStart = this.buffer.length - overlap;
          if (invalidBarRun && invalidBarRun.index !== undefined) {
            result.content += this.buffer.slice(0, invalidBarRun.index);
            const tagEnd = this.buffer.indexOf(">", invalidBarRun.index + invalidBarRun[0].length);
            this.buffer = tagEnd >= 0 ? this.buffer.slice(tagEnd + 1) : "";
            result.rejected = true;
            continue;
          }
          if (dsmlLike && dsmlLike.index !== undefined && dsmlLike.index < partialStart) {
            result.content += this.buffer.slice(0, dsmlLike.index);
            const tagEnd = this.buffer.indexOf(">", dsmlLike.index + dsmlLike[0].length);
            this.buffer = tagEnd >= 0 ? this.buffer.slice(tagEnd + 1) : "";
            result.rejected = true;
            continue;
          }
          if (overlap) {
            const safeLength = this.buffer.length - overlap;
            if (safeLength > 0) {
              result.content += this.buffer.slice(0, safeLength);
              this.buffer = this.buffer.slice(safeLength);
            }
            break;
          }
          if (dsmlLike && dsmlLike.index !== undefined) {
            result.content += this.buffer.slice(0, dsmlLike.index);
            const tagEnd = this.buffer.indexOf(">", dsmlLike.index + dsmlLike[0].length);
            this.buffer = tagEnd >= 0 ? this.buffer.slice(tagEnd + 1) : "";
            result.rejected = true;
            continue;
          }
          result.content += this.buffer;
          this.buffer = "";
          break;
        }

        const invalidBarRun = findInvalidDsmlBarRun(this.buffer);
        const dsmlLike = findDsmlLikeTag(this.buffer);
        const malformed = invalidBarRun ?? dsmlLike;
        if (malformed && malformed.index !== undefined) {
          result.content += this.buffer.slice(0, malformed.index);
          const tagEnd = this.buffer.indexOf(">", malformed.index + malformed[0].length);
          this.buffer = tagEnd >= 0 ? this.buffer.slice(tagEnd + 1) : "";
          result.rejected = true;
          continue;
        }

        if (final) {
          result.content += this.buffer;
          this.buffer = "";
          break;
        }
        break;
      }

      BLOCK_END_RE.lastIndex = 0;
      const end = BLOCK_END_RE.exec(this.buffer);
      if (!end || end.index === undefined) {
        if (final) {
          this.buffer = "";
          result.rejected = true;
        }
        break;
      }

      const blockEnd = end.index + end[0].length;
      const block = this.buffer.slice(0, blockEnd);
      this.buffer = this.buffer.slice(blockEnd);
      this.inBlock = false;

      const calls = parseBlock(block);
      if (calls) result.toolCalls.push(...calls);
      else result.rejected = true;
    }

    return result;
  }
}

/** Parse one complete or fragmented DSML text value. */
export function parseDeepSeekDsml(content: string): DeepSeekDsmlParseResult {
  const parser = new DeepSeekDsmlParser();
  const streamed = parser.feed(content);
  const completed = parser.finish();
  return {
    content: streamed.content + completed.content,
    toolCalls: [...streamed.toolCalls, ...completed.toolCalls],
    rejected: streamed.rejected || completed.rejected,
  };
}
