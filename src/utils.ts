import { existsSync } from "node:fs";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

export function duplicates<T>(items: T[]): Set<T> {
  const seen = new Set<T>();
  const dups = new Set<T>();
  for (const item of items) {
    if (seen.has(item)) dups.add(item);
    else seen.add(item);
  }
  return dups;
}

export function removePrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

export async function withBackoff<T>(fn: () => Promise<T>, opts?: { verboseLog?: (msg: string) => void }): Promise<T> {
  let delayMs = 500;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const code = err?.code ?? err?.response?.status;
      const retryable =
        code === 429 ||
        code === 409 ||
        (typeof code === "number" && code >= 500 && code <= 599);

      if (!retryable) throw err;

      opts?.verboseLog?.(`retrying after error (code=${String(code)}) in ${delayMs}ms`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const timeoutMs = Math.max(1, ms);
  let timer: any;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
