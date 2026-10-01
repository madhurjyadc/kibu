# Kibu

A desktop pet that does real work on your Mac.

Kibu sits on your desktop, takes an instruction, looks at the relevant context,
does the work with files, applications and websites, and shows you evidence of
what it did. You can watch it, pause it, stop it, and undo the file changes it
made.

This is an early prototype. It is macOS-only today, and the sections below say
plainly what has been tested and what has not.

The short version, with a demo you can try in the browser, is at
<https://getkibu.vercel.app>.

---

## Installing it

You need an Apple silicon Mac (M1 or later) on macOS 14+, [Node.js](https://nodejs.org) 22.12 or later, and Apple's
command line tools (`xcode-select --install`). Then:

```bash
git clone https://github.com/madhurjyadc/kibu.git && cd kibu && npm install && npx install-electron --no && npm run app
```

`npm install` also downloads the Electron executable. The first Swift helper
build can take a few minutes without printing progress; let it finish.

That builds **Kibu.app** on your Mac, puts it in Applications and opens it.
Press **⌘⇧Space** from anywhere, or click Kibu's face in the menu bar. An app
you build yourself opens without any Apple warning; because it is signed only
for this build, macOS may ask for its permissions again after you update.

To update: `git pull && npm install && npx install-electron --no && npm run app`.

For development with hot reload, use `npm run dev` instead (macOS will call it
"Electron" in its permission dialogs).

If startup reports `Error: Electron uninstall`, run `npx install-electron --no`
in the repo, then retry your command. This also repairs an older checkout or an
install made with npm scripts disabled.

### What Kibu thinks with

- **A model connection for open-ended app/browser tasks**. Local file search, arithmetic,
  and capability help work without a model key. API keys can be added under Settings and encrypted with
  the macOS Keychain. No shared key is bundled.
  - **A TypeSafe key** (`TYPESAFE_API_KEY`) for Jev. On its own this covers
    organising a folder, finding a file and renaming files, with no planning model
    involved, ~100ms decisions, $0.042/MTok input with output free.
  - **An Anthropic key** (`ANTHROPIC_API_KEY`) for the planning model
    (Claude Sonnet 5.5), needed for anything open-ended.

  They are different providers with different keys. See *Doing tasks without
  the planning model* below for exactly which requests need which.

  **Already use Claude Code?** Then there is nothing to set up: the tour
  offers to think with the Claude Code on your Mac, using your own login;
  see *Planning through Claude Code* below. Codex and OpenCode work the same way.

## First run

Kibu opens on a one-minute tour: one card per thing it can do, each with a
line of explanation, something you could type, and, on the same card, the
macOS permissions that thing needs. Nothing is asked for until you tap
"Allow"; every card can be skipped. `/setup` shows it again, and Settings →
Permissions lists everything in one place.

1. **Hello**, and the shortcut, ⌘ Command + ⇧ Shift + Space (not ⌘ Command + Space,
   which is Spotlight's). Click it and press a new chord to change it; if
   another app already holds it, Kibu picks the next free one and shows that.
2. **How Kibu thinks**: pick one of the coding apps found on this Mac (Claude
   Code, Codex, OpenCode, each using its own login), or an Anthropic API key.
   The same card asks for the optional TypeSafe key for Jev.
3. **Files**: Desktop, Documents and Downloads.
4. **Your day**: Calendar, Reminders, Notes and Mail.
5. **The web**: each installed browser, with its "Allow JavaScript from Apple Events" step spelled out.
6. **Other apps**: Accessibility, Screen Recording, Finder and System Events.
7. **Remember & remind**: notifications.
8. **That's it**: what it thinks with, whether Jev is on, how many
   permissions are allowed, and a few requests to try.

Reading a permission never prompts. A denied one links to the right page of
System Settings.

## Where the pet lives

By default, Kibu stays out of sight. Press **⌘⇧Space** to bring up the pet and
prompt together. Close the prompt to put both away; the pet stays visible while
work is running or waiting for your answer, briefly shows the result, and comes
back when a reminder is due. A running or paused timer keeps the pet on screen
until it is cancelled or dismissed.

The background host keeps the shortcut and reminder clock available. When the
workspace is closed and no task is running, the task runtime shuts down and
hidden windows throttle their rendering. **Quit Kibu** in the menu bar stops
it completely, including its shortcut and reminders. Settings → **Open Kibu at
login for reminders** starts the host again when you log in.

Settings → **The pet** also offers **always on the desktop**, **only while
working** (with the right-edge hover shortcut), and **menu bar only**. An
explicitly chosen mode is preserved across updates. While visible, drag the pet
anywhere, drop files on it, or right-click it to dance, nap, or **Hide Kibu**.
Hiding only tucks away the pet: tasks, timers and reminders keep running. Call
Kibu again to bring it back; a new task, due reminder or ringing timer also
brings it back. The default shortcut avoids ChatGPT’s ⌥Space pet shortcut;
change Kibu’s shortcut in Settings if you prefer another chord.

## Using it

Press **⌘⇧Space** or click Kibu’s face in the menu bar to open the pet and companion
workspace. The minimal home has one input and Find, Organize, and Rename actions.
The clock opens History; the sliders open Settings.

- **Type a request and press Enter**, or use the send button. Quick actions fill
  an editable draft, so you can choose the scope before anything runs.
- **Drop files or folders onto the pet or panel** to scope a task to exactly those.
- **Include the previous app** with the context toggle or **⌥Enter**.
- **Answer a question** using its buttons, number shortcuts, or the composer
  when free text is allowed. File previews show before/after names, and you can
  expand the complete list.
- **Watch, pause, stop, or inspect steps** from the task view. Settings and
  History remain navigable while a task runs.
- **Delete a task from History**, or clear all finished tasks. Deletion removes
  the saved request, logs, and undo records; your actual files stay untouched.
- **Open result files and web links**, reveal files in Finder, or undo supported
  changes. Failed sends preserve the draft and attached paths.
- **Esc** clears a draft, backs out of a page, or hides the workspace.
- **⌘⇧Esc** stops Kibu immediately whenever it is driving your screen.

Slash commands remain available in the composer as keyboard shortcuts:

| | |
|---|---|
| `/undo` | put back what it moved |
| `/steps` | every tool call of the last task, and whether each was verified |
| `/past` | what it did before |
| `/stop` | stop what it is doing |
| `/keys` | the two API keys |
| `/tune` | limits, habits and macOS permissions |
| `/setup` | the one-minute tour again, with every permission |
| `/bench` | time every route on this Mac: Jev, the macOS index, local code |
| `/help` | all of the above |

---

## How it works

```
┌─────────────┐   validated IPC   ┌──────────────┐   typed messages   ┌─────────────┐
│  renderer   │ ────────────────▶ │ Electron main│ ─────────────────▶ │   runtime   │
│ pet + line  │ ◀──────────────── │  (privileged)│ ◀───────────────── │  (agent)    │
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

- **The renderer** draws the pet and the line you type into. It has no Node integration and
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

### Ways to act, in order of preference

1. **Direct operations**: file moves happen through the filesystem, not by
   driving Finder.
2. **App scripting**: Calendar, Reminders, Notes, Mail, browser tabs, the
   Shortcuts app and a few system settings are driven through their own
   scripting interfaces (`src/os/macos/scripting.ts`), which take well under a
   second and either work or say why. Each change is read back to verify it,
   and new events, reminders, notes and setting changes can be undone. Mail is
   only ever a draft; nothing Kibu does reaches another person on its own.
3. **Semantic control**: macOS accessibility actions and browser DOM
   references, which are far more reliable than pixels.
**Never: your mouse or keyboard.** Kibu does not move the pointer or type
keystrokes, ever. The tools that could (`syntheticInputTools` in
`src/runtime/tools/desktop.ts`) are defined but not registered. If something
can only be done by clicking, Kibu tells you what to click.

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
| "Make a folder called automaton in dev and open it in Zed" | Local patterns produce the steps; the macOS index resolves which folder and which app was meant. Jev only picks when several real candidates exist. | No |
| "Remind me to call mom tomorrow at 7" | Code reads the title and the time (`src/runtime/when.ts`). "At 7" has two readings; Jev picks between them. | No |
| "Put dentist on my calendar friday 10am" | Code reads title, time and length; Jev picks which of your real calendars; code warns about clashes. | No |
| "What's on tomorrow", "when is my first free hour" | Code reads the day and window, reads Calendar, and finds the gaps. | No |
| "Dark mode", "volume to 30", "mute" | Code. | No |
| "Run my focus shortcut" | Jev picks among the names of your real shortcuts. | No |
| "Note: …", "save this to Notes" | Code; "this" is your selection or open tab. | No |
| Anything else | The full agent loop. | Yes |

Live, on a real Mac, these take about 0.5–3 seconds end to end.

The constraint that keeps this honest: **a workflow may only ask Jev to choose
between alternatives local code has already constructed.** Jev cannot generate
text, so it cannot invent a folder name or a destination path. If a step needs
a value invented, it is not a workflow and the request goes to the planner.

Workflows run their actions through the same `executeTool` path the planner
uses, so they inherit every scope check, verifier and undo record: a workflow
cannot skip a permission prompt or claim an unverified success.

With only a TypeSafe key configured, Kibu still does all three of the above.
A request that needs the planner then fails with a message naming what it *can*
do, rather than a bare error. Turn workflows off under `/tune` to send
everything through the planner.

### Making the planner fast

When a request does need the planner, one Jev call (`Jev.planSetup`) settles
what its first step would otherwise spend a round trip on:

- **Which tool families** the request needs. The planner is shown, say, only
  the Notes and "what's on screen" tools for "save this page as a note",
  instead of all fifty. A shorter prompt is a faster step.
- **Which parts of "this"** to fetch in advance: your selected text, the tab
  open in your browser, Finder's selection, or, only when you mention
  copying or pasting, the clipboard. They are fetched in parallel and handed
  to the planner as data.
- **Whether the quick model will do.** Small jobs plan on Haiku with thinking
  off.

These are bets, and they are called off automatically: the first time the
progress check says the work is not going well, the planner is shown every
tool and moved to the full model. Narrowing the menu never grants anything;
every call still passes the scope check. Without a TypeSafe key, keyword rules
answer the same questions.

### Planning through Claude Code

Kibu's loop talks to a `PlannerLike`, not to a vendor, so the planning model
can be swapped without touching anything else.
`src/runtime/model/claude-code-planner.ts` is a second implementation that
drives the locally installed **Claude Code CLI** in print mode instead of the
Anthropic API, using the login already on the machine. Turn it on under
`/tune`; it only appears when the `claude` binary is actually found.

One Claude Code process is started per task and kept open, fed one message
per step over `--input-format stream-json`; starting the CLI costs about two
seconds, so doing it once instead of every step roughly halves a task. It
restarts on the same conversation only when the model tier changes. It runs with **no Claude Code tools
loaded or allowed** (`--tools "" --allowed-tools ""`), no user settings, hooks,
skills or MCP servers (`--setting-sources "" --disable-slash-commands
--strict-mcp-config`), from a neutral working directory, so that process can
only answer: it cannot read a file, run a command, or pick up the `CLAUDE.md`
of whatever project you happen to be sitting in. Kibu's system prompt
*replaces* Claude Code's coding-agent prompt (`--system-prompt`), which takes a
trivial step from about 4s to about 1.5s. It is handed Kibu's system prompt, Kibu's tool schemas, and the
task's authorization, and it replies with one JSON object naming the calls it
wants. The first turn opens a session; later turns `--resume` it, so the
conversation is not resent each step.

Everything downstream is unchanged: the proposal still goes through the same
registry check, schema parse, authorization check, protected-path refusal,
verifier and undo record. A planner that proposes something out of scope is
stopped by the same code that stops the API planner.

Two honest caveats:

- **This is for running Kibu on your own machine with your own login**,
  which is how Kibu is installed today: everyone builds and runs their own
  copy. Anthropic does not permit third-party products to offer claude.ai
  login or subscription rate limits to *their* users without prior approval
  ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)),
  so a signed build distributed to other people should
  lead with an API key instead.
- **Nothing is billed, so the per-task spending limit does not apply on this
  path**: it reports no cost rather than a number nobody is charged. The step
  limit and the wall-clock limit are what bound a task here, and planning
  steps consume your Claude Code usage allowance.

### Running things on the command line

`shell_run` exists, and the shape of it matters more than the feature. The
dangerous way to build this is to let a model write a shell string and hand it
to `sh -c`; one confused sentence, or one instruction hidden in a web page, is
then arbitrary code execution. Instead:

- **There is no shell.** Commands run through `execFile` with an argv array,
  so pipes, redirects, `;`, backticks and `$(...)` are inert text.
- **Only allowlisted programs run**: `mkdir`, `cp`, `mv`, `ls`, `cat`, `git`,
  `open` and a few more. `rm`, `sudo`, `curl` and their relatives are absent
  by design rather than filtered afterwards. Git is limited to a list of
  everyday subcommands, and every way of making it run another program
  (`-c`, aliases, `--upload-pack`, `ext::` URLs) is refused.
- **Programs that run code ask every time.** `node`, `python3` and `npm` can
  do anything your account can, so no folder permission covers them: Kibu
  shows you the exact command and waits for your OK on every run.
- **`open` will not launch anything.** Apps, scripts, installers and files
  marked executable are refused, and so are URL schemes other than web pages.
- **Every path argument, and the folder a command runs in, must resolve
  inside your home folder** and never into a protected location (including
  via `../..`), and inside what the task has been allowed to read or write.

`vetCommand` and `commandScopes` are that boundary, and they are tested directly.

### Jev

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is
TypeSafe AI's "System One" model, reached through the `@typesafe-ai/sdk`
package and authenticated with `TYPESAFE_API_KEY`. **It is a separate service
from the planning model, with its own key and its own pricing** ($0.042 per
million input tokens; output is unmetered).

Jev is not a text model. You give it state plus a set of declared typed
questions, namely `choice`, `noul` (yes/no with a probability) and `score`, and it
answers all of them in one round trip. That shape determines how Kibu uses it
(`src/runtime/model/jev.ts`):

- **Routing** a request to a toolset: one `choice` plus one `noul`, in a single
  call, and only when the local keyword rules are unsure.
- **Assigning files to groups that already exist.** Jev picks between labels we
  declared, so it cannot invent a folder name; the planning model proposes the
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
Jev was consulted or local rules answered, including how often Jev changed the
local verdict, so its value can be measured rather than assumed.

---

## Memory

Kibu gets more useful the more you use it, without dragging the past into
every request.

- **Told:** "remember that my manager is Priya", "from now on, invoices go in
  Finance". Handled in code, instantly.
- **Learned:** choices you make yourself. Naming a calendar for "standup" once
  means the next "standup friday 9am" goes there too, and the result says
  "like last time" with a *From memory* line. A shortcut Kibu had to work out
  from your words is remembered under those words. Defaults Kibu guessed are
  never learned, only choices you made.
- **Relevant only.** Before a task, local code shortlists memories sharing a
  word or topic with the request; Jev then answers one yes/no per memory
  ("would knowing this help?"), in a single call. Without Jev, a memory must
  share a distinctive word. The planner is told to use what it is given only
  where it helps and never to mention the rest, and to cite what it relied on,
  which shows in the result so a wrong memory can be caught.
- **Yours.** "What do you remember about me", "forget that …", "forget
  everything"; or Settings → Memory, where each item can be forgotten and
  learning or memory can be turned off. Stored in the local database only.
  Passwords, codes, keys, card and ID numbers are refused in code, whoever asks.

`src/runtime/memory.ts` holds the rules; `src/runtime/workflows/memory.ts` the
told/forget/list conversation.

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
the world has moved on: if the file is no longer where Kibu put it, if
something now occupies the original path, or if a created folder now contains
files, it skips that entry and tells you why.

There is no universal undo, and Kibu does not claim one. Copies, downloads,
and anything done through synthetic input are not reversible.

---

## Documentation

- [`docs/TESTED.md`](docs/TESTED.md): what is actually verified, and what is not
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): boundaries and how to extend them

## Tests

Kibu is developed against 270 automated tests covering memory (what is kept, refused, recalled and forgotten), authorization, file operations, the task loop, the
planner-free workflows (files and apps), time reading, Jev's request shape and
caution-clamping, the planner's tool narrowing and widening, the persistent
Claude Code session, undo, crash recovery, and a real browser workflow against
a local server. The app tests run against an in-memory fake Mac, never your
real apps. Alongside them, a live eval runs real requests through the real
runner on a Mac, and interface checks drive the renderer against a fake bridge.

The test suite and the eval stay in the maintainer's working copy, so this
repository holds only what is needed to build and run Kibu. See
`docs/TESTED.md` for exactly what they do and do not prove.

### Natural document search

Local search recognizes Aadhaar/aadhar/adhar/आधार and common document terms
such as CV/resume and driving licence/license. It drops conversational words
like “my PC,” prioritizes document names over unrelated recent files, and uses
Spotlight's indexed text plus a bounded filename fallback. It does not perform
OCR on unindexed scans. An unknown filename or encrypted/unindexed document can
still require a narrower folder or another search term.
