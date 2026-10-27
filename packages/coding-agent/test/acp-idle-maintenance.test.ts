/**
 * Contract: an ACP session opts in to idle maintenance the way Claude Code
 * does it, compaction only. A session left idle over the idle threshold is
 * compacted after the idle delay; it never asks the model for an idle recap,
 * which an ACP client has nowhere to show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { drive, driveTurn, elapse, flush, until, wait } from "./helpers/fake-clock";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const RECAP_SECONDS = 240;
const COMPACTION_SECONDS = 300;

describe("ACP idle maintenance", () => {
	let settingsState: SettingsTestState;
	let root: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-idle-"));
		fs.mkdirSync(path.join(root, "cwd"), { recursive: true });
		settingsState = beginSettingsTest();
		setAgentDir(path.join(root, "agent"));
		await Settings.init({ inMemory: true, cwd: root });
		closeSessionIndex();
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		vi.useFakeTimers();
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await drive(session.dispose());
		vi.useRealTimers();
		vi.restoreAllMocks();
		authStorage.close();
		closeSessionIndex();
		restoreSettingsTestState(settingsState);
		removeSyncWithRetries(root);
	});

	it("compacts an idle session over the threshold and never requests a recap", async () => {
		const main = createMockModel({ handler: { content: ["Work finished."], usage: { input: 5_000, output: 20 } } });
		const side = createMockModel({ handler: { content: ["A recap."] } });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const connection = {
			sessionUpdate: async (_notification: SessionNotification) => {},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const agent = new AcpAgent(connection, async sessionCwd => {
			const session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
					convertToLlm,
					streamFn: main.stream,
				}),
				sessionManager: SessionManager.create(sessionCwd, path.join(root, "sessions")),
				settings: Settings.isolated({
					"todo.reminders": false,
					"recap.idleSeconds": RECAP_SECONDS,
					"compaction.idleEnabled": true,
					"compaction.idleThresholdTokens": 1_000,
					"compaction.idleTimeoutSeconds": COMPACTION_SECONDS,
				}),
				modelRegistry,
				sideStreamFn: side.stream,
			});
			sessions.push(session);
			return session;
		});
		await wait(agent.initialize({ protocolVersion: 1, clientCapabilities: {} }));
		const { sessionId } = await wait(agent.newSession({ cwd: path.join(root, "cwd"), mcpServers: [] }));
		const session = sessions.find(candidate => candidate.sessionId === sessionId)!;
		const compaction = vi.spyOn(session, "runIdleCompaction").mockResolvedValue(undefined);

		await driveTurn(session, agent.prompt({ sessionId, prompt: [{ type: "text", text: "please work" }] }));
		await wait(session.waitForIdle());
		await flush();
		await elapse(COMPACTION_SECONDS * 1000);
		await until(() => compaction.mock.calls.length === 1, "the idle compaction pass");

		expect(side.calls).toHaveLength(0);
	});
});
