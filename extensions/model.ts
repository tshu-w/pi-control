import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderCollapsed, renderToolCall } from "./render-call.js";
import { clampLimit } from "./utils.js";
import { scheduleDeferred } from "./command-actions.js";
import { isOutputTruncated, styleToolOutput, withToolOutputContract } from "./tool-output.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function scopedModels(ctx: any, available: any[]): any[] {
	return ctx.scopedModels.length > 0
		? ctx.scopedModels.map((entry: any) => entry.model)
		: available;
}

/**
 * Resolve a model by id (and optional provider), preferring scoped models.
 *
 * If `provider` is given, looks up directly via the registry.
 * If not, prefers a scoped match (matching settings.json `enabledModels`),
 * then falls back to any available model with the same id.
 *
 * `includeUnregistered` (only for consult) lets callers fall back to
 * `getModel(provider, modelId)` so consult can hit a model the registry
 * doesn't yet know but that does have an API key configured.
 */
async function resolveModel(
	ctx: any,
	provider: string | undefined,
	modelId: string,
	opts?: { includeUnregistered?: boolean },
): Promise<{ model: any | null; error?: string }> {
	const available = await ctx.modelRegistry.getAvailable();
	const providerMap = new Map<string, string>();
	for (const m of available) providerMap.set(m.provider.toLowerCase(), m.provider);

	let resolvedProvider = provider ? (providerMap.get(provider.toLowerCase()) ?? provider) : undefined;
	let resolvedModelId = modelId;

	if (resolvedProvider) {
		const exact = ctx.modelRegistry.find(resolvedProvider, modelId);
		if (exact) return { model: exact };
	}

	const slashIndex = modelId.indexOf("/");
	if (slashIndex !== -1) {
		const maybeProvider = modelId.substring(0, slashIndex);
		const rest = modelId.substring(slashIndex + 1);
		const canonical = providerMap.get(maybeProvider.toLowerCase());
		if (canonical) {
			if (resolvedProvider && resolvedProvider !== canonical) {
				return { model: null, error: `Provider mismatch: provider=${resolvedProvider}, modelId=${modelId}.` };
			}
			resolvedProvider = canonical;
			resolvedModelId = rest;
		}
	}

	if (resolvedProvider) {
		const found = ctx.modelRegistry.find(resolvedProvider, resolvedModelId);
		if (found) return { model: found };
		if (opts?.includeUnregistered) return { model: getModel(resolvedProvider as any, resolvedModelId) };
		return { model: null };
	}

	const findMatches = (models: any[]) => models.filter((m: any) => m.id === resolvedModelId || `${m.provider}/${m.id}` === resolvedModelId);
	if (ctx.scopedModels.length > 0) {
		const scopedMatches = findMatches(scopedModels(ctx, available));
		if (scopedMatches.length === 1) return { model: scopedMatches[0] };
		if (scopedMatches.length > 1) {
			return { model: null, error: `Ambiguous modelId "${modelId}" in scoped models. Candidates: ${scopedMatches.map(m => `${m.provider}/${m.id}`).join(", ")}. Use provider/modelId or pass provider.` };
		}
	}

	const matches = findMatches(available);
	if (matches.length === 1) return { model: matches[0] };
	if (matches.length > 1) {
		return { model: null, error: `Ambiguous modelId "${modelId}". Candidates: ${matches.map(m => `${m.provider}/${m.id}`).join(", ")}. Use provider/modelId or pass provider.` };
	}
	return { model: null };
}

export function registerModelsRouter(pi: ExtensionAPI) {
	const pendingUsage = new Map<string, Usage>();
	pi.on("tool_result", (event) => {
		if (event.toolName !== "models") return;
		const usage = pendingUsage.get(event.toolCallId);
		if (usage === undefined) return;
		pendingUsage.delete(event.toolCallId);
		if (event.usage === undefined) return { usage };
	});

	pi.registerTool(withToolOutputContract({
		name: "models",
		label: "Models",
		description: [
			"List available models, switch the active model, or consult another model.",
			"switch takes effect after the current turn.",
			"consult returns a one-shot response without tools or a change to the active model.",
		].join(" "),
		promptSnippet: "List, switch, or consult models",
		promptGuidelines: [
			"Use models(action='list') to discover available scoped models when the target is uncertain.",
			"Prefer scoped models; use scope='all' only when the user asks or scoped results are insufficient.",
			"Finish your turn after calling models(action='switch').",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "switch", "consult"] as const, {
				description: "Action to perform",
			}),
			// switch / consult params
			modelId: Type.Optional(Type.String({ description: "Model ID or provider/modelId for switch or consult. Required for both." })),
			provider: Type.Optional(Type.String({ description: "Model provider for switch or consult. Optional when modelId includes the provider or identifies a unique model." })),
			thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking level for switch or consult." })),
			message: Type.Optional(Type.String({ description: "User message to start the next turn after switch." })),
			// consult params
			prompt: Type.Optional(Type.String({ description: "Prompt for consult. Required for consult." })),
			// list params
			scope: Type.Optional(StringEnum(["scoped", "all"] as const, { description: "Model scope for list (default: scoped). scoped uses configured models, or all available models if none are configured; all lists every available model." })),
			filter: Type.Optional(Type.String({ description: "Case-insensitive substring filter on provider, model ID, or model name for list." })),
			limit: Type.Optional(Type.Integer({ description: "Maximum results for list (default: 20, max: 200).", minimum: 1, maximum: 200, default: 20 })),
			offset: Type.Optional(Type.Integer({ description: "Number of filtered results to skip for list (default: 0).", minimum: 0, default: 0 })),
		}),
		renderCall(args, theme, context) {
			return renderToolCall("models", args, theme, !context.isPartial);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = result.content.find((part) => part.type === "text")?.text ?? "";
			const truncated = isOutputTruncated(result.details);
			if (context.isError) return new Text(theme.fg("error", text), 0, 0);
			if (expanded || isPartial) return new Text(styleToolOutput(text, truncated, theme), 0, 0);

			if (context.args.action === "list") {
				const lines = text.split("\n");
				const modelLines = lines.filter((line) => line.startsWith("- "));
				if (modelLines.length <= 20) return new Text(styleToolOutput(text, truncated, theme), 0, 0);

				const footerLines = lines.slice(lines.lastIndexOf(modelLines.at(-1)!) + 1).filter(Boolean);
				return renderCollapsed(modelLines.slice(20).join("\n"), (hidden) => {
					const visible = [
						theme.fg("toolOutput", lines[0]!),
						...modelLines.slice(0, 20).map((line) => theme.fg("toolOutput", line)),
						"",
						theme.fg("muted", `... (${hidden} more lines, ${keyText("app.tools.expand")} to expand)`),
					];
					if (footerLines.length > 0) visible.push("", ...footerLines.map((line) => styleToolOutput(line, truncated, theme)));
					return new Text(visible.join("\n"), 0, 0);
				});
			}

			if (context.args.action === "consult") {
				const separator = text.indexOf("\n\n");
				if (separator < 0) return new Text(theme.fg("toolOutput", text), 0, 0);
				const footerStart = truncated ? Math.max(text.lastIndexOf("\n\n[Output truncated:"), text.lastIndexOf("\n\n[Showing "), text.lastIndexOf("\n\n[Line ")) : -1;
				const bodyEnd = footerStart >= 0 ? footerStart : text.length;
				const responseLines = text.slice(separator + 2, bodyEnd).split("\n");
				while (responseLines.at(-1) === "") responseLines.pop();
				if (responseLines.length <= 15) return new Text(styleToolOutput(text, truncated, theme), 0, 0);

				return renderCollapsed(responseLines.slice(15).join("\n"), (hidden) => {
					const visible = [
						theme.fg("toolOutput", text.slice(0, separator)),
						"",
						...responseLines.slice(0, 15).map((line) => theme.fg("toolOutput", line)),
						"",
						theme.fg("muted", `... (${hidden} more lines, ${keyText("app.tools.expand")} to expand)`),
					];
					if (footerStart >= 0) visible.push("", styleToolOutput(text.slice(footerStart + 2), true, theme));
					return new Text(visible.join("\n"), 0, 0);
				});
			}

			return new Text(styleToolOutput(text, truncated, theme), 0, 0);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			switch (params.action) {
				// ── list ─────────────────────────────────────────────
				case "list": {
					const scope = params.scope ?? "scoped";
					const available = await ctx.modelRegistry.getAvailable();

					let candidates = available;
					if (scope === "scoped") {
						candidates = scopedModels(ctx, available);
					}

					const filter = params.filter?.toLowerCase();
					const filtered = filter
						? candidates.filter(m =>
							`${m.provider}/${m.id}`.toLowerCase().includes(filter)
							|| (m.name ?? "").toLowerCase().includes(filter)
						)
						: candidates;

					const limit = Math.max(1, clampLimit(params.limit, 20, 200));
					const offset = clampLimit(params.offset, 0, Number.MAX_SAFE_INTEGER);
					const total = filtered.length;
					const page = filtered.slice(offset, offset + limit);

					const header = scope === "scoped" && ctx.scopedModels.length > 0
						? `scoped models (${ctx.scopedModels.length} configured)`
						: scope === "scoped"
							? "no scoped models configured, using all available models:"
							: "all available models:";

					if (page.length === 0) {
						return {
							content: [{ type: "text", text: total > 0
								? `${header}\nNo models at offset ${offset} (total: ${total}).`
								: `${header}\nNo models found${filter ? ` matching "${params.filter}"` : ""}. Check API keys.` }],
							details: { scope, total, offset, limit, models: [] },
						};
					}

					const lines = page.map(m =>
						`- ${m.provider}/${m.id} context=${m.contextWindow} reasoning=${m.reasoning ?? false}`
					);

					const remaining = total - offset - page.length;
					const continuation = remaining > 0
						? `\n\n[${remaining} more results. Use offset=${offset + page.length} to continue.]`
						: "";
					return {
						content: [{ type: "text", text: `${header}\n${lines.join("\n")}${continuation}` }],
						details: { scope, total, offset, limit, models: page.map(m => ({ provider: m.provider, id: m.id })) },
					};
				}

				// ── switch ──────────────────────────────────────────
				case "switch": {
					if (!params.modelId) {
						throw new Error("`modelId` is required for switch.");
					}

					const resolved = await resolveModel(ctx, params.provider, params.modelId);
					if (!resolved.model) {
						throw new Error(resolved.error ?? `Model not found: ${params.provider ?? "(auto)"}/${params.modelId}. Use models(action='list') to find valid models.`);
					}
					const model = resolved.model;

					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok) {
						throw new Error(`No API key for ${model.provider}/${model.id}.`);
					}

					// Deferred switch: the model change (and thinking level) applies on
					// agent_settled, so each turn belongs to exactly one model and the
					// message reliably starts the next turn. Mid-turn switching relied
					// on the new model choosing to end the turn, which newer models
					// no longer do: queued follow-ups accumulated instead.
					const scheduled = scheduleDeferred(ctx, `model switch to ${model.provider}/${model.id}`, async () => {
						const ok = await pi.setModel(model);
						if (!ok) throw new Error(`setModel failed for ${model.provider}/${model.id}`);
						if (params.thinkingLevel) pi.setThinkingLevel(params.thinkingLevel);
						// Upstream limit: ExtensionAPI.sendUserMessage returns void, so
						// delivery cannot be awaited; failures surface as extension errors.
						if (params.message) pi.sendUserMessage(params.message, { deliverAs: "followUp" });
					});
					if (!scheduled.ok) {
						throw new Error(`Cannot schedule switch: ${scheduled.reason}.`);
					}

					return {
						content: [{ type: "text", text: `switch to ${model.provider}/${model.id} scheduled at end of this turn${params.message ? "; your message will start the next turn as a user message" : ""}. Finish your turn now.` }],
						details: { provider: model.provider, modelId: model.id, thinkingLevel: params.thinkingLevel, scheduled: true, messageScheduled: params.message !== undefined },
					};
				}

				// ── consult ─────────────────────────────────────────
				case "consult": {
					if (!params.modelId || !params.prompt) {
						throw new Error("`modelId` and `prompt` are required for consult.");
					}

					const resolved = await resolveModel(ctx, params.provider, params.modelId, { includeUnregistered: true });
					if (!resolved.model) {
						throw new Error(resolved.error ?? `Model not found: ${params.provider ?? "(auto)"}/${params.modelId}`);
					}
					const model = resolved.model;

					const thinkingLevel = params.thinkingLevel;
					const useReasoning = !!(model.reasoning && thinkingLevel && thinkingLevel !== "off");
					const completeOpts: any = { signal };
					if (useReasoning) completeOpts.reasoning = thinkingLevel;

					onUpdate?.({ content: [{ type: "text", text: `Consulting ${model.provider}/${model.id}${useReasoning ? ` (thinking: ${thinkingLevel})` : ""}...` }], details: {} });

					const response = await ctx.modelRegistry.streamSimple(
						model,
						{
							messages: [{ role: "user", content: [{ type: "text", text: params.prompt }], timestamp: Date.now() }],
						},
						completeOpts,
					).result();

					pendingUsage.set(toolCallId, response.usage);
					if (response.stopReason === "aborted") {
						throw new Error("Consultation aborted.");
					}
					if (response.stopReason === "error") {
						throw new Error(response.errorMessage ?? "Consultation failed.");
					}

					const text = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map(c => c.text).join("\n");

					const usage = response.usage;
					const stats = [
						usage ? `↑${usage.input} ↓${usage.output}` : "",
						usage?.cost?.total ? `$${usage.cost.total.toFixed(4)}` : "",
					].filter(Boolean).join(" ");

					return {
						content: [{ type: "text", text: `response from ${model.provider}/${model.id}${useReasoning ? ` (thinking: ${thinkingLevel})` : ""} ${stats}\n\n${text}` }],
						details: { provider: model.provider, modelId: model.id, thinkingLevel: useReasoning ? thinkingLevel : undefined },
						usage,
					};
				}

				default:
					throw new Error(`Unknown action: "${params.action}"`);
			}
		},
	}, {
		tempPrefix: "pi-control-consult",
	}));
}
