import { appendFile } from "node:fs/promises";

export function createLogger(opts: { verbose: boolean; debug: boolean; file: boolean; logFilePath: string }) {
  const { verbose, debug, file, logFilePath } = opts;

  const stamp = () => {
    const ts = new Date();
    return `[${ts.toISOString()}]`;
  };

  const log = (...args: any[]) => {
    // console.log is line-buffered; Bun flushes eagerly.
    console.log(...args);
    if (!file) return;

    const line = [stamp(), ...args].map(String).join(" ") + "\n";
    // Best-effort logging; don't crash sync on log write issues.
    appendFile(logFilePath, line).catch(() => undefined);
  };

  const v = (...args: any[]) => {
    if (verbose) log(...args);
  };

  const d = (...args: any[]) => {
    if (debug) log(stamp(), "[DEBUG]", ...args);
  };

  return { log, v, d };
}
