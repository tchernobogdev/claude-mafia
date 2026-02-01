import { execFile } from "child_process";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  compilationErrors?: CompilationError[];
}

export interface CompilationError {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning";
}

export interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SupportedLanguage = "python" | "typescript" | "javascript" | "build";

interface ExecuteCodeOptions {
  code: string;
  language: SupportedLanguage;
  timeout?: number;
  buildCommand?: string; // For language="build", e.g., "npm run build", "tsc --noEmit"
}

/**
 * Execute code in a sandboxed temp directory with timeout protection.
 * Supports Python, TypeScript, JavaScript, and build commands.
 */
export async function executeCode({
  code,
  language,
  timeout = DEFAULT_TIMEOUT_MS,
  buildCommand,
}: ExecuteCodeOptions): Promise<ExecutionResult> {
  const dir = join(tmpdir(), "agentmafia-sandbox");
  await mkdir(dir, { recursive: true });

  let command: string;
  let args: string[];
  let filepath: string | undefined;

  if (language === "build") {
    // Build commands run in the temp directory without writing a file
    if (!buildCommand) {
      return {
        stdout: "",
        stderr: "Error: buildCommand is required for language='build'",
        exitCode: 1,
      };
    }
    // Parse command (e.g., "npm run build" -> command="npm", args=["run", "build"])
    const parts = buildCommand.split(" ");
    command = parts[0];
    args = parts.slice(1);
  } else {
    // Write code to temp file
    const ext = language === "python" ? "py" : language === "typescript" ? "ts" : "js";
    const filename = `script_${randomUUID().slice(0, 8)}.${ext}`;
    filepath = join(dir, filename);
    await writeFile(filepath, code, "utf-8");

    if (language === "python") {
      command = "python";
      args = [filepath];
    } else if (language === "typescript") {
      // Use tsx for TypeScript execution (requires tsx installed globally or in project)
      command = "npx";
      args = ["tsx", filepath];
    } else {
      // JavaScript via node
      command = "node";
      args = [filepath];
    }
  }

  return new Promise((resolve) => {
    const proc = execFile(
      command,
      args,
      { timeout, cwd: dir, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        // Clean up temp file if created
        if (filepath) {
          unlink(filepath).catch(() => {});
        }

        if (error && "killed" in error && error.killed) {
          resolve({
            stdout,
            stderr: stderr + `\n[Execution timed out after ${timeout / 1000} seconds]`,
            exitCode: 1,
          });
          return;
        }

        const exitCode = error
          ? ((error as NodeJS.ErrnoException & { code?: number }).code as unknown as number) || 1
          : 0;

        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode,
        });
      }
    );

    // Safety: kill if somehow still running
    setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, timeout + 1000);
  });
}

/**
 * Legacy Python-only execution function. Kept for backwards compatibility.
 */
export async function executePython(code: string): Promise<PythonResult> {
  const result = await executeCode({ code, language: "python" });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}
