import "server-only";

import { TextEncoder } from "node:util";
import type {
  SpreadsheetChart,
  SpreadsheetCreateInput,
  SpreadsheetEditInput,
  SpreadsheetReadInput,
  SpreadsheetScalar,
  SpreadsheetStyle,
  SpreadsheetSummary,
  SpreadsheetToolInput,
} from "../../../lib/spreadsheet-protocol";
import { SPREADSHEET_LIMITS } from "../../../lib/spreadsheet-protocol";

export const OPENPYXL_PROVIDER_NAME = "openpyxl" as const;

export type SpreadsheetExecutor = {
  run(input: unknown): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
  }>;
  readWorkspaceFile(path: string): Promise<Uint8Array>;
};

export class SpreadsheetProviderError extends Error {
  constructor(message: string, readonly provider = OPENPYXL_PROVIDER_NAME) {
    super(message);
    this.name = "SpreadsheetProviderError";
  }
}

export type SpreadsheetProviderResult = {
  operation: SpreadsheetToolInput["operation"];
  path: string;
  summary?: SpreadsheetSummary;
  bytes?: Uint8Array;
  durationMs: number;
};

const PYTHON_SOURCE = String.raw`import json
import os
import sys
from copy import copy
from datetime import date, datetime, time
from decimal import Decimal

from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, LineChart, PieChart, ScatterChart, Reference, Series
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.utils.cell import get_column_letter, range_boundaries


def fail(message):
    raise ValueError(message)


def argb(value):
    value = str(value).upper()
    return value if len(value) == 8 else "FF" + value


def json_value(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return str(value)


def style_value(cell):
    font_color = getattr(getattr(cell.font, "color", None), "rgb", None)
    fill_color = getattr(getattr(cell.fill, "fgColor", None), "rgb", None)
    border = cell.border
    border_side = border.left if border.left.style else border.right if border.right.style else border.top if border.top.style else border.bottom
    border_color = getattr(getattr(border_side, "color", None), "rgb", None)
    result = {}
    if cell.font.bold:
        result["bold"] = True
    if cell.font.italic:
        result["italic"] = True
    if cell.font.underline:
        result["underline"] = True
    if cell.font.name:
        result["fontName"] = cell.font.name
    if cell.font.sz:
        result["fontSize"] = cell.font.sz
    if isinstance(font_color, str):
        result["fontColor"] = font_color[-8:]
    if isinstance(fill_color, str) and fill_color not in ("00000000", "000000" ):
        result["fillColor"] = fill_color[-8:]
    if cell.number_format and cell.number_format != "General":
        result["numberFormat"] = cell.number_format
    if cell.alignment.horizontal:
        result["horizontal"] = cell.alignment.horizontal
    if cell.alignment.vertical:
        result["vertical"] = cell.alignment.vertical
    if cell.alignment.wrap_text:
        result["wrapText"] = True
    if border_side.style:
        result["borderStyle"] = border_side.style
    if isinstance(border_color, str):
        result["borderColor"] = border_color[-8:]
    return result


def apply_style(cell, specification):
    if not specification:
        return
    font = copy(cell.font)
    if "bold" in specification:
        font.bold = specification["bold"]
    if "italic" in specification:
        font.italic = specification["italic"]
    if "underline" in specification:
        font.underline = specification["underline"]
    if "fontName" in specification:
        font.name = specification["fontName"]
    if "fontSize" in specification:
        font.sz = specification["fontSize"]
    if "fontColor" in specification:
        font.color = argb(specification["fontColor"])
    cell.font = font
    if "fillColor" in specification:
        cell.fill = PatternFill(fill_type="solid", fgColor=argb(specification["fillColor"]))
    if "numberFormat" in specification:
        cell.number_format = specification["numberFormat"]
    alignment = copy(cell.alignment)
    if "horizontal" in specification:
        alignment.horizontal = specification["horizontal"]
    if "vertical" in specification:
        alignment.vertical = specification["vertical"]
    if "wrapText" in specification:
        alignment.wrap_text = specification["wrapText"]
    cell.alignment = alignment
    if "borderStyle" in specification:
        border_side = Side(style=specification["borderStyle"], color=argb(specification.get("borderColor", "000000")))
        cell.border = Border(left=border_side, right=border_side, top=border_side, bottom=border_side)


def set_cell(cell, specification):
    if "formula" in specification:
        cell.value = specification["formula"]
    elif "value" in specification:
        cell.value = specification["value"]
    apply_style(cell, specification.get("style"))


def put_sheet_values(worksheet, sheet):
    for row_index, row in enumerate(sheet.get("rows", []), start=1):
        for column_index, value in enumerate(row, start=1):
            worksheet.cell(row=row_index, column=column_index, value=value)
    for specification in sheet.get("cells", []):
        set_cell(worksheet[specification["address"]], specification)
    if sheet.get("freezePanes"):
        worksheet.freeze_panes = sheet["freezePanes"]
    for specification in sheet.get("tables", []):
        add_table(worksheet, specification)
    for specification in sheet.get("charts", []):
        add_chart(worksheet, specification)


def get_sheet(workbook, name):
    if name not in workbook.sheetnames:
        fail("Worksheet not found: " + str(name))
    return workbook[name]


def add_table(worksheet, specification):
    table = Table(displayName=specification["name"], ref=specification["ref"])
    table.tableStyleInfo = TableStyleInfo(
        name=specification.get("styleName", "TableStyleMedium2"),
        showFirstColumn=False,
        showLastColumn=False,
        showRowStripes=True,
        showColumnStripes=False,
    )
    worksheet.add_table(table)


def add_chart(worksheet, specification):
    chart_type = specification["type"]
    if chart_type == "bar":
        chart = BarChart()
        chart.type = "col"
    elif chart_type == "line":
        chart = LineChart()
    elif chart_type == "pie":
        chart = PieChart()
    else:
        chart = ScatterChart()
    data_min_col, data_min_row, data_max_col, data_max_row = range_boundaries(specification["dataRange"])
    if chart_type == "scatter":
        if data_max_col - data_min_col < 1:
            fail("Scatter charts require two data columns.")
        x_values = Reference(worksheet, min_col=data_min_col, min_row=data_min_row, max_row=data_max_row)
        y_values = Reference(worksheet, min_col=data_min_col + 1, min_row=data_min_row, max_row=data_max_row)
        chart.series.append(Series(y_values, x_values, title=specification.get("title")))
    else:
        data = Reference(worksheet, min_col=data_min_col, min_row=data_min_row, max_col=data_max_col, max_row=data_max_row)
        chart.add_data(data, titles_from_data=data_max_row > data_min_row)
        if specification.get("categoriesRange"):
            category_min_col, category_min_row, category_max_col, category_max_row = range_boundaries(specification["categoriesRange"])
            chart.set_categories(Reference(worksheet, min_col=category_min_col, min_row=category_min_row, max_col=category_max_col, max_row=category_max_row))
    if specification.get("title"):
        chart.title = specification["title"]
    chart.width = specification.get("width", 15)
    chart.height = specification.get("height", 7.5)
    worksheet.add_chart(chart, specification.get("anchor", "J2"))


def chart_title(chart):
    title = getattr(chart, "title", None)
    if title is None:
        return None
    try:
        return title.tx.rich.p[0].r[0].t
    except Exception:
        value = str(title)
        return value[:512]


def summary(workbook, requested_sheet=None, requested_range=None, include_styles=False, max_rows=50, max_columns=25):
    worksheets = [get_sheet(workbook, requested_sheet)] if requested_sheet else list(workbook.worksheets)
    result = []
    for worksheet in worksheets:
        if requested_range:
            start_col, start_row, end_col, end_row = range_boundaries(requested_range)
        else:
            start_col, start_row = 1, 1
            end_col = max(1, worksheet.max_column)
            end_row = max(1, worksheet.max_row)
        returned_end_col = min(end_col, start_col + max_columns - 1)
        returned_end_row = min(end_row, start_row + max_rows - 1)
        cells = []
        for row in worksheet.iter_rows(min_row=start_row, max_row=returned_end_row, min_col=start_col, max_col=returned_end_col):
            for cell in row:
                if cell.value is None and not (include_styles and style_value(cell)):
                    continue
                value = json_value(cell.value)
                item = {"address": cell.coordinate, "value": None if isinstance(value, str) and value.startswith("=") else value}
                if isinstance(value, str) and value.startswith("="):
                    item["formula"] = value
                if include_styles:
                    styles = style_value(cell)
                    if styles:
                        item["style"] = styles
                cells.append(item)
        tables = []
        for table in list(worksheet.tables.values())[:50]:
            tables.append({"name": table.name, "ref": table.ref, **({"styleName": table.tableStyleInfo.name} if table.tableStyleInfo and table.tableStyleInfo.name else {})})
        charts = []
        for chart in list(getattr(worksheet, "_charts", []))[:50]:
            anchor = getattr(getattr(chart, "anchor", None), "_from", None)
            anchor_name = None
            if anchor is not None:
                anchor_name = get_column_letter(anchor.col + 1) + str(anchor.row + 1)
            chart_item = {"type": chart.__class__.__name__.replace("Chart", "").lower()}
            if chart_title(chart):
                chart_item["title"] = chart_title(chart)
            if anchor_name:
                chart_item["anchor"] = anchor_name
            charts.append(chart_item)
        result.append({
            "name": worksheet.title,
            "state": worksheet.sheet_state,
            "maxRow": worksheet.max_row,
            "maxColumn": worksheet.max_column,
            "cells": cells,
            "mergedRanges": [str(value) for value in list(worksheet.merged_cells.ranges)[:100]],
            "tables": tables,
            "charts": charts,
            **({"truncated": returned_end_row < end_row or returned_end_col < end_col} if returned_end_row < end_row or returned_end_col < end_col else {}),
        })
    return {"sheets": result}


def edit(workbook, operations):
    for specification in operations:
        operation = specification["type"]
        if operation == "set_cells":
            worksheet = get_sheet(workbook, specification["sheet"])
            for cell_specification in specification["cells"]:
                set_cell(worksheet[cell_specification["address"]], cell_specification)
        elif operation == "format_range":
            worksheet = get_sheet(workbook, specification["sheet"])
            min_col, min_row, max_col, max_row = range_boundaries(specification["range"])
            for row in worksheet.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col):
                for cell in row:
                    apply_style(cell, specification["style"])
        elif operation == "add_sheet":
            if specification["name"] in workbook.sheetnames:
                fail("Worksheet already exists: " + specification["name"])
            workbook.create_sheet(specification["name"])
        elif operation == "rename_sheet":
            if specification["from"] not in workbook.sheetnames:
                fail("Worksheet not found: " + specification["from"])
            if specification["to"] in workbook.sheetnames:
                fail("Worksheet already exists: " + specification["to"])
            workbook[specification["from"]].title = specification["to"]
        elif operation == "delete_sheet":
            worksheet = get_sheet(workbook, specification["name"])
            if len(workbook.worksheets) <= 1:
                fail("A workbook must contain at least one worksheet.")
            workbook.remove(worksheet)
        elif operation == "add_table":
            add_table(get_sheet(workbook, specification["sheet"]), specification["table"])
        elif operation == "add_chart":
            add_chart(get_sheet(workbook, specification["sheet"]), specification["chart"])
        else:
            fail("Unsupported spreadsheet operation: " + str(operation))


def ensure_parent(path):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def main(input_value):
    operation = input_value["operation"]
    path = input_value["path"]
    if operation == "create":
        ensure_parent(path)
        workbook = Workbook()
        workbook.remove(workbook.active)
        for sheet in input_value["sheets"]:
            worksheet = workbook.create_sheet(sheet["name"])
            put_sheet_values(worksheet, sheet)
        workbook.save(path)
        return {"operation": operation, "path": path, "sheets": [sheet.title for sheet in workbook.worksheets]}
    if operation == "read":
        workbook = load_workbook(path, data_only=False, read_only=False)
        return summary(workbook, input_value.get("sheet"), input_value.get("range"), input_value.get("includeStyles", False), input_value.get("maxRows", 50), input_value.get("maxColumns", 25))
    workbook = load_workbook(path, data_only=False, read_only=False)
    edit(workbook, input_value["operations"])
    ensure_parent(path)
    workbook.save(path)
    return {"operation": operation, "path": path, "sheets": [sheet.title for sheet in workbook.worksheets]}


try:
    input_value = json.loads(sys.stdin.read())
    print(json.dumps(main(input_value), ensure_ascii=False, separators=(",", ":")))
except Exception as error:
    print(str(error), file=sys.stderr)
    raise
`;

const encoder = new TextEncoder();
function serializedInput(input: SpreadsheetToolInput): string {
  const serialized = JSON.stringify(input);
  if (encoder.encode(serialized).byteLength > 64 * 1024) throw new SpreadsheetProviderError("Spreadsheet request is too large for the local workbook provider.");
  return serialized;
}

function errorMessage(result: Awaited<ReturnType<SpreadsheetExecutor["run"]>>): string {
  if (result.timedOut) return "The spreadsheet provider timed out.";
  if (result.stderrTruncated) return "The spreadsheet provider failed with a truncated error.";
  const message = result.stderr.trim().replace(/\s+/gu, " ");
  return message.slice(0, 1_000) || "The spreadsheet provider failed.";
}

function summaryFromOutput(value: unknown): SpreadsheetSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { sheets?: unknown };
  if (!Array.isArray(candidate.sheets)) return undefined;
  return value as SpreadsheetSummary;
}

async function runProvider(input: SpreadsheetToolInput, executor: SpreadsheetExecutor): Promise<{ output: unknown; durationMs: number }> {
  const startedAt = Date.now();
  const request = {
    code: PYTHON_SOURCE,
    stdin: serializedInput(input),
    ...(input.operation === "create" || input.operation === "edit" ? { artifacts: [input.path] } : {}),
  };
  const result = await executor.run(request);
  if (result.exitCode !== 0) throw new SpreadsheetProviderError(errorMessage(result));
  if (result.stdoutTruncated) throw new SpreadsheetProviderError("The spreadsheet provider returned too much output.");
  const outputText = result.stdout.trim();
  if (!outputText) throw new SpreadsheetProviderError("The spreadsheet provider returned no result.");
  try {
    return { output: JSON.parse(outputText), durationMs: Date.now() - startedAt };
  } catch {
    throw new SpreadsheetProviderError("The spreadsheet provider returned invalid JSON.");
  }
}

export async function runOpenpyxlSpreadsheet(input: SpreadsheetToolInput, executor: SpreadsheetExecutor): Promise<SpreadsheetProviderResult> {
  const result = await runProvider(input, executor);
  if (input.operation === "read") {
    const summary = summaryFromOutput(result.output);
    if (!summary) throw new SpreadsheetProviderError("The spreadsheet provider returned an invalid workbook summary.");
    return { operation: input.operation, path: input.path, summary, durationMs: result.durationMs };
  }
  const bytes = await executor.readWorkspaceFile(input.path);
  if (bytes.byteLength > SPREADSHEET_LIMITS.maxWorkbookBytes) throw new SpreadsheetProviderError("The workbook exceeds the 25 MiB artifact limit.");
  return {
    operation: input.operation,
    path: input.path,
    bytes,
    durationMs: result.durationMs,
  };
}

export function openpyxlSpreadsheetSource(): string {
  return PYTHON_SOURCE;
}

export function spreadsheetSummaryCellValue(value: unknown): SpreadsheetScalar {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return String(value);
}

export type { SpreadsheetChart, SpreadsheetCreateInput, SpreadsheetEditInput, SpreadsheetReadInput, SpreadsheetStyle };
