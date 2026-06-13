/**
 * Pi Control — self-control layer for pi.
 *
 * 4 router tools, always active:
 *   sessions  — session management (info, search, resume, new, name, queue_message, reload)
 *   tree      — session entry operations (list, search, labels, set_label, navigate, fork, compact)
 *   models    — model listing, switching, and consultation
 *   commands  — dispatch arbitrary third-party slash commands (e.g. /ssh, /uv) as tool calls
 *
 * Also registers a context event hook that injects a runtime status line
 * only on significant state changes (model switch, context/tool threshold
 * crossings), not every turn — preserving prompt cache across providers.
 *
 * Uses a private API hack to capture command-only closures from
 * ExtensionRunner.prototype.bindCommandContext, then executes
 * pending session/navigation actions after agent_end + setTimeout(0).
 * Upstream equivalent: pi.runWhenIdle() (#2023).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchBindCommandContext, runPending, clearPending, isArmed, hasPending } from "./command-actions.js";
import { registerSessionsRouter } from "./session.js";
import { registerTreeRouter } from "./tree.js";
import { registerModelsRouter } from "./model.js";
import { registerCommandsRouter } from "./commands.js";

// ── Event-driven status injection state ──
let lastModel: string | null = null;
let lastContextBucket: string | null = null;
function contextBucket(pct: number): string | null {
	if (pct >= 95) return "critical";
	if (pct >= 85) return "very-high";
	if (pct >= 70) return "high";
	return null;
}

export default function (pi: ExtensionAPI) {
	// Patch ExtensionRunner to auto-capture command context actions.
	const patchOk = patchBindCommandContext();

	registerSessionsRouter(pi);
	registerTreeRouter(pi);
	registerModelsRouter(pi);
	registerCommandsRouter(pi);

	// ── Context event: inject runtime status only on state changes ──
	// Fires on: model switch (incl. first turn), context/tool threshold crossings.
	// Skips injection on most turns to preserve prompt cache.
	pi.on("context", async (event, ctx) => {
		const messages = event.messages;
		if (!messages || messages.length === 0) return;

		const currentModel = ctx.model;
		if (!currentModel) return;

		const modelId = `${currentModel.provider}/${currentModel.id}`;
		const usage = ctx.getContextUsage?.();
		const ctxPct = (usage && typeof usage.percent === "number") ? Math.min(100, Math.round(usage.percent)) : 0;

		// ── Determine what changed ──
		const reasons: string[] = [];

		if (modelId !== lastModel) {
			reasons.push(`model=${modelId}`);
			lastModel = modelId;
		}

		const cb = contextBucket(ctxPct);
		if (cb && cb !== lastContextBucket) {
			reasons.push(`context=${ctxPct}% (${cb})`);
		}
		lastContextBucket = cb;

		// Nothing changed — skip injection entirely.
		if (reasons.length === 0) return;

		const statusMsg = {
			role: "custom",
			customType: "pi-status",
			content: `[pi-control] ${reasons.join(" | ")}`,
			display: false,
			timestamp: Date.now(),
		} as any;

		// Append to last user message content instead of inserting a new message,
		// so no extra "ghost" user message enters history.
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as any;
			if (msg.role === "user") {
				if (typeof msg.content === "string") {
					msg.content += `\n\n${statusMsg.content}`;
				} else if (Array.isArray(msg.content)) {
					msg.content.push({ type: "text", text: `\n\n${statusMsg.content}` });
				}
				return { messages };
			}
		}
		// Fallback: insert as separate message.
		messages.push(statusMsg);
		return { messages };
	});

	// ── Execute pending actions after agent fully settles ──
	pi.on("agent_end", async (_event, ctx) => {
		if (!hasPending()) return;
		const notify = ctx.hasUI
			? (msg: string, level: "info" | "warning" | "error") => ctx.ui.notify(msg, level)
			: undefined;
		const runtime = {
			sendFollowUp: async (msg: string) => { await pi.sendUserMessage(msg, { deliverAs: "followUp" }); },
		};
		setTimeout(() => {
			runPending(notify, runtime).catch((e) => {
				if (notify) notify(`pi-control runPending error: ${e}`, "error");
				else console.error("[pi-control] runPending error:", e);
			});
		}, 0);
	});

	// Warn once if patch failed or command context was never bound.
	let warnedOnce = false;
	pi.on("session_start", async (_event, ctx) => {
		if (warnedOnce) return;
		if (!patchOk) {
			warnedOnce = true;
			if (ctx.hasUI) ctx.ui.notify("pi-control: failed to patch ExtensionRunner — resume/new/navigate/fork will fall back to built-in commands", "warning");
		} else if (!isArmed()) {
			warnedOnce = true;
			if (ctx.hasUI) ctx.ui.notify("pi-control: command context not captured — resume/new/navigate/fork will fall back to built-in commands", "warning");
		}
	});

	// Clear stale pending state on session shutdown.
	pi.on("session_shutdown", async () => {
		if (hasPending()) {
			console.warn("[pi-control] session_shutdown fired while a transition was pending; dropping it.");
		}
		clearPending();
		lastModel = null;
		lastContextBucket = null;
	});
}
