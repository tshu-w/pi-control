import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { registerSessionsRouter } = await jiti.import("../extensions/session.ts");
const { registerTreeRouter } = await jiti.import("../extensions/tree.ts");
const { registerModelsRouter } = await jiti.import("../extensions/model.ts");
const { registerCommandsRouter } = await jiti.import("../extensions/commands.ts");

const tools = new Map();
const pi = { registerTool: (tool) => tools.set(tool.name, tool) };
registerSessionsRouter(pi);
registerTreeRouter(pi);
registerModelsRouter(pi);
registerCommandsRouter(pi);

const cases = [
	["sessions", { action: "search", keyword: "renderer", limit: 10, scope: "all" }, '<b>sessions</b>(action="search", keyword="renderer", limit=10, scope="all")'],
	["tree", { action: "list", scope: "branch", types: ["message", "compaction"] }, '<b>tree</b>(action="list", scope="branch", types=["message","compaction"])'],
	["models", { action: "consult", modelId: "gpt-5.5", thinkingLevel: "high", prompt: "review" }, '<b>models</b>(action="consult", modelId="gpt-5.5", thinkingLevel="high", prompt="review")'],
	["commands", { action: "run", name: "ssh", args: "off" }, '<b>commands</b>(action="run", name="ssh", args="off")'],
];

test("router calls render every argument in function-call form", () => {
	for (const [name, args, expected] of cases) {
		const styles = [];
		const theme = {
			bold: (text) => `<b>${text}</b>`,
			fg: (color, text) => { styles.push([color, text]); return text; },
		};
		const component = tools.get(name).renderCall(args, theme, { expanded: false });
		assert.deepEqual(component.render(1000).map((line) => line.trimEnd()), [expected, ""]);
		assert.equal(styles[0][0], "toolTitle");
		assert.ok(styles.filter(([color]) => color === "text").length > Object.keys(args).length);
		assert.equal(styles.some(([color]) => color === "muted"), false);
		assert.equal(styles.some(([color]) => color === "accent"), false);
	}
});
