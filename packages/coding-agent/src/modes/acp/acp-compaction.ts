/**
 * ACP context compaction reporting (unstable session-compaction RFD).
 *
 * A client that advertises `clientCapabilities.session.compaction` gets an
 * ID-addressed `compaction_update` lifecycle: `in_progress`, then one terminal
 * `completed` (with the summary), `failed` (with the error), or `cancelled`.
 * Every other client gets a synthetic "Compact conversation" tool call
 * (kind `think`) whose content shows the summary; a skipped compaction closes
 * it as completed with a "Compaction skipped" line rather than as failed. JetBrains AIR clients get the compaction facts under
 * `_meta.jetbrains.air.contextCompaction`. Shapes match claude-agent-acp's
 * `context-compaction.ts` and `tool-calls/reporters/compaction.ts`.
 *
 * omp has no streamed compaction summary, so `compaction_summary_chunk` is
 * never sent.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ClientCapabilities, SessionUpdate, ToolCallContent } from "@oh-my-pi/pi-utils/acp";
import { withAirMeta } from "./acp-air";

/** AIR `_meta.jetbrains.air` key of the compaction facts. */
export const AIR_CONTEXT_COMPACTION_KEY = "contextCompaction";
const CONTEXT_COMPACTION_META_VERSION = 1;
const TOOL_TITLE = "Compact conversation";

export type CompactionPresentation = "compaction_update" | "tool_call";
export type CompactionTerminalStatus = "completed" | "failed" | "cancelled";

/** Facts about one compaction; AIR gets them in `_meta`, other tool-call clients in `rawOutput`. */
export interface ContextCompactionFacts {
	trigger?: "manual" | "automatic";
	preTokens?: number;
	postTokens?: number;
	durationMs?: number;
}

export interface CompactionOutcome {
	status: CompactionTerminalStatus;
	/** Retained summary; sent only on `completed`. */
	summary?: string;
	/**
	 * A benign skip (nothing to compact, no model) reported with status
	 * `cancelled`; a tool-call client sees it completed as "Compaction skipped".
	 */
	skipped?: { reason?: string };
	/** Failure text; sent only on `failed`. */
	error?: string;
	preTokens?: number;
	postTokens?: number;
}

export interface CompactionReportOptions {
	presentation: CompactionPresentation;
	airClient: boolean;
}

/** Whether the client advertised `clientCapabilities.session.compaction` (an object). */
export function clientSupportsCompactionUpdates(capabilities: ClientCapabilities | undefined): boolean {
	const compaction = capabilities?.session?.compaction;
	return typeof compaction === "object" && compaction !== null && !Array.isArray(compaction);
}

/** `_meta.jetbrains.air.contextCompaction` carrying `facts`. */
export function contextCompactionMeta(facts: ContextCompactionFacts = {}): Record<string, unknown> {
	return withAirMeta(undefined, AIR_CONTEXT_COMPACTION_KEY, { version: CONTEXT_COMPACTION_META_VERSION, ...facts });
}

function toolCallMeta(facts: ContextCompactionFacts, airClient: boolean): Record<string, unknown> {
	return airClient ? contextCompactionMeta(facts) : { claudeCode: { toolName: "compact" } };
}

function textContent(text: string): ToolCallContent {
	return { type: "content", content: { type: "text", text } };
}

/** The synthetic "Compact conversation" tool call for a client without `compaction_update`. */
export const compactionToolCall = {
	started(toolCallId: string, airClient: boolean): SessionUpdate {
		return {
			sessionUpdate: "tool_call",
			toolCallId,
			title: TOOL_TITLE,
			kind: "think",
			status: "in_progress",
			_meta: toolCallMeta({}, airClient),
		};
	},

	/**
	 * The terminal report; `first` makes it a complete `tool_call` (replay).
	 * A completed compaction shows its summary. ACP tool calls have no
	 * cancelled state: a skipped compaction reports `completed` with a
	 * "Compaction skipped" line, any other cancelled one `failed` with a
	 * "Compaction cancelled" line instead of staying in progress.
	 */
	finished(
		toolCallId: string,
		status: CompactionTerminalStatus,
		facts: ContextCompactionFacts,
		options: {
			airClient: boolean;
			first: boolean;
			summary?: string;
			error?: string;
			skipped?: { reason?: string };
		},
	): SessionUpdate {
		const skipped = status === "cancelled" ? options.skipped : undefined;
		const resultText = skipped
			? skipped.reason
				? `Compaction skipped: ${skipped.reason}`
				: "Compaction skipped"
			: status === "completed"
				? options.summary || undefined
				: status === "failed"
					? options.error
						? `Compaction failed: ${options.error}`
						: undefined
					: "Compaction cancelled";
		const content = resultText ? { content: [textContent(resultText)] } : {};
		const rawOutput = !options.airClient && Object.keys(facts).length > 0 ? { rawOutput: facts } : {};
		const toolStatus = skipped ? "completed" : status === "cancelled" ? "failed" : status;
		const meta = toolCallMeta(facts, options.airClient);
		if (options.first) {
			return {
				sessionUpdate: "tool_call",
				toolCallId,
				title: TOOL_TITLE,
				kind: "think",
				status: toolStatus,
				...content,
				...rawOutput,
				_meta: meta,
			};
		}
		return {
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: toolStatus,
			...content,
			...rawOutput,
			_meta: meta,
		};
	},
};

/** A finished compaction, as replayed on `session/load`: one terminal report. */
export function compactionReplayUpdate(
	compactionId: string,
	summary: string,
	facts: ContextCompactionFacts,
	options: CompactionReportOptions,
): SessionUpdate {
	if (options.presentation === "tool_call") {
		return compactionToolCall.finished(compactionId, "completed", facts, {
			airClient: options.airClient,
			first: true,
			summary,
		});
	}
	return {
		sessionUpdate: "compaction_update",
		compactionId,
		status: "completed",
		...(summary ? { summary: [{ type: "text", text: summary }] } : {}),
		...(options.airClient ? { _meta: contextCompactionMeta(facts) } : {}),
	};
}

type ActiveCompaction = {
	compactionId: string;
	trigger: "manual" | "automatic";
	startedAt: number;
};

/**
 * One session's compaction reports. At most one compaction is open at a
 * time; `start` while one is open and `finish` with none open are ignored,
 * so a duplicated or orphaned signal never opens a second entity.
 */
export class AcpCompactionLifecycle {
	#send: (update: SessionUpdate) => Promise<void>;
	#options: CompactionReportOptions;
	#active: ActiveCompaction | undefined;

	constructor(send: (update: SessionUpdate) => Promise<void>, options: CompactionReportOptions) {
		this.#send = send;
		this.#options = options;
	}

	get active(): boolean {
		return this.#active !== undefined;
	}

	async start(trigger: "manual" | "automatic"): Promise<void> {
		if (this.#active) return;
		const compactionId = `compaction:${crypto.randomUUID()}`;
		this.#active = { compactionId, trigger, startedAt: Date.now() };
		const { presentation, airClient } = this.#options;
		await this.#send(
			presentation === "compaction_update"
				? {
						sessionUpdate: "compaction_update",
						compactionId,
						status: "in_progress",
						...(airClient ? { _meta: contextCompactionMeta() } : {}),
					}
				: compactionToolCall.started(compactionId, airClient),
		);
	}

	async finish(outcome: CompactionOutcome): Promise<void> {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		const facts: ContextCompactionFacts = {
			trigger: active.trigger,
			...(outcome.preTokens !== undefined ? { preTokens: outcome.preTokens } : {}),
			...(outcome.postTokens !== undefined ? { postTokens: outcome.postTokens } : {}),
			durationMs: Date.now() - active.startedAt,
		};
		const { presentation, airClient } = this.#options;
		if (presentation === "tool_call") {
			await this.#send(
				compactionToolCall.finished(active.compactionId, outcome.status, facts, {
					airClient,
					first: false,
					summary: outcome.summary,
					error: outcome.error,
					skipped: outcome.skipped,
				}),
			);
			return;
		}
		await this.#send({
			sessionUpdate: "compaction_update",
			compactionId: active.compactionId,
			status: outcome.status,
			...(outcome.status === "completed" && outcome.summary
				? { summary: [{ type: "text", text: outcome.summary }] }
				: {}),
			...(outcome.status === "failed" && outcome.error ? { error: outcome.error } : {}),
			...(airClient ? { _meta: contextCompactionMeta(facts) } : {}),
		});
	}

	/**
	 * Close a compaction still open at a turn boundary (turn end, cancel) as
	 * `cancelled`: its terminal signal can no longer reach this session. Never
	 * throws, so callers can settle the turn unconditionally.
	 */
	async reset(): Promise<void> {
		if (!this.#active) return;
		try {
			await this.finish({ status: "cancelled" });
		} catch (error) {
			logger.warn("Failed to send the cancelled compaction update", { error });
		}
	}
}
