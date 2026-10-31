# fiveupdate

Keeps your resources up to date from their GitHub releases without losing the changes you made to them.

Updating a resource by hand usually means copying the new version over the old one and then redoing your config, or skipping the update. fiveupdate downloads both the release you have installed and the new one, works out who changed what, and only hands over what the update changed. Your edits stay.

It works with any resource that has a `version` and a GitHub `repository` in its `fxmanifest.lua` and publishes releases on GitHub. That covers the ox resources, Qbox and most of the bigger open source scripts, as well as anything else you list in the config.

## How it decides

For every file in the old and new release:

| | |
|---|---|
| You didn't touch it | the new version is written |
| Only you changed it | yours stays |
| You both changed it, in different places | both sets of changes are combined |
| You both changed the same lines | yours stays, and the new one is written next to it as `config.lua.new` for you to compare |
| New in the release | added |
| Dropped from the release and you didn't touch it | removed |
| Your own files the release doesn't have | left alone |

JSON files that don't combine line by line are combined key by key. Line endings don't count as a change, so a Windows checkout with CRLF files is fine.

If the release you have installed can't be found on GitHub, there's no telling your changes apart from the update's. Then files matching `keep` in the config (config files and locales by default) stay as they are with the new one written as `.new`, and everything else is replaced. The preview tells you when this is the case.

## Install

1. Drop `fiveupdate` into your resources and add to `server.cfg`:

   ```
   ensure fiveupdate
   ```

2. Optional, in `server.cfg`:

   ```
   set fiveupdate_github_token "..."   # more than GitHub's 60 checks an hour, any token with no scopes works
   set fiveupdate_webhook "..."        # Discord webhook for new versions, when you don't run fivecord
   ```

## Use

Everything runs from the server console, or rcon. In-game players can't use it.

```
fiveupdate list                    what's tracked, and what has an update
fiveupdate check                   check GitHub now
fiveupdate update ox_lib           show what the update would change, writes nothing
fiveupdate update ox_lib confirm   write it
fiveupdate update all              the same for everything with an update
fiveupdate undo ox_lib             put the last update back
fiveupdate history                 past updates
```

The preview shows the release notes and every file with what will happen to it. Nothing is written until you confirm, and the files it replaces are backed up to `backups/` first.

`undo` puts every file back as it was before the update, byte for byte, without downloading anything. A file you changed after the update is left alone and named, so undo never throws away newer work. If the server crashed in the middle of an update, it says so on the next start, and `undo` cleans it up.

It checks every 6 hours and on start. New versions are posted to Discord once each, through [fivecord](https://github.com/1amZach/fivecord) if it's running, or the webhook.

After an update, restart the resource to load it, or turn on `restart` in the config.

## Config

`config.json`:

| | |
|---|---|
| `checkHours` | How often to check. 0 checks only on start |
| `keep` | Files that are yours when the installed release can't be found. `*` is one folder level, `**` any. A name without a `/` matches in any folder |
| `ignore` | Resources never to check |
| `resources` | Resources without a `repository` line, as `"name": "owner/repo"` |
| `restart` | Restart a resource after updating it |
| `backups` | Updates to keep backups of, per resource |
| `discordKind` | fivecord log channel for new versions |

## For other resources

```js
exports.fiveupdate.list()              // [{ name, repo, version, latest, error }]
await exports.fiveupdate.check()       // the ones with an update
await exports.fiveupdate.preview(name) // { from, to, exact, notes, files: [{ path, action, note }] }
await exports.fiveupdate.update(name)  // writes it
exports.fiveupdate.history()
exports.fiveupdate.undo(name)
```

## Support

Made by **IamZach**. Questions, bugs or ideas: [discord.gg/agn](https://discord.gg/agn)

## License

MIT
