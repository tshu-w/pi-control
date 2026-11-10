// Contract test for the private-API surface pi-control depends on: the
// commands router calls third-party handlers through the ExtensionRunner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { patchBindCommandContext, getRunner } from "../extensions/command-actions.ts";

const fakeActions = () => ({
	switchSession: async () => ({ cancelled: false }),
	newSession: async () => ({ cancelled: false }),
	navigateTree: async () => ({ cancelled: false }),
	fork: async () => ({ cancelled: false }),
	reload: async () => {},
	waitForIdle: async () => {},
});

test("ExtensionRunner still exposes the patched/used private methods", () => {
	for (const method of ["bindCommandContext", "getCommand", "createCommandContext"]) {
		assert.equal(typeof ExtensionRunner.prototype[method], "function", `ExtensionRunner.prototype.${method} missing — pi private API changed`);
	}
});

test("patch captures the runner when pi binds the command context", () => {
	assert.equal(patchBindCommandContext(), true);
	const sessionManager = {};
	assert.equal(getRunner(sessionManager), null);
	const runner = { sessionManager };
	ExtensionRunner.prototype.bindCommandContext.call(runner, fakeActions());
	assert.equal(getRunner(sessionManager), runner);
});

test("original bindCommandContext behavior is preserved (handlers land on the runner)", () => {
	const runner = { sessionManager: {} };
	const actions = fakeActions();
	ExtensionRunner.prototype.bindCommandContext.call(runner, actions);
	// pi's original implementation stores the closures on the instance; if this
	// stops holding, the patch may be swallowing the original call.
	assert.ok(Object.values(runner).includes(actions.switchSession), "original implementation no longer receives the actions");
});

test("binding null drops only its own session's runner", () => {
	const first = { sessionManager: {} };
	const second = { sessionManager: {} };
	ExtensionRunner.prototype.bindCommandContext.call(first, fakeActions());
	ExtensionRunner.prototype.bindCommandContext.call(second, null);
	assert.equal(getRunner(first.sessionManager), first);
	assert.equal(getRunner(second.sessionManager), null);
});
