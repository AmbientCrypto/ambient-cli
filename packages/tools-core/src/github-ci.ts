import { spawn } from "node:child_process";
import { CI_LOG_LIMIT, CiSnapshot, type CiTarget } from "./ci-schema.js";
import { cleanTerminalOutput } from "./tools/bash.js";

const RESPONSE_BYTES = 2 * 1024 * 1024;

export interface CiReader {
  read(target: CiTarget, signal: AbortSignal): Promise<unknown>;
  logs(target: CiTarget, jobId: number, signal: AbortSignal): Promise<string>;
}

/** Fixed argv only: authentication stays in gh's environment/key store and never enters arguments. */
function runGh(args: string[], signal: AbortSignal, tail = false): Promise<string> {
  const limit = tail ? CI_LOG_LIMIT : RESPONSE_BYTES;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(tail ? 3000 : 15_000)]);
  if (deadline.aborted) return Promise.reject(new Error("GitHub request cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const abort = () => child.kill();
    deadline.addEventListener("abort", abort, { once: true });
    if (deadline.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      stdout = (stdout + text).slice(-limit);
      if (!tail && Buffer.byteLength(stdout) >= limit) {
        overflow = true;
        child.kill();
      }
    });
    child.stderr.on("data", (text: string) => {
      stderr = (stderr + text).slice(-8000);
    });
    child.once("error", (error) => {
      deadline.removeEventListener("abort", abort);
      reject(
        new Error(`GitHub CLI unavailable: ${error.message}. Install gh and run gh auth login.`),
      );
    });
    child.once("close", (code) => {
      deadline.removeEventListener("abort", abort);
      if (deadline.aborted)
        reject(new Error(signal.aborted ? "GitHub request cancelled" : "GitHub request timed out"));
      else if (overflow) reject(new Error("GitHub response exceeded the safe size limit"));
      else if (code !== 0)
        reject(
          new Error(`GitHub CLI failed (${code}): ${stderr.trim() || "no diagnostic output"}`),
        );
      else resolve(stdout);
    });
  });
}

export class GithubCiReader implements CiReader {
  async read(target: CiTarget, signal: AbortSignal): Promise<CiSnapshot> {
    const text = await runGh(
      [
        "run",
        "view",
        String(target.runId),
        "--repo",
        target.repo,
        "--json",
        "status,conclusion,url,jobs",
      ],
      signal,
    );
    return CiSnapshot.parse(JSON.parse(text));
  }
  async logs(target: CiTarget, jobId: number, signal: AbortSignal): Promise<string> {
    try {
      return cleanTerminalOutput(
        await runGh(
          ["api", `repos/${target.repo}/actions/jobs/${jobId}/logs`, "--allow-escape-sequences"],
          signal,
          true,
        ),
      );
    } catch (error) {
      return `Logs unavailable: ${(error as Error).message}`;
    }
  }
}
