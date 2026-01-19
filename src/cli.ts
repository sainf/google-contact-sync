import { Command } from "commander";
import { runSync } from "./sync";
import { runRestore } from "./restore";

const program = new Command();
program
  .name("google-contact-sync")
  .description("Sync Google Contacts across accounts using the People API");

program
  .command("sync")
  .option("--init", "Initialize by syncing using names")
  .option("--rlim <seconds>", "If --init, wait this many seconds between each sync", (v) => Number(v))
  .option("--debug", "Extra debug output")
  .option("--auth <mode>", "Auth mode: local (default) or manual (copy/paste)", "local")
  .option(
    "--auth-timeout <seconds>",
    "Fail auth if the browser callback is not received in time",
    (v) => Number(v),
    180,
  )
  .option("--api-timeout <seconds>", "Timeout per Google API request", (v) => Number(v), 60)
  .option("--no-open-browser", "Do not try to auto-open the login URL")
  .option("-v, --verbose", "Verbose output")
  .option("-f, --file", "Save output to log.txt")
  .action(async (opts) => {
    const authMode = String(opts.auth ?? "local").toLowerCase();
    if (authMode !== "local" && authMode !== "manual") {
      console.error(`Invalid --auth value: ${opts.auth}. Use local or manual.`);
      process.exit(2);
    }

    await runSync({
      init: Boolean(opts.init),
      rlimSeconds: typeof opts.rlim === "number" && !Number.isNaN(opts.rlim) ? opts.rlim : undefined,
      debug: Boolean(opts.debug),
      authTimeoutSeconds:
        typeof opts.authTimeout === "number" && !Number.isNaN(opts.authTimeout) ? opts.authTimeout : 180,
      authMode,
      apiTimeoutSeconds:
        typeof opts.apiTimeout === "number" && !Number.isNaN(opts.apiTimeout) ? opts.apiTimeout : 60,
      openBrowser: Boolean(opts.openBrowser),
      verbose: Boolean(opts.verbose),
      file: Boolean(opts.file),
    });
  });

program
  .command("restore")
  .option("-v, --verbose", "Verbose output")
  .action(async (opts) => {
    await runRestore({ verbose: Boolean(opts.verbose) });
  });

// Bun sometimes forwards an extra standalone `--` into argv (especially when
// using `bun run <file> <cmd> -- --flag`). Commander treats that as the end of
// options, which makes flags look like positional args. Strip it to be
// forgiving.
const argv = [...process.argv];
const dashDash = argv.indexOf("--");
if (dashDash !== -1) argv.splice(dashDash, 1);

program.parseAsync(argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
