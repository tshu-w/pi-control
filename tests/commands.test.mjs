import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { patchBindCommandContext } = await jiti.import("../extensions/command-actions.ts");
const { registerCommandsRouter } = await jiti.import("../extensions/commands.ts");
const MAX_BYTES = 50 * 1024;

function setup(command) {
	const sessionManager = {};
	const commandContext = {
		hasUI: false,
		sessionManager,
		ui: {
			notify() {},
			setStatus() {},
		},
	};
	const runner = {
		sessionManager,
		getRegisteredCommands: () => [command],
		getCommand: (name) => name === command.invocationName ? command : undefined,
		createCommandContext: () => commandContext,
	};
	const actions = {
		switchSession: async () => ({ cancelled: false }),
		newSession: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		reload: async () => {},
		waitForIdle: async () => {},
	};
	patchBindCommandContext();
	ExtensionRunner.prototype.bindCommandContext.call(runner, actions);
	let tool;
	registerCommandsRouter({ registerTool(value) { tool = value; } });
	return { tool, ctx: { sessionManager } };
}

test("command notifications and rendered output are bounded", async () => {
	const command = {
		invocationName: "noisy",
		name: "noisy",
		description: "Emit many large notifications",
		sourceInfo: { path: "/tmp/noisy.ts", source: "local", scope: "user" },
		handler: async (_args, ctx) => {
			for (let i = 0; i < 500; i++) ctx.ui.notify(`${i}:` + "x".repeat(10_000));
		},
	};
	const { tool, ctx } = setup(command);
	const result = await tool.execute("t1", { action: "run", name: "noisy" }, undefined, undefined, ctx);
	assert.ok(Buffer.byteLength(result.content[0].text) <= MAX_BYTES);
	assert.equal(result.details.notifications, undefined, "captured output must not be duplicated in details");
	const fullOutput = readFileSync(result.details.fullOutputPath, "utf8");
	const notifications = fullOutput.split("\n").filter((line) => line.startsWith("  [info]"));
	assert.equal(notifications.length, 100);
	assert.ok(notifications.every((line) => line.includes("x".repeat(10_000))), "captured command output must be preserved before spill");
	rmSync(dirname(result.details.fullOutputPath), { recursive: true, force: true });
});
