import * as fs from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import { keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { clampLimit, scanSessions } from "./utils.js";
import { scheduleAction, hasPending } from "./command-actions.js";
import { renderToolCall } from "./render-call.js";
import { withToolOutputContract } from "./tool-output.js";

export function registerSessionsRouter(pi: ExtensionAPI) {
	pi.registerTool(withToolOutputContract({
		name: "sessions",
		label: "Sessions",
		description: [
			"Session management. resume, new, and reload take effect after the current turn.",
			"info: current session details (model, tokens, cwd).",
			"search: find or list past sessions.",
			"resume: switch to a different session by file path (changes active session; current context will be lost).",
			"new: start a new session.",
			"name: set session display name.",
			"queue_message: queue a user message in the current session.",
			"reload: reload extensions and runtime.",
		].join(" "),
		promptSnippet: "Manage pi runtime sessions",
		promptGuidelines: [
			"Use sessions(action='search') to find past sessions, then sessions(action='resume', sessionFile=...) to switch.",
			"Ask before resume or new unless the user explicitly requested it; they change the active session.",
			"Use sessions(action='queue_message') to send a follow-up user message in the current session.",
			"Pass message= to resume/new/reload to send a follow-up user message after the transition.",
			"Use sessions(action='info') to check the current model, token usage, cwd, and session file.",
		],
		parameters: Type.Object({
			action: StringEnum(["info", "search", "resume", "new", "name", "queue_message", "reload"] as const, {
				description: "Action to perform",
			}),
			// search params
			keyword: Type.Optional(Type.String({ description: "Search keyword (case-insensitive). For search." })),
			limit: Type.Optional(Type.Integer({ description: "Max results. Default: 10, maximum: 100. For search.", minimum: 1, maximum: 100 })),
			scope: Type.Optional(StringEnum(["cwd", "all"] as const, { description: '"cwd" (default) limits search to sessions in the current working directory; "all" scans every session. For search.' })),
			// resume params
			sessionFile: Type.Optional(Type.String({ description: "Full path to session .jsonl file. For resume." })),
			// new params
			linkParent: Type.Optional(Type.Boolean({ description: "Link current session as parent. Default: true. For new." })),
			// name params
			name: Type.Optional(Type.String({ description: "Display name for the session. For name." })),
			// queue_message params (also used as followUp for resume/new/reload)
			message: Type.Optional(Type.String({ description: "Message content delivered as a user message. For queue_message: the queued body. For resume/new/reload: a next-turn directive." })),
			deliverAs: Type.Optional(StringEnum(["steer", "followUp"] as const, { description: 'Delivery mode. "followUp" (default) waits until the agent finishes; "steer" delivers after the current assistant turn\'s tool calls, before the next model call. For queue_message.' })),
		}),
		renderCall(args, theme, context) {
			return renderToolCall("sessions", args, theme, !context.isPartial);
		},
		renderResult(result, { expanded }, theme, context) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			if (context.isError) return new Text(theme.fg("error", text), 0, 0);
			if (expanded || context.args.action !== "search") {
				return new Text(theme.fg("toolOutput", text), 0, 0);
			}

			const sections = text.split("\n\n");
			const records = sections.filter((section) => section.startsWith("- name="));
			if (records.length <= 5) return new Text(theme.fg("toolOutput", text), 0, 0);

			const visible = [sections[0]!, ...records.slice(0, 5)]
				.map((section) => theme.fg("toolOutput", section));
			const hidden = records.length - 5;
			visible.push(theme.fg("dim", `... (${hidden} session${hidden === 1 ? "" : "s"} hidden, ${keyText("app.tools.expand")} to expand)`));
			const footerSections = sections.filter((section) =>
				section.startsWith("[Use sessions(") || section.startsWith("[Output truncated:"),
			);
			visible.push(...footerSections.map((section) => theme.fg("toolOutput", section)));
			return new Text(visible.join("\n\n"), 0, 0);
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
					const results = await scanSessions(params.keyword, limit, signal, { scope, cwd: ctx.cwd });

					if (results.length === 0) {
						const match = params.keyword ? ` matching ${JSON.stringify(params.keyword)}` : "";
						return {
							content: [{ type: "text", text: `No sessions found${match} (scope: ${scope}).` }],
							details: { results: [], scope },
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

					return {
						content: [{ type: "text", text: `sessions (${results.length} returned)\n\n${records.join("\n\n")}\n\n[Use sessions(action="resume", sessionFile=...) to switch.]` }],
						details: {
							results: results.map(({ file, sessionId, timestamp, name, cwd }) => ({ sessionFile: file, sessionId, timestamp, name, cwd })),
							scope,
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
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	}));
}
