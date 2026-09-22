import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { patchBindCommandContext, scheduleRawOp, clearPending } = await jiti.import("../extensions/command-actions.ts");
const { registerCommandsRouter } = await jiti.import("../extensions/commands.ts");
const MAX_BYTES = 50 * 1024;

function setup(command, { hasUI = true } = {}) {
	const sessionManager = {};
	const forwarded = { notifications: [], statusUpdates: [] };
	const commandContext = {
		hasUI,
		sessionManager,
		ui: {
			notify(message, type) { forwarded.notifications.push({ message, type }); },
			setStatus(key, text) { forwarded.statusUpdates.push({ key, text }); },
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
	return { tool, ctx: { sessionManager }, forwarded };
}

test("completed commands return notifications once and preserve status updates", async () => {
	const command = {
		invocationName: "ssh",
		name: "ssh",
		description: "Switch SSH mode",
		sourceInfo: { path: "/tmp/ssh.ts", source: "local", scope: "user" },
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("ssh", "SSH: macbook-pro:/Users/wangtianshu");
			ctx.ui.notify("SSH mode enabled: macbook-pro:/Users/wangtianshu (disable: /ssh off)", "info");
		},
	};
	const { tool, ctx, forwarded } = setup(command);
	const result = await tool.execute("ssh-on", { action: "run", name: "ssh", args: "macbook-pro:/Users/wangtianshu" }, undefined, undefined, ctx);
	assert.equal(result.content[0].text, "SSH mode enabled: macbook-pro:/Users/wangtianshu (disable: /ssh off)");
	assert.deepEqual(result.details, { status: "completed" });
	assert.deepEqual(forwarded.notifications, []);
	assert.deepEqual(forwarded.statusUpdates, [{ key: "ssh", text: "SSH: macbook-pro:/Users/wangtianshu" }]);
});

test("command failures reject while scheduled transitions remain successful", async () => {
	const originalError = new Error("boom");
	const failureCases = [
		{
			name: "handler failure",
			command: {
				invocationName: "broken",
				name: "broken",
				sourceInfo: { path: "/tmp/broken.ts", source: "local", scope: "user" },
				handler: async (_args, ctx) => {
					ctx.ui.notify("before failure", "warning");
					throw originalError;
				},
			},
			pattern: /\/broken: failed[\s\S]*Error: boom[\s\S]*\[warning\] before failure/,
		},
		{
			name: "interactive UI",
			command: {
				invocationName: "prompt",
				name: "prompt",
				sourceInfo: { path: "/tmp/prompt.ts", source: "local", scope: "user" },
				handler: async (_args, ctx) => ctx.ui.input("Value"),
			},
			options: { hasUI: false },
			pattern: /\/prompt: interactive_unavailable[\s\S]*ui\.input requires a real TTY/,
		},
		{
			name: "swallowed transition",
			command: {
				invocationName: "swallow",
				name: "swallow",
				sourceInfo: { path: "/tmp/swallow.ts", source: "local", scope: "user" },
				handler: async (_args, ctx) => {
					try { await ctx.reload(); } catch {}
				},
			},
			pattern: /transition cancelled/,
		},
	];

	for (const item of failureCases) {
		const { tool, ctx } = setup(item.command, item.options);
		await assert.rejects(
			tool.execute(item.name, { action: "run", name: item.command.invocationName }, undefined, undefined, ctx),
			item.pattern,
		);
	}

	const transition = {
		invocationName: "reload-now",
		name: "reload-now",
		sourceInfo: { path: "/tmp/reload.ts", source: "local", scope: "user" },
		handler: async (_args, ctx) => ctx.reload(),
	};
	const { tool, ctx } = setup(transition);
	const scheduled = await tool.execute("scheduled", { action: "run", name: "reload-now" }, undefined, undefined, ctx);
	assert.equal(scheduled.content[0].text, "/reload-now: reload scheduled after the current turn.");
	assert.deepEqual(scheduled.details, {
		status: "scheduled_transition",
		scheduledTransition: { op: "reload" },
	});

	const { tool: busyTool, ctx: busyCtx } = setup(transition);
	assert.equal(scheduleRawOp(busyCtx, "occupied", async () => {}).ok, true);
	try {
		await assert.rejects(
			busyTool.execute("busy", { action: "run", name: "reload-now" }, undefined, undefined, busyCtx),
			/\/reload-now: busy[\s\S]*another pending action/,
		);
	} finally {
		clearPending(busyCtx);
	}

	const swallowedBusy = {
		...transition,
		invocationName: "swallow-busy",
		handler: async (_args, ctx) => {
			try { await ctx.reload(); } catch {}
		},
	};
	const { tool: swallowedBusyTool, ctx: swallowedBusyCtx } = setup(swallowedBusy);
	assert.equal(scheduleRawOp(swallowedBusyCtx, "occupied", async () => {}).ok, true);
	try {
		await assert.rejects(
			swallowedBusyTool.execute("swallow-busy", { action: "run", name: "swallow-busy" }, undefined, undefined, swallowedBusyCtx),
			/\/swallow-busy: busy[\s\S]*another pending action/,
		);
	} finally {
		clearPending(swallowedBusyCtx);
	}
});

test("commands reject unavailable, missing, and unknown command requests", async () => {
	const command = {
		invocationName: "known",
		name: "known",
		sourceInfo: { path: "/tmp/known.ts", source: "local", scope: "user" },
		handler: async () => {},
	};
	const { tool, ctx } = setup(command);
	await assert.rejects(tool.execute("missing", { action: "run" }, undefined, undefined, ctx), /Missing required parameter: name/);
	await assert.rejects(tool.execute("unknown", { action: "run", name: "missing" }, undefined, undefined, ctx), /No command named "missing"/);

	let unboundTool;
	registerCommandsRouter({ registerTool(value) { unboundTool = value; } });
	await assert.rejects(
		unboundTool.execute("unavailable", { action: "list" }, undefined, undefined, { sessionManager: {} }),
		/Commands router unavailable/,
	);
});

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
	const notifications = fullOutput.split("\n").filter((line) => /^\d+:x/.test(line));
	assert.equal(notifications.length, 100);
	assert.ok(notifications.every((line) => line.includes("x".repeat(10_000))), "captured command output must be preserved before spill");
	rmSync(dirname(result.details.fullOutputPath), { recursive: true, force: true });
});
