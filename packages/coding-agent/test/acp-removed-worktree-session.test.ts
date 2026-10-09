/**
 * Contract: an ACP client in a checkout of a repository can list, load, and
 * resume a session recorded in a since-removed worktree of that repository
 * (e.g. a `/wt` worktree). The session moves into the request cwd, like
 * `omp --resume` does; its own directory cannot be entered.
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
import { resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";
import { $ } from "bun";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { makeAssistantMessage } from "./session-manager/helpers";

/** Host git config (signing, hooks) must not leak into the fixture repo; worktrees stay under the temp root. */
const TEST_ENV_KEYS = [
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"OMP_WORKTREE_DIR",
] as const;

describe.skipIf(process.platform === "win32")("ACP sessions from removed git worktrees", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalEnv = Object.fromEntries(TEST_ENV_KEYS.map(key => [key, process.env[key]]));
	let root: string;
	let repo: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let updates: SessionNotification[];

	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-wt-")));
		Object.assign(process.env, {
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
			OMP_WORKTREE_DIR: path.join(root, "wt-base"),
		});
		setAgentDir(path.join(root, "agent"));
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: root });
		repo = path.join(root, "repo");
		fs.mkdirSync(repo, { recursive: true });
		await $`git init -q && git commit -q --allow-empty -m init`.cwd(repo).quiet();
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
		resetSessionIndexForTests();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		for (const key of TEST_ENV_KEYS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
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

	/** Runs `/wt`'s worktree creation and session move for a fresh answered session in `repo`. */
	async function sessionMovedByWt(branch: string): Promise<{ id: string; worktree: string; file: string }> {
		const session = SessionManager.create(repo);
		session.appendMessage({ role: "user", content: `work on ${branch}`, timestamp: 1 });
		// The model the ACP session runs, so `switchSession` can restore it.
		session.appendMessage({ ...makeAssistantMessage(), model: "claude-sonnet-4-5" });
		await session.flush();
		const { path: worktree } = await createSessionWorktree(repo, Settings.isolated(), branch);
		await session.moveTo(worktree);
		await session.close();
		return { id: session.getSessionId(), worktree, file: session.getSessionFile()! };
	}

	async function removeWorktree(worktree: string): Promise<void> {
		// `omp worktree clear` removes and prunes: git no longer knows the worktree.
		await $`git worktree remove --force ${worktree} && git worktree prune`.cwd(repo).quiet();
	}

	it("lists a removed worktree's session under the request cwd, and a live one under its own", async () => {
		const gone = await sessionMovedByWt("wt/gone");
		const live = await sessionMovedByWt("wt/live");
		await removeWorktree(gone.worktree);

		const { sessions: listed } = await createAgent().listSessions({ cwd: repo });
		const cwdById = Object.fromEntries(listed.map(s => [s.sessionId, s.cwd]));
		expect(cwdById).toEqual({ [gone.id]: repo, [live.id]: live.worktree });
	});

	for (const method of ["loadSession", "resumeSession"] as const) {
		it(`${method} moves a removed worktree's session into the request cwd`, async () => {
			const gone = await sessionMovedByWt(`wt/${method}`);
			await removeWorktree(gone.worktree);

			const agent = createAgent();
			await agent[method]({ sessionId: gone.id, cwd: repo, mcpServers: [] });

			const opened = sessions.find(s => s.sessionId === gone.id);
			expect(opened?.sessionManager.getCwd()).toBe(repo);
			expect(opened?.sessionManager.buildSessionContext().messages.map(m => m.role)).toEqual(["user", "assistant"]);
			expect((await SessionManager.list(repo)).map(s => [s.id, s.cwd])).toEqual([[gone.id, repo]]);
			expect(fs.existsSync(gone.file)).toBe(false);
		});
	}

	it("unstable_forkSession forks a removed worktree's session into the request cwd and leaves the source in place", async () => {
		const gone = await sessionMovedByWt("wt/fork");
		await removeWorktree(gone.worktree);

		const forked = await createAgent().unstable_forkSession({ sessionId: gone.id, cwd: repo, mcpServers: [] });

		const fork = sessions.find(s => s.sessionId === forked.sessionId);
		expect(forked.sessionId).not.toBe(gone.id);
		expect(fork?.sessionManager.getCwd()).toBe(repo);
		expect(fork?.sessionManager.getHeader()?.parentSession).toBe(gone.id);
		expect(fork?.sessionManager.buildSessionContext().messages.map(m => m.role)).toEqual(["user", "assistant"]);
		// Forking copies, like `omp --fork`: the source keeps its file and recorded cwd.
		const source = await SessionManager.open(gone.file);
		expect(source.getHeader()?.cwd).toBe(gone.worktree);
		await source.close();
	});
});
