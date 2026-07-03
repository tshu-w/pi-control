---
name: pi-control
description: "Workflow patterns for the pi-control extension — cross-model review loops, session lifecycle, and runtime self-regulation. Use when doing non-trivial work that benefits from a second opinion, when the user asks for review or cross-checking, after repeated failures on the same problem, when planning cross-session or cross-model handoffs, or when choosing which model to use for a task. Also triggered by mentions of review loop, model selection, or multi-model collaboration."
---

# Pi-Control Patterns

pi-control exposes four tools — `sessions`, `tree`, `models`, `commands`. Each tool's own guidelines cover basic usage. This skill teaches higher-level patterns: when and how to combine them.

## Cross-Model Collaboration

Different models have different priors and failure modes. Deliberately using another model surfaces blind spots the current one wouldn't catch.

### When to Use

- Non-trivial implementations where a bug would be costly
- Repeated failures (2+ attempts) on the same approach
- User explicitly asks for review or a second opinion
- Complex reasoning where logic-chain verification matters

Simple edits, formatting, and routine tasks don't need this.

### Model Selection

Start from scoped models (`models(list)`); only `scope="all"` when the user asks.

| Role | Good picks | Why |
|------|-----------|-----|
| Implementor | Claude Opus | Strong code generation, multi-file changes |
| Pattern reviewer | Gemini Pro | Different training priors, catches structural issues |
| Logic reviewer | GPT | Strong logical-chain reasoning |
| Digest / summarize | Cheap/fast model | Token-efficient for bulk reading |

For critical review, run two reviewers in sequence — their failure modes rarely overlap.

### Review Loop

Implement → review → fix → repeat until the reviewer approves.

```
1. Do the work.
2. models(switch, modelId="<reviewer>", thinkingLevel="high",
          message="Review the changes above. Give concrete issues only.")
3. Reviewer gives feedback.
4. models(switch, modelId="<implementor>",
          message="Apply the feedback above.")
5. Fix the issues.
6. Repeat from step 2, or stop when the reviewer approves.
```

- **End on the implementor.** The next turn after a loop should be action, not critique.
- **Give the reviewer a focused prompt.** "Review X" beats dumping context without direction.
- **Always pass `message=`** to drive the next turn after a switch.

### Consult (One-Shot)

For a narrow question that doesn't need full session handoff:

```
models(consult, modelId="<model>", prompt="Is X or Y the right approach for ...?")
```

Result comes back inline — no model switch, no context loss.

### Handoff

Plan with one model, implement with another (or vice versa):

```
1. (Planner) produce a concrete plan.
2. models(switch, modelId="<implementor>",
          message="Implement the plan above.")
```

## Session Lifecycle

The tools describe *what* each action does; these patterns cover *when* to combine them.

### Resume with intent

1. `sessions(search, keyword=..., scope="cwd")` — find the session; confirm with the user if multiple candidates match.
2. `sessions(resume, sessionFile=..., message="...")` — always pass `message` so the resumed session starts with a directive instead of waking up idle.

### Fork for experiments

When trying a risky alternative without polluting the main line:

1. `tree(list)` or `tree(search)` — find the user turn to branch from.
2. `tree(fork, entryId=..., message="try approach B")` — the fork gets its own session; the original branch stays clean.

### Cross-session handoff

A handoff is a transition plus a payload. The receiving session has no memory of the current one, so the `message` must carry everything it needs:

```
sessions(new, message="Context: <state summary>. Task: <next step>. Constraints: <...>")
```

Same applies to `resume` — summarize what happened here before switching there.

### Context self-regulation

React to `[pi-control] context=NN%` status lines instead of running until the wall:

- **70%** — finish the current scope; avoid opening new large files
- **85%** — `tree(compact)` with `customInstructions`, or hand off to a new session
- **95%** — stop; compact or hand off now, work done here may be lost

## Anti-Patterns

| Don't | Do |
|---|---|
| Review every small change | Review non-trivial or risky changes |
| Leave the session on the reviewer | End on the implementor |
| Switch models without a message | Always pass `message=` to drive the next turn |
| Resume/new/fork without a message | Pass `message=` so the target session starts with a directive |
| Hand off without context | Put state summary + task + constraints in the handoff message |
