/**
 * Contract: the JetBrains AIR `sessionIndex` extension, as claude-agent-acp
 * ships it and agent-shell consumes it. Only an AIR client that declares
 * `sessionIndex` gets the paged `session/list` with AIR row metadata and the
 * `_session/rename` / `_session/archive` / `_session/unarchive` methods.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSessionWorktreeScope } from "@oh-my-pi/pi-coding-agent/session/settings";
import { ACP_BOOTSTRAP_RACE_GUARD_MS, AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { parseSessionIndexListOptions } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-session-index";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { findSessionFiles, sessionIdFromSessionPath } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type {
	AgentSideConnection,
	ClientCapabilities,
	ListSessionsResponse,
	PromptRequest,
	RequestPermissionResponse,
	SessionInfo,
	SessionNotification,
} from "@oh-my-pi/pi-utils/acp";
import { $ } from "bun";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { makeAssistantMessage } from "./session-manager/helpers";

const MODEL_ID = "claude-sonnet-4-5";

function airCapabilities(capabilities: string[]): ClientCapabilities {
	return { _meta: { jetbrains: { air: { version: 1, capabilities } } } } as ClientCapabilities;
}

function listMeta(list: Record<string, unknown>): Record<string, unknown> {
	return { jetbrains: { air: { version: 1, list } } };
}

function air(row: SessionInfo | undefined): Record<string, unknown> {
	const meta = row?._meta as { jetbrains?: { air?: Record<string, unknown> } } | undefined;
	return meta?.jetbrains?.air ?? {};
}

async function errorCode(promise: Promise<unknown>): Promise<number | undefined> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: number }).code;
	}
	return undefined;
}

/**
 * The sibling a move-off leaves when another process holds `file`: the same
 * entries under a new id whose header names the old one in `continuationOf`,
 * then a later turn.
 */
function writeContinuation(file: string): { id: string; file: string } {
	const records = fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(line => line.trim())
		.map(line => JSON.parse(line) as Record<string, unknown>);
	const header = records.find(record => record.type === "session");
	if (!header) throw new Error("Expected a session header");
	const oldId = header.id as string;
	const id = crypto.randomUUID();
	const movedAt = Date.now() + 1_000;
	Object.assign(header, {
		id,
		timestamp: new Date(movedAt).toISOString(),
		parentSession: oldId,
		continuationOf: oldId,
	});
	records.push({
		type: "message",
		id: "continued-turn",
		parentId: records[records.length - 1].id,
		timestamp: new Date(movedAt + 1_000).toISOString(),
		message: { role: "user", content: "after the move-off", timestamp: movedAt + 1_000 },
	});
	const fileTime = new Date(movedAt).toISOString().replace(/[:.]/g, "-");
	const sibling = path.join(path.dirname(file), `${fileTime}_${id}.jsonl`);
	fs.writeFileSync(sibling, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
	return { id, file: sibling };
}

describe("ACP AIR sessionIndex", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	let root: string;
	let cwd: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let updates: SessionNotification[];
	let permissionAnswers: Array<PromiseWithResolvers<RequestPermissionResponse>>;

	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-acp-index-")));
		setAgentDir(path.join(root, "agent"));
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: root });
		cwd = path.join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessions = [];
		updates = [];
		permissionAnswers = [];
	});

	afterEach(async () => {
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

	/** `capabilities: null` initializes a plain (non-AIR) client. */
	async function createAgent(capabilities: string[] | null = ["sessionIndex"]): Promise<AcpAgent> {
		const model = modelRegistry.find("anthropic", MODEL_ID);
		if (!model) throw new Error(`Expected ${MODEL_ID} to exist in registry`);
		const connection = {
			sessionUpdate: async (notification: SessionNotification) => {
				updates.push(notification);
			},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
			// Each permission request stays open until the test answers it.
			requestPermissionWithCancel: () => {
				const answer = Promise.withResolvers<RequestPermissionResponse>();
				permissionAnswers.push(answer);
				return { promise: answer.promise, cancel: () => {} };
			},
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
		await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: capabilities === null ? {} : airCapabilities(capabilities),
		});
		return agent;
	}

	/** An answered session in `cwd`; each call's prompt is newer than the last. */
	async function storedSession(
		title: string,
		options: { parent?: string } = {},
	): Promise<{ id: string; file: string }> {
		await Bun.sleep(5);
		const manager = options.parent ? await SessionManager.forkFrom(options.parent, cwd) : SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: `about ${title}`, timestamp: Date.now() });
		manager.appendMessage({ ...makeAssistantMessage(), model: MODEL_ID });
		await manager.setSessionName(title, "user");
		await manager.flush();
		await manager.close();
		return { id: manager.getSessionId(), file: manager.getSessionFile()! };
	}

	function list(
		agent: AcpAgent,
		options: Record<string, unknown> = {},
		cursor?: string,
	): Promise<ListSessionsResponse> {
		return agent.listSessions({ cwd, cursor, _meta: listMeta(options) });
	}

	it("advertises the extension only to an AIR client that declares sessionIndex", async () => {
		const withIndex = await new AcpAgent(
			{ signal: new AbortController().signal } as unknown as AgentSideConnection,
			async () => {
				throw new Error("unused");
			},
		).initialize({ protocolVersion: 1, clientCapabilities: airCapabilities(["asyncTasks", "sessionIndex"]) });
		const without = await new AcpAgent(
			{ signal: new AbortController().signal } as unknown as AgentSideConnection,
			async () => {
				throw new Error("unused");
			},
		).initialize({ protocolVersion: 1, clientCapabilities: airCapabilities(["asyncTasks"]) });

		const advertised = (meta: unknown) =>
			(meta as { jetbrains: { air: { capabilities: string[] } } }).jetbrains.air.capabilities;
		expect(advertised(withIndex._meta)).toEqual([
			"asyncTasks",
			"planFile",
			"sessionIndex",
			"sessionArchive",
			"sessionRename",
			"sessionListSubscribe",
			"sessionWorktrees",
		]);
		expect(advertised(without._meta)).toEqual(["asyncTasks", "planFile"]);
	});

	it("answers the session index methods with -32601 when the client did not declare sessionIndex", async () => {
		const { id } = await storedSession("Plain");
		const agent = await createAgent(["asyncTasks"]);

		for (const method of ["_session/rename", "_session/archive", "_session/unarchive"]) {
			expect(await errorCode(agent.extMethod(method, { sessionId: id, title: "x" }))).toBe(-32601);
		}
		// The plain list keeps its shape: no AIR row metadata, mtime-based updatedAt.
		const { sessions: rows } = await agent.listSessions({ cwd, _meta: listMeta({ archived: "all", limit: 1 }) });
		expect(rows.map(row => row.sessionId)).toEqual([id]);
		expect(air(rows[0])).toEqual({});
	});

	it("pages newest prompt first with cursors bound to their scope", async () => {
		const a = await storedSession("A");
		const b = await storedSession("B");
		const c = await storedSession("C");
		const agent = await createAgent();

		const first = await list(agent, { limit: 2 });
		expect(first.sessions.map(row => row.sessionId)).toEqual([c.id, b.id]);
		expect(first.nextCursor).toBeString();
		// limit may change between pages; null means omitted.
		const second = await list(agent, { limit: 5, archived: null, includeWorktrees: null }, first.nextCursor!);
		expect(second.sessions.map(row => row.sessionId)).toEqual([a.id]);
		expect(second.nextCursor).toBeUndefined();

		expect(await errorCode(list(agent, { limit: 2, archived: "all" }, first.nextCursor!))).toBe(-32602);
		expect(await errorCode(list(agent, { limit: 2, includeWorktrees: true }, first.nextCursor!))).toBe(-32602);
		expect(await errorCode(list(agent, { limit: 2 }, "not-a-cursor"))).toBe(-32602);
		expect(await errorCode(list(agent, { limit: 2 }, "5"))).toBe(-32602);
		for (const invalid of [
			{ limit: 0 },
			{ limit: 1.5 },
			{ limit: "5" },
			{ archived: true },
			{ includeWorktrees: "yes" },
		]) {
			expect(await errorCode(list(agent, invalid))).toBe(-32602);
		}
		// Clamped, not rejected.
		expect((await list(agent, { limit: 10_000 })).sessions).toHaveLength(3);
		expect(parseSessionIndexListOptions(listMeta({ limit: 10_000 })).limit).toBe(200);
	});

	it("reports AIR row fields and lists a fork with its parent but not its archived flag", async () => {
		const parent = await storedSession("Parent");
		const agent = await createAgent();
		expect(await agent.extMethod("_session/archive", { sessionId: parent.id })).toEqual({});
		const fork = await storedSession("Fork", { parent: parent.file });

		const { sessions: rows } = await list(agent, { archived: "all" });
		const forkRow = rows.find(row => row.sessionId === fork.id);
		const parentRow = rows.find(row => row.sessionId === parent.id);
		expect(air(forkRow)).toMatchObject({
			version: 1,
			archived: false,
			forkedFrom: parent.id,
			model: MODEL_ID,
			state: "idle",
		});
		expect(Date.parse(air(forkRow).lastPromptAt as string)).toBeGreaterThan(0);
		expect(Date.parse(air(forkRow).lastTurnEndedAt as string)).toBeGreaterThanOrEqual(
			Date.parse(air(forkRow).lastPromptAt as string),
		);
		expect(air(forkRow).cost).toBeUndefined();
		expect(air(parentRow)).toMatchObject({ archived: true });
		expect(air(parentRow).forkedFrom).toBeUndefined();
		// The plain row metadata stays alongside.
		expect(forkRow?._meta).toMatchObject({ messageCount: 4 });
	});

	it("archives and unarchives a session that is not loaded, without moving it in the order", async () => {
		const older = await storedSession("Older");
		const newer = await storedSession("Newer");
		const agent = await createAgent();
		const before = (await list(agent, { archived: "all" })).sessions;

		expect(await agent.extMethod("_session/archive", { sessionId: older.id })).toEqual({});
		expect(await agent.extMethod("_session/archive", { sessionId: older.id })).toEqual({});

		expect((await list(agent)).sessions.map(row => row.sessionId)).toEqual([newer.id]);
		expect((await list(agent, { archived: "archived" })).sessions.map(row => row.sessionId)).toEqual([older.id]);
		const all = (await list(agent, { archived: "all" })).sessions;
		expect(all.map(row => [row.sessionId, row.updatedAt, air(row).archived])).toEqual([
			[newer.id, before[0].updatedAt, false],
			[older.id, before[1].updatedAt, true],
		]);

		expect(await agent.extMethod("_session/unarchive", { sessionId: older.id })).toEqual({});
		expect((await list(agent)).sessions.map(row => row.sessionId)).toEqual([newer.id, older.id]);
		expect(await errorCode(agent.extMethod("_session/archive", { sessionId: "no-such-session" }))).toBe(-32002);
		expect(await errorCode(agent.extMethod("_session/unarchive", { sessionId: "no-such-session" }))).toBe(-32002);
	});

	it("renames a session that is not loaded without moving it or unarchiving it", async () => {
		const older = await storedSession("Older");
		await storedSession("Newer");
		const agent = await createAgent();
		await agent.extMethod("_session/archive", { sessionId: older.id });
		const before = (await list(agent, { archived: "all" })).sessions;

		expect(
			await agent.extMethod("_session/rename", { sessionId: older.id, title: "  [archived] Fixed\n  parser " }),
		).toEqual({});

		const after = (await list(agent, { archived: "all" })).sessions;
		expect(after.map(row => row.sessionId)).toEqual(before.map(row => row.sessionId));
		expect(after[1]).toMatchObject({ title: "Fixed parser", updatedAt: before[1].updatedAt });
		expect(air(after[1]).archived).toBe(true);
		expect(await errorCode(agent.extMethod("_session/rename", { sessionId: older.id, title: " \n " }))).toBe(-32602);
		expect(await errorCode(agent.extMethod("_session/rename", { sessionId: "nope", title: "x" }))).toBe(-32002);
	});

	it("loads the copy a session went on in, under the id the client asked for", async () => {
		const original = await storedSession("Moved");
		const continued = writeContinuation(original.file);
		const agent = await createAgent();
		await agent.loadSession({ sessionId: original.id, cwd, mcpServers: [] });
		await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 20);

		// The live session is the copy, with the turn the original file lacks.
		const loaded = sessions.find(s => s.sessionId === continued.id);
		expect(JSON.stringify(loaded?.sessionManager.getEntries())).toContain("after the move-off");
		// The client hears about it only under its own id, with a notice naming the copy.
		expect(new Set(updates.map(u => u.sessionId))).toEqual(new Set([original.id]));
		expect(JSON.stringify(updates)).toContain(path.basename(continued.file));
		// Later requests on the client's id reach the copy.
		await agent.extMethod("_session/rename", { sessionId: original.id, title: "Renamed" });
		expect(loaded?.sessionManager.getSessionName()).toBe("Renamed");
		// Loading the client's id again reuses the live copy instead of reopening the old file.
		const opened = sessions.length;
		await agent.loadSession({ sessionId: original.id, cwd, mcpServers: [] });
		expect(sessions).toHaveLength(opened);
	});

	it("renames a loaded session through its title and tells the client", async () => {
		const stored = await storedSession("Old title");
		const agent = await createAgent();
		await agent.loadSession({ sessionId: stored.id, cwd, mcpServers: [] });
		await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 20);
		updates.length = 0;

		await agent.extMethod("_session/rename", { sessionId: stored.id, title: "New title" });

		const infoUpdates = updates.filter(u => u.update.sessionUpdate === "session_info_update");
		expect(infoUpdates.map(u => (u.update as { title?: string }).title)).toEqual(["New title"]);
		expect(sessions.find(s => s.sessionId === stored.id)?.sessionManager.getSessionName()).toBe("New title");
		expect((await list(agent)).sessions[0].title).toBe("New title");
	});

	it("archiving a loaded session cancels its turn, closes it, and reports archived last", async () => {
		const stored = await storedSession("Busy");
		const agent = await createAgent();
		await agent.loadSession({ sessionId: stored.id, cwd, mcpServers: [] });
		await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 20);
		const session = sessions.find(s => s.sessionId === stored.id)!;
		// A turn that runs until it is aborted.
		const turnAborted = Promise.withResolvers<void>();
		session.prompt = async () => {
			await turnAborted.promise;
			return true;
		};
		const realAbort = session.abort.bind(session);
		session.abort = async options => {
			turnAborted.resolve();
			await realAbort(options);
		};
		const running = agent.prompt({
			sessionId: stored.id,
			prompt: [{ type: "text", text: "work" }],
		} as PromptRequest);
		await Bun.sleep(10);
		expect(air((await list(agent)).sessions[0]).state).toBe("running");

		expect(await agent.extMethod("_session/archive", { sessionId: stored.id })).toEqual({});

		expect((await running).stopReason).toBe("cancelled");
		const last = updates.at(-1);
		expect(last?.sessionId).toBe(stored.id);
		expect(last?.update).toMatchObject({
			sessionUpdate: "session_info_update",
			_meta: { jetbrains: { air: { archived: true } } },
		});
		await expect(
			agent.prompt({ sessionId: stored.id, prompt: [{ type: "text", text: "again" }] } as PromptRequest),
		).rejects.toThrow();
		expect((await list(agent)).sessions).toHaveLength(0);
		expect(air((await list(agent, { archived: "archived" })).sessions[0]).state).toBe("idle");

		// Unarchive does not load it; a load of the archived session keeps it archived until then.
		await agent.extMethod("_session/unarchive", { sessionId: stored.id });
		expect((await list(agent)).sessions.map(row => row.sessionId)).toEqual([stored.id]);
	});

	it("reports a loaded session's row as requires_action while its permission request is open", async () => {
		const stored = await storedSession("Asking");
		const agent = await createAgent();
		await agent.loadSession({ sessionId: stored.id, cwd, mcpServers: [] });
		await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 20);
		const session = sessions.find(s => s.sessionId === stored.id)!;
		// A turn that asks once, then runs until it is aborted.
		const turnAborted = Promise.withResolvers<void>();
		session.prompt = async () => {
			await session.clientBridge!.requestPermission!(
				{ toolCallId: "call-1", toolName: "bash", title: "rm -rf build", status: "pending" },
				[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
			);
			await turnAborted.promise;
			return true;
		};
		const realAbort = session.abort.bind(session);
		session.abort = async options => {
			turnAborted.resolve();
			await realAbort(options);
		};
		const running = agent.prompt({
			sessionId: stored.id,
			prompt: [{ type: "text", text: "work" }],
		} as PromptRequest);
		await Bun.sleep(10);

		// The client did not opt into `state_update`; the row still says who waits on the user.
		expect(air((await list(agent)).sessions[0]).state).toBe("requires_action");
		permissionAnswers[0].resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
		await Bun.sleep(10);
		expect(air((await list(agent)).sessions[0]).state).toBe("running");

		await agent.cancel({ sessionId: stored.id });
		await running;
	});

	it("unarchiving a loaded session keeps it loaded and reports archived false", async () => {
		const stored = await storedSession("Kept");
		const agent = await createAgent();
		await agent.extMethod("_session/archive", { sessionId: stored.id });
		await agent.loadSession({ sessionId: stored.id, cwd, mcpServers: [] });
		await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 20);
		expect(air((await list(agent, { archived: "archived" })).sessions[0]).archived).toBe(true);
		updates.length = 0;

		await agent.extMethod("_session/unarchive", { sessionId: stored.id });

		expect(updates.map(u => u.update)).toEqual([
			expect.objectContaining({
				sessionUpdate: "session_info_update",
				_meta: { jetbrains: { air: { version: 1, archived: false } } },
			}),
		]);
		expect(air((await list(agent)).sessions[0]).archived).toBe(false);
		// Still loaded: a rename goes through the live session.
		await agent.extMethod("_session/rename", { sessionId: stored.id, title: "Live" });
		expect(sessions.find(s => s.sessionId === stored.id)?.sessionManager.getSessionName()).toBe("Live");
	});

	describe("session/delete", () => {
		/** Stored transcripts of `id`, plus whether its artifacts directory (subagent transcripts) remains. */
		async function onDisk(id: string, file: string): Promise<{ files: string[]; artifacts: boolean }> {
			const files = (await findSessionFiles(id)).filter(found => sessionIdFromSessionPath(found) === id);
			return { files, artifacts: fs.existsSync(file.slice(0, -".jsonl".length)) };
		}

		function withSubagentTranscript(file: string): void {
			const artifacts = file.slice(0, -".jsonl".length);
			fs.mkdirSync(artifacts, { recursive: true });
			fs.writeFileSync(path.join(artifacts, "0-Scout.jsonl"), "{}\n");
		}

		it("a sessionIndex client deletes the transcript and its artifacts; an unknown id is -32002", async () => {
			const stored = await storedSession("Doomed");
			const kept = await storedSession("Kept");
			withSubagentTranscript(stored.file);
			const agent = await createAgent();

			expect(await agent.deleteSession({ sessionId: stored.id })).toEqual({});

			expect(await onDisk(stored.id, stored.file)).toEqual({ files: [], artifacts: false });
			expect((await list(agent, { archived: "all" })).sessions.map(row => row.sessionId)).toEqual([kept.id]);
			expect(await errorCode(agent.deleteSession({ sessionId: stored.id }))).toBe(-32002);
			// A subagent child id is not a stored session: nothing happens, and no error.
			expect(await agent.deleteSession({ sessionId: `${kept.id}:subagent:0-Scout` })).toEqual({});
			expect((await onDisk(kept.id, kept.file)).files).toEqual([kept.file]);
		});

		it("deleting a loaded session cancels its turn, closes it, and leaves no transcript behind", async () => {
			const stored = await storedSession("Busy");
			withSubagentTranscript(stored.file);
			const agent = await createAgent();
			await agent.loadSession({ sessionId: stored.id, cwd, mcpServers: [] });
			await Bun.sleep(ACP_BOOTSTRAP_RACE_GUARD_MS + 20);
			const session = sessions.find(s => s.sessionId === stored.id)!;
			const turnAborted = Promise.withResolvers<void>();
			session.prompt = async () => {
				await turnAborted.promise;
				return true;
			};
			const realAbort = session.abort.bind(session);
			session.abort = async options => {
				turnAborted.resolve();
				await realAbort(options);
			};
			const running = agent.prompt({
				sessionId: stored.id,
				prompt: [{ type: "text", text: "work" }],
			} as PromptRequest);
			await Bun.sleep(10);

			expect(await agent.deleteSession({ sessionId: stored.id })).toEqual({});

			expect((await running).stopReason).toBe("cancelled");
			expect(await onDisk(stored.id, stored.file)).toEqual({ files: [], artifacts: false });
			await expect(
				agent.prompt({ sessionId: stored.id, prompt: [{ type: "text", text: "again" }] } as PromptRequest),
			).rejects.toThrow();
			await Bun.sleep(50);
			expect((await onDisk(stored.id, stored.file)).files).toEqual([]);
		});

		it("a plain client deletes for real and an unknown id succeeds silently", async () => {
			const stored = await storedSession("Plain");
			const agent = await createAgent(null);

			expect(await agent.deleteSession({ sessionId: stored.id })).toEqual({});
			expect((await onDisk(stored.id, stored.file)).files).toEqual([]);
			expect(await agent.deleteSession({ sessionId: stored.id })).toEqual({});
			expect(await agent.deleteSession({ sessionId: "no-such-session" })).toEqual({});
		});

		it("an AIR client without sessionIndex archives instead of deleting", async () => {
			const stored = await storedSession("Done");
			const agent = await createAgent(["asyncTasks"]);

			expect(await agent.deleteSession({ sessionId: stored.id })).toEqual({});

			expect((await onDisk(stored.id, stored.file)).files).toEqual([stored.file]);
			const indexed = await createAgent();
			expect((await list(indexed)).sessions).toHaveLength(0);
			expect((await list(indexed, { archived: "archived" })).sessions.map(row => row.sessionId)).toEqual([
				stored.id,
			]);
			expect(await agent.deleteSession({ sessionId: "no-such-session" })).toEqual({});
		});
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

		it("lists another live worktree's sessions only with includeWorktrees", async () => {
			const here = await storedSession("Here");
			const moved = SessionManager.create(cwd);
			moved.appendMessage({ role: "user", content: "elsewhere", timestamp: Date.now() });
			moved.appendMessage({ ...makeAssistantMessage(), model: MODEL_ID });
			await moved.flush();
			const { path: worktree } = await createSessionWorktree(cwd, Settings.isolated(), "wt/other");
			await moved.moveTo(worktree);
			await moved.close();
			const agent = await createAgent();

			expect((await list(agent)).sessions.map(row => row.sessionId)).toEqual([here.id]);
			const withWorktrees = (await list(agent, { includeWorktrees: true })).sessions;
			expect(withWorktrees.map(row => [row.sessionId, row.cwd])).toEqual([
				[moved.getSessionId(), worktree],
				[here.id, cwd],
			]);
		});

		it("scopes a plain client's list to the directory when session.worktreeScope is directory", async () => {
			const here = await storedSession("Here");
			const moved = SessionManager.create(cwd);
			moved.appendMessage({ role: "user", content: "elsewhere", timestamp: Date.now() });
			moved.appendMessage({ ...makeAssistantMessage(), model: MODEL_ID });
			await moved.flush();
			const { path: worktree } = await createSessionWorktree(cwd, Settings.isolated(), "wt/other");
			await moved.moveTo(worktree);
			await moved.close();
			const agent = await createAgent(null);

			expect((await agent.listSessions({ cwd })).sessions.map(row => row.sessionId).sort()).toEqual(
				[here.id, moved.getSessionId()].sort(),
			);
			cfgSessionWorktreeScope.override(Settings.instance, "directory");
			expect((await agent.listSessions({ cwd })).sessions.map(row => row.sessionId)).toEqual([here.id]);
		});

		it("marks only rows in a live agent-made worktree as agentWorktree", async () => {
			const here = await storedSession("Here");
			const inManaged = SessionManager.create(cwd);
			inManaged.appendMessage({ role: "user", content: "managed", timestamp: Date.now() });
			inManaged.appendMessage({ ...makeAssistantMessage(), model: MODEL_ID });
			await inManaged.flush();
			const { path: managed } = await createSessionWorktree(cwd, Settings.isolated(), "wt/managed");
			await inManaged.moveTo(managed);
			await inManaged.close();
			const manual = path.join(root, "manual-wt");
			await $`git worktree add -q -b manual ${manual}`.cwd(cwd).quiet();
			const inManual = SessionManager.create(manual);
			inManual.appendMessage({ role: "user", content: "manual", timestamp: Date.now() });
			inManual.appendMessage({ ...makeAssistantMessage(), model: MODEL_ID });
			await inManual.flush();
			await inManual.close();
			const agent = await createAgent();

			const flags = async () =>
				Object.fromEntries(
					(await list(agent, { includeWorktrees: true })).sessions.map(row => [
						row.sessionId,
						air(row).agentWorktree,
					]),
				);
			expect(await flags()).toEqual({
				[inManaged.getSessionId()]: true,
				[inManual.getSessionId()]: undefined,
				[here.id]: undefined,
			});

			await $`git worktree remove --force ${managed}`.cwd(cwd).quiet();
			const rows = (await list(agent, { includeWorktrees: true })).sessions;
			const moved = rows.find(row => row.sessionId === inManaged.getSessionId());
			expect(moved?.cwd).toBe(cwd);
			expect(air(moved).agentWorktree).toBeUndefined();
		});

		it("checks a shared worktree cwd once per list rebuild, never caching across rebuilds", async () => {
			const { path: managed } = await createSessionWorktree(cwd, Settings.isolated(), "wt/shared");
			const ids: string[] = [];
			for (const text of ["first", "second", "third"]) {
				const inManaged = SessionManager.create(cwd);
				inManaged.appendMessage({ role: "user", content: text, timestamp: Date.now() });
				inManaged.appendMessage({ ...makeAssistantMessage(), model: MODEL_ID });
				await inManaged.flush();
				await inManaged.moveTo(managed);
				await inManaged.close();
				ids.push(inManaged.getSessionId());
			}
			const agent = await createAgent();
			const gitCalls = spyOn(vcs, "git");
			try {
				const managedChecks = () => gitCalls.mock.calls.filter(([dir]) => dir === managed).length;
				const flags = async () => {
					const rows = (await list(agent, { includeWorktrees: true })).sessions;
					return ids.map(id => air(rows.find(row => row.sessionId === id)).agentWorktree);
				};

				expect(await flags()).toEqual([true, true, true]);
				expect(managedChecks()).toBe(1);
				expect(await flags()).toEqual([true, true, true]);
				expect(managedChecks()).toBe(2);
			} finally {
				gitCalls.mockRestore();
			}
		});
	});
});
