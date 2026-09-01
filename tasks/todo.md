# Sit/Stand Tracker — Implementation

Design: `../docs/superpowers/specs/2026-09-01-sit-stand-tracker-design.md`

- [x] Tests for `lib/stats.js` (clipping, day splitting, DST, goal maths)
- [x] Implement `lib/stats.js`
- [x] Tests for `lib/settings.js` (defaults, validation)
- [x] Implement `lib/settings.js`
- [x] `lib/db.js` — schema, one-open-session guarantee, queries
- [x] `lib/api.js` + `server.js` — routing, API, static serving
- [x] Integration tests against the HTTP API
- [x] `public/index.html` — toggle, gauge, chart, settings, nudges
- [x] Run it and verify in a browser
- [x] README

## Review

75 tests, all passing. Verified in headless Chrome against a seeded database and
against an empty one: light and dark, desktop and a 390px viewport.

**What changed from the design.** The design put routing in `server.js`. It ended
up in `lib/api.js` instead, with `server.js` reduced to wiring, because that made
the whole HTTP surface testable against an in-memory database and a clock the
tests move by hand. The goal display is a segmented gauge rather than a smooth
ring, which reads as instrumentation rather than as a dashboard widget.

**Three bugs found by looking at it rather than by testing it.**

1. The per-second tick rebuilt the control buttons on every render, which would
   have dropped keyboard focus once a second and swallowed clicks. Rendering is
   now incremental: the buttons are rebuilt only when the posture changes, the
   gauge only when a segment lights, and the split bar keeps its two elements so
   its width can animate.
2. The screen-reader live region was toggled with `hidden`, which both made the
   text visible on screen and stopped it being announced. It is now visually
   hidden and permanently in the accessibility tree.
3. The desk legs were drawn across the nudge message. The message now rides with
   the readout above the desk surface.

**Known deviation.** `public/index.html` is about 1000 lines, over the 800-line
guideline in the global coding standards. Splitting the CSS and JS into separate
files would fix the number but give up the "one self-contained file" property
that was explicitly chosen. Left as one file; the guideline loses to the
requirement here.

**Not built, by decision.** Accounts, cloud sync, hardware integration, and
overnight (night-shift) work windows. `workEnd` must be later than `workStart`.

---

# Away from desk (follow-up)

- [x] Shared `lib/postures.js` so one list defines the postures
- [x] `away` in clipping and aggregation, with tests
- [x] Schema migration for the widened posture constraint, with tests
- [x] API tests for away (no API code changes were needed)
- [x] Third colour, dashed desk, three-weight controls
- [x] Three-segment split bar and 14-day chart
- [x] Verified the round trip in a browser, light and dark, desktop and mobile

## Review

94 tests. The API needed no changes at all — the routes were already
posture-agnostic — which the new tests now pin down rather than leave to luck.

**The interesting part was the migration.** SQLite bakes a `CHECK` constraint
into the table definition, so `CREATE TABLE IF NOT EXISTS` would have silently
left an old database unable to store `away`. The fix is a `user_version`-keyed
migration that rebuilds the table inside a transaction. A database from a newer
build is refused rather than opened.

**Something the work turned up.** Copying `data/sit-stand.db` on its own gave an
empty database, because in WAL mode recent writes live in the `-wal` sidecar
until a clean shutdown folds them in. The code was already correct — there is
now a test proving a closed database file is complete on its own — but the
README's advice to "back that file up" was wrong while the app is running. Now
corrected.

**Deliberately not done.** No nudge to come back from a long absence: that is
the periodic "are you still there?" prompting that was turned down when the app
was first specified.

---

# Timeline, auto-away, suspect blocks, menu bar

- [x] Session editing in `lib/db.js`: update, split, delete, insert
- [x] `lib/day.js` — a day as blocks, with implausible ones flagged
- [x] `implausibleAfterMinutes` setting with validation
- [x] Pattern-matching router for `/api/sessions/:id`
- [x] Split `public/index.html` into html/css/js so no file breaks 800 lines
- [x] `public/timeline.js` — the track and its editor
- [x] `tools/auto-away` + launchd job, tested through a stubbed lock probe
- [x] `menubar/DeskLog.swift` + `.app` bundle, with a one-shot `--posture` mode

## Review

132 tests. Four features, and the two that mattered most were the ones that make
the data trustworthy rather than the ones that add numbers to look at.

**Design decisions worth recording.**

Boundaries are edited with time fields, not by dragging. Dragging cannot be
driven from a keyboard and a minute is hard to hit with a mouse; this was a
deliberate departure from how the feature was pitched.

Sessions may have gaps but must never overlap. Deleting a block leaves a gap
rather than silently stretching its neighbour, because guessing which neighbour
should absorb the time would invent data.

The menu bar app grew a `--posture` one-shot mode. It began as a way to test the
POST path without clicking a menu, and it is genuinely useful: it is what you
bind a keyboard shortcut to.

`auto-away` takes an optional `DESK_LOG_LOCK_PROBE` command. Without it the lock
transitions could not be tested at all, since the screen cannot be locked from a
script.

**The file split.** `public/index.html` had reached 1076 lines and this work
would have pushed it past 1400, so it became html + css + two JS modules. The
"single self-contained file" property is gone, but nothing was actually lost:
the browser loads the modules directly, there is still no build step and nothing
to install.

**What is verified and what is not.** Everything server-side is under test. The
timeline was driven through a real browser: split, posture change, refused
overlap, delete. The auto-away agent was run through a full lock and unlock
cycle with a stubbed probe. The menu bar app was launched against a mock and
observed polling, and its POST path is covered by the `--posture` mode. What was
not verified is the menu bar rendering and clicking its items, which needs a
human looking at a screen.

---

# Mobile, publishing, sleep, and disagreements

- [x] Work window governs tracking: `lib/worktime.js` closes a finished day
- [x] `autoStopAtWorkEnd` setting, on by default
- [x] `at` on toggle and stop, so a switch can be dated when it happened
- [x] Sleep, wake, lock and unlock in the menu bar app; shell agent stands down
- [x] PWA: manifest, service worker, generated icons, installable
- [x] Offline queue on the phone, replayed through `POST /api/sync`
- [x] Conflicts stored (schema v2) and settled by the person, desktop primary
- [x] Tailscale documented as the way to reach it from a phone over HTTPS

## Review

162 tests. The important correction this round was mine to own: working hours
were only ever filtering the statistics, never governing the app. See
`~/.claude/lessons/sit-stand.md`.

**The rule for sleeping across a day change**, which the user specified and
which is now a test: on waking, resume only if the same day's work window is
still running. Otherwise remove the sleep-induced away block entirely, so the
previous day ends at the moment the Mac slept, and start nothing.

**Conflicts turned out narrower than expected**, and saying so was worth more
than building for the general case. With one server there is no conflict when
both devices are online: writes just serialise. The only real disagreement is a
switch a phone queued while offline that contradicts a block the desktop has
already closed. That is the only case `lib/sync.js` treats as a conflict; a
late report against a block that is still running is applied, because that is
exactly what the timestamp is for.

**Two rules that stop the automatic behaviour being annoying.** A session
started deliberately after hours is left alone that evening rather than being
killed the instant it starts, which would make the button look broken; it is
closed when the calendar day turns. And a block begun on a day off is closed at
midnight rather than at its own start, so the timeline shows what happened
instead of a zero-length row.

**Not done.** Web push to the phone. The manifest and service worker are in
place, which is what iOS requires before push can be requested at all, but the
subscription handling and a push endpoint are still to write. Nudges currently
fire only on a device with the page open.
