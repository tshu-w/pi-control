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

**Runtime status** (event-driven)

Notifies the model on state changes:

- **Model switch** (excluding the first turn): `[pi-control] Switched from model <previous> to model <current>.`
- **Context threshold crossing** (70 / 85 / 95%): `[pi-control] Context usage: <n>%.`

Full runtime details available via `sessions(action='info')`.

## Install

```bash
pi install git:github.com/tshu-w/pi-control
```

## Heads-up: private API hack

pi-control uses private Pi APIs for runtime controls that are not publicly exposed. This may require updates when Pi changes its internals; affected actions return fallback instructions when the patch is unavailable. Run `/reload` after upgrading pi-control.

Requires pi >= 0.86.0 and is tested against `@earendil-works/pi-coding-agent` 1.0.1. Public API tracking: [earendil-works/pi#2023](https://github.com/earendil-works/pi/issues/2023).

## Testing

```bash
npm install && npm test
```


## License

[AGPL-3.0](LICENSE)
