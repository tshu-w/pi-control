// Contract test for the private-API surface pi-control depends on.
// If a pi upgrade renames or reshapes these, this file fails first —
// before resume/new/navigate/fork silently degrade at runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { patchBindCommandContext, isArmed, getOps, getRunner } from "../extensions/command-actions.ts";

const fakeActions = () => ({
	switchSession: async () => ({ cancelled: false }),
	newSession: async () => ({ cancelled: false }),
	navigateTree: async () => ({ cancelled: false }),
	fork: async () => ({ cancelled: false }),
	reload: async () => {},
	waitForIdle: async () => {},
});

test("ExtensionRunner still exposes the patched/used private methods", () => {
	for (const method of ["bindCommandContext", "getRegisteredCommands", "getCommand", "createCommandContext"]) {
		assert.equal(typeof ExtensionRunner.prototype[method], "function", `ExtensionRunner.prototype.${method} missing — pi private API changed`);
	}
});

test("pi still exposes the agent_settled extension event (pi >= 0.80.4)", () => {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const types = readFileSync(path.join(path.dirname(entry), "core", "extensions", "types.d.ts"), "utf8");
	// Deferred transitions run on agent_settled; if pi renames or drops the
	// event, they would silently never fire.
	assert.match(types, /"agent_settled"/, "agent_settled missing from pi extension types — deferred transitions would never fire");
});

test("patch captures ops and runner when pi binds the command context", () => {
	assert.equal(patchBindCommandContext(), true);
	assert.equal(isArmed(), false, "must not be armed before binding");

	const runner = { marker: "fake-runner" };
	const actions = fakeActions();
	ExtensionRunner.prototype.bindCommandContext.call(runner, actions);

	assert.equal(isArmed(), true);
	assert.equal(getRunner(), runner, "runner instance must be captured");
	const ops = getOps();
	for (const key of ["switchSession", "newSession", "navigateTree", "fork", "reload", "waitForIdle"]) {
		assert.equal(ops[key], actions[key], `ops.${key} must be the closure pi passed in`);
	}
});

test("upstream message APIs keep their awaited/void shapes", () => {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const types = readFileSync(path.join(path.dirname(entry), "core", "extensions", "types.d.ts"), "utf8");
	// runPending awaits waitForIdle before transitions so a turn that raced the
	// public settled event finishes instead of being torn down mid-flight.
	assert.match(types, /waitForIdle: \(\) => Promise<void>;/, "ExtensionCommandContextActions.waitForIdle missing \u2014 transition idle-gating would silently disable");
	// ExtensionAPI.sendUserMessage is fire-and-forget (returns void): several
	// routers document asynchronous delivery because of this. If it becomes
	// awaitable, upgrade queue_message/nav/compact/reload/model-handoff delivery.
	assert.match(types, /sendUserMessage\(content: string \| \(TextContent \| ImageContent\)\[\], options\?: \{\s*deliverAs\?: "steer" \| "followUp";\s*\}\): void;/, "ExtensionAPI.sendUserMessage is no longer void \u2014 upgrade to awaited delivery");
	// resume/new/fork followUp delivery awaits the replaced-session context API.
	assert.match(types, /sendUserMessage\(content: string \| \(TextContent \| ImageContent\)\[\], options\?: \{\s*deliverAs\?: "steer" \| "followUp";\s*\}\): Promise<void>;/, "ReplacedSessionContext.sendUserMessage no longer returns a Promise");
});

test("original bindCommandContext behavior is preserved (handlers land on the runner)", () => {
	const runner = {};
	const actions = fakeActions();
	ExtensionRunner.prototype.bindCommandContext.call(runner, actions);
	// pi's original implementation stores the closures on the instance; if this
	// stops holding, the patch may be swallowing the original call.
	const stored = Object.values(runner);
	assert.ok(stored.includes(actions.switchSession), "original implementation no longer receives the actions");
});

test("binding null disarms", () => {
	ExtensionRunner.prototype.bindCommandContext.call({}, null);
	assert.equal(isArmed(), false);
});
