import type { AgentToolResult, Theme, ToolDefinition, TruncationResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TSchema } from "typebox";

export function isOutputTruncated(details: unknown): boolean {
	if (!details || typeof details !== "object") return false;
	const value = details as { truncation?: { truncated?: boolean } };
	return value.truncation?.truncated === true;
}

export function styleToolOutput(text: string, truncated: boolean, theme: Theme): string {
	if (!truncated) return theme.fg("toolOutput", text);
	const separatedFooterStart = Math.max(text.lastIndexOf("\n\n[Output truncated:"), text.lastIndexOf("\n\n[Showing "), text.lastIndexOf("\n\n[Line "));
	const footerStart = separatedFooterStart >= 0 ? separatedFooterStart : /^(?:\[Output truncated:|\[Showing |\[Line )/.test(text) ? 0 : -1;
	if (footerStart < 0) return theme.fg("toolOutput", text);
	const noticeStart = separatedFooterStart >= 0 ? separatedFooterStart + 2 : footerStart;
	const nextLine = text.indexOf("\n", noticeStart);
	const noticeEnd = nextLine >= 0 ? nextLine : text.length;
	return theme.fg("toolOutput", text.slice(0, noticeStart))
		+ theme.fg("warning", text.slice(noticeStart, noticeEnd))
		+ theme.fg("toolOutput", text.slice(noticeEnd));
}

interface OutputContractOptions {
	tempPrefix?: string;
}

async function boundText(value: string, tempPrefix: string): Promise<{
	text: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}> {
	const full = truncateHead(value, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!full.truncated) return { text: value };

	const directory = await mkdtemp(join(tmpdir(), `${tempPrefix}-`));
	const fullOutputPath = join(directory, "output.txt");
	await writeFile(fullOutputPath, value, "utf8");

	// The limits bound the content; the notice sits on top of it.
	const summary = full.firstLineExceedsLimit
		? `Line 1 is ${formatSize(Buffer.byteLength(value.split("\n")[0]!, "utf8"))}, exceeds ${formatSize(full.maxBytes)} limit.`
		: `Showing lines 1-${full.outputLines} of ${full.totalLines}${full.truncatedBy === "bytes" ? ` (${formatSize(full.maxBytes)} limit)` : ""}.`;
	const notice = `\n\n[${summary} Full output: ${fullOutputPath}]`;
	const continuation = value.match(/\[\d{1,16} (?:more (?:results|labels|fork points)|older (?:entry|entries))\. Use offset=\d{1,16} to continue\.\]$/);
	const nextPage = continuation && continuation.index! + continuation[0].length > full.content.length
		? `\n\n${continuation[0]}`
		: "";

	return {
		text: full.content + notice + nextPage,
		truncation: full,
		fullOutputPath,
	};
}

async function boundResult<TDetails>(
	result: AgentToolResult<TDetails>,
	tempPrefix: string,
): Promise<AgentToolResult<TDetails>> {
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const bounded = await boundText(text, tempPrefix);
	if (!bounded.truncation) return result;

	const nonText = result.content.filter((part) => part.type !== "text");
	const details = result.details && typeof result.details === "object"
		? result.details as Record<string, unknown>
		: {};
	return {
		...result,
		content: [{ type: "text", text: bounded.text }, ...nonText],
		details: {
			...details,
			truncation: bounded.truncation,
			fullOutputPath: bounded.fullOutputPath,
		} as TDetails,
	};
}

export function withToolOutputContract<TParams extends TSchema, TDetails, TState>(
	definition: ToolDefinition<TParams, TDetails, TState>,
	options: OutputContractOptions = {},
): ToolDefinition<TParams, TDetails, TState> {
	const execute = definition.execute.bind(definition);
	return {
		...definition,
		async execute(id, params, signal, onUpdate, ctx) {
			const tempPrefix = options.tempPrefix ?? `pi-control-${definition.name}`;
			let result: AgentToolResult<TDetails>;
			try {
				result = await execute(id, params, signal, onUpdate, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const bounded = await boundText(message, tempPrefix);
				throw new Error(bounded.text, { cause: error });
			}
			return boundResult(result, tempPrefix);
		},
	};
}
