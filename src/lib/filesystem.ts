import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "child_process";

/**
 * Resolve a relative path within a working directory, preventing path traversal.
 */
export function safePath(workingDir: string, relativePath: string): string {
  const resolved = path.resolve(workingDir, relativePath);
  const normalized = path.normalize(resolved);
  if (!normalized.startsWith(path.normalize(workingDir) + path.sep) && normalized !== path.normalize(workingDir)) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return normalized;
}

export async function readFileAction(workingDir: string, filePath: string): Promise<string> {
  const full = safePath(workingDir, filePath);
  try {
    return await fs.readFile(full, "utf-8");
  } catch (err) {
    return `[Error reading file]: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function writeFileAction(workingDir: string, filePath: string, content: string): Promise<string> {
  const full = safePath(workingDir, filePath);
  try {
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
    return `File written: ${filePath}`;
  } catch (err) {
    return `[Error writing file]: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function listFilesAction(workingDir: string, subPath?: string): Promise<string> {
  const full = subPath ? safePath(workingDir, subPath) : workingDir;
  try {
    const entries = await fs.readdir(full, { withFileTypes: true });
    return entries
      .map((e) => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`)
      .join("\n");
  } catch (err) {
    return `[Error listing files]: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function runCommandAction(workingDir: string, command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile("cmd", ["/c", command], {
      cwd: workingDir,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve(`[Command error]: ${err.message}\n${stderr}`);
      } else {
        resolve(stdout + (stderr ? `\n[stderr]: ${stderr}` : ""));
      }
    });
    child.on("error", (err) => resolve(`[Command error]: ${err.message}`));
  });
}
