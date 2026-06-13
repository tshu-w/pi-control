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

Injected only on significant state changes — not every turn:

- **Model switch** (including session's first turn): `[pi-control] model=<provider/id>`
- **Context threshold crossing** (70% / 85% / 95%): `[pi-control] context=<n>% (<level>)`

When injected, the status is appended to the last user message content rather than inserted as a separate message. This avoids creating a new cache breakpoint that would invalidate Anthropic/Claude prompt caching on every turn.

For full runtime details (model, context%, tool output share), use `sessions(action='info')`.

## Install

```bash
pi install git:github.com/tshu-w/pi-control
```

## Heads-up: private API hack

To drive `resume` / `new` / `navigate` / `fork` from tool calls, pi-control patches `ExtensionRunner.prototype.bindCommandContext` at runtime — pi does not yet expose these as public APIs.

The patch is idempotent and applied once on activation. If it fails (pi internal drift, version mismatch), the affected actions fall back to printing the equivalent slash command and the rest of the tool surface keeps working. Compatibility is therefore tighter than a normal extension; tested against `@earendil-works/pi-coding-agent` 0.75.x.

When pi adds first-class APIs, the hack goes away. Tracking upstream at [earendil-works/pi#2023](https://github.com/earendil-works/pi/issues/2023).

## License

MIT.
