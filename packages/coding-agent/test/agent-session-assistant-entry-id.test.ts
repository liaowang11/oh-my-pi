/**
 * An assistant message's entry id is known from its first event: subscribers
 * show the streaming reply under it (ACP clients fork at it, possibly from
 * another process that has only the session file), so it must be the id the
 * message is persisted under.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession assistant entry id", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-assistant-entry-id-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	it("streams each assistant message under the id of the entry it persists as", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model to exist");
		const mock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["first answer"] }, { content: ["second answer"] }],
		});
		const agent = new Agent({
			getApiKey: agentModel => `${agentModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (streamModel, context, options) => mock.stream(streamModel, context, options),
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.modelFallback": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });

		// Every id each assistant message's events carried, keyed by the event's turn order.
		const streamed: string[][] = [];
		session.subscribe(event => {
			if (
				(event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") ||
				event.message.role !== "assistant"
			) {
				return;
			}
			if (event.type === "message_start") streamed.push([]);
			streamed.at(-1)?.push(session!.assistantEntryId(event.message) ?? "none");
		});

		await session.prompt("first question");
		await session.waitForIdle();
		await session.prompt("second question");
		await session.waitForIdle();

		const persisted = sessionManager
			.getEntries()
			.filter(entry => entry.type === "message" && entry.message.role === "assistant")
			.map(entry => entry.id);
		expect(persisted).toHaveLength(2);
		expect(streamed.map(ids => [...new Set(ids)])).toEqual(persisted.map(id => [id]));
	});
});
