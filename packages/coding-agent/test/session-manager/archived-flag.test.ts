/**
 * Contract: a session's archived flag lives in its fixed-width title slot. It
 * can be set on a session no process has loaded without rewriting the
 * transcript, it survives renames and reloads, the session listing reports it,
 * and a copy under a new session id (fork) starts unarchived.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { readSessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getConfigRootDir, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

describe("session archived flag", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	let root: string;
	let cwd: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-archived-")));
		cwd = path.join(root, "cwd");
		fs.mkdirSync(cwd, { recursive: true });
		setAgentDir(path.join(root, "agent"));
	});

	afterEach(() => {
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		removeSyncWithRetries(root);
	});

	async function answeredSession(title?: string): Promise<{ id: string; file: string }> {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		if (title) await session.setSessionName(title, "user");
		await session.flush();
		await session.close();
		return { id: session.getSessionId(), file: session.getSessionFile()! };
	}

	it("archives an unloaded session in place, keeping its transcript and title", async () => {
		const { id, file } = await answeredSession("Fix the parser");
		const before = fs.readFileSync(file);

		await SessionManager.updateStoredSessionMeta({ path: file, id }, { archived: true });

		const after = fs.readFileSync(file);
		// Only the fixed-width first line changed: same size, same transcript bytes.
		expect(after.length).toBe(before.length);
		const slotEnd = before.indexOf(0x0a) + 1;
		expect(after.subarray(slotEnd).equals(before.subarray(slotEnd))).toBe(true);
		const info = await readSessionInfo(file);
		expect(info?.archived).toBe(true);
		expect(info?.title).toBe("Fix the parser");

		await SessionManager.updateStoredSessionMeta({ path: file, id }, { archived: false });
		expect((await readSessionInfo(file))?.archived).toBe(false);
	});

	it("keeps the flag through a rename of a loaded session and a reload", async () => {
		const { file } = await answeredSession("Old");
		const loaded = await SessionManager.open(file);
		await loaded.setArchived(true);
		await loaded.setSessionName("New", "user");
		await loaded.flush();
		await loaded.close();

		const info = await readSessionInfo(file);
		expect(info?.title).toBe("New");
		expect(info?.archived).toBe(true);
		const reopened = await SessionManager.open(file);
		expect(reopened.isArchived()).toBe(true);
		await reopened.close();
	});

	it("renames an unloaded session in place without unarchiving it", async () => {
		const { id, file } = await answeredSession("Old");
		await SessionManager.updateStoredSessionMeta({ path: file, id }, { archived: true });
		await SessionManager.updateStoredSessionMeta({ path: file, id }, { title: "Renamed" });

		const info = await readSessionInfo(file);
		expect(info?.title).toBe("Renamed");
		expect(info?.archived).toBe(true);
		const reopened = await SessionManager.open(file);
		expect(reopened.getSessionName()).toBe("Renamed");
		expect(reopened.titleSource).toBe("user");
		await reopened.close();
	});

	it("archives a legacy session file that has no title slot", async () => {
		const { id, file } = await answeredSession("Legacy");
		const content = fs.readFileSync(file, "utf8");
		// Drop the title slot line: files written before the slot existed start with the header.
		fs.writeFileSync(file, content.slice(content.indexOf("\n") + 1));
		expect((await readSessionInfo(file))?.archived).toBe(false);

		await SessionManager.updateStoredSessionMeta({ path: file, id }, { archived: true });

		const info = await readSessionInfo(file);
		expect(info?.archived).toBe(true);
		expect(info?.messageCount).toBe(2);
	});

	it("does not carry the flag into a fork", async () => {
		const { id, file } = await answeredSession("Parent");
		await SessionManager.updateStoredSessionMeta({ path: file, id }, { archived: true });

		const forked = await SessionManager.forkFrom(file, cwd);
		await forked.flush();
		const forkedFile = forked.getSessionFile()!;
		await forked.close();
		expect((await readSessionInfo(forkedFile))?.archived).toBe(false);

		const loaded = await SessionManager.open(file);
		const result = await loaded.fork();
		await loaded.flush();
		await loaded.close();
		expect((await readSessionInfo(result!.newSessionFile))?.archived).toBe(false);
		expect((await readSessionInfo(file))?.archived).toBe(true);
	});
});
