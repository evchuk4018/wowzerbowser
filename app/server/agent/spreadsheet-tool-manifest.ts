import type { ModelToolDefinition } from "../../../lib/model-tool-protocol";
import { SPREADSHEET_LIMITS } from "../../../lib/spreadsheet-protocol";

export const SPREADSHEET_TOOL_NAME = "spreadsheet";

const path = {
  type: "string",
  minLength: 5,
  maxLength: SPREADSHEET_LIMITS.maxPathLength,
  description: "Safe relative workspace path ending in .xlsx.",
};

const style = {
  type: "object",
  additionalProperties: false,
  properties: {
    bold: { type: "boolean" },
    italic: { type: "boolean" },
    underline: { type: "boolean" },
    fontName: { type: "string", maxLength: 100 },
    fontSize: { type: "number", exclusiveMinimum: 0, maximum: 200 },
    fontColor: { type: "string", pattern: "^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$" },
    fillColor: { type: "string", pattern: "^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$" },
    numberFormat: { type: "string", maxLength: 100 },
    horizontal: { type: "string", enum: ["left", "center", "right", "fill", "justify", "centerContinuous", "distributed"] },
    vertical: { type: "string", enum: ["top", "center", "bottom", "justify", "distributed"] },
    wrapText: { type: "boolean" },
    borderStyle: { type: "string", enum: ["thin", "medium", "thick", "double", "dotted", "dashed"] },
    borderColor: { type: "string", pattern: "^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$" },
  },
} as const;

const cell = {
  type: "object",
  additionalProperties: false,
  required: ["address"],
  properties: {
    address: { type: "string", pattern: "^[A-Za-z]{1,3}[1-9][0-9]{0,6}$" },
    value: { type: ["string", "number", "boolean", "null"] },
    formula: { type: "string", pattern: "^=", maxLength: SPREADSHEET_LIMITS.maxFormulaLength },
    style,
  },
} as const;

const table = {
  type: "object",
  additionalProperties: false,
  required: ["name", "ref"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 255, pattern: "^[A-Za-z_][A-Za-z0-9_.]*$" },
    ref: { type: "string", pattern: "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(:[A-Za-z]{1,3}[1-9][0-9]{0,6})?$" },
    styleName: { type: "string", maxLength: 64 },
  },
} as const;

const chart = {
  type: "object",
  additionalProperties: false,
  required: ["type", "dataRange"],
  properties: {
    type: { type: "string", enum: ["bar", "line", "pie", "scatter"] },
    dataRange: { type: "string", pattern: "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(:[A-Za-z]{1,3}[1-9][0-9]{0,6})?$" },
    categoriesRange: { type: "string", pattern: "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(:[A-Za-z]{1,3}[1-9][0-9]{0,6})?$" },
    title: { type: "string", maxLength: 512 },
    anchor: { type: "string", pattern: "^[A-Za-z]{1,3}[1-9][0-9]{0,6}$" },
    width: { type: "number", minimum: 1, maximum: 100 },
    height: { type: "number", minimum: 1, maximum: 100 },
  },
} as const;

const sheet = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: SPREADSHEET_LIMITS.maxSheetNameLength },
    rows: {
      type: "array",
      maxItems: SPREADSHEET_LIMITS.maxReadRows,
      items: {
        type: "array",
        maxItems: SPREADSHEET_LIMITS.maxReadColumns,
        items: { type: ["string", "number", "boolean", "null"] },
      },
    },
    cells: { type: "array", maxItems: SPREADSHEET_LIMITS.maxCellCount, items: cell },
    freezePanes: { type: "string", pattern: "^[A-Za-z]{1,3}[1-9][0-9]{0,6}$" },
    tables: { type: "array", maxItems: SPREADSHEET_LIMITS.maxTableCount, items: table },
    charts: { type: "array", maxItems: SPREADSHEET_LIMITS.maxChartCount, items: chart },
  },
} as const;

const editOperation = {
  type: "object",
  discriminator: { propertyName: "type" },
  oneOf: [
    { type: "object", additionalProperties: false, required: ["type", "sheet", "cells"], properties: { type: { const: "set_cells" }, sheet: { type: "string", maxLength: SPREADSHEET_LIMITS.maxSheetNameLength }, cells: { type: "array", minItems: 1, maxItems: SPREADSHEET_LIMITS.maxCellCount, items: cell } } },
    { type: "object", additionalProperties: false, required: ["type", "sheet", "range", "style"], properties: { type: { const: "format_range" }, sheet: { type: "string", maxLength: SPREADSHEET_LIMITS.maxSheetNameLength }, range: { type: "string" }, style } },
    { type: "object", additionalProperties: false, required: ["type", "name"], properties: { type: { const: "add_sheet" }, name: { type: "string", minLength: 1, maxLength: SPREADSHEET_LIMITS.maxSheetNameLength } } },
    { type: "object", additionalProperties: false, required: ["type", "from", "to"], properties: { type: { const: "rename_sheet" }, from: { type: "string", maxLength: SPREADSHEET_LIMITS.maxSheetNameLength }, to: { type: "string", maxLength: SPREADSHEET_LIMITS.maxSheetNameLength } } },
    { type: "object", additionalProperties: false, required: ["type", "name"], properties: { type: { const: "delete_sheet" }, name: { type: "string", maxLength: SPREADSHEET_LIMITS.maxSheetNameLength } } },
    { type: "object", additionalProperties: false, required: ["type", "sheet", "table"], properties: { type: { const: "add_table" }, sheet: { type: "string", maxLength: SPREADSHEET_LIMITS.maxSheetNameLength }, table } },
    { type: "object", additionalProperties: false, required: ["type", "sheet", "chart"], properties: { type: { const: "add_chart" }, sheet: { type: "string", maxLength: SPREADSHEET_LIMITS.maxSheetNameLength }, chart } },
  ],
} as const;

export function spreadsheetToolDefinition(): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name: SPREADSHEET_TOOL_NAME,
      description: "Create, inspect, or edit a real .xlsx workbook in the persistent workspace. Use read for existing workbooks, edit for targeted changes, and create for a new downloadable spreadsheet. Formulas, common formatting, tables, and basic charts are supported.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["operation", "path"],
        properties: {
          operation: { type: "string", enum: ["create", "read", "edit"] },
          path,
          sheets: { type: "array", minItems: 1, maxItems: SPREADSHEET_LIMITS.maxSheetCount, items: sheet },
          sheet: { type: "string", maxLength: SPREADSHEET_LIMITS.maxSheetNameLength },
          range: { type: "string" },
          includeStyles: { type: "boolean" },
          maxRows: { type: "integer", minimum: 1, maximum: SPREADSHEET_LIMITS.maxReadRows },
          maxColumns: { type: "integer", minimum: 1, maximum: SPREADSHEET_LIMITS.maxReadColumns },
          operations: { type: "array", minItems: 1, maxItems: SPREADSHEET_LIMITS.maxOperationCount, items: editOperation },
        },
      },
    },
  };
}

export const SPREADSHEET_TOOL_DEFINITION = spreadsheetToolDefinition();

export function availableSpreadsheetTools(enabled: boolean): ModelToolDefinition[] {
  return enabled ? [spreadsheetToolDefinition()] : [];
}
