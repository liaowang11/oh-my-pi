/**
 * Contract: `/tan <work>` over ACP dispatches a background clone of the session
 * as a task job without running a model turn, and the clone's report comes back
 * as an agent-initiated turn the client sees streamed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";

function cloneReport(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** The surface of the clone session the tan job drives. */
function cloneStub(report: string) {
	const prompt = vi.fn(async (_text: string) => {});
	const clone = {
		agent: { appendMessage: vi.fn(), state: { messages: [] } },
		sessionManager: { appendSessionInit: vi.fn() },
		systemPrompt: ["clone"],
		setTodoPhases: vi.fn(),
		getEnabledToolNames: vi.fn(() => []),
		getMountedXdevToolNames: vi.fn(() => []),
		setActiveToolPresentation: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt,
		waitForIdle: vi.fn(async () => {}),
		hasPendingAsyncWork: vi.fn(() => false),
		settleAsyncWork: vi.fn(async () => {}),
		getLastAssistantMessage: vi.fn(() => cloneReport(report)),
		abort: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	};
	return { clone, prompt };
}

describe("ACP /tan", () => {
	const authStorages: AuthStorage[] = [];
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
	});

	it("dispatches the work to a background clone and streams its report back as an agent turn", async () => {
		await using temp = await TempDir.create("@acp-tan-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses: [{ content: ["Tan report received"] }] });
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const sessionManager = SessionManager.create(temp.path(), temp.path());
		const parent = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, temp.join("models.yml")),
			agentId: "Lead",
			asyncJobManager: manager,
		});
		session = parent;
		const { clone, prompt: clonePrompt } = cloneStub("TAN_REPORT: release note drafted");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: clone,
		} as unknown as CreateAgentSessionResult);

		const updates: SessionNotification[] = [];
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				updates.push(notification);
			},
			extNotification: async () => {},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const streamedText = () =>
			updates
				.map(notification =>
					notification.update.sessionUpdate === "agent_message_chunk" &&
					notification.update.content.type === "text"
						? notification.update.content.text
						: "",
				)
				.join("");
		const acp = new AcpAgent(connection, async () => parent);
		try {
			await acp.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const created = await acp.newSession({ cwd: temp.path(), mcpServers: [] });
			const response = await acp.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "/tan write the release note" }],
			});

			expect(response.stopReason).toBe("end_turn");
			// The command ran no model turn of its own.
			expect(mock.calls).toHaveLength(0);
			const jobs = manager.getAllJobs();
			expect(jobs.map(job => [job.type, job.label, job.ownerId])).toEqual([
				["task", "/tan write the release note", "Lead"],
			]);
			expect(streamedText()).toContain(`Dispatched background tan ${jobs[0]!.id}`);

			await parent.settleAsyncWork();
			await parent.waitForIdle();
			await Bun.sleep(0);
			expect(clonePrompt).toHaveBeenCalledWith("write the release note", expect.anything());
			// The clone's report reached the parent model and the turn it woke streamed.
			expect(mock.calls).toHaveLength(1);
			expect(JSON.stringify(mock.calls[0]!.context.messages)).toContain("TAN_REPORT: release note drafted");
			expect(streamedText()).toContain("Tan report received");
		} finally {
			await acp.dispose();
		}
	});
});
