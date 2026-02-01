/**
 * Error Parser — converts raw compiler/linter/runtime output into structured error objects
 */

export interface ParsedError {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info";
  code?: string;
}

/**
 * Parse TypeScript compiler (tsc) output.
 * Example: "src/app/page.tsx(42,15): error TS2304: Cannot find name 'foo'."
 */
export function parseTypeScriptErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const lines = output.split("\n");

  const tsErrorPattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/;

  for (const line of lines) {
    const match = line.match(tsErrorPattern);
    if (match) {
      const [, file, lineNum, col, severity, code, message] = match;
      errors.push({
        file: file.trim(),
        line: parseInt(lineNum, 10),
        column: parseInt(col, 10),
        message: message.trim(),
        severity: severity === "error" ? "error" : "warning",
        code: `TS${code}`,
      });
    }
  }

  return errors;
}

/**
 * Parse ESLint output (assumes --format=stylish or similar).
 * Example: "  42:15  error  'foo' is not defined  no-undef"
 */
export function parseESLintErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const lines = output.split("\n");

  let currentFile = "";
  const filePattern = /^(.+\.(?:ts|tsx|js|jsx))$/;
  const errorPattern = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(.+)$/;

  for (const line of lines) {
    // Check if line is a file path
    const fileMatch = line.match(filePattern);
    if (fileMatch && !line.includes(":")) {
      currentFile = fileMatch[1].trim();
      continue;
    }

    // Check if line is an error
    const errorMatch = line.match(errorPattern);
    if (errorMatch && currentFile) {
      const [, lineNum, col, severity, message, rule] = errorMatch;
      errors.push({
        file: currentFile,
        line: parseInt(lineNum, 10),
        column: parseInt(col, 10),
        message: message.trim(),
        severity: severity === "error" ? "error" : "warning",
        code: rule.trim(),
      });
    }
  }

  return errors;
}

/**
 * Parse JavaScript/Node runtime stack traces.
 * Example: "    at Object.<anonymous> (/path/to/file.js:42:15)"
 */
export function parseRuntimeError(stackTrace: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const lines = stackTrace.split("\n");

  const stackPattern = /at .+? \((.+?):(\d+):(\d+)\)/;

  // First line is usually the error message
  const errorMessage = lines[0]?.trim() || "Runtime error";

  for (const line of lines) {
    const match = line.match(stackPattern);
    if (match) {
      const [, file, lineNum, col] = match;
      errors.push({
        file: file.trim(),
        line: parseInt(lineNum, 10),
        column: parseInt(col, 10),
        message: errorMessage,
        severity: "error",
      });
      break; // Only take the first stack frame for simplicity
    }
  }

  return errors;
}

/**
 * Smart parser that detects error format and routes to appropriate parser.
 */
export function parseErrors(output: string): ParsedError[] {
  if (output.includes("error TS") || output.includes("warning TS")) {
    return parseTypeScriptErrors(output);
  }
  if (output.includes("error ") && output.match(/\d+:\d+/)) {
    return parseESLintErrors(output);
  }
  if (output.includes(" at ") && output.match(/\(.+:\d+:\d+\)/)) {
    return parseRuntimeError(output);
  }
  return [];
}
