import path from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import crypto from "node:crypto";
import type { SyncOptions } from "./types.js";
import { Contacts, SYNC_TAG, allPersonFields } from "./contacts.js";
import {
  getAccounts,
  getBackupDays,
  getLastRunIso,
  loadConfigOrCreateDefault,
  resolveConfigDir,
  saveConfigLastRun,
} from "./config.js";
import { createLogger } from "./logger.js";
import type { BackupV2 } from "./backup.js";
import { writeBackupV2 } from "./backup.js";
import { duplicates, fileExists, removePrefix, sleep } from "./utils.js";

const LOG_NAME = "log.txt";

function newTag(used: Set<string>): string {
  while (true) {
    // 20 lowercase chars, close enough to Python behavior.
    const buf = crypto.randomBytes(20);
    const tag = Array.from(buf)
      .map((b) => String.fromCharCode(97 + (b % 26)))
      .join("");
    if (!used.has(tag)) {
      used.add(tag);
      return tag;
    }
  }
}

function safeDate(iso: string): Date {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : new Date(0);
}

async function rotateBackups(cdir: string, backupDays: number): Promise<void> {
  if (backupDays <= 0) return;
  const backupsDir = path.join(cdir, "backups");
  await mkdir(backupsDir, { recursive: true, mode: 0o755 });

  const lastBackup = path.join(backupsDir, `${backupDays}.bak`);
  if (fileExists(lastBackup)) {
    await rm(lastBackup);
  }

  for (let i = backupDays - 1; i >= 1; i--) {
    const from = path.join(backupsDir, `${i}.bak`);
    const to = path.join(backupsDir, `${i + 1}.bak`);
    if (fileExists(from)) {
      await rename(from, to);
    }
  }
}

// Backup writing is handled by writeBackupV2

export async function runSync(opts: SyncOptions): Promise<void> {
  const t0 = Date.now();
  const cdir = await resolveConfigDir();
  const cfg = await loadConfigOrCreateDefault(cdir);

  const logger = createLogger({
    verbose: opts.verbose,
    debug: opts.debug,
    file: opts.file,
    logFilePath: path.join(process.cwd(), LOG_NAME),
  });

  logger.d("runSync start", { cdir: cfg.cdir, cfile: cfg.cfile, init: opts.init });

  logger.v(`loaded ${cfg.cfile}`);
  logger.v("Getting contacts");

  const accounts = getAccounts(cfg);
  if (accounts.length === 0) {
    logger.log(`No accounts found in ${cfg.cfile}`);
    process.exit(2);
  }

  const con = new Map<string, Contacts>();
  for (const acc of accounts) {
    logger.log(`Initializing account ${acc.user}...`);
    const c = new Contacts({
      keyfile: acc.keyfile,
      credfile: acc.credfile,
      user: acc.user,
      verbose: opts.verbose,
      debug: opts.debug,
      authTimeoutSeconds: opts.authTimeoutSeconds,
      authMode: opts.authMode,
      apiTimeoutSeconds: opts.apiTimeoutSeconds,
      openBrowser: opts.openBrowser,
      logger,
    });
    await c.init();
    con.set(acc.user, c);
    logger.log(`Initialized ${acc.user} (${Object.keys(c.info).length} contacts)`);
  }
  logger.d("accounts initialized", { count: con.size });

  // backup (TS version writes a JSON snapshot instead of Python pickle)
  const backupDays = getBackupDays(cfg);
  if (backupDays > 0) {
    await rotateBackups(cfg.cdir, backupDays);

    const backupsDir = path.join(cfg.cdir, "backups");
    const snapshot: BackupV2 = {
      version: 2,
      createdAt: new Date().toISOString(),
      accounts: {},
    };

    for (const [email, c] of con.entries()) {
      logger.v(`Creating backup snapshot for ${email}...`);

      // Groups: list call already includes name + clientData
      const groupsByRn = await c.getContactGroups(opts.verbose);
      const groupsByTag: Record<string, { tag: string; name: string }> = {};
      const groupRnToTag = new Map<string, string>();
      for (const g of groupsByRn) {
        if (g.groupType !== "USER_CONTACT_GROUP") continue;
        const tag = (g.clientData ?? []).find((kv: any) => kv?.key === SYNC_TAG)?.value;
        if (!tag || typeof tag !== "string") continue;
        if (g.resourceName) groupRnToTag.set(g.resourceName, tag);
        groupsByTag[tag] = { tag, name: g.name ?? "" };
      }

      // Contacts: pull full connections in a few paginated calls (not per-contact)
      const persons = await c.getAllContacts(Array.from(allPersonFields));
      const contactsByTag: Record<string, any> = {};
      for (const p of persons) {
        const tag = (p.clientData ?? []).find((kv: any) => kv?.key === SYNC_TAG)?.value;
        if (!tag || typeof tag !== "string") continue;
        const name = p.names?.[0]?.displayName ?? p.organizations?.[0]?.name;

        // Extract group tags from memberships
        const groupRns: string[] = (p.memberships ?? [])
          .map((m: any) => m?.contactGroupMembership?.contactGroupResourceName)
          .filter((rn: any) => typeof rn === "string" && rn !== "contactGroups/myContacts");
        const groupTags = groupRns
          .map((rn) => groupRnToTag.get(rn))
          .filter((t): t is string => typeof t === "string" && t.length > 0);

        // Strip to an updateable body and remove label memberships; we restore labels via groupTags.
        const body = Contacts.stripPersonForUpdate(p);
        body.memberships = (body.memberships ?? []).filter(
          (m: any) => m?.contactGroupMembership?.contactGroupResourceName === "contactGroups/myContacts",
        );

        // Ensure clientData carries the tag
        body.clientData = (body.clientData ?? []).filter((kv: any) => kv?.key !== SYNC_TAG);
        body.clientData.push({ key: SYNC_TAG, value: tag });

        contactsByTag[tag] = {
          tag,
          name: typeof name === "string" ? name : undefined,
          groupTags,
          body,
        };
      }

      snapshot.accounts[email] = {
        email,
        contactsByTag,
        groupsByTag,
      };
    }

    await writeBackupV2(backupsDir, snapshot);
  }

  const usedTags = new Set<string>();

  if (opts.init) {
    logger.log("Setting up syncing using names to identify identical contacts");

    for (const [email, acc] of con.entries()) {
      const dups = duplicates(Object.values(acc.info).map((i) => i.name));
      if (dups.size > 0) {
        logger.log("");
        logger.log(
          `These contacts (${Array.from(dups).join(",")}) are duplicated in account ${email}. I will not continue, this will cause confusion`,
        );
        logger.log("");
        logger.log("Please remove your duplicates and try again");
        process.exit(1);
      }
    }

    const done = new Set<string>();
    for (const [email, acc] of con.entries()) {
      let ndone = 0;
      let nsync = 0;

      for (const [rn, p] of Object.entries(acc.info)) {
        if (done.has(p.name)) {
          ndone += 1;
          continue;
        }

        let tag = p.tag;
        if (!tag) {
          tag = newTag(usedTags);
          await acc.updateTag(rn, tag);
          p.tag = tag;
        }

        const newcontact = await acc.get(rn, opts.verbose);
        for (const [otheremail, otheracc] of con.entries()) {
          if (otheracc === acc) continue;
          const otherRn = otheracc.nameToRn(p.name);
          if (otherRn) {
            await otheracc.updateTag(otherRn, tag);
            await otheracc.update(tag, newcontact, opts.verbose);
          } else {
            await otheracc.add(newcontact);
          }
        }

        done.add(p.name);
        nsync += 1;
        if (opts.rlimSeconds && opts.rlimSeconds > 0) {
          await sleep(opts.rlimSeconds * 1000);
        }

        process.stdout.write(
          `Pushing ${email} (tot ${Object.keys(acc.info).length}): synced ${nsync}, done before ${ndone}\r`,
        );
      }
      process.stdout.write("\n");
    }

    await saveConfigLastRun(cfg);
    logger.d("runSync done", { ms: Date.now() - t0 });
    return;
  }

  // detect new accounts: accounts where all tags are null
  const checked = new Map<string, Contacts>();
  const newCon = new Map<string, Contacts>();

  for (const [email, acc] of con.entries()) {
    const allNone = Object.values(acc.info).every((v) => v.tag === null);
    if (allNone) newCon.set(email, acc);
    else checked.set(email, acc);
  }

  if (checked.size === 0) {
    logger.log(
      "all emails have no sync tags. It looks like this is the first time running this script for this account. You need to pass --init for me to assign the sync tag to each contact",
    );
    process.exit(2);
  }

  const active = checked;

  // ======================================
  // Sync ContactGroup
  // ======================================
  logger.v("ContactGroups synchronization...");
  const allGroupTags = new Set<string>();
  for (const acc of active.values()) {
    for (const v of Object.values(acc.infoGroup)) {
      if (v.tag) allGroupTags.add(v.tag);
    }
  }

  logger.v("ContactGroups - Checking what to delete");
  const groupsToDelete = new Set<string>();
  for (const [email, acc] of active.entries()) {
    const tags = new Set(Object.values(acc.infoGroup).map((v) => v.tag).filter((t): t is string => !!t));
    const rm = Array.from(allGroupTags).filter((t) => !tags.has(t));
    if (rm.length > 0) logger.log(`${email}: ${rm.length} ContactGroup(s) deleted`);
    for (const t of rm) groupsToDelete.add(t);
  }

  if (groupsToDelete.size > 0) {
    for (const [email, acc] of active.entries()) {
      logger.log(`removing ContactGroups from ${email}: `);
      for (const tag of groupsToDelete) {
        await acc.deleteContactGroup(tag);
      }
    }

    for (const acc of active.values()) {
      await acc.getInfo();
    }
  }

  logger.v("ContactGroups - Checking for new ContactGroup");
  const addedGroups: Array<{ acc: Contacts; rn: string }> = [];
  for (const [email, acc] of active.entries()) {
    const toAdd = Object.entries(acc.infoGroup)
      .filter(([, v]) => v.tag === null)
      .map(([rn, v]) => ({ rn, name: v.name }));
    if (toAdd.length > 0) logger.v(`${email}: these are new ${toAdd.map((i) => i.name).join(",")}`);

    for (const { rn, name } of toAdd) {
      const tag = newTag(usedTags);
      await acc.updateContactGroupTag(rn, tag);
      const group = await acc.getContactGroupWaitSyncTag(rn, opts.verbose);

      addedGroups.push({ acc, rn });

      for (const [otherEmail, other] of active.entries()) {
        if (other === acc) continue;
        logger.v(`adding ${name} to ${otherEmail}`);
        const tmp = { contactGroup: { name: group.name, clientData: group.clientData } };
        const created = await other.addContactGroup(tmp);
        if (created.resourceName) addedGroups.push({ acc: other, rn: created.resourceName });
      }
    }
  }

  const lastUpdate = safeDate(getLastRunIso(cfg));
  const groupUpdates = new Map<string, Array<{ acc: Contacts; rn: string; updated: Date }>>();
  for (const acc of active.values()) {
    for (const [rn, v] of Object.entries(acc.infoGroup)) {
      if (!v.tag) continue;
      const wasAdded = addedGroups.some((x) => x.acc === acc && x.rn === rn);
      if (v.updated > lastUpdate && !wasAdded) {
        const list = groupUpdates.get(v.tag) ?? [];
        list.push({ acc, rn, updated: v.updated });
        groupUpdates.set(v.tag, list);
      }
    }
  }

  logger.v(`ContactGroups - There are ${groupUpdates.size} contactGroups to update`);
  for (const [tag, val] of groupUpdates.entries()) {
    const newest = val.reduce((a, b) => (a.updated >= b.updated ? a : b));
    const srcAcc = newest.acc;
    const srcRn = newest.rn;
    logger.v(`${srcAcc.infoGroup[srcRn]?.name ?? ""}: `);

    const group = await srcAcc.getContactGroup(srcRn);
    for (const [otherEmail, otherAcc] of active.entries()) {
      if (otherAcc === srcAcc) continue;
      logger.v(`${otherEmail} `);
      await otherAcc.updateContactGroup(tag, group);
    }
  }

  // ======================================
  // Sync Contact
  // ======================================
  logger.v("Contacts synchronization...");
  const allTags = new Set<string>();
  for (const acc of active.values()) {
    for (const v of Object.values(acc.info)) {
      if (v.tag) allTags.add(v.tag);
    }
  }

  logger.v("Checking what to delete");
  const toDelete = new Set<string>();
  for (const [email, acc] of active.entries()) {
    const tags = new Set(Object.values(acc.info).map((v) => v.tag).filter((t): t is string => !!t));
    const rm = Array.from(allTags).filter((t) => !tags.has(t));
    if (rm.length > 0) logger.v(`${email}: ${rm.length} contact(s) deleted`);
    for (const t of rm) toDelete.add(t);
  }

  if (toDelete.size > 0) {
    for (const [email, acc] of active.entries()) {
      logger.v(`removing contacts from ${email}: `);
      for (const tag of toDelete) {
        await acc.delete(tag, opts.verbose);
      }
      logger.v("");
    }
    for (const acc of active.values()) {
      await acc.getInfo();
    }
  }

  logger.v("Checking for new people");
  const addedContacts: Array<{ acc: Contacts; rn: string }> = [];
  for (const [email, acc] of active.entries()) {
    const toAdd = Object.entries(acc.info)
      .filter(([, v]) => v.tag === null)
      .map(([rn, v]) => ({ rn, name: v.name }));
    if (toAdd.length > 0) logger.v(`${email}: these are new ${toAdd.map((i) => i.name).join(",")}`);

    for (const { rn, name } of toAdd) {
      const tag = newTag(usedTags);
      await acc.updateTag(rn, tag);
      const newcontact = await acc.get(rn, opts.verbose);
      addedContacts.push({ acc, rn });

      const groupRns: string[] = (newcontact.memberships ?? [])
        .map((grp: any) => grp?.contactGroupMembership?.contactGroupResourceName)
        .filter((g: any) => typeof g === "string" && g !== "contactGroups/myContacts");
      const groupTags: (string | null)[] = groupRns.map((groupRn) => acc.rnToTagContactGroup(groupRn));

      // remove all labels except myContacts
      newcontact.memberships = (newcontact.memberships ?? []).filter(
        (grp: any) => grp?.contactGroupMembership?.contactGroupResourceName === "contactGroups/myContacts",
      );

      for (const [otherEmail, other] of active.entries()) {
        if (other === acc) continue;
        logger.v(`adding ${name} to ${otherEmail}`);

        if (groupTags.filter(Boolean).length > 0) {
          const contactCopy = structuredClone(newcontact);
          for (const groupTag of groupTags) {
            if (!groupTag) continue;
            const groupRnOther = other.tagToRnContactGroup(groupTag);
            if (!groupRnOther) continue;
            const groupIdOther = removePrefix(groupRnOther, "contactGroups/");
            contactCopy.memberships = contactCopy.memberships ?? [];
            contactCopy.memberships.push({
              contactGroupMembership: {
                contactGroupId: groupIdOther,
                contactGroupResourceName: groupRnOther,
              },
            });
          }

          const created = await other.add(contactCopy);
          if (created.resourceName) addedContacts.push({ acc: other, rn: created.resourceName });
        } else {
          const created = await other.add(newcontact);
          if (created.resourceName) addedContacts.push({ acc: other, rn: created.resourceName });
        }
      }
    }
  }

  const contactUpdates = new Map<string, Array<{ acc: Contacts; rn: string; updated: Date }>>();
  for (const acc of active.values()) {
    for (const [rn, v] of Object.entries(acc.info)) {
      if (!v.tag) continue;
      const wasAdded = addedContacts.some((x) => x.acc === acc && x.rn === rn);
      if (v.updated > lastUpdate && !wasAdded) {
        const list = contactUpdates.get(v.tag) ?? [];
        list.push({ acc, rn, updated: v.updated });
        contactUpdates.set(v.tag, list);
      }
    }
  }

  logger.v(`There are ${contactUpdates.size} contacts to update`);
  for (const [tag, val] of contactUpdates.entries()) {
    const newest = val.reduce((a, b) => (a.updated >= b.updated ? a : b));
    const srcAcc = newest.acc;
    const srcRn = newest.rn;
    logger.v(`${srcAcc.info[srcRn]?.name ?? ""}: `);

    const contact = await srcAcc.get(srcRn, opts.verbose);

    const groupRns: string[] = (contact.memberships ?? [])
      .map((grp: any) => grp?.contactGroupMembership?.contactGroupResourceName)
      .filter((g: any) => typeof g === "string" && g !== "contactGroups/myContacts");
    const groupTags: (string | null)[] = groupRns.map((groupRn) => srcAcc.rnToTagContactGroup(groupRn));

    contact.memberships = (contact.memberships ?? []).filter(
      (grp: any) => grp?.contactGroupMembership?.contactGroupResourceName === "contactGroups/myContacts",
    );

    for (const [otherEmail, otherAcc] of active.entries()) {
      if (otherAcc === srcAcc) continue;
      logger.v(`${otherEmail} `);

      if (groupTags.filter(Boolean).length > 0) {
        const contactCopy = structuredClone(contact);
        for (const groupTag of groupTags) {
          if (!groupTag) continue;
          const rnOther = otherAcc.tagToRnContactGroup(groupTag);
          if (!rnOther) continue;
          const gid = removePrefix(rnOther, "contactGroups/");
          contactCopy.memberships = contactCopy.memberships ?? [];
          contactCopy.memberships.push({
            contactGroupMembership: {
              contactGroupId: gid,
              contactGroupResourceName: rnOther,
            },
          });
        }
        await otherAcc.update(tag, contactCopy, opts.verbose);
      } else {
        await otherAcc.update(tag, contact, opts.verbose);
      }
    }
  }

  if (newCon.size > 0) {
    logger.v("There are new accounts!");
    const source = active.values().next().value as Contacts;
    await source.getInfo();

    // Sync ContactGroups to new accounts
    const toAddGroups = Object.entries(source.infoGroup).map(([rn, v]) => ({ rn, name: v.name }));
    if (toAddGroups.length > 0) logger.v(`contactsGroup to add: ${toAddGroups.map((i) => i.name).join(",")}`);

    for (const { rn, name } of toAddGroups) {
      const group = await source.getContactGroup(rn);
      for (const [otherEmail, other] of newCon.entries()) {
        logger.v(`adding ${name} to ${otherEmail}`);
        const tmp = { contactGroup: { name: group.name, clientData: group.clientData } };
        await other.addContactGroup(tmp);
      }
    }

    // refresh groups in new accounts so tag mapping works
    for (const newAcc of newCon.values()) {
      await newAcc.getInfo();
    }

    // Sync Contacts to new accounts
    const toAddContacts = Object.entries(source.info).map(([rn, v]) => ({ rn, name: v.name }));
    if (toAddContacts.length > 0) logger.v(`contacts to add: ${toAddContacts.map((i) => i.name).join(",")}`);

    for (const { rn, name } of toAddContacts) {
      const contact = await source.get(rn, opts.verbose);

      const groupRns: string[] = (contact.memberships ?? [])
        .map((grp: any) => grp?.contactGroupMembership?.contactGroupResourceName)
        .filter((g: any) => typeof g === "string" && g !== "contactGroups/myContacts");
      const groupTags: (string | null)[] = groupRns.map((groupRn) => source.rnToTagContactGroup(groupRn));

      contact.memberships = (contact.memberships ?? []).filter(
        (grp: any) => grp?.contactGroupMembership?.contactGroupResourceName === "contactGroups/myContacts",
      );

      for (const [otherEmail, other] of newCon.entries()) {
        logger.v(`adding ${name} to ${otherEmail}`);

        if (groupTags.filter(Boolean).length > 0) {
          const contactCopy = structuredClone(contact);
          for (const groupTag of groupTags) {
            if (!groupTag) continue;
            const groupRnOther = other.tagToRnContactGroup(groupTag);
            if (!groupRnOther) continue;
            const groupIdOther = removePrefix(groupRnOther, "contactGroups/");
            contactCopy.memberships = contactCopy.memberships ?? [];
            contactCopy.memberships.push({
              contactGroupMembership: {
                contactGroupId: groupIdOther,
                contactGroupResourceName: groupRnOther,
              },
            });
          }
          await other.add(contactCopy);
        } else {
          await other.add(contact);
        }
      }
    }
  }

  await saveConfigLastRun(cfg);
  logger.d("runSync done", { ms: Date.now() - t0 });
}
