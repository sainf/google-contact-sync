import { google, people_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import open from "open";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileExists, withBackoff, withTimeout } from "./utils.js";
import type { Logger } from "./types.js";

export const SCOPES = ["https://www.googleapis.com/auth/contacts"];
export const SYNC_TAG = "csync-uid";

export const allPersonFields = [
  "addresses",
  "ageRanges",
  "biographies",
  "birthdays",
  "calendarUrls",
  "clientData",
  "coverPhotos",
  "emailAddresses",
  "events",
  "externalIds",
  "genders",
  "imClients",
  "interests",
  "locales",
  "locations",
  "memberships",
  "metadata",
  "miscKeywords",
  "names",
  "nicknames",
  "occupations",
  "organizations",
  "phoneNumbers",
  "photos",
  "relations",
  "sipAddresses",
  "skills",
  "urls",
  "userDefined",
] as const;

export const allUpdatePersonFields = [
  "addresses",
  "biographies",
  "birthdays",
  "clientData",
  "emailAddresses",
  "events",
  "externalIds",
  "genders",
  "imClients",
  "interests",
  "locales",
  "locations",
  "memberships",
  "names",
  "nicknames",
  "occupations",
  "organizations",
  "phoneNumbers",
  "relations",
  "sipAddresses",
  "urls",
  "userDefined",
] as const;

export type ContactInfo = {
  etag: string;
  tag: string | null;
  updated: Date;
  name: string;
};

export class Contacts {
  readonly user: string;
  readonly verbose: boolean;
  readonly debug: boolean;

  private keyfile: string;
  private credfile: string;
  private authTimeoutSeconds: number;
  private authMode: "local" | "manual";
  private apiTimeoutMs: number;
  private openBrowser: boolean;
  private logger?: Logger & { d?: (...args: any[]) => void };
  private auth!: OAuth2Client;
  private people!: people_v1.People;

  info: Record<string, ContactInfo> = {};
  infoGroup: Record<string, ContactInfo> = {};

  constructor(opts: {
    keyfile: string;
    credfile: string;
    user: string;
    verbose: boolean;
    debug: boolean;
    authTimeoutSeconds: number;
    authMode: "local" | "manual";
    apiTimeoutSeconds: number;
    openBrowser: boolean;
    logger?: Logger & { d?: (...args: any[]) => void };
  }) {
    this.keyfile = opts.keyfile;
    this.credfile = opts.credfile;
    this.user = opts.user;
    this.verbose = opts.verbose;
    this.debug = opts.debug;
    this.authTimeoutSeconds = opts.authTimeoutSeconds;
    this.authMode = opts.authMode;
    this.apiTimeoutMs = Math.max(1, opts.apiTimeoutSeconds) * 1000;
    this.openBrowser = opts.openBrowser;
    this.logger = opts.logger;
  }

  async init(): Promise<void> {
    this.logger?.d?.("Contacts.init start", { user: this.user, keyfile: this.keyfile, credfile: this.credfile });
    this.auth = await this.getAuthClient();
    this.people = google.people({ version: "v1", auth: this.auth });
    await this.getInfo();
    this.logger?.d?.("Contacts.init done", { user: this.user, contacts: Object.keys(this.info).length });
  }

  private async authenticateWithLocalServer(oauth2Client: OAuth2Client, redirectUri: string): Promise<OAuth2Client> {
    const redirect = new URL(redirectUri);
    if (redirect.hostname !== "localhost") {
      throw new Error(
        `Invalid redirect URI in keyfile (must be localhost): ${redirectUri}. Update your keyfile redirect_uris.`,
      );
    }

    const scopes = SCOPES;

    const timeoutMs = Math.max(5, this.authTimeoutSeconds) * 1000;
    const start = Date.now();

    return await new Promise<OAuth2Client>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url ?? "", "http://localhost");
          if (reqUrl.pathname !== redirect.pathname) {
            res.statusCode = 404;
            res.end("Invalid callback URL");
            return;
          }
          const err = reqUrl.searchParams.get("error");
          if (err) {
            res.end("Authorization rejected.");
            reject(new Error(err));
            return;
          }
          const code = reqUrl.searchParams.get("code");
          if (!code) {
            res.end("No authentication code provided.");
            reject(new Error("Cannot read authentication code."));
            return;
          }

          const { tokens } = await oauth2Client.getToken({ code, redirect_uri: redirect.toString() });
          oauth2Client.setCredentials(tokens);
          res.end("Authentication successful! Return to the console.");
          resolve(oauth2Client);
        } catch (e) {
          reject(e);
        } finally {
          server.close();
        }
      });

      const timer = setTimeout(() => {
        server.close();
        reject(
          new Error(
            `Auth timeout after ${this.authTimeoutSeconds}s. If you are on a headless box, run again with --no-open-browser and open the printed URL manually.`,
          ),
        );
      }, timeoutMs);

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          clearTimeout(timer);
          reject(new Error("Failed to bind local auth callback server"));
          return;
        }

        redirect.port = String(addr.port);

        const authorizeUrl = oauth2Client.generateAuthUrl({
          redirect_uri: redirect.toString(),
          access_type: "offline",
          scope: scopes.join(" "),
          prompt: "consent",
        });

        const msLeft = Math.max(0, timeoutMs - (Date.now() - start));
        this.logger?.log(`\nOAuth needed for ${this.user}`);
        this.logger?.log(`Open this URL to authorize (timeout in ~${Math.ceil(msLeft / 1000)}s):`);
        this.logger?.log(authorizeUrl);

        if (this.openBrowser) {
          open(authorizeUrl, { wait: false }).catch((e) => {
            this.logger?.v?.(`Could not auto-open browser: ${String(e?.message ?? e)}`);
          });
        }
      });

      // Ensure timer cleared on settle
      const settle = (fn: any) => (val: any) => {
        clearTimeout(timer);
        return fn(val);
      };
      // Wrap resolve/reject to clear timer
      // (safe: only the first one wins)
      resolve = settle(resolve) as any;
      reject = settle(reject) as any;
    });
  }

  private extractAuthCode(answer: string): string {
    const trimmed = answer.trim();
    if (!trimmed) throw new Error("No auth code provided");

    // User may paste full redirect URL (http://localhost:.../?code=...)
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const u = new URL(trimmed);
      const code = u.searchParams.get("code");
      if (!code) throw new Error("No code= parameter found in pasted URL");
      return code;
    }

    // Or paste just the code
    return trimmed;
  }

  private async authenticateManual(oauth2Client: OAuth2Client, redirectUri: string): Promise<OAuth2Client> {
    const scopes = SCOPES;
    const authorizeUrl = oauth2Client.generateAuthUrl({
      redirect_uri: redirectUri,
      access_type: "offline",
      scope: scopes.join(" "),
      prompt: "consent",
    });

    this.logger?.log(`\nOAuth needed for ${this.user}`);
    this.logger?.log("Open this URL to authorize:");
    this.logger?.log(authorizeUrl);
    this.logger?.log(
      "After approving, your browser will redirect to a localhost URL that contains `code=...` in the address bar. Copy and paste that full URL here (or paste just the code).",
    );

    if (this.openBrowser) {
      open(authorizeUrl, { wait: false }).catch((e) => {
        this.logger?.v?.(`Could not auto-open browser: ${String(e?.message ?? e)}`);
      });
    }

    const rl = readline.createInterface({ input, output });
    try {
      const answer = await withTimeout(
        rl.question("Paste redirected URL or code: "),
        Math.max(5, this.authTimeoutSeconds) * 1000,
        `Auth timeout after ${this.authTimeoutSeconds}s`,
      );
      const code = this.extractAuthCode(answer);
      const { tokens } = await oauth2Client.getToken({ code, redirect_uri: redirectUri });
      oauth2Client.setCredentials(tokens);
      return oauth2Client;
    } finally {
      rl.close();
    }
  }

  private async getAuthClient(): Promise<OAuth2Client> {
    // Load client secrets
    const secretsRaw = await readFile(this.keyfile, "utf8");
    const secrets = JSON.parse(secretsRaw);
    const installed = secrets.installed ?? secrets.web;
    if (!installed?.client_id || !installed?.client_secret || !installed?.redirect_uris?.[0]) {
      throw new Error(`Invalid keyfile format: ${this.keyfile}`);
    }

    const oauth2Client = new OAuth2Client(installed.client_id, installed.client_secret, installed.redirect_uris[0]);

    if (fileExists(this.credfile)) {
      try {
        const tokenRaw = await readFile(this.credfile, "utf8");
        const token = JSON.parse(tokenRaw);
        oauth2Client.setCredentials(token);

        // Force a refresh if needed; if it fails, fall back to re-auth.
        this.logger?.d?.("using cached token", { user: this.user, credfile: this.credfile });
        await withTimeout(
          oauth2Client.getAccessToken(),
          this.apiTimeoutMs,
          `Timeout while refreshing token for ${this.user}. If running headless, try --auth manual`,
        );
        return oauth2Client;
      } catch {
        // Continue to interactive auth below
        this.logger?.d?.("cached token refresh failed; re-auth needed", { user: this.user });
      }
    }

    if (this.verbose) console.log(`login into: ${this.user}`);

    this.logger?.d?.("starting interactive OAuth", {
      user: this.user,
      redirectUri: installed.redirect_uris[0],
      authMode: this.authMode,
      openBrowser: this.openBrowser,
      timeoutSeconds: this.authTimeoutSeconds,
    });

    // Auto-switch to manual if no GUI is available and user didn't explicitly pick local.
    const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    if (headless && this.authMode === "local" && this.openBrowser) {
      this.logger?.v?.("No DISPLAY detected; if auth stalls, try: --auth manual --no-open-browser");
    }

    const redirectUri = installed.redirect_uris[0];
    const authClient =
      this.authMode === "manual"
        ? await this.authenticateManual(oauth2Client, redirectUri)
        : await this.authenticateWithLocalServer(oauth2Client, redirectUri);

    await mkdir(path.dirname(this.credfile), { recursive: true, mode: 0o755 });
    await writeFile(this.credfile, JSON.stringify(authClient.credentials, null, 2), "utf8");

    return authClient;
  }

  static stripPersonForUpdate(body: any): any {
    const bad = new Set(["metadata", "coverPhotos", "photos", "resourceName", "etag"]);
    const toKeep = new Set(allPersonFields.filter((f) => !bad.has(f)));

    const ret: any = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (!toKeep.has(k as any)) continue;
      ret[k] = v;
    }

    for (const [k, v] of Object.entries(ret)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === "object") delete (item as any).metadata;
        }
      } else if (v && typeof v === "object") {
        delete (v as any).metadata;
      }
    }

    if (Array.isArray(ret.names) && ret.names.length > 0) ret.names = [ret.names[0]];
    if (Array.isArray(ret.genders) && ret.genders.length > 0) ret.genders = [ret.genders[0]];
    if (Array.isArray(ret.birthdays) && ret.birthdays.length > 0) ret.birthdays = [ret.birthdays[0]];

    return ret;
  }

  async getInfo(): Promise<void> {
    this.logger?.d?.("getInfo start", { user: this.user });
    this.info = {};
    const contacts = await this.getAllContacts(["names", "organizations", "clientData", "metadata"]);

    for (const p of contacts) {
      const tagls = (p.clientData ?? [])
        .filter((kv) => kv?.key === SYNC_TAG)
        .map((kv) => kv?.value)
        .filter((v) => typeof v === "string");

      if (!p.names && !p.organizations) continue;

      const name = p.names?.[0]?.displayName ?? p.organizations?.[0]?.name;
      if (!name) continue;

      const updateTime = p.metadata?.sources?.[0]?.updateTime;
      const updated = updateTime ? new Date(updateTime) : new Date(0);

      if (!p.resourceName || !p.etag) continue;
      this.info[p.resourceName] = {
        etag: p.etag,
        tag: tagls[0] ?? null,
        updated,
        name,
      };
    }

    this.infoGroup = {};
    const groups = await this.getContactGroups();
    for (const g of groups) {
      if (g.groupType !== "USER_CONTACT_GROUP") continue;

      const tagls = (g.clientData ?? [])
        .filter((kv) => kv?.key === SYNC_TAG)
        .map((kv) => kv?.value)
        .filter((v) => typeof v === "string");

      const updated = g.metadata?.updateTime ? new Date(g.metadata.updateTime) : new Date(0);
      if (!g.resourceName || !g.etag || !g.name) continue;

      this.infoGroup[g.resourceName] = {
        etag: g.etag,
        tag: tagls[0] ?? null,
        updated,
        name: g.name,
      };
    }

    this.logger?.d?.("getInfo done", {
      user: this.user,
      contacts: Object.keys(this.info).length,
      groups: Object.keys(this.infoGroup).length,
    });
  }

  async getAllContacts(fields: string[]): Promise<people_v1.Schema$Person[]> {
    const out: people_v1.Schema$Person[] = [];
    let pageToken: string | undefined = "";

    while (pageToken !== undefined && pageToken !== null) {
      const res = (await withTimeout(
        this.people.people.connections.list(
          {
        resourceName: "people/me",
        pageSize: 1000,
        personFields: fields.join(","),
        pageToken: pageToken || undefined,
          },
          { timeout: this.apiTimeoutMs },
        ),
        this.apiTimeoutMs,
        `Timeout listing contacts for ${this.user}`,
      )) as { data: people_v1.Schema$ListConnectionsResponse };

      out.push(...(res.data.connections ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    }

    return out;
  }

  tagToRn(tag: string): string | null {
    const rn = Object.entries(this.info)
      .filter(([, v]) => v.tag === tag)
      .map(([k]) => k);
    if (rn.length === 0) return null;
    if (rn.length !== 1) throw new Error(`Expected exactly one rn for tag ${tag}, got ${rn.length}`);
    return rn[0];
  }

  nameToRn(name: string): string | null {
    const rn = Object.entries(this.info)
      .filter(([, v]) => v.name.toLowerCase() === name.toLowerCase())
      .map(([k]) => k);
    if (rn.length === 0) return null;
    if (rn.length !== 1) throw new Error(`Expected exactly one rn for name ${name}, got ${rn.length}`);
    return rn[0];
  }

  async delete(tag: string, verbose = false): Promise<void> {
    const rn = this.tagToRn(tag);
    if (!rn) return;

    if (verbose) process.stdout.write(`${this.info[rn]?.name ?? ""} `);

    await withBackoff(async () => {
      await withTimeout(
        this.people.people.deleteContact({ resourceName: rn }, { timeout: this.apiTimeoutMs }),
        this.apiTimeoutMs,
        `Timeout deleting contact ${rn} for ${this.user}`,
      );
    });
  }

  async updateTag(rn: string, tag: string): Promise<void> {
    await withBackoff(async () => {
      const p = await withTimeout(
        this.people.people.get({ resourceName: rn, personFields: "clientData" }, { timeout: this.apiTimeoutMs }),
        this.apiTimeoutMs,
        `Timeout reading clientData for ${rn} (${this.user})`,
      );

      const wout = (p.data.clientData ?? []).filter((i) => i?.key !== SYNC_TAG);
      wout.push({ key: SYNC_TAG, value: tag });

      const etag = this.info[rn]?.etag;
      if (!etag) throw new Error(`Missing etag for ${rn}`);

      await withTimeout(
        this.people.people.updateContact(
          {
            resourceName: rn,
            updatePersonFields: "clientData",
            requestBody: { etag, clientData: wout },
          },
          { timeout: this.apiTimeoutMs },
        ),
        this.apiTimeoutMs,
        `Timeout updating clientData for ${rn} (${this.user})`,
      );
    });
  }

  async add(body: any): Promise<people_v1.Schema$Person> {
    const res = await withBackoff(async () => {
      return await withTimeout(
        this.people.people.createContact({ requestBody: body }, { timeout: this.apiTimeoutMs }),
        this.apiTimeoutMs,
        `Timeout creating contact for ${this.user}`,
      );
    });
    return res.data;
  }

  async update(tag: string, body: any, verbose = false): Promise<void> {
    const rn = this.tagToRn(tag);
    if (!rn) return;

    await withBackoff(async () => {
      const etag = this.info[rn]?.etag;
      if (!etag) throw new Error(`Missing etag for ${rn}`);

      const requestBody = { ...body, etag };
      try {
        await withTimeout(
          this.people.people.updateContact(
            {
              resourceName: rn,
              updatePersonFields: allUpdatePersonFields.join(","),
              requestBody,
            },
            { timeout: this.apiTimeoutMs },
          ),
          this.apiTimeoutMs,
          `Timeout updating contact ${rn} for ${this.user}`,
        );
      } catch (e: any) {
        if (verbose) console.error("\n", "[ERROR]", e);
        throw e;
      }
    });
  }

  async get(rn: string, verbose = false): Promise<any> {
    const res = await withBackoff(async () => {
      try {
        return await withTimeout(
          this.people.people.get(
            {
              resourceName: rn,
              personFields: allPersonFields.join(","),
            },
            { timeout: this.apiTimeoutMs },
          ),
          this.apiTimeoutMs,
          `Timeout getting contact ${rn} for ${this.user}`,
        );
      } catch (e: any) {
        if (verbose) console.error("\n", "[ERROR]", e);
        throw e;
      }
    });

    return Contacts.stripPersonForUpdate(res.data);
  }

  rnToTagContactGroup(rn: string): string | null {
    const v = this.infoGroup[rn];
    return v?.tag ?? null;
  }

  tagToRnContactGroup(tag: string): string | null {
    const rn = Object.entries(this.infoGroup)
      .filter(([, v]) => v.tag === tag)
      .map(([k]) => k);
    if (rn.length === 0) return null;
    if (rn.length !== 1) throw new Error(`Expected exactly one group rn for tag ${tag}, got ${rn.length}`);
    return rn[0];
  }

  async addContactGroup(body: any, verbose = false): Promise<people_v1.Schema$ContactGroup> {
    const res = await withBackoff(async () => {
      try {
        body.readGroupFields = "clientData,groupType,metadata,name";
        return await this.people.contactGroups.create({ requestBody: body });
      } catch (e: any) {
        if (verbose) console.error("\n", "[ERROR]", e);
        throw e;
      }
    });

    return res.data;
  }

  async getContactGroups(verbose = false): Promise<people_v1.Schema$ContactGroup[]> {
    const out: people_v1.Schema$ContactGroup[] = [];
    let pageToken: string | undefined = "";

    while (pageToken !== undefined && pageToken !== null) {
      const res = await withBackoff(async () => {
        try {
          return await withTimeout(
            this.people.contactGroups.list(
              {
                pageSize: 1000,
                pageToken: pageToken || undefined,
                groupFields: "clientData,name,metadata,groupType",
              },
              { timeout: this.apiTimeoutMs },
            ),
            this.apiTimeoutMs,
            `Timeout listing contact groups for ${this.user}`,
          );
        } catch (e: any) {
          if (verbose) console.error("\n", "[ERROR]", e);
          throw e;
        }
      });

      out.push(...(res.data.contactGroups ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    }

    return out;
  }

  async getContactGroup(rn: string, verbose = false): Promise<people_v1.Schema$ContactGroup> {
    const res = await withBackoff(async () => {
      try {
        return await withTimeout(
          this.people.contactGroups.get(
            {
              resourceName: rn,
              groupFields: "clientData,groupType,metadata,name",
            },
            { timeout: this.apiTimeoutMs },
          ),
          this.apiTimeoutMs,
          `Timeout getting contact group ${rn} for ${this.user}`,
        );
      } catch (e: any) {
        if (verbose) console.error("\n", "[ERROR]", e);
        throw e;
      }
    });
    return res.data;
  }

  async getContactGroupWaitSyncTag(rn: string, verbose = false): Promise<people_v1.Schema$ContactGroup> {
    let delayMs = 500;
    while (true) {
      const cont = await this.getContactGroup(rn, verbose);
      const cd = cont.clientData ?? [];
      const has = cd.some((i) => i?.key === SYNC_TAG);
      if (has) return cont;

      if (verbose) console.error("\n", "[ERROR]", "SYNC_TAG missing");
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }

  async updateContactGroupTag(rn: string, tag: string): Promise<void> {
    await withBackoff(async () => {
      try {
        const p = await this.people.contactGroups.get({ resourceName: rn, groupFields: "clientData" });
        const wout = (p.data.clientData ?? []).filter((i) => i?.key !== SYNC_TAG);
        wout.push({ key: SYNC_TAG, value: tag });

        const etag = this.infoGroup[rn]?.etag;
        if (!etag) throw new Error(`Missing etag for group ${rn}`);

        await this.people.contactGroups.update({
          resourceName: rn,
          requestBody: {
            contactGroup: { etag, clientData: wout },
            updateGroupFields: "clientData",
            readGroupFields: "clientData,groupType,metadata,name",
          },
        });
      } catch (e: any) {
        const code = e?.code ?? e?.response?.status;
        const reason = e?.errors?.[0]?.reason ?? e?.message ?? "";
        if (code === 409 && String(reason).includes("etag")) {
          const fresh = await this.getContactGroup(rn);
          // Keep existing tag in cache if already present
          const currentTag = this.infoGroup[rn]?.tag ?? null;
          if (fresh.resourceName && fresh.etag && fresh.name) {
            this.infoGroup[fresh.resourceName] = {
              etag: fresh.etag,
              tag: currentTag,
              updated: fresh.metadata?.updateTime ? new Date(fresh.metadata.updateTime) : new Date(0),
              name: fresh.name,
            };
          }
          throw e;
        }
        throw e;
      }
    });
  }

  async updateContactGroup(tag: string, body: any): Promise<void> {
    const rn = this.tagToRnContactGroup(tag);
    if (!rn) return;

    await withBackoff(async () => {
      await this.people.contactGroups.update({
        resourceName: rn,
        requestBody: {
          contactGroup: { etag: this.infoGroup[rn]?.etag, name: body.name },
          readGroupFields: "clientData,groupType,metadata,name",
        },
      });
    });
  }

  async deleteContactGroup(tag: string): Promise<void> {
    const rn = this.tagToRnContactGroup(tag);
    if (!rn) return;

    await withBackoff(async () => {
      await this.people.contactGroups.delete({ resourceName: rn, deleteContacts: false });
    });
  }
}
