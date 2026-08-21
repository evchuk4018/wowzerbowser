import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { executePythonTool } from "../app/server/agent/python-tool.ts";
import { executeSpreadsheetTool } from "../app/server/agent/spreadsheet-tool.ts";
import {
  availableSpreadsheetTools,
  SPREADSHEET_TOOL_NAME,
} from "../app/server/agent/spreadsheet-tool-manifest.ts";
import { gemmaCompatibleToolDefinitions } from "../app/providers/openrouter/openrouter-tool-schema.ts";

const call = (argumentsValue) => ({
  id: "spreadsheet-call-1",
  name: SPREADSHEET_TOOL_NAME,
  arguments: JSON.stringify(argumentsValue),
});

const context = {
  ownerId: "owner-1",
  conversationId: "conversation-1",
  executor: {},
};

test("spreadsheet tool publishes created and edited workbooks as downloadable artifacts", async () => {
  const registered = [];
  const dependencies = {
    runSpreadsheet: async (input) => ({ operation: input.operation, path: input.path, bytes: Uint8Array.from([80, 75, 3, 4]), durationMs: 2 }),
    registerArtifact: async (input) => {
      registered.push(input);
      return { id: `artifact-xlsx-${registered.length}`, name: input.name, contentType: input.contentType, size: input.bytes.byteLength, workspacePath: input.workspacePath, preview: input.preview, editable: input.editable, origin: input.origin };
    },
  };
  const result = await executeSpreadsheetTool(
    call({ operation: "create", path: "reports/budget.xlsx", sheets: [{ name: "Budget" }] }),
    context,
    dependencies,
  );

  assert.equal(result.ok, true);
  assert.equal(result.artifacts[0].name, "budget.xlsx");
  assert.equal(result.artifacts[0].contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(result.artifacts[0].workspacePath, "reports/budget.xlsx");
  assert.equal(result.artifacts[0].editable, false);
  assert.equal(registered[0].origin, "generated");

  const edited = await executeSpreadsheetTool(
    call({ operation: "edit", path: "reports/budget.xlsx", operations: [{ type: "set_cells", sheet: "Budget", cells: [{ address: "A1", value: "Updated" }] }] }),
    context,
    dependencies,
  );
  assert.equal(edited.ok, true);
  assert.equal(edited.artifacts[0].origin, "generated");
  assert.equal(registered[1].origin, "generated");
});

test("generic Python-created xlsx artifacts retain binary workspace metadata", async () => {
  const registered = [];
  const result = await executePythonTool(
    { id: "python-xlsx-call", name: "run_python", arguments: JSON.stringify({ code: "print('created')", artifacts: ["reports/budget.xlsx"] }) },
    {
      run: async () => ({ stdout: "created\n", stderr: "", exitCode: 0, artifacts: [{ path: "reports/budget.xlsx", size: 4 }] }),
      readArtifact: async () => Uint8Array.from([80, 75, 3, 4]),
    },
    "owner-1",
    "conversation-1",
    undefined,
    {
      registerArtifact: async (input) => {
        registered.push(input);
        return { id: "artifact-python-xlsx", name: input.name, contentType: input.contentType, size: input.bytes.byteLength, editable: input.editable, preview: input.preview };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(registered[0].contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(registered[0].editable, false);
  assert.equal(registered[0].preview, "none");
});

test("spreadsheet tool reads structured workbook metadata and rejects malformed calls", async () => {
  const read = await executeSpreadsheetTool(
    call({ operation: "read", path: "reports/budget.xlsx", sheet: "Budget" }),
    context,
    {
      runSpreadsheet: async () => ({ operation: "read", path: "reports/budget.xlsx", summary: { sheets: [{ name: "Budget", state: "visible", maxRow: 2, maxColumn: 2, cells: [{ address: "A1", value: "Amount" }], mergedRanges: [], tables: [], charts: [] }] }, durationMs: 1 }),
    },
  );
  assert.equal(read.ok, true);
  assert.equal(JSON.parse(read.stdout).sheets[0].cells[0].value, "Amount");
  assert.equal(read.artifacts, undefined);

  const invalid = await executeSpreadsheetTool(
    call({ operation: "read", path: "../secret.xlsx" }),
    context,
    { runSpreadsheet: async () => { throw new Error("must not run"); } },
  );
  assert.equal(invalid.ok, false);
  assert.match(invalid.stderr, /safe relative workspace path/i);
});

test("spreadsheet tool is advertised only when the local workbook runtime is available", () => {
  assert.deepEqual(availableSpreadsheetTools(false), []);
  assert.deepEqual(availableSpreadsheetTools(true).map((tool) => tool.function.name), [SPREADSHEET_TOOL_NAME]);
  const definition = availableSpreadsheetTools(true)[0];
  assert.deepEqual(definition.function.parameters.properties.operation.enum, ["create", "read", "edit"]);
  assert.equal(definition.function.parameters.properties.path.description.includes(".xlsx"), true);
});

test("Gemma receives a Gemini-compatible spreadsheet schema", () => {
  const definition = availableSpreadsheetTools(true)[0];
  const [tool] = gemmaCompatibleToolDefinitions([definition]);
  const parameters = tool.function.parameters;
  const sheets = parameters.properties.sheets.items;
  const rowsValue = sheets.properties.rows.items.items;
  const cellValue = sheets.properties.cells.items.properties.value;

  assert.deepEqual(rowsValue, {
    anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
    nullable: true,
  });
  assert.deepEqual(cellValue, rowsValue);

  const unsupported = new Set([
    "additionalProperties", "const", "discriminator", "exclusiveMinimum", "maxItems", "maxLength",
    "maximum", "minItems", "minLength", "minimum", "oneOf", "pattern",
  ]);
  const visit = (value) => {
    if (!value || typeof value !== "object") return [];
    if (Array.isArray(value)) return value.flatMap(visit);
    return Object.entries(value).flatMap(([key, child]) => [
      ...(unsupported.has(key) ? [key] : []),
      ...visit(child),
    ]);
  };
  assert.deepEqual(visit(parameters), []);
});

test("chat orchestration includes spreadsheet selection, instructions, and execution", async () => {
  const source = await readFile(new URL("../app/chat/chat-server-service.ts", import.meta.url), "utf8");
  assert.match(source, /availableSpreadsheetTools/);
  assert.match(source, /SPREADSHEET_TOOL_NAME/);
  assert.match(source, /activeSpreadsheetTools/);
  assert.match(source, /SPREADSHEET_TOOL_INSTRUCTIONS/);
  assert.match(source, /executeSpreadsheetTool/);
});
