# The AI panel

HuginnDB can talk to a language model about your database. The whole design
exists to answer one objection first, because it is the correct one:

> *My client's data is not going to a third party.*

So the answer is not a checkbox and a promise. **The model you talk to is the
one you point HuginnDB at** — a process on your own machine, a GPU box on your
own network, or a cloud provider with your own key, and nothing in between.
There is no HuginnDB service in the middle, and there is no configuration in
which your data passes through us.

The panel is **off** until you switch it on, and every connection is
**unreachable** by it until you tick that connection specifically.

---

## Two questions, kept separate

Most tools conflate these. Conflating them is the mistake.

**1. Where does inference run?** On loopback, on your LAN, on a gateway you
operate — or on somebody else's servers. You tell HuginnDB which; it never
guesses. A hostname like `ai-internal` resolves wherever DNS says it does, and
DNS is not a security boundary, so "is this endpoint mine?" is a question only
you can answer. Settings → AI pre-fills a guess from loopback and private-range
detection and stores *your* answer.

**2. What reaches the model's context?** Metadata — table and column names,
types, indexes, view definitions, `EXPLAIN` output — or metadata **plus rows**.

These are independent, and "read-only" is not the same promise as "nothing
leaves". A read-only assistant that runs `SELECT * FROM patients LIMIT 50` has
sent fifty patient records to whatever endpoint is configured. That is why
there are two switches and not one.

### The rule, enforced in Rust

| Endpoint trust | Connection allows rows | What the model can see |
| --- | --- | --- |
| My infrastructure | — | Metadata **and** rows |
| Third party | No | Metadata only |
| Third party | Yes | Metadata **and** rows |

Under metadata-only the row-reading tools are **not offered to the model at
all** — they are absent from the list it is given, not present-and-refused. A
model that can see a tool it may not use will spend its turns trying.

Note the asymmetry: a **trusted** endpoint reads rows whatever the
per-connection flag says. To keep one connection away from the assistant
entirely, turn off its *reach* rather than its rows.

Whatever the setting, **anything you paste into the chat yourself is sent.**
The rule governs what the assistant reads on its own initiative; a grid
selection you paste in is you choosing to send it.

---

## What hardware you need

Roughly, at 4-bit quantisation:

| Machine | Viable model | Reliable multi-step tool calling |
| --- | --- | --- |
| No GPU, 8–16 GB RAM | 3B–4B; 7–8B at 2–6 tok/s | No |
| GPU 8 GB | 7–8B | Marginal |
| GPU 12–16 GB | 14B | Yes |
| GPU 24 GB+ / vLLM host | 32B | Yes, comfortably |

Small models are precisely the ones that fail at chained tool calls, so "just
use a smaller model" is not a degradation path. That is why there are two
modes, and why the smaller one is not a consolation prize — see below.

### The deployment that actually works in an office

**One GPU box serving everyone.** Ollama, llama.cpp's `llama-server` and vLLM
all expose an OpenAI-compatible endpoint over the network, so the machine that
runs the model does not have to be the machine you work on:

```
Settings → AI → Endpoint:  http://ai-internal:11434/v1
Settings → AI → Trust:     My infrastructure
```

This is the primary documented pattern, not a footnote. Plain `http` is allowed
for exactly this reason — an https-only rule would break the deployment the
feature is designed around. Every scheme except `http` and `https` is refused,
and redirects are refused too: an inference endpoint has no business
redirecting a completion, and following one would make the endpoint allowlist
meaningless.

### Picking a model

For a 12 GB card, from Ollama's current library:

| Model | Size | Why |
| --- | --- | --- |
| `gemma4:12b` | 7.6 GB | The most capable that fits with room for context, and by far the most downloaded — which in practice means its tool-calling template is the best tested. |
| `lfm2.5:8b` | 5.2 GB | 8B with 1B active, built specifically for fast, reliable tool calling on consumer hardware. Cheap enough to keep alongside the first as a comparison. |
| `granite4.2:8b` | 5.3 GB | Apache 2.0, tool use and structured JSON output. |

`qwen3.6`'s smallest tag is 27b (~17 GB) and does not fit; nor do
`muse-glimmer:30b` or `gemma4:26b`.

### Raise Ollama's context window

**This is the single most common cause of the assistant behaving strangely.**
Ollama's default context is small and it truncates **from the front** — which
is where the system prompt and your question live. A model handed a large tool
result and a truncated prompt will answer a question it can no longer see, often
in the wrong language:

```bash
OLLAMA_CONTEXT_LENGTH=16384 ollama serve
```

HuginnDB bounds what it sends (see *Budgets* below) so a small context degrades
rather than breaks, but it cannot make one bigger.

---

## Assisted mode

**One model call. HuginnDB assembles the context itself.** No tool loop, so it
works on a model far too small to be trusted with one — and for these four jobs
it is *better* than agent mode, because the context was chosen deliberately
rather than discovered.

| Job | Where | What HuginnDB sends |
| --- | --- | --- |
| **Explain this statement** | Right-click in the query editor | The statement (or your selection) and the server's product and version. |
| **Why is this statement slow?** | Right-click in the editor, or the button on Pulse's slow-statement rows | The statement plus the plan the server itself would use. |
| **Write SQL** | The wand in the panel's composer | Your request plus the structure of the tables it appears to be about. |
| **Document with AI** | Right-click a table in the schema tree | Columns, indexes, and — only when the endpoint may read rows — a handful of sample values. |

Documentation is the only one that reads rows. Under a metadata-only endpoint it
does not become unavailable: it drops the sample and tells the model to say
nothing about values it was not shown.

The wand's table matching is deliberately dumb and deterministic: a table is
relevant when its name appears in your request. It runs *before* the one
completion the task is allowed, so anything cleverer would be a second
inference picking the context for the first. When nothing matches, the whole
table list goes instead and the model asks — a better failure than a
confidently wrong subset.

---

## Agent mode

**A real tool-call loop**: the model asks for what it needs, HuginnDB reads it,
and it keeps going until it can answer.

It is gated on a **measurement, not a preference**. Settings → AI's *Test
endpoint* asks the endpoint for its models (a courtesy — `llama-server` and
several gateways do not implement it, which is not an error) and then makes one
small tool call. Three outcomes:

- **Tool-capable** — agent mode is available.
- **Chat only** — the model completes but does not emit usable tool calls.
  Assisted mode is available; agent mode is not, and the panel says so.
- **Unreachable** — with the server's own reason, verbatim.

A small model asked to chain tool calls does not degrade gracefully. It
fabricates, and the assistant looks like it is working right up to the point
where nothing it claims to have read was ever read. Gating on the probe is what
keeps that from being your problem to discover.

### The tools it gets

Read-only, all of them. **No write is in the list at all**, and a `run_query`
carrying anything but a read is refused with an instruction to propose the
statement instead.

`list_databases`, `list_tables`, `describe_table`, `list_indexes`,
`server_version`, `get_view_definition`, `pulse_explain`, `pulse_top_queries`,
and — only when the scope allows rows — `run_query` and `browse_table`.

Users and privileges are deliberately withheld: who may log in and what they may
do is the most attack-shaped thing HuginnDB can read, and no task needs it.

### Watch it work

Every step goes to the **Console**, under its own **AI** filter: the tools it was
offered and whether they included row access, each call with its arguments, and
each result's **row count and size**. The payload never does — that is the data
this whole page is about, and writing it into a panel you can copy out of would
be an odd way to keep the promise.

This is the part that makes the guarantee checkable rather than merely stated.
Read it once against a connection you care about.

### Budgets

A turn stops at whichever comes first: six model calls, twelve reads, three
replies' worth of accumulated result text, or the row cap in Settings. Hitting
one ends the turn and says which in the answer — "the model gave up" and "the
model was cut off" are different facts and only one is worth retrying.

---

## It never writes

The assistant proposes; you run. A statement it suggests arrives in a small
read-only editor with an **open in editor** action per statement, which hands it
to a query tab — where the destructive-statement confirmation, the
unfiltered-write refusal, the Console entry and the history all already are.

This is not a limitation waiting to be lifted. A write-capable assistant is a
separate decision with a separate threat model, not a setting.

---

## If you already pay for Claude or ChatGPT

**Those subscriptions cannot be spent through HuginnDB, and that is not our
choice.** Anthropic's terms state that OAuth is "intended exclusively for …
ordinary use of Claude Code and other native Anthropic applications" and that
developers building products "should use API key authentication". OpenAI's
ChatGPT sign-in is scoped to their own clients the same way. Any tool that
claims otherwise is doing something its provider has told it not to.

The sanctioned path is the other direction: **Settings → MCP**. The
`huginndb-mcp` connector lets Claude Code, Claude Desktop or Cursor read your
databases *through* HuginnDB, using the licence you already have. See
[MCP.md](MCP.md).

| You want | Use | Does data leave? |
| --- | --- | --- |
| To spend your existing Claude/Codex licence | `huginndb-mcp` in that client | Yes, to that vendor |
| A chat inside HuginnDB with nothing leaving your infrastructure | This panel, local or self-hosted endpoint | No |
| A chat inside HuginnDB with a frontier model | This panel, your own API key | Yes |

---

## Settings reference

**Settings → AI**

| Setting | What it does |
| --- | --- |
| Enable the AI panel | Off on every existing install. While off, HuginnDB makes no request to any endpoint. |
| Endpoint | An OpenAI-compatible base URL. Usually needs to end in `/v1`. |
| Model | The model id. Becomes a list once the endpoint check has run. |
| Endpoint trust | Your declaration. See *Two questions* above. |
| Mode | Assisted or agent. Agent additionally requires a tool-capable probe result. |
| Effort | `reasoning_effort` for a thinking model. **Automatic** sends nothing, which is the only setting no endpoint can reject — OpenAI refuses the field outright on a model that does not reason. For a local thinking model in assisted mode, turn effort off. |
| Row budget | How many rows one tool reply may put in the model's context. Capped at 1000; a character budget applies on top. |
| Idle timeout | Seconds without a byte before a request is abandoned. Not a total budget — a slow model is not a broken one. |
| API key | Only needed for a cloud provider. Stored in your OS keychain, keyed to that endpoint's host, so changing the endpoint cannot send it elsewhere. HuginnDB never shows it again and no command returns it. |
| Connections | Two switches each: **reach** (may the assistant see this connection at all) and **rows**. Both off by default, both strictly local — preserved across a shared-origin sync and cleared on import, because what a model on *your* machine may read is not a decision a publisher two machines away gets to make. |

**The conversation is never written to disk.** It holds schema names, proposed
SQL and row snippets, which is exactly the artefact this feature promises not to
accumulate. Closing the app forgets it. That is the promise, not a missing
feature.

---

## Known rough edges

- **Small models under-use their tools, and the panel now works around it.**
  Some models end a turn by writing a `SELECT` and waiting for you to run it,
  even holding a `run_query` tool. Four causes were ours and are fixed: the
  assistant is told which engine and database it is connected to (so it stops
  guessing `LIMIT` at SQL Server or SQL at MongoDB), `DESCRIBE` is recognised
  as the read it is instead of refused as a write, a batch or a `USE` is
  answered with what to fix rather than "hand it to the user", and a MongoDB
  connection opened at a database works at all.

  For what is left — the model's own judgement — the loop no longer relies on
  persuasion. When an answer hands you a read, in a turn that read no rows, on
  a connection where rows are allowed, the panel asks the model for that one
  call and answers from the rows. It happens at most once per turn, never for a
  statement that writes, and the extra step is in the Console like every
  other.
- **Prose renders as a small markdown subset** — bold, italic, inline code,
  lists, headings, quotes and fenced code. Tables are not rendered yet.
- **Links in an answer are shown, not clickable.** A model-authored URL that
  opened your browser on one click is a decision to take deliberately.
