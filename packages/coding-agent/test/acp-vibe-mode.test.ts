/**
 * Contracts: vibe mode over ACP.
 *
 * 1. `vibe` is an ACP session mode; selecting it swaps the toolset to `read`,
 *    parent `todo`, and the vibe tools, and leaving it restores the prior set.
 * 2. Mode-picker switches between plan and vibe transition directly.
 * 3. `/vibe` toggles the same mode from a prompt.
 * 4. A session persisted in vibe mode comes back in vibe mode.
 * 5. Sessions without a background job manager cannot enter vibe mode.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { cfgPlanEnabled } from "@oh-my-pi/pi-coding-agent/plan-mode/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VIBE_TOOL_NAMES } from "@oh-my-pi/pi-coding-agent/tools/vibe";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

const VIBE_TOOLSET = ["read", "todo", ...VIBE_TOOL_NAMES].toSorted();

describe("ACP vibe mode", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let updates: SessionNotification[];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-acp-vibe-");
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		VibeSessionRegistry.resetGlobalForTests();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		cfgPlanEnabled.set(Settings.instance, true);
		sessions = [];
		updates = [];
	});

	afterEach(async () => {
		for (const session of sessions) await session.dispose();
		VibeSessionRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(sessionManager?: SessionManager, options?: { withoutJobManager?: boolean }): AgentSession {
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const registryTools = [stubTool("read"), stubTool("todo"), stubTool("edit")];
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
			}),
			sessionManager: sessionManager ?? SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "plan.enabled": true }),
			modelRegistry,
			toolRegistry: new Map(registryTools.map(tool => [tool.name, tool])),
			builtInToolNames: registryTools.map(tool => tool.name),
			createVibeTools: () => VIBE_TOOL_NAMES.map(stubTool),
			asyncJobManager: options?.withoutJobManager ? undefined : new AsyncJobManager({}),
		});
		sessions.push(session);
		return session;
	}

	function createAgent(factory: () => AgentSession = () => createSession()): AcpAgent {
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				updates.push(notification);
			},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		return new AcpAgent(connection, async () => factory());
	}

	function textOutput(sessionId: string): string {
		return updates
			.filter(n => n.sessionId === sessionId && n.update.sessionUpdate === "agent_message_chunk")
			.map(n =>
				n.update.sessionUpdate === "agent_message_chunk" && n.update.content.type === "text"
					? n.update.content.text
					: "",
			)
			.join("");
	}

	it("swaps the toolset on entry and restores it when switching to plan and back", async () => {
		const agent = createAgent();
		const created = await agent.newSession({ cwd: tempDir.path(), mcpServers: [] });
		const session = sessions[0];
		await session.setActiveToolsByName(["read", "edit"]);

		await agent.setSessionMode({ sessionId: created.sessionId, modeId: "vibe" });
		expect(session.getVibeModeState()?.enabled).toBe(true);
		expect(session.getActiveToolNames().toSorted()).toEqual(VIBE_TOOLSET);
		expect(
			updates.some(
				n =>
					n.sessionId === created.sessionId &&
					n.update.sessionUpdate === "current_mode_update" &&
					n.update.currentModeId === "vibe",
			),
		).toBe(true);
		expect(
			session.sessionManager.getEntries().some(entry => entry.type === "mode_change" && entry.mode === "vibe"),
		).toBe(true);

		// Picker switch vibe -> plan exits vibe (restoring tools) and enters plan.
		await agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });
		expect(session.getVibeModeState()).toBeUndefined();
		expect(session.getPlanModeState()?.enabled).toBe(true);
		expect(session.getActiveToolNames().toSorted()).toEqual(["edit", "read"]);
		expect(session.getAllToolNames()).not.toContain("vibe_spawn");

		// And plan -> vibe exits plan.
		await agent.setSessionMode({ sessionId: created.sessionId, modeId: "vibe" });
		expect(session.getPlanModeState()).toBeUndefined();
		expect(session.getVibeModeState()?.enabled).toBe(true);
	});

	it("toggles vibe mode with /vibe and refuses to enter it from plan mode", async () => {
		const agent = createAgent();
		const created = await agent.newSession({ cwd: tempDir.path(), mcpServers: [] });
		const session = sessions[0];
		await session.setActiveToolsByName(["edit"]);

		await agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/vibe" }] });
		expect(session.getVibeModeState()?.enabled).toBe(true);
		expect(session.getActiveToolNames().toSorted()).toEqual(VIBE_TOOLSET);

		await agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/vibe" }] });
		expect(session.getVibeModeState()).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["edit"]);
		expect(textOutput(created.sessionId)).toContain("Vibe mode disabled.");

		await agent.setSessionMode({ sessionId: created.sessionId, modeId: "plan" });
		await agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/vibe" }] });
		expect(session.getVibeModeState()).toBeUndefined();
		expect(session.getPlanModeState()?.enabled).toBe(true);
		expect(textOutput(created.sessionId)).toContain("Exit plan mode first.");
	});

	it("restores vibe mode for a session persisted in vibe mode", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendModeChange("vibe", { previousTools: ["edit"] });
		const agent = createAgent(() => createSession(sessionManager));

		const created = await agent.newSession({ cwd: tempDir.path(), mcpServers: [] });
		const session = sessions[0];
		expect(created.modes?.currentModeId).toBe("vibe");
		expect(session.getActiveToolNames().toSorted()).toEqual(VIBE_TOOLSET);
		// Restoring must not record a second vibe entry.
		expect(
			sessionManager.getEntries().filter(entry => entry.type === "mode_change" && entry.mode === "vibe"),
		).toHaveLength(1);
	});

	it("does not offer vibe mode to a session without a background job manager", async () => {
		const agent = createAgent(() => createSession(undefined, { withoutJobManager: true }));
		const created = await agent.newSession({ cwd: tempDir.path(), mcpServers: [] });
		expect(created.modes?.availableModes.map(mode => mode.id)).toEqual(["default", "plan"]);

		await agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/vibe" }] });
		expect(sessions[0].getVibeModeState()).toBeUndefined();
		expect(textOutput(created.sessionId)).toContain("Vibe mode is unavailable in this session");
		await expect(agent.setSessionMode({ sessionId: created.sessionId, modeId: "vibe" })).rejects.toThrow(
			"Unsupported ACP mode: vibe",
		);
	});
});
