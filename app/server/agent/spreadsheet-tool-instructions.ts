export const SPREADSHEET_TOOL_INSTRUCTIONS = [
  "<spreadsheet_policy>",
  "Use the spreadsheet tool for real .xlsx workbooks in the persistent workspace. Use operation=create for a new workbook, operation=read to inspect an existing workbook, and operation=edit for targeted changes.",
  "Before editing an existing workbook, read it first unless the requested change is unambiguous. Keep the exact relative .xlsx path so the edited workbook remains downloadable as a chat artifact.",
  "Create sheets with rows for rectangular data or cells for explicit A1 addresses. Use a formula field beginning with '=' for formulas; formulas are preserved but are not recalculated by the local provider.",
  "Use style for common font, fill, alignment, number-format, wrapping, and border changes. Tables use an A1 ref and a safe Excel table style. Basic bar, line, pie, and scatter charts can reference an A1 range.",
  "After create or edit, inspect the tool result and its artifact before claiming the workbook is ready. Read returns bounded structured cell, table, chart, and merge metadata rather than a binary dump.",
  "All paths are relative to the conversation workspace and must end in .xlsx. Never use absolute paths, parent traversal, .venv, or .runs.",
  "</spreadsheet_policy>",
].join("\n");
