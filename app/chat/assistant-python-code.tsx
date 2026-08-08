import type { PythonActivity } from "./assistant-activity-types";

type PythonSource = {
  filename: string;
  code: string;
};

export function pythonSourceFor(activity: PythonActivity): PythonSource {
  try {
    const input = JSON.parse(activity.call.arguments) as { code?: unknown; file?: unknown };
    if (typeof input.file === "string" && input.file.trim()) {
      return { filename: input.file, code: `# Executed file: ${input.file}` };
    }
    if (typeof input.code === "string") return { filename: "script.py", code: input.code };
  } catch {
    // Keep malformed calls visible without allowing them to break the transcript.
  }
  return { filename: "script.py", code: "# Python source unavailable" };
}

type PythonToken = { text: string; className?: string };

function highlightPython(code: string): PythonToken[] {
  const tokenPattern = new RegExp("(#[^\\n]*|'''[\\s\\S]*?'''|\\\"\\\"\\\"[\\s\\S]*?\\\"\\\"\\\"|'(?:\\\\.|[^'\\\\])*'|\\\"(?:\\\\.|[^\\\"\\\\])*\\\"|\\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\\b|\\b(?:print|len|range|str|int|float|list|dict|set|tuple|enumerate|zip|open|sum|min|max|sorted|super|self)\\b|\\b\\d+(?:\\.\\d+)?\\b|@[A-Za-z_][\\w.]*|==|!=|<=|>=|->|\\*\\*|//|[+\\-*%=<>:&|^~\\x2f])", "g");
  const tokens: PythonToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(code))) {
    if (match.index > lastIndex) tokens.push({ text: code.slice(lastIndex, match.index) });
    const value = match[0];
    const className = value.startsWith("#")
      ? "python-token-comment"
      : value.startsWith("\"") || value.startsWith("'")
        ? "python-token-string"
        : value.startsWith("@")
          ? "python-token-decorator"
          : /^\d/.test(value)
            ? "python-token-number"
            : /^(?:print|len|range|str|int|float|list|dict|set|tuple|enumerate|zip|open|sum|min|max|sorted|super|self)$/.test(value)
              ? "python-token-builtin"
              : /^[A-Za-z]/.test(value)
                ? "python-token-keyword"
                : "python-token-operator";
    tokens.push({ text: value, className });
    lastIndex = tokenPattern.lastIndex;
  }
  if (lastIndex < code.length) tokens.push({ text: code.slice(lastIndex) });
  return tokens;
}

export function PythonCode({ activity }: { activity: PythonActivity }) {
  const source = pythonSourceFor(activity);
  return (
    <pre className="python-source" aria-label={`${source.filename} source code`}>
      <code>{highlightPython(source.code).map((token, index) => (
        <span key={`${index}-${token.text}`} className={token.className}>{token.text}</span>
      ))}</code>
    </pre>
  );
}
