/**
 * The JetBrains AIR live session list: `_session/list/subscribe` pushes the
 * changed rows of a cwd's session list to a `sessionIndex` client as
 * `_session/list/changes`. Wire shapes match claude-agent-acp's
 * `session-index/list-subscriptions.ts`.
 *
 * A subscription covers the `session/list` rows of its cwd in any archive
 * state, the repository's other worktrees included. All subscriptions of one
 * cwd share a {@link Scope}: a non-recursive `fs.watch` on each session
 * directory of the cwd. Subscribing records the current rows as sent and
 * pushes nothing.
 *
 * Events (a watched directory changed, or this connection changed one of its
 * own sessions) are coalesced: the rows are recomputed 150 ms after the last
 * event, at most 1 s after the first. Each subscription compares the rows with
 * what it last sent by signature (`[sessionId, cwd, title, _meta]`, so a
 * change of `updatedAt` alone is no change); a sent session missing from the
 * rows is reported as removed. A rescan every 10 s recomputes the watched
 * directories (a worktree made since) and the rows, which covers events
 * `fs.watch` missed.
 *
 * Delivery is best effort: no resync, no sequence number. Other processes'
 * live sessions are seen only through their transcripts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { RequestError, type SessionInfo } from "@oh-my-pi/pi-utils/acp";

export const LIST_SUBSCRIBE_METHOD = "_session/list/subscribe";
export const LIST_UNSUBSCRIBE_METHOD = "_session/list/unsubscribe";
export const LIST_CHANGES_METHOD = "_session/list/changes";

/** Subscriptions per connection. */
export const MAX_SUBSCRIPTIONS = 128;
const DEBOUNCE_MS = 150;
const MAX_WAIT_MS = 1_000;
const RESCAN_MS = 10_000;

export type ListSubscribeRequest = { cwd: string };
export type ListSubscribeResponse = { subscriptionId: string };
export type ListUnsubscribeRequest = { subscriptionId: string };
export type ListChanges = { subscriptionId: string; sessions: SessionInfo[]; removed: string[] };

/** Coalescing and rescan intervals, in milliseconds. */
export type SessionListTiming = { debounceMs?: number; maxWaitMs?: number; rescanMs?: number };

export type SessionListSubscriptionDeps = SessionListTiming & {
	/** The `session/list` rows of `cwd`: worktrees included, any archive state. */
	rows: (cwd: string) => Promise<SessionInfo[]>;
	/** The session directories holding those rows' transcripts. */
	dirs: (cwd: string) => Promise<string[]>;
	notify: (changes: ListChanges) => Promise<void>;
};

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** `{ cwd }`: an absolute path. Other parameters are ignored. */
export function parseListSubscribeRequest(params: unknown): ListSubscribeRequest {
	const cwd = asRecord(params).cwd;
	if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
		throw RequestError.invalidParams({ cwd }, "params require an absolute cwd");
	}
	return { cwd };
}

/** `{ subscriptionId }`. */
export function parseListUnsubscribeRequest(params: unknown): ListUnsubscribeRequest {
	const subscriptionId = asRecord(params).subscriptionId;
	if (typeof subscriptionId !== "string") {
		throw RequestError.invalidParams(undefined, "params require a subscriptionId");
	}
	return { subscriptionId };
}

/** What a change of a row is compared by: everything but `updatedAt`, which alone is no change. */
export function changeSignature(info: SessionInfo): string {
	return JSON.stringify([info.sessionId, info.cwd, info.title, info._meta ?? null]);
}

type Subscription = {
	id: string;
	scope: Scope;
	/** The signature last sent per session id. */
	sent: Map<string, string>;
};

/** What the subscriptions of one cwd share. */
type Scope = {
	cwd: string;
	subscriptions: Set<Subscription>;
	watchers: Map<string, fs.FSWatcher>;
	/** When the first event of the pending flush arrived. */
	firstEventAt: number | undefined;
	debounceTimer: NodeJS.Timeout | undefined;
	rescanTimer: NodeJS.Timeout | undefined;
	flushing: Promise<void> | undefined;
	/** An event arrived during a flush: flush again once it ends. */
	again: boolean;
	closed: boolean;
};

export class SessionListSubscriptions {
	readonly #deps: SessionListSubscriptionDeps;
	readonly #debounceMs: number;
	readonly #maxWaitMs: number;
	readonly #rescanMs: number;
	readonly #subscriptions = new Map<string, Subscription>();
	readonly #scopes = new Map<string, Scope>();
	#disposed = false;

	constructor(deps: SessionListSubscriptionDeps) {
		this.#deps = deps;
		this.#debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
		this.#maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;
		this.#rescanMs = deps.rescanMs ?? RESCAN_MS;
	}

	async subscribe(cwd: string): Promise<ListSubscribeResponse> {
		if (this.#disposed) throw new Error("Session list subscriptions are disposed");
		if (this.#subscriptions.size >= MAX_SUBSCRIPTIONS) {
			throw RequestError.invalidParams(
				{ reason: "too_many_subscriptions", max: MAX_SUBSCRIPTIONS },
				`At most ${MAX_SUBSCRIPTIONS} session list subscriptions per connection`,
			);
		}
		const key = path.resolve(cwd);
		let scope = this.#scopes.get(key);
		const opened = !scope;
		if (!scope) {
			scope = {
				cwd: key,
				subscriptions: new Set(),
				watchers: new Map(),
				firstEventAt: undefined,
				debounceTimer: undefined,
				rescanTimer: undefined,
				flushing: undefined,
				again: false,
				closed: false,
			};
			this.#scopes.set(key, scope);
		}
		const subscription: Subscription = { id: crypto.randomUUID(), scope, sent: new Map() };
		// Counted now, so concurrent subscribes respect the cap; joined to the
		// scope only once its baseline is complete, so no flush pushes it a
		// half-read list before the client has its id.
		this.#subscriptions.set(subscription.id, subscription);
		try {
			// Watch before the baseline, so a change in between is either in it or flushed after.
			if (opened) await this.#watchDirs(scope);
			for (const row of await this.#deps.rows(key)) subscription.sent.set(row.sessionId, changeSignature(row));
			if (scope.closed || !this.#subscriptions.has(subscription.id)) {
				throw new Error("Session list subscription closed while subscribing");
			}
			scope.subscriptions.add(subscription);
			if (opened) this.#scheduleRescan(scope);
		} catch (error) {
			this.unsubscribe(subscription.id);
			throw error;
		}
		return { subscriptionId: subscription.id };
	}

	/** Idempotent: an unknown id is no error. */
	unsubscribe(subscriptionId: string): void {
		const subscription = this.#subscriptions.get(subscriptionId);
		if (!subscription) return;
		this.#subscriptions.delete(subscriptionId);
		const { scope } = subscription;
		scope.subscriptions.delete(subscription);
		if (scope.subscriptions.size === 0) this.#closeScope(scope);
	}

	/**
	 * A session this connection runs, renamed, archived, deleted or created
	 * changed: every scope recomputes its rows. Its cwd may be a worktree of
	 * another subscription's cwd, so no scope is skipped.
	 */
	markDirty(): void {
		for (const scope of this.#scopes.values()) this.#schedule(scope);
	}

	dispose(): void {
		this.#disposed = true;
		for (const scope of this.#scopes.values()) this.#closeScope(scope);
		this.#subscriptions.clear();
	}

	#closeScope(scope: Scope): void {
		scope.closed = true;
		this.#scopes.delete(scope.cwd);
		for (const subscription of scope.subscriptions) this.#subscriptions.delete(subscription.id);
		scope.subscriptions.clear();
		clearTimeout(scope.debounceTimer);
		clearTimeout(scope.rescanTimer);
		for (const watcher of scope.watchers.values()) watcher.close();
		scope.watchers.clear();
	}

	/** Watch the scope's session directories: open new ones, close those no longer listed. */
	async #watchDirs(scope: Scope): Promise<void> {
		const dirs = new Set((await this.#deps.dirs(scope.cwd)).map(dir => path.resolve(dir)));
		if (scope.closed) return;
		for (const [dir, watcher] of scope.watchers) {
			if (dirs.has(dir)) continue;
			watcher.close();
			scope.watchers.delete(dir);
		}
		for (const dir of dirs) {
			if (scope.watchers.has(dir)) continue;
			let watcher: fs.FSWatcher;
			try {
				watcher = fs.watch(dir, { persistent: false }, () => this.#schedule(scope));
			} catch {
				// Not there yet (a worktree without sessions): the rescan tries again.
				continue;
			}
			watcher.on("error", error => {
				logger.debug("Session list directory watch failed", { dir, error: String(error) });
				watcher.close();
				if (scope.watchers.get(dir) === watcher) scope.watchers.delete(dir);
			});
			scope.watchers.set(dir, watcher);
		}
	}

	#scheduleRescan(scope: Scope): void {
		if (scope.closed) return;
		scope.rescanTimer = setTimeout(() => {
			void this.#watchDirs(scope)
				.catch(error => logger.debug("Session list rescan failed", { cwd: scope.cwd, error: String(error) }))
				.finally(() => {
					this.#schedule(scope);
					this.#scheduleRescan(scope);
				});
		}, this.#rescanMs);
		scope.rescanTimer.unref?.();
	}

	/** Coalesce: flush `debounceMs` after the last event, at most `maxWaitMs` after the first. */
	#schedule(scope: Scope): void {
		if (scope.closed) return;
		if (scope.flushing) {
			scope.again = true;
			return;
		}
		const now = Date.now();
		scope.firstEventAt ??= now;
		const delay = Math.max(0, Math.min(this.#debounceMs, scope.firstEventAt + this.#maxWaitMs - now));
		clearTimeout(scope.debounceTimer);
		scope.debounceTimer = setTimeout(() => this.#startFlush(scope), delay);
		scope.debounceTimer.unref?.();
	}

	#startFlush(scope: Scope): void {
		scope.debounceTimer = undefined;
		scope.firstEventAt = undefined;
		scope.again = false;
		scope.flushing = this.#flush(scope)
			.catch(error => logger.warn("Session list push failed", { cwd: scope.cwd, error: String(error) }))
			.finally(() => {
				scope.flushing = undefined;
				if (scope.again) this.#schedule(scope);
			});
	}

	async #flush(scope: Scope): Promise<void> {
		const rows = await this.#deps.rows(scope.cwd);
		if (scope.closed) return;
		const current = new Map(rows.map(row => [row.sessionId, { row, signature: changeSignature(row) }]));
		const sends: ListChanges[] = [];
		for (const subscription of scope.subscriptions) {
			const sessions: SessionInfo[] = [];
			for (const [sessionId, { row, signature }] of current) {
				if (subscription.sent.get(sessionId) === signature) continue;
				subscription.sent.set(sessionId, signature);
				sessions.push(row);
			}
			const removed: string[] = [];
			for (const sessionId of subscription.sent.keys()) {
				if (current.has(sessionId)) continue;
				subscription.sent.delete(sessionId);
				removed.push(sessionId);
			}
			if (sessions.length > 0 || removed.length > 0) {
				sends.push({ subscriptionId: subscription.id, sessions, removed });
			}
		}
		for (const changes of sends) {
			if (!this.#subscriptions.has(changes.subscriptionId)) continue;
			try {
				await this.#deps.notify(changes);
			} catch (error) {
				logger.warn("Session list push failed", { subscriptionId: changes.subscriptionId, error: String(error) });
			}
		}
	}
}
