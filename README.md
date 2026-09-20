# Kibu

A desktop pet that does real work on your Mac.

Kibu sits on your desktop, takes an instruction, looks at the relevant context,
does the work with files, applications and websites, and shows you evidence of
what it did. You can watch it, pause it, stop it, and undo the file changes it
made.

This is an early prototype. It is macOS-only today, and the sections below say
plainly what has been tested and what has not.

---

## Running it

```bash
npm install
npm run helper:build   # compiles the Swift macOS helper
npm run build
npm start
```

For development with hot reload:

```bash
npm run dev
```

You will need:

- **macOS 14 or later** (the helper targets `arm64-apple-macosx14.0`)
- **Xcode command line tools**, for `swiftc`
- **At least one API key**, added in Kibu's Settings and encrypted with the
  macOS Keychain. No shared key is bundled.
  - **A TypeSafe key** (`TYPESAFE_API_KEY`) for Jev. On its own this covers
    organising a folder, finding a file and renaming files — no planning model
    involved, ~100ms decisions, $0.042/MTok input with output free.
  - **An Anthropic key** (`ANTHROPIC_API_KEY`) for the planning model, needed
    for anything open-ended.

  They are different providers with different keys. See *Doing tasks without
  the planning model* below for exactly which requests need which.

On first run, grant **Accessibility** permission when asked if you want Kibu to
read and control native app windows. Without it, file and browser work still
work; native app control does not, and Kibu will say so rather than guess.

## Using it

- **Click the pet** or press **⌘⇧K** to open the task panel.
- **Drop files or folders onto the pet** to scope a task to exactly those.
- **"Use <app>"** in the composer sends the window you were in before the panel
  opened, for "help me with what I'm doing here".
- **⌘⇧Esc** stops Kibu immediately whenever it is driving your screen.

---

## How it works

```
┌─────────────┐   validated IPC   ┌──────────────┐   typed messages   ┌─────────────┐
│  renderer   │ ────────────────▶ │ Electron main│ ─────────────────▶ │   runtime   │
│ pet + panel │ ◀──────────────── │  (privileged)│ ◀───────────────── │  (agent)    │
└─────────────┘                   └──────────────┘                    └──────┬──────┘
   no Node                          windows, DB,                             │
   no filesystem                    Keychain, undo               ┌───────────┴──────────┐
   no IPC surface                                                │  tools    │ OS adapter│
   beyond a named API                                            │ files     │  macOS    │
                                                                 │ desktop   │  helper   │
                                                                 │ browser   │  (Swift)  │
                                                                 └──────────────────────┘
```

Three processes, on purpose:

- **The renderer** draws the pet and the panel. It has no Node integration and
  no filesystem access. Its entire reach into the rest of the app is the named
  method list in `src/preload/index.ts`, and every one of those lands on a main
  process handler that validates its arguments.
- **The Electron main process** owns windows, the local database, the Keychain,
  undo, and the exclusive desktop-control session.
- **The runtime** is a separate OS process that runs the agent loop and holds
  the privileged capabilities. Keeping it out of process is what lets the
  interface stay responsive when a model call or a native operation stalls, and
  lets a wedged runtime be restarted without taking the app down.

### The loop

`src/runtime/loop/task-runner.ts` implements one explicit cycle:

```
understand → observe → propose → validate scope → execute → verify → continue | ask | finish
```

The model proposes actions. Local code decides whether they happen:

1. The tool name must exist in the registry for this task's scope.
2. The input must parse against the tool's Zod schema.
3. The requested paths, apps and origins must fall inside the task's
   authorization, or the loop pauses and asks.
4. Protected locations (`/System`, `~/.ssh`, `~/Library/Keychains`, …) are
   refused outright and are never escalated to the user.
5. After execution, the tool's own verifier checks the effect really landed. A
   tool that reports success but fails verification is recorded as a failure.

### Three ways to act, in order of preference

1. **Direct operations** — file moves happen through the filesystem, not by
   driving Finder.
2. **Semantic control** — macOS accessibility actions and browser DOM
   references, which are far more reliable than pixels.
3. **Synthetic input** — clicks and keystrokes, only when nothing above is
   available, and each one records why it was needed.

Element references are tied to the observation that produced them. Acting on a
reference from a stale snapshot fails with a "re-observe first" error instead
of clicking wherever that button used to be.

### Doing tasks without the planning model

Most everyday requests do not need open-ended planning. For those, Kibu runs a
**workflow**: local code enumerates the options, and Jev makes the judgment
calls between them. No planning-model call happens at all.

| Request | What runs | Planner? |
|---|---|---|
| "Organise this folder" | Code derives candidate groups (by type, by a project name recurring in the filenames, by month). Jev picks the grouping and assigns files to it. | No |
| "Find the PDF I downloaded yesterday" | Jev turns the sentence into filters chosen from fixed sets. Code searches and ranks. | No |
| "Rename these files consistently" | Jev picks one of five fixed naming schemes. Code applies it. | No |
| Anything else | The full agent loop. | Yes |

The constraint that keeps this honest: **a workflow may only ask Jev to choose
between alternatives local code has already constructed.** Jev cannot generate
text, so it cannot invent a folder name or a destination path. If a step needs
a value invented, it is not a workflow and the request goes to the planner.

Workflows run their actions through the same `executeTool` path the planner
uses, so they inherit every scope check, verifier and undo record — a workflow
cannot skip a permission prompt or claim an unverified success.

With only a TypeSafe key configured, Kibu still does all three of the above.
A request that needs the planner then fails with a message naming what it *can*
do, rather than a bare error. Turn workflows off in Settings to send everything
through the planner.

### Jev

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is
TypeSafe AI's "System One" model, reached through the `@typesafe-ai/sdk`
package and authenticated with `TYPESAFE_API_KEY`. **It is a separate service
from the planning model, with its own key and its own pricing** ($0.042 per
million input tokens; output is unmetered).

Jev is not a text model. You give it state plus a set of declared typed
questions — `choice`, `noul` (yes/no with a probability), `score` — and it
answers all of them in one round trip. That shape determines how Kibu uses it
(`src/runtime/model/jev.ts`):

- **Routing** a request to a toolset: one `choice` plus one `noul`, in a single
  call, and only when the local keyword rules are unsure.
- **Assigning files to groups that already exist.** Jev picks between labels we
  declared, so it cannot invent a folder name — the planning model proposes the
  groups, Jev does the bulk assignment in one batched call, and the result is
  still shown to you as a preview before anything moves.
- **Choosing whether to reobserve, replan or ask**, but only in the ambiguous
  middle where no local rule fired.

Three constraints, enforced in code rather than hoped for:

- **Jev never authorizes anything and never decides a task succeeded.** Those
  are deterministic checks elsewhere. A probability is not a permission.
- **Jev can only increase caution, never reduce it.** `assessProgress` clamps
  its answer against the local verdict, so a confident "carry on" cannot talk
  the loop past its failure budget. There is a test for exactly this.
- **Where local code can decide correctly, local code decides**, and no call is
  made at all.

Every decision is recorded with its latency, input tokens, cost, and whether
Jev was consulted or local rules answered — including how often Jev changed the
local verdict — so its value can be measured rather than assumed.

---

## Privacy and cost

Kibu **uses cloud models, so it is not an offline app.**

- Tasks, history, observations and preferences stay in a local SQLite database
  in `~/Library/Application Support/kibu`.
- Only the context a step needs is sent to the model. There is no filesystem
  indexing, no continuous screenshotting, and window captures are written to
  the system temp directory rather than retained.
- File and page text is passed to the model marked as untrusted data, and the
  system prompt states that instructions found inside it must never be
  followed.
- Your API key is encrypted via `safeStorage`, which is backed by the macOS
  Keychain.
- Every task has a step limit, a wall-clock limit and a spending limit, all
  enforced by local code before each step.

## Undo

Kibu records an undo entry for the operations it can genuinely reverse: file
moves, renames, and folder creation. Undo runs newest-first and refuses when
the world has moved on — if the file is no longer where Kibu put it, if
something now occupies the original path, or if a created folder now contains
files, it skips that entry and tells you why.

There is no universal undo, and Kibu does not claim one. Copies, downloads,
and anything done through synthetic input are not reversible.

---

## Documentation

- [`docs/TESTED.md`](docs/TESTED.md) — what is actually verified, and what is not
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — boundaries and how to extend them

## Tests

```bash
npm test
```

93 tests covering authorization, file operations, the task loop, the
planner-free workflows, Jev's request shape and caution-clamping, undo, crash
recovery, and a real browser workflow against a local server. See `docs/TESTED.md` for exactly what that does and
does not prove — in particular, neither model provider has been called live.
