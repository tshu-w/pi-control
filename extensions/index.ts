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
 * pending session/navigation actions on agent_settled.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { patchBindCommandContext, runPending, runPendingDeferredInline, clearPending, isArmed, hasPending, hasQueuedAction } from "./command-actions.js";
import { registerSessionsRouter } from "./session.js";
import { registerTreeRouter } from "./tree.js";
import { registerModelsRouter } from "./model.js";
import { registerCommandsRouter } from "./commands.js";

// ── Event-driven status injection state ──
function contextBucket(pct: number): string | null {
	if (pct >= 95) return "critical";
	if (pct >= 85) return "very-high";
	if (pct >= 70) return "high";
	return null;
}

export default function (pi: ExtensionAPI) {
	let lastModel: string | null = null;
	let lastContextBucket: string | null = null;

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

		// Insert after the last user message.
		for (let i = messages.length - 1; i >= 0; i--) {
			if ((messages[i] as any).role === "user") {
				messages.splice(i + 1, 0, statusMsg);
				return { messages };
			}
		}
		messages.push(statusMsg);
		return { messages };
	});

	// ── Execute pending actions after agent fully settles ──
	// agent_settled (pi >= 0.80.4) fires only when no auto-retry, compaction
	// retry, or queued follow-up remains.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!hasPending(ctx)) return;
		const notify = ctx.hasUI
			? (msg: string, level: "info" | "warning" | "error") => ctx.ui.notify(msg, level)
			: undefined;
		// Deferred public-API work (model switch) completes inside this emit:
		// core publishes settled to external listeners and resolves idle only
		// after extension handlers return, so an external prompt racing the
		// settled event already sees the new model.
		if (await runPendingDeferredInline(ctx, notify)) return;
		const runtime = {
			sendFollowUp: async (msg: string) => { await pi.sendUserMessage(msg, { deliverAs: "followUp" }); },
		};
		// Session transitions tear down this runner: setTimeout(0) escapes the
		// emit stack so session replacement never runs inside the settled emit.
		// runPending additionally awaits ops.waitForIdle() first, so a prompt
		// that raced the public settled event finishes instead of being torn
		// down mid-turn by the transition.
		setTimeout(() => {
			runPending(ctx, notify, runtime).catch((e) => {
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
		} else if (!isArmed(ctx)) {
			warnedOnce = true;
			if (ctx.hasUI) ctx.ui.notify("pi-control: command context not captured — resume/new/navigate/fork will fall back to built-in commands", "warning");
		}
	});

	// Clear stale pending state on session shutdown. Only unclaimed queued
	// actions are stale: a transition in flight fires session_shutdown itself
	// (core emits it before switchSession/reload resolve) and is released by
	// runPending's finally, not here.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (hasQueuedAction(ctx)) {
			console.warn("[pi-control] session_shutdown fired while a transition was pending; dropping it.");
		}
		clearPending(ctx);
		lastModel = null;
		lastContextBucket = null;
	});
}
