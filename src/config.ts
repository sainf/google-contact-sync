import envPaths from "env-paths";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileExists } from "./utils.js";

export type AppConfig = {
  cdir: string;
  cfile: string;
  data: JsonConfig;
};

export type JsonAccountConfig = {
  user: string;
  keyfile: string;
  credfile: string;
};

export type JsonConfig = {
  last: string;
  backupdays: number;
  accounts: JsonAccountConfig[];
};

function nowUtcPlus5SecondsIso(): string {
  const dt = new Date(Date.now() + 5_000);
  return dt.toISOString();
}

function defaultJsonConfig(cdir: string): JsonConfig {
  return {
    last: "1972-01-01T00:00:00+00:00",
    backupdays: 0,
    accounts: [
      {
        user: "FIXME@gmail.com",
        keyfile: path.join(cdir, "FIXME_keyfile.json"),
        credfile: path.join(cdir, "FIXME_token"),
      },
    ],
  };
}

function parseLegacyIni(raw: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = Object.create(null);
  let section: string | null = null;
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith(";") || line.startsWith("#")) continue;
    const m = line.match(/^\[([^\]]+)\]$/);
    if (m) {
      section = m[1].trim();
      out[section] = out[section] ?? Object.create(null);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1 || !section) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    out[section]![key] = value;
  }
  return out;
}

function migrateIniToJson(cdir: string, iniData: Record<string, Record<string, string>>): JsonConfig {
  const def = iniData.DEFAULT ?? {};
  const last = typeof def.last === "string" && def.last.length > 0 ? def.last : "1972-01-01T00:00:00+00:00";
  const backupdays = Number(def.backupdays ?? 0);

  const accounts: JsonAccountConfig[] = [];
  for (const [section, value] of Object.entries(iniData)) {
    if (section === "DEFAULT") continue;
    if (section === "account-FIXME") continue;
    const user = value.user;
    const keyfile = value.keyfile;
    const credfile = value.credfile;
    if (typeof user === "string" && typeof keyfile === "string" && typeof credfile === "string") {
      accounts.push({ user, keyfile, credfile });
    }
  }

  return {
    last,
    backupdays: Number.isFinite(backupdays) ? backupdays : 0,
    accounts,
  };
}

export async function resolveConfigDir(): Promise<string> {
  // Python behavior: if PORTABLE.md exists in CWD, use ./conf.
  // Extra robustness: also treat it as portable if PORTABLE.md exists at the
  // project root (so running from another CWD still works).
  const cwd = process.cwd();
  // Portable layout used by this repo: ./conf/config.json (or legacy config.ini)
  if (fileExists(path.join(cwd, "conf", "config.json")) || fileExists(path.join(cwd, "conf", "config.ini"))) {
    return path.join(cwd, "conf");
  }
  if (fileExists(path.join(cwd, "PORTABLE.md"))) {
    return path.join(cwd, "conf");
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, "..");
  if (
    fileExists(path.join(projectRoot, "conf", "config.json")) ||
    fileExists(path.join(projectRoot, "conf", "config.ini"))
  ) {
    return path.join(projectRoot, "conf");
  }
  if (fileExists(path.join(projectRoot, "PORTABLE.md"))) {
    return path.join(projectRoot, "conf");
  }

  const paths = envPaths("google-contacts-sync", { suffix: "" });
  return paths.data;
}

export async function loadConfigOrCreateDefault(cdir: string): Promise<AppConfig> {
  await mkdir(cdir, { recursive: true, mode: 0o755 });

  const jsonFile = path.join(cdir, "config.json");
  const iniFile = path.join(cdir, "config.ini");

  // Preferred: JSON config
  if (fileExists(jsonFile)) {
    const raw = await readFile(jsonFile, "utf8");
    const data = JSON.parse(raw) as JsonConfig;
    if (!Array.isArray((data as any).accounts)) {
      throw new Error(`Invalid config.json (missing accounts array): ${jsonFile}`);
    }
    return { cdir, cfile: jsonFile, data };
  }

  // One-time migration from legacy INI
  if (fileExists(iniFile)) {
    const raw = await readFile(iniFile, "utf8");
    const legacy = parseLegacyIni(raw);
    if (legacy?.["account-FIXME"]) {
      console.error(`You must edit ${iniFile}. There is an account-FIXME section`);
      process.exit(2);
    }

    const migrated = migrateIniToJson(cdir, legacy);
    await writeFile(jsonFile, JSON.stringify(migrated, null, 2) + "\n", "utf8");
    console.error(`Migrated ${iniFile} -> ${jsonFile}`);
    return { cdir, cfile: jsonFile, data: migrated };
  }

  // Create a default JSON config
  const def = defaultJsonConfig(cdir);
  await writeFile(jsonFile, JSON.stringify(def, null, 2) + "\n", "utf8");
  console.error(`Made config file ${jsonFile}, you must edit it`);
  process.exit(1);
}

export async function saveConfigLastRun(cfg: AppConfig): Promise<void> {
  cfg.data.last = nowUtcPlus5SecondsIso();
  if (!Number.isFinite(cfg.data.backupdays)) cfg.data.backupdays = 0;
  if (!Array.isArray(cfg.data.accounts)) cfg.data.accounts = [];
  await writeFile(cfg.cfile, JSON.stringify(cfg.data, null, 2) + "\n", "utf8");
}

export function getBackupDays(cfg: AppConfig): number {
  const v = cfg.data?.backupdays;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

export function getLastRunIso(cfg: AppConfig): string {
  const v = cfg.data?.last;
  return typeof v === "string" && v.length > 0 ? v : "1972-01-01T00:00:00+00:00";
}

export type AccountConfig = {
  user: string;
  keyfile: string;
  credfile: string;
};

export function getAccounts(cfg: AppConfig): AccountConfig[] {
  const accounts = cfg.data?.accounts ?? [];
  return accounts
    .filter(
      (a: any) => typeof a?.user === "string" && typeof a?.keyfile === "string" && typeof a?.credfile === "string",
    )
    .map((a: any) => ({ user: a.user, keyfile: a.keyfile, credfile: a.credfile }));
}
