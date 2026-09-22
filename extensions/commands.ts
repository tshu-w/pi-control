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
 *      see an empty result for commands like /ssh which only notify. Captured
 *      notifications are not also forwarded to the UI, which would display
 *      the same message twice alongside the tool result.
 *
 *   3. ui.select / ui.confirm / ui.input throw InteractiveUIUnavailable when
 *      !ctx.hasUI. We do NOT fall through to noOpUIContext: a noop return
 *      could trick handlers into "user cancelled" branches that perform half
 *      a cleanup before throwing.
 *
 * Successful result statuses surfaced to the model:
 *   - completed            — handler returned normally
 *   - scheduled_transition — handler scheduled a session transition (deferred)
 *
 * Missing capabilities, invalid requests, scheduling conflicts, and handler
 * failures throw tool errors so Pi and custom renderers display them as errors.
 *
 * What we deliberately do NOT do in v1:
 *   - timeout-as-cancel (Promise.race does not actually cancel)
 *   - static allow/deny by sourceInfo (use capability mediation instead)
 *   - re-entrancy serialization beyond the existing single-slot queue
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getRunner, getOps, scheduleRawOp, clearPendingRawOp } from "./command-actions.js";
import { renderCollapsed, renderToolCall } from "./render-call.js";
import { clampLimit } from "./utils.js";
import { isOutputTruncated, styleToolOutput, withToolOutputContract } from "./tool-output.js";

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

const MAX_CAPTURE_ITEMS = 100;

interface Capture {
	notifications: Array<{ level: "info" | "warning" | "error"; message: string }>;
	statusUpdates: Array<{ key: string; text: string | undefined }>;
}

interface MediatedContext {
	ctx: any;
	clearOwnPendingRawOp(): boolean;
	getTransitionRequest(): DeferredTransitionRequested | null;
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
	const ops = getOps(ctx);
	const hasUI: boolean = !!ctx?.hasUI;
	let rawOpToken: symbol | null = null;
	let transitionRequest: DeferredTransitionRequested | null = null;

	const scheduleTransition = (op: string, runner: () => Promise<{ cancelled?: boolean } | void>): never => {
		// `ops` should be non-null when we're here (the patch is what wired ctx in
		// the first place), but be defensive: report through the sentinel path.
		if (!ops) {
			transitionRequest = new DeferredTransitionRequested(op, "command ops unavailable");
			throw transitionRequest;
		}
		const result = scheduleRawOp(ctx, op, runner);
		if (!result.ok) {
			transitionRequest = new DeferredTransitionRequested(op, result.reason);
			throw transitionRequest;
		}
		rawOpToken = result.token;
		// Synchronous throw is intentional: even handlers that forget to `await`
		// ctx.newSession()/fork()/... must stop immediately.
		transitionRequest = new DeferredTransitionRequested(op);
		throw transitionRequest;
	};

	const mediatedUI = Object.create(ctx.ui ?? null);
	mediatedUI.notify = (message: string, type: "info" | "warning" | "error" = "info") => {
		if (capture.notifications.length < MAX_CAPTURE_ITEMS) {
			capture.notifications.push({ level: type, message: String(message) });
		}
	};
	mediatedUI.setStatus = (key: string, text: string | undefined) => {
		if (capture.statusUpdates.length < MAX_CAPTURE_ITEMS) {
			capture.statusUpdates.push({ key: String(key), text: text === undefined ? undefined : String(text) });
		}
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
		clearOwnPendingRawOp: () => rawOpToken !== null && clearPendingRawOp(ctx, rawOpToken),
		getTransitionRequest: () => transitionRequest,
	};
}

function renderResult(
	status: string,
	command: string,
	args: string,
	capture: Capture,
	extra: { scheduled?: { op: string; reason?: string }; error?: string } = {},
): { content: Array<{ type: "text"; text: string }>; details: Record<string, any> } {
	if (status === "completed") {
		const messages = capture.notifications.map((notification) =>
			notification.level === "info" ? notification.message : `[${notification.level}] ${notification.message}`,
		);
		return {
			content: [{ type: "text", text: messages.join("\n") || `/${command}${args ? " " + args : ""} completed.` }],
			details: { status },
		};
	}

	const lines = [`/${command}${args ? " " + args : ""}: ${status}`];
	if (extra.scheduled) {
		if (status === "scheduled_transition") {
			lines[0] = `/${command}${args ? " " + args : ""}: ${extra.scheduled.op} scheduled after the current turn.`;
		} else {
			lines.push(`Scheduled transition: ${extra.scheduled.op}`);
		}
		if (extra.scheduled.reason) lines.push(`  (note: ${extra.scheduled.reason})`);
	}
	if (extra.error) lines.push(`Error: ${extra.error}`);
	for (const notification of capture.notifications) {
		lines.push(notification.level === "info" ? notification.message : `[${notification.level}] ${notification.message}`);
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			status,
			...(extra.scheduled ? { scheduledTransition: { op: extra.scheduled.op } } : {}),
		},
	};
}

function throwCommandResult(result: ReturnType<typeof renderResult>, cause: unknown): never {
	throw new Error(result.content[0]?.text ?? "Command failed.", { cause });
}

export function registerCommandsRouter(pi: ExtensionAPI) {
	pi.registerTool(withToolOutputContract({
		name: "commands",
		label: "Commands",
		description: "List and run registered extension slash commands.",
		promptSnippet: "List and run registered extension slash commands",
		promptGuidelines: [
			"Use commands(action='list') when the command name is unknown or ambiguous.",
			"Use sessions, tree, and models directly for their respective operations.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "run"] as const, { description: "Action to perform" }),
			name: Type.Optional(Type.String({ description: "Command name for run, without the leading slash. Required for run." })),
			args: Type.Optional(Type.String({ description: "Argument string for run, passed verbatim to the command handler (default: empty)." })),
			filter: Type.Optional(Type.String({ description: "Case-insensitive substring filter on command names and descriptions for list." })),
			limit: Type.Optional(Type.Integer({ description: "Maximum results for list (default: 20, max: 200).", minimum: 1, maximum: 200, default: 20 })),
			offset: Type.Optional(Type.Integer({ description: "Number of filtered results to skip for list (default: 0).", minimum: 0, default: 0 })),
		}),
		renderCall(args, theme, context) {
			return renderToolCall("commands", args, theme, !context.isPartial);
		},
		renderResult(result, { expanded }, theme, context) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			const truncated = isOutputTruncated(result.details);
			if (context.isError) return new Text(theme.fg("error", text), 0, 0);
			if (expanded) return new Text(styleToolOutput(text, truncated, theme), 0, 0);

			if (context.args.action === "list") {
				const lines = text.split("\n");
				const commandLines = lines.filter((line) => line.startsWith("/"));
				if (commandLines.length <= 20) return new Text(styleToolOutput(text, truncated, theme), 0, 0);

				const footerLines = lines.slice(lines.lastIndexOf(commandLines.at(-1)!) + 1).filter(Boolean);
				return renderCollapsed(commandLines.slice(20).join("\n"), (hidden) => {
					const visible = [
						...commandLines.slice(0, 20).map((line) => theme.fg("toolOutput", line)),
						"",
						theme.fg("muted", `... (${hidden} more lines, ${keyText("app.tools.expand")} to expand)`),
					];
					if (footerLines.length > 0) visible.push("", ...footerLines.map((line) => styleToolOutput(line, truncated, theme)));
					return new Text(visible.join("\n"), 0, 0);
				});
			}

			if (context.args.action === "run") {
				const footerStart = truncated ? Math.max(text.lastIndexOf("\n\n[Output truncated:"), text.lastIndexOf("\n\n[Showing "), text.lastIndexOf("\n\n[Line ")) : -1;
				const bodyEnd = footerStart >= 0 ? footerStart : text.length;
				const lines = text.slice(0, bodyEnd).split("\n");
				while (lines.at(-1) === "") lines.pop();
				if (lines.length <= 15) return new Text(styleToolOutput(text, truncated, theme), 0, 0);

				return renderCollapsed(lines.slice(15).join("\n"), (hidden) => {
					const visible = [
						...lines.slice(0, 15).map((line) => theme.fg("toolOutput", line)),
						"",
						theme.fg("muted", `... (${hidden} more lines, ${keyText("app.tools.expand")} to expand)`),
					];
					if (footerStart >= 0) visible.push("", styleToolOutput(text.slice(footerStart + 2), true, theme));
					return new Text(visible.join("\n"), 0, 0);
				});
			}

			return new Text(styleToolOutput(text, truncated, theme), 0, 0);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const runner = getRunner(ctx);
			if (!runner) {
				throw new Error("Commands router unavailable: ExtensionRunner not captured (pi-control patch inactive).");
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

					const limit = Math.max(1, clampLimit(params.limit, 20, 200));
					const offset = clampLimit(params.offset, 0, Number.MAX_SAFE_INTEGER);
					const total = filtered.length;
					const page = filtered.slice(offset, offset + limit);

					if (page.length === 0) {
						return {
							content: [{ type: "text", text: total > 0
								? `No commands at offset ${offset} (total: ${total}).`
								: filter ? `No commands match "${filter}".` : "No third-party slash commands registered." }],
							details: { total, offset, limit, commands: [] },
						};
					}

					const lines = page.map(c => {
						const parts = [`/${c.invocationName}`];
						if (c.description) parts.push(`— ${c.description}`);
						parts.push(`(${c.sourceInfo.source})`);
						return parts.join(" ");
					});
					const remaining = total - offset - page.length;
					const continuation = remaining > 0
						? `\n\n[${remaining} more results. Use offset=${offset + page.length} to continue.]`
						: "";
					return {
						content: [{ type: "text", text: lines.join("\n") + continuation }],
						details: {
							total, offset, limit,
							commands: page.map(c => ({
								invocationName: c.invocationName,
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
						throw new Error("Missing required parameter: name.");
					}
					const cmd = runner.getCommand(name);
					if (!cmd) {
						throw new Error(`No command named "${name}". Use commands(action="list") to see available commands.`);
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
						const swallowedTransition = mediated.getTransitionRequest();
						if (swallowedTransition) {
							if (mediated.clearOwnPendingRawOp()) {
								throw new Error("Handler swallowed a scheduled session transition; transition cancelled.");
							}
							throw swallowedTransition;
						}
						return renderResult("completed", name, args, capture);
					} catch (e) {
						if (e instanceof DeferredTransitionRequested) {
							if (e.schedulingError) {
								throwCommandResult(renderResult("busy", name, args, capture, {
									scheduled: { op: e.op, reason: e.schedulingError },
								}), e);
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
							throwCommandResult(renderResult("interactive_unavailable", name, args, capture, {
								error: e.message,
							}), e);
						}
						throwCommandResult(renderResult("failed", name, args, capture, {
							error: e instanceof Error ? `${e.message}` : String(e),
						}), e);
					}
				}
			}

			throw new Error(`Unknown action: ${params.action}`);
		},
	}, {
		tempPrefix: "pi-control-command",
	}));
}
