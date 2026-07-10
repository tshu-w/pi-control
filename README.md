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

**Status line** (event-driven)

Appended to the last user message on state changes:

- **Model switch** (including first turn): `[pi-control] model=<provider/id>`
- **Context threshold crossing** (70 / 85 / 95%): `[pi-control] context=<n>% (<level>)`

Full runtime details available via `sessions(action='info')`.

## Install

```bash
pi install git:github.com/tshu-w/pi-control
```

## Heads-up: private API hack

To drive `resume` / `new` / `navigate` / `fork` from tool calls, pi-control patches `ExtensionRunner.prototype.bindCommandContext` at runtime — pi does not yet expose these as public APIs.

The full private-API surface, for upgrade auditing:

- `ExtensionRunner.prototype.bindCommandContext` — patched to capture the five session-transition closures (`switchSession` / `newSession` / `navigateTree` / `fork` / `reload`) and the runner instance
- `runner.getRegisteredCommands()` / `runner.getCommand()` / `runner.createCommandContext()` — used by the `commands` router to enumerate and invoke third-party slash commands
- `runner.runtime.sendUserMessage` — used to deliver the follow-up message after a `reload` (the pre-reload extension closure would be stale)

The patch is idempotent and applied once on activation. If it fails (pi internal drift, version mismatch), the affected actions fall back to printing the equivalent slash command and the rest of the tool surface keeps working. Compatibility is therefore tighter than a normal extension; requires pi >= 0.80.4 (deferred transitions run on the `agent_settled` event), tested against `@earendil-works/pi-coding-agent` 0.80.x.

When pi adds first-class APIs, the hack goes away. Tracking upstream at [earendil-works/pi#2023](https://github.com/earendil-works/pi/issues/2023).

## Testing

```bash
npm install && npm test
```

`tests/contract.test.mjs` pins the private-API assumptions above against the
installed pi package — run it after every pi upgrade; it fails before
resume/new/navigate/fork silently degrade at runtime. `tests/command-actions.test.mjs`
covers the deferred-action state machine (single pending slot,
consume-before-await, cancellation/error paths, follow-up delivery) with
recording fakes in place of pi's closures. `tests/scan.test.mjs` covers
session search filtering and own-output exclusion.

## License

MIT.
