/**
 * Contract: an ACP client that opens a workspace through a directory alias
 * (a symlink to the real directory) can load and resume the sessions stored
 * under the real cwd, and an already-active session accepts any equivalent
 * spelling of its cwd. A different directory still rejects the request and
 * leaves the stored session untouched — nothing is rewritten for an alias.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { makeAssistantMessage } from "./session-manager/helpers";

describe.skipIf(process.platform === "win32")("ACP sessions through directory aliases", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	let root: string;
	let project: string;
	let alias: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let updates: SessionNotification[];

	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-alias-")));
		setAgentDir(path.join(root, "agent"));
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: root });
		project = path.join(root, "project");
		fs.mkdirSync(project);
		alias = path.join(root, "alias");
		fs.symlinkSync(project, alias);
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessions = [];
		updates = [];
	});

	afterEach(async () => {
		for (const session of sessions) await session.dispose();
		authStorage.close();
		resetSettingsForTest();
		// The process-wide `<agentDir>/history.db` handle must not outlive the temp agent dir.
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(root);
	});

	/** A real AgentSession per ACP request cwd, so `switchSession` enforces its cwd checks. */
	function createAgent(): AcpAgent {
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				updates.push(notification);
			},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		return new AcpAgent(connection, async cwd => {
			const session = new AgentSession({
				agent: new Agent({
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
					convertToLlm,
				}),
				sessionManager: SessionManager.create(cwd),
				settings: Settings.isolated(),
				modelRegistry,
			});
			sessions.push(session);
			return session;
		});
	}

	/** A stored one-turn session recorded under the real `project` cwd. */
	async function storedProjectSession(marker: string): Promise<{ id: string; file: string }> {
		const session = SessionManager.create(project);
		session.appendMessage({ role: "user", content: [{ type: "text", text: `work in ${marker}` }], timestamp: 1 });
		// The model the ACP session runs, so `switchSession` can restore it.
		session.appendMessage({ ...makeAssistantMessage(), model: "claude-sonnet-4-5" });
		await session.flush();
		const id = session.getSessionId();
		const file = session.getSessionFile()!;
		await session.close();
		return { id, file };
	}

	for (const method of ["loadSession", "resumeSession"] as const) {
		it(`${method} restores a stored session through an alias of its cwd, without rewriting it`, async () => {
			// The alias must really be the same directory, or the fixture proves nothing.
			expect(fs.realpathSync(alias)).toBe(project);
			const stored = await storedProjectSession(`alias-${method}`);

			await createAgent()[method]({ sessionId: stored.id, cwd: alias, mcpServers: [] });

			const opened = sessions.find(s => s.sessionId === stored.id);
			expect(opened).toBeDefined();
			// The recorded cwd is adopted as spelled in the header — not the alias.
			expect(opened!.sessionManager.getCwd()).toBe(project);
			expect(opened!.sessionManager.getSessionFile()).toBe(stored.file);
			const messages = opened!.sessionManager.buildSessionContext().messages;
			expect(messages.map(m => m.role)).toEqual(["user", "assistant"]);
			expect(messages[0]).toMatchObject({
				role: "user",
				content: [{ type: "text", text: `work in alias-${method}` }],
			});
			// Opened in place: the original file still holds the only copy of the id,
			// with its header cwd unchanged.
			expect(fs.existsSync(stored.file)).toBe(true);
			expect((await SessionManager.list(alias)).map(s => [s.id, s.cwd])).toEqual([[stored.id, project]]);
			if (method === "loadSession") {
				// `session/load` replays the stored history to the client.
				const replayed = updates
					.map(u => (u.update.sessionUpdate === "user_message_chunk" ? u.update.content : undefined))
					.filter((block): block is { type: "text"; text: string } => block?.type === "text");
				expect(replayed.map(block => block.text)).toEqual([`work in alias-${method}`]);
			}
		});
	}

	it("an active session accepts an equivalent alias cwd; a different directory rejects and leaves it intact", async () => {
		const stored = await storedProjectSession("active-alias");
		const agent = createAgent();
		await agent.loadSession({ sessionId: stored.id, cwd: project, mcpServers: [] });
		expect(sessions.find(s => s.sessionId === stored.id)?.sessionManager.getCwd()).toBe(project);

		// Returning through the alias reuses the active session instead of rejecting it.
		await agent.resumeSession({ sessionId: stored.id, cwd: alias, mcpServers: [] });
		await agent.loadSession({ sessionId: stored.id, cwd: alias, mcpServers: [] });
		expect(sessions.filter(s => s.sessionId === stored.id)).toHaveLength(1);

		// A different directory still rejects.
		const unrelated = path.join(root, "unrelated");
		fs.mkdirSync(unrelated);
		await expect(agent.loadSession({ sessionId: stored.id, cwd: unrelated, mcpServers: [] })).rejects.toThrow();
		// The rejection left the session active and the stored file untouched.
		await agent.resumeSession({ sessionId: stored.id, cwd: alias, mcpServers: [] });
		expect(fs.existsSync(stored.file)).toBe(true);
		expect((await SessionManager.list(project)).map(s => [s.id, s.cwd])).toEqual([[stored.id, project]]);
	});
});
