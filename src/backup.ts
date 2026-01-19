import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileExists } from "./utils.js";

export type BackupContact = {
  tag: string;
  name?: string;
  groupTags: string[];
  body: any;
};

export type BackupGroup = {
  tag: string;
  name: string;
};

export type BackupAccount = {
  email: string;
  contactsByTag: Record<string, BackupContact>;
  groupsByTag: Record<string, BackupGroup>;
};

export type BackupV2 = {
  version: 2;
  createdAt: string;
  accounts: Record<string, BackupAccount>;
};

export type BackupFileInfo = {
  filename: string;
  fullPath: string;
  index: number;
  createdAt?: string;
  version?: number;
};

export async function listBackups(backupsDir: string): Promise<BackupFileInfo[]> {
  if (!fileExists(backupsDir)) return [];
  const names = await readdir(backupsDir);
  const bak = names
    .filter((n) => /^\d+\.bak$/i.test(n))
    .map((filename) => {
      const m = filename.match(/^(\d+)\.bak$/i);
      const index = m ? Number(m[1]) : Number.NaN;
      return { filename, index, fullPath: path.join(backupsDir, filename) };
    })
    .filter((x) => Number.isFinite(x.index))
    .sort((a, b) => a.index - b.index);

  // Best-effort read metadata for display
  const out: BackupFileInfo[] = [];
  for (const f of bak) {
    try {
      const raw = await readFile(f.fullPath, "utf8");
      const parsed = JSON.parse(raw);
      out.push({
        ...f,
        version: parsed?.version,
        createdAt: parsed?.createdAt,
      });
    } catch {
      out.push({ ...f });
    }
  }
  return out;
}

export async function readBackup(fullPath: string): Promise<any> {
  const raw = await readFile(fullPath, "utf8");
  return JSON.parse(raw);
}

export async function writeBackupV2(backupsDir: string, data: BackupV2): Promise<void> {
  await mkdir(backupsDir, { recursive: true, mode: 0o755 });
  const out = path.join(backupsDir, "1.bak");
  await writeFile(out, JSON.stringify(data, null, 2), "utf8");
}
