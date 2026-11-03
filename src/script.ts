import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

export interface ScriptOptions {
  scriptPath: string;
  args?: string[];
  envFiles?: Record<string, string>;
  timeoutSeconds?: number;
}

export function validateScript(options: ScriptOptions): void {
  if (typeof options.scriptPath !== "string" || !isAbsolute(options.scriptPath) || options.scriptPath.includes("\0")) {
    throw new Error("scriptPath must be an absolute path");
  }
  if (options.args !== undefined && (!Array.isArray(options.args) || options.args.some(arg => typeof arg !== "string" || arg.includes("\0")))) {
    throw new Error("args must be an array of strings without NUL characters");
  }
  if (options.envFiles !== undefined && (!options.envFiles || typeof options.envFiles !== "object" || Array.isArray(options.envFiles)
    || Object.entries(options.envFiles).some(([name, path]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      || typeof path !== "string" || !isAbsolute(path) || path.includes("\0")))) {
    throw new Error("envFiles must map environment variable names to absolute file paths");
  }
}

export interface ScriptResult {
  stdout: string;
  diagnostic?: string;
  skipped?: boolean;
}

/** No shell, output limit, output filtering, or secret-bearing error/stderr logs. */
export async function runScript(options: ScriptOptions, cwd: string, canStart: () => boolean): Promise<ScriptResult> {
  validateScript(options);
  const env = { ...process.env };
  try {
    for (const [name, path] of Object.entries(options.envFiles ?? {})) {
      env[name] = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
    }
  } catch {
    return { stdout: "", diagnostic: "Unable to read script environment file" };
  }
  // A pause during file reads can still prevent execution, never delivery after execution.
  if (!canStart()) return { stdout: "", skipped: true };
  return new Promise(resolve => {
    let child;
    try {
      child = spawn("python3", [options.scriptPath, ...(options.args ?? [])], {
        cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch {
      resolve({ stdout: "", diagnostic: "Unable to spawn python3 script" });
      return;
    }
    let stdout = "", diagnostic: string | undefined, stderr = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => { stdout += text; });
    child.stderr.on("data", () => { stderr = true; });
    child.on("error", () => { diagnostic = "Unable to spawn or run python3 script"; });
    const timeout = options.timeoutSeconds ? setTimeout(() => {
      diagnostic = "Python script timed out; termination requested";
      child.kill();
    }, options.timeoutSeconds * 1000) : undefined;
    timeout?.unref();
    child.once("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (!diagnostic && (code !== 0 || signal)) diagnostic = `Python script exited with code ${code}, signal ${signal}`;
      if (!diagnostic && stderr) diagnostic = "Python script wrote to stderr (contents omitted)";
      resolve({ stdout, diagnostic });
    });
  });
}
