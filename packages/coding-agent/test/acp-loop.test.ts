/**
 * Contracts: `/loop` over ACP.
 *
 * 1. `/loop <count>` arms the loop without a model turn; the next prompt then
 *    re-runs after every yield inside its own `session/prompt`, until the
 *    budget runs out.
 * 2. `--until '<cmd>'` stops the loop once the command succeeds.
 * 3. `session/cancel` suspends the loop (no further iteration), and `/loop`
 *    again disables it.
 * 4. `loop.mode: compact` compacts the context before each re-run.
 * 5. A prompt sent while the loop's condition runs takes over the session
 *    instead of queueing behind the loop.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";

interface Harness {
	acp: AcpAgent;
	sessionId: string;
	mock: MockModel;
	temp: TempDir;
	session: AgentSession;
	prompt: (text: string) => ReturnType<AcpAgent["prompt"]>;
	streamedText: () => string;
}

describe("ACP /loop", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function createHarness(
		handler: (call: number, temp: TempDir) => string,
		settings: Record<string, unknown> = {},
		options: { summarizeCompactions?: boolean } = {},
	): Promise<Harness> {
		const temp = await TempDir.create("@acp-loop-");
		cleanups.push(() => temp.remove());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		let call = 0;
		const mockHandler: MockHandler = () => ({ content: [handler(++call, temp)] });
		const mock = createMockModel({ handler: mockHandler });
		const authStorage = await AuthStorage.create(":memory:");
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory(temp.path());
		const modelRegistry = new ModelRegistry(authStorage, temp.join("models.yml"));
		let extensionRunner: ExtensionRunner | undefined;
		if (options.summarizeCompactions) {
			// Supplies the summary so compaction runs without a summarizer model.
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("session_before_compact", async event => ({
						compaction: {
							summary: "compacted",
							shortSummary: undefined,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
				temp.path(),
				new EventBus(),
				runtime,
				"loop-compaction",
			);
			extensionRunner = new ExtensionRunner([extension], runtime, temp.path(), sessionManager, modelRegistry);
		}
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager,
			settings: Settings.isolated(settings),
			modelRegistry,
			extensionRunner,
		});
		cleanups.push(() => session.dispose());
		const updates: SessionNotification[] = [];
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				updates.push(notification);
			},
			extNotification: async () => {},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, async () => session);
		cleanups.push(() => acp.dispose());
		await acp.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await acp.newSession({ cwd: temp.path(), mcpServers: [] });
		return {
			acp,
			sessionId,
			mock,
			temp,
			session,
			prompt: text => acp.prompt({ sessionId, prompt: [{ type: "text", text }] }),
			streamedText: () =>
				updates
					.map(notification =>
						notification.update.sessionUpdate === "agent_message_chunk" &&
						notification.update.content.type === "text"
							? notification.update.content.text
							: "",
					)
					.join(""),
		};
	}

	function userPrompts(mock: MockModel): string[] {
		const last = mock.calls.at(-1);
		if (!last) return [];
		return last.context.messages.flatMap(message => {
			if (message.role !== "user") return [];
			if (typeof message.content === "string") return [message.content];
			return message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
		});
	}

	it("re-runs the next prompt after each yield until the iteration budget is spent", async () => {
		const harness = await createHarness(call => `answer ${call}`);

		const armed = await harness.prompt("/loop 2");
		expect(armed.stopReason).toBe("end_turn");
		expect(harness.mock.calls).toHaveLength(0);
		expect(harness.streamedText()).toContain("Loop mode enabled");

		const looped = await harness.prompt("fix the next failing test");
		expect(looped.stopReason).toBe("end_turn");
		// The prompt itself, then two re-submissions.
		expect(harness.mock.calls).toHaveLength(3);
		expect(userPrompts(harness.mock)).toEqual([
			"fix the next failing test",
			"fix the next failing test",
			"fix the next failing test",
		]);
		expect(harness.streamedText()).toContain("answer 3");
		expect(harness.streamedText()).toContain("Loop limit reached. Loop mode disabled.");

		// The loop is over: the next prompt runs once.
		await harness.prompt("anything else?");
		expect(harness.mock.calls).toHaveLength(4);
	});

	it("stops once the --until command succeeds", async () => {
		const harness = await createHarness((call, temp) => {
			if (call === 2) fs.writeFileSync(temp.join("DONE"), "");
			return `answer ${call}`;
		});

		const looped = await harness.prompt("/loop --until 'test -e DONE' keep fixing");
		expect(looped.stopReason).toBe("end_turn");
		expect(harness.mock.calls).toHaveLength(2);
		expect(userPrompts(harness.mock)).toEqual(["keep fixing", "keep fixing"]);
		expect(harness.streamedText()).toContain("is now satisfied. Loop mode disabled.");
	});

	it("suspends on session/cancel and disables on a second /loop", async () => {
		const cancelOnSecondCall = Promise.withResolvers<Harness>();
		const harness = await createHarness(call => {
			if (call === 2) {
				void cancelOnSecondCall.promise.then(self => self.acp.cancel({ sessionId: self.sessionId }));
			}
			return `answer ${call}`;
		});
		cancelOnSecondCall.resolve(harness);

		await harness.prompt("/loop");
		const looped = await harness.prompt("keep going");
		expect(looped.stopReason).toBe("cancelled");
		await Bun.sleep(50);
		const callsAfterCancel = harness.mock.calls.length;
		expect(callsAfterCancel).toBe(2);

		const disabled = await harness.prompt("/loop");
		expect(disabled.stopReason).toBe("end_turn");
		expect(harness.streamedText()).toContain("Loop mode disabled.");
		expect(harness.mock.calls).toHaveLength(callsAfterCancel);
	});

	it("compacts the context before each re-run in compact mode", async () => {
		const harness = await createHarness(
			call => `answer ${call}`,
			{ "loop.mode": "compact", "compaction.keepRecentTokens": 1 },
			{ summarizeCompactions: true },
		);

		const looped = await harness.prompt("/loop 1 tidy the module");
		expect(looped.stopReason).toBe("end_turn");
		const compactions = harness.session.sessionManager.getEntries().filter(entry => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect(userPrompts(harness.mock).at(-1)).toBe("tidy the module");
		expect(harness.streamedText()).toContain("Loop limit reached. Loop mode disabled.");
	});

	it("refuses reset mode, which needs a new session between iterations", async () => {
		const harness = await createHarness(call => `answer ${call}`, { "loop.mode": "reset" });

		await harness.prompt("/loop 3 tidy the module");
		expect(harness.mock.calls).toHaveLength(0);
		expect(harness.streamedText()).toContain('loop.mode "reset" is unavailable over ACP');
	});

	it("lets a new prompt take over while the loop condition is still running", async () => {
		const harness = await createHarness(call => `answer ${call}`);
		const conditionRunning = async (calls: number) => {
			while (harness.mock.calls.length < calls) await Bun.sleep(5);
			// Give the condition command time to start.
			await Bun.sleep(100);
		};

		const looped = harness.prompt("/loop --while 'sleep 30' first task");
		await conditionRunning(1);
		const takeover = harness.prompt("second task");
		expect((await looped).stopReason).toBe("cancelled");

		// The takeover became the loop prompt; a cancel during its condition ends it.
		await conditionRunning(2);
		await harness.acp.cancel({ sessionId: harness.sessionId });
		expect((await takeover).stopReason).toBe("cancelled");
		expect(userPrompts(harness.mock)).toEqual(["first task", "second task"]);
	}, 10_000);
});
