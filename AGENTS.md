# AGENTS.md

## Docs stay in sync with code

When changing code, update the affected docs in the same commit:

- `README.md` — user-facing behavior: tool table, status line, private-API surface
- Tool schema `description` / `promptGuidelines` in `extensions/*.ts` — the model-facing contract
- `skills/pi-control/SKILL.md` — workflow patterns (when/why, not what/how; tools stay self-describing)
- File header comments in `extensions/index.ts`, `command-actions.ts`, `commands.ts` — design-level invariants

## Conventions

- Code, comments, and commit messages in English
- Commit style: Conventional Commits (`feat(sessions): ...`, `fix(tree): ...`)
- Any new private-API dependency must be listed in README's "Heads-up" section
