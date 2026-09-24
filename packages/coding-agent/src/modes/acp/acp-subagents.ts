import type { ClientCapabilities, SessionNotification, SubagentState } from "@oh-my-pi/pi-utils/acp";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../../session/agent-session";
import {
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "../../task";
import type { EventBus } from "../../utils/event-bus";
import { mapAgentSessionEventToAcpSessionUpdates } from "./acp-event-mapper";

/**
 * Draft ACP subagent sessions (agent-client-protocol#1992): the client opts in
 * with an object-valued `clientCapabilities.subagents`.
 */
export function clientSupportsSubagents(capabilities: ClientCapabilities | undefined): boolean {
	const value = capabilities?.subagents;
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ChildSession = {
	sessionId: string;
	parentSessionId: string;
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
}

const TERMINAL_STATE: Record<Exclude<SubagentLifecyclePayload["status"], "started">, SubagentState> = {
	completed: "completed",
	failed: "failed",
	aborted: "cancelled",
};

/**
 * Relays the task tool's subagents to the client as child ACP sessions: a
 * `subagent_spawned` on the parent session, the child's own updates under its
 * `subagentSessionId`, then a `subagent_state_update` on the parent when it
 * ends. Nested subagents hang off the child that ran their task tool call.
 */
export class AcpSubagentRelay {
	readonly #options: AcpSubagentRelayOptions;
	readonly #live = new Map<string, ChildSession>();
	// Spawn count per subagent id; an IRC follow-up re-runs a finished id, which
	// gets a fresh child session so the client never revives a closed one.
	readonly #generations = new Map<string, number>();
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
		];
	}

	/** Resolves once every notification queued so far has been delivered. */
	flush(): Promise<void> {
		return this.#chain;
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers.length = 0;
		this.#live.clear();
		this.#toolCallOwner.clear();
	}

	#onLifecycle(payload: SubagentLifecyclePayload): void {
		if (payload.status === "started") {
			if (this.#live.has(payload.id)) return;
			const generation = (this.#generations.get(payload.id) ?? 0) + 1;
			this.#generations.set(payload.id, generation);
			const base = `${this.#options.sessionId}:subagent:${payload.id}`;
			const child: ChildSession = {
				sessionId: generation === 1 ? base : `${base}:generation:${generation}`,
				parentSessionId:
					(payload.parentToolCallId && this.#toolCallOwner.get(payload.parentToolCallId)) ||
					this.#options.sessionId,
				liveMessageId: undefined,
				liveMessageProgress: undefined,
				toolArgsById: new Map(),
			};
			this.#live.set(payload.id, child);
			this.#enqueue({
				sessionId: child.parentSessionId,
				update: {
					sessionUpdate: "subagent_spawned",
					subagentSessionId: child.sessionId,
					name: payload.agent,
					task: payload.description ?? "",
					capabilities: {},
				},
			});
			return;
		}
		const child = this.#live.get(payload.id);
		if (!child) return;
		this.#live.delete(payload.id);
		for (const [toolCallId, owner] of this.#toolCallOwner) {
			if (owner === child.sessionId) this.#toolCallOwner.delete(toolCallId);
		}
		this.#enqueue({
			sessionId: child.parentSessionId,
			update: {
				sessionUpdate: "subagent_state_update",
				subagentSessionId: child.sessionId,
				state: TERMINAL_STATE[payload.status],
			},
		});
	}

	#onEvent(payload: SubagentEventPayload): void {
		const child = this.#live.get(payload.id);
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
