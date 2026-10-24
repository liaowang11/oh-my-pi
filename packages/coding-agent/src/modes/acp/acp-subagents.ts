import { logger } from "@oh-my-pi/pi-utils";
import {
	type ClientCapabilities,
	RequestError,
	type SessionNotification,
	type SubagentUpdate,
	type SubagentWorkState,
} from "@oh-my-pi/pi-utils/acp";
import { cancelLiveSubagent } from "../../registry/cancel-subagent";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { MountedMCPToolRouteSource } from "../../session/session-tools";
import {
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../task";
import type { EventBus } from "../../utils/event-bus";
import { mapAgentSessionEventToAcpSessionUpdates } from "./acp-event-mapper";

/**
 * ACP subagents RFD: the client opts in with an object-valued
 * `clientCapabilities.subagents`.
 */
export function clientSupportsSubagents(capabilities: ClientCapabilities | undefined): boolean {
	const value = capabilities?.subagents;
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The ACP session id of subagent `id` under root session `rootSessionId`, live and replayed alike. */
export function subagentSessionId(rootSessionId: string, id: string): string {
	return `${rootSessionId}:subagent:${id}`;
}

/** Whether `sessionId` names a relayed subagent child (see {@link subagentSessionId}), not a stored session. */
export function isSubagentSessionId(sessionId: string): boolean {
	return sessionId.includes(":subagent:");
}

/**
 * The title of subagent `id` running agent type `agent`, live and replayed
 * alike: `"id (agent)"`, or the bare id when the type is unknown or the same
 * (claude-agent-acp's `"name (agentType)"`).
 */
export function subagentTitle(id: string, agent: string | undefined): string {
	const type = agent?.trim();
	return type && type !== id ? `${id} (${type})` : id;
}

/** A child of a loaded or resumed session; see {@link AcpSubagentRelay.restore}. */
export interface RestoredSubagent {
	sessionId: string;
	parentSessionId: string;
	title: string;
	description: string | undefined;
	prompts: number;
	/** Whether a replay already announced it on this connection. */
	announced: boolean;
}

type ChildSession = {
	sessionId: string;
	parentSessionId: string;
	title: string;
	description: string | undefined;
	announced: boolean;
	running: boolean;
	// The current run's transcript, from its `started` frame; it pins the
	// registry ref a cancel may kill. Unset for a restored child until it runs.
	sessionFile: string | undefined;
	// Whether the current run's assignment went out as a `session_message`.
	promptSent: boolean;
	prompts: number;
	liveMessageId: string | undefined;
	liveMessageProgress: { textEmitted: boolean; thoughtEmitted: boolean } | undefined;
	toolArgsById: Map<string, unknown>;
};

export interface AcpSubagentRelayOptions {
	sessionId: string;
	eventBus: EventBus;
	send: (notification: SessionNotification) => Promise<void>;
	getCwd: () => string;
	resolveImageData?: (data: string, mimeType: string | undefined) => string;
	/** Whether the client may cancel a running child with `session/cancel` on its id. */
	cancellable: boolean;
	/** Whether the client is an AIR client (see the event mapper's option). */
	airClient?: boolean;
	/** Registered tool lookup for the MCP tag (see the event mapper's option). */
	lookupTool?: (toolName: string) => MountedMCPToolRouteSource | undefined;
}

const IDLE_STATE: Record<Exclude<SubagentLifecyclePayload["status"], "started">, SubagentWorkState> = {
	completed: { state: "idle", stopReason: "end_turn" },
	failed: { state: "idle", stopReason: "error" },
	aborted: { state: "idle", stopReason: "cancelled" },
};

/**
 * Relays the task tool's subagents to the client as child ACP sessions (ACP
 * subagents RFD). A `subagent_update` on the parent announces the child as
 * running before any of its traffic; its assignment is a `session_message` on
 * the child; its own updates carry the child's session id; and it goes idle on
 * the parent when its run ends. A subagent that runs again (an IRC follow-up)
 * keeps its session and goes running again. Nested subagents hang off the
 * child that ran their task tool call.
 */
export class AcpSubagentRelay {
	readonly #options: AcpSubagentRelayOptions;
	readonly #children = new Map<string, ChildSession>();
	// Tool call id -> ACP session that issued it, to parent nested spawns.
	readonly #toolCallOwner = new Map<string, string>();
	readonly #unsubscribers: Array<() => void>;
	#chain: Promise<void> = Promise.resolve();

	constructor(options: AcpSubagentRelayOptions) {
		this.#options = options;
		this.#unsubscribers = [
			options.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data =>
				this.#onLifecycle(data as SubagentLifecyclePayload),
			),
			options.eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => this.#onEvent(data as SubagentEventPayload)),
			options.eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => this.#onProgress(data as SubagentProgressPayload)),
		];
	}

	/** Resolves once every notification queued so far has been delivered. */
	flush(): Promise<void> {
		return this.#chain;
	}

	/**
	 * Stop relaying. A child still running is reported idle/cancelled first:
	 * the session that owns it is going away (close/shutdown kills its
	 * subagents after this, when nothing relays their end any more), and the
	 * client must not keep it running forever. Resolves once those reports
	 * are delivered.
	 */
	dispose(): Promise<void> {
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers.length = 0;
		for (const child of this.#children.values()) {
			if (child.running) this.#settle(child, IDLE_STATE.aborted);
		}
		this.#children.clear();
		this.#toolCallOwner.clear();
		return this.#chain;
	}

	/** The ACP session id of subagent `id`, live or restored, or `undefined` if this relay does not know it. */
	sessionIdOf(id: string): string | undefined {
		return this.#children.get(id)?.sessionId;
	}

	/**
	 * Registers an idle child of a loaded or resumed session, so a later run
	 * continues its session and prompt numbering. One a replay did not
	 * announce is announced, ancestors first, when it runs again.
	 */
	restore(id: string, child: RestoredSubagent): void {
		if (this.#children.has(id)) return;
		this.#children.set(id, {
			...child,
			running: false,
			sessionFile: undefined,
			promptSent: false,
			liveMessageId: undefined,
			liveMessageProgress: undefined,
			toolArgsById: new Map(),
		});
	}

	#onLifecycle(payload: SubagentLifecyclePayload): void {
		if (payload.status === "started") {
			const known = this.#children.get(payload.id);
			if (known?.running) return;
			if (known) {
				this.#announce(known);
				known.running = true;
				known.sessionFile = payload.sessionFile;
				known.promptSent = false;
				this.#patch(known, { state: { state: "running" }, ...this.#cancelCapability(known) });
				this.#sendPrompt(known, payload.assignment);
				return;
			}
			const child: ChildSession = {
				sessionId: subagentSessionId(this.#options.sessionId, payload.id),
				parentSessionId:
					(payload.parentToolCallId && this.#toolCallOwner.get(payload.parentToolCallId)) ||
					this.#options.sessionId,
				title: subagentTitle(payload.id, payload.agent),
				description: payload.description?.trim() || undefined,
				announced: true,
				running: true,
				sessionFile: payload.sessionFile,
				promptSent: false,
				prompts: 0,
				liveMessageId: undefined,
				liveMessageProgress: undefined,
				toolArgsById: new Map(),
			};
			this.#children.set(payload.id, child);
			this.#patch(child, {
				title: child.title,
				...(child.description ? { description: child.description } : {}),
				state: { state: "running" },
				...this.#cancelCapability(child),
			});
			this.#sendPrompt(child, payload.assignment);
			return;
		}
		const child = this.#children.get(payload.id);
		if (!child?.running) return;
		this.#sendPrompt(child, payload.assignment);
		// A failure's text goes with it, as `error` on the idle state (ACP subagents RFD).
		const error = payload.status === "failed" ? payload.error?.trim() : undefined;
		this.#settle(
			child,
			error
				? {
						state: "idle",
						stopReason: "error",
						error: { code: RequestError.internalError().code, message: error },
					}
				: IDLE_STATE[payload.status],
			this.#descriptionPatch(child, payload.description),
		);
	}

	// Ends the child's run on its parent, withdrawing an advertised cancel.
	#settle(child: ChildSession, state: SubagentWorkState, labels: { description?: string } = {}): void {
		const cancelAdvertised = this.#canCancel(child);
		child.running = false;
		this.#patch(child, { ...labels, state, ...(cancelAdvertised ? { capabilities: null } : {}) });
	}

	/**
	 * Hard-kills the running subagent behind child session `childSessionId`, as
	 * RPC `cancel_subagent` does. The child goes idle/cancelled through its real
	 * `aborted` lifecycle frame, and the owning task call settles as aborted;
	 * the parent turn keeps running. Resolves `false` (a no-op) for an unknown,
	 * finished, or not cancellable child.
	 */
	cancelChild(childSessionId: string): Promise<boolean> {
		for (const [id, child] of this.#children) {
			if (child.sessionId !== childSessionId) continue;
			if (!this.#canCancel(child) || !child.sessionFile) return Promise.resolve(false);
			return cancelLiveSubagent(id, child.sessionFile);
		}
		return Promise.resolve(false);
	}

	// Cancel is advertised only when it can work: a running run whose
	// transcript pins its registry ref, for a client that may cancel children.
	#canCancel(child: ChildSession): boolean {
		return this.#options.cancellable && child.running && child.sessionFile !== undefined;
	}

	#cancelCapability(child: ChildSession): Pick<SubagentUpdate, "capabilities"> {
		return this.#canCancel(child) ? { capabilities: { cancel: {} } } : {};
	}

	#onProgress(payload: SubagentProgressPayload): void {
		const child = this.#children.get(payload.progress.id);
		if (!child?.running) return;
		this.#sendPrompt(child, payload.assignment);
		const patch = this.#descriptionPatch(child, payload.progress.description);
		if (patch.description) this.#patch(child, patch);
	}

	// Announces a restored child, and before it each unannounced ancestor,
	// parent first and with no work state.
	#announce(child: ChildSession): void {
		if (child.announced) return;
		child.announced = true;
		for (const parent of this.#children.values()) {
			if (parent.sessionId === child.parentSessionId) this.#announce(parent);
		}
		this.#patch(child, { title: child.title, ...(child.description ? { description: child.description } : {}) });
	}

	#descriptionPatch(child: ChildSession, description: string | undefined): { description?: string } {
		const label = description?.trim();
		if (!label || label === child.description) return {};
		child.description = label;
		return { description: label };
	}

	#patch(child: ChildSession, fields: Omit<SubagentUpdate, "sessionId">): void {
		this.#enqueue({
			sessionId: child.parentSessionId,
			update: { sessionUpdate: "subagent_update", sessionId: child.sessionId, ...fields },
		});
	}

	// The run's assignment is the child's prompt: a message from its parent,
	// sent once per run, after the announcement.
	#sendPrompt(child: ChildSession, assignment: string | undefined): void {
		const text = assignment?.trim();
		if (child.promptSent || !text) return;
		child.promptSent = true;
		child.prompts += 1;
		this.#enqueue({
			sessionId: child.sessionId,
			update: {
				sessionUpdate: "session_message",
				messageId: `${child.sessionId}:prompt:${child.prompts}`,
				senderSessionId: child.parentSessionId,
				recipientSessionId: child.sessionId,
				content: [{ type: "text", text }],
			},
		});
	}

	#onEvent(payload: SubagentEventPayload): void {
		const child = this.#children.get(payload.id);
		if (!child) return;
		const { event } = payload;
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			child.toolArgsById.set(event.toolCallId, event.args);
			this.#toolCallOwner.set(event.toolCallId, child.sessionId);
		}
		prepareLiveMessage(child, event);
		const notifications = mapAgentSessionEventToAcpSessionUpdates(event, child.sessionId, {
			getMessageId: message => (isObject(message) ? (child.liveMessageId ??= crypto.randomUUID()) : undefined),
			getMessageProgress: message =>
				isObject(message)
					? (child.liveMessageProgress ??= { textEmitted: false, thoughtEmitted: false })
					: undefined,
			getToolArgs: toolCallId => child.toolArgsById.get(toolCallId),
			cwd: this.#options.getCwd(),
			resolveImageData: this.#options.resolveImageData,
			airClient: this.#options.airClient,
			lookupTool: this.#options.lookupTool,
		});
		if (event.type === "tool_execution_end") child.toolArgsById.delete(event.toolCallId);
		if (event.type === "message_end" && event.message.role === "assistant") {
			child.liveMessageId = undefined;
			child.liveMessageProgress = undefined;
		}
		for (const notification of notifications) this.#enqueue(notification);
	}

	// Events arrive synchronously in order; map them immediately (message state
	// is order-dependent) and deliver on one chain so the wire keeps that order.
	#enqueue(notification: SessionNotification): void {
		this.#chain = this.#chain.then(async () => {
			try {
				await this.#options.send(notification);
			} catch (error) {
				logger.warn("Failed to relay ACP subagent update", {
					sessionId: notification.sessionId,
					update: notification.update.sessionUpdate,
					error: String(error),
				});
			}
		});
	}
}

function isObject(value: unknown): boolean {
	return typeof value === "object" && value !== null;
}

function prepareLiveMessage(child: ChildSession, event: AgentSessionEvent): void {
	if (
		(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
		event.message.role === "assistant" &&
		(event.type === "message_start" || !child.liveMessageId || !child.liveMessageProgress)
	) {
		child.liveMessageId = crypto.randomUUID();
		child.liveMessageProgress = { textEmitted: false, thoughtEmitted: false };
	}
}
