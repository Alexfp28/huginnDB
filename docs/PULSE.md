# Pulse

HuginnDB can already tell you what's *in* a database. Pulse answers a
different question: how is the *server* doing right now, and how has it been
doing over the last few days? Live vital signs, the statements it has spent
the most time on, its biggest tables, who's connected, and which indexes
nobody reads — all in one place, without leaving the app.

Pulse works with **MySQL and MongoDB** today. Opening it against Postgres,
SQLite or SQL Server shows an explicit "not supported yet" state rather than
a wall of zeroes — the other drivers simply don't expose the statistics Pulse
needs.

## Opening Pulse

Click the pulse icon in the right activity bar to dock the panel next to your
workspace — it follows whichever connection is selected, or click the pin to
lock it to one connection regardless of what you click on elsewhere.

The dock panel is deliberately compact: four sections (Status, Alerts, Time
spent, Storage), each showing the top few rows and a **↗** button in the
header. Click it to open Pulse in a window of its own — wider, with the full
tables and two more views (Sessions, Indexes) that don't fit in a side panel.
That window measures one connection and closes independently of the main
one; nothing about it is saved as a tab.

## What each view shows

### Status

Queries per second, connection pressure, threads running and buffer-pool (or
WiredTiger cache) hit rate, each with a small live chart, plus the alerts
derived from them — approaching the connection ceiling, a low cache hit
rate, temp tables spilling to disk, refused connections. The live numbers
refresh every five seconds **only while the panel or window is on screen** —
switch away, collapse the dock, or minimise the app, and the polling stops
with it.

### Time spent

The statements the server has spent the most time on ("Consultas"): MySQL
reads this from `performance_schema`'s digest table; MongoDB from the
database profiler's `system.profile` collection — turn the profiler on for
this to show anything (the Status view's alerts say so when it's off). Each
row shows how many times a statement ran, its average and slowest duration,
rows examined vs. sent, and a red badge when it resolved without using any
index.

A row with a **Plan** button has a real, runnable example of that statement
kept alongside it — click it to see the plan the server would use, without
running the statement for real.

### Storage

The connection's biggest tables/collections, ranked, split into data,
indexes and free space — space a rebuild would hand back.

### Sessions

*Expanded window only.* Every session or operation currently open on the
server: MySQL's `SHOW FULL PROCESSLIST`, MongoDB's active or lock-waiting
operations. On MySQL, a session waiting on a lock shows which other session
it's blocked on. This is a live snapshot with its own refresh button, not
something that auto-updates — a five-second poll on a full session list
would cost more than it's worth.

### Indexes

*Expanded window only.* Every index across your biggest tables, ranked by
how often it's actually been read since the counters were last reset. An
index reading **unused** has seen zero reads — worth a look, never a
suggestion Pulse makes for you to drop it outright: "unused since the server
last restarted" is not the same claim as "safe to remove," and Pulse only
ever tells you the first one.

### History

*Expanded window only.* The same live numbers, but over the last 24 hours, 7
days or 30 days, so you can answer "was this slow yesterday too?" instead of
only "is it slow right now?" This view needs history to have actually been
recorded — see [Keeping history](#keeping-history).

## Keeping history

Everything above the History view is live-only — close the window and it's
gone. To keep a record, turn on Pulse's history sampler for a connection in
**Settings → Pulse**: a tree of your connections, each with a toggle, next to
the sampler's own knobs (how often it samples, how long it keeps history, a
disk-size cap, and whether it keeps sampling while HuginnDB is minimised).

It's **off by default, per connection** — turning it on for one connection
never starts tracking another. Once on, HuginnDB reads that connection's
vital signs in the background (once a minute by default) and appends them to
a small local database, entirely separate from anything the connection
itself stores. History older than 48 hours is gradually thinned out to keep
the file small, and anything past the retention window is deleted outright.

## Asking an AI assistant

Everything Pulse shows is also available to an AI client connected through
HuginnDB's [MCP connector](MCP.md) — `pulse_health`, `pulse_metrics`,
`pulse_top_queries`, `pulse_explain`, `pulse_storage`, `pulse_sessions` and
`pulse_index_usage`. All seven are read-only: an assistant can ask "why is
this server slow" or "what happened to it last week" and get real numbers
back, but it can never change anything through them. See the connector's own
guide for how to connect a client in the first place.
