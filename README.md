# Desk log

Tracks how much of your working day you spend sitting, standing, and away from
your desk. One button, one machine, no accounts.

## Running it

    cd sit-stand
    npm start

Then open <http://localhost:4321>. There is nothing to install: the server uses
Node's built-in SQLite, so the project has no dependencies. It needs Node 22.5
or newer.

Data is written to `data/sit-stand.db` next to the server. Copy the whole
`data/` directory to back it up: while the app is running, recent sessions live
in the `-wal` sidecar file and copying only the `.db` would give you an
incomplete database. Once the server has shut down cleanly the `.db` file is
complete on its own. The CSV export is the safest thing to archive either way.

## Using it

Press **Start sitting** or **Start standing** when you get to your desk, and
press the big button whenever you change posture. **Away from desk** times a
break the same way, for lunch or a meeting; when you come back, say whether
you are sitting or standing. **Stop tracking** is different: it ends the day
and records nothing until you start again.

If you forget any of it, nothing outside your working hours is counted anyway.

The three buttons are weighted by how often you need them: the posture switch
is solid, away is outlined, and stopping is quiet text.

You do not have to keep the page open. The menu bar app below shows the same
thing and switches posture in one click, and locking your Mac marks you away by
itself.

The desk surface behind the timer rises when you stand and lowers when you sit.
While you are away it rests at neutral height and goes dashed - the desk is
still there, you are not. A glance from across the room tells you what the app
thinks you are doing.

**Nudges** are browser notifications, asked for the first time you press the
button. If you decline, the timer still turns amber and tells you when you have
been in one position too long. You are never nudged while away, and the clock
restarts when you come back.

## Fixing the record

Every number here rests on you remembering to press a button, so the day is
shown block by block underneath the totals, and every block can be corrected.

Click a block and you can change what posture it really was, move either edge,
split it where a switch actually happened, or delete it. Splitting is the one
that matters most: if you stood up at eleven and only pressed the button at
noon, set the time to 11:00, press **to Standing**, and the hour moves across.

Boundaries are edited with time fields rather than by dragging. Dragging cannot
be driven from a keyboard and a single minute is hard to hit with a mouse.

Blocks longer than a threshold you choose are hatched and called out above the
timeline, because an unbroken four-hour stretch is usually a switch nobody
pressed rather than something that happened. The threshold is in Settings and
starts at three hours.

## Away when your Mac locks

`tools/auto-away` watches the lock screen. When your Mac locks it remembers
whether you were sitting or standing, marks you away, and puts you back in the
same posture when you unlock. It does nothing if you were not tracking, and
nothing while the tracker is unreachable.

To run it at login, point the bundled job at your copy and load it:

    sed "s|REPLACE_WITH_PROJECT_PATH|$PWD|" tools/com.desk-log.auto-away.plist \
      > ~/Library/LaunchAgents/com.desk-log.auto-away.plist
    launchctl load ~/Library/LaunchAgents/com.desk-log.auto-away.plist

It logs to `/tmp/desk-log-auto-away.log`. Stop it with `launchctl unload` on the
same path. `DESK_LOG_URL` overrides the address if you moved the port.

## The menu bar app

    ./menubar/build.sh
    open menubar/DeskLog.app

The current posture and how long you have held it sit in the menu bar; the menu
switches posture, stops tracking, and opens this page. There is no dock icon.
Add it to **System Settings → General → Login Items** to have it start with your
Mac. Building it needs the Xcode command line tools (`xcode-select --install`).

It also works as a one-shot command, which is what you want behind a keyboard
shortcut in Raycast, Alfred or Shortcuts:

    menubar/DeskLog.app/Contents/MacOS/DeskLog --posture stand
    menubar/DeskLog.app/Contents/MacOS/DeskLog --posture stop

The app stores nothing of its own. It talks to the same API as the page, so both
can be open at once and they agree.

## Using it on your phone

The page is a progressive web app, so it installs to a home screen and runs
without browser chrome. What it needs is HTTPS: a service worker will not
install over plain `http://`, which rules out reaching your Mac by its LAN
address.

[Tailscale](https://tailscale.com) is the least troublesome way to get that,
and is free for personal use. Install it on your Mac and your phone and sign
both into the same account. **Serve has to be switched on for the tailnet
before it will work** — the first `tailscale serve` prints a one-click link to
do it. Then, on the Mac:

    tailscale serve --bg 4321

That publishes the tracker at `https://<your-mac>.<your-tailnet>.ts.net` with a
real Let's Encrypt certificate, reachable from your phone anywhere, with
nothing exposed to the public internet. The app itself keeps listening only on
loopback; Tailscale is what fronts it.

The setting survives reboots. To undo it: `tailscale serve --https=443 off`.

On Android, open that address in Chrome and use **Install app** from the menu.
On iOS, use **Add to Home Screen** in Safari.

Your Mac is the server, so the tracker is available whenever the Mac is awake.
That is the same window in which it has anything to record, and the working day
closes itself off if the Mac sleeps through the end of it.

### Both devices stay in step

A switch made anywhere shows up everywhere within a few milliseconds, without
a reload. The page holds a server-sent events stream open to `/api/events`;
the server pushes the new state down it whenever anything changes — a toggle,
a stop, a correction on the timeline, a settings change. Writes still go
through the ordinary POST routes, so there is one path for changing anything
and the stream only ever carries news outwards.

The app is fetched from the network first, with the cache kept as the offline
fallback, so a published change is picked up on the next load rather than
lingering behind a cached copy.

The browser reconnects the stream on its own if it drops. A slow poll every
minute stays as a safety net in case a stream dies quietly.

One deliberate exception: if you have a block selected in the timeline editor,
an incoming change does not redraw it, because that would throw away whatever
you were half way through typing.

### When the phone has no signal

A switch made with no connection is kept on the phone, with the time you made
it, and sent when the connection comes back. If it turns out to disagree with
something already recorded — you marked yourself away at 10:00, but the Mac has
a sitting block covering 10:00 — the recorded version stands and the app asks
you which is right rather than choosing for you. The Mac is the primary device;
nothing arriving late overwrites it quietly.

## Settings

Working hours, working days, a daily standing goal, and the two nudge
thresholds, the length at which a block is flagged as too long to be
believable, and whether tracking stops by itself at the end of the working day. Away time counts alongside sitting and standing in the daily
percentages, so the three always add up to your tracked day, but it never
counts towards the standing goal. Working hours are applied when statistics are calculated, not when
sessions are recorded, so changing them re-derives every past day correctly and
a session left running overnight only ever counts its in-hours portion.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4321` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface(s) to bind, comma-separated. The default keeps it on this machine |
| `SIT_STAND_DB` | `./data/sit-stand.db` | Where the database lives |

## Getting your data out

`http://localhost:4321/api/export.csv`, or the link at the bottom of the page,
gives you every raw session as CSV.

## Starting it automatically

To have it start when you log in, fill your paths into the bundled job and
load it:

    sed -e "s|NODE_PATH_HERE|$(which node)|" \
        -e "s|PROJECT_PATH_HERE|$PWD|g" \
        tools/com.desk-log.server.plist \
        > ~/Library/LaunchAgents/com.desk-log.server.plist
    launchctl load ~/Library/LaunchAgents/com.desk-log.server.plist

It logs to `/tmp/desk-log-server.log`. Stop it with `launchctl unload` on the
same path.

The older hand-written version, for reference:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.desk-log</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/websites/sit-stand/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/websites/sit-stand</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

## Tests

    npm test

A hundred and seventy-one tests across ten suites: the clipping and aggregation maths
(including days that cross midnight, weekends, and daylight-saving changes),
settings validation, the database invariants and schema migration, editing
sessions, the working day starting and stopping by itself, reconciling a
phone's queued switches, the live event stream, and the HTTP API. The menu bar app and the auto-away agent are
verified by running them rather than by unit tests.

## How it is put together

| File | Job |
|---|---|
| `server.js` | Opens the database, listens, shuts down cleanly |
| `lib/api.js` | Routes, request validation, the JSON envelope, static files |
| `lib/db.js` | Schema, migrations, queries and edits. Enforces one open session at a time |
| `lib/day.js` | One day as blocks, with the ones that look too long flagged |
| `lib/worktime.js` | Closing off a working day that has finished |
| `lib/sync.js` | Deciding whether a queued switch fits or disagrees |
| `lib/events.js` | Pushing changes to every open page |
| `lib/postures.js` | The list of postures, shared by storage, stats and the API |
| `lib/stats.js` | Clipping sessions to working hours and totalling them. Pure |
| `lib/settings.js` | Defaults and cross-field validation. Pure |
| `public/index.html` | Markup |
| `public/app.css` | Styles |
| `public/app.js` | The page: toggling, totals, chart, settings, nudges |
| `public/timeline.js` | The block-by-block day and its editor |
| `public/sw.js` | Offline shell and cached reads |
| `public/manifest.webmanifest` | What makes it installable |
| `tools/auto-away` | Marks you away while the Mac is locked |
| `menubar/DeskLog.swift` | The menu bar companion |

There is still no build step for the web side: the browser loads the CSS and the
two modules directly.

The design notes are in
`../docs/superpowers/specs/2026-09-01-sit-stand-tracker-design.md`.

## Upgrading

A posture list has to be written into the table definition, so adding **away**
meant rebuilding the sessions table. That happens automatically and once, the
next time you start the app: the file's `user_version` is checked, the table is
rebuilt inside a transaction with every existing session copied across, and the
version is stamped. Your history is preserved, including whichever session was
still open.

A database written by a *newer* build than the one you are running is refused
rather than opened, so downgrading cannot quietly damage your data.

## What happens when the Mac sleeps

The menu bar app watches for sleeping, waking, locking and unlocking, and acts
only inside your working hours.

Going to sleep or locking marks you away from the moment it happened, not from
whenever the tracker is next spoken to. Coming back picks your posture up again
if the same working day is still running.

If the day ended while the Mac was away — you closed the lid at 17:00 and opened
it at 10:00 the next morning — the absence is taken back out, so the previous
day finishes at 17:00 where it stopped, and nothing starts for the new day until
you press a button.

`tools/auto-away` does the lock and unlock part for people not running the menu
bar app. It stands down automatically if the app is running, so the two never
fight over the same posture.
