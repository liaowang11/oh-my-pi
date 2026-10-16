/**
 * Contract: the JetBrains AIR live session list, as claude-agent-acp ships it.
 * A `sessionIndex` client subscribes to a cwd with `_session/list/subscribe`
 * and gets `_session/list/changes` notifications carrying the changed
 * `session/list` rows (any archive state, worktrees included) and the ids of
 * sessions that left the list.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ACP_BOOTSTRAP_RACE_GUARD_MS, AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type {
	AgentSideConnection,
	ClientCapabilities,
	PromptRequest,
	SessionInfo,
	SessionNotification,
} from "@oh-my-pi/pi-utils/acp";
import { $ } from "bun";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { makeAssistantMessage } from "./session-manager/helpers";

const MODEL_ID = "claude-sonnet-4-5";

type ListChanges = { subscriptionId: string; sessions: SessionInfo[]; removed: string[] };

function airCapabilities(capabilities: string[]): ClientCapabilities {
	return { _meta: { jetbrains: { air: { version: 1, capabilities } } } } as ClientCapabilities;
}

function air(row: SessionInfo | undefined): Record<string, unknown> {
	const meta = row?._meta as { jetbrains?: { air?: Record<string, unknown> } } | undefined;
	return meta?.jetbrains?.air ?? {};
}

async function rpcError(promise: Promise<unknown>): Promise<{ code?: number; data?: unknown } | undefined> {
	try {
		await promise;
	} catch (error) {
		return error as { code?: number; data?: unknown };
	}
	return undefined;
}

describe("ACP AIR live session list", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	let root: string;
	let cwd: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let agents: AcpAgent[];
	let pushes: Array<{ method: string; params: ListChanges }>;

	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-list-sub-")));
		setAgentDir(path.join(root, "agent"));
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: root });
		cwd = path.join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessions = [];
		agents = [];
		pushes = [];
	});

	afterEach(async () => {
		// The agents own the watchers and timers: dispose them so none outlives the test.
		for (const agent of agents) await agent.dispose();
		for (const session of sessions) await session.dispose();
		authStorage.close();
		resetSettingsForTest();
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(root);
	});

	async function createAgent(capabilities: string[] = ["sessionIndex"]): Promise<AcpAgent> {
		const model = modelRegistry.find("anthropic", MODEL_ID);
		if (!model) throw new Error(`Expected ${MODEL_ID} to exist in registry`);
		const connection = {
			sessionUpdate: async (_notification: SessionNotification) => {},
			extNotification: async (method: string, params: Record<string, unknown>) => {
				pushes.push({ method, params: params as ListChanges });
			},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const agent = new AcpAgent(connection, async sessionCwd => {
			const session = new AgentSession({
				agent: new Agent({
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
					convertToLlm,
				}),
				sessionManager: SessionManager.create(sessionCwd),
				settings: Settings.isolated(),
				modelRegistry,
			});
			sessions.push(session);
			return session;
		});
		agents.push(agent);
		// The rescan alone catches every change fast, so a missed fs.watch event cannot fail a test.
		agent.setSessionListTimingForTesting({ debounceMs: 5, maxWaitMs: 20, rescanMs: 40 });
		await agent.initialize({ protocolVersion: 1, clientCapabilities: airCapabilities(capabilities) });
		return agent;
	}

	async function storedSession(title: string, sessionCwd = cwd): Promise<{ id: string; file: string }> {
		await Bun.sleep(5);
		const manager = SessionManager.create(sessionCwd);
		manager.appendMessage({ role: "user", content: `about ${title}`, timestamp: Date.now() });
		manager.appendMessage({ ...makeAssistantMessage(), model: MODEL_ID });
		await manager.setSessionName(title, "user");
		await manager.flush();
		await manager.close();
		return { id: manager.getSessionId(), file: manager.getSessionFile()! };
	}

	async function subscribe(agent: AcpAgent): Promise<string> {
		const response = await agent.extMethod("_session/list/subscribe", { cwd });
		expect(response).toEqual({ subscriptionId: expect.any(String) });
		return response.subscriptionId as string;
	}

	/** Every pushed row of `sessionId`, oldest first. */
	function rowsOf(sessionId: string): SessionInfo[] {
		return pushes.flatMap(push => push.params.sessions.filter(row => row.sessionId === sessionId));
	}

	async function waitFor(condition: () => boolean, what: string): Promise<void> {
		const deadline = Date.now() + 3000;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
			await Bun.sleep(10);
		}
	}

	it("answers -32601 without sessionIndex and validates its params", async () => {
		const plain = await createAgent(["asyncTasks"]);
		for (const method of ["_session/list/subscribe", "_session/list/unsubscribe"]) {
			expect((await rpcError(plain.extMethod(method, { cwd, subscriptionId: "x" })))?.code).toBe(-32601);
		}

		const agent = await createAgent();
		expect(await rpcError(agent.extMethod("_session/list/subscribe", { cwd: "relative/dir" }))).toMatchObject({
			code: -32602,
			data: { cwd: "relative/dir" },
		});
		expect((await rpcError(agent.extMethod("_session/list/unsubscribe", {})))?.code).toBe(-32602);
		// Unknown ids are fine: unsubscribe is idempotent.
		expect(await agent.extMethod("_session/list/unsubscribe", { subscriptionId: "unknown" })).toEqual({});

		for (let i = 0; i < 128; i++) await subscribe(agent);
		expect(await rpcError(agent.extMethod("_session/list/subscribe", { cwd }))).toMatchObject({
			code: -32602,
			data: { reason: "too_many_subscriptions", max: 128 },
		});
	});

	it("pushes a new stored session with its session/list row and stops after unsubscribe", async () => {
		const before = await storedSession("Before");
		const agent = await createAgent();
		const subscriptionId = await subscribe(agent);

		const added = await storedSession("Added");
		await waitFor(() => rowsOf(added.id).length > 0, "the new session's row");

		expect(pushes[0].method).toBe("_session/list/changes");
		expect(pushes.every(push => push.params.subscriptionId === subscriptionId)).toBe(true);
		// Subscribing sends nothing: the session already listed is no change.
		expect(rowsOf(before.id)).toEqual([]);
		const listed = (
			await agent.listSessions({ cwd, _meta: { jetbrains: { air: { version: 1, list: { archived: "all" } } } } })
		).sessions.find(row => row.sessionId === added.id);
		expect(rowsOf(added.id).at(-1)).toEqual(listed!);

		expect(await agent.extMethod("_session/list/unsubscribe", { subscriptionId })).toEqual({});
		const seen = pushes.length;
		await storedSession("After unsubscribe");
		await Bun.sleep(150);
		expect(pushes).toHaveLength(seen);
	});

	it("pushes a rename and an archive of an unloaded session, and a delete as removed", async () => {
		const stored = await storedSession("Old title");
		const agent = await createAgent();
		await subscribe(agent);

		await agent.extMethod("_session/rename", { sessionId: stored.id, title: "New title" });
		await waitFor(() => rowsOf(stored.id).some(row => row.title === "New title"), "the renamed row");

		await agent.extMethod("_session/archive", { sessionId: stored.id });
		await waitFor(() => rowsOf(stored.id).some(row => air(row).archived === true), "the archived row");
		expect(pushes.flatMap(push => push.params.removed)).toEqual([]);

		await agent.deleteSession({ sessionId: stored.id });
		await waitFor(() => pushes.some(push => push.params.removed.includes(stored.id)), "the removal");
	});

	it("pushes a loaded session's turn as running, then idle", async () => {
		const stored = await storedSession("Busy");
		const agent = await createAgent();
		await agent.loadSession({ sessionId: stored.id, cwd, mcpServers: [] });
		await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 20);
		await subscribe(agent);
		const session = sessions.find(s => s.sessionId === stored.id)!;
		const finishTurn = Promise.withResolvers<void>();
		session.prompt = async () => {
			await finishTurn.promise;
			return true;
		};
		const realAbort = session.abort.bind(session);
		session.abort = async options => {
			finishTurn.resolve();
			await realAbort(options);
		};

		const running = agent.prompt({ sessionId: stored.id, prompt: [{ type: "text", text: "work" }] } as PromptRequest);
		await waitFor(() => rowsOf(stored.id).some(row => air(row).state === "running"), "the running row");
		await agent.cancel({ sessionId: stored.id });
		await running;
		await waitFor(() => air(rowsOf(stored.id).at(-1)).state === "idle", "the idle row");
	});

	describe.skipIf(process.platform === "win32")("in a git repository", () => {
		const gitEnvKeys = [
			"GIT_CONFIG_GLOBAL",
			"GIT_CONFIG_NOSYSTEM",
			"GIT_AUTHOR_NAME",
			"GIT_AUTHOR_EMAIL",
			"GIT_COMMITTER_NAME",
			"GIT_COMMITTER_EMAIL",
			"OMP_WORKTREE_DIR",
		] as const;
		const originalEnv = Object.fromEntries(gitEnvKeys.map(key => [key, process.env[key]]));

		beforeEach(async () => {
			Object.assign(process.env, {
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@example.com",
				OMP_WORKTREE_DIR: path.join(root, "wt-base"),
			});
			await $`git init -q && git commit -q --allow-empty -m init`.cwd(cwd).quiet();
		});

		afterEach(() => {
			for (const key of gitEnvKeys) {
				if (originalEnv[key] === undefined) delete process.env[key];
				else process.env[key] = originalEnv[key];
			}
		});

		it("pushes a session of a worktree made after subscribing, under the worktree's cwd", async () => {
			const agent = await createAgent();
			await subscribe(agent);

			const { path: worktree } = await createSessionWorktree(cwd, Settings.isolated(), "wt/later");
			const inWorktree = await storedSession("In worktree", worktree);

			await waitFor(() => rowsOf(inWorktree.id).length > 0, "the worktree session's row");
			expect(rowsOf(inWorktree.id).at(-1)).toMatchObject({ cwd: worktree });
			expect(air(rowsOf(inWorktree.id).at(-1)).agentWorktree).toBe(true);
		});
	});
});
