# Architecture

The boundaries here exist so that Windows and Linux can be added, model
providers swapped, and capabilities extended without rewriting the core. This
file describes each boundary and how to work with it.

## Process boundaries

| Process | Owns | Must never |
|---|---|---|
| Renderer | Pet sprite, the command line | Touch Node, the filesystem, or any IPC channel outside the preload API |
| Electron main | Windows, SQLite, Keychain, undo, desktop session, global shortcuts | Run the agent loop, or call a model |
| Runtime | The task loop, tool execution, model calls, browser, OS adapter | Draw UI, or bypass the tool registry |

The runtime is a forked child process rather than a thread so that a stalled
model call or a wedged native operation cannot freeze the interface, and so
that a crashed runtime can be restarted in place (`RuntimeHost.restart`).

## The OS adapter (`src/os/`)

`OsAdapter` is a capability interface. `supports(capability)` is the only
correct way to ask whether something is possible — calling an unsupported
operation throws `UnsupportedCapabilityError`, which the loop surfaces to the
model as "use a different approach" rather than as a task failure.

To add a platform:

1. Implement `OsAdapter` for it.
2. Return honest `supports()` results. Reporting a capability you have not
   implemented is worse than returning `false`, because the loop will plan
   around a `false`.
3. Add it to the switch in `createOsAdapter`.

Nothing above the adapter references macOS, Swift, or accessibility concepts.

### The macOS helper (`src/os/swift/KibuHelper.swift`)

A long-lived process speaking newline-delimited JSON. It is deliberately
policy-free: it exposes capabilities and reports failure honestly, and all
decisions live in TypeScript.

Two things it does that matter:

- **Permission checks never prompt.** `AXIsProcessTrustedWithOptions` is called
  with the prompt flag `false`, so asking "can I?" does not surprise the user
  with a dialog.
- **One coordinate space.** Accessibility frames and CGEvent mouse positions
  use global points with the origin at the top-left of the primary display.
  `NSScreen` is bottom-left origin, so `listDisplays` converts once rather than
  leaving a trap at every call site.

`validateStamp` confirms an element still has the role and label it had when
observed, before any action is performed on it.

## The tool registry (`src/runtime/tools/registry.ts`)

Every capability is a `ToolDefinition` with:

- `input` — a Zod schema, which is both the model-facing JSON schema and the
  local validator. Model output is parsed through it before anything runs.
- `capability` — the name used to scope which tools a task is even offered.
- `scopes(input)` — the concrete paths, apps and origins this specific call
  needs, checked against the task's authorization.
- `precondition` — cheap checks that make failure legible before any change.
- `execute` — the effect, returning undo entries and evidence.
- `verify` — independent confirmation the effect landed.

To add a tool, write the definition and register it. Then decide which route
should expose it in `ROUTE_CAPABILITIES` — tool availability is scoped
deliberately, so a folder-sorting task is never handed the browser.

A tool with no `verify` can never, on its own, justify calling a task complete.

## Authorization vs OS permission

These are separate and must stay separate:

- **OS permission** is macOS deciding whether Kibu *can* read a window. It is
  requested when a capability is first needed, with the reason shown verbatim.
- **Task authorization** is the user deciding whether Kibu *may* touch these
  files, this app, this site, for this task. It lives in `TaskState.authorization`
  and is checked by `checkScopes` before every call.

Having Accessibility permission does not authorize any particular action, and
observing a window does not authorize modifying anything — `observeFrontWindow`
grants the app for reading and says so in the note it gives the planner.

## Two model providers, two credentials

Kibu talks to two unrelated services, and conflating them is a mistake worth
naming:

| | Planning model | Jev |
|---|---|---|
| Provider | Anthropic | TypeSafe AI |
| Package | `@anthropic-ai/sdk` | `@typesafe-ai/sdk` |
| Credential | `ANTHROPIC_API_KEY` | `TYPESAFE_API_KEY` |
| Shape | Text and tool calls | Declared typed questions → typed answers |
| Job | Open-ended planning | Fast structured decisions |
| Required? | Yes | No — local rules are the fallback |

Both are stored separately via `Secrets`, encrypted through `safeStorage`.

The loop depends on `PlannerLike`, not on the concrete `Planner`. Supplying
`RunnerDeps.createPlanner` swaps in a different provider, a local model, or the
scripted planner the tests use. `src/runtime/model/pricing.ts` holds the
Anthropic rate table used to enforce spending limits; unknown models are costed
pessimistically so a new model id cannot slip past a limit. Jev is priced
separately in `jev.ts`, since its output tokens are free.

`Jev`'s constructor takes an optional `fetch` override, which is how its
behaviour is tested without a network or a key.

## Where to be careful

- **`rejectedOps` in the task runner** enforces a declined preview in code.
  Anything that adds new file-mutating tools should be added to the check in
  `rejectedOperation`, or a declined operation could be performed by the new
  tool.
- **`serializeResult`** truncates tool output to keep the context bounded. A
  tool returning large payloads should summarise in `execute` rather than rely
  on truncation.
- **`trimHistory`** in the planner keeps the first message and drops the oldest
  middle turns. It must never leave a `tool_result` as the first kept message,
  or the API rejects the request as an orphan.
