# Google Contacts Sync

Sync the contacts of a bunch of google accounts using the People API.

ContactGroups (labels) and individual contacts are synced.

# Setup

1. [Create a Google Cloud Platform project and enable the people API](https://developers.google.com/workspace/guides/create-project).

2. [Create and download credentials](https://developers.google.com/workspace/guides/create-credentials)

3. Install software (Bun + TypeScript)

   ```
   bun install
   ```

4. Run the sync script

   ```
   bun run sync -v
   ```

   Common options:

   - Debug: `bun run sync -- --debug`
   - Rate limit during init: `bun run sync -- --init --rlim 1 -v`
   - Headless auth (copy/paste): `bun run sync -- --auth manual --no-open-browser -v`
   - Tune timeouts (avoid silent hangs): `bun run sync -- --auth-timeout 180 --api-timeout 60 --debug`

   it will create a default config file that you will need to edit.  The name
   of the config file will be displayed so you know what to edit (on my system
   it is `~/.local/share/google-contacts-sync/config.json`).

5. Edit the config file (`config.json`). Example:

    ```json
    {
       "last": "2021-07-02T09:44:37.906846+00:00",
       "backupdays": 30,
       "accounts": [
          {
             "user": "myemail@gmail.com",
             "keyfile": "/blah/.local/share/google-contacts-sync/myemail_keyfile.json",
             "credfile": "/blah/.local/share/google-contacts-sync/myemail_token"
          },
          {
             "user": "otheremail@gmail.com",
             "keyfile": "/blah/.local/share/google-contacts-sync/otheremail_keyfile.json",
             "credfile": "/blah/.local/share/google-contacts-sync/otheremail_token"
          }
       ]
    }
    ```

    You don't need to edit `last`, that gets updated when the script runs.
    The main things to set up are the `keyfile` paths and where the `credfile`
    token cache will be stored.

6. The script needs to store the `credfile` tokens (unless you have them from a
   previous syncer and just copy them in).

   - GUI machine: run normally; it will print an OAuth URL and try to open your browser.
   - Headless / no GUI: use manual mode (copy/paste) so it won't hang waiting for a browser callback:

     ```
     bun run sync -- --auth manual --no-open-browser -v
     ```

     It will print an OAuth URL. Open it on any machine with a browser, approve access,
     then copy/paste either the full redirected URL (containing `code=...`) or just the
     code into the terminal prompt.

7. Now you are ready to do syncing.  If you have previously used a google
   contacts syncer that uses the `csync-uid` field 
   (such as [sainf](https://github.com/sainf/google-contact-sync))
   then you are good to go and can just start running the `sync.py`
   periodically.  However if this is the first time doing syncing then you will
   have to initialize things.  This is where contacts a matched up using their
   names.  Just run

   ```
   bun run sync -- --init -v
   ```

   and let it run.  It will take ages, but will give you updates.  After this
   every contact will have a `csync-uid` field, unique across all your
   accounts.  So you can change peoples names if you want and syncing will just
   work because the `csync-uid` is used to identify people.  If you ever add
   another account you will have to run the --init again.  

# Restore

Restore is interactive:

```
bun run restore
```

Workflow:

1. Select a backup file from `conf/backups/*.bak`
2. Select account(s) to restore
3. Confirm (optionally prune remote contacts/groups not present in backup)

Notes:

- Backups are created only when `backupdays > 0` in `conf/config.json`.
- New backups written by the Bun version are JSON (versioned) and contain enough data to restore.

# Build

Build a Linux binary into `dist/linux`:

```
bun run build:linux
```

# Credits

- sainf (repo-specific modifications)
- GitHub Copilot (refactor assistance)

# License

MIT License

Copyright (c) 2026 sainf

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


