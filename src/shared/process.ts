import spawn from "cross-spawn";

export interface RunProcessOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  extraEnv?: Record<string, string>;
}

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  outputExceeded: boolean;
}

export function runProcess(command: string, args: readonly string[], input: string, options: RunProcessOptions): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", ...options.extraEnv }
    });
    let stdout = "";
    let stderr = "";
    let outputExceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    const stdoutStream = child.stdout!;
    const stderrStream = child.stderr!;
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > options.maxOutputBytes) {
        outputExceeded = true;
        child.kill();
      }
    });
    stderrStream.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr) < 8_192) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, outputExceeded });
    });
    child.stdin!.end(input, "utf8");
  });
}
