import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { RestoreOptions } from "./types.js";
import { createLogger } from "./logger.js";
import { resolveConfigDir, loadConfigOrCreateDefault, getAccounts } from "./config.js";
import { listBackups, readBackup, type BackupV2 } from "./backup.js";
import { Contacts, SYNC_TAG } from "./contacts.js";
import { removePrefix } from "./utils.js";

function isBackupV2(x: any): x is BackupV2 {
  return x && typeof x === "object" && x.version === 2 && typeof x.createdAt === "string" && x.accounts;
}

function parseSelection(answer: string, max: number): number[] {
  const a = answer.trim().toLowerCase();
  if (a === "all") return Array.from({ length: max }, (_, i) => i + 1);
  const parts = a.split(/[\s,]+/).filter(Boolean);
  const idx = new Set<number>();
  for (const p of parts) {
    const n = Number(p);
    if (Number.isFinite(n) && n >= 1 && n <= max) idx.add(n);
  }
  return Array.from(idx).sort((x, y) => x - y);
}

async function askYesNo(rl: readline.Interface, prompt: string, def = false): Promise<boolean> {
  const ans = (await rl.question(prompt)).trim().toLowerCase();
  if (!ans) return def;
  if (ans === "y" || ans === "yes") return true;
  if (ans === "n" || ans === "no") return false;
  return def;
}

export async function runRestore(opts: RestoreOptions): Promise<void> {
  const logger = createLogger({ verbose: opts.verbose, debug: false, file: false, logFilePath: path.join(process.cwd(), "log.txt") });

  const cdir = await resolveConfigDir();
  const cfg = await loadConfigOrCreateDefault(cdir);
  const backupsDir = path.join(cfg.cdir, "backups");

  const backups = await listBackups(backupsDir);
  if (backups.length === 0) {
    logger.log(`No backups found in ${backupsDir}`);
    process.exit(2);
  }

  const rl = readline.createInterface({ input, output });
  try {
    logger.log("Available backups:");
    backups.forEach((b, i) => {
      const when = b.createdAt ? ` (${b.createdAt})` : "";
      logger.log(`  ${i + 1}) ${b.filename}${when}`);
    });
    const chosenBackupIdx = parseSelection(await rl.question("Select backup number: "), backups.length)[0];
    if (!chosenBackupIdx) {
      logger.log("No backup selected.");
      process.exit(2);
    }

    const chosenBackup = backups[chosenBackupIdx - 1];
    const raw = await readBackup(chosenBackup.fullPath);
    if (!isBackupV2(raw)) {
      logger.log("Selected backup is not in restoreable format (version 2). Create a new backup by running sync with backupdays enabled.");
      process.exit(2);
    }
    const backup: BackupV2 = raw;

    const emails = Object.keys(backup.accounts).sort();
    if (emails.length === 0) {
      logger.log("Backup contains no accounts.");
      process.exit(2);
    }

    logger.log("Accounts in backup:");
    emails.forEach((e, i) => logger.log(`  ${i + 1}) ${e}`));
    const accIdx = parseSelection(await rl.question("Select account(s) to restore (e.g. 1,2 or all): "), emails.length);
    if (accIdx.length === 0) {
      logger.log("No accounts selected.");
      process.exit(2);
    }
    const selectedEmails = accIdx.map((i) => emails[i - 1]);

    const prune = await askYesNo(rl, "Prune (delete) contacts/groups not present in backup? [y/N]: ", false);

    logger.log("\nRestore plan:");
    logger.log(`- Backup: ${chosenBackup.filename} (${backup.createdAt})`);
    logger.log(`- Accounts: ${selectedEmails.join(", ")}`);
    logger.log(`- Prune: ${prune ? "yes" : "no"}`);
    const ok = await askYesNo(rl, "Proceed? [y/N]: ", false);
    if (!ok) {
      logger.log("Cancelled.");
      process.exit(0);
    }

    // Build account config map from config.ini
    const configAccounts = getAccounts(cfg);
    const cfgByEmail = new Map(configAccounts.map((a) => [a.user, a] as const));

    for (const email of selectedEmails) {
      const accCfg = cfgByEmail.get(email);
      if (!accCfg) {
        logger.log(`Skipping ${email}: not found in ${cfg.cfile}`);
        continue;
      }

      const snap = backup.accounts[email];
      logger.log(`\nRestoring ${email}...`);

      const c = new Contacts({
        keyfile: accCfg.keyfile,
        credfile: accCfg.credfile,
        user: email,
        verbose: opts.verbose,
        debug: false,
        authTimeoutSeconds: 180,
        authMode: "local",
        apiTimeoutSeconds: 60,
        openBrowser: true,
        logger,
      });
      await c.init();

      // Ensure groups exist & match names
      const desiredGroupTags = Object.keys(snap.groupsByTag);
      for (const tag of desiredGroupTags) {
        const existingRn = c.tagToRnContactGroup(tag);
        if (existingRn) {
          await c.updateContactGroup(tag, { name: snap.groupsByTag[tag].name });
        } else {
          // Create with clientData tag
          const tmp = {
            contactGroup: {
              name: snap.groupsByTag[tag].name,
              clientData: [{ key: SYNC_TAG, value: tag }],
            },
          };
          const created = await c.addContactGroup(tmp, opts.verbose);
          if (created.resourceName) {
            // Some accounts occasionally don't return clientData right away; force a refresh
            await c.getContactGroupWaitSyncTag(created.resourceName, opts.verbose);
          }
        }
      }
      await c.getInfo();

      // Optionally prune groups
      if (prune) {
        const currentTags = new Set(Object.values(c.infoGroup).map((v) => v.tag).filter((t): t is string => !!t));
        const desired = new Set(desiredGroupTags);
        for (const t of currentTags) {
          if (!desired.has(t)) {
            await c.deleteContactGroup(t);
          }
        }
        await c.getInfo();
      }

      // Restore contacts
      const desiredContactTags = Object.keys(snap.contactsByTag);
      for (const tag of desiredContactTags) {
        const entry = snap.contactsByTag[tag];
        const body = structuredClone(entry.body);

        // Ensure csync-uid is present
        body.clientData = (body.clientData ?? []).filter((kv: any) => kv?.key !== SYNC_TAG);
        body.clientData.push({ key: SYNC_TAG, value: tag });

        // Rebuild memberships from groupTags for this account
        const memberships = (body.memberships ?? []).filter(
          (m: any) => m?.contactGroupMembership?.contactGroupResourceName === "contactGroups/myContacts",
        );

        for (const groupTag of entry.groupTags ?? []) {
          const rn = c.tagToRnContactGroup(groupTag);
          if (!rn) continue;
          const gid = removePrefix(rn, "contactGroups/");
          memberships.push({
            contactGroupMembership: {
              contactGroupId: gid,
              contactGroupResourceName: rn,
            },
          });
        }
        body.memberships = memberships;

        const rn = c.tagToRn(tag);
        if (rn) {
          await c.update(tag, body, opts.verbose);
        } else {
          await c.add(body);
        }
      }

      if (prune) {
        // Delete contacts not in snapshot
        await c.getInfo();
        const currentTags = new Set(Object.values(c.info).map((v) => v.tag).filter((t): t is string => !!t));
        const desired = new Set(desiredContactTags);
        for (const t of currentTags) {
          if (!desired.has(t)) {
            await c.delete(t, opts.verbose);
          }
        }
      }

      logger.log(`Done restoring ${email}.`);
    }

    logger.log("\nRestore completed.");
  } finally {
    rl.close();
  }
}
