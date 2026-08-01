import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "typebox";

interface OutputContractOptions<TParams> {
	preserveFullOutput?: (params: TParams) => boolean;
	tempPrefix?: string;
}

function utf8Prefix(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.length <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (buffer[end] & 0b1100_0000) === 0b1000_0000) end--;
	return buffer.subarray(0, end).toString("utf8");
}

async function boundText(value: string, preserve: boolean, tempPrefix: string): Promise<{
	text: string;
	truncated: boolean;
	fullOutputSaved?: boolean;
	fullOutputPath?: string;
}> {
	const full = truncateHead(value, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!full.truncated) return { text: value, truncated: false };

	let fullOutputPath: string | undefined;
	if (preserve) {
		try {
			const directory = await mkdtemp(join(tmpdir(), `${tempPrefix}-`));
			fullOutputPath = join(directory, "output.txt");
			await writeFile(fullOutputPath, value, "utf8");
		} catch {
			fullOutputPath = undefined;
		}
	}

	const summary = `Output truncated: ${formatSize(full.totalBytes)}, ${full.totalLines} lines total.`;
	const notice = fullOutputPath
		? `\n\n[${summary} Full output: ${fullOutputPath}. This is a temporary file; copy or move it if it should persist.]`
		: preserve
			? `\n\n[${summary} Full output could not be saved to a temporary file.]`
			: `\n\n[${summary} Narrow the filter or use pagination to continue.]`;
	// The limits bound the content; the notice sits on top of it.
	let content = full.content;
	if (!content) content = utf8Prefix(value.split("\n")[0] ?? "", DEFAULT_MAX_BYTES);
	return {
		text: content + notice,
		truncated: true,
		...(preserve ? { fullOutputSaved: fullOutputPath !== undefined } : {}),
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
}

async function boundResult<TDetails>(
	result: AgentToolResult<TDetails>,
	preserve: boolean,
	tempPrefix: string,
): Promise<AgentToolResult<TDetails>> {
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const bounded = await boundText(text, preserve, tempPrefix);
	if (!bounded.truncated) return result;

	const nonText = result.content.filter((part) => part.type !== "text");
	const details = result.details && typeof result.details === "object"
		? result.details as Record<string, unknown>
		: {};
	return {
		...result,
		content: [{ type: "text", text: bounded.text }, ...nonText],
		details: {
			...details,
			truncated: true,
			...(bounded.fullOutputSaved !== undefined ? { fullOutputSaved: bounded.fullOutputSaved } : {}),
			...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
		} as TDetails,
	};
}

export function withToolOutputContract<TParams extends TSchema, TDetails, TState>(
	definition: ToolDefinition<TParams, TDetails, TState>,
	options: OutputContractOptions<import("typebox").Static<TParams>> = {},
): ToolDefinition<TParams, TDetails, TState> {
	const execute = definition.execute.bind(definition);
	return {
		...definition,
		async execute(id, params, signal, onUpdate, ctx) {
			const preserve = options.preserveFullOutput?.(params) ?? false;
			const tempPrefix = options.tempPrefix ?? `pi-control-${definition.name}`;
			try {
				return await boundResult(await execute(id, params, signal, onUpdate, ctx), preserve, tempPrefix);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const bounded = await boundText(message, preserve, tempPrefix);
				throw new Error(bounded.text, { cause: error });
			}
		},
	};
}
