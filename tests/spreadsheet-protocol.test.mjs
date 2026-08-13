import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSpreadsheetToolInput,
  SpreadsheetInputError,
  XLSX_CONTENT_TYPE,
} from "../lib/spreadsheet-protocol.ts";
import { workspaceFileFor, workspaceContentType } from "../lib/workspace-protocol.ts";

test("spreadsheet protocol accepts workbook creation with formulas, styles, tables, and charts", () => {
  const input = parseSpreadsheetToolInput({
    operation: "create",
    path: "reports/budget.xlsx",
    sheets: [{
      name: "Summary",
      rows: [["Category", "Amount"], ["Hosting", 120]],
      cells: [
        { address: "B4", formula: "=SUM(B2:B3)", style: { bold: true, numberFormat: "$#,##0.00", fillColor: "d9ead3" } },
      ],
      freezePanes: "A2",
      tables: [{ name: "BudgetTable", ref: "A1:B3", styleName: "TableStyleMedium2" }],
      charts: [{ type: "bar", dataRange: "A1:B3", categoriesRange: "A2:A3", title: "Budget" }],
    }],
  });

  assert.equal(input.operation, "create");
  assert.equal(input.path, "reports/budget.xlsx");
  assert.equal(input.sheets[0].cells?.[0].formula, "=SUM(B2:B3)");
  assert.equal(input.sheets[0].tables?.[0].styleName, "TableStyleMedium2");
  assert.equal(input.sheets[0].charts?.[0].type, "bar");
});

test("spreadsheet protocol validates safe paths and bounded edits", () => {
  assert.throws(
    () => parseSpreadsheetToolInput({ operation: "read", path: "../secret.xlsx" }),
    SpreadsheetInputError,
  );
  assert.throws(
    () => parseSpreadsheetToolInput({ operation: "create", path: "report.csv", sheets: [{ name: "Sheet1" }] }),
    /\.xlsx/,
  );
  assert.throws(
    () => parseSpreadsheetToolInput({ operation: "create", path: "report.xlsx", sheets: [{ name: "Sheet1", cells: [{ address: "A1", value: "x", formula: "=1" }] }] }),
    /both value and formula/,
  );
  const edit = parseSpreadsheetToolInput({
    operation: "edit",
    path: "report.xlsx",
    operations: [{ type: "format_range", sheet: "Sheet1", range: "A1:B2", style: { bold: true } }],
  });
  assert.equal(edit.operations[0].range, "A1:B2");
});

test("xlsx workspace metadata is binary, downloadable, and not text-previewed", () => {
  assert.equal(workspaceContentType("reports/budget.xlsx"), XLSX_CONTENT_TYPE);
  assert.deepEqual(workspaceFileFor("reports/budget.xlsx", 12), {
    path: "reports/budget.xlsx",
    name: "budget.xlsx",
    size: 12,
    contentType: XLSX_CONTENT_TYPE,
    language: "excel",
    editable: false,
    preview: "none",
  });
});
