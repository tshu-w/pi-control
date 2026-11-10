# pi-control

A [Pi](https://pi.dev) package that lets the agent drive Pi's runtime itself — resume sessions, switch models, navigate history — through tool calls.

Ask for "my previous dev session" or "try another model from here", and the agent does it instead of asking you to type the slash command.

## What's in the box

**Tools** (extension)

| Tool | Actions |
|---|---|
| `sessions` | `info`, `search`, `resume`, `new`, `name`, `queue_message`, `reload` |
| `tree` | `list`, `search`, `labels`, `set_label`, `navigate`, `fork`, `compact` |
| `models` | `list`, `switch`, `consult` |
| `commands` | `list`, `run` |

**Runtime status**

Notifies the model on state changes:

- **Model switch** (excluding the first turn): `[pi-control] Switched from model <previous> to model <current>.`
- **Context threshold crossing** (70 / 85 / 95%): `[pi-control] Context usage: <n>%.`

Full runtime details available via `sessions(action='info')`.

## Install

```bash
pi install git:github.com/tshu-w/pi-control
```

## Heads-up

`/pi-control-internal` appears in the command list; it is used by pi-control's tools and does nothing when typed.

`commands(action='run')` relies on a private Pi API; if Pi changes it, run the slash command yourself.

## Testing

```bash
npm install && npm test
```

## License

[AGPL-3.0](LICENSE)
