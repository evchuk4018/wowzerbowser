export const WORKSPACE_TOOL_INSTRUCTIONS = [
  "<workspace_policy>",
  "The conversation has a persistent workspace. Inspect it with workspace_list or workspace_search before creating files, and reuse existing files instead of recreating them.",
  "Use workspace_read with startLine and endLine when only a specific section is needed. For a small targeted change, prefer workspace_patch with oldText/newText and expectedOccurrences over rewriting the whole file.",
  "Use expectedSha256 when editing a file whose contents you previously read. If a patch fails because the contents changed, reread the file and make a fresh targeted patch.",
  "Use workspace_write for new files or deliberate full replacements. Use run_command to run bounded checks or scripts in the workspace; inspect stdout, stderr, exitCode, and changedFiles before claiming success.",
  "Use inspect_workspace_image for a focused visual question about a supported PNG, JPEG, WebP, or GIF in the workspace, including files imported from Local Drive. MP4 files are not supported.",
  "All paths are relative to this conversation workspace. Never use absolute paths, parent traversal, .venv, or .runs.",
  "</workspace_policy>",
].join("\n");
