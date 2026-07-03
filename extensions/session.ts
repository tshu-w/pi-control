import * as fs from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSessionsDir, scanSessions } from "./utils.js";
import { scheduleAction, hasPending } from "./command-actions.js";

export function registerSessionsRouter(pi: ExtensionAPI) {
	pi.registerTool({
		name: "sessions",
		label: "Sessions",
		description: [
			"Session management.",
			"info: current session details (model, tokens, cwd).",
			"search: find past sessions by keyword.",
			"resume: switch to a different session by file path (changes active session; current context will be lost).",
			"new: start a new session.",
			"name: set session display name.",
			"queue_message: queue a user message in the current session.",
			"reload: reload extensions and runtime after the current turn.",
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
			limit: Type.Optional(Type.Number({ description: "Max results. Default: 10. For search." })),
			scope: Type.Optional(StringEnum(["cwd", "all"] as const, { description: '"cwd" (default) limits search to sessions in the current working directory; "all" scans every session. For search.' })),
			// resume params
			sessionFile: Type.Optional(Type.String({ description: "Full path to session .jsonl file. For resume." })),
			// new params
			linkParent: Type.Optional(Type.Boolean({ description: "Link current session as parent. Default: true. For new." })),
			// name params
			name: Type.Optional(Type.String({ description: "Display name for the session. For name." })),
			// queue_message params (also used as followUp for resume/new/reload)
			message: Type.Optional(Type.String({ description: "Message content delivered as a user message. For queue_message: the queued body. For resume/new/reload: a next-turn directive." })),
			deliverAs: Type.Optional(StringEnum(["steer", "followUp"] as const, { description: '"followUp" (default) or "steer". For queue_message.' })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			switch (params.action) {
				// ── info ─────────────────────────────────────────────
				case "info": {
					const model = ctx.model;
					const usage = ctx.getContextUsage?.();
					const sessionFile = ctx.sessionManager.getSessionFile();
					const sessionName = ctx.sessionManager.getSessionName();
					const entries = ctx.sessionManager.getEntries();

					const lines: string[] = [];
					lines.push(`model: ${model ? `${model.provider}/${model.id}` : "none"}`);
					lines.push(`thinking: ${pi.getThinkingLevel()}`);
					lines.push(`session: ${sessionName || "(unnamed)"}`);
					lines.push(`file: ${sessionFile || "(ephemeral)"}`);
					lines.push(`cwd: ${ctx.cwd}`);
					lines.push(`entries: ${entries.length}`);
					if (usage && typeof usage.tokens === "number") {
						lines.push(`context tokens: ${usage.tokens}/${usage.contextWindow}`);
					}

					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { model: model ? `${model.provider}/${model.id}` : null, usage },
					};
				}

				// ── search ──────────────────────────────────────────
				case "search": {
					const limit = Math.max(0, Math.trunc(params.limit ?? 10));
					const scope = (params.scope ?? "cwd") as "cwd" | "all";
					const results = await scanSessions(params.keyword, limit, signal, { scope, cwd: ctx.cwd });

					if (results.length === 0) {
						return {
							content: [{ type: "text", text: `No sessions found${params.keyword ? ` matching "${params.keyword}"` : ""} (scope: ${scope}). Sessions dir: ${getSessionsDir()}` }],
							details: { results: [], scope },
						};
					}

					const lines = results.map((r, i) => {
						const parts = [`${i + 1}. ${r.name || "(unnamed)"}`];
						parts.push(`   File: \`${r.file}\``);
						if (r.timestamp) parts.push(`   Time: ${r.timestamp}`);
						if (r.cwd) parts.push(`   CWD: ${r.cwd}`);
						if (r.matchSnippets && r.matchSnippets.length > 0) {
							for (const s of r.matchSnippets) parts.push(`   Match: ${s}`);
						} else if (r.firstMessage) {
							parts.push(`   Preview: ${r.firstMessage.slice(0, 150)}`);
						}
						return parts.join("\n");
					});

					return {
						content: [{ type: "text", text: lines.join("\n\n") + "\n\nUse sessions(action='resume', sessionFile=...) to switch." }],
						details: { results, scope },
					};
				}

				// ── resume ──────────────────────────────────────────
				case "resume": {
					if (!params.sessionFile) {
						return { content: [{ type: "text", text: "`sessionFile` is required for resume." }], details: {} };
					}
					if (!fs.existsSync(params.sessionFile)) {
						return { content: [{ type: "text", text: `Session file not found: ${params.sessionFile}` }], details: {} };
					}
					return scheduleAction({
						fallbackHint: "Use built-in `/resume` instead.",
						action: { kind: "resume", file: params.sessionFile!, message: params.message },
						successText: `Scheduled session switch to: ${params.sessionFile}${params.message ? " (with followUp message)" : ""}`,
						details: { scheduled: "resume", sessionFile: params.sessionFile, message: params.message },
					});
				}

				// ── new ─────────────────────────────────────────────
				case "new": {
					const currentFile = ctx.sessionManager.getSessionFile();
					const parentSession = (params.linkParent ?? true) ? currentFile ?? undefined : undefined;
					return scheduleAction({
						fallbackHint: "Use built-in `/new` instead.",
						action: { kind: "new", parentSession, message: params.message },
						successText: `Scheduled new session creation${params.message ? " (with followUp message)" : ""}.`,
						details: { scheduled: "new", message: params.message },
					});
				}

				// ── name ────────────────────────────────────────────
				case "name": {
					if (!params.name) {
						return { content: [{ type: "text", text: "`name` is required for name." }], details: {} };
					}
					pi.setSessionName(params.name);
					return {
						content: [{ type: "text", text: `Session named: "${params.name}"` }],
						details: {},
					};
				}

				// ── queue_message ────────────────────────────────────
				case "queue_message": {
					if (!params.message) {
						return { content: [{ type: "text", text: "`message` is required for queue_message." }], details: {} };
					}
					if (hasPending()) {
						return { content: [{ type: "text", text: "A session transition is already scheduled. Use the transition's `message` parameter instead of queue_message." }], details: {} };
					}
					const deliverAs = params.deliverAs ?? "followUp";
					await pi.sendUserMessage(params.message, { deliverAs });
					return {
						content: [{ type: "text", text: `Message queued as ${deliverAs}.` }],
						details: { deliverAs },
					};
				}

				// ── reload ───────────────────────────────────────────
				case "reload": {
					return scheduleAction({
						fallbackHint: "Use built-in `/reload` instead.",
						action: { kind: "reload", message: params.message },
						successText: `Scheduled runtime reload${params.message ? " (with followUp message)" : ""}.`,
						details: { scheduled: "reload", message: params.message },
					});
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: "${params.action}"` }], details: {} };
			}
		},
	});
}
