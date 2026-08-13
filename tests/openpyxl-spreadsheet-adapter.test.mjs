import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  openpyxlSpreadsheetSource,
  runOpenpyxlSpreadsheet,
} from "../app/providers/openpyxl/openpyxl-spreadsheet-adapter.ts";
import { parseSpreadsheetToolInput } from "../lib/spreadsheet-protocol.ts";

function runPython(code, cwd, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", code], { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.stdin.end(stdin);
  });
}

async function pythonHasOpenpyxl() {
  const result = await runPython("import openpyxl; print(openpyxl.__version__)", process.cwd());
  return result.exitCode === 0;
}

test("openpyxl provider creates, reads, and modifies a workbook while preserving workbook features", async (t) => {
  if (!(await pythonHasOpenpyxl())) {
    t.skip("openpyxl is supplied by the private Python worker image and is unavailable in this local test runtime");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "wowzerbowser-xlsx-"));
  const calls = [];
  const executor = {
    async run(input) {
      calls.push(input);
      return await runPython(input.code, root, input.stdin);
    },
    async readWorkspaceFile(relativePath) {
      return new Uint8Array(await readFile(path.join(root, relativePath)));
    },
  };

  try {
    const create = parseSpreadsheetToolInput({
      operation: "create",
      path: "reports/budget.xlsx",
      sheets: [{
        name: "Budget",
        rows: [["Category", "Amount"], ["Hosting", 120], ["Travel", 80]],
        cells: [{ address: "B4", formula: "=SUM(B2:B3)", style: { bold: true, numberFormat: "$#,##0.00" } }],
        freezePanes: "A2",
        tables: [{ name: "BudgetTable", ref: "A1:B3", styleName: "TableStyleMedium2" }],
        charts: [{ type: "bar", dataRange: "A1:B3", categoriesRange: "A2:A3", title: "Budget" }],
      }],
    });
    const created = await runOpenpyxlSpreadsheet(create, executor);
    assert.ok(created.bytes?.byteLength > 0);
    assert.deepEqual([...created.bytes.slice(0, 2)], [80, 75]);
    assert.equal(calls[0].artifacts[0], "reports/budget.xlsx");

    const read = await runOpenpyxlSpreadsheet(parseSpreadsheetToolInput({
      operation: "read",
      path: "reports/budget.xlsx",
      sheet: "Budget",
      includeStyles: true,
      maxRows: 10,
      maxColumns: 5,
    }), executor);
    const sheet = read.summary.sheets[0];
    assert.equal(sheet.name, "Budget");
    assert.equal(sheet.tables[0].name, "BudgetTable");
    assert.equal(sheet.charts[0].type, "bar");
    assert.equal(sheet.cells.find((cell) => cell.address === "B4").formula, "=SUM(B2:B3)");
    assert.equal(sheet.cells.find((cell) => cell.address === "B4").style.bold, true);

    const edit = parseSpreadsheetToolInput({
      operation: "edit",
      path: "reports/budget.xlsx",
      operations: [
        { type: "set_cells", sheet: "Budget", cells: [{ address: "B2", value: 150 }] },
        { type: "format_range", sheet: "Budget", range: "A1:B3", style: { fillColor: "d9ead3" } },
        { type: "add_sheet", name: "Notes" },
      ],
    });
    const edited = await runOpenpyxlSpreadsheet(edit, executor);
    assert.ok(edited.bytes?.byteLength > 0);
    const afterEdit = await runOpenpyxlSpreadsheet(parseSpreadsheetToolInput({ operation: "read", path: "reports/budget.xlsx", includeStyles: true }), executor);
    assert.deepEqual(afterEdit.summary.sheets.map((item) => item.name), ["Budget", "Notes"]);
    assert.equal(afterEdit.summary.sheets[0].cells.find((cell) => cell.address === "B2").value, 150);
    assert.equal(afterEdit.summary.sheets[0].cells.find((cell) => cell.address === "A1").style.fillColor.endsWith("D9EAD3"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openpyxl provider keeps its executable source below the Python source limit", () => {
  assert.ok(openpyxlSpreadsheetSource().length < 64 * 1024);
  assert.match(openpyxlSpreadsheetSource(), /load_workbook/);
  assert.match(openpyxlSpreadsheetSource(), /TableStyleInfo/);
  assert.match(openpyxlSpreadsheetSource(), /BarChart/);
});
