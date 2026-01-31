import { execFile } from "child_process";
import { writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const TIMEOUT_MS = 30_000;

export interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function executePython(code: string): Promise<PythonResult> {
  const dir = join(tmpdir(), "agentmafia-sandbox");
  await mkdir(dir, { recursive: true });

  const filename = `script_${randomUUID().slice(0, 8)}.py`;
  const filepath = join(dir, filename);

  await writeFile(filepath, code, "utf-8");

  return new Promise((resolve) => {
    const proc = execFile(
      "python",
      [filepath],
      { timeout: TIMEOUT_MS, cwd: dir, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        // Clean up temp file
        unlink(filepath).catch(() => {});

        if (error && "killed" in error && error.killed) {
          resolve({ stdout, stderr: stderr + "\n[Execution timed out after 30 seconds]", exitCode: 1 });
          return;
        }

        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
          exitCode: error ? (error as NodeJS.ErrnoException & { code?: number }).code as unknown as number || 1 : 0,
        });
      }
    );

    // Safety: kill if somehow still running
    setTimeout(() => {
      try { proc.kill(); } catch {}
    }, TIMEOUT_MS + 1000);
  });
}
