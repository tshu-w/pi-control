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

## Private API dependency

pi-control patches Pi's internal command context because session transitions are not yet exposed as public extension APIs. This may require updates when Pi changes its internals; affected actions return fallback instructions when the patch is unavailable. Restart Pi after upgrading Pi or pi-control so the patch binds to the current runtime.

Requires pi >= 0.80.4 and is tested against `@earendil-works/pi-coding-agent` 0.82.0. Public API tracking: [earendil-works/pi#2023](https://github.com/earendil-works/pi/issues/2023).

## Testing

```bash
npm install && npm test
```


## License

MIT.
