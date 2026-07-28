# pi-control

A [pi](https://pi.dev) package that lets the agent drive pi's runtime itself — resume sessions, switch models, navigate history — through tool calls.

Most agent harnesses keep these controls user-only. Ask for "my previous dev session" or "try another model from here", and the user still has to type the slash command. pi-control changes that: it patches pi's internal command context and exposes runtime control to the agent. **If the user can do it, the agent should too.**

## What's in the box

**Tools** (extension)

| Tool | Actions |
|---|---|
| `sessions` | `info`, `search`, `resume`, `new`, `name`, `queue_message`, `reload` |
| `tree` | `list`, `search`, `labels`, `set_label`, `navigate`, `fork`, `compact` |
| `models` | `list`, `switch`, `consult` |
| `commands` | `list`, `run` |

All model-visible tool results and errors are capped at 50KB / 2000 lines. Truncated model consultations and already-executed slash commands are best-effort saved to a temporary file, because replay may be expensive or unsafe. Tool-result `details` retain only structured state, rendering, and follow-up metadata.

**Status line** (event-driven)

Appended to the last user message on state changes:

- **Model switch** (including first turn): `[pi-control] model=<provider/id>`
- **Context threshold crossing** (70 / 85 / 95%): `[pi-control] context=<n>% (<level>)`

Full runtime details available via `sessions(action='info')`. Runtime bindings, pending transitions, and model-status tracking are isolated per Pi session. Router list/search actions enforce page caps, and third-party command notifications and status updates are bounded before rendering.

## Install

```bash
pi install git:github.com/tshu-w/pi-control
```

## Heads-up: private API hack

To drive `resume` / `new` / `navigate` / `fork` from tool calls, pi-control patches `ExtensionRunner.prototype.bindCommandContext` at runtime — pi does not yet expose these as public APIs.

The full private-API surface, for upgrade auditing:

- `ExtensionRunner.prototype.bindCommandContext` — patched to capture the five session-transition closures (`switchSession` / `newSession` / `navigateTree` / `fork` / `reload`) plus `waitForIdle` and the runner instance
- `runner.getRegisteredCommands()` / `runner.getCommand()` / `runner.createCommandContext()` — used by the `commands` router to enumerate and invoke third-party slash commands
- `runner.runtime.sendUserMessage` — used to deliver the follow-up message after a `reload` (the pre-reload extension closure would be stale)

Captured command state lives in a process-wide registry keyed by session manager. A versioned process-wide wrapper marker prevents duplicate wrapping across `/reload` without reusing incompatible wrappers from older releases, while a `WeakSet` tracks each patched `ExtensionRunner.prototype`. If an in-process upgrade exposes a new class identity, pi-control patches that prototype too and invalidates every session's closures captured from the old runner until each active session binds again. If the patch still fails (pi internal drift or an unreachable runner class), affected actions fall back to printing the equivalent slash command and the rest of the tool surface keeps working. Compatibility is therefore tighter than a normal extension; requires pi >= 0.80.4 (deferred transitions run on the `agent_settled` event), tested against `@earendil-works/pi-coding-agent` 0.82.0.

Timing semantics: a model switch is applied inside the `agent_settled` extension emit, before pi publishes settled to SDK/RPC/UI listeners — an external prompt racing the settled event already runs on the new model. Session transitions cannot run inside that emit (they tear down the runner), so they run just after; before executing, pi-control awaits `waitForIdle()` so a prompt that raced into that window finishes instead of being torn down mid-turn. A small window between the idle check and the transition's first step remains — closing it fully needs an upstream pre-publication seam. Follow-up delivery after `resume` / `new` / `fork` is awaited via the replaced-session context; `queue_message`, `navigate`, `compact`, `reload`, and model-handoff messages go through pi's fire-and-forget `sendUserMessage` (returns `void`), so those tools report submission, not confirmed enqueueing, and delivery failures surface as extension errors.

When pi adds first-class APIs, the hack goes away. Tracking upstream at [earendil-works/pi#2023](https://github.com/earendil-works/pi/issues/2023).

## Testing

```bash
npm install && npm test
```

`tests/contract.test.mjs` pins the private-API assumptions above against the
installed pi package — run it after every pi upgrade; it fails before
resume/new/navigate/fork silently degrade at runtime. `tests/command-actions.test.mjs`
covers prototype-identity recovery plus the deferred-action state machine
(single pending slot, consume-before-await, cancellation/error paths,
follow-up delivery, and cross-session isolation) with recording fakes in place
of pi's closures.
`tests/commands.test.mjs` covers bounded third-party command capture.
`tests/scan.test.mjs` covers session search filtering, page caps, and own-output
exclusion. `tests/output-contract.test.mjs` covers final output bounds,
full-output preservation, error handling, and lean details.

## License

MIT.
