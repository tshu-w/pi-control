import * as fs from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import { keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { clampLimit, scanSessions } from "./utils.js";
import { scheduleAction, hasPending } from "./command-actions.js";
import { renderCollapsed, renderToolCall } from "./render-call.js";
import { isOutputTruncated, styleToolOutput, withToolOutputContract } from "./tool-output.js";

export function registerSessionsRouter(pi: ExtensionAPI) {
	pi.registerTool(withToolOutputContract({
		name: "sessions",
		label: "Sessions",
		description: [
			"Manage Sessions: inspect state, search, resume, create, rename, queue user messages, or reload extensions and runtime.",
			"resume, new, and reload take effect after the current turn.",
			"resume and new replace the active Session and its context.",
		].join(" "),
		promptSnippet: "Manage Sessions",
		promptGuidelines: [
			"Use sessions(action='search') when the Session file to resume is unknown.",
			"Use sessions(action='resume') or sessions(action='new') for user-approved Session changes.",
			"Finish your turn after calling sessions with action='resume', 'new', or 'reload'.",
		],
		parameters: Type.Object({
			action: StringEnum(["info", "search", "resume", "new", "name", "queue_message", "reload"] as const, {
				description: "Action to perform",
			}),
			// resume params
			sessionFile: Type.Optional(Type.String({ description: "Full path to a Session .jsonl file for resume. Required for resume." })),
			// new params
			linkParent: Type.Optional(Type.Boolean({ description: "Link the current Session as parent when creating a new Session (default: true)." })),
			// name params
			name: Type.Optional(Type.String({ description: "Non-empty Session display name. Required for name." })),
			// queue_message params (also used as followUp for resume/new/reload)
			message: Type.Optional(Type.String({ description: "Non-empty user message. Required for queue_message; optional next-turn instruction for resume, new, or reload." })),
			deliverAs: Type.Optional(StringEnum(["steer", "followUp"] as const, { description: "Delivery mode for queue_message (default: followUp). followUp waits until the agent finishes; steer delivers after current tool calls, before the next model call." })),
			// search params
			keyword: Type.Optional(Type.String({ description: "Case-insensitive keyword for search." })),
			scope: Type.Optional(StringEnum(["cwd", "all"] as const, { description: "Search scope (default: cwd). cwd searches Sessions in the current working directory; all searches every Session." })),
			limit: Type.Optional(Type.Integer({ description: "Maximum search results (default: 10, max: 100).", minimum: 1, maximum: 100 })),
			offset: Type.Optional(Type.Integer({ description: "Number of search results to skip (default: 0).", minimum: 0 })),
		}),
		renderCall(args, theme, context) {
			return renderToolCall("sessions", args, theme, !context.isPartial);
		},
		renderResult(result, { expanded }, theme, context) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			const truncated = isOutputTruncated(result.details);
			if (context.isError) return new Text(theme.fg("error", text), 0, 0);
			if (expanded || context.args.action !== "search") {
				return new Text(styleToolOutput(text, truncated, theme), 0, 0);
			}

			const sections = text.split("\n\n");
			const records = sections.filter((section) => section.startsWith("- name="));
			if (records.length <= 5) return new Text(styleToolOutput(text, truncated, theme), 0, 0);

			return renderCollapsed(records.slice(5).join("\n\n"), (hidden) => {
				const visible = [sections[0]!, ...records.slice(0, 5)]
					.map((section) => theme.fg("toolOutput", section));
				visible.push(theme.fg("muted", `... (${hidden} more lines, ${keyText("app.tools.expand")} to expand)`));
				const footerSections = sections.filter((section) =>
					/^(?:\[Output truncated:|\[Showing |\[Line )/.test(section) || /^\[\d+ more results\./.test(section),
				);
				visible.push(...footerSections.map((section) => styleToolOutput(section, truncated, theme)));
				return new Text(visible.join("\n\n"), 0, 0);
			});
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				// ── info ─────────────────────────────────────────────
				case "info": {
					const model = ctx.model;
					const thinkingLevel = pi.getThinkingLevel();
					const usage = ctx.getContextUsage?.();
					const sessionFile = ctx.sessionManager.getSessionFile();
					const sessionName = ctx.sessionManager.getSessionName();
					const entries = ctx.sessionManager.getEntries();

					const lines: string[] = [];
					lines.push(`model: ${model ? `${model.provider}/${model.id}` : "none"}`);
					lines.push(`thinking: ${thinkingLevel}`);
					lines.push(`session: ${sessionName || "(unnamed)"}`);
					lines.push(`file: ${sessionFile || "(ephemeral)"}`);
					lines.push(`cwd: ${ctx.cwd}`);
					lines.push(`entries: ${entries.length}`);
					if (usage && typeof usage.tokens === "number") {
						lines.push(`context tokens: ${usage.tokens}/${usage.contextWindow}`);
					}

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: {
							model: model ? `${model.provider}/${model.id}` : null,
							thinkingLevel,
							sessionName: sessionName || null,
							sessionFile: sessionFile || null,
							cwd: ctx.cwd,
							entries: entries.length,
							usage,
						},
					};
				}

				// ── search ──────────────────────────────────────────
				case "search": {
					const limit = Math.max(1, clampLimit(params.limit, 10, 100));
					const scope = (params.scope ?? "cwd") as "cwd" | "all";
					const offset = clampLimit(params.offset, 0, Number.MAX_SAFE_INTEGER);
					const matches = await scanSessions(params.keyword, Infinity, signal, { scope, cwd: ctx.cwd });
					const total = matches.length;
					const results = matches.slice(offset, offset + limit);

					if (results.length === 0) {
						const match = params.keyword ? ` matching ${JSON.stringify(params.keyword)}` : "";
						return {
							content: [{ type: "text", text: total > 0
								? `No sessions at offset ${offset} (total: ${total}, scope: ${scope}).`
								: `No sessions found${match} (scope: ${scope}).` }],
							details: { results: [], scope, total, offset, limit },
						};
					}

					const records = results.map((result) => {
						let header = `- name=${JSON.stringify(result.name || "(unnamed)")}`;
						if (result.timestamp) header += ` timestamp=${result.timestamp}`;
						if (result.cwd) header += ` cwd=${JSON.stringify(result.cwd)}`;
						const lines = [header, `  sessionFile: ${JSON.stringify(result.file)}`];
						if (result.matchSnippets && result.matchSnippets.length > 0) {
							for (const snippet of result.matchSnippets) lines.push(`  match: ${JSON.stringify(snippet)}`);
						} else if (result.firstMessage) {
							lines.push(`  preview: ${JSON.stringify(result.firstMessage.slice(0, 150))}`);
						}
						return lines.join("\n");
					});

					const remaining = total - offset - results.length;
					const continuation = remaining > 0
						? `\n\n[${remaining} more results. Use offset=${offset + results.length} to continue.]`
						: "";
					return {
						content: [{ type: "text", text: `sessions (${results.length} returned)\n\n${records.join("\n\n")}${continuation}` }],
						details: {
							results: results.map(({ file, sessionId, timestamp, name, cwd }) => ({ sessionFile: file, sessionId, timestamp, name, cwd })),
							scope, total, offset, limit,
						},
					};
				}

				// ── resume ──────────────────────────────────────────
				case "resume": {
					if (params.message !== undefined && !params.message.trim()) {
						throw new Error("`message` must contain at least one non-whitespace character when provided.");
					}
					if (!params.sessionFile) {
						throw new Error("`sessionFile` is required for resume.");
					}
					if (!params.sessionFile.endsWith(".jsonl")) {
						throw new Error(`Session path is not a .jsonl file: ${params.sessionFile}`);
					}
					if (!fs.existsSync(params.sessionFile)) {
						throw new Error(`Session file not found: ${params.sessionFile}`);
					}
					if (!fs.statSync(params.sessionFile).isFile()) {
						throw new Error(`Session path is not a .jsonl file: ${params.sessionFile}`);
					}
					return scheduleAction(ctx, {
						fallbackHint: "Use built-in `/resume` instead.",
						action: { kind: "resume", file: params.sessionFile, message: params.message },
						successText: `Scheduled session switch to: ${params.sessionFile}${params.message ? " (with follow-up message)" : ""}.`,
						details: { scheduled: "resume", sessionFile: params.sessionFile, messageScheduled: params.message !== undefined },
					});
				}

				// ── new ─────────────────────────────────────────────
				case "new": {
					if (params.message !== undefined && !params.message.trim()) {
						throw new Error("`message` must contain at least one non-whitespace character when provided.");
					}
					const currentFile = ctx.sessionManager.getSessionFile();
					const linkParent = params.linkParent ?? true;
					const parentSession = linkParent ? currentFile ?? undefined : undefined;
					return scheduleAction(ctx, {
						fallbackHint: "Use built-in `/new` instead.",
						action: { kind: "new", parentSession, message: params.message },
						successText: `Scheduled new session creation${params.message ? " (with follow-up message)" : ""}.`,
						details: {
							scheduled: "new",
							linkParent,
							parentSession: parentSession ?? null,
							messageScheduled: params.message !== undefined,
						},
					});
				}

				// ── name ────────────────────────────────────────────
				case "name": {
					if (!params.name || !params.name.trim()) {
						throw new Error("`name` must contain at least one non-whitespace character.");
					}
					pi.setSessionName(params.name);
					return {
						content: [{ type: "text", text: `Session named: ${JSON.stringify(params.name)}` }],
						details: { name: params.name },
					};
				}

				// ── queue_message ────────────────────────────────────
				case "queue_message": {
					if (!params.message || !params.message.trim()) {
						throw new Error("`message` must contain at least one non-whitespace character.");
					}
					if (hasPending(ctx)) {
						throw new Error("A session transition is already scheduled. Use the transition's `message` parameter instead of queue_message.");
					}
					const deliverAs = params.deliverAs ?? "followUp";
					// Upstream limit: ExtensionAPI.sendUserMessage returns void (core
					// fire-and-forgets the prompt pipeline), so enqueueing cannot be
					// awaited or confirmed here. Failures surface as extension errors.
					pi.sendUserMessage(params.message, { deliverAs });
					return {
						content: [{ type: "text", text: `Message submitted as ${deliverAs}.` }],
						details: { deliverAs },
					};
				}

				// ── reload ───────────────────────────────────────────
				case "reload": {
					if (params.message !== undefined && !params.message.trim()) {
						throw new Error("`message` must contain at least one non-whitespace character when provided.");
					}
					return scheduleAction(ctx, {
						fallbackHint: "Use built-in `/reload` instead.",
						action: { kind: "reload", message: params.message },
						successText: `Scheduled runtime reload${params.message ? " (with follow-up message)" : ""}.`,
						details: { scheduled: "reload", messageScheduled: params.message !== undefined },
					});
				}

				default:
					throw new Error(`Unknown action: "${params.action}"`);
			}
		},
	}));
}
