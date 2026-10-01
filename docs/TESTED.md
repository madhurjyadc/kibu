# What is actually tested

This file is deliberately blunt. The most dangerous failure mode for an
assistant like this is a confident claim of work it did not do, and that
applies to the project's own status as much as to a task result.

Last updated: 1 October 2026.

---

## Model selection (1 October 2026)

- Live metadata discovery passed against installed Codex (8 models, account plan,
  configured default and recommendation) and Claude Code (12 model choices,
  subscription details and default recommendation). Neither discovery started a
  user turn or generated a reply. This does not verify access across every plan.
- 64 focused tests passed: current catalogs, pagination, partial replies,
  connection details, privacy filtering, missing credentials, timeouts, free vs
  unknown pricing, provider recommendations, denied providers and text support,
  exact model IDs, check error classification and Claude model substitution.
- OpenCode is not installed on this Mac. Its metadata integration was checked
  with an authenticated temporary local fixture server; its older CLI fallback
  and explicit access checks were tested with stand-in CLIs/JSON event fixtures.
- Renderer checks passed for draft recommendations, disabled model choices,
  failed access preserving the saved model, late checks after switching apps,
  separate saved choices, configured defaults, free filtering, custom IDs,
  failed catalog refresh, compact layout, setup and keyboard navigation.
- The production build passed. No live generation checks were run across model
  plans or providers; **Check & use model** performs that check on the user's
  connection only after their explicit click and may consume quota or credits.

## Verified live on a real Mac (26 September 2026)

Run with Kibu's live eval and a few direct script checks, on macOS with Calendar,
Reminders, Notes and Chrome in use:

- **Every app script, against the real apps.** Listing calendars and events,
  reminder lists and open reminders, Notes search, running apps, browser tabs,
  Finder selection, dark mode and volume (read only), and the Shortcuts CLI.
  Creating an event, a reminder and a note; reading each back; undoing each;
  and confirming it is gone. First contact with an app takes up to ~7s while
  it launches; after that calls take 0.1–2s.
- **The Claude Code planner, driving the real loop.** Answering from the open
  browser tab, listing open reminders, saving the open tab as a note (and
  undoing it), and planning a day from Calendar and Reminders. 12 of 12 eval
  cases passed; planner cases took 3–26s, median 8.7s.
- **The no-model app workflows.** Reminders at relative and ambiguous times,
  an event on a named calendar, the agenda, free-slot finding, a note, and the
  biggest file in Downloads. Median 1.7s.

Not live-verified: **Jev itself.** The eval ran with Jev's local fallback,
because the TypeSafe key is encrypted for the app and was not available to the
eval. The Anthropic API
planner path, Mail drafts (they open a window) and running a shortcut (there
were none to run) were also not exercised live.

### Memory (27 September 2026)

Live, with Claude Code planning and a scratch memory: telling Kibu a fact,
the planner answering from it ("who is my manager?" → from memory, 3.1s), an
unrelated request getting no memory at all, and forgetting it. Recall ran on
the local rules; Jev's relevance judgement is covered only by a stubbed test.

## Verified by automated tests (270 tests, all passing)

The suite is kept in the maintainer's working copy, not in this repository.

### Authorization
- A path inside a granted root is allowed; a path outside is reported as a
  missing scope to escalate, not silently permitted.
- A write root implies read on the same tree; a read root does **not** imply
  write.
- Sibling directories sharing a prefix (`/Downloads` vs `/Down`) are not
  treated as nested.
- Protected locations (`/System`, `~/.ssh`, `~/Library/Keychains`) are refused
  outright and never offered to the user as a grantable scope.
- Origins are matched by origin, not by URL prefix.
- Granting the missing scopes makes the identical check pass afterwards.

### File operations
- Listing and searching return real on-disk entries, with depth and result
  limits honoured.
- A move records an undo entry with both paths, and its verifier confirms the
  source is gone and the destination exists.
- A name collision produces `name (2).ext`; the pre-existing file is byte-for-
  byte untouched.
- `onConflict: "fail"` refuses rather than renaming.
- Verification correctly reports failure when the destination is missing.
- A missing source is caught by the precondition before anything changes.
- Tool scoping hides `files_move` from a read-only task.

### The task loop
Driven by a scripted planner through the real `TaskRunner`, real tools and the
real filesystem:
- A full organise-a-folder run: progress → list → preview → create folder →
  two moves → finish. Files genuinely move, the untouched file stays put, both
  moves are independently verified, and three undo entries are recorded.
- A **rejected preview is enforced in code**: when the scripted model ignores
  the refusal and attempts the move anyway, the move never executes and the
  file is untouched.
- An action outside the authorized roots pauses, asks with reason
  `authorization`, and proceeds only once granted.
- A denied authorization request does not perform the action.
- A protected system path is refused **without ever asking the user**.
- Malformed tool input is rejected by schema validation; nothing executes.
- An unknown tool name is handled without crashing the loop.
- Step limit and spending limit both terminate the task with an explanatory
  headline.
- **Cancellation mid-task**: the first move completes, cancellation lands, the
  second move never runs, and what did happen is still undoable.
- GUI tools claim the exclusive desktop session before acting.
- A synthetic click outside every display is rejected by its precondition.
- A stale element reference is reported as needing re-observation.

### Planner-free workflows: real files, stubbed Jev
Driven through the real `TaskRunner` with **no Anthropic key**, and a planner
stub whose `propose()` fails the test if it is ever called:
- A folder of mixed files is genuinely sorted into `Documents/`, `Images/` and
  `Spreadsheets/`, **with the planner never called** and `cost.usd === 0`.
- Grouping by type costs exactly one Jev call, because assignment by extension
  is pure local code.
- Project grouping offers Jev **only the names derived from the filenames**
  (asserted on the request body), and files land in those folders.
- Cancelling the preview moves nothing.
- A near-empty folder is left alone and costs **zero** Jev calls.
- Renaming applies the chosen scheme, and every rename is verified.
- Already-conforming files are reported as needing no work.
- Find turns a sentence into filters and locates the right file.
- Nothing matching is reported honestly rather than as a success.
- **With Jev failing every call (HTTP 500), a folder is still organised** using
  local rules alone.
- **With no Anthropic key at all**, organising still completes; a request no
  workflow covers fails with a message naming what Kibu *can* do.
- Deterministic helpers: project names come from shared filename tokens,
  generic words ("final", "copy") never become folder names, type grouping is a
  pure function of the extension, and all five naming schemes are exact.

### Jev: against a stubbed transport
The SDK's `fetch` override is used, so these cover *our use of the API* (the
request sent and how the answer is treated) without a network or a key:
- Routing sends one `choice` and one `noul` in a **single** request, to
  `/v1/systemone`, with the configured model id.
- A `noul` probability above 0.5 is read as yes.
- A confident local answer makes **no** network call at all.
- **Jev can escalate a local `continue` to `ask`.**
- **Jev cannot talk a deterministic `ask` back down to `continue`**: once a
  local rule fires, no call is even made.
- A lower-caution suggestion on an untidy history is ignored.
- A 500 from the API falls back to the local verdict in both routing and
  progress checks; a task is never broken by Jev being unavailable.
- File assignment offers only the declared groups plus `unsorted`, batches all
  files into one request, and maps answers back by file name.
- Cost accounting uses $0.042/MTok input with free output.

### Progress, cost, undo, recovery
- Consecutive-failure budget, failure-streak reset, identical-error replan,
  staleness → reobserve, and six-identical-calls → replan. All deterministic.
- Local routing without any model call; vague requests flagged for
  clarification; Jev metrics recorded per decision.
- An unknown model is costed pessimistically so it cannot slip past a limit.
- Undo reverses a move, is not applied twice, refuses when something else now
  occupies the original path, skips a file the user has since moved, and
  **never deletes a created folder that now contains files**.
- A task left mid-flight is marked interrupted on next launch rather than
  resumed; a finished task is left alone.

### First-run tour (interface checks, 30 September 2026)
- Against the fake bridge: a first run opens on the tour and "Skip tour"
  never shows it again; the shortcut can be changed by pressing a new chord;
  every installed coding app is offered by name beside an API key, and
  picking one switches planning to it; apps that are not installed are not
  offered; the TypeSafe key is asked for and saved; showing a card asks for
  nothing; each permission is asked for only by its own tap.
- The helper's `automation` op was run by hand in check-only mode: it
  reported Finder and Chrome as granted, Calendar as not running and a
  made-up bundle id as not installed, without showing any dialog. **The
  asking mode (a real "Kibu wants to control…" dialog), the folder prompts
  and the notification prompt have not been exercised** on a Mac that has
  never run Kibu.
- `npm run app`'s build step was run: it produces an ad-hoc signed Kibu.app
  that passes `codesign --verify --deep --strict` after being copied, with no
  update feed. The copy into /Applications and the first launch from there
  have not been run on this Mac.

### Where the pet is
- The default is always on the desktop. Peeking (an option), the pet is hidden when idle; it comes out while working or
  waiting, and for a running timer or a due reminder; it stays six seconds
  after a task finishes, then says it is leaving (so it can slide out) and
  hides.
- Resting the pointer on the lower right edge for a quarter of a second calls
  it, a pointer passing by does not, and neither do the top of the edge or the
  very corner (where macOS hot corners live); it stays while the pointer is on
  it and goes a moment after the pointer leaves.
- Menu bar only never shows it; always on the desktop never hides it.
- A locally built Kibu.app was started for ten seconds on 30 September 2026
  and logged no errors and no shortcut fallback. How the slide looks, and the
  menu bar status text and notifications, were not watched on screen.

### The command line
- `python3 -c`, `node -e` and `npm exec`/`install` are confirmed with the user
  every time, with the exact command, and need write access to the folder
  they run in.
- Every known way of making git run another program is refused: `-c`,
  `--config-env`, `git config`, `submodule foreach`, `bisect run`,
  `--upload-pack`/`-u`, `ext::` URLs and `difftool -x`.
- `cat` needs read access to what it reads; `mv` needs write access at both
  ends, `cp` only where it lands.
- The working folder is held to the home-folder and protected-location rules,
  and a sibling folder sharing the home folder's name as a prefix is outside it.
- `open` refuses apps, scripts, installers, executable files, `--args` and
  non-web URL schemes; the panel's "open" button reveals such files in Finder
  instead of opening them.

### Browser workflow
Against a real Chromium via Playwright and a local HTTP server:
- Navigate, with verification comparing the landed origin.
- Page inspection yields usable element references plus page text surfaced
  under a name that marks it untrusted.
- Fill, with verification reading the value back from the DOM.
- **Form submission where the server actually receives the correct values.**
- **Download where the file lands on disk with the correct contents**, its
  verifier confirms a non-zero size, and evidence points at the real path.
- A reference from a previous page is rejected rather than mis-clicked.
- Without Playwright's own Chromium (any installed copy), the managed browser
  starts the installed Google Chrome, then Microsoft Edge, in Kibu's own
  profile. Launching through the `chrome` channel was checked by hand on
  29 September 2026 (Chrome 154); the fallback order itself is not unit-tested.

### The macOS helper (verified manually)
The compiled Swift helper was run directly and confirmed to:
- Report Accessibility and Screen Recording status truthfully: it returned
  `false` for both when not granted, rather than claiming success.
- Enumerate running applications with pids.
- Report the display as 1470×956 logical at `scaleFactor: 2`, in the
  top-left-origin coordinate space that Accessibility and CGEvent use.

---

## NOT tested: be skeptical of these

### No live Jev call, and no live Anthropic API run
**Update:** the Claude Code planner has now run live (see the top of this file). What follows still applies to Jev and to the Anthropic API planner.

**This was the biggest gap.** Neither an Anthropic key nor a TypeSafe key was
available in the environment where this was built, so the loop has never been
driven by a real planning model and has never made a real Jev call. Every
task-loop test uses a scripted planner, and every Jev test uses a stubbed
transport.

What this means concretely:
- The loop mechanics, validation, verification, limits and undo are proven.
- The **prompt** is not. Whether the planner actually calls `show_preview`
  before moving files, uses `report_progress` sensibly, or declines to follow
  injected instructions in page text is **unverified**.
- Token accounting and the cost limit arithmetic are unit-tested, but have
  never been compared against a real `usage` response.
- The workflows have never run against real Jev answers. Their *mechanics* are
  proven with real files, but whether Jev picks a sensible grouping strategy or
  reads "rename these consistently" as the kebab-case scheme is unverified.
- No call has ever been made to the **real** TypeSafe API. The request shape is
  built against the SDK's own TypeScript definitions (`@typesafe-ai/sdk@0.6.0`)
  and exercised through a stubbed transport, but no live Jev response has been
  seen. Confidence calibration in particular (where to put the `noul`
  threshold, currently 0.5) is a guess until measured.

The first thing to do with a working API key is run the three demo workflows
end to end and check the prompt behaves.

### Native application control is unproven against real apps
The Swift helper compiles and its non-privileged operations work. But
Accessibility permission was not granted in this environment, so:
- `inspectWindow` has never returned a real element tree.
- `pressElement` and `setElementValue` have never driven a real control.
- Synthetic clicks, typing, scrolling and shortcuts have never been posted.
- `captureWindow` (ScreenCaptureKit) has never produced an image.

**No specific application has been tested.** The spec asks for a documented
list of apps and workflows that work; that list is currently empty and should
stay empty until each one is actually exercised.

### Other known gaps
- **Multi-display and Retina handling is coded, not verified.** The coordinate
  space is unified to top-left origin and the conversion is tested against a
  single Retina display only. A multi-monitor setup, or a mixed-DPI setup, has
  not been tried.
- **The exclusive desktop session is advisory at the runtime boundary.** The
  main process refuses a second claimant and logs it, but the runtime does not
  receive that refusal; it only sends a claim. Today this is safe because the
  runtime refuses to start a second concurrent task at all, but the two
  mechanisms should be joined up before concurrent tasks are allowed.
- **Pause does not interrupt an in-flight tool call.** It takes effect at the
  next checkpoint, between steps. A long `browser_download` will finish first.
- **The signed build has not been run.** An *unsigned* packaged build
  (`electron-builder --dir`) was launched on 29 September 2026: the task
  runtime started from inside `app.asar` and the Swift helper started from
  `Contents/Resources/resources/bin`, and `Info.plist` carried the minimum
  macOS version and permission strings. Signing, notarization, Gatekeeper on
  a fresh Mac, Accessibility surviving a relaunch, and auto-update have not
  been exercised, because no Developer ID certificate was available.
- **The planner moved to Claude Sonnet 5.5 without a live run.** The request
  shape type-checks against `@anthropic-ai/sdk` 0.127 (refusal fallback, and
  dropping stale thinking after the history is trimmed), and a refusal is
  covered by a scripted test, but no real Sonnet 5.5 call has been made.
- **Windows and Linux are unimplemented.** `UnimplementedAdapter` reports every
  capability as unsupported, which is intentional (the runtime degrades to
  file work rather than failing confusingly), but nothing there has run.
- **Voice, proactive observation and "watch this task" mode are not built.**
  These were explicitly deferred.

---

## How to extend this file

When you make a capability work, add it here with what you actually did, not
what you expect to work. If a workflow is tested against TextEdit, say
"TextEdit", not "native apps".
