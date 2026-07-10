/**
 * Commands router — dispatch arbitrary third-party slash commands as tool calls.
 *
 * pi exposes `getRegisteredCommands()` / `createCommandContext()` on ExtensionRunner.
 * We list them via `commands(action="list")` and invoke them via `commands(action="run")`.
 *
 * Safety model (capability mediation, not source-based deny lists):
 *
 *   1. The five session-transition closures on ExtensionCommandContext
 *      (newSession / fork / switchSession / navigateTree / reload) are wrapped.
 *      A handler calling them schedules a deferred raw op (executed on
 *      agent_settled, reusing the existing pi-control queue) and
 *      throws DeferredTransitionRequested to unwind the handler — so it cannot
 *      keep running under the false assumption that the session was replaced.
 *
 *   2. ui.notify / ui.setStatus are captured into the tool result so the LLM
 *      can see what the command actually did. Without this the model would
 *      see an empty result for commands like /ssh which only notify.
 *
 *   3. ui.select / ui.confirm / ui.input throw InteractiveUIUnavailable when
 *      !ctx.hasUI. We do NOT fall through to noOpUIContext: a noop return
 *      could trick handlers into "user cancelled" branches that perform half
 *      a cleanup before throwing.
 *
 * Result statuses surfaced to the model:
 *   - completed              — handler returned normally
 *   - scheduled_transition   — handler scheduled a session transition (deferred)
 *   - interactive_unavailable — handler needed UI we cannot provide
 *   - busy                   — another deferred action is already queued
 *   - failed                 — handler threw
 *
 * What we deliberately do NOT do in v1:
 *   - timeout-as-cancel (Promise.race does not actually cancel)
 *   - static allow/deny by sourceInfo (use capability mediation instead)
 *   - re-entrancy serialization beyond the existing single-slot queue
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getRunner, getOps, scheduleRawOp, clearPendingRawOp } from "./command-actions.js";

class DeferredTransitionRequested extends Error {
	constructor(public op: string, public schedulingError?: string) {
		super(`deferred:${op}`);
	}
}

class InteractiveUIUnavailable extends Error {
	constructor(public method: string) {
		super(`Interactive UI unavailable: ${method} requires a real TTY`);
	}
}

interface Capture {
	notifications: Array<{ level: "info" | "warning" | "error"; message: string }>;
	statusUpdates: Array<{ key: string; text: string | undefined }>;
}

interface MediatedContext {
	ctx: any;
	clearOwnPendingRawOp(): boolean;
}

/**
 * Wrap a real ExtensionCommandContext so that:
 *   - the five session-transition methods reschedule + throw
 *   - ui.notify/setStatus are captured
 *   - ui.select/confirm/input throw if no real UI
 *
 * We construct via Object.create so the underlying ctx remains functional for
 * any property we did not override (cwd, sessionManager, exec, etc.).
 */
function mediateCtx(ctx: any, capture: Capture): MediatedContext {
	const ops = getOps();
	const hasUI: boolean = !!ctx?.hasUI;
	let rawOpToken: symbol | null = null;

	const scheduleTransition = (op: string, runner: () => Promise<{ cancelled?: boolean } | void>): never => {
		// `ops` should be non-null when we're here (the patch is what wired ctx in
		// the first place), but be defensive: report through the sentinel path.
		if (!ops) {
			throw new DeferredTransitionRequested(op, "command ops unavailable");
		}
		const result = scheduleRawOp(op, async () => { await runner(); });
		if (!result.ok) {
			throw new DeferredTransitionRequested(op, result.reason);
		}
		rawOpToken = result.token;
		// Synchronous throw is intentional: even handlers that forget to `await`
		// ctx.newSession()/fork()/... must stop immediately.
		throw new DeferredTransitionRequested(op);
	};

	const mediatedUI = Object.create(ctx.ui ?? null);
	mediatedUI.notify = (message: string, type: "info" | "warning" | "error" = "info") => {
		capture.notifications.push({ level: type, message });
		// Also forward to real UI if present — users still want to see it.
		if (hasUI && typeof ctx.ui?.notify === "function") {
			try { ctx.ui.notify(message, type); } catch { /* best-effort */ }
		}
	};
	mediatedUI.setStatus = (key: string, text: string | undefined) => {
		capture.statusUpdates.push({ key, text });
		if (typeof ctx.ui?.setStatus === "function") {
			try { ctx.ui.setStatus(key, text); } catch { /* best-effort */ }
		}
	};
	mediatedUI.select = async (...args: any[]) => {
		if (!hasUI) throw new InteractiveUIUnavailable("ui.select");
		return ctx.ui.select(...args);
	};
	mediatedUI.confirm = async (...args: any[]) => {
		if (!hasUI) throw new InteractiveUIUnavailable("ui.confirm");
		return ctx.ui.confirm(...args);
	};
	mediatedUI.input = async (...args: any[]) => {
		if (!hasUI) throw new InteractiveUIUnavailable("ui.input");
		return ctx.ui.input(...args);
	};
	mediatedUI.custom = async (...args: any[]) => {
		if (!hasUI) throw new InteractiveUIUnavailable("ui.custom");
		return ctx.ui.custom(...args);
	};
	mediatedUI.editor = async (...args: any[]) => {
		if (!hasUI) throw new InteractiveUIUnavailable("ui.editor");
		return ctx.ui.editor(...args);
	};

	const mediated: any = Object.create(ctx);
	// IMPORTANT: ExtensionContext exposes `ui` as a getter on its prototype —
	// plain assignment via `mediated.ui = ...` throws "only a getter".
	// defineProperty on the wrapper installs an own data property that shadows
	// the prototype's getter. Use the same uniform path for the five session-
	// transition methods so overrides always win.
	const override = (name: string, value: any) => {
		Object.defineProperty(mediated, name, { value, writable: true, configurable: true, enumerable: true });
	};
	override("ui", mediatedUI);
	override("newSession", (opts?: any) => scheduleTransition("newSession", () => ops!.newSession(opts)));
	override("fork", (entryId: string, opts?: any) => scheduleTransition("fork", () => ops!.fork(entryId, opts)));
	override("switchSession", (sessionPath: string, opts?: any) => scheduleTransition("switchSession", () => ops!.switchSession(sessionPath, opts)));
	override("navigateTree", (targetId: string, opts?: any) => scheduleTransition("navigateTree", () => ops!.navigateTree(targetId, opts)));
	override("reload", () => scheduleTransition("reload", () => ops!.reload()));
	return {
		ctx: mediated,
		clearOwnPendingRawOp: () => rawOpToken !== null && clearPendingRawOp(rawOpToken),
	};
}

function renderResult(
	status: string,
	command: string,
	args: string,
	capture: Capture,
	extra: { scheduled?: { op: string; reason?: string }; error?: string } = {},
): { content: Array<{ type: "text"; text: string }>; details: Record<string, any> } {
	const lines: string[] = [];
	lines.push(`Command: /${command}${args ? " " + args : ""}`);
	lines.push(`Status: ${status}`);
	if (extra.scheduled) {
		lines.push(`Scheduled transition: ${extra.scheduled.op}`);
		if (extra.scheduled.reason) lines.push(`  (note: ${extra.scheduled.reason})`);
	}
	if (extra.error) lines.push(`Error: ${extra.error}`);
	if (capture.notifications.length > 0) {
		lines.push("Notifications:");
		for (const n of capture.notifications) lines.push(`  [${n.level}] ${n.message}`);
	}
	if (capture.statusUpdates.length > 0) {
		lines.push("Status updates:");
		for (const s of capture.statusUpdates) lines.push(`  ${s.key} = ${s.text === undefined ? "<cleared>" : s.text}`);
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			command,
			args,
			status,
			notifications: capture.notifications,
			statusUpdates: capture.statusUpdates,
			...(extra.scheduled ? { scheduledTransition: extra.scheduled } : {}),
			...(extra.error ? { error: extra.error } : {}),
		},
	};
}

export function registerCommandsRouter(pi: ExtensionAPI) {
	pi.registerTool({
		name: "commands",
		label: "Commands",
		description: [
			"Invoke arbitrary third-party slash commands (e.g. /ssh, /uv) as tool calls.",
			"list: enumerate all registered slash commands (name, description, source).",
			"run: execute a slash command by name with optional argument string.",
			"For pi-control's own routes (sessions/tree/models), use those tools directly — they offer structured args and safer scheduling.",
		].join(" "),
		promptSnippet: "Third-party slash commands: list, run",
		promptGuidelines: [
			"Use commands(action='list') to discover what slash commands the user's extensions registered.",
			"Use commands(action='run', name, args?) to invoke one. Args is a single string passed verbatim to the handler (the same way `/cmd args...` would).",
			"If status='scheduled_transition', the handler asked to switch session/fork/reload; it will happen after this turn.",
			"If status='interactive_unavailable', the command needs a TTY and cannot run from a tool call.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "run"] as const, { description: "Action to perform" }),
			name: Type.Optional(Type.String({ description: "Command invocation name (without leading slash). For run." })),
			args: Type.Optional(Type.String({ description: "Argument string passed verbatim to the handler. For run. Default: empty." })),
			filter: Type.Optional(Type.String({ description: "Substring filter on name or description. For list." })),
		}),
		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const runner = getRunner();
			if (!runner) {
				return {
					content: [{ type: "text", text: "Commands router unavailable: ExtensionRunner not captured (pi-control patch inactive)." }],
					details: { status: "unavailable", error: "runner-unavailable" },
				};
			}

			switch (params.action) {
				case "list": {
					const all = runner.getRegisteredCommands() as Array<{
						invocationName: string;
						name: string;
						description?: string;
						sourceInfo: { path: string; source: string; scope: string };
					}>;
					const filter = (params.filter ?? "").toLowerCase();
					const filtered = filter
						? all.filter(c =>
							c.invocationName.toLowerCase().includes(filter) ||
							(c.description ?? "").toLowerCase().includes(filter))
						: all;

					if (filtered.length === 0) {
						return {
							content: [{ type: "text", text: filter ? `No commands match "${filter}".` : "No third-party slash commands registered." }],
							details: { commands: [] },
						};
					}

					const lines = filtered.map(c => {
						const parts = [`/${c.invocationName}`];
						if (c.description) parts.push(`— ${c.description}`);
						parts.push(`(${c.sourceInfo.source})`);
						return parts.join(" ");
					});
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: {
							commands: filtered.map(c => ({
								invocationName: c.invocationName,
								name: c.name,
								description: c.description,
								source: c.sourceInfo.source,
								path: c.sourceInfo.path,
								scope: c.sourceInfo.scope,
							})),
						},
					};
				}

				case "run": {
					const name = (params.name ?? "").trim();
					const args = params.args ?? "";
					if (!name) {
						return {
							content: [{ type: "text", text: "Missing required parameter: name." }],
							details: { error: "missing-name" },
						};
					}
					const cmd = runner.getCommand(name);
					if (!cmd) {
						const available = (runner.getRegisteredCommands() as any[]).map(c => c.invocationName);
						return {
							content: [{ type: "text", text: `No command named "${name}". Available: ${available.length ? available.join(", ") : "(none)"}.` }],
							details: { error: "not-found", name, available },
						};
					}

					const realCtx = runner.createCommandContext();
					const capture: Capture = { notifications: [], statusUpdates: [] };

					let mediated: MediatedContext | null = null;
					try {
						mediated = mediateCtx(realCtx, capture);
						await cmd.handler(args, mediated.ctx);
						// Defensive: handler may have caught DeferredTransitionRequested and
						// resumed normally. Letting its queued transition fire on agent_settled
						// would surprise the model, so cancel only the rawOp scheduled by
						// this command run (never another router's pending action).
						if (mediated.clearOwnPendingRawOp()) {
							capture.notifications.push({
								level: "warning",
								message: "Handler swallowed a scheduled session transition; transition cancelled.",
							});
						}
						return renderResult("completed", name, args, capture);
					} catch (e) {
						if (e instanceof DeferredTransitionRequested) {
							if (e.schedulingError) {
								return renderResult("busy", name, args, capture, {
									scheduled: { op: e.op, reason: e.schedulingError },
								});
							}
							return renderResult("scheduled_transition", name, args, capture, {
								scheduled: { op: e.op },
							});
						}
						// Non-sentinel throw: if this command queued a transition before
						// throwing, drop it. Partial mid-flight state is not safe to apply.
						if (mediated?.clearOwnPendingRawOp()) {
							capture.notifications.push({
								level: "warning",
								message: "Handler threw after scheduling a transition; pending transition cancelled.",
							});
						}
						if (e instanceof InteractiveUIUnavailable) {
							return renderResult("interactive_unavailable", name, args, capture, {
								error: e.message,
							});
						}
						return renderResult("failed", name, args, capture, {
							error: e instanceof Error ? `${e.message}` : String(e),
						});
					}
				}
			}

			return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
		},
	});
}
