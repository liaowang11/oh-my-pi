/**
 * The JetBrains AIR `sessionIndex` ACP extension: `session/list` as a bounded
 * page ordered by last prompt, with AIR row metadata and an archive filter,
 * plus `_session/rename`, `_session/archive` and `_session/unarchive`, and
 * the live list of `acp-session-list-subscriptions.ts`.
 *
 * Only an AIR client that lists `sessionIndex` gets any of it; every other
 * client keeps the plain `session/list`. Wire shapes match claude-agent-acp's
 * session index, so a client needs no omp-specific code. The `[archived] `
 * title prefix that claude-agent-acp stores is not used: omp keeps the flag in
 * the session's title slot.
 */
import { RequestError } from "@oh-my-pi/pi-utils/acp";
import type { ClientCapabilities } from "@oh-my-pi/pi-utils/acp";
import { clientSupportsAirCapability } from "./acp-air";

/** Client-declared capability that turns the extension on. */
export const AIR_SESSION_INDEX_CAPABILITY = "sessionIndex";
/** Advertised with {@link AIR_SESSION_INDEX_CAPABILITY}: `_session/archive` and `_session/unarchive`. */
export const AIR_SESSION_ARCHIVE_CAPABILITY = "sessionArchive";
/** Advertised with {@link AIR_SESSION_INDEX_CAPABILITY}: `_session/rename`. */
export const AIR_SESSION_RENAME_CAPABILITY = "sessionRename";
/** Advertised with {@link AIR_SESSION_INDEX_CAPABILITY}: `_session/list/subscribe` and `_session/list/unsubscribe`. */
export const AIR_SESSION_LIST_SUBSCRIBE_CAPABILITY = "sessionListSubscribe";
/** Advertised with {@link AIR_SESSION_INDEX_CAPABILITY}: list rows mark sessions in an agent-made worktree. */
export const AIR_SESSION_WORKTREES_CAPABILITY = "sessionWorktrees";

export const SESSION_RENAME_METHOD = "_session/rename";
export const SESSION_ARCHIVE_METHOD = "_session/archive";
export const SESSION_UNARCHIVE_METHOD = "_session/unarchive";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
/** The CLI title limit claude-agent-acp keeps: the first 200 characters, trimmed. */
const MAX_TITLE_LENGTH = 200;
const ARCHIVED_TITLE_PREFIX = "[archived] ";
/** Cursor format version; a cursor of another version is rejected. */
const CURSOR_VERSION = 1;

export type ArchivedFilter = "unarchived" | "archived" | "all";
const ARCHIVED_FILTERS: readonly ArchivedFilter[] = ["unarchived", "archived", "all"];

/** `_meta.jetbrains.air.list` of a `session/list` request, defaults applied. */
export type SessionIndexListOptions = { limit: number; includeWorktrees: boolean; archived: ArchivedFilter };

/** The request values a cursor is bound to. */
export type SessionIndexListScope = { cwd: string | null; includeWorktrees: boolean; archived: ArchivedFilter };

/** A position in the list order: the order key and session id of the last row served. */
export type SessionIndexPosition = { orderAtMs: number; sessionId: string };

export type SessionIdRequest = { sessionId: string };
export type RenameSessionRequest = { sessionId: string; title: string };

/** The AIR row state, never `unknown`. `requires_action` is not reported by omp. */
export type SessionIndexState = "running" | "idle" | "requires_action" | "error";

/** Flat `_meta.jetbrains.air` fields of a list row. `archived` is always present. */
export type SessionIndexRowFields = {
	archived: boolean;
	lastPromptAt?: string;
	model?: string;
	forkedFrom?: string;
	state?: SessionIndexState;
	lastTurnEndedAt?: string;
	cost?: { amount: number; currency: "USD" };
	/** The session's cwd is a live git worktree omp made (`/wt`, PR checkout, task isolation). */
	agentWorktree?: true;
};

/** Whether the client declared `sessionIndex`: only then is the extension advertised and served. */
export function clientSupportsSessionIndex(capabilities: ClientCapabilities | undefined): boolean {
	return clientSupportsAirCapability(capabilities, AIR_SESSION_INDEX_CAPABILITY);
}

/** Capabilities advertised to a client that declared `sessionIndex`; none otherwise. */
export function sessionIndexCapabilities(capabilities: ClientCapabilities | undefined): string[] {
	return clientSupportsSessionIndex(capabilities)
		? [
				AIR_SESSION_INDEX_CAPABILITY,
				AIR_SESSION_ARCHIVE_CAPABILITY,
				AIR_SESSION_RENAME_CAPABILITY,
				AIR_SESSION_LIST_SUBSCRIBE_CAPABILITY,
				AIR_SESSION_WORKTREES_CAPABILITY,
			]
		: [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** Validate `params._meta.jetbrains.air.list`. `null` counts as omitted; anything else invalid is `-32602`. */
export function parseSessionIndexListOptions(meta: unknown): SessionIndexListOptions {
	const list = asRecord(asRecord(asRecord(asRecord(meta).jetbrains).air).list);
	const limit = list.limit ?? DEFAULT_LIST_LIMIT;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
		throw RequestError.invalidParams({ limit }, "`_meta.jetbrains.air.list.limit` must be an integer of at least 1");
	}
	const includeWorktrees = list.includeWorktrees ?? false;
	if (typeof includeWorktrees !== "boolean") {
		throw RequestError.invalidParams(
			{ includeWorktrees },
			"`_meta.jetbrains.air.list.includeWorktrees` must be a boolean",
		);
	}
	const archived = list.archived ?? "unarchived";
	if (!ARCHIVED_FILTERS.includes(archived as ArchivedFilter)) {
		throw RequestError.invalidParams(
			{ archived },
			'`_meta.jetbrains.air.list.archived` must be "unarchived", "archived" or "all"',
		);
	}
	return { limit: Math.min(MAX_LIST_LIMIT, limit), includeWorktrees, archived: archived as ArchivedFilter };
}

/** Whether a row with the given archived flag passes the filter. */
export function matchesArchivedFilter(archived: boolean, filter: ArchivedFilter): boolean {
	return filter === "all" || (filter === "archived") === archived;
}

/** List order: order key descending, then session id ascending. */
export function compareSessionIndexPositions(left: SessionIndexPosition, right: SessionIndexPosition): number {
	if (left.orderAtMs !== right.orderAtMs) return right.orderAtMs - left.orderAtMs;
	return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
}

type CursorPayload = { v: number; u: number; id: string; cwd: string | null; archived: string; worktrees: boolean };

/** An opaque cursor naming `position`, bound to the scope it was issued for. */
export function encodeSessionIndexCursor(position: SessionIndexPosition, scope: SessionIndexListScope): string {
	const payload: CursorPayload = {
		v: CURSOR_VERSION,
		u: position.orderAtMs,
		id: position.sessionId,
		cwd: scope.cwd,
		archived: scope.archived,
		worktrees: scope.includeWorktrees,
	};
	return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** The position a cursor names. A cursor of another scope, or one this agent did not issue, is `-32602`. */
export function decodeSessionIndexCursor(cursor: string, scope: SessionIndexListScope): SessionIndexPosition {
	let payload: Partial<CursorPayload> | undefined;
	try {
		payload = asRecord(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))) as Partial<CursorPayload>;
	} catch {
		payload = undefined;
	}
	if (
		!payload ||
		payload.v !== CURSOR_VERSION ||
		typeof payload.u !== "number" ||
		!Number.isFinite(payload.u) ||
		typeof payload.id !== "string"
	) {
		throw RequestError.invalidParams({ cursor }, "Unknown session/list cursor");
	}
	if (
		payload.cwd !== scope.cwd ||
		payload.archived !== scope.archived ||
		payload.worktrees !== scope.includeWorktrees
	) {
		throw RequestError.invalidParams({ cursor }, "The session/list cursor belongs to another cwd or filter");
	}
	return { orderAtMs: payload.u, sessionId: payload.id };
}

/** Validate the params of `_session/archive` and `_session/unarchive`. */
export function parseSessionIdRequest(params: { [key: string]: unknown }): SessionIdRequest {
	const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
	if (!sessionId) throw RequestError.invalidParams(undefined, "params require a non-empty sessionId");
	return { sessionId };
}

/** Validate the params of `_session/rename`; a title that is blank once sanitized is `-32602`. */
export function parseRenameSessionRequest(params: { [key: string]: unknown }): RenameSessionRequest {
	const { sessionId } = parseSessionIdRequest(params);
	const title = typeof params.title === "string" ? sanitizeSessionTitle(params.title) : "";
	if (!title) throw RequestError.invalidParams(undefined, "title must be a non-empty string");
	return { sessionId, title };
}

/**
 * A requested title as stored: whitespace collapsed, any leading
 * `[archived] ` prefix dropped (a rename never changes the archive state),
 * then the first 200 characters, trimmed.
 */
export function sanitizeSessionTitle(raw: string): string {
	let title = raw.replace(/\s+/g, " ").trim();
	while (title.startsWith(ARCHIVED_TITLE_PREFIX)) title = title.slice(ARCHIVED_TITLE_PREFIX.length).trimStart();
	return [...title].slice(0, MAX_TITLE_LENGTH).join("").trim();
}

/** The error for a session id that names no stored session. */
export function sessionNotFound(sessionId: string): RequestError {
	return new RequestError(-32002, `Session not found: ${sessionId}`, { sessionId });
}
