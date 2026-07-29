# Environments

An **environment** is a named set of connections plus the whole working session
that belongs to them: which tabs are open, how the panes are split, which
connection has focus, and what reconnects when you come back to it.

The switcher lives in the topbar, left of the breadcrumb. Pick another
environment and HuginnDB puts the current session away, closes the live
connections, and brings up the other one's — the tabs you had, arranged the way
you left them, filtered and sorted the way you left them.

The case it exists for: you work with several clients or sites, each with its own
handful of servers. Before this, keeping them apart meant a window per client
and rebuilding the layout by hand every morning. Now it's one switcher.

## What an environment does and doesn't own

**It does not own your connections.** There is one global list of connections,
exactly as before. An environment decides which of them are *in play* — it
doesn't take them over.

That distinction is what makes deleting one safe. Deleting an environment
discards its remembered tabs and its pane layout. It never deletes a connection,
and it never touches a stored password: those live in `profiles.json` and your
operating system's keychain, both outside the environment entirely. The
confirmation dialog says so, because "delete environment" can easily read the
other way round.

The reverse direction *does* propagate: deleting a **connection** removes it from
every environment that remembered it. Otherwise it would come back as a tab
pointing at a connection that no longer exists the moment you switched.

## What each environment remembers

- Open table and query tabs, including their colour and pinned state.
- For table tabs: the column filters, the multi-level sort, and the search you
  committed. Only what was actually applied — a half-typed search box isn't
  saved.
- The split/float arrangement of the workspace panes.
- Which connections were live, which one had focus, and which tab was showing.
- Which nodes you had expanded in the schema tree.

Structure-editor and view-editor tabs are deliberately **not** remembered. They
are in-progress editing sessions, not places you return to.

Each environment remembers the 20 most recently used connections independently.
The cap is per environment on purpose: a global one would let a busy environment
quietly evict the tabs of one you hadn't opened in a while.

## Switching is not instantaneous

A switch closes every open pool and opens the incoming environment's. It takes
about as long as connecting to those servers normally does, and the switcher
shows a spinner and refuses further clicks while it works. This is real work, not
a UI transition — if a server is slow to answer, the switch is slow.

A connection that fails to come back (unreachable host, password no longer in the
keychain) is skipped without blocking the rest, the same as at startup.

Reconnecting on entry follows the **Reconnect on launch** preference. With it
turned off, switching still changes which environment is active and still records
what you had open, but it won't reopen connections or restore the layout — layout
restore rides along with reconnect by design.

## The upgrade from an earlier version

Nothing is lost. Whatever session you had becomes a single environment holding it
verbatim, so the first launch after updating looks exactly like the last one
before it. From there you can rename it and add more.

That first environment starts **unnamed** and displays as "Default" in whichever
language the interface is set to. That's deliberate: if HuginnDB wrote a name
into your data it would be stuck in one language forever. Give it a name and the
name is yours.

One thing worth knowing before you update: the session file (`tab_state.json`)
moves to a new format, and **an older build of HuginnDB will not understand
it**. Going back to a previous version means it starts with an empty session —
your connections and passwords are untouched, but the remembered tabs and layout
are not readable by it. If you want to try a pre-release without that risk, the
canary build keeps its session state in a directory of its own, side by side with
your stable install (see `docs/CANARY.md` in the repository).

## Secondary windows

Environments belong to the main window. **Window → New window** opens a
deliberately ephemeral instance: it never writes session state, so closing it
loses its tabs by design, and the environment switcher doesn't appear there.
Switching in the main window doesn't disturb an open secondary one.

## Practical notes

- Renaming to an empty name clears your name and brings the localised default
  back. Creating an environment does require a name — an unnamed new one would
  be indistinguishable from the default.
- Assigning a colour puts a dot next to the environment in the switcher. It's
  cosmetic; nothing behaves differently.
- The last environment can't be deleted. There is always exactly one active.
