import { relativeWorkspacePath } from "./python-tool-policy";

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;
export const XLSX_EXTENSION = ".xlsx" as const;

export const SPREADSHEET_LIMITS = {
  maxPathLength: 512,
  maxSheetCount: 20,
  maxSheetNameLength: 31,
  maxCellCount: 500,
  maxCellValueLength: 16_384,
  maxFormulaLength: 16_384,
  maxOperationCount: 100,
  maxTableCount: 50,
  maxChartCount: 50,
  maxReadRows: 200,
  maxReadColumns: 100,
  maxReadOutputCharacters: 128 * 1024,
  maxWorkbookBytes: 25 * 1024 * 1024,
} as const;

export type SpreadsheetScalar = string | number | boolean | null;

export type SpreadsheetStyle = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontName?: string;
  fontSize?: number;
  fontColor?: string;
  fillColor?: string;
  numberFormat?: string;
  horizontal?: "left" | "center" | "right" | "fill" | "justify" | "centerContinuous" | "distributed";
  vertical?: "top" | "center" | "bottom" | "justify" | "distributed";
  wrapText?: boolean;
  borderStyle?: "thin" | "medium" | "thick" | "double" | "dotted" | "dashed";
  borderColor?: string;
};

export type SpreadsheetCell = {
  address: string;
  value?: SpreadsheetScalar;
  formula?: string;
  style?: SpreadsheetStyle;
};

export type SpreadsheetTable = {
  name: string;
  ref: string;
  styleName?: string;
};

export type SpreadsheetChart = {
  type: "bar" | "line" | "pie" | "scatter";
  dataRange: string;
  categoriesRange?: string;
  title?: string;
  anchor?: string;
  width?: number;
  height?: number;
};

export type SpreadsheetSheet = {
  name: string;
  rows?: SpreadsheetScalar[][];
  cells?: SpreadsheetCell[];
  freezePanes?: string;
  tables?: SpreadsheetTable[];
  charts?: SpreadsheetChart[];
};

export type SpreadsheetCreateInput = {
  operation: "create";
  path: string;
  sheets: SpreadsheetSheet[];
};

export type SpreadsheetReadInput = {
  operation: "read";
  path: string;
  sheet?: string;
  range?: string;
  includeStyles?: boolean;
  maxRows?: number;
  maxColumns?: number;
};

export type SpreadsheetEditOperation =
  | { type: "set_cells"; sheet: string; cells: SpreadsheetCell[] }
  | { type: "format_range"; sheet: string; range: string; style: SpreadsheetStyle }
  | { type: "add_sheet"; name: string }
  | { type: "rename_sheet"; from: string; to: string }
  | { type: "delete_sheet"; name: string }
  | { type: "add_table"; sheet: string; table: SpreadsheetTable }
  | { type: "add_chart"; sheet: string; chart: SpreadsheetChart };

export type SpreadsheetEditInput = {
  operation: "edit";
  path: string;
  operations: SpreadsheetEditOperation[];
};

export type SpreadsheetToolInput = SpreadsheetCreateInput | SpreadsheetReadInput | SpreadsheetEditInput;

export type SpreadsheetCellSummary = {
  address: string;
  value: SpreadsheetScalar;
  formula?: string;
  style?: SpreadsheetStyle;
};

export type SpreadsheetSheetSummary = {
  name: string;
  state: string;
  maxRow: number;
  maxColumn: number;
  cells: SpreadsheetCellSummary[];
  mergedRanges: string[];
  tables: Array<{ name: string; ref: string; styleName?: string }>;
  charts: Array<{ type: string; title?: string; anchor?: string }>;
  truncated?: boolean;
};

export type SpreadsheetSummary = {
  sheets: SpreadsheetSheetSummary[];
};

export class SpreadsheetInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetInputError";
  }
}

const ADDRESS_PATTERN = /^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/u;
const RANGE_PATTERN = /^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$/u;
const COLOR_PATTERN = /^(?:[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/u;
const SAFE_STYLE_NAMES = new Set([
  "TableStyleMedium2",
  "TableStyleMedium4",
  "TableStyleMedium9",
  "TableStyleMedium10",
  "TableStyleMedium11",
  "TableStyleMedium13",
  "TableStyleMedium15",
  "TableStyleMedium16",
  "TableStyleMedium17",
  "TableStyleMedium20",
  "TableStyleLight1",
  "TableStyleLight2",
  "TableStyleLight9",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpreadsheetInputError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > maximum) throw new SpreadsheetInputError(`${label} is invalid.`);
  return value;
}

function requiredPath(value: unknown): string {
  const raw = boundedString(value, "path", SPREADSHEET_LIMITS.maxPathLength)!;
  let path: string;
  try {
    path = relativeWorkspacePath(raw);
  } catch {
    throw new SpreadsheetInputError("path must be a safe relative workspace path.");
  }
  if (!path.toLowerCase().endsWith(XLSX_EXTENSION)) throw new SpreadsheetInputError("path must identify an .xlsx workbook.");
  return path;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new SpreadsheetInputError(`${label} contains an unexpected field: ${unexpected}.`);
}

function scalar(value: unknown, label: string): SpreadsheetScalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= SPREADSHEET_LIMITS.maxCellValueLength) return value;
  throw new SpreadsheetInputError(`${label} must be a bounded string, finite number, boolean, or null.`);
}

function cellAddress(value: unknown, label: string): string {
  const address = boundedString(value, label, 16)!;
  if (!ADDRESS_PATTERN.test(address)) throw new SpreadsheetInputError(`${label} must be an A1 cell address.`);
  return address.toUpperCase();
}

function cellRange(value: unknown, label: string): string {
  const range = boundedString(value, label, 32)!;
  if (!RANGE_PATTERN.test(range)) throw new SpreadsheetInputError(`${label} must be an A1 cell range.`);
  return range.toUpperCase();
}

function color(value: unknown, label: string): string {
  const candidate = boundedString(value, label, 8)!;
  if (!COLOR_PATTERN.test(candidate)) throw new SpreadsheetInputError(`${label} must be a six- or eight-digit hexadecimal color.`);
  return candidate.toUpperCase();
}

function style(value: unknown, label: string): SpreadsheetStyle {
  const input = record(value, label);
  keys(input, ["bold", "italic", "underline", "fontName", "fontSize", "fontColor", "fillColor", "numberFormat", "horizontal", "vertical", "wrapText", "borderStyle", "borderColor"], label);
  for (const field of ["bold", "italic", "underline", "wrapText"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") throw new SpreadsheetInputError(`${label}.${field} is invalid.`);
  }
  const fontName = input.fontName === undefined ? undefined : boundedString(input.fontName, `${label}.fontName`, 100);
  const numberFormat = input.numberFormat === undefined ? undefined : boundedString(input.numberFormat, `${label}.numberFormat`, 100);
  const fontSize = input.fontSize === undefined ? undefined : input.fontSize;
  if (fontSize !== undefined && (typeof fontSize !== "number" || !Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 200)) throw new SpreadsheetInputError(`${label}.fontSize is invalid.`);
  const horizontal = input.horizontal;
  const vertical = input.vertical;
  if (horizontal !== undefined && !["left", "center", "right", "fill", "justify", "centerContinuous", "distributed"].includes(String(horizontal))) throw new SpreadsheetInputError(`${label}.horizontal is invalid.`);
  if (vertical !== undefined && !["top", "center", "bottom", "justify", "distributed"].includes(String(vertical))) throw new SpreadsheetInputError(`${label}.vertical is invalid.`);
  const borderStyle = input.borderStyle;
  if (borderStyle !== undefined && !["thin", "medium", "thick", "double", "dotted", "dashed"].includes(String(borderStyle))) throw new SpreadsheetInputError(`${label}.borderStyle is invalid.`);
  return {
    ...(input.bold === undefined ? {} : { bold: input.bold as boolean }),
    ...(input.italic === undefined ? {} : { italic: input.italic as boolean }),
    ...(input.underline === undefined ? {} : { underline: input.underline as boolean }),
    ...(fontName === undefined ? {} : { fontName }),
    ...(fontSize === undefined ? {} : { fontSize }),
    ...(input.fontColor === undefined ? {} : { fontColor: color(input.fontColor, `${label}.fontColor`) }),
    ...(input.fillColor === undefined ? {} : { fillColor: color(input.fillColor, `${label}.fillColor`) }),
    ...(numberFormat === undefined ? {} : { numberFormat }),
    ...(horizontal === undefined ? {} : { horizontal: horizontal as SpreadsheetStyle["horizontal"] }),
    ...(vertical === undefined ? {} : { vertical: vertical as SpreadsheetStyle["vertical"] }),
    ...(input.wrapText === undefined ? {} : { wrapText: input.wrapText as boolean }),
    ...(borderStyle === undefined ? {} : { borderStyle: borderStyle as SpreadsheetStyle["borderStyle"] }),
    ...(input.borderColor === undefined ? {} : { borderColor: color(input.borderColor, `${label}.borderColor`) }),
  };
}

function cell(value: unknown, label: string): SpreadsheetCell {
  const input = record(value, label);
  keys(input, ["address", "value", "formula", "style"], label);
  const address = cellAddress(input.address, `${label}.address`);
  const hasValue = Object.prototype.hasOwnProperty.call(input, "value");
  const hasFormula = input.formula !== undefined;
  if (hasFormula && (typeof input.formula !== "string" || !input.formula.startsWith("=") || input.formula.length > SPREADSHEET_LIMITS.maxFormulaLength)) throw new SpreadsheetInputError(`${label}.formula is invalid.`);
  if (hasValue && hasFormula) throw new SpreadsheetInputError(`${label} cannot contain both value and formula.`);
  return {
    address,
    ...(hasValue ? { value: scalar(input.value, `${label}.value`) } : {}),
    ...(hasFormula ? { formula: input.formula as string } : {}),
    ...(input.style === undefined ? {} : { style: style(input.style, `${label}.style`) }),
  };
}

function table(value: unknown, label: string): SpreadsheetTable {
  const input = record(value, label);
  keys(input, ["name", "ref", "styleName"], label);
  const name = boundedString(input.name, `${label}.name`, 255)!;
  if (!TABLE_NAME_PATTERN.test(name)) throw new SpreadsheetInputError(`${label}.name is invalid.`);
  const styleName = input.styleName === undefined ? undefined : boundedString(input.styleName, `${label}.styleName`, 64);
  if (styleName && !SAFE_STYLE_NAMES.has(styleName)) throw new SpreadsheetInputError(`${label}.styleName is unsupported.`);
  return { name, ref: cellRange(input.ref, `${label}.ref`), ...(styleName ? { styleName } : {}) };
}

function chart(value: unknown, label: string): SpreadsheetChart {
  const input = record(value, label);
  keys(input, ["type", "dataRange", "categoriesRange", "title", "anchor", "width", "height"], label);
  if (!["bar", "line", "pie", "scatter"].includes(String(input.type))) throw new SpreadsheetInputError(`${label}.type is invalid.`);
  const width: number | undefined = input.width === undefined ? undefined : input.width as number;
  const height: number | undefined = input.height === undefined ? undefined : input.height as number;
  for (const [field, candidate] of [["width", width], ["height", height]] as const) {
    if (candidate !== undefined && (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 1 || candidate > 100)) throw new SpreadsheetInputError(`${label}.${field} is invalid.`);
  }
  return {
    type: input.type as SpreadsheetChart["type"],
    dataRange: cellRange(input.dataRange, `${label}.dataRange`),
    ...(input.categoriesRange === undefined ? {} : { categoriesRange: cellRange(input.categoriesRange, `${label}.categoriesRange`) }),
    ...(input.title === undefined ? {} : { title: boundedString(input.title, `${label}.title`, 512) }),
    ...(input.anchor === undefined ? {} : { anchor: cellAddress(input.anchor, `${label}.anchor`) }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

function sheet(value: unknown, index: number): SpreadsheetSheet {
  const input = record(value, `sheets[${index}]`);
  keys(input, ["name", "rows", "cells", "freezePanes", "tables", "charts"], `sheets[${index}]`);
  const name = boundedString(input.name, `sheets[${index}].name`, SPREADSHEET_LIMITS.maxSheetNameLength)!;
  if (/[\\/:?*\[\]]/u.test(name)) throw new SpreadsheetInputError(`sheets[${index}].name contains an invalid character.`);
  if (name.trim() !== name) throw new SpreadsheetInputError(`sheets[${index}].name must not have surrounding whitespace.`);
  const rows = input.rows === undefined ? undefined : input.rows;
  if (rows !== undefined && (!Array.isArray(rows) || rows.length > SPREADSHEET_LIMITS.maxReadRows || rows.some((row) => !Array.isArray(row) || row.length > SPREADSHEET_LIMITS.maxReadColumns))) throw new SpreadsheetInputError(`sheets[${index}].rows is invalid.`);
  const normalizedRows: SpreadsheetScalar[][] | undefined = rows === undefined
    ? undefined
    : (rows as unknown[][]).map((row: unknown[], rowIndex: number) => row.map((value: unknown, columnIndex: number) => scalar(value, `sheets[${index}].rows[${rowIndex}][${columnIndex}]`)));
  const cells = input.cells === undefined ? undefined : input.cells;
  if (cells !== undefined && (!Array.isArray(cells) || cells.length > SPREADSHEET_LIMITS.maxCellCount)) throw new SpreadsheetInputError(`sheets[${index}].cells is invalid.`);
  const normalizedCells = cells?.map((candidate, cellIndex) => cell(candidate, `sheets[${index}].cells[${cellIndex}]`));
  const freezePanes = input.freezePanes === undefined ? undefined : cellAddress(input.freezePanes, `sheets[${index}].freezePanes`);
  const tables = input.tables === undefined ? undefined : input.tables;
  if (tables !== undefined && (!Array.isArray(tables) || tables.length > SPREADSHEET_LIMITS.maxTableCount)) throw new SpreadsheetInputError(`sheets[${index}].tables is invalid.`);
  const charts = input.charts === undefined ? undefined : input.charts;
  if (charts !== undefined && (!Array.isArray(charts) || charts.length > SPREADSHEET_LIMITS.maxChartCount)) throw new SpreadsheetInputError(`sheets[${index}].charts is invalid.`);
  return {
    name,
    ...(normalizedRows === undefined ? {} : { rows: normalizedRows }),
    ...(normalizedCells === undefined ? {} : { cells: normalizedCells }),
    ...(freezePanes ? { freezePanes } : {}),
    ...(tables === undefined ? {} : { tables: tables.map((candidate, tableIndex) => table(candidate, `sheets[${index}].tables[${tableIndex}]`)) }),
    ...(charts === undefined ? {} : { charts: charts.map((candidate, chartIndex) => chart(candidate, `sheets[${index}].charts[${chartIndex}]`)) }),
  };
}

function operation(value: unknown, index: number): SpreadsheetEditOperation {
  const input = record(value, `operations[${index}]`);
  const type = input.type;
  if (type === "set_cells") {
    keys(input, ["type", "sheet", "cells"], `operations[${index}]`);
    if (!Array.isArray(input.cells) || input.cells.length < 1 || input.cells.length > SPREADSHEET_LIMITS.maxCellCount) throw new SpreadsheetInputError(`operations[${index}].cells is invalid.`);
    return { type, sheet: boundedString(input.sheet, `operations[${index}].sheet`, SPREADSHEET_LIMITS.maxSheetNameLength)!, cells: input.cells.map((candidate, cellIndex) => cell(candidate, `operations[${index}].cells[${cellIndex}]`)) };
  }
  if (type === "format_range") {
    keys(input, ["type", "sheet", "range", "style"], `operations[${index}]`);
    return { type, sheet: boundedString(input.sheet, `operations[${index}].sheet`, SPREADSHEET_LIMITS.maxSheetNameLength)!, range: cellRange(input.range, `operations[${index}].range`), style: style(input.style, `operations[${index}].style`) };
  }
  if (type === "add_sheet") {
    keys(input, ["type", "name"], `operations[${index}]`);
    const name = boundedString(input.name, `operations[${index}].name`, SPREADSHEET_LIMITS.maxSheetNameLength)!;
    if (/[\\/:?*\[\]]/u.test(name) || name.trim() !== name) throw new SpreadsheetInputError(`operations[${index}].name is invalid.`);
    return { type, name };
  }
  if (type === "rename_sheet") {
    keys(input, ["type", "from", "to"], `operations[${index}]`);
    const from = boundedString(input.from, `operations[${index}].from`, SPREADSHEET_LIMITS.maxSheetNameLength)!;
    const to = boundedString(input.to, `operations[${index}].to`, SPREADSHEET_LIMITS.maxSheetNameLength)!;
    if (/[\\/:?*\[\]]/u.test(to) || to.trim() !== to) throw new SpreadsheetInputError(`operations[${index}].to is invalid.`);
    return { type, from, to };
  }
  if (type === "delete_sheet") {
    keys(input, ["type", "name"], `operations[${index}]`);
    return { type, name: boundedString(input.name, `operations[${index}].name`, SPREADSHEET_LIMITS.maxSheetNameLength)! };
  }
  if (type === "add_table") {
    keys(input, ["type", "sheet", "table"], `operations[${index}]`);
    return { type, sheet: boundedString(input.sheet, `operations[${index}].sheet`, SPREADSHEET_LIMITS.maxSheetNameLength)!, table: table(input.table, `operations[${index}].table`) };
  }
  if (type === "add_chart") {
    keys(input, ["type", "sheet", "chart"], `operations[${index}]`);
    return { type, sheet: boundedString(input.sheet, `operations[${index}].sheet`, SPREADSHEET_LIMITS.maxSheetNameLength)!, chart: chart(input.chart, `operations[${index}].chart`) };
  }
  throw new SpreadsheetInputError(`operations[${index}].type is unsupported.`);
}

export function parseSpreadsheetToolInput(value: unknown): SpreadsheetToolInput {
  const input = record(value, "spreadsheet arguments");
  const operationName = input.operation;
  const path = requiredPath(input.path);
  if (operationName === "create") {
    keys(input, ["operation", "path", "sheets"], "spreadsheet arguments");
    if (!Array.isArray(input.sheets) || input.sheets.length < 1 || input.sheets.length > SPREADSHEET_LIMITS.maxSheetCount) throw new SpreadsheetInputError("sheets must contain between 1 and 20 entries.");
    const sheets = input.sheets.map((candidate, index) => sheet(candidate, index));
    if (new Set(sheets.map((candidate) => candidate.name.toLocaleLowerCase())).size !== sheets.length) throw new SpreadsheetInputError("sheet names must be unique.");
    return { operation: "create", path, sheets };
  }
  if (operationName === "read") {
    keys(input, ["operation", "path", "sheet", "range", "includeStyles", "maxRows", "maxColumns"], "spreadsheet arguments");
    const maxRows = input.maxRows === undefined ? 50 : input.maxRows;
    const maxColumns = input.maxColumns === undefined ? 25 : input.maxColumns;
    if (!Number.isSafeInteger(maxRows) || Number(maxRows) < 1 || Number(maxRows) > SPREADSHEET_LIMITS.maxReadRows) throw new SpreadsheetInputError("maxRows is invalid.");
    if (!Number.isSafeInteger(maxColumns) || Number(maxColumns) < 1 || Number(maxColumns) > SPREADSHEET_LIMITS.maxReadColumns) throw new SpreadsheetInputError("maxColumns is invalid.");
    if (input.includeStyles !== undefined && typeof input.includeStyles !== "boolean") throw new SpreadsheetInputError("includeStyles is invalid.");
    return {
      operation: "read",
      path,
      ...(input.sheet === undefined ? {} : { sheet: boundedString(input.sheet, "sheet", SPREADSHEET_LIMITS.maxSheetNameLength) }),
      ...(input.range === undefined ? {} : { range: cellRange(input.range, "range") }),
      ...(input.includeStyles ? { includeStyles: true } : {}),
      maxRows: maxRows as number,
      maxColumns: maxColumns as number,
    };
  }
  if (operationName === "edit") {
    keys(input, ["operation", "path", "operations"], "spreadsheet arguments");
    if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > SPREADSHEET_LIMITS.maxOperationCount) throw new SpreadsheetInputError("operations must contain between 1 and 100 entries.");
    return { operation: "edit", path, operations: input.operations.map((candidate, index) => operation(candidate, index)) };
  }
  throw new SpreadsheetInputError("operation must be create, read, or edit.");
}

export function isSpreadsheetContentType(contentType: string): boolean {
  return contentType.split(";", 1)[0].trim().toLowerCase() === XLSX_CONTENT_TYPE;
}
