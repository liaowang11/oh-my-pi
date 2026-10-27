import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, type Model, serviceTierFamily, shouldSendServiceTier } from "@oh-my-pi/pi-ai";
import { formatBytes, getBlobsDir, isEnoent, logger, type postmortem, VERSION } from "@oh-my-pi/pi-utils";
import {
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AuthMethod,
	type AvailableCommand,
	type ClientCapabilities,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type DeleteSessionRequest,
	type DeleteSessionResponse,
	type CreateElicitationResponse,
	type ElicitationContentValue,
	type ElicitationPropertySchema,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type McpServer,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type RunStateUpdate,
	type SessionConfigOption,
	type SessionInfo,
	type SessionModeState,
	type SessionNotification,
	type SessionUpdate,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
	type SubagentWorkState,
	type Usage,
} from "@oh-my-pi/pi-utils/acp";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils/dirs";
import { disableProvider, enableProvider } from "../../capability";
import {
	applyModelPreset,
	getModelPreset,
	getModelPresetNames,
	sessionMatchesModelPreset,
} from "../../config/model-presets";
import { Settings } from "../../config/settings";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	getExtensionUISelectOptionLabel,
	timedOutAskDialogResult,
} from "../../extensibility/extensions";
import { runExtensionCompact } from "../../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../../extensibility/extensions/get-commands-handler";
import { parseSkillInvocation } from "../../extensibility/skills";
import { PYTHON_KERNEL_CANCEL_BUDGET_MS } from "../../eval/py/kernel";
import {
	completeExitingGoal,
	GOAL_CONTINUATION_MESSAGE_TYPE,
	isGoalInterviewActive,
	isStalledGoalContinuation,
	restoreGoalMode,
} from "../../goals/mode";
import { cfgGoalContinuationModes } from "../../goals/settings";
import { goalContinuationActivity } from "../../goals/state";
import { MCPManager } from "../../mcp/manager";
import { reconnectMcpManagerServer } from "../../mcp/oauth-reauth";
import type { MCPServerConfig } from "../../mcp/types";
import { loadAllExtensions } from "../../modes/components/extensions/state-manager";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
	normalizePlanTitle,
	type PlanApprovalDetails,
	proposedPlanFileUrl,
	resolveApprovedPlan,
} from "../../plan-mode/approved-plan";
import { autosaveApprovedPlan } from "../../plan-mode/plan-autosave";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { MountedMCPToolRouteSource } from "../../session/session-tools";
import { BlobStore, resolveImageDataSync } from "../../session/blob-store";
import {
	bashExecutionToText,
	formatFileMention,
	isSilentAbort,
	pythonExecutionToText,
	SKILL_PROMPT_MESSAGE_TYPE,
	USER_INTERRUPT_LABEL,
} from "../../session/messages";
import type { ModelTokenStatistics, SessionEntry, UsageStatistics } from "../../session/session-entries";
import {
	findSessionFiles,
	readSessionInfo,
	sessionIdFromSessionPath,
	type SessionInfo as StoredSessionInfo,
} from "../../session/session-listing";
import { loadSessionMessagesReadOnly } from "../../session/session-loader";
import { isAgentManagedWorktree, worktreeSessionDirs } from "../../session/session-paths";
import { SessionManager, SessionMoveRefusedError } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands, toAcpAvailableCommands } from "../../slash-commands/available-commands";
import { acpGoalActionRefusal, applyAcpGoalAction } from "../../slash-commands/helpers/goal";
import { DEFAULT_STT_MODEL_KEY, STT_MODELS } from "../../stt/models";
import { refreshAgentDiscovery } from "../../task";
import { AUTO_THINKING, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { OTHER_OPTION } from "../../tools/ask";
import { formatPathRelativeToCwd } from "../../tools/path-utils";
import { isProposeToolCall } from "../../tools/resolve";
import { existingPlanFileSync, resolvePlanFilePath } from "../../plan-mode/plan-files";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	DEFAULT_TTS_SPEED,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODELS,
	TTS_LOCAL_VOICE_OPTIONS,
	TTS_SPEED_MAX,
	TTS_SPEED_MIN,
	TTS_SPEED_OPTIONS,
} from "../../tts/models";
import type { EventBus } from "../../utils/event-bus";
import { enterVibeMode, exitVibeMode, type VibeModeHandle, vibeParentSessionOf } from "../../vibe/mode";
import { VibeSessionRegistry } from "../../vibe/runtime";
import { canonicalizeMessage } from "@oh-my-pi/pi-tui/chat/thinking-display";
import type { BashExecutionMessage, PythonExecutionMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { createAcpClientBridge } from "./acp-client-bridge";
import { RATE_LIMIT_META_KEY, rateLimitInfos, usageLimitFailureText } from "./acp-rate-limit";
import {
	extractAssistantMessageText,
	mapAgentSessionEventToAcpSessionUpdates,
	normalizeReplayToolArguments,
} from "./acp-event-mapper";
import { GOAL_CONTROL_METHOD, type GoalRequest, goalCapability, parseGoalRequest, toGoalSnapshot } from "./acp-goal";
import {
	AcpSubagentRelay,
	clientSupportsSubagents,
	isSubagentSessionId,
	subagentSessionId,
	subagentTitle,
} from "./acp-subagents";
import {
	AIR_ASYNC_TASKS_CAPABILITY,
	AIR_CUSTOM_ANSWER_KEY,
	AIR_GOAL_KEY,
	AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY,
	AIR_PLAN_FILE_CAPABILITY,
	airCapabilityMeta,
	clientSupportsAirCapability,
	clientSupportsAsyncTasks,
	clientSupportsPlanFile,
	isAirClient,
	withAirFields,
	withAirMeta,
} from "./acp-air";
import {
	AcpCompactionLifecycle,
	type CompactionOutcome,
	clientSupportsCompactionUpdates,
	compactionReplayUpdate,
} from "./acp-compaction";
import {
	clientSupportsNotices,
	mapSessionNoticeEvent,
	newConfigWarningNotices,
	noticeOrTranscriptUpdate,
	type SessionNotice,
	textNotice,
} from "./acp-notices";
import {
	type ArchivedFilter,
	clientSupportsSessionIndex,
	compareSessionIndexPositions,
	decodeSessionIndexCursor,
	encodeSessionIndexCursor,
	matchesArchivedFilter,
	parseRenameSessionRequest,
	parseSessionIdRequest,
	parseSessionIndexListOptions,
	type RenameSessionRequest,
	SESSION_ARCHIVE_METHOD,
	SESSION_RENAME_METHOD,
	SESSION_UNARCHIVE_METHOD,
	type SessionIndexPosition,
	type SessionIndexRowFields,
	sessionIndexCapabilities,
	sessionNotFound,
} from "./acp-session-index";
import {
	LIST_CHANGES_METHOD,
	LIST_SUBSCRIBE_METHOD,
	LIST_UNSUBSCRIBE_METHOD,
	parseListSubscribeRequest,
	parseListUnsubscribeRequest,
	SessionListSubscriptions,
	type SessionListTiming,
} from "./acp-session-list-subscriptions";
import {
	AcpAsyncTaskRelay,
	ASYNC_TASK_STOP_METHOD,
	type AsyncTaskStopRequest,
	parseAsyncTaskStopRequest,
} from "./acp-async-tasks";
import { ACP_TERMINAL_AUTH_FLAG } from "./terminal-auth";

import { cfgDisabledExtensions } from "../../extensibility/settings";
import { cfgPlanEnabled } from "../../plan-mode/settings";
import { cfgSessionWorktreeScope } from "../../session/settings";

const ACP_DEFAULT_MODE_ID = "default";
const ACP_PLAN_MODE_ID = "plan";
const ACP_VIBE_MODE_ID = "vibe";
const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";
/** A provider error that is the model declining, which ends the turn as `refusal`. */
const REFUSAL_ERROR_PATTERN = /content[_ ]?filter|refus(al|ed)/i;
/** How long a failed usage-limited prompt waits for its rate-limit push before failing. */
const RATE_LIMIT_PUSH_WAIT_MS = 2_000;
// Descriptions of an ask form's free-text "Other" field, as claude-agent-acp words them.
const OTHER_MULTI_DESCRIPTION = "Type your own answer to add to your selection above (optional).";
const OTHER_SINGLE_DESCRIPTION = "Type your own answer, or add a note to the option you chose above (optional).";
// Un-namespaced custom-answer key: agent-shell reads it from every agent, released AIR versions too.
const CUSTOM_ANSWER_META_KEY = "_askUserQuestionCustomAnswer";
// `_meta` key an ask form's option carries its preview under.
const OPTION_META_KEY = "_claude/askUserQuestionOption";
const APPROVE_OPTION = "Approve and execute";
const REFINE_OPTION = "Refine plan";
const MODE_CONFIG_ID = "mode";
const MODEL_CONFIG_ID = "model";
const THINKING_CONFIG_ID = "thinking";
const MODEL_PRESET_CONFIG_ID = "model_preset";
const FAST_MODE_CONFIG_ID = "fast_mode";
const FAST_MODE_OFF = "off";
const FAST_MODE_ON = "on";
const FAST_MODE_ULTRA = "ultra";
const ADVISOR_CONFIG_ID = "advisor";
const TOGGLE_ON = "on";
const TOGGLE_OFF = "off";
/** Preset value shown when no saved preset matches. Preset names start with a letter, so never a name. */
const MODEL_PRESET_CUSTOM = "_custom";
const THINKING_OFF = "off";
const SESSION_PAGE_SIZE = 50;
const SPEECH_MODELS_LIST_METHOD = "speech.models.list";
/**
 * `_session/steering` — the steering extension method from claude-agent-acp /
 * codex-acp (spec proposal: ACP `session/inject`,
 * agentclientprotocol/agent-client-protocol#1261, still open). Advertised via
 * top-level `_meta.steering.supported` in the `initialize` response; params
 * carry `{ sessionId, prompt: ContentBlock[] }`. The omp extension
 * `_meta.steering.queue: "followUp"` routes to the native follow-up queue
 * instead of the steering queue. Idle sessions are never consumed or started:
 * the response is always `promptRequired`, so the host submits the prompt
 * itself and keeps owning the turn.
 */
const SESSION_STEERING_METHOD = "_session/steering";
/**
 * Delay between `session/new` (or `session/load` / `session/resume` /
 * `unstable_session/fork`) returning and the agent firing the first
 * notifications against the new session id. Mitigates Zed's
 * `Received session notification for unknown session` race — see
 * `#scheduleBootstrapUpdates`. Exported so the ACP test harness can
 * wait past this guard without hard-coding the literal.
 */
export const ACP_BOOTSTRAP_RACE_GUARD_MS = 50;
const ACP_CANCEL_CLEANUP_TIMEOUT_MS = PYTHON_KERNEL_CANCEL_BUDGET_MS + 1_000;
const ACP_ASYNC_DELIVERY_DRAIN_TIMEOUT_MS = 250;
const ACP_ASYNC_DELIVERY_DRAIN_MAX_PASSES = 3;
/** Auto-maintenance actions that rewrite the context; handoff and shake are not reported as compactions. */
const COMPACTION_ACTIONS: ReadonlySet<string> = new Set(["context-full", "remote", "snapcompact"]);

type AgentImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

type PromptQueueState = {
	promise: Promise<void>;
	release: (() => void) | undefined;
};
/**
 * Cancellation carrier for a client prompt accepted on the wire whose turn has
 * not started yet — still queued behind another prompt, or inside the dispatch
 * window before its `PromptTurnState` slot exists. `session/request_cancel`
 * marks every live carrier so a stop can never race past a prompt that is
 * about to stream; the queue callback consumes the mark when the slot is
 * created and resolves the wire response `cancelled` without starting the run.
 */
type PromptDispatchCancellation = { cancelled: boolean };

type PromptTurnState = {
	abortController: AbortController;
	cancelRequested: boolean;
	settled: boolean;
	/**
	 * Delivery of streamed assistant `error` chunks this turn (the mapper
	 * surfaces them as `agent_message_chunk`s). Resolves `true` once at least
	 * one error chunk reached the client — the `agent_end` error fallback in
	 * {@link AcpAgent##flushUnreportedTurnError} awaits it and stays silent on
	 * success, so a fallback racing an in-flight delivery can neither duplicate
	 * the error nor drop it when delivery fails.
	 */
	errorTextDelivery: Promise<boolean> | undefined;
	/**
	 * `abort()` is in-flight (or its bounded-timeout race). `undefined` while the turn is
	 * running normally and after cleanup completes. The turn occupies `record.promptTurn`
	 * for as long as either `!settled` or `cleanup` is set — that combined window is the
	 * "turn in flight" predicate (`isPromptTurnInFlight`) every consumer gates on.
	 */
	cleanup: Promise<void> | undefined;
	/**
	 * An agent turn no `session/prompt` owns (a background-job delivery) was
	 * already streaming when this prompt reserved the slot. Its remaining events,
	 * up to and including its `agent_end`, still reach this turn's subscription;
	 * they are forwarded as autonomous output so that `agent_end` cannot settle
	 * this prompt before its own turn has run. Cleared by that `agent_end`, or by
	 * this prompt's own `agent_start` if the foreign turn ended unseen.
	 */
	inheritedForeignTurn: boolean;
	/**
	 * Dispatch was refused because the agent was busy with turns no
	 * `session/prompt` owns; the prompt waits for idle before retrying. Every
	 * event in that window is foreign, including the `agent_start`/`agent_end`
	 * of chained background-job deliveries, so none can settle this prompt.
	 */
	parked: boolean;
	usageBaseline: UsageStatistics;
	modelUsageBaseline: Map<string, ModelTokenStatistics>;
	unsubscribe: (() => void) | undefined;
	resolve: (value: PromptResponse) => void;
	reject: (reason?: unknown) => void;
	promise: Promise<PromptResponse>;
};

/**
 * A turn is "in flight" from the moment `prompt()` reserves the slot until `settled` is
 * true AND any cancel cleanup has completed. Fork/queue/event gating all depend on this
 * combined window — a settled-but-still-aborting turn is not safe to fork from, queue
 * onto, or forward late events for.
 */
function isPromptTurnInFlight(turn: PromptTurnState | undefined): turn is PromptTurnState {
	return turn !== undefined && (!turn.settled || turn.cleanup !== undefined);
}

/**
 * `_session/steering` prompt param: the same `ContentBlock[]` shape as
 * `session/prompt`. Blocks are validated here rather than trusted, because
 * `#convertPromptBlocks` dereferences their fields (`block.text`, image
 * `data`/`mimeType`, `block.resource`) — a null block would surface as a
 * TypeError (generic internal error) and an image without `data` would queue
 * an image with undefined fields. A bare string is accepted defensively for
 * slightly off-spec clients.
 */
function toSteeringPromptBlocks(prompt: unknown): PromptRequest["prompt"] {
	if (typeof prompt === "string") {
		return [{ type: "text", text: prompt }];
	}
	if (!Array.isArray(prompt)) {
		throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "prompt must be content blocks");
	}
	for (const block of prompt) {
		if (typeof block !== "object" || block === null || Array.isArray(block)) {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "prompt blocks must be objects");
		}
		const record = block as Record<string, unknown>;
		if (typeof record.type !== "string") {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "prompt block requires a string type");
		}
		// Own-key lookup: inherited names (`constructor`, `toString`, …) would
		// index inherited prototype values, and the `for…of` below would then
		// throw a TypeError that surfaces as a generic -32603 internal error.
		if (!Object.hasOwn(STEERING_BLOCK_STRING_FIELDS, record.type)) {
			throw RequestError.invalidParams(
				{ method: SESSION_STEERING_METHOD },
				`unsupported prompt block type: ${record.type}`,
			);
		}
		const required = STEERING_BLOCK_STRING_FIELDS[record.type];
		for (const field of required) {
			if (typeof record[field] !== "string") {
				throw RequestError.invalidParams(
					{ method: SESSION_STEERING_METHOD },
					`prompt block ${record.type} requires string ${field}`,
				);
			}
		}
		if (record.type === "resource") {
			const resource = record.resource;
			if (
				typeof resource !== "object" ||
				resource === null ||
				typeof (resource as Record<string, unknown>).uri !== "string"
			) {
				throw RequestError.invalidParams(
					{ method: SESSION_STEERING_METHOD },
					"resource block requires a resource object with a string uri",
				);
			}
			const resourceFields = resource as Record<string, unknown>;
			// `#convertPromptBlocks` selects the text arm whenever the key
			// exists and the image arm only for a string blob: require the
			// arm that would be selected to be a string, so a mixed shape
			// (e.g. a string blob plus a non-string text) cannot pass here
			// and then silently replace the image with the raw field value
			// in model input. A resource with neither arm keeps the same
			// rejection as before.
			if (Object.hasOwn(resourceFields, "text")) {
				if (typeof resourceFields.text !== "string") {
					throw RequestError.invalidParams(
						{ method: SESSION_STEERING_METHOD },
						"resource block with a text arm requires string text",
					);
				}
			} else if (Object.hasOwn(resourceFields, "blob")) {
				if (typeof resourceFields.blob !== "string") {
					throw RequestError.invalidParams(
						{ method: SESSION_STEERING_METHOD },
						"resource block with a blob arm requires string blob",
					);
				}
			} else {
				throw RequestError.invalidParams(
					{ method: SESSION_STEERING_METHOD },
					"resource block requires string text or string blob",
				);
			}
			// The embedded-resource schema types `mimeType` as an optional
			// string (never null): reject a present non-string value instead
			// of letting it slip into the converter's image arm.
			if (Object.hasOwn(resourceFields, "mimeType") && typeof resourceFields.mimeType !== "string") {
				throw RequestError.invalidParams(
					{ method: SESSION_STEERING_METHOD },
					"resource block mimeType must be a string when present",
				);
			}
		}
		if (record.type === "resource_link") {
			for (const field of ["title", "name", "mimeType", "description"] as const) {
				// `null` is a legal value (the ACP schema types these
				// `string | null`): treat it exactly like an absent field —
				// the converter names the link by its uri alone.
				if (record[field] !== undefined && record[field] !== null && typeof record[field] !== "string") {
					throw RequestError.invalidParams(
						{ method: SESSION_STEERING_METHOD },
						`resource_link ${field} must be a string or null when present`,
					);
				}
			}
			if (record.size !== undefined && record.size !== null && typeof record.size !== "number") {
				throw RequestError.invalidParams(
					{ method: SESSION_STEERING_METHOD },
					"resource_link size must be a number or null when present",
				);
			}
		}
	}
	return prompt as PromptRequest["prompt"];
}

/** Required top-level string fields per accepted prompt block type. */
const STEERING_BLOCK_STRING_FIELDS: Record<string, string[]> = {
	text: ["text"],
	image: ["data", "mimeType"],
	audio: ["data", "mimeType"],
	resource_link: ["uri"],
	resource: [],
};

/**
 * `_meta.steering.queue` of a `_session/steering` request — the omp-specific
 * opt-in routing the message to the native follow-up queue instead of the
 * steering queue. Everything else (including `idleBehavior`) is unused: idle
 * sessions always answer `promptRequired`, so the host keeps owning the turn.
 */
function steeringQueueFromMeta(meta: unknown): "steering" | "followUp" {
	if (typeof meta === "object" && meta !== null) {
		const steering = (meta as Record<string, unknown>).steering;
		if (typeof steering === "object" && steering !== null) {
			return (steering as Record<string, unknown>).queue === "followUp" ? "followUp" : "steering";
		}
	}
	return "steering";
}

/**
 * Whether the client asked for ACP v2 `state_update`s on this v1 connection:
 * `clientCapabilities._meta.stateUpdate === true`. Tolerates malformed `_meta`.
 */
function clientSupportsStateUpdates(capabilities: ClientCapabilities | undefined): boolean {
	const meta = capabilities?._meta;
	return typeof meta === "object" && meta !== null && (meta as Record<string, unknown>).stateUpdate === true;
}

/** The JSON-RPC error a failed prompt is answered with, for its `idle` state update. */
function jsonRpcError(error: unknown): { code: number; message: string; data?: unknown } {
	if (error instanceof RequestError) {
		return { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) };
	}
	return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}

type ManagedSessionRecord = {
	session: AgentSession;
	setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined;
	mcpManager: MCPManager | undefined;
	// Ordered queue of MCP tool refreshes for this record. Rebuilt per
	// `#configureMcpServers` call; drained on reconfigure so a stale in-flight
	// refresh can never land after a newer configuration's tools.
	mcpRefreshChain: Promise<void> | undefined;
	// MCP startup failures recorded during `#registerPreparedSession` (before
	// the newSession/loadSession response has told the client the session id).
	// Drained by `#emitBootstrapUpdates` behind the bootstrap race guard so
	// clients (Zed) cannot drop them as notifications for an unknown session.
	// `oauthCapable` marks http/sse servers, the only ones `/mcp reauth` can repair.
	pendingMcpStartupChunks: Array<{ name: string; message: string; oauthCapable: boolean }>;
	promptTurn: PromptTurnState | undefined;
	promptQueue: PromptQueueState;
	// Cancellation carriers for client prompts accepted on the wire whose
	// turn slot does not exist yet (queued behind another prompt or still
	// inside the dispatch window). Marked by cancel(); consumed at slot
	// creation so a stop never leaves a prompt streaming behind the client's back.
	pendingPromptDispatches: Array<PromptDispatchCancellation>;
	liveMessageId: string | undefined;
	liveMessageProgress: { textEmitted: boolean; thoughtEmitted: boolean } | undefined;
	// The stamp (`assistantMessageStamp`) of each assistant message streamed
	// under a `liveMessageId`, so `session/fork` can find the session entry a
	// client's fork point names. Kept until the session closes.
	liveMessageStamps: Map<string, string>;
	toolArgsById: Map<string, unknown>;
	extensionsConfigured: boolean;
	// Installed inside `#scheduleBootstrapUpdates` (post-race-guard); released
	// in `#disposeSessionRecord`. Lives independent of any prompt turn.
	lifetimeUnsubscribe: (() => void) | undefined;
	// Relays task-tool subagents as ACP subagents-RFD child sessions; set only when the
	// client advertises `subagents`. Released in `#disposeSessionRecord`.
	subagentRelay: AcpSubagentRelay | undefined;
	// Relays the session's background bash/eval jobs as AIR `async_task_*`
	// updates; set only when the client advertises AIR `asyncTasks` and the
	// session owns a job manager. Released in `#disposeSessionRecord`.
	asyncTaskRelay: AcpAsyncTaskRelay | undefined;
	// Pushes `session_info_update` as soon as a title resolves, instead of only
	// at bootstrap/end-of-turn: auto title generation runs async and can settle
	// after `agent_end` already fired, or after a turn with no `agent_end` at
	// all (a fully local slash command). Installed alongside
	// `lifetimeUnsubscribe` so it shares the same bootstrap race guard.
	titleUnsubscribe: (() => void) | undefined;
	// The title `#pushSessionInfoUpdate` last sent, so an unchanged one is not
	// re-sent at every turn end or by the rename that already pushed it.
	sentTitle: string | undefined;
	// The AIR goal snapshot (JSON) `#pushGoalUpdate` last sent, so an unchanged
	// goal is not re-sent; `undefined` until one was sent.
	sentGoal: string | undefined;
	// The `usage_update` values last sent, so a reading that did not change
	// since the last assistant message, compaction, or bootstrap is not repeated.
	sentUsage: string | undefined;
	// Each rate-limit window (by `rateLimitType`) last sent, so an unchanged one is not repeated.
	sentRateLimits: Map<string, string>;
	// The rate-limit push the last turn end started; a failed turn waits on it.
	rateLimitPush: Promise<void> | undefined;
	// Config warnings already sent as notices, so each reaches the client once.
	sentConfigWarnings: Set<string>;
	// Reports this session's context compactions (auto and manual /compact).
	compaction: AcpCompactionLifecycle;
	// Goal auto-continuation bookkeeping, same rule as the TUI: a continuation
	// turn that did no tool work, or repeated the previous one, stops the chain
	// until the user speaks again.
	goalContinuation: { pendingTurns: number; previousActivity: string | undefined; stalled: boolean };
	// Present while vibe mode is active: the owner scope and pre-vibe toolset
	// `exitVibeMode` needs to kill workers and restore tools.
	vibeMode: VibeModeHandle | undefined;
	// The `xd://propose` call in flight, and for an AIR `planFile` client the
	// plan file its input names. Read from the start event: the proposal
	// handler can run before that event is forwarded.
	planProposal: { toolCallId: string; planFilePath: string | undefined } | undefined;
	// The plan the proposal handler approved, reported once the propose call's
	// result reaches the client. Never set for a refined or failed proposal.
	approvedPlan: { planContent: string; planFilePath: string | undefined } | undefined;
	closedError: RequestError | undefined;
	promptEventHandlers: Set<Promise<void>>;
	extensionUserMessageTasks: Set<Promise<void>>;
	// The `state_update` state last sent (see `#setRunState`); a session starts idle.
	runState: RunStateUpdate["state"];
	// `session/request_permission` requests awaiting the client.
	pendingPermissions: number;
};

type ReplayableMessage = {
	role: string;
	content?: unknown;
	/** `compactionSummary` messages carry their text here, not in `content`. */
	summary?: unknown;
	tokensBefore?: unknown;
	tokensAfter?: unknown;
	timestamp?: unknown;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
	stopReason?: string;
};

/**
 * State of one pass over a session's subagent children: a `session/load`
 * replay, or (`send` a no-op) a `session/resume` that registers them unsent.
 */
type SubagentReplay = {
	rootSessionId: string;
	relay: AcpSubagentRelay;
	cwd: string;
	replayed: Set<string>;
	send: (notification: SessionNotification) => Promise<void>;
	announce: boolean;
};

type ReplayableToolItem = {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
	input?: unknown;
};

type MCPConfigMap = {
	[name: string]: MCPServerConfig;
};

type MCPSource = {
	provider: string;
	providerName: string;
	path: string;
	level: "project";
};

type MCPSourceMap = {
	[name: string]: MCPSource;
};

type AcpSessionHandle = {
	session: AgentSession;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	// The bus the session's task tool publishes subagent frames on.
	eventBus?: EventBus;
};

type CreateAcpSession = (
	cwd: string,
	options?: { interactivePrompts?: boolean },
) => Promise<AgentSession | AcpSessionHandle>;

/**
 * The subagents a task tool result spawned: `results` for a run the call
 * waited on, `progress` for a detached one.
 */
function taskResultSubagents(
	details: unknown,
): Array<{ id: string; agent: string | undefined; description: string | undefined }> {
	if (typeof details !== "object" || details === null) return [];
	const { results, progress } = details as { results?: unknown; progress?: unknown };
	const children = new Map<string, { agent: string | undefined; description: string | undefined }>();
	for (const list of [results, progress]) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (typeof item !== "object" || item === null) continue;
			const { id, agent, description } = item as { id?: unknown; agent?: unknown; description?: unknown };
			if (typeof id !== "string" || id.length === 0) continue;
			const label = typeof description === "string" ? description.trim() || undefined : undefined;
			const known = children.get(id);
			children.set(id, {
				agent: known?.agent ?? (typeof agent === "string" ? agent : undefined),
				description: known?.description ?? label,
			});
		}
	}
	return [...children].map(([id, child]) => ({ id, ...child }));
}

/** The idle snapshot that ends a replayed child, from its last assistant message's stop reason. */
/** One `_meta.quota` counter set, keyed as claude-agent-acp's `quotaTokenCount`. */
interface AcpQuotaTokenCount {
	totalTokens: number;
	inputTokens: number;
	cachedInputTokens: number;
	cachedWriteTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
}

/** `_meta.quota` on a prompt response: the turn's spend, whole and per model. */
interface AcpQuota {
	token_count: AcpQuotaTokenCount;
	model_usage: Array<{ model: string; token_count: AcpQuotaTokenCount }>;
}

function quotaTokenCount(tokens: ModelTokenStatistics): AcpQuotaTokenCount {
	return {
		totalTokens: tokens.totalTokens,
		inputTokens: tokens.input,
		cachedInputTokens: tokens.cacheRead,
		cachedWriteTokens: tokens.cacheWrite,
		outputTokens: tokens.output,
		reasoningOutputTokens: tokens.reasoning,
	};
}

function replayedIdleState(stopReason: string | undefined): SubagentWorkState {
	switch (stopReason) {
		case undefined:
			return { state: "idle" };
		case "error":
			return { state: "idle", stopReason: "error" };
		case "aborted":
			return { state: "idle", stopReason: "cancelled" };
		default:
			return { state: "idle", stopReason: "end_turn" };
	}
}

/** Longest title `session/fork`'s `_meta.sessionTitle` may give a fork, as in claude-agent-acp. */
const MAX_FORK_TITLE_LENGTH = 256;

/**
 * The agent message AIR's fork-point extension asks `session/fork` to cut
 * after, `_meta.jetbrains.air.fork = { version: 1, messageId }`. Undefined
 * (any other shape) forks the whole session.
 */
function forkPointMessageId(meta: unknown): string | undefined {
	type ForkPointMeta = { jetbrains?: { air?: { fork?: { version?: unknown; messageId?: unknown } } } };
	const fork = (meta as ForkPointMeta | null | undefined)?.jetbrains?.air?.fork;
	if (fork?.version !== 1 || typeof fork.messageId !== "string") return undefined;
	return fork.messageId.trim() || undefined;
}

/** The ids a fork point may name: as sent, then without the `:segment:<n>` suffix older AIR builds append. */
function forkPointCandidates(messageId: string): string[] {
	const unsegmented = messageId.replace(/:segment:\d+$/, "");
	return unsegmented === messageId ? [messageId] : [messageId, unsegmented];
}

/** The title `_meta.sessionTitle` asks a fork to carry, on one line and at most {@link MAX_FORK_TITLE_LENGTH} long. */
function forkSessionTitle(meta: unknown): string | undefined {
	const requested = (meta as { sessionTitle?: unknown } | null | undefined)?.sessionTitle;
	if (typeof requested !== "string") return undefined;
	const title = requested.replace(/\s+/g, " ").trim();
	if (title.length <= MAX_FORK_TITLE_LENGTH) return title || undefined;
	return `${title.slice(0, MAX_FORK_TITLE_LENGTH - 1)}…`;
}

/**
 * What identifies an assistant message through a copy of it — the display copy
 * the bridge streams under secret obfuscation, a replay copy without dangling
 * tool calls, the same message reloaded from disk: when, and by which model,
 * it was produced.
 */
function assistantMessageStamp(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const { role, timestamp, provider, model } = message as {
		role?: unknown;
		timestamp?: unknown;
		provider?: unknown;
		model?: unknown;
	};
	if (role !== "assistant" || typeof timestamp !== "number") return undefined;
	return `${timestamp}:${String(provider)}:${String(model)}`;
}

/** Assistant message entries by message object and by {@link assistantMessageStamp}. */
type AssistantEntryIndex = { byMessage: Map<object, string>; byStamp: Map<string, string> };

function indexAssistantEntries(entries: readonly SessionEntry[]): AssistantEntryIndex {
	const index: AssistantEntryIndex = { byMessage: new Map(), byStamp: new Map() };
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		index.byMessage.set(entry.message, entry.id);
		const stamp = assistantMessageStamp(entry.message);
		if (stamp) index.byStamp.set(stamp, entry.id);
	}
	return index;
}

function isoToMs(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * A session index row's `updatedAt`: its last message, capped at the file
 * mtime, so a title-slot write (rename, archive) moves neither it nor the
 * order. The mtime when the tail window holds no message.
 */
function sessionIndexUpdatedAtMs(session: StoredSessionInfo): number {
	const mtime = session.modified.getTime();
	const lastMessage = isoToMs(session.activity?.lastMessageAt);
	return lastMessage === undefined ? mtime : Math.min(lastMessage, mtime);
}

/** The parent session id of a header `parentSession`, which a branch records as the parent's file path. */
function parentSessionId(parentSession: string | undefined): string | undefined {
	if (!parentSession) return undefined;
	if (path.isAbsolute(parentSession) || parentSession.endsWith(".jsonl"))
		return sessionIdFromSessionPath(parentSession);
	return parentSession;
}

function normalizeCreatedAcpSession(created: AgentSession | AcpSessionHandle): {
	session: AgentSession;
	setToolUIContext: AcpSessionHandle["setToolUIContext"] | undefined;
	eventBus: EventBus | undefined;
} {
	return "session" in created
		? { session: created.session, setToolUIContext: created.setToolUIContext, eventBus: created.eventBus }
		: { session: created, setToolUIContext: undefined, eventBus: undefined };
}

type AcpSpeechOption = {
	value: string;
	label: string;
	description?: string;
};

type AcpSpeechVoiceOption = {
	value: string;
	label: string;
};

type AcpSpeechTtsModelOption = AcpSpeechOption & {
	voices: AcpSpeechVoiceOption[];
};

function buildAcpSpeechModelsCatalog(): Record<string, unknown> {
	const localSelector = (modelId: string) => `local/${modelId}`;
	const defaultSpeechModel = localSelector(TTS_LOCAL_MODELS[0].key);
	const defaultDictationModel = localSelector(DEFAULT_STT_MODEL_KEY);
	const voices = TTS_LOCAL_VOICE_OPTIONS.map(({ value, label }) => ({ value, label }));
	// Speed settings are numeric, so presets are advertised as numbers clients can write back as-is.
	const speeds = TTS_SPEED_OPTIONS.map(({ value, label }) => ({ value: Number(value), label }));
	return {
		settings: {
			speechToTextModel: "modelRoles.dictation",
			textToSpeechModel: "modelRoles.speech",
			textToSpeechVoice: "tts.localVoice",
			speechVoice: "speech.voice",
			textToSpeechSpeed: "tts.localSpeed",
			speechSpeed: "speech.speed",
		},
		defaults: {
			speechToTextModel: defaultDictationModel,
			textToSpeechModel: defaultSpeechModel,
			voice: DEFAULT_TTS_VOICE,
			speed: DEFAULT_TTS_SPEED,
		},
		speechToText: {
			setting: "modelRoles.dictation",
			defaultValue: defaultDictationModel,
			models: STT_MODELS.map(({ key, label, description }) => ({
				value: localSelector(key),
				label,
				description,
			})),
		},
		textToSpeech: {
			modelSetting: "modelRoles.speech",
			voiceSetting: "tts.localVoice",
			speechVoiceSetting: "speech.voice",
			speedSetting: "tts.localSpeed",
			speechSpeedSetting: "speech.speed",
			defaultModel: defaultSpeechModel,
			defaultVoice: DEFAULT_TTS_VOICE,
			defaultSpeed: DEFAULT_TTS_SPEED,
			speedRange: { min: TTS_SPEED_MIN, max: TTS_SPEED_MAX },
			models: TTS_LOCAL_MODELS.map(({ key, label, description, voices: modelVoices }): AcpSpeechTtsModelOption => ({
				value: localSelector(key),
				label,
				description,
				voices: modelVoices.map(({ id, label: voiceLabel }) => ({ value: id, label: voiceLabel })),
			})),
			voices,
			speeds,
		},
	};
}

/**
 * Bridge an ExtensionUIContext form to ACP `unstable_createElicitation`.
 *
 * `dialogOptions.signal` short-circuits the elicitation if it is already
 * aborted and races the in-flight request against the abort event.
 *
 * `dialogOptions.timeout` mirrors `RpcExtensionUIContext.#createDialogPromise`:
 * when the timer fires before the client responds, `onTimeout` is invoked and
 * the caller's promise resolves to the stub fallback.
 *
 * Either way the caller stops waiting at once, and the request itself is
 * withdrawn: one internal controller, aborted whenever the elicitation settles
 * without a client answer, is the request's signal, so the transport sends
 * `$/cancel_request` and the client can close the abandoned dialog. ACP has
 * no form-mode cancel method (`elicitation/complete` is URL-mode only); a
 * client that ignores `$/cancel_request` keeps a stale dialog whose late
 * answer is dropped. Late responses after abort/timeout — rejections and
 * `accept`s alike — are dropped silently to keep operator logs clean. The
 * caller's abort listener is removed on settle so a signal reused across many
 * elicitations does not accumulate listeners.
 */
async function elicitFormFromAcpClient(
	connection: AgentSideConnection,
	sessionId: string,
	method: string,
	message: string,
	properties: Record<string, ElicitationPropertySchema>,
	required: string[] | undefined,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<Record<string, ElicitationContentValue> | undefined> {
	const signal = dialogOptions?.signal;
	if (signal?.aborted) {
		return undefined;
	}
	const { promise, resolve } = Promise.withResolvers<CreateElicitationResponse | undefined>();
	const request = new AbortController();
	let settled = false;
	let timeoutId: NodeJS.Timeout | undefined;
	const finish = (value: CreateElicitationResponse | undefined, answered: boolean) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
		if (!answered) request.abort();
		resolve(value);
	};
	const onAbort = () => finish(undefined, false);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (dialogOptions?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			if (settled) return;
			try {
				dialogOptions.onTimeout?.();
			} catch (error) {
				// A throwing `onTimeout` must not leave the elicitation promise
				// pending — settle it via `finish` below regardless.
				logger.warn("ACP elicitation onTimeout threw", { acpSessionId: sessionId, method, error });
			}
			finish(undefined, false);
		}, dialogOptions.timeout);
		// A long pending timeout alone shouldn't keep the event loop alive when
		// the rest of the agent has shut down — matches `job-manager.ts` /
		// `executor.ts` timer hygiene. Connection + session lifetimes keep the
		// loop alive on the happy path.
		timeoutId.unref();
	}
	connection
		.unstable_createElicitation(
			{
				mode: "form",
				sessionId,
				message,
				requestedSchema: {
					type: "object",
					properties,
					required,
				},
			},
			request.signal,
		)
		.then(
			response => finish(response, true),
			error => {
				// Caller may already have moved on via abort/timeout; suppress noise.
				if (settled) return;
				logger.warn("ACP elicitation failed", { acpSessionId: sessionId, method, error });
				finish(undefined, true);
			},
		);
	const response = await promise;
	if (!isAcceptedElicitation(response) || !response.content) {
		return undefined;
	}
	return response.content;
}

async function elicitFromAcpClient(
	connection: AgentSideConnection,
	sessionId: string,
	method: "select" | "confirm" | "input" | "editor",
	message: string,
	property: ElicitationPropertySchema,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<ElicitationContentValue | undefined> {
	const content = await elicitFormFromAcpClient(
		connection,
		sessionId,
		method,
		message,
		{ value: property },
		["value"],
		dialogOptions,
	);
	return content?.value;
}

/** Narrows a `CreateElicitationResponse` to the accepted-with-content branch; the SDK's `action: string` catch-all arm otherwise defeats literal narrowing on `action !== "accept"`. */
function isAcceptedElicitation(
	response: CreateElicitationResponse | undefined,
): response is Extract<CreateElicitationResponse, { action: "accept" }> {
	return response?.action === "accept";
}

/**
 * Build an {@link ExtensionUIContext} that translates skill/extension UI
 * requests into ACP elicitations against `connection` for the session
 * returned by `getSessionId()`. The id is read lazily at each elicitation
 * because `AgentSession.sessionId` is a getter over `sessionManager` state
 * that mutates when an extension command calls `ctx.newSession` /
 * `ctx.switchSession` — snapshotting it once at factory time would route
 * later elicitations to the pre-switch id. Live reads keep the bridge
 * symmetric with every other `sessionUpdate` call in this file
 * (`record.session.sessionId` is always evaluated at emit time).
 *
 * The non-elicitation surface (custom components, theming, terminal
 * input) remains stubbed — ACP clients render those themselves or not
 * at all. Capability gating respects the client's `initialize`
 * advertisement.
 */
export function createAcpExtensionUiContext(
	connection: AgentSideConnection,
	getSessionId: () => string,
	clientCapabilities: ClientCapabilities | undefined,
): ExtensionUIContext {
	const supportsForm = clientCapabilities?.elicitation?.form != null;
	const airClient = isAirClient(clientCapabilities);
	const supportsNotices = clientSupportsNotices(clientCapabilities);
	return {
		supportsEditor: false,
		select: async (title, options, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"select",
				title,
				{ type: "string", enum: options.map(getExtensionUISelectOptionLabel) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		confirm: async (title, message, dialogOptions) => {
			if (!supportsForm) return false;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"confirm",
				message.trim().length > 0 ? `${title}\n\n${message}` : title,
				{ type: "boolean" },
				dialogOptions,
			);
			return typeof value === "boolean" ? value : false;
		},
		input: async (title, placeholder, dialogOptions) => {
			// ACP form-mode elicitation has no masked/password field and the ACP spec
			// forbids falling back to form mode for secrets or credentials.
			if (!supportsForm || dialogOptions?.secret) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"input",
				title,
				// ACP's `StringPropertySchema` has no `placeholder` field, so we
				// surface the placeholder text as `description` — the closest
				// semantic field a client can render alongside the input.
				// Empty / whitespace-only placeholders are treated as absent.
				{ type: "string", ...(placeholder?.trim() ? { description: placeholder } : {}) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		askDialog: async (questions, dialogOptions) => {
			if (!supportsForm) return undefined;
			const properties: Record<string, ElicitationPropertySchema> = {};
			for (const [index, question] of questions.entries()) {
				const key = `q${index}`;
				const entries = question.options.map(option => ({
					const: option.label,
					title: option.label,
					...(option.description?.trim() ? { description: option.description.trim() } : {}),
					// ACP's enum option has no preview slot; claude-agent-acp sends it under
					// this `_meta` key, which agent-shell renders.
					...(option.preview?.trim() ? { _meta: { [OPTION_META_KEY]: { preview: option.preview } } } : {}),
				}));
				// A single question already travels as the elicitation `message`, so the
				// field carries only the header; repeating the question renders it twice.
				const header = question.header?.trim();
				const title = header || question.question;
				const description = header && questions.length > 1 ? question.question : undefined;
				if (entries.length > 0) {
					if (question.multi === true) {
						properties[key] = {
							type: "array",
							title,
							...(description ? { description } : {}),
							items: { anyOf: entries },
						};
					} else {
						const recommended = question.recommended;
						properties[key] = {
							type: "string",
							title,
							...(description ? { description } : {}),
							oneOf: entries,
							...(recommended !== undefined && recommended >= 0 && recommended < question.options.length
								? { default: question.options[recommended].label }
								: {}),
						};
					}
				}
				// Marks the free-text field as the select's companion so clients
				// (agent-shell, JetBrains AIR) offer it as one more option of that
				// select instead of a separate field. Every client gets the
				// un-namespaced key, which agent-shell reads from any agent; an AIR
				// client also gets `_meta.jetbrains.air.customAnswer`, as
				// claude-agent-acp sends it. Without options the free-text field is
				// the whole question.
				const customAnswer = { questionId: key, isCustomAnswer: true };
				const customAnswerMeta = { [CUSTOM_ANSWER_META_KEY]: customAnswer };
				properties[`${key}__other`] =
					entries.length > 0
						? {
								type: "string",
								title: OTHER_OPTION,
								description: question.multi === true ? OTHER_MULTI_DESCRIPTION : OTHER_SINGLE_DESCRIPTION,
								_meta: airClient
									? withAirMeta(customAnswerMeta, AIR_CUSTOM_ANSWER_KEY, customAnswer)
									: customAnswerMeta,
							}
						: { type: "string", title, ...(description ? { description } : {}) };
			}

			let timedOut = false;
			const content = await elicitFormFromAcpClient(
				connection,
				getSessionId(),
				"askDialog",
				questions.length === 1 ? questions[0].question : `Answer ${questions.length} questions`,
				properties,
				undefined,
				{
					...dialogOptions,
					onTimeout: () => {
						timedOut = true;
						dialogOptions?.onTimeout?.();
					},
				},
			);
			if (timedOut) return timedOutAskDialogResult(questions);
			if (!content) return undefined;

			return {
				kind: "submit",
				results: questions.map((question, index) => {
					const key = `q${index}`;
					const otherKey = `${key}__other`;
					const labels = question.options.map(option => option.label);
					const otherValue = content[otherKey];
					const customInput = typeof otherValue === "string" && otherValue.trim() ? otherValue.trim() : undefined;
					const value = content[key];
					const selectedOptions =
						question.multi === true
							? Array.isArray(value)
								? value.filter(candidate => typeof candidate === "string" && labels.includes(candidate))
								: []
							: customInput === undefined && typeof value === "string" && labels.includes(value)
								? [value]
								: [];
					return {
						id: question.id,
						question: question.question,
						options: labels,
						multi: question.multi ?? false,
						selectedOptions,
						customInput,
					};
				}),
			};
		},
		notify: (message, type) => {
			const update = noticeOrTranscriptUpdate(textNotice(message, type), supportsNotices);
			void Promise.resolve(connection.sessionUpdate({ sessionId: getSessionId(), update })).catch(
				(error: unknown) => {
					logger.warn("Failed to send ACP extension notification", { error });
				},
			);
		},
		onTerminalInput: () => () => {},
		rerenderMessage: () => {},
		getLinkClicksAvailable: () => false,
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async (title, prefill, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"editor",
				title,
				{ type: "string", ...(prefill ? { default: prefill } : {}) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false, error: "Theme changes are unavailable in ACP mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

export class AcpAgent implements Agent {
	#connection: AgentSideConnection;
	#initialSession: AgentSession | undefined;
	#createSession: CreateAcpSession;
	// Preset each session last switched to, so the preset select keeps showing
	// it (not an earlier-named preset with the same roles) while it still matches.
	readonly #appliedModelPresets = new WeakMap<AgentSession, string>();
	#sessions = new Map<string, ManagedSessionRecord>();
	// Each session's active-branch assistant entries, as of the leaf they were
	// indexed at, so one replay indexes them once (see `#replayedMessageId`).
	readonly #replayEntryIndexes = new WeakMap<SessionManager, { leafId: string | null; index: AssistantEntryIndex }>();
	#disposePromise: Promise<void> | undefined;
	#cleanupRegistered = false;
	#clientCapabilities: ClientCapabilities | undefined;
	/** The client sent `clientCapabilities._meta.stateUpdate: true`: run state goes out as `state_update`s. */
	#stateUpdates = false;
	/** The client declared AIR `sessionIndex`: list pages carry AIR rows and the `_session/*` index methods answer. */
	#sessionIndex = false;
	/** Serializes rename/archive/unarchive, so two of them never interleave on one session's title slot. */
	#sessionIndexQueue: Promise<void> = Promise.resolve();
	#cancelCleanupTimeoutMs = ACP_CANCEL_CLEANUP_TIMEOUT_MS;
	#sessionListTiming: SessionListTiming = {};
	/** `_session/list/subscribe` state; set up for a `sessionIndex` client at its first subscribe. */
	#listSubscriptions: SessionListSubscriptions | undefined;
	#blobs = new BlobStore(getBlobsDir());

	constructor(connection: AgentSideConnection, createSession: CreateAcpSession, initialSession?: AgentSession) {
		this.#connection = connection;
		this.#initialSession = initialSession;
		this.#createSession = createSession;
	}

	setCancelCleanupTimeoutForTesting(timeoutMs: number): void {
		this.#cancelCleanupTimeoutMs = Math.max(1, timeoutMs);
	}

	/** Shorten the live session list's coalescing and rescan intervals; applies to later subscriptions. */
	setSessionListTimingForTesting(timing: SessionListTiming): void {
		this.#sessionListTiming = timing;
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		this.#registerConnectionCleanup();
		this.#clientCapabilities = params.clientCapabilities;
		this.#stateUpdates = clientSupportsStateUpdates(params.clientCapabilities);
		this.#sessionIndex = clientSupportsSessionIndex(params.clientCapabilities);
		const authMethods: AuthMethod[] = [
			{
				id: "agent",
				name: "Use existing local credentials",
				description: "Authenticate via the provider keys/OAuth state already configured under ~/.omp.",
			},
		];
		if (params.clientCapabilities?.auth?.terminal === true) {
			authMethods.push({
				type: "terminal",
				id: "terminal",
				name: "Set up omp in terminal",
				description: "Launch the omp TUI to add provider keys and select models.",
				args: [ACP_TERMINAL_AUTH_FLAG],
			});
		}
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: {
				name: "omp",
				title: "omp",
				version: VERSION,
			},
			authMethods,
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: {
					http: true,
					sse: true,
				},
				promptCapabilities: {
					embeddedContext: true,
					image: true,
				},
				sessionCapabilities: {
					list: {},
					fork: {},
					resume: {},
					close: {},
					delete: {},
				},
			},
			// Top-level `_meta`, sibling of `agentCapabilities`: the shared ACP
			// steering extension advertises itself here, so a client learns it may
			// send `_session/steering` without probing the method first. The
			// JetBrains AIR extension advertises its capabilities alongside, to
			// an AIR client only.
			_meta: {
				steering: { supported: true },
				...(isAirClient(params.clientCapabilities)
					? withAirMeta(
							airCapabilityMeta(
								AIR_ASYNC_TASKS_CAPABILITY,
								AIR_PLAN_FILE_CAPABILITY,
								...sessionIndexCapabilities(params.clientCapabilities),
							),
							AIR_GOAL_KEY,
							goalCapability(),
						)
					: {}),
			},
		};
	}

	async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
		// ACP spec: `methodId` must be one of the methods advertised by `initialize`.
		// Reject anything else so malformed clients fail fast rather than appearing
		// authenticated and surfacing a downstream model failure later.
		const supportsTerminalAuth = this.#clientCapabilities?.auth?.terminal === true;
		const validMethods = supportsTerminalAuth ? ["agent", "terminal"] : ["agent"];
		if (!validMethods.includes(params.methodId)) {
			throw new Error(`Unknown ACP auth method: ${params.methodId}`);
		}
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#createNewSessionRecord(params.cwd, params.mcpServers);
		this.#sessionListChanged();
		const response: NewSessionResponse = {
			sessionId: record.session.sessionId,
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record);
		return response;
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#loadManagedSession(params.sessionId, params.cwd, params.mcpServers);
		await this.#replaySessionHistory(record);
		const response: LoadSessionResponse = {
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record, { runStateSnapshot: true });
		return response;
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		if (params.cwd) {
			this.#assertAbsoluteCwd(params.cwd);
		}
		for (const record of this.#sessions.values()) {
			await record.session.sessionManager.flush();
		}
		if (this.#sessionIndex) {
			return await this.#listSessionIndexPage(params);
		}
		// Picker view: untitled 0-turn stubs are hidden but still loadable by id.
		// Sibling worktrees follow `session.worktreeScope`, as the resume picker does.
		const sessions = (
			params.cwd
				? await SessionManager.listForPicker(
						params.cwd,
						undefined,
						undefined,
						cfgSessionWorktreeScope.get(await Settings.init()),
					)
				: await SessionManager.listAllForPicker()
		).sort((left, right) => right.modified.getTime() - left.modified.getTime());
		const offset = this.#parseCursor(params.cursor ?? undefined);
		const paged = sessions.slice(offset, offset + SESSION_PAGE_SIZE);
		const nextOffset = offset + paged.length;
		const requestCwd = params.cwd;
		return {
			// A removed worktree's session is loaded by moving it into the request
			// cwd, so report that cwd: its recorded directory no longer exists.
			sessions: await Promise.all(
				paged.map(async session =>
					this.#toSessionInfo(
						requestCwd && (await SessionManager.isFromRemovedWorktree(session, requestCwd))
							? { ...session, cwd: requestCwd }
							: session,
					),
				),
			),
			nextCursor: nextOffset < sessions.length ? String(nextOffset) : undefined,
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#resumeManagedSession(params.sessionId, params.cwd, params.mcpServers ?? []);
		await this.#replaySessionHistory(record, { send: false });
		const response: ResumeSessionResponse = {
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record, { runStateSnapshot: true });
		return response;
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#forkManagedSession(params);
		this.#sessionListChanged();
		const response: ForkSessionResponse = {
			sessionId: record.session.sessionId,
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record);
		return response;
	}

	async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		if (!record) {
			return {};
		}
		await this.#closeManagedSession(params.sessionId, record);
		return {};
	}

	/**
	 * `session/delete`, as claude-agent-acp answers it. A live session's turn is
	 * cancelled and the session closed first, so nothing writes its transcript
	 * again. Then a `sessionIndex` client deletes for real (an id stored nowhere
	 * and not loaded here is -32002); an AIR client without it uses delete to
	 * mark a session done, so it is archived instead; every other client deletes
	 * for real, and an unknown id succeeds silently. A subagent child id is not a
	 * stored session: a no-op. A session worktree is left in place.
	 */
	async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
		const { sessionId } = params;
		if (isSubagentSessionId(sessionId)) return {};
		const result = await this.#runSessionIndexOperation(async () => {
			if (!this.#sessionIndex && isAirClient(this.#clientCapabilities)) {
				try {
					return await this.#setSessionArchived(sessionId, true);
				} catch (error) {
					if (error instanceof RequestError && error.code === -32002) return {};
					throw error;
				}
			}
			return await this.#deleteStoredSession(sessionId);
		});
		this.#sessionListChanged();
		return result;
	}

	async #deleteStoredSession(sessionId: string): Promise<{ [key: string]: unknown }> {
		const record = this.#sessions.get(sessionId);
		const files = new Set(
			(await findSessionFiles(sessionId)).filter(file => sessionIdFromSessionPath(file) === sessionId),
		);
		const liveFile = record?.session.sessionManager.getSessionFile();
		if (liveFile) files.add(liveFile);
		if (record) await this.#closeManagedSession(sessionId, record);
		if (!record && files.size === 0 && this.#sessionIndex) throw sessionNotFound(sessionId);
		const storage = new FileSessionStorage();
		for (const file of files) {
			try {
				await storage.deleteSessionWithArtifacts(file);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		return {};
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		await this.#applyModeChange(record, params.modeId);
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: this.#buildCurrentModeUpdate(record.session),
		});
		await this.#pushConfigOptionUpdate(record);
		return {};
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		if (typeof params.value === "boolean") {
			// Only options advertised as `boolean` (when the client opted in) take one.
			if (params.configId !== ADVISOR_CONFIG_ID || !this.#clientSupportsBooleanConfigOptions()) {
				throw new Error(`Unsupported boolean ACP config option: ${params.configId}`);
			}
			record.session.setAdvisorEnabled(params.value);
			await this.#pushConfigOptionUpdate(record);
			return { configOptions: this.#buildConfigOptions(record.session) };
		}

		switch (params.configId) {
			case MODE_CONFIG_ID:
				await this.#applyModeChange(record, params.value);
				break;
			case MODEL_CONFIG_ID:
				await this.#setModelById(record.session, params.value);
				break;
			case THINKING_CONFIG_ID:
				this.#setThinkingLevelById(record.session, params.value);
				break;
			case MODEL_PRESET_CONFIG_ID:
				await this.#applyModelPresetById(record.session, params.value);
				break;
			case FAST_MODE_CONFIG_ID:
				this.#setFastModeById(record.session, params.value);
				break;
			case ADVISOR_CONFIG_ID:
				this.#setAdvisorById(record.session, params.value);
				break;
			default:
				throw new Error(`Unknown ACP config option: ${params.configId}`);
		}

		// When mode is changed via the generic config-option API, mirror the
		// `current_mode_update` notification that `setSessionMode` emits so
		// ACP clients tracking session-mode state see a consistent transition.
		if (params.configId === MODE_CONFIG_ID) {
			await this.#connection.sessionUpdate({
				sessionId: record.session.sessionId,
				update: this.#buildCurrentModeUpdate(record.session),
			});
		}

		// For `model`/`thinking`, `#setModelById`/`#setThinkingLevelById` change
		// the session model/thinking level through AgentSession, which now emits
		// a lifetime event (`model_changed`/`thinking_level_changed`) that
		// `#handleLifetimeEvent` turns into a push once the subscription is
		// installed. Only push here when that subscription is not yet
		// installed, so pre-bootstrap callers still see the change without a
		// post-bootstrap duplicate.
		const handledBySubscription =
			(params.configId === THINKING_CONFIG_ID || params.configId === MODEL_CONFIG_ID) &&
			record.lifetimeUnsubscribe !== undefined;
		if (!handledBySubscription) {
			await this.#pushConfigOptionUpdate(record);
		}
		return { configOptions: this.#buildConfigOptions(record.session) };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		const activeTurn = record.promptTurn;
		// A `_session/steering` refusal (`promptRequired`) now only ever
		// happens while no client prompt owns the turn (idle, or an
		// autonomous wake with no client forwarder) or during abort: the
		// mid-dispatch window parks instead (see #handleSessionSteering), so
		// a steer resubmitted through `session/prompt` can only arrive as an
		// idle new turn (queued normally) or inside the abort window — where
		// the implicit cancel below matches the user's stop intent. No
		// resubmission bookkeeping is needed here anymore.
		if (activeTurn && !activeTurn.settled && record.session.isStreaming) {
			// New prompt arrived while the previous turn is still in-flight (e.g. the
			// client sent a message immediately after pressing stop, before or without
			// a preceding session/cancel notification). Implicitly cancel the running
			// turn so the new prompt can queue behind the abort cleanup — identical to
			// what cancel() does when called explicitly. #beginCancelCleanup is
			// idempotent, so a concurrent session/cancel notification is harmless.
			// Mirror cancel()'s timeout handling: if abort() hangs past the cleanup
			// timeout, close the managed session instead of leaving it registered
			// with a still-streaming AgentSession. The queued prompt below observes
			// the same cleanup rejection and fails accordingly.
			this.#beginCancelCleanup(record, activeTurn).catch(async (error: unknown) => {
				logger.warn("ACP cancel cleanup timed out; closing session", {
					acpSessionId: record.session.sessionId,
					error,
				});
				await this.#closeManagedSession(params.sessionId, record);
			});
		}
		// A cancel that lands between this prompt's wire acceptance and its
		// turn slot creation must still stop it (the client believes it stopped
		// the session). The carrier is marked by cancel() and consumed below.
		const cancellation: PromptDispatchCancellation = { cancelled: false };
		record.pendingPromptDispatches.push(cancellation);
		try {
			return await this.#queuePrompt(record, async () => {
				const previousTurn = record.promptTurn;
				if (previousTurn) {
					// Wait for any prompt that's still settling or whose cancel cleanup is
					// still in flight. We deliberately swallow the prompt rejection (the
					// owning caller already received it) but let cleanup rejections
					// propagate — a timed-out cancel must fail this queued prompt instead
					// of letting it run on a session that is about to be closed.
					await previousTurn.promise.catch(() => undefined);
					await previousTurn.cleanup;
				}
				this.#throwIfRecordClosed(record);

				const converted = this.#convertPromptBlocks(params.prompt, record.session.sessionManager.getCwd());
				const pendingPrompt = Promise.withResolvers<PromptResponse>();
				record.promptTurn = {
					abortController: new AbortController(),
					cancelRequested: false,
					settled: false,
					errorTextDelivery: undefined,
					cleanup: undefined,
					inheritedForeignTurn: record.session.isStreaming,
					parked: false,
					usageBaseline: this.#cloneUsageStatistics(record.session.sessionManager.getUsageStatistics()),
					modelUsageBaseline: record.session.sessionManager.getModelUsageStatistics(),
					unsubscribe: undefined,
					resolve: pendingPrompt.resolve,
					reject: pendingPrompt.reject,
					promise: pendingPrompt.promise,
				};

				this.#setRunState(record, "running");
				// A client prompt starts a fresh continuation chain, as a typed TUI message does.
				record.goalContinuation.pendingTurns = 0;
				this.#sessionListChanged();
				record.promptTurn.unsubscribe = record.session.subscribe(event => {
					this.#trackPromptEvent(record, event);
				});

				// Cancelled before the turn ever started (dispatch window or
				// queued behind a cancelled predecessor): settle the wire
				// response cancelled instead of starting a run the client
				// has already stopped.
				if (cancellation.cancelled) {
					const cleanup = this.#beginCancelCleanup(record, record.promptTurn);
					// The wire response already says cancelled, but the cleanup
					// barrier must still be observed: an abort that hangs past
					// the timeout closes the managed session here instead of
					// surfacing an unhandled rejection (mirrors cancel() and
					// the implicit-cancel guard above).
					cleanup.catch(async (error: unknown) => {
						logger.warn("ACP cancel cleanup timed out; closing session", {
							sessionId: record.session.sessionId,
							error,
						});
						await this.#closeManagedSession(record.session.sessionId, record);
					});
					return await pendingPrompt.promise;
				}

				// Autonomous turns stream without an owning promptTurn, so the implicit-cancel
				// guard above cannot fire and a client prompt lands on AgentSession's busy
				// guard. Type that failure for the wire instead of letting transport.ts wrap
				// it as a generic -32603 internal error.
				this.#runPromptOrCommand(record, converted.text, converted.images).catch((error: unknown) => {
					this.#finishPrompt(
						record,
						undefined,
						error instanceof AgentBusyError
							? RequestError.sessionBusy(error.message, {
									reason: "session_busy",
									hint: "steer|followUp|wait",
								})
							: error,
					);
				});

				return await pendingPrompt.promise;
			});
		} finally {
			const index = record.pendingPromptDispatches.indexOf(cancellation);
			if (index >= 0) {
				record.pendingPromptDispatches.splice(index, 1);
			}
		}
	}

	async #queuePrompt(record: ManagedSessionRecord, run: () => Promise<PromptResponse>): Promise<PromptResponse> {
		const nextQueue = Promise.withResolvers<void>();
		const releaseQueue = nextQueue.resolve;
		const previousQueue = record.promptQueue;
		record.promptQueue = {
			promise: nextQueue.promise,
			release: releaseQueue,
		};
		await previousQueue.promise;
		this.#throwIfRecordClosed(record);
		try {
			return await run();
		} finally {
			releaseQueue();
			if (record.promptQueue.release === releaseQueue) {
				record.promptQueue.release = undefined;
			}
		}
	}

	#throwIfRecordClosed(record: ManagedSessionRecord): void {
		if (record.closedError) {
			throw record.closedError;
		}
	}

	#trackPromptEvent(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		const handling = this.#handlePromptEvent(record, event).catch((error: unknown) => {
			logger.warn("ACP prompt event handler failed", { error });
		});
		record.promptEventHandlers.add(handling);
		void handling.finally(() => {
			record.promptEventHandlers.delete(handling);
		});
	}

	async #waitForPromptEventHandlers(record: ManagedSessionRecord): Promise<void> {
		while (record.promptEventHandlers.size > 0) {
			await Promise.allSettled(Array.from(record.promptEventHandlers));
		}
	}

	#trackExtensionUserMessage(record: ManagedSessionRecord, task: Promise<void>): void {
		const tracked = task.catch((error: unknown) => {
			logger.warn("ACP extension sendUserMessage failed", { error });
		});
		record.extensionUserMessageTasks.add(tracked);
		void tracked.finally(() => {
			record.extensionUserMessageTasks.delete(tracked);
		});
	}

	async #waitForExtensionUserMessages(
		record: ManagedSessionRecord,
		baseline: ReadonlySet<Promise<void>>,
	): Promise<void> {
		while (true) {
			const pending = Array.from(record.extensionUserMessageTasks).filter(task => !baseline.has(task));
			if (pending.length === 0) {
				return;
			}
			await Promise.allSettled(pending);
		}
	}

	async #runPromptOrCommand(record: ManagedSessionRecord, text: string, images: AgentImageContent[]): Promise<void> {
		const promptTurn = record.promptTurn;
		const skillResult = await this.#tryRunSkillCommand(record, text);
		if (skillResult || promptTurn?.cancelRequested) {
			return;
		}

		const builtinResult = await executeAcpBuiltinSlashCommand(text, {
			session: record.session,
			sessionManager: record.session.sessionManager,
			settings: record.session.settings,
			cwd: record.session.sessionManager.getCwd(),
			signal: promptTurn?.abortController.signal,
			output: output => this.#emitCommandOutput(record, output),
			refreshCommands: () => this.#emitAvailableCommandsUpdate(record),
			reloadPlugins: () => this.#reloadPluginState(record),
			// `/mcp reauth` writes config-file credentials: reconnect the live
			// manager's entry (with its client-supplied auth surface cleared, a
			// pending automatic attempt superseded, and a name-collision with a
			// config file entry left alone) via the shared engine helper.
			reconnectMcpServer: async (name, selected) => {
				const state = await reconnectMcpManagerServer(record.mcpManager, name, selected);
				// The tools-changed callback that fired during the reconnect only
				// *enqueued* the session refresh onto `record.mcpRefreshChain` —
				// resolving here without awaiting it would let the reauth prompt
				// report success (and the client's next prompt start) while the
				// recovered tools are still unbound, and a refresh failure would
				// surface only in the log behind the success message. The chain's
				// own catch logs such a failure; here it just orders completion.
				if (state) await record.mcpRefreshChain;
				return state;
			},
			// ACP-declared servers (`session/new` `mcpServers`) live in this
			// manager, in no writable config file; `/mcp` lookups must consult it.
			mcpManager: record.mcpManager,
			keepTurnOpenUntilIdle: async () => {
				await record.session.waitForIdle();
				// `AgentSession.#emit()` does not await listeners, so the retried
				// turn's `agent_end` handler — which emits the trailing chunks and
				// end-of-turn updates — can still be in flight once the session is
				// idle. Drain the tracked handlers too, or the prompt response can
				// overtake its own updates. Same pairing as the `!agentInvoked`
				// path below.
				await this.#waitForPromptEventHandlers(record);
			},
			setAcpMode: async modeId => {
				await this.setSessionMode({ sessionId: record.session.sessionId, modeId });
			},
			notifyTitleChanged: async () => {
				await this.#pushSessionInfoUpdate(record);
			},
			reportCompaction: {
				start: () => this.#sendQuietly(record.compaction.start("manual"), "compaction start"),
				finish: outcome =>
					this.#sendQuietly(
						record.compaction.finish(
							outcome.status === "completed"
								? {
										status: "completed",
										summary: outcome.summary,
										preTokens: outcome.tokensBefore,
										postTokens: outcome.tokensAfter,
									}
								: outcome,
						),
						"compaction outcome",
					),
			},
			notifyConfigChanged: async options => {
				// Mirrors `setSessionConfigOption`: once the session-lifetime
				// subscription is installed, `model_changed`/`thinking_level_changed`
				// already reach `#handleLifetimeEvent`, which pushes the
				// `config_option_update`. Pushing again here would make clients
				// redraw their config UI twice for a single change.
				if (options?.handledBySessionEvent && record.lifetimeUnsubscribe !== undefined) {
					await this.#waitForPromptEventHandlers(record);
					return;
				}
				await this.#pushConfigOptionUpdate(record);
			},
		});
		if (promptTurn?.cancelRequested) return;
		if (builtinResult !== false) {
			if ("prompt" in builtinResult) {
				const residualBaseline = new Set(record.extensionUserMessageTasks);
				const residualAgentInvoked = await this.#promptWhenIdle(record, promptTurn, () =>
					record.session.prompt(builtinResult.prompt, { images, synthetic: builtinResult.synthetic }),
				);
				// A residual prompt can itself resolve locally (extension command,
				// custom-TS command, file prompt template). No agent turn means no
				// `agent_end`, so the prompt turn must be settled here — same pairing
				// as the plain-prompt `!agentInvoked` path below — or the ACP
				// `session/prompt` request never resolves (#9206).
				if (!residualAgentInvoked) {
					await this.#waitForExtensionUserMessages(record, residualBaseline);
					await this.#waitForPromptEventHandlers(record);
					this.#finishPrompt(record, { stopReason: "end_turn" });
				}
				return;
			}
			// A builtin such as /compact can change the context with no agent turn.
			await record.compaction.reset();
			await this.#pushUsageUpdate(record);
			this.#finishPrompt(record, { stopReason: "end_turn", ...this.#turnUsage(record, promptTurn) });
			return;
		}

		const extensionPromptBaseline = new Set(record.extensionUserMessageTasks);
		const agentInvoked = await this.#promptWhenIdle(record, promptTurn, () =>
			record.session.prompt(text, { images }),
		);
		// Extension and custom-TS commands are handled locally inside session.prompt().
		// An ACP extension command can still call pi.sendUserMessage(), which starts
		// an async nested prompt through the extension runtime. Keep the ACP turn
		// subscribed until those scheduled prompts and their event handlers drain;
		// only then is `false` proof that the slash command was purely local.
		if (!agentInvoked) {
			await this.#waitForExtensionUserMessages(record, extensionPromptBaseline);
			await this.#waitForPromptEventHandlers(record);
			this.#finishPrompt(record, { stopReason: "end_turn" });
		}
	}

	/**
	 * Start an ACP prompt turn's agent turn via `dispatch` — `session.prompt()`
	 * or `promptCustomMessage()` with no `streamingBehavior` — behind any agent
	 * turn no `session/prompt` owns. A finished background job can start such a turn
	 * after the previous prompt ended; a bare prompt would then hit
	 * AgentSession's busy guard and the user's message would be lost. Instead
	 * the prompt parks until the session is idle and retries, so it runs as the
	 * next turn and settles on its own `agent_end`. Steering into the running
	 * turn is not an option here: the agent loop drains steers and follow-ups
	 * inside that turn, so no `agent_start` of this prompt's own would follow.
	 *
	 * A cancel while parked settles the prompt, aborts the foreign turn, and
	 * never dispatches the message.
	 */
	async #promptWhenIdle(
		record: ManagedSessionRecord,
		promptTurn: PromptTurnState | undefined,
		dispatch: () => Promise<boolean>,
	): Promise<boolean> {
		for (let attempt = 0; ; attempt++) {
			if (promptTurn) {
				// Re-captured with no await before dispatch: a foreign turn may have
				// started or ended since the turn was reserved.
				promptTurn.inheritedForeignTurn = record.session.isStreaming;
				if (attempt > 0) {
					// The turns this prompt waited out are not its usage. A first attempt
					// keeps the reservation baseline, which still counts a builtin's own
					// work before its residual prompt.
					const manager = record.session.sessionManager;
					promptTurn.usageBaseline = this.#cloneUsageStatistics(manager.getUsageStatistics());
					promptTurn.modelUsageBaseline = manager.getModelUsageStatistics();
				}
			}
			try {
				return await dispatch();
			} catch (error) {
				if (!promptTurn || !(error instanceof AgentBusyError)) throw error;
			}
			promptTurn.parked = true;
			try {
				await record.session.waitForIdle();
				// Idle can be reported while another submission is still in setup;
				// yield a macrotask so the retry cannot spin on microtasks.
				await Bun.sleep(0);
			} finally {
				promptTurn.parked = false;
			}
			// Cancelled while parked: the prompt is already settled. `true` tells the
			// caller there is nothing left to settle.
			if (promptTurn.cancelRequested || promptTurn.settled) return true;
		}
	}

	async #tryRunSkillCommand(record: ManagedSessionRecord, text: string): Promise<boolean> {
		if (!record.session.skillsSettings?.enableSkillCommands) {
			return false;
		}
		const parsed = parseSkillInvocation(text);
		if (!parsed) {
			return false;
		}
		const skill = record.session.skills.find(candidate => candidate.name === parsed.name);
		if (!skill) {
			return false;
		}
		const built = await record.session.buildUserSkillPrompt(skill, parsed);
		await this.#promptWhenIdle(record, record.promptTurn, () =>
			record.session.promptCustomMessage({
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: built.message,
				display: true,
				details: built.details,
				attribution: "user",
			}),
		);
		return true;
	}

	async cancel(params: { sessionId: string }): Promise<void> {
		if (isSubagentSessionId(params.sessionId)) {
			await this.#cancelSubagent(params.sessionId);
			return;
		}
		const record = this.#getSessionRecord(params.sessionId);
		// Stop means stop everything accepted on this session: prompts still
		// inside the dispatch window or queued behind the running turn must not
		// stream after the client believes it stopped the session.
		for (const cancellation of record.pendingPromptDispatches) {
			cancellation.cancelled = true;
		}
		const promptTurn = record.promptTurn;
		// A turn whose cancel cleanup is still unwinding counts as in
		// flight: a repeated cancel notification must reuse that barrier
		// (#beginCancelCleanup is idempotent) instead of falling through to
		// the autonomous-run branch below — a second, uncoalesced
		// AgentSession.abort() there can reset or interrupt a replacement
		// prompt that started after the first cleanup.
		if (promptTurn && (!promptTurn.settled || promptTurn.cleanup)) {
			const cleanup = this.#beginCancelCleanup(record, promptTurn);
			try {
				await cleanup;
			} catch (error: unknown) {
				logger.warn("ACP cancel cleanup timed out; closing session", {
					sessionId: record.session.sessionId,
					error,
				});
				await this.#closeManagedSession(record.session.sessionId, record);
			}
			return;
		}
		if (!record.session.isStreaming) {
			return;
		}
		// Autonomous run (steer-triggered follow-up, IRC wake, scheduler turn):
		// no client promptTurn owns it, so #beginCancelCleanup has nothing to
		// settle — but the client's stop is still an explicit interrupt. Abort
		// the run with the same bound as cancel cleanup instead of silently
		// dropping it.
		const timeoutGate = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => timeoutGate.reject(new Error("ACP cancel cleanup timed out")),
			this.#cancelCleanupTimeoutMs,
		);
		try {
			await Promise.race([record.session.abort({ reason: USER_INTERRUPT_LABEL }), timeoutGate.promise]);
		} catch (error: unknown) {
			logger.warn("ACP cancel cleanup timed out; closing session", {
				acpSessionId: record.session.sessionId,
				error,
			});
			await this.#closeManagedSession(record.session.sessionId, record);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * `session/cancel` on a subagent child id kills that one subagent; the
	 * parent turn keeps running. An unknown or finished child is a no-op. A
	 * failed kill is only logged: `session/cancel` is a notification.
	 */
	async #cancelSubagent(childSessionId: string): Promise<void> {
		for (const record of this.#sessions.values()) {
			const relay = record.subagentRelay;
			if (!relay) continue;
			try {
				if (await relay.cancelChild(childSessionId)) return;
			} catch (error) {
				logger.warn("ACP subagent cancel failed", { sessionId: childSessionId, error });
				return;
			}
		}
	}

	/**
	 * Transition a still-running turn into cancellation: mark intent, drop the live-event
	 * subscription, start the bounded `abort()` race, and resolve the ACP prompt response
	 * with `stopReason: "cancelled"` so the client sees acceptance immediately. The
	 * returned promise is the cleanup barrier — it resolves when `abort()` completes and
	 * rejects when the timeout fires. Idempotent: a second call returns the same barrier.
	 */
	#beginCancelCleanup(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		if (promptTurn.cleanup) {
			return promptTurn.cleanup;
		}
		promptTurn.cancelRequested = true;
		promptTurn.abortController.abort();
		promptTurn.unsubscribe?.();
		// The compaction's own end event can no longer reach this turn. The send
		// is queued now, so `cancelled` precedes the prompt response.
		void record.compaction.reset();
		const cleanup = this.#runCancelCleanup(record, promptTurn);
		promptTurn.cleanup = cleanup;
		this.#finishPrompt(record, {
			stopReason: "cancelled",
			...this.#turnUsage(record, promptTurn),
		});
		return cleanup;
	}

	async #runCancelCleanup(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(RequestError.resourceNotFound(record.session.sessionId)),
				this.#cancelCleanupTimeoutMs,
			);
		});
		try {
			await Promise.race([record.session.abort({ reason: USER_INTERRUPT_LABEL }), timeout]);
		} finally {
			if (timer) clearTimeout(timer);
			// Order matters: clear `cleanup` before evicting the slot so the slot-eviction
			// branch matches what `#finishPrompt` saw if it ran first.
			promptTurn.cleanup = undefined;
			if (promptTurn.settled && record.promptTurn === promptTurn) {
				record.promptTurn = undefined;
			}
		}
	}

	async extMethod(method: string, params: { [key: string]: unknown }): Promise<{ [key: string]: unknown }> {
		switch (method) {
			case ASYNC_TASK_STOP_METHOD:
				return await this.#stopAsyncTask(parseAsyncTaskStopRequest(params));
			case SESSION_RENAME_METHOD: {
				if (!this.#sessionIndex) throw RequestError.methodNotFound(method);
				const request = parseRenameSessionRequest(params);
				const result = await this.#runSessionIndexOperation(() => this.#renameSession(request));
				this.#sessionListChanged();
				return result;
			}
			case SESSION_ARCHIVE_METHOD:
			case SESSION_UNARCHIVE_METHOD: {
				if (!this.#sessionIndex) throw RequestError.methodNotFound(method);
				const { sessionId } = parseSessionIdRequest(params);
				const archived = method === SESSION_ARCHIVE_METHOD;
				const result = await this.#runSessionIndexOperation(() => this.#setSessionArchived(sessionId, archived));
				this.#sessionListChanged();
				return result;
			}
			case LIST_SUBSCRIBE_METHOD: {
				if (!this.#sessionIndex) throw RequestError.methodNotFound(method);
				const { cwd } = parseListSubscribeRequest(params);
				return await this.#sessionListSubscriptions().subscribe(cwd);
			}
			case LIST_UNSUBSCRIBE_METHOD: {
				if (!this.#sessionIndex) throw RequestError.methodNotFound(method);
				const { subscriptionId } = parseListUnsubscribeRequest(params);
				this.#listSubscriptions?.unsubscribe(subscriptionId);
				return {};
			}
			case GOAL_CONTROL_METHOD:
				if (!isAirClient(this.#clientCapabilities)) throw RequestError.methodNotFound(method);
				return await this.#controlGoal(parseGoalRequest(params));
			case SPEECH_MODELS_LIST_METHOD:
				return buildAcpSpeechModelsCatalog();
			case "_omp/sessions/listAll": {
				const limit = typeof params.limit === "number" ? Math.max(1, Math.min(5000, params.limit as number)) : 1000;
				const sessions = await SessionManager.listAll();
				const sorted = sessions.sort((l, r) => r.modified.getTime() - l.modified.getTime()).slice(0, limit);
				return {
					sessions: sorted.map(s => this.#toSessionInfo(s)),
					total: sessions.length,
				};
			}
			case "_omp/projects/list": {
				const sessions = await SessionManager.listAll();
				const buckets = new Map<
					string,
					{ cwd: string; sessionCount: number; lastActivityAt: number; lastTitle: string }
				>();
				for (const s of sessions) {
					if (!s.cwd) continue;
					const ts = s.modified.getTime();
					const existing = buckets.get(s.cwd);
					if (existing) {
						existing.sessionCount += 1;
						if (ts > existing.lastActivityAt) {
							existing.lastActivityAt = ts;
							existing.lastTitle = s.title ?? "";
						}
					} else {
						buckets.set(s.cwd, {
							cwd: s.cwd,
							sessionCount: 1,
							lastActivityAt: ts,
							lastTitle: s.title ?? "",
						});
					}
				}
				const projects = Array.from(buckets.values()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
				return { projects, totalSessions: sessions.length };
			}
			case "_omp/chats/byCwd": {
				const cwd = typeof params.cwd === "string" ? (params.cwd as string) : undefined;
				if (!cwd) throw new Error("cwd required");
				const limit = typeof params.limit === "number" ? Math.max(1, Math.min(500, params.limit as number)) : 100;
				const sessions = await SessionManager.list(cwd);
				const sorted = sessions.sort((l, r) => r.modified.getTime() - l.modified.getTime()).slice(0, limit);
				return { sessions: sorted.map(s => this.#toSessionInfo(s)) };
			}
			case "_omp/usage": {
				const [firstRecord] = this.#sessions.values();
				const target = firstRecord?.session ?? this.#initialSession;
				if (!target) {
					return { reports: [] };
				}
				const reports = await target.fetchUsageReports();
				return { reports: reports ?? [] };
			}
			case "_omp/extensions": {
				const cwd = typeof params.cwd === "string" ? (params.cwd as string) : undefined;
				const sm = await Settings.init();
				const disabledIds = cfgDisabledExtensions.get(sm);
				const extensions = await loadAllExtensions(cwd, disabledIds);
				return { extensions: extensions as unknown as Array<{ [key: string]: unknown }> };
			}
			case "_omp/extensions/toggle": {
				const providerId = params.providerId;
				if (typeof providerId !== "string") throw new Error("providerId required");
				if (params.enabled === false) {
					disableProvider(providerId);
					return { enabled: false };
				}
				enableProvider(providerId);
				return { enabled: true };
			}
			case SESSION_STEERING_METHOD:
				return await this.#handleSessionSteering(params);
			default:
				throw new Error(`Unknown ACP ext method: ${method}`);
		}
	}

	/**
	 * `_session/steering` — the steering extension method implemented by
	 * claude-agent-acp and codex-acp (spec proposal: ACP `session/inject`,
	 * agentclientprotocol/agent-client-protocol#1261). Admission goes through
	 * `AgentSession.joinActiveTurn()`, which atomically classifies the target
	 * run and enqueues onto its native steering/follow-up queue:
	 *
	 * - a live run (streaming, or a `session/prompt` turn reserved but still
	 *   dispatching) owns delivery — its agent loop polls the queue at
	 *   tool-batch and model-call boundaries — and the outcome is
	 *   `injected`;
	 * - a run that settles while the steer is being admitted (image
	 *   preprocessing awaits real time) classifies as not-admitted, the
	 *   message never reaches the queue, and no autonomous continuation can
	 *   claim it — the outcome is `promptRequired`;
	 * - an idle session is never started or consumed here: the response is
	 *   always `promptRequired`, so the host submits the content through
	 *   `session/prompt` and keeps owning the turn.
	 *
	 * omp deliberately never returns `startedNewTurn` (claude-agent-acp's
	 * behavior without the `idleBehavior` opt-in) because a detached turn has
	 * no `session/prompt` response to carry a failed start, so a rejection
	 * would be invisible to the client (claude-agent-acp#903). `queue` is
	 * `followUp` when the request opts into the omp-specific
	 * `_meta.steering.queue: "followUp"` routing.
	 */
	async #handleSessionSteering(params: { [key: string]: unknown }): Promise<{ [key: string]: unknown }> {
		// A malformed request can carry null/non-object params (the transport hands
		// extension requests through unvalidated): reading `sessionId` below would
		// throw a TypeError surfaced as -32603. Map to the method's invalid-params
		// contract instead.
		if (typeof params !== "object" || params === null) {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "params must be an object");
		}
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "sessionId required");
		}
		let record: ManagedSessionRecord;
		try {
			record = this.#getSessionRecord(sessionId);
		} catch {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, `unknown session: ${sessionId}`);
		}
		this.#throwIfRecordClosed(record);

		const promptBlocks = toSteeringPromptBlocks(params.prompt);
		const converted = this.#convertPromptBlocks(promptBlocks, record.session.sessionManager.getCwd());
		if (converted.text.length === 0 && converted.images.length === 0) {
			throw RequestError.invalidParams({ method: SESSION_STEERING_METHOD }, "prompt is empty");
		}
		const queue = steeringQueueFromMeta(params._meta);

		try {
			const admitted = await record.session.joinActiveTurn(converted.text, converted.images, { queue });
			if (!admitted) {
				// Not admitted only when no client prompt owns the turn:
				// idle (nothing to inject into — the host resubmits
				// through `session/prompt` as a fresh turn), an autonomous
				// IRC wake streaming with no client forwarder (a steered
				// answer would be invisible — the host keeps its content),
				// or the abort window (a resubmitted prompt there matches
				// the user's stop intent). A steer that lands mid-dispatch
				// parks inside `joinActiveTurn` until the owning prompt
				// goes live and admits it, so it is never refused back.
				return { outcome: "promptRequired", queue };
			}
		} catch (error: unknown) {
			return {
				outcome: "failed",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		return { outcome: "injected", queue };
	}

	async extNotification(_method: string, _params: { [key: string]: unknown }): Promise<void> {}

	get signal(): AbortSignal {
		return this.#connection.signal;
	}

	get closed(): Promise<void> {
		return this.#connection.closed;
	}

	#registerConnectionCleanup(): void {
		if (this.#cleanupRegistered) {
			return;
		}
		this.#cleanupRegistered = true;
		this.#connection.signal.addEventListener(
			"abort",
			() => {
				void this.dispose();
			},
			{ once: true },
		);
	}

	async #createNewSessionRecord(cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const { session, setToolUIContext, eventBus } = normalizeCreatedAcpSession(
			await this.#createSession(path.resolve(cwd), {
				interactivePrompts: this.#clientCapabilities?.elicitation?.form != null,
			}),
		);
		// The session file stays lazy (written with the first assistant message),
		// so a session/new that is never prompted leaves nothing on disk.
		return await this.#registerPreparedSession(session, mcpServers, setToolUIContext, eventBus);
	}

	async #loadManagedSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#assertMatchingCwd(existing.session, cwd);
			await this.#configureMcpServers(existing, mcpServers);
			return existing;
		}

		const storedSession = await this.#findStoredSession(sessionId, cwd);
		if (!storedSession) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		return await this.#openStoredSession(storedSession, cwd, mcpServers, sessionId);
	}

	async #resumeManagedSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#assertMatchingCwd(existing.session, cwd);
			await this.#configureMcpServers(existing, mcpServers);
			return existing;
		}

		const storedSession = await this.#findStoredSession(sessionId, cwd);
		if (!storedSession) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		return await this.#openStoredSession(storedSession, cwd, mcpServers, sessionId);
	}

	async #forkManagedSession(params: ForkSessionRequest): Promise<ManagedSessionRecord> {
		const sourcePath = await this.#resolveForkSourceSessionPath(params.sessionId);
		const { session, setToolUIContext, eventBus } = normalizeCreatedAcpSession(
			await this.#createSession(path.resolve(params.cwd), {
				interactivePrompts: this.#clientCapabilities?.elicitation?.form != null,
			}),
		);
		try {
			const copied = await this.#forkFromRemovedWorktree(sourcePath, session.sessionManager);
			const success = await session.switchSession(copied ?? sourcePath);
			if (!success) {
				throw new Error(`ACP session fork was cancelled: ${params.sessionId}`);
			}
			const forkPoint = this.#resolveForkPoint(params, session.sessionManager);
			// A copy out of a removed worktree already is a whole-session fork; a cut forks the copy again.
			const forked =
				forkPoint !== undefined ? await session.fork(forkPoint) : copied !== undefined || (await session.fork());
			if (!forked) {
				throw new Error(`ACP session fork failed: ${params.sessionId}`);
			}
			if (copied !== undefined && forkPoint !== undefined) {
				// The cut copies the interim copy's artifacts; let that finish before deleting them.
				await session.sessionManager.flush();
				await session.sessionManager.dropSession(copied);
			}
			await this.#titleFork(session, params._meta);
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, params.mcpServers ?? [], setToolUIContext, eventBus);
	}

	/**
	 * The entry `session/fork`'s fork point names in `sessionManager`, the fork
	 * source just opened: an agent message by the entry id session/load
	 * replayed it under, or by the id it streamed under in this process.
	 * Undefined without a fork point; invalid params when it names no agent message.
	 */
	#resolveForkPoint(params: ForkSessionRequest, sessionManager: SessionManager): string | undefined {
		const messageId = forkPointMessageId(params._meta);
		if (messageId === undefined) return undefined;
		const streamed = this.#sessions.get(params.sessionId)?.liveMessageStamps;
		let index: AssistantEntryIndex | undefined;
		for (const candidate of forkPointCandidates(messageId)) {
			const entry = sessionManager.getEntry(candidate);
			if (entry?.type === "message" && entry.message.role === "assistant") return entry.id;
			const stamp = streamed?.get(candidate);
			if (stamp === undefined) continue;
			index ??= indexAssistantEntries(sessionManager.getEntries());
			const entryId = index.byStamp.get(stamp);
			if (entryId !== undefined) return entryId;
		}
		throw RequestError.invalidParams(
			{ messageId },
			`Fork point message ${messageId} was not found in session ${params.sessionId}`,
		);
	}

	/**
	 * Title a fork as `session/fork`'s `_meta` asks: `sessionTitle` as the
	 * user's title, or with `generateSessionTitle`, the title it shows (the
	 * parent's, or `sessionTitle`) only until it is titled after its own turns.
	 */
	async #titleFork(session: AgentSession, meta: unknown): Promise<void> {
		const title = forkSessionTitle(meta);
		if ((meta as { generateSessionTitle?: unknown } | null | undefined)?.generateSessionTitle === true) {
			await session.markTitleInherited(title);
		} else if (title) {
			await session.sessionManager.setSessionName(title, "user");
		}
	}

	async #openStoredSession(
		stored: StoredSessionInfo,
		cwd: string,
		mcpServers: McpServer[],
		sessionId: string,
	): Promise<ManagedSessionRecord> {
		const { session, setToolUIContext, eventBus } = normalizeCreatedAcpSession(
			await this.#createSession(path.resolve(cwd), {
				interactivePrompts: this.#clientCapabilities?.elicitation?.form != null,
			}),
		);
		try {
			const sessionPath = await this.#relocateFromRemovedWorktree(stored, session.sessionManager);
			const success = await session.switchSession(sessionPath);
			if (!success) {
				throw new Error(`ACP session load was cancelled: ${sessionId}`);
			}
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, mcpServers, setToolUIContext, eventBus);
	}

	/**
	 * Move a session recorded in a removed worktree of the request cwd's
	 * repository (e.g. a `/wt` worktree) into that cwd, as `omp --resume` does:
	 * its own directory cannot be entered. Returns the session file to switch to.
	 */
	async #relocateFromRemovedWorktree(stored: StoredSessionInfo, target: SessionManager): Promise<string> {
		const cwd = target.getCwd();
		const sessionDir = target.getSessionDir();
		if (!(await SessionManager.isFromRemovedWorktree(stored, cwd, sessionDir))) return stored.path;
		try {
			const relocated = await SessionManager.openRelocated(stored.path, stored.cwd, cwd, sessionDir);
			const movedPath = relocated.getSessionFile() ?? stored.path;
			await relocated.close();
			return movedPath;
		} catch (error) {
			if (!(error instanceof SessionMoveRefusedError)) throw error;
			throw new Error(
				`Cannot resume ACP session ${stored.id} from removed worktree ${stored.cwd}: ${error.message} Close the session in the other omp process, then load it again.`,
			);
		}
	}

	/**
	 * Fork a session recorded in a removed worktree of the request cwd's
	 * repository into that cwd, as `omp --fork` does: the source cannot be
	 * entered, and forking copies it, so the source stays where it is.
	 * Returns the fork's session file, or undefined for any other source.
	 */
	async #forkFromRemovedWorktree(sourcePath: string, target: SessionManager): Promise<string | undefined> {
		const cwd = target.getCwd();
		const sessionDir = target.getSessionDir();
		const source = await readSessionInfo(sourcePath);
		if (!source || !(await SessionManager.isFromRemovedWorktree(source, cwd, sessionDir))) return undefined;
		const fork = await SessionManager.forkFrom(sourcePath, cwd, sessionDir);
		const forkPath = fork.getSessionFile();
		await fork.close();
		return forkPath;
	}

	async #registerPreparedSession(
		session: AgentSession,
		mcpServers: McpServer[],
		setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined,
		eventBus: EventBus | undefined,
	): Promise<ManagedSessionRecord> {
		const record = this.#createManagedSessionRecord(session, setToolUIContext);
		session.setClientBridge(
			createAcpClientBridge(this.#connection, session.sessionId, this.#clientCapabilities, {
				onPermissionPending: () => {
					if (++record.pendingPermissions === 1 && record.runState === "running") {
						this.#setRunState(record, "requires_action");
					}
				},
				onPermissionSettled: () => {
					// A cancelled run already went idle; its withdrawn request must not revive it.
					if (--record.pendingPermissions === 0 && record.runState === "requires_action") {
						this.#setRunState(record, "running");
					}
				},
			}),
		);
		// Client-declared servers live in `record.mcpManager`, not the session's
		// own (ACP sessions run with `enableMCP: false`); read it live so every
		// reconfiguration's `refreshMCPTools` rebuild renders its instructions.
		session.setMcpServerInstructionsSource(() => record.mcpManager?.getServerInstructions());
		if (eventBus && clientSupportsSubagents(this.#clientCapabilities)) {
			record.subagentRelay = new AcpSubagentRelay({
				sessionId: session.sessionId,
				eventBus,
				// A child's tool call that started a background job is stamped too.
				send: notification => this.#connection.sessionUpdate(this.#stampBackgroundedToolCall(record, notification)),
				getCwd: () => session.sessionManager.getCwd(),
				resolveImageData: data => resolveImageDataSync(this.#blobs, data),
				// Child cancel is offered unless the client is AIR and lists
				// `nativeSubagentSessions` (claude-agent-acp parity): only AIR's
				// native subagent sessions lack it. An AIR client without that
				// capability, such as agent-shell, gets cancel like any client.
				cancellable: !clientSupportsAirCapability(
					this.#clientCapabilities,
					AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY,
				),
				airClient: isAirClient(this.#clientCapabilities),
				// A child mounts its parent's MCP tools under the same names.
				lookupTool: name => session.getToolByName(name),
			});
		}
		// Secondary in-process sessions own no job manager (issue #1923): no relay.
		const asyncJobManager = session.asyncJobManager;
		if (asyncJobManager && clientSupportsAsyncTasks(this.#clientCapabilities)) {
			record.asyncTaskRelay = new AcpAsyncTaskRelay({
				sessionId: session.sessionId,
				manager: asyncJobManager,
				ownerId: session.getAgentId(),
				// A job a subagent started goes to the subagent's child session.
				routeOf: ownerId => record.subagentRelay?.sessionIdOf(ownerId),
				send: notification => this.#connection.sessionUpdate(notification),
			});
		}
		// `record.lifetimeUnsubscribe` is installed in `#scheduleBootstrapUpdates`
		// so it shares the bootstrap race guard — see that comment for why.
		try {
			await this.#restoreStoredGoal(session);
			await this.#configureExtensions(record);
			await this.#configureMcpServers(record, mcpServers);
			// After MCP: connected MCP tools join the active set, which would
			// otherwise leak into the read-only vibe toolset and be missing from
			// the snapshot exit restores.
			await this.#restoreVibeMode(record);
			this.#sessions.set(session.sessionId, record);
			return record;
		} catch (error) {
			await this.#disposeSessionRecord(record);
			throw error;
		}
	}

	async #restoreStoredGoal(session: AgentSession): Promise<void> {
		// Cold resume pauses an active goal, matching the interactive session path.
		const restored = await restoreGoalMode(session, session.sessionManager.buildSessionContext());
		if (restored?.enabled) {
			await session.setActiveToolsByName([...new Set([...session.getEnabledToolNames(), "goal"])]);
		}
	}

	async #restoreVibeMode(record: ManagedSessionRecord): Promise<void> {
		// Same as the interactive resume path: a session persisted in vibe mode
		// re-enters it (without re-recording the mode) and re-adopts its parked
		// workers. The current toolset becomes the one exit restores.
		const { session } = record;
		if (!session.asyncJobManager || session.sessionManager.buildSessionContext().mode !== "vibe") return;
		await VibeSessionRegistry.global().rehydrate(vibeParentSessionOf(session));
		record.vibeMode = await enterVibeMode(session, { persistModeChange: false });
	}

	#createManagedSessionRecord(
		session: AgentSession,
		setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined = undefined,
	): ManagedSessionRecord {
		return {
			session,
			setToolUIContext,
			mcpManager: undefined,
			mcpRefreshChain: undefined,
			pendingMcpStartupChunks: [],
			promptTurn: undefined,
			promptQueue: { promise: Promise.resolve(), release: undefined },
			liveMessageId: undefined,
			liveMessageProgress: undefined,
			liveMessageStamps: new Map(),
			toolArgsById: new Map(),
			extensionsConfigured: false,
			closedError: undefined,
			promptEventHandlers: new Set(),
			pendingPromptDispatches: [],
			extensionUserMessageTasks: new Set(),
			lifetimeUnsubscribe: undefined,
			subagentRelay: undefined,
			asyncTaskRelay: undefined,
			titleUnsubscribe: undefined,
			sentTitle: undefined,
			sentGoal: undefined,
			sentUsage: undefined,
			sentRateLimits: new Map(),
			rateLimitPush: undefined,
			sentConfigWarnings: new Set(),
			compaction: new AcpCompactionLifecycle(
				update => this.#connection.sessionUpdate({ sessionId: session.sessionId, update }),
				this.#compactionReportOptions(),
			),
			goalContinuation: { pendingTurns: 0, previousActivity: undefined, stalled: false },
			vibeMode: undefined,
			planProposal: undefined,
			approvedPlan: undefined,
			runState: "idle",
			pendingPermissions: 0,
		};
	}

	async #handleLifetimeEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
		if (event.type === "goal_updated") {
			// Delivered before the owning turn settles, like config updates below.
			const delivery = this.#pushGoalUpdate(record, event.goal);
			record.promptEventHandlers.add(delivery);
			try {
				await delivery;
			} catch (error) {
				logger.warn("Failed to push the ACP goal update", { sessionId: record.session.sessionId, error });
			} finally {
				record.promptEventHandlers.delete(delivery);
			}
			return;
		}
		if (event.type !== "thinking_level_changed" && event.type !== "model_changed") {
			if (!isPromptTurnInFlight(record.promptTurn)) {
				await this.#handleAutonomousEvent(record, event);
			}
			return;
		}
		// Config delivery is part of command completion, even though the
		// subscription lives beyond an individual prompt turn.
		const delivery = this.#pushConfigOptionUpdate(record);
		record.promptEventHandlers.add(delivery);
		try {
			await delivery;
		} catch (error) {
			logger.warn("Failed to push config_option_update after a lifetime event", {
				acpSessionId: record.session.sessionId,
				eventType: event.type,
				error,
			});
		} finally {
			record.promptEventHandlers.delete(delivery);
		}
	}

	#getSessionRecord(sessionId: string): ManagedSessionRecord {
		const record = this.#sessions.get(sessionId);
		if (!record) {
			throw RequestError.resourceNotFound(sessionId);
		}
		return record;
	}

	#assertMatchingCwd(session: AgentSession, cwd: string): void {
		// Equivalent physical directories (symlinks or macOS /private aliases) are the
		// same workspace; the resolved spellings stay in the error for the client.
		const expected = path.resolve(cwd);
		const actual = path.resolve(session.sessionManager.getCwd());
		if (normalizePathForComparison(expected) !== normalizePathForComparison(actual)) {
			throw new Error(`ACP session ${session.sessionId} is already loaded for ${actual}, not ${expected}`);
		}
	}

	async #resolveForkSourceSessionPath(sessionId: string): Promise<string> {
		const loaded = this.#sessions.get(sessionId);
		if (loaded) {
			if (isPromptTurnInFlight(loaded.promptTurn)) {
				throw new Error(`ACP session fork is unavailable while a prompt is in progress: ${sessionId}`);
			}
			// A live session may not be written yet; forking needs a source file.
			await loaded.session.sessionManager.ensureOnDisk();
			await loaded.session.sessionManager.flush();
			const sessionPath = loaded.session.sessionManager.getSessionFile();
			if (!sessionPath) {
				throw new Error(`ACP session cannot be forked before it is persisted: ${sessionId}`);
			}
			return sessionPath;
		}

		const storedSession = await this.#findStoredSessionById(sessionId);
		if (!storedSession) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		return storedSession.path;
	}

	async #handlePromptEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled || promptTurn.cancelRequested) {
			return;
		}
		if (promptTurn.parked) {
			await this.#handleAutonomousEvent(record, event);
			return;
		}
		if (promptTurn.inheritedForeignTurn) {
			// Every agent loop opens with `agent_start`, so one arriving here is this
			// prompt's own turn: the foreign turn's `agent_end` fired before the
			// subscription while `isStreaming` was still unwinding.
			if (event.type === "agent_start") {
				promptTurn.inheritedForeignTurn = false;
			} else {
				if (event.type === "agent_end") promptTurn.inheritedForeignTurn = false;
				await this.#handleAutonomousEvent(record, event);
				return;
			}
		}

		const streamedAssistantError =
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			event.assistantMessageEvent.type === "error";
		await this.#forwardSessionEvent(record, event, delivery => {
			if (!streamedAssistantError) return;
			// Resolves true only once the error chunk actually reached the
			// client — a failed delivery keeps the agent_end fallback armed.
			const outcome = delivery.then(
				() => true,
				() => false,
			);
			const prior = promptTurn.errorTextDelivery;
			promptTurn.errorTextDelivery = prior ? Promise.all([prior, outcome]).then(([a, b]) => a || b) : outcome;
		});

		if (event.type === "agent_end") {
			await this.#flushMissedFinalAssistantText(record, event);
			await this.#flushUnreportedTurnError(record, event);
			await this.#emitEndOfTurnUpdates(record);
			await this.#waitForAcpPromptIdle(record);
			await record.compaction.reset();
			try {
				await this.#finishGoalModeAfterTurn(record);
			} catch (error) {
				logger.warn("Failed to finish ACP goal mode after turn", { sessionId: record.session.sessionId, error });
			}
			record.liveMessageId = undefined;
			record.liveMessageProgress = undefined;
			const failure = promptTurn.cancelRequested
				? undefined
				: await this.#turnFailure(record, event).catch((error: unknown) => {
						// Settling matters more than classifying: a throw here would leave the prompt pending.
						logger.warn("Failed to classify ACP turn failure", { sessionId: record.session.sessionId, error });
						return undefined;
					});
			if (failure) {
				this.#finishPrompt(record, undefined, failure);
				return;
			}
			const response: PromptResponse = {
				stopReason: this.#resolveStopReason(event, promptTurn.cancelRequested),
				...this.#turnUsage(record, promptTurn),
			};
			if (response.stopReason === "end_turn" && this.#continueGoalInPromptTurn(record, promptTurn, response)) {
				return;
			}
			this.#finishPrompt(record, response);
		}
	}

	/**
	 * Run the next goal-continuation turn inside the prompt turn that just
	 * ended, instead of settling it. Upstream keeps agent-initiated work inside
	 * an owning `session/prompt` for ACP (async job deliveries drain the same
	 * way) so the client shows the session busy and `session/cancel` can stop
	 * it; cancelling aborts the turn, which pauses the goal. The continuation's
	 * own `agent_end` re-enters here and either continues or settles.
	 */
	#continueGoalInPromptTurn(
		record: ManagedSessionRecord,
		promptTurn: PromptTurnState,
		response: PromptResponse,
	): boolean {
		const { session } = record;
		const continuation = record.goalContinuation;
		if (continuation.stalled || promptTurn.cancelRequested || record.promptTurn !== promptTurn) return false;
		if (!cfgGoalContinuationModes.get(session.settings).includes("acp")) return false;
		if (session.getPlanModeState()?.enabled) return false;
		const prompt = session.goalRuntime.buildContinuationPrompt();
		if (!prompt) return false;
		continuation.pendingTurns++;
		const settle = (): void => {
			continuation.pendingTurns = Math.max(0, continuation.pendingTurns - 1);
			this.#finishPrompt(record, response);
		};
		session
			.promptCustomMessage({
				customType: GOAL_CONTINUATION_MESSAGE_TYPE,
				content: prompt,
				display: false,
				attribution: "agent",
			})
			.then(
				started => {
					// `true` resolves after the continuation's own `agent_end` already
					// decided this turn's fate; only a turn that never ran settles here.
					if (!started) settle();
				},
				(error: unknown) => {
					if (!(error instanceof AgentBusyError)) {
						logger.warn("ACP goal continuation failed", { sessionId: session.sessionId, error });
					}
					settle();
				},
			);
		return true;
	}

	#trackGoalContinuation(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		const continuation = record.goalContinuation;
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			continuation.stalled = false;
			continuation.previousActivity = undefined;
			return;
		}
		if (event.type !== "agent_end") return;
		if (continuation.pendingTurns === 0) {
			continuation.stalled = false;
			continuation.previousActivity = undefined;
			return;
		}
		continuation.pendingTurns--;
		const activity = goalContinuationActivity(event.messages);
		continuation.stalled = isStalledGoalContinuation(activity, continuation.previousActivity);
		continuation.previousActivity = activity;
	}

	/**
	 * Stream a turn the agent started on its own — a finished background job or
	 * a queued follow-up flushed by the idle yield queue after `end_turn`. No
	 * `session/prompt` owns it, so nothing here may touch `record.promptTurn`
	 * or settle a `PromptResponse`; the content simply reaches the client as
	 * ordinary `session/update`s instead of vanishing into the session file
	 * (#9157). The `agent_end` fallbacks mirror the owned path so a turn that
	 * only streamed thinking, or failed before streaming, still surfaces.
	 */
	async #handleAutonomousEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
		// Any event of a running loop counts, not only `agent_start`: one that
		// began before the lifetime subscription was installed has no start here.
		if (event.type === "agent_start" || (event.type !== "agent_end" && record.session.isStreaming)) {
			this.#setRunState(record, "running");
		}
		try {
			await this.#forwardSessionEvent(record, event);
			if (event.type === "agent_end") {
				await this.#flushMissedFinalAssistantText(record, event);
				await this.#flushUnreportedTurnError(record, event);
				await this.#finishGoalModeAfterTurn(record);
				await record.compaction.reset();
				record.liveMessageId = undefined;
				record.liveMessageProgress = undefined;
			}
		} catch (error) {
			logger.warn("ACP autonomous event handler failed", { sessionId: record.session.sessionId, error });
		}
		// A prompt waiting behind this run keeps foreground work going; its own
		// settlement sends the idle.
		if (event.type === "agent_end" && !isPromptTurnInFlight(record.promptTurn)) {
			this.#setRunState(record, "idle", { stopReason: this.#resolveStopReason(event, false) });
		}
	}

	/**
	 * Send `state` as a `state_update` when the client opted in and it differs
	 * from the last one sent; `force` repeats it as a snapshot. The state is
	 * recorded synchronously so concurrent event handlers see the transition.
	 */
	#setRunState(
		record: ManagedSessionRecord,
		state: RunStateUpdate["state"],
		idle?: Omit<Extract<RunStateUpdate, { state: "idle" }>, "state">,
		force = false,
	): void {
		if (!this.#stateUpdates || (record.runState === state && !force)) return;
		record.runState = state;
		const update: SessionUpdate = { sessionUpdate: "state_update", state, ...(state === "idle" ? idle : {}) };
		void this.#sendQuietly(
			this.#connection.sessionUpdate({ sessionId: record.session.sessionId, update }),
			"state update",
		);
	}

	async #forwardSessionEvent(
		record: ManagedSessionRecord,
		event: AgentSessionEvent,
		onDelivery?: (delivery: Promise<void>) => void,
	): Promise<void> {
		this.#trackGoalContinuation(record, event);
		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			record.toolArgsById.set(event.toolCallId, event.args);
		}
		if (event.type === "tool_execution_start") this.#trackPlanProposal(record, event);

		this.#prepareLiveAssistantMessage(record, event);
		const imageDataCache = new Map<string, string>();
		const resolveImageDataForAcp = (data: string, mimeType: string | undefined): string => {
			const key = `${mimeType ?? ""}\u0000${data}`;
			const cached = imageDataCache.get(key);
			if (cached !== undefined) return cached;
			const resolved = resolveImageDataSync(this.#blobs, data);
			imageDataCache.set(key, resolved);
			return resolved;
		};
		for (const notification of mapAgentSessionEventToAcpSessionUpdates(event, record.session.sessionId, {
			getMessageId: message => this.#getLiveMessageId(record, message),
			getMessageProgress: message => this.#getLiveMessageProgress(record, message),
			getToolArgs: toolCallId => record.toolArgsById.get(toolCallId),
			cwd: record.session.sessionManager.getCwd(),
			resolveImageData: resolveImageDataForAcp,
			airClient: isAirClient(this.#clientCapabilities),
			lookupTool: name => record.session.getToolByName(name),
		})) {
			const delivery = this.#connection.sessionUpdate(
				this.#withPlanFilePath(record, this.#stampBackgroundedToolCall(record, notification)),
			);
			onDelivery?.(delivery);
			await delivery;
		}
		if (event.type === "tool_execution_end" && record.planProposal?.toolCallId === event.toolCallId) {
			const delivery = this.#reportApprovedPlan(record, event.toolCallId, event.toolName, event.isError === true);
			onDelivery?.(delivery);
			await delivery;
		}
		if (
			(event.type === "auto_compaction_start" || event.type === "auto_compaction_end") &&
			COMPACTION_ACTIONS.has(event.action)
		) {
			const delivery = this.#reportAutoCompaction(record, event);
			onDelivery?.(delivery);
			await delivery;
		}
		const notices = this.#sessionNotices(record, event);
		// Await only when there is something to send: an idle await here would
		// delay the usage reading below past later synchronous session events.
		if (notices.length > 0) await this.#sendSessionNotices(record, notices, onDelivery);
		if (
			(event.type === "message_end" && event.message.role === "assistant") ||
			(event.type === "auto_compaction_end" && event.result !== undefined && !event.aborted)
		) {
			await this.#pushUsageUpdate(record);
		}
		if (event.type === "tool_execution_end") {
			record.toolArgsById.delete(event.toolCallId);
		}
		this.#clearLiveAssistantMessageAfterEvent(record, event);
	}

	/**
	 * Note an `xd://propose` call as it starts. For an AIR `planFile` client,
	 * the plan file is the one its title names, else the plan-mode state's,
	 * when it exists; the approval may later settle on another file.
	 */
	#trackPlanProposal(
		record: ManagedSessionRecord,
		event: Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
	): void {
		const args = event.args as Record<string, unknown> | undefined;
		if (!isProposeToolCall({ name: event.toolName, arguments: args })) return;
		let planFilePath: string | undefined;
		if (clientSupportsPlanFile(this.#clientCapabilities)) {
			const { session } = record;
			for (const url of [proposedPlanFileUrl(args?.content), session.getPlanModeState()?.planFilePath]) {
				planFilePath = url ? this.#existingAcpPlanFile(session, url) : undefined;
				if (planFilePath) break;
			}
		}
		record.planProposal = { toolCallId: event.toolCallId, planFilePath };
	}

	/**
	 * Name the plan file in the `rawInput` of the propose call's start and
	 * result, for an AIR `planFile` client; the approved file wins once known.
	 */
	#withPlanFilePath(record: ManagedSessionRecord, notification: SessionNotification): SessionNotification {
		const { update } = notification;
		const proposal = record.planProposal;
		if (
			(update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") ||
			update.toolCallId !== proposal?.toolCallId
		) {
			return notification;
		}
		const planFilePath = record.approvedPlan?.planFilePath ?? proposal.planFilePath;
		if (!planFilePath) return notification;
		const args = record.toolArgsById.get(update.toolCallId);
		const input = typeof args === "object" && args !== null && !Array.isArray(args) ? args : {};
		return { ...notification, update: { ...update, rawInput: { ...input, planFilePath } } };
	}

	/**
	 * After the propose call's result: an approved plan becomes the session's
	 * markdown plan for a `plan` client, and an AIR `planFile` client gets the
	 * call that clears its plan file. A refined or failed proposal sends nothing.
	 */
	async #reportApprovedPlan(
		record: ManagedSessionRecord,
		toolCallId: string,
		toolName: string,
		isError: boolean,
	): Promise<void> {
		const approved = record.approvedPlan;
		const planFilePath = approved?.planFilePath ?? record.planProposal?.planFilePath;
		record.planProposal = undefined;
		record.approvedPlan = undefined;
		if (!approved || isError) return;
		const { sessionId } = record.session;
		if (planFilePath) {
			await this.#connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId: `${toolCallId}:plan-file-clear`,
					name: toolName,
					title: "Exited Plan Mode",
					kind: "switch_mode",
					status: "completed",
					rawInput: { planFilePath: "" },
					content: [],
				},
			});
		}
		const content = approved.planContent.trim();
		if (this.#clientCapabilities?.plan != null && content) {
			await this.#connection.sessionUpdate({
				sessionId,
				update: { sessionUpdate: "plan_update", plan: { type: "markdown", planId: "plan-mode", content } },
			});
		}
	}

	#compactionReportOptions(): { presentation: "compaction_update" | "tool_call"; airClient: boolean } {
		return {
			presentation: clientSupportsCompactionUpdates(this.#clientCapabilities) ? "compaction_update" : "tool_call",
			airClient: isAirClient(this.#clientCapabilities),
		};
	}

	/** Await a report whose failure must not fail the command that triggered it. */
	async #sendQuietly(delivery: Promise<void>, what: string): Promise<void> {
		try {
			await delivery;
		} catch (error) {
			logger.warn(`Failed to send the ACP ${what}`, { error });
		}
	}

	/** Open or close the compaction entity of an automatic context-rewriting compaction. */
	async #reportAutoCompaction(
		record: ManagedSessionRecord,
		event: Extract<AgentSessionEvent, { type: "auto_compaction_start" | "auto_compaction_end" }>,
	): Promise<void> {
		if (event.type === "auto_compaction_start") {
			await record.compaction.start("automatic");
			return;
		}
		let outcome: CompactionOutcome;
		if (event.aborted) {
			outcome = { status: "cancelled" };
		} else if (event.skipped) {
			outcome = { status: "cancelled", skipped: event.errorMessage ? { reason: event.errorMessage } : {} };
		} else if (event.result) {
			outcome = {
				status: "completed",
				summary: event.result.summary,
				preTokens: event.result.tokensBefore,
				postTokens: record.session.getContextUsage()?.tokens ?? undefined,
			};
		} else {
			outcome = { status: "failed", error: event.errorMessage ?? "Compaction failed" };
		}
		await record.compaction.finish(outcome);
	}

	/** The session notices an event carries. */
	#sessionNotices(record: ManagedSessionRecord, event: AgentSessionEvent): SessionNotice[] {
		if (event.type === "config_warnings_changed") {
			return newConfigWarningNotices(record.session.configWarnings, record.sentConfigWarnings);
		}
		const notice = mapSessionNoticeEvent(event);
		return notice ? [notice] : [];
	}

	/**
	 * Send notices: a `notice` to a client that declares `session.notices`,
	 * else a bold-label line under its own `messageId`, so it never merges
	 * into the live assistant message.
	 */
	async #sendSessionNotices(
		record: ManagedSessionRecord,
		notices: SessionNotice[],
		onDelivery?: (delivery: Promise<void>) => void,
	): Promise<void> {
		const supportsNotices = clientSupportsNotices(this.#clientCapabilities);
		for (const notice of notices) {
			const delivery = this.#connection.sessionUpdate({
				sessionId: record.session.sessionId,
				update: noticeOrTranscriptUpdate(notice, supportsNotices),
			});
			onDelivery?.(delivery);
			await delivery;
		}
	}

	/**
	 * Marks the `tool_call_update` of a tool call whose job was backgrounded with
	 * AIR `asyncTasks.backgrounded`, so the client links the card to its task.
	 * Only updates forwarded after the job is announced carry it: an `async` or
	 * zero-wait job is announced as it registers, so its tool call's final update
	 * is stamped (the spawn itself rides the relay's own queue, so it may reach
	 * the client just before or after that update); an auto-backgrounded job is
	 * announced when the foreground wait gives up, so updates streamed during
	 * that wait are not stamped, while the final one is.
	 */
	#stampBackgroundedToolCall(record: ManagedSessionRecord, notification: SessionNotification): SessionNotification {
		const { update } = notification;
		if (
			update.sessionUpdate !== "tool_call_update" ||
			!record.asyncTaskRelay?.isBackgroundedToolCall(update.toolCallId)
		) {
			return notification;
		}
		return {
			...notification,
			update: { ...update, _meta: withAirMeta(update._meta, AIR_ASYNC_TASKS_CAPABILITY, { backgrounded: true }) },
		};
	}

	/**
	 * `_session/async_task/stop`: cancel one announced background job without
	 * touching the prompt turn. Resolves after the `stopped` state update is
	 * delivered. Only tasks this session announced (and not yet finished) are
	 * stoppable, including one a subagent started (announced on the child's
	 * session, stopped through the root session as in claude-agent-acp);
	 * anything else — including an unknown or already closed session —
	 * answers `{ stopped: false }`.
	 */
	async #stopAsyncTask(params: AsyncTaskStopRequest): Promise<{ stopped: boolean }> {
		const record = this.#sessions.get(params.sessionId);
		const relay = record?.asyncTaskRelay;
		const manager = record?.session.asyncJobManager;
		if (!record || !relay || !manager || !relay.canStop(params.asyncTaskId)) return { stopped: false };
		const stopped = manager.cancel(params.asyncTaskId, { ownerId: relay.ownerOf(params.asyncTaskId) });
		await relay.flush();
		return { stopped };
	}

	async #finishGoalModeAfterTurn(record: ManagedSessionRecord): Promise<void> {
		const { session } = record;
		const completed = completeExitingGoal(session);
		// ACP keeps the `goal` tool enabled exactly while a goal is enabled or a
		// /guided-goal interview is running (tool on, no goal yet), so drop it
		// once the goal completes or is paused by the agent.
		const state = session.getGoalModeState();
		if ((completed || (state && !state.enabled)) && session.getEnabledToolNames().includes("goal")) {
			await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "goal"));
		}
	}

	/**
	 * Deliver the final visible answer when the assistant `message_end` never
	 * reached this prompt turn's subscription. Session event handlers are
	 * fire-and-forget (`Agent#emit` does not await async listeners), and
	 * `agent_end` is flushed through the session's `#endInFlight` path while the
	 * assistant `message_end` fan-out can still be parked on extension delivery —
	 * so `agent_end` can overtake `message_end`. Once the turn finishes,
	 * `#finishPrompt` unsubscribes and the fallback text emission in
	 * `mapAssistantMessageEnd` is lost for good: a client that only received
	 * `agent_thought_chunk`s stays stuck on the thinking block (#4902). The live
	 * message progress records whether visible text ever reached the client; if
	 * it has not, emit the last assistant message's text before the prompt
	 * resolves. A `message_end` that lands during the end-of-turn waits still
	 * takes the normal mapper path and sees `textEmitted` already set, so the
	 * answer is delivered exactly once.
	 */
	async #flushMissedFinalAssistantText(
		record: ManagedSessionRecord,
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
	): Promise<void> {
		const progress = record.liveMessageProgress;
		if (!progress || progress.textEmitted) {
			return;
		}
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (!lastAssistant) {
			return;
		}
		const text = extractAssistantMessageText(lastAssistant);
		if (text.length === 0) {
			return;
		}
		progress.textEmitted = true;
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text },
				messageId: record.liveMessageId,
			},
		});
	}

	/**
	 * Surface a turn-fatal provider error that never reached the client. A
	 * request that fails before streaming any assistant events — e.g. GitHub
	 * Copilot's `HTTP 400 model_not_supported` — emits only
	 * `agent_end` with an empty assistant message carrying `errorMessage`
	 * (`Agent#runLoop`'s catch), so no `message_update`/`message_end` ever maps
	 * to a session update and the client sees the turn end silently. Errors
	 * that did stream are tracked via {@link PromptTurnState.errorTextDelivery};
	 * the fallback awaits that delivery and re-sends only when it failed.
	 */
	async #flushUnreportedTurnError(
		record: ManagedSessionRecord,
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
	): Promise<void> {
		const streamedDelivery = record.promptTurn?.errorTextDelivery;
		if (streamedDelivery && (await streamedDelivery)) {
			return;
		}
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (lastAssistant?.stopReason !== "error") {
			return;
		}
		const errorMessage = lastAssistant.errorMessage;
		if (!errorMessage || isSilentAbort(lastAssistant)) {
			return;
		}
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: errorMessage },
				messageId: record.liveMessageId ?? crypto.randomUUID(),
			},
		});
	}

	async #waitForAcpPromptIdle(record: ManagedSessionRecord): Promise<void> {
		for (let pass = 0; pass < ACP_ASYNC_DELIVERY_DRAIN_MAX_PASSES; pass++) {
			await record.session.waitForIdle();
			const delivered = await record.session.drainAsyncJobDeliveriesForAcp({
				timeoutMs: ACP_ASYNC_DELIVERY_DRAIN_TIMEOUT_MS,
			});
			if (!delivered) {
				return;
			}
		}

		await record.session.waitForIdle();
	}

	#prepareLiveAssistantMessage(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant" &&
			(event.type === "message_start" || !record.liveMessageId || !record.liveMessageProgress)
		) {
			record.liveMessageId = crypto.randomUUID();
			record.liveMessageProgress = { textEmitted: false, thoughtEmitted: false };
		}
	}

	/**
	 * Reset live-message tracking once the assistant `message_end` is handled.
	 * The `agent_end` reset happens inside the `agent_end` branch of
	 * `#handlePromptEvent` — after `#flushMissedFinalAssistantText` — so a
	 * `message_end` that arrives during the end-of-turn waits maps against the
	 * real progress instead of resurrecting a fresh one (which would double-emit
	 * the final answer).
	 */
	#clearLiveAssistantMessageAfterEvent(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const stamp = assistantMessageStamp(event.message);
			if (record.liveMessageId && stamp) record.liveMessageStamps.set(record.liveMessageId, stamp);
			record.liveMessageId = undefined;
			record.liveMessageProgress = undefined;
		}
	}

	#getLiveMessageId(record: ManagedSessionRecord, message: unknown): string | undefined {
		if (typeof message !== "object" || message === null) {
			return undefined;
		}
		record.liveMessageId ??= crypto.randomUUID();
		return record.liveMessageId;
	}

	#getLiveMessageProgress(
		record: ManagedSessionRecord,
		message: unknown,
	): { textEmitted: boolean; thoughtEmitted: boolean } | undefined {
		if (typeof message !== "object" || message === null) {
			return undefined;
		}
		record.liveMessageProgress ??= { textEmitted: false, thoughtEmitted: false };
		return record.liveMessageProgress;
	}

	#finishPrompt(record: ManagedSessionRecord, response?: PromptResponse, error?: unknown): void {
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled) {
			return;
		}
		promptTurn.settled = true;
		promptTurn.unsubscribe?.();
		this.#sessionListChanged();
		// Keep the slot occupied until cancel cleanup finishes — `#runCancelCleanup`
		// evicts the slot in its finally block once both flags say it's safe.
		if (!promptTurn.cleanup && record.promptTurn === promptTurn) {
			record.promptTurn = undefined;
		}
		// Sent before the response settles, so the client sees idle first.
		if (error !== undefined) {
			this.#setRunState(record, "idle", { stopReason: "error", error: jsonRpcError(error) });
			promptTurn.reject(error);
			return;
		}
		const settled = response ?? { stopReason: "end_turn" };
		this.#setRunState(record, "idle", {
			stopReason: settled.stopReason,
			...(settled.usage ? { usage: settled.usage } : {}),
		});
		promptTurn.resolve(settled);
	}

	#resolveStopReason(
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
		cancelRequested: boolean,
	): PromptResponse["stopReason"] {
		if (cancelRequested) {
			return "cancelled";
		}
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		const reason = lastAssistant?.stopReason;
		switch (reason) {
			case "aborted":
				return "cancelled";
			case "length":
				return "max_tokens";
			case "error": {
				const errorMessage = lastAssistant?.errorMessage ?? "";
				if (REFUSAL_ERROR_PATTERN.test(errorMessage)) {
					return "refusal";
				}
				return "end_turn";
			}
			default:
				return "end_turn";
		}
	}

	/**
	 * The error a prompt turn fails with when its provider failed and nothing
	 * recovered it, or undefined. Read once the session is idle, from the
	 * session's last assistant message rather than the event's: a failed
	 * attempt that a retry or fallback then answered emits its own `agent_end`
	 * first. As claude-agent-acp does for a client without AIR session
	 * failures, the prompt is rejected with `-32603 Internal error: <text>`,
	 * the only signal an ACP client has that the turn failed rather than
	 * finished; the error text has already gone out as a message chunk. A
	 * usage limit is said in the Claude SDK's usage-limit words, after the
	 * rejected limit window is pushed, so a client reading claude-agent-acp's
	 * usage-limit failures reads omp's. A refusal and a silent abort keep
	 * their own outcome.
	 */
	async #turnFailure(
		record: ManagedSessionRecord,
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
	): Promise<RequestError | undefined> {
		// A run with no assistant message of its own did not fail on a provider;
		// the session's last one would be an earlier turn's.
		if (!event.messages.some(message => message.role === "assistant")) return undefined;
		const last = record.session.getLastAssistantMessage();
		if (last?.stopReason !== "error" || isSilentAbort(last)) return undefined;
		const errorMessage = last.errorMessage || "Unknown error";
		if (REFUSAL_ERROR_PATTERN.test(errorMessage)) return undefined;
		const limit = await record.session.usageLimitFailure(last);
		if (!limit) return RequestError.internalError(undefined, errorMessage);
		// The turn end's push, not a second one: a second would skip the window
		// the first already claimed and return before its notification is sent.
		await Promise.race([record.rateLimitPush, Bun.sleep(RATE_LIMIT_PUSH_WAIT_MS)]);
		return RequestError.internalError(undefined, usageLimitFailureText(last.provider, limit.resetAtMs));
	}

	async #emitCommandOutput(record: ManagedSessionRecord, text: string): Promise<void> {
		if (!text) {
			return;
		}
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text },
				messageId: crypto.randomUUID(),
			},
		});
	}

	#assertAbsoluteCwd(cwd: string): void {
		if (!path.isAbsolute(cwd)) {
			throw new Error(`ACP cwd must be absolute: ${cwd}`);
		}
	}

	/**
	 * Flattens prompt blocks into the text and images of one user message.
	 * Attached files — the blocks a client sends in place of an `@path`
	 * mention — get the `<file path="…">` wrapper the TUI uses for `@path`
	 * mentions, so the model always sees which file it is reading.
	 */
	#convertPromptBlocks(blocks: PromptRequest["prompt"], cwd: string): { text: string; images: AgentImageContent[] } {
		const textParts: string[] = [];
		const images: AgentImageContent[] = [];
		// A `file:` URI shows as a path (cwd-relative inside the cwd); any other
		// URI stays verbatim — the read tool accepts URLs. `session/prompt`
		// blocks are not field-validated, so a non-string uri must not throw.
		const attachedPath = (uri: string): string =>
			typeof uri === "string" && uri.toLowerCase().startsWith("file://")
				? formatPathRelativeToCwd(uri, cwd)
				: String(uri);
		for (const block of blocks) {
			switch (block.type) {
				case "text":
					textParts.push(block.text);
					break;
				case "image":
					images.push({ type: "image", data: block.data, mimeType: block.mimeType });
					// Name the image when the client says where it came from, as the
					// TUI does for an `@image.png` mention.
					if (typeof block.uri === "string" && block.uri.length > 0) {
						textParts.push(formatFileMention({ path: attachedPath(block.uri), content: "" }));
					}
					break;
				case "resource": {
					const resourcePath = attachedPath(block.resource.uri);
					// Select arms by *type*, not key presence: `session/prompt`
					// blocks reach here without the `_session/steering`
					// validation, and a mixed shape (a string blob plus a
					// non-string text key) would otherwise inject the raw
					// field value as text instead of the image. The `in`
					// checks narrow the union; the typeof checks keep a
					// malformed arm from winning it.
					if ("text" in block.resource && typeof block.resource.text === "string") {
						textParts.push(formatFileMention({ path: resourcePath, content: block.resource.text }));
					} else if (
						"blob" in block.resource &&
						typeof block.resource.blob === "string" &&
						typeof block.resource.mimeType === "string" &&
						block.resource.mimeType.startsWith("image/")
					) {
						// `embeddedContext: true` covers both text and blob resources, but
						// blobs aren't directly consumable by the LLM. Route image blobs
						// to the images array so the user's intent survives; everything
						// else falls back to the skipped-read note below.
						images.push({ type: "image", data: block.resource.blob, mimeType: block.resource.mimeType });
						textParts.push(formatFileMention({ path: resourcePath, content: "" }));
					} else {
						textParts.push(
							formatFileMention({ path: resourcePath, content: "(skipped auto-read: binary file)" }),
						);
					}
					break;
				}
				case "resource_link": {
					// A bare reference (agent-shell sends one for a file over its
					// embed limit) takes the TUI's skipped-read form, so the model
					// reads the file itself when it needs the contents.
					const size = typeof block.size === "number" ? `, ${formatBytes(block.size)}` : "";
					textParts.push(
						formatFileMention({
							path: attachedPath(block.uri),
							content: `(skipped auto-read: not embedded by the client${size})`,
						}),
					);
					break;
				}
				case "audio":
					textParts.push("[audio omitted]");
					break;
			}
		}
		return {
			text: textParts.join("\n\n").trim(),
			images,
		};
	}

	async #pushConfigOptionUpdate(record: ManagedSessionRecord): Promise<void> {
		await this.#pushConfigOptionUpdateForSession(record.session);
	}

	async #pushConfigOptionUpdateForSession(session: AgentSession): Promise<void> {
		await this.#connection.sessionUpdate({
			sessionId: session.sessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions: this.#buildConfigOptions(session),
			},
		});
	}

	#buildConfigOptions(session: AgentSession): SessionConfigOption[] {
		const currentModeId = this.#getCurrentModeId(session);
		const modeOptions = this.#getAvailableModes(session).map(mode => ({
			value: mode.id,
			name: mode.name,
			description: mode.description,
		}));
		const configOptions: SessionConfigOption[] = [
			{
				id: MODE_CONFIG_ID,
				name: "Mode",
				category: "mode",
				type: "select",
				currentValue: currentModeId,
				options: modeOptions,
			},
		];

		const models = session.getAvailableModels();
		const currentModel = session.model;
		if (models.length > 0) {
			configOptions.push({
				id: MODEL_CONFIG_ID,
				name: "Model",
				category: "model",
				type: "select",
				currentValue: currentModel ? this.#toModelId(currentModel) : this.#toModelId(models[0]),
				options: models.map(model => ({
					value: this.#toModelId(model),
					name: `${model.provider}/${model.name}`,
					description: `${model.provider}/${model.id}`,
				})),
			});
		}

		configOptions.push({
			id: THINKING_CONFIG_ID,
			name: "Thinking",
			category: "thought_level",
			type: "select",
			currentValue: this.#toThinkingConfigValue(
				session.model?.reasoning ? this.#getConfiguredThinkingLevel(session) : undefined,
			),
			options: this.#buildThinkingOptions(session),
		});
		const fastOption = this.#buildFastModeOption(session);
		if (fastOption) configOptions.push(fastOption);
		const presetOption = this.#buildModelPresetOption(session);
		if (presetOption) configOptions.push(presetOption);
		configOptions.push(this.#buildAdvisorOption(session));
		return configOptions;
	}

	#clientSupportsBooleanConfigOptions(): boolean {
		return this.#clientCapabilities?.session?.configOptions?.boolean !== undefined;
	}

	/**
	 * `/fast` for the active model's service-tier family: `off`/`on`, plus
	 * `ultra` when the model offers the OpenAI `ultrafast` tier. Absent for
	 * models with no service tier (nothing to toggle).
	 */
	#buildFastModeOption(session: AgentSession): SessionConfigOption | undefined {
		const model = session.model;
		if (!model || !serviceTierFamily(model)) return undefined;
		const options = [
			{ value: FAST_MODE_OFF, name: "Off", description: "Standard service" },
			{ value: FAST_MODE_ON, name: "On", description: "Priority service tier" },
		];
		if (shouldSendServiceTier("ultrafast", model)) {
			options.push({ value: FAST_MODE_ULTRA, name: "Ultra", description: "OpenAI ultrafast tier" });
		}
		const current = session.isUltrafastModeEnabled()
			? FAST_MODE_ULTRA
			: session.isFastModeEnabled()
				? FAST_MODE_ON
				: FAST_MODE_OFF;
		return {
			id: FAST_MODE_CONFIG_ID,
			name: "Fast mode",
			description: "Priority service for this model family in this session",
			category: "model_config",
			type: "select",
			currentValue: current,
			options,
		};
	}

	#setFastModeById(session: AgentSession, value: string): void {
		switch (value) {
			case FAST_MODE_OFF:
				session.setFastMode(false);
				return;
			case FAST_MODE_ON:
				if (!session.setFastMode(true)) throw new Error("Fast mode is unavailable for the current model.");
				return;
			case FAST_MODE_ULTRA:
				if (!session.setUltrafastMode(true)) throw new Error("Ultrafast is unavailable for the current model.");
				return;
			default:
				throw new Error(`Unknown ACP fast mode value: ${value}`);
		}
	}

	/**
	 * Advisor toggle: a native `boolean` when the client opted in, else an
	 * `on`/`off` select. Enabled but inactive (no model on the `advisor` role)
	 * is called out in the description.
	 */
	#buildAdvisorOption(session: AgentSession): SessionConfigOption {
		const enabled = session.isAdvisorEnabled();
		const stats = session.getAdvisorStats();
		const base = {
			id: ADVISOR_CONFIG_ID,
			name: "Advisor",
			description:
				enabled && !stats.active
					? "A second model reviews each turn — enabled, but no model is assigned to the advisor role"
					: "A second model reviews each turn and injects notes",
		};
		if (this.#clientSupportsBooleanConfigOptions()) {
			return { ...base, type: "boolean", currentValue: enabled };
		}
		return {
			...base,
			type: "select",
			currentValue: enabled ? TOGGLE_ON : TOGGLE_OFF,
			options: [
				{ value: TOGGLE_OFF, name: "Off" },
				{ value: TOGGLE_ON, name: "On" },
			],
		};
	}

	#setAdvisorById(session: AgentSession, value: string): void {
		if (value !== TOGGLE_ON && value !== TOGGLE_OFF) throw new Error(`Unknown ACP advisor value: ${value}`);
		session.setAdvisorEnabled(value === TOGGLE_ON);
	}

	/**
	 * Saved model presets as one select. The current value is the preset last
	 * applied in this session while the session still matches it, else the first
	 * matching preset, else `_custom`. Uncategorized so clients keep treating the
	 * `model` option as the single model picker.
	 */
	#buildModelPresetOption(session: AgentSession): SessionConfigOption | undefined {
		const { settings } = session;
		const presets = getModelPresetNames(settings).flatMap(name => {
			const lookup = getModelPreset(settings, name);
			return lookup.kind === "found" ? [{ name, preset: lookup.preset }] : [];
		});
		if (presets.length === 0) return undefined;
		const thinkingLevel = this.#getConfiguredThinkingLevel(session);
		const matches = (entry: (typeof presets)[number]) =>
			sessionMatchesModelPreset(settings, entry.preset, thinkingLevel);
		const applied = this.#appliedModelPresets.get(session);
		const current =
			presets.find(entry => entry.name === applied && matches(entry))?.name ??
			presets.find(matches)?.name ??
			MODEL_PRESET_CUSTOM;
		const options = presets.map(entry => ({
			value: entry.name,
			name: entry.name,
			description: Object.entries(entry.preset.modelRoles)
				.map(([role, selector]) => `${role}: ${selector}`)
				.join(", "),
		}));
		if (current === MODEL_PRESET_CUSTOM) {
			options.push({
				value: MODEL_PRESET_CUSTOM,
				name: "Custom",
				description: "Roles differ from every saved preset",
			});
		}
		return {
			id: MODEL_PRESET_CONFIG_ID,
			name: "Model preset",
			description: "Switch every model role to a saved preset for this session",
			type: "select",
			currentValue: current,
			options,
		};
	}

	/** Session-only preset switch: roles become runtime overrides; nothing is persisted. */
	async #applyModelPresetById(session: AgentSession, name: string): Promise<void> {
		if (name === MODEL_PRESET_CUSTOM) throw new Error("Custom is not a preset; pick a saved preset.");
		const result = await applyModelPreset(session.settings, session, name, { sessionOnly: true });
		switch (result.kind) {
			case "switched":
				this.#appliedModelPresets.set(session, name);
				return;
			case "missing":
				throw new Error(`Unknown ACP model preset: ${name}`);
			case "invalid":
				throw new Error(`Model preset "${name}" is malformed: ${result.reason}`);
			case "unavailable":
				throw new Error(`Model preset "${name}" not applied: ${result.reason}`);
			case "failed":
				this.#appliedModelPresets.set(session, name);
				throw new Error(
					`Model preset "${name}" roles set for this session, but the model was not switched: ${result.reason}`,
				);
		}
	}

	#buildThinkingOptions(session: AgentSession): Array<{ value: string; name: string; description?: string }> {
		return [
			{ value: THINKING_OFF, name: "Off" },
			{ value: AUTO_THINKING, name: "Auto", description: "Auto-detect per prompt" },
			...session.getAvailableThinkingLevels().map(level => ({
				value: level,
				name: level,
			})),
		];
	}
	#getConfiguredThinkingLevel(session: AgentSession): string | undefined {
		const configuredThinkingLevel = (session as { configuredThinkingLevel?: () => string | undefined })
			.configuredThinkingLevel;
		return typeof configuredThinkingLevel === "function"
			? configuredThinkingLevel.call(session)
			: session.thinkingLevel;
	}

	#toThinkingConfigValue(value: string | undefined): string {
		return value && value !== "inherit" ? value : THINKING_OFF;
	}

	async #setModelById(session: AgentSession, modelId: string): Promise<void> {
		const model = session.getAvailableModels().find(candidate => this.#toModelId(candidate) === modelId);
		if (!model) {
			throw new Error(`Unknown ACP model: ${modelId}`);
		}
		await session.setModel(model);
	}

	#setThinkingLevelById(session: AgentSession, value: string): void {
		const thinkingLevel = parseConfiguredThinkingLevel(value);
		if (!thinkingLevel) {
			throw new Error(`Unknown ACP thinking level: ${value}`);
		}
		session.setThinkingLevel(thinkingLevel);
	}

	#toModelId(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#getAvailableModes(session: AgentSession): Array<{ id: string; name: string; description: string }> {
		const modes = [{ id: ACP_DEFAULT_MODE_ID, name: "Default", description: "Standard ACP headless mode" }];
		if (cfgPlanEnabled.get(session.settings)) {
			modes.push({
				id: ACP_PLAN_MODE_ID,
				name: "Plan",
				description: "Read-only planning mode that drafts a plan to a markdown file before any code changes",
			});
		}
		// Vibe workers run as background jobs; secondary in-process sessions own
		// no job manager (issue #1923), so they cannot direct workers.
		if (session.asyncJobManager) {
			modes.push({
				id: ACP_VIBE_MODE_ID,
				name: "Vibe",
				description: "Direct persistent fast/good worker sessions with a read-only toolset",
			});
		}
		return modes;
	}

	#getCurrentModeId(session: AgentSession): string {
		if (session.getVibeModeState()?.enabled) return ACP_VIBE_MODE_ID;
		return session.getPlanModeState()?.enabled ? ACP_PLAN_MODE_ID : ACP_DEFAULT_MODE_ID;
	}

	/**
	 * Switch the session's ACP mode. Mode-picker switches between plan and vibe
	 * transition directly (exit one, enter the other) so the client's single
	 * mode selector never sticks; an active goal still blocks both.
	 */
	async #applyModeChange(record: ManagedSessionRecord, modeId: string): Promise<void> {
		const { session } = record;
		const availableModes = this.#getAvailableModes(session);
		if (!availableModes.some(mode => mode.id === modeId)) {
			throw new Error(`Unsupported ACP mode: ${modeId}`);
		}
		const goalActive = session.getGoalModeState() !== undefined || isGoalInterviewActive(session);
		const vibeActive = session.getVibeModeState()?.enabled === true;
		if (modeId === ACP_VIBE_MODE_ID) {
			if (vibeActive) return;
			if (goalActive) throw new Error("Exit goal mode before entering vibe mode.");
			// Enter first so a failed entry leaves plan mode intact.
			record.vibeMode = await enterVibeMode(session);
			session.setPlanProposalHandler?.(null);
			session.setPlanModeState(undefined);
			return;
		}
		if (modeId === ACP_PLAN_MODE_ID && goalActive) {
			throw new Error("Exit goal mode before entering plan mode.");
		}
		if (vibeActive) {
			// Exiting aborts the running turn; leave that to `session/cancel` so
			// the prompt turn settles through the normal cancel path.
			if (session.isStreaming) throw new Error("Cancel the running turn before exiting vibe mode.");
			await exitVibeMode(session, record.vibeMode);
			record.vibeMode = undefined;
		}
		if (modeId === ACP_PLAN_MODE_ID) {
			const previous = session.getPlanModeState();
			session.setPlanModeState({
				enabled: true,
				planFilePath: previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL,
				workflow: previous?.workflow ?? "parallel",
				reentry: previous !== undefined,
			});
			// Mirror `InteractiveMode.#enterPlanMode`: register the plan-proposal
			// handler that consumes `xd://propose` writes from plan mode. Without
			// this, proposal dispatch falls through and plan mode has no approval
			// path (issue #1869).
			session.setPlanProposalHandler?.(title => this.#handleAcpPlanProposal(session, title));
		} else {
			session.setPlanProposalHandler?.(null);
			session.setPlanModeState(undefined);
		}
	}

	/**
	 * Plan-proposal handler installed while ACP plan mode is active. The agent
	 * submits the finalized plan by writing its `<slug>`/title to
	 * `xd://propose`; this handler validates the plan file, normalizes the
	 * title, asks the ACP client to confirm (via `unstable_createElicitation`
	 * when supported), and on approval keeps the chosen plan path, exits plan
	 * mode, and notifies the client so the agent regains full tools.
	 *
	 * Mirrors `InteractiveMode.#handlePlanProposal` for the parts the agent sees
	 * (same `PlanApprovalDetails` shape). Clients without form-mode elicitation
	 * get an auto-approve so plan mode is never stranded — the agent always has
	 * a way out.
	 */
	async #handleAcpPlanProposal(session: AgentSession, title: string): Promise<AgentToolResult<unknown>> {
		const record = this.#sessions.get(session.sessionId);
		// An approval whose propose result never reached the client (a dropped
		// turn's events) must not surface on this proposal.
		if (record) record.approvedPlan = undefined;
		const state = session.getPlanModeState();
		if (!state?.enabled) {
			throw new ToolError("Plan mode is not active.");
		}
		const {
			planFilePath,
			planContent,
			title: resolvedTitle,
		} = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url => this.#readAcpPlanFile(session, url),
			listPlanFiles: () => this.#listAcpLocalPlanFiles(session),
		});
		// A turn cancel while the approval dialog is open settles as refine and
		// withdraws the dialog.
		const turnSignal = record?.promptTurn?.abortController.signal;
		const approved = await this.#requestAcpPlanApprovalChoice(
			session.sessionId,
			resolvedTitle,
			planContent,
			turnSignal,
		);
		const details: PlanApprovalDetails = {
			planFilePath,
			title: resolvedTitle,
			planExists: true,
		};
		if (!approved) {
			// Rejection keeps plan mode active for another planning turn. Promote the
			// reviewed path into plan-mode state so the next `#buildPlanModeMessage()`
			// targets the plan just reviewed, not the stale state path.
			if (state.planFilePath !== planFilePath) {
				session.setPlanModeState({ ...state, planFilePath });
			}
			const normalizedTitle = normalizePlanTitle(resolvedTitle).title;
			return {
				content: [
					{
						type: "text" as const,
						text: `Plan refinement requested. Update the plan file, then write ${normalizedTitle} to xd://propose again when ready.`,
					},
				],
				details,
			};
		}
		// Approved. Set the plan reference so the next turn injects the plan
		// content as context (the file keeps its agent-chosen name — no rename),
		session.setPlanReferencePath(planFilePath);
		if (record) {
			record.approvedPlan = {
				planContent,
				planFilePath: clientSupportsPlanFile(this.#clientCapabilities)
					? this.#existingAcpPlanFile(session, planFilePath)
					: undefined,
			};
		}
		session.setPlanProposalHandler?.(null);
		session.setPlanModeState(undefined);
		let autosaveFailed = false;
		try {
			await autosaveApprovedPlan({
				settings: session.settings,
				cwd: session.sessionManager.getCwd(),
				title: resolvedTitle,
				planContent,
			});
		} catch (error) {
			logger.warn("Failed to autosave approved plan", {
				acpSessionId: session.sessionId,
				error,
			});
			autosaveFailed = true;
		}
		try {
			await this.#connection.sessionUpdate({
				sessionId: session.sessionId,
				update: this.#buildCurrentModeUpdate(session),
			});
			await this.#pushConfigOptionUpdateForSession(session);
		} catch (error) {
			logger.warn("Failed to emit mode updates after plan approval", {
				acpSessionId: session.sessionId,
				error,
			});
		}
		return {
			content: [
				{
					type: "text" as const,
					text: autosaveFailed
						? `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation. (Plan autosave failed; continuing.)`
						: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
				},
			],
			details,
		};
	}

	#resolveAcpPlanFilePath(session: AgentSession, planFilePath: string): string {
		return resolvePlanFilePath(planFilePath, {
			localProtocolOptions: {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			},
			cwd: session.sessionManager.getCwd(),
		});
	}

	#existingAcpPlanFile(session: AgentSession, planFilePath: string): string | undefined {
		return existingPlanFileSync(planFilePath, {
			localProtocolOptions: {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			},
			cwd: session.sessionManager.getCwd(),
		});
	}

	async #readAcpPlanFile(session: AgentSession, planFilePath: string): Promise<string | null> {
		const resolvedPath = this.#resolveAcpPlanFilePath(session, planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}
	}

	/** `local://` URLs of plan files in the session-local root, newest first —
	 *  the `resolveApprovedPlan` fallback for a dropped `extra.title`. */
	async #listAcpLocalPlanFiles(session: AgentSession): Promise<string[]> {
		const localRoot = this.#resolveAcpPlanFilePath(session, "local://");
		try {
			const entries = await fs.readdir(localRoot, { withFileTypes: true });
			const plans = await Promise.all(
				entries
					.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
					.map(async entry => {
						const stat = await fs.stat(path.join(localRoot, entry.name)).catch(() => null);
						return { url: `local://${entry.name}`, mtime: stat?.mtimeMs ?? 0 };
					}),
			);
			return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
		} catch {
			return [];
		}
	}

	/**
	 * Ask the ACP client to confirm plan approval. Returns `true` only on an
	 * explicit `APPROVE_OPTION` selection. Refine, dismissal (`undefined`), or
	 * any unrecognized value falls through to refine semantics — the caller
	 * keeps plan mode active and surfaces guidance text to the agent. Clients
	 * without `elicitation.form` support auto-approve because there is no
	 * confirmation surface available; without that, plan mode would strand
	 * the agent (the bug this method exists to fix).
	 */
	async #requestAcpPlanApprovalChoice(
		sessionId: string,
		title: string,
		planContent: string,
		signal: AbortSignal | undefined,
	): Promise<boolean> {
		const supportsForm = this.#clientCapabilities?.elicitation?.form != null;
		if (!supportsForm) return true;
		// Include a short preview of the plan so the user has context in the
		// dialog. Keep the body bounded — Zed renders elicitation messages
		// inline and a multi-thousand-line plan blows out the dialog.
		const previewLines = planContent.split("\n").slice(0, 12).join("\n");
		const ellipsis = planContent.split("\n").length > 12 ? "\n…" : "";
		const message = `Approve plan "${title}" and start implementation?\n\n${previewLines}${ellipsis}`;
		const value = await elicitFromAcpClient(
			this.#connection,
			sessionId,
			"select",
			message,
			{ type: "string", enum: [APPROVE_OPTION, REFINE_OPTION] },
			signal ? { signal } : undefined,
		);
		// Approve ONLY on the explicit approve selection. Dismissal, cancel,
		// timeout, or any other non-approve response falls through to refine
		// semantics so closing the dialog can never grant write access.
		return value === APPROVE_OPTION;
	}

	#buildModeState(session: AgentSession): SessionModeState {
		return {
			availableModes: this.#getAvailableModes(session),
			currentModeId: this.#getCurrentModeId(session),
		};
	}

	#buildCurrentModeUpdate(session: AgentSession): SessionUpdate {
		return {
			sessionUpdate: "current_mode_update",
			currentModeId: this.#getCurrentModeId(session),
		};
	}

	async #buildAvailableCommands(session: AgentSession): Promise<AvailableCommand[]> {
		return toAcpAvailableCommands(await buildAvailableSlashCommands(session));
	}

	/**
	 * A `session/list` page for an AIR `sessionIndex` client: filtered by the
	 * archive state, ordered by last prompt (else last message) descending,
	 * then session id, and paged by an opaque cursor bound to the request.
	 * Without `includeWorktrees`, the sessions of the repository's other live
	 * worktrees are left out; a removed worktree's session stays listed under
	 * the request cwd, where a load moves it.
	 */
	async #listSessionIndexPage(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		const options = parseSessionIndexListOptions(params._meta);
		const requestCwd = params.cwd ?? undefined;
		const scope = { cwd: requestCwd ?? null, includeWorktrees: options.includeWorktrees, archived: options.archived };
		const after = params.cursor ? decodeSessionIndexCursor(params.cursor, scope) : undefined;
		const rows = await this.#collectSessionIndexRows(requestCwd, options);
		const remaining = after ? rows.filter(row => compareSessionIndexPositions(row.position, after) > 0) : rows;
		const page = remaining.slice(0, options.limit);
		const last = page.at(-1);
		const agentWorktrees = new Map<string, boolean>();
		return {
			sessions: page.map(row => this.#toSessionIndexRow(row.session, row.updatedAtMs, agentWorktrees)),
			nextCursor:
				last && remaining.length > page.length ? encodeSessionIndexCursor(last.position, scope) : undefined,
		};
	}

	/**
	 * Every `sessionIndex` row of `requestCwd` (all projects without one) in
	 * list order, for `session/list` pages and the live list alike.
	 */
	async #collectSessionIndexRows(
		requestCwd: string | undefined,
		options: { includeWorktrees: boolean; archived: ArchivedFilter },
	): Promise<Array<{ session: StoredSessionInfo; position: SessionIndexPosition; updatedAtMs: number }>> {
		const stored = (
			requestCwd ? await SessionManager.listForPicker(requestCwd) : await SessionManager.listAllForPicker()
		).sort((left, right) => right.modified.getTime() - left.modified.getTime());
		const ownDir = requestCwd ? path.resolve(SessionManager.getDefaultSessionDir(requestCwd)) : undefined;
		const rows: Array<{ session: StoredSessionInfo; position: SessionIndexPosition; updatedAtMs: number }> = [];
		const listed = new Set<string>();
		for (const candidate of stored) {
			if (listed.has(candidate.id) || !matchesArchivedFilter(candidate.archived === true, options.archived))
				continue;
			let session = candidate;
			if (requestCwd && path.resolve(path.dirname(candidate.path)) !== ownDir) {
				if (await SessionManager.isFromRemovedWorktree(candidate, requestCwd)) {
					session = { ...candidate, cwd: requestCwd };
				} else if (!options.includeWorktrees) {
					continue;
				}
			}
			listed.add(session.id);
			const updatedAtMs = sessionIndexUpdatedAtMs(session);
			const orderAtMs = isoToMs(session.activity?.lastPromptAt) ?? updatedAtMs;
			rows.push({ session, updatedAtMs, position: { orderAtMs, sessionId: session.id } });
		}
		rows.sort((left, right) => compareSessionIndexPositions(left.position, right.position));
		return rows;
	}

	/** The live list's view of `cwd`: the `session/list` rows of every archive state, worktrees included. */
	async #sessionListRows(cwd: string): Promise<SessionInfo[]> {
		for (const record of this.#sessions.values()) {
			await record.session.sessionManager.flush();
		}
		const rows = await this.#collectSessionIndexRows(cwd, { includeWorktrees: true, archived: "all" });
		const agentWorktrees = new Map<string, boolean>();
		return rows.map(row => this.#toSessionIndexRow(row.session, row.updatedAtMs, agentWorktrees));
	}

	/** The session directories behind {@link #sessionListRows}: the cwd's own and its worktrees'. */
	async #sessionListDirs(cwd: string): Promise<string[]> {
		const own = SessionManager.getDefaultSessionDir(cwd);
		return [own, ...(await worktreeSessionDirs(cwd, own))];
	}

	#sessionListSubscriptions(): SessionListSubscriptions {
		this.#listSubscriptions ??= new SessionListSubscriptions({
			...this.#sessionListTiming,
			rows: cwd => this.#sessionListRows(cwd),
			dirs: cwd => this.#sessionListDirs(cwd),
			notify: changes => this.#connection.extNotification(LIST_CHANGES_METHOD, changes),
		});
		return this.#listSubscriptions;
	}

	/** One of this connection's sessions changed its list row: live list subscribers recompute. */
	#sessionListChanged(): void {
		this.#listSubscriptions?.markDirty();
	}

	/**
	 * A list row with its AIR fields; a session loaded here reports its live state, model and cost.
	 * `agentWorktrees` memoizes the worktree check per cwd for one list build only, so a
	 * removed worktree is noticed on the next build.
	 */
	#toSessionIndexRow(
		session: StoredSessionInfo,
		updatedAtMs: number,
		agentWorktrees: Map<string, boolean>,
	): SessionInfo {
		const base = this.#toSessionInfo(session);
		const record = this.#sessions.get(session.id);
		const activity = session.activity;
		const fields: SessionIndexRowFields = { archived: session.archived === true };
		if (activity?.lastPromptAt) fields.lastPromptAt = activity.lastPromptAt;
		const model = record?.session.model?.id ?? activity?.model;
		if (model) fields.model = model;
		const forkedFrom = parentSessionId(session.parentSessionPath);
		if (forkedFrom) fields.forkedFrom = forkedFrom;
		const running = record !== undefined && (isPromptTurnInFlight(record.promptTurn) || record.session.isStreaming);
		// `pendingPermissions` is counted for every client; `runState` only for one that opted into `state_update`.
		fields.state = running
			? record.pendingPermissions > 0
				? "requires_action"
				: "running"
			: session.status === "error"
				? "error"
				: "idle";
		if (activity?.lastTurnEndedAt) fields.lastTurnEndedAt = activity.lastTurnEndedAt;
		const cost = record?.session.sessionManager.getUsageStatistics().cost ?? 0;
		if (cost > 0) fields.cost = { amount: cost, currency: "USD" };
		if (session.cwd) {
			let agentWorktree = agentWorktrees.get(session.cwd);
			if (agentWorktree === undefined) {
				agentWorktree = isAgentManagedWorktree(session.cwd);
				agentWorktrees.set(session.cwd, agentWorktree);
			}
			if (agentWorktree) fields.agentWorktree = true;
		}
		return {
			...base,
			updatedAt: new Date(updatedAtMs).toISOString(),
			_meta: withAirFields(base._meta, fields),
		};
	}

	#runSessionIndexOperation(
		operation: () => Promise<{ [key: string]: unknown }>,
	): Promise<{ [key: string]: unknown }> {
		const run = this.#sessionIndexQueue.then(operation, operation);
		this.#sessionIndexQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Every stored file of `sessionId` (an exact id), or `-32002` when there is none. */
	async #storedSessionFiles(sessionId: string): Promise<Array<{ path: string; id: string }>> {
		const files = (await findSessionFiles(sessionId)).filter(file => sessionIdFromSessionPath(file) === sessionId);
		if (files.length === 0) throw sessionNotFound(sessionId);
		return files.map(file => ({ path: file, id: sessionId }));
	}

	async #renameSession(request: RenameSessionRequest): Promise<{ [key: string]: unknown }> {
		const record = this.#sessions.get(request.sessionId);
		if (record) {
			await record.session.setSessionName(request.title, "user");
			// The title listener sends the update once bootstrap installed it.
			if (!record.titleUnsubscribe) await this.#pushSessionInfoUpdate(record);
			return {};
		}
		for (const stored of await this.#storedSessionFiles(request.sessionId)) {
			await SessionManager.updateStoredSessionMeta(stored, { title: request.title });
		}
		return {};
	}

	/**
	 * Archive or unarchive a session. Archiving one loaded here stops it, as
	 * claude-agent-acp does: its turn is cancelled and the session closed, so a
	 * later prompt fails until the client unarchives and loads it again.
	 * Unarchiving never loads a session.
	 */
	async #setSessionArchived(sessionId: string, archived: boolean): Promise<{ [key: string]: unknown }> {
		const record = this.#sessions.get(sessionId);
		if (!record) {
			for (const stored of await this.#storedSessionFiles(sessionId)) {
				await SessionManager.updateStoredSessionMeta(stored, { archived });
			}
			return {};
		}
		if (archived) await this.#cancelPromptForClose(record);
		await record.session.sessionManager.setArchived(archived);
		await record.session.sessionManager.flush();
		if (archived) await this.#closeManagedSession(sessionId, record);
		// Sent after the close: an archive's update is the session's last.
		await this.#connection.sessionUpdate({
			sessionId,
			update: { sessionUpdate: "session_info_update", _meta: withAirFields(undefined, { archived }) },
		});
		return {};
	}

	#toSessionInfo(session: StoredSessionInfo): SessionInfo {
		return {
			sessionId: session.id,
			cwd: session.cwd,
			title: session.title,
			updatedAt: session.modified.toISOString(),
			_meta: {
				messageCount: session.messageCount,
				size: session.size,
			},
		};
	}

	#scheduleBootstrapUpdates(record: ManagedSessionRecord, options: { runStateSnapshot?: boolean } = {}): void {
		const sessionId = record.session.sessionId;
		// Defer first notifications until the response has reached the client.
		// Zed's agent-client-protocol reader dispatches responses and
		// notifications to different async tasks; sending the first
		// `available_commands_update` from `setTimeout(0)` reliably loses the
		// race against the response handler and Zed logs `Received session
		// notification for unknown session` then drops the update — leaving
		// the slash-command palette empty (#1015 follow-up; see
		// zed-industries/zed#55965 for the same race biting other ACP agents).
		// `ACP_BOOTSTRAP_RACE_GUARD_MS` is invisible to the operator and large
		// enough that the response future has scheduled before our timer fires
		// on stdio-only transports.
		//
		// The session-lifetime subscription is installed inside the same timer
		// so it shares this guard — without it, an extension's `session_start`
		// handler (or any async work it schedules) calling `setThinkingLevel`
		// would push a `config_option_update` for a session id the client
		// hasn't been told about yet. The pre-bootstrap thinking level is
		// reported in the response's `configOptions`, so deferring the
		// notification loses no state.
		setTimeout(() => {
			if (this.#connection.signal.aborted || this.#sessions.get(sessionId) !== record) {
				return;
			}
			if (!record.lifetimeUnsubscribe) {
				const unsubscribeEvents = record.session.subscribe(event => {
					void this.#handleLifetimeEvent(record, event);
				});
				// Skills/commands rediscovery (live `skills.*`/`commands.*` edits, MCP
				// prompts, manage_skill) re-advertises the palette.
				const unsubscribeCommands = record.session.subscribeCommandMetadataChanged(() => {
					void this.#emitAvailableCommandsUpdate(record).catch(error => {
						logger.warn("Failed to emit ACP available commands update", { error: String(error) });
					});
				});
				record.lifetimeUnsubscribe = () => {
					unsubscribeEvents();
					unsubscribeCommands();
				};
			}
			if (!record.titleUnsubscribe) {
				record.titleUnsubscribe = record.session.sessionManager.onSessionNameChanged(() => {
					void this.#pushSessionInfoUpdate(record);
				});
			}
			// A loaded or resumed session can be one this connection already runs;
			// the client re-attaching to it gets the state again.
			if (options.runStateSnapshot && (isPromptTurnInFlight(record.promptTurn) || record.session.isStreaming)) {
				this.#setRunState(record, "running", undefined, true);
			}
			void this.#emitBootstrapUpdates(sessionId, record);
			void this.#emitDiscoveredModelOptions(sessionId, record);
		}, ACP_BOOTSTRAP_RACE_GUARD_MS);
	}

	async #emitDiscoveredModelOptions(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		try {
			// Discovery is independent of the command/title/usage bootstrap above,
			// which must stay responsive when a provider is slow or never starts.
			await record.session.modelRegistry.awaitBackgroundRefresh();
			if (this.#connection.signal.aborted || this.#sessions.get(sessionId) !== record) {
				return;
			}
			// Build after discovery so selections changed while it was pending are
			// reflected in the snapshot sent to the client.
			await this.#pushConfigOptionUpdate(record);
		} catch (error) {
			logger.warn("Failed to publish ACP model options after background discovery", {
				sessionId,
				error: String(error),
			});
		}
	}

	async #emitBootstrapUpdates(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		if (this.#sessions.get(sessionId) !== record) {
			return;
		}
		// MCP startup failures queued by `#configureMcpServers` flush here,
		// behind the bootstrap race guard, so the client can finally attribute
		// them to a session it knows.
		for (const { name, message, oauthCapable } of record.pendingMcpStartupChunks.splice(0)) {
			const recovery = oauthCapable
				? `until it is reauthorized (/mcp reauth ${name}) or the client restarts the session`
				: "until the client restarts the session";
			await this.#connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: `MCP server "${name}" failed to connect: ${message}. Its tools are unavailable ${recovery}.`,
					},
				},
			});
		}
		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await this.#buildAvailableCommands(record.session),
			},
		});
		await this.#pushSessionInfoUpdate(record, record.session.sessionManager.getHeader()?.timestamp);
		await this.#pushUsageUpdate(record);
		const goal = record.session.getGoalModeState()?.goal;
		if (goal) await this.#pushGoalUpdate(record, goal);
	}

	async #emitAvailableCommandsUpdate(record: ManagedSessionRecord): Promise<void> {
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await this.#buildAvailableCommands(record.session),
			},
		});
	}

	/**
	 * Reload plugin/registry state for an ACP session. Mirrors the interactive
	 * `/reload-plugins` and `/move` flows: invalidates the plugin-roots cache,
	 * refreshes task agents, resets the capability cache, refreshes the
	 * session's slash-command state, then re-advertises commands so the client
	 * sees newly installed/disabled plugins.
	 */
	async #reloadPluginState(record: ManagedSessionRecord): Promise<void> {
		const cwd = record.session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		await refreshAgentDiscovery(cwd, record.session.effectiveExtensionRoots);
		await record.session.refreshSkillsAndCommands();
		await this.#emitAvailableCommandsUpdate(record);
	}

	async #emitEndOfTurnUpdates(record: ManagedSessionRecord): Promise<void> {
		await this.#pushUsageUpdate(record);
		await this.#pushSessionInfoUpdate(record);
		// Not awaited: a usage cache miss is a network call, which must not delay the prompt response.
		// A usage-limited turn waits on it, bounded, before failing (`#turnFailure`).
		record.rateLimitPush = this.#pushRateLimitUpdates(record);
	}

	/**
	 * Sends the session's context usage and cost, unless they equal the values
	 * last sent. Called at bootstrap, after each assistant message and each
	 * compaction, and at the end of a turn, so the client's context gauge follows
	 * the turn instead of jumping once at its end.
	 */
	async #pushUsageUpdate(record: ManagedSessionRecord): Promise<void> {
		const contextUsage = record.session.getContextUsage();
		if (!contextUsage) return;
		const cost = record.session.sessionManager.getUsageStatistics().cost;
		const used = contextUsage.tokens ?? 0;
		const sent = `${contextUsage.contextWindow}:${used}:${cost}`;
		if (sent === record.sentUsage) return;
		record.sentUsage = sent;
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "usage_update",
				size: contextUsage.contextWindow,
				used,
				cost: cost > 0 ? { amount: cost, currency: "USD" } : undefined,
			},
		});
	}

	/**
	 * Sends each subscription rate-limit window of the session's model and
	 * account that changed since last sent, one `usage_update` per window under
	 * `_meta["_claude/rateLimit"]`, as claude-agent-acp does. The reports come
	 * from the auth storage's usage cache, which refetches at most every few
	 * minutes; a failed fetch skips the push.
	 */
	async #pushRateLimitUpdates(record: ManagedSessionRecord): Promise<void> {
		const { session } = record;
		const sessionId = session.sessionId;
		try {
			const model = session.model;
			if (!model) return;
			const reports = await session.fetchUsageReports();
			if (!reports || this.#sessions.get(sessionId) !== record) return;
			const contextUsage = session.getContextUsage();
			if (!contextUsage) return;
			const infos = rateLimitInfos(reports, {
				provider: model.provider,
				modelId: model.id,
				identity: session.modelRegistry.authStorage.oauth.identity(model.provider, sessionId),
			});
			const cost = session.sessionManager.getUsageStatistics().cost;
			for (const info of infos) {
				const sent = JSON.stringify(info);
				if (record.sentRateLimits.get(info.rateLimitType) === sent) continue;
				record.sentRateLimits.set(info.rateLimitType, sent);
				await this.#connection.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "usage_update",
						size: contextUsage.contextWindow,
						used: contextUsage.tokens ?? 0,
						cost: cost > 0 ? { amount: cost, currency: "USD" } : undefined,
						_meta: { [RATE_LIMIT_META_KEY]: info },
					},
				});
			}
		} catch (error) {
			logger.debug("Failed to push ACP rate limits", { sessionId, error: String(error) });
		}
	}

	/** Sends the session's title, unless it has none or the client already has it. */
	async #pushSessionInfoUpdate(record: ManagedSessionRecord, updatedAt = new Date().toISOString()): Promise<void> {
		const title = record.session.sessionName;
		if (!title || title === record.sentTitle) return;
		record.sentTitle = title;
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: { sessionUpdate: "session_info_update", title, updatedAt },
		});
	}

	/** Sends an AIR client the session's goal snapshot (`null` once gone), unless it already has it. */
	async #pushGoalUpdate(record: ManagedSessionRecord, goal: Goal | null | undefined): Promise<void> {
		if (!isAirClient(this.#clientCapabilities)) return;
		const snapshot = toGoalSnapshot(goal);
		const sent = JSON.stringify(snapshot);
		if (sent === record.sentGoal) return;
		record.sentGoal = sent;
		await this.#connection.sessionUpdate({
			sessionId: record.session.sessionId,
			update: { sessionUpdate: "session_info_update", _meta: withAirMeta(undefined, AIR_GOAL_KEY, snapshot) },
		});
	}

	/**
	 * `_session/goal`: set or clear a loaded session's goal, with `/goal`'s
	 * checks; a refused change is `-32602`. Setting on an idle session runs
	 * `/goal set <objective>` as a prompt and answers after that turn; setting
	 * while a turn streams changes the goal in place, without cancelling the
	 * turn or starting another, and goal continuation picks it up when the turn
	 * ends. Clearing never starts a turn.
	 */
	async #controlGoal(request: GoalRequest): Promise<{ [key: string]: unknown }> {
		const record = this.#sessions.get(request.sessionId);
		if (!record) throw sessionNotFound(request.sessionId);
		this.#throwIfRecordClosed(record);
		const { session } = record;
		const context = { session, settings: session.settings };
		const refusal = acpGoalActionRefusal(context, request);
		if (refusal) throw RequestError.invalidParams({ action: request.action }, refusal);
		if (request.action === "set" && !session.isStreaming) {
			await this.prompt({
				sessionId: request.sessionId,
				prompt: [{ type: "text", text: `/goal set ${request.objective}` }],
			});
			return {};
		}
		const failure = await applyAcpGoalAction(context, request);
		if (failure) throw RequestError.invalidParams({ action: request.action }, failure);
		return {};
	}

	#cloneUsageStatistics(usage: UsageStatistics): UsageStatistics {
		return {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			orchestrationInput: usage.orchestrationInput,
			orchestrationOutput: usage.orchestrationOutput,
			orchestrationCacheRead: usage.orchestrationCacheRead,
			premiumRequests: usage.premiumRequests,
			cost: usage.cost,
			subagentCost: usage.subagentCost,
		};
	}

	/**
	 * The `usage` and `_meta.quota` of the turn `promptTurn` opened, from the
	 * session's running totals against the baselines it took. `quota` follows
	 * claude-agent-acp: `token_count` mirrors `usage`, and `model_usage` splits
	 * the spend by `<provider>/<model>`, subagent results under the model they
	 * resolved to. Spend with no model (a subagent result that never resolved
	 * one) counts in `token_count` only, so the rows can sum to less.
	 */
	#turnUsage(
		record: ManagedSessionRecord,
		promptTurn: PromptTurnState | undefined,
	): { usage: Usage | undefined; _meta: { quota: AcpQuota } } {
		const manager = record.session.sessionManager;
		const current = manager.getUsageStatistics();
		const modelUsage = manager.getModelUsageStatistics();
		const previous = promptTurn?.usageBaseline ?? current;
		const previousModelUsage = promptTurn?.modelUsageBaseline ?? modelUsage;
		const rows: Array<{ model: string; tokens: ModelTokenStatistics }> = [];
		let reasoning = 0;
		for (const [model, tokens] of modelUsage) {
			const before = previousModelUsage.get(model);
			const delta: ModelTokenStatistics = {
				input: Math.max(0, tokens.input - (before?.input ?? 0)),
				output: Math.max(0, tokens.output - (before?.output ?? 0)),
				reasoning: Math.max(0, tokens.reasoning - (before?.reasoning ?? 0)),
				cacheRead: Math.max(0, tokens.cacheRead - (before?.cacheRead ?? 0)),
				cacheWrite: Math.max(0, tokens.cacheWrite - (before?.cacheWrite ?? 0)),
				totalTokens: Math.max(0, tokens.totalTokens - (before?.totalTokens ?? 0)),
			};
			if (delta.totalTokens === 0 && delta.input === 0 && delta.output === 0) continue;
			reasoning += delta.reasoning;
			rows.push({ model, tokens: delta });
		}
		rows.sort((a, b) => b.tokens.totalTokens - a.tokens.totalTokens || a.model.localeCompare(b.model));
		return {
			usage: this.#buildTurnUsage(previous, current),
			_meta: {
				quota: {
					token_count: quotaTokenCount({
						input: Math.max(0, current.input - previous.input),
						output: Math.max(0, current.output - previous.output),
						reasoning,
						cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
						cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
						totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
					}),
					model_usage: rows.map(row => ({ model: row.model, token_count: quotaTokenCount(row.tokens) })),
				},
			},
		};
	}

	#buildTurnUsage(previous: UsageStatistics, current: UsageStatistics): Usage | undefined {
		const inputTokens = Math.max(0, current.input - previous.input);
		const outputTokens = Math.max(0, current.output - previous.output);
		const cachedReadTokens = Math.max(0, current.cacheRead - previous.cacheRead);
		const cachedWriteTokens = Math.max(0, current.cacheWrite - previous.cacheWrite);
		const totalTokens = Math.max(0, current.totalTokens - previous.totalTokens);

		if (totalTokens === 0) {
			return undefined;
		}

		const usage: Usage = {
			inputTokens,
			outputTokens,
			totalTokens,
		};
		if (cachedReadTokens > 0) {
			usage.cachedReadTokens = cachedReadTokens;
		}
		if (cachedWriteTokens > 0) {
			usage.cachedWriteTokens = cachedWriteTokens;
		}
		return usage;
	}

	async #listStoredSessions(cwd?: string): Promise<StoredSessionInfo[]> {
		const sessions = cwd ? await SessionManager.list(cwd) : await SessionManager.listAll();
		return sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}

	async #findStoredSession(sessionId: string, cwd: string): Promise<StoredSessionInfo | undefined> {
		const sessions = await this.#listStoredSessions(cwd);
		const scoped = sessions.find(session => session.id === sessionId);
		if (scoped) {
			return scoped;
		}
		// The cwd-derived directory only covers sessions stored under the current
		// naming scheme. Sessions written under a legacy/hashed project directory
		// (the 17.2.5+ scheme reverted in #7656) live elsewhere, so fall back to a
		// global by-id scan: the session id is globally unique, and
		// #openStoredSession reopens the file with the request cwd. See #7779.
		return this.#findStoredSessionById(sessionId);
	}

	async #findStoredSessionById(sessionId: string): Promise<StoredSessionInfo | undefined> {
		const sessions = await this.#listStoredSessions();
		return sessions.find(session => session.id === sessionId);
	}

	#parseCursor(cursor: string | undefined): number {
		if (!cursor) {
			return 0;
		}
		const parsed = Number.parseInt(cursor, 10);
		if (!Number.isFinite(parsed) || parsed < 0) {
			throw new Error(`Invalid ACP session cursor: ${cursor}`);
		}
		return parsed;
	}

	/**
	 * Replays the session's history, or with `send: false` (`session/resume`)
	 * only registers its subagent children, so one that runs again is
	 * announced, ancestors first, before its traffic.
	 */
	async #replaySessionHistory(record: ManagedSessionRecord, options: { send?: boolean } = {}): Promise<void> {
		const { sessionId, sessionManager } = record.session;
		const cwd = sessionManager.getCwd();
		const send =
			options.send === false
				? async () => {}
				: (notification: SessionNotification) => this.#connection.sessionUpdate(notification);
		if (options.send === false && !record.subagentRelay) return;
		const subagents: SubagentReplay | undefined = record.subagentRelay && {
			rootSessionId: sessionId,
			relay: record.subagentRelay,
			cwd,
			replayed: new Set(),
			send,
			announce: options.send !== false,
		};
		await this.#replayMessages(
			send,
			sessionId,
			sessionManager.buildSessionContext().messages as ReplayableMessage[],
			cwd,
			sessionManager.getSessionFile(),
			subagents,
		);
	}

	/**
	 * Replays `messages` into `sessionId`. With `subagents`, each task tool
	 * result is followed by the replay of the children it spawned; with
	 * `prompts`, the session is such a child and its user messages are the
	 * prompts its parent sent. Returns the number of prompts replayed.
	 */
	async #replayMessages(
		send: (notification: SessionNotification) => Promise<void>,
		sessionId: string,
		messages: ReplayableMessage[],
		cwd: string,
		sessionFile: string | undefined,
		subagents: SubagentReplay | undefined,
		prompts?: { parentSessionId: string },
	): Promise<number> {
		const replayedToolCallIds = new Set<string>();
		const replayedToolCallArgs = new Map<string, unknown>();
		let promptCount = 0;
		for (const message of messages) {
			if (prompts && message.role === "user") {
				promptCount += 1;
				await send({
					sessionId,
					update: {
						sessionUpdate: "session_message",
						messageId: `${sessionId}:prompt:${promptCount}`,
						senderSessionId: prompts.parentSessionId,
						recipientSessionId: sessionId,
						content: this.#extractReplayContent(
							typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
							undefined,
						),
					},
				});
				continue;
			}
			for (const notification of this.#messageToReplayNotifications(
				sessionId,
				message,
				cwd,
				replayedToolCallIds,
				replayedToolCallArgs,
			)) {
				await send(notification);
			}
			if (subagents && sessionFile && message.role === "toolResult" && message.toolName === "task") {
				for (const child of taskResultSubagents(message.details)) {
					await this.#replaySubagent(child, sessionId, sessionFile, subagents);
				}
			}
		}
		return promptCount;
	}

	/**
	 * Replays one subagent from its own transcript, which the task tool keeps
	 * at `<caller session file minus .jsonl>/<id>.jsonl`: an announcement on
	 * its parent without a work state, its history under its live session id,
	 * then an idle snapshot. A child without a transcript stays unexposed.
	 */
	async #replaySubagent(
		child: { id: string; agent: string | undefined; description: string | undefined },
		parentSessionId: string,
		parentSessionFile: string,
		subagents: SubagentReplay,
	): Promise<void> {
		if (subagents.replayed.has(child.id) || !parentSessionFile.endsWith(".jsonl")) return;
		subagents.replayed.add(child.id);
		const sessionFile = path.join(parentSessionFile.slice(0, -".jsonl".length), `${child.id}.jsonl`);
		let messages: ReplayableMessage[];
		try {
			messages = (await loadSessionMessagesReadOnly(sessionFile)) as ReplayableMessage[];
		} catch (error) {
			logger.debug("ACP subagent transcript unavailable for replay", { sessionFile, error: String(error) });
			return;
		}
		if (messages.length === 0) return;
		const sessionId = subagentSessionId(subagents.rootSessionId, child.id);
		const title = subagentTitle(child.id, child.agent);
		await subagents.send({
			sessionId: parentSessionId,
			update: {
				sessionUpdate: "subagent_update",
				sessionId,
				title,
				...(child.description ? { description: child.description } : {}),
			},
		});
		const prompts = await this.#replayMessages(
			subagents.send,
			sessionId,
			messages,
			subagents.cwd,
			sessionFile,
			subagents,
			{
				parentSessionId,
			},
		);
		const last = messages.findLast(message => message.role === "assistant");
		await subagents.send({
			sessionId: parentSessionId,
			update: { sessionUpdate: "subagent_update", sessionId, state: replayedIdleState(last?.stopReason) },
		});
		subagents.relay.restore(child.id, {
			sessionId,
			parentSessionId,
			title,
			description: child.description,
			prompts,
			announced: subagents.announce,
		});
	}

	#messageToReplayNotifications(
		sessionId: string,
		message: ReplayableMessage,
		cwd: string,
		replayedToolCallIds: Set<string>,
		replayedToolCallArgs: Map<string, unknown>,
	): SessionNotification[] {
		if (message.role === "assistant") {
			return this.#replayAssistantMessage(sessionId, message, cwd, replayedToolCallIds, replayedToolCallArgs);
		}
		if (
			message.role === "user" ||
			message.role === "developer" ||
			message.role === "custom" ||
			message.role === "hookMessage"
		) {
			return this.#wrapReplayContent(
				sessionId,
				this.#extractReplayContent(message.content, undefined),
				"user_message_chunk",
				crypto.randomUUID(),
			);
		}
		if (
			message.role === "toolResult" &&
			typeof message.toolCallId === "string" &&
			typeof message.toolName === "string"
		) {
			return this.#replayToolResult(
				sessionId,
				cwd,
				{
					...message,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
				},
				{
					includeStart: !replayedToolCallIds.has(message.toolCallId),
					toolArgs: replayedToolCallArgs.get(message.toolCallId),
				},
			);
		}
		if (message.role === "bashExecution" || message.role === "pythonExecution") {
			// The role fixes the shape: these come from buildSessionContext, and keep their text in fields, not `content`.
			const text =
				message.role === "bashExecution"
					? bashExecutionToText(message as BashExecutionMessage)
					: pythonExecutionToText(message as PythonExecutionMessage);
			return this.#wrapReplayContent(sessionId, [{ type: "text", text }], "user_message_chunk", crypto.randomUUID());
		}
		if (message.role === "compactionSummary" && typeof message.summary === "string" && message.summary.length > 0) {
			// Replay is terminal-only: one completed compaction at this position.
			const update = compactionReplayUpdate(
				`compaction:${message.timestamp}`,
				message.summary,
				{
					...(typeof message.tokensBefore === "number" ? { preTokens: message.tokensBefore } : {}),
					...(typeof message.tokensAfter === "number" ? { postTokens: message.tokensAfter } : {}),
				},
				this.#compactionReportOptions(),
			);
			return [{ sessionId, update }];
		}
		return [];
	}

	#replayAssistantMessage(
		sessionId: string,
		message: ReplayableMessage,
		cwd: string,
		replayedToolCallIds: Set<string>,
		replayedToolCallArgs: Map<string, unknown>,
	): SessionNotification[] {
		const notifications: SessionNotification[] = [];
		const messageId = this.#replayedMessageId(sessionId, message);
		if (Array.isArray(message.content)) {
			for (const item of message.content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					notifications.push({
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: item.text },
							messageId,
						},
					});
					continue;
				}
				if (
					item.type === "image" &&
					"data" in item &&
					typeof item.data === "string" &&
					"mimeType" in item &&
					typeof item.mimeType === "string"
				) {
					notifications.push({
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "image", data: item.data, mimeType: item.mimeType },
							messageId,
						},
					});
					continue;
				}
				if (item.type === "thinking" && "thinking" in item && typeof item.thinking === "string") {
					const thinking = canonicalizeMessage(item.thinking);
					if (thinking.length === 0) continue;
					notifications.push({
						sessionId,
						update: {
							sessionUpdate: item.narration ? "agent_message_chunk" : "agent_thought_chunk",
							content: { type: "text", text: thinking },
							messageId,
						},
					});
					continue;
				}
				const toolItem = item as ReplayableToolItem;
				if (
					(toolItem.type === "toolCall" || toolItem.type === "tool_use") &&
					typeof toolItem.id === "string" &&
					typeof toolItem.name === "string"
				) {
					const args = this.#buildReplayAssistantToolArgs(toolItem);
					notifications.push(
						...mapAgentSessionEventToAcpSessionUpdates(
							{
								type: "tool_execution_start",
								toolCallId: toolItem.id,
								toolName: toolItem.name,
								args,
							},
							sessionId,
							{ cwd, ...this.#replayToolMetaOptions(sessionId) },
						),
					);
					replayedToolCallIds.add(toolItem.id);
					replayedToolCallArgs.set(toolItem.id, args);
				}
			}
		}
		if (notifications.length === 0 && message.errorMessage && !isSilentAbort(message)) {
			notifications.push({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: message.errorMessage },
					messageId,
				},
			});
		}
		return notifications;
	}

	/**
	 * The id a replayed agent message carries: its session entry id, which
	 * `session/fork` takes as a fork point. A message of no open session (a
	 * subagent transcript) or without an entry gets a fresh id.
	 */
	#replayedMessageId(sessionId: string, message: ReplayableMessage): string {
		const sessionManager = this.#sessions.get(sessionId)?.session.sessionManager;
		if (!sessionManager) return crypto.randomUUID();
		const leafId = sessionManager.getLeafId();
		let cached = this.#replayEntryIndexes.get(sessionManager);
		if (cached?.leafId !== leafId) {
			cached = { leafId, index: indexAssistantEntries(sessionManager.getBranchView()) };
			this.#replayEntryIndexes.set(sessionManager, cached);
		}
		const stamp = assistantMessageStamp(message);
		return (
			cached.index.byMessage.get(message) ??
			(stamp ? cached.index.byStamp.get(stamp) : undefined) ??
			crypto.randomUUID()
		);
	}

	#buildReplayAssistantToolArgs(item: ReplayableToolItem): unknown {
		if ("arguments" in item) {
			return normalizeReplayToolArguments(item.arguments).args;
		}
		if (item.type === "tool_use" && "input" in item) {
			return item.input;
		}
		return {};
	}

	#replayToolResult(
		sessionId: string,
		cwd: string,
		message: Required<Pick<ReplayableMessage, "toolCallId" | "toolName">> & ReplayableMessage,
		options: { includeStart?: boolean; toolArgs?: unknown } = {},
	): SessionNotification[] {
		const args = this.#buildReplayToolArgs(message.details);
		const startEvent: AgentSessionEvent = {
			type: "tool_execution_start",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			args,
		};
		const endEvent: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError === true,
			result: {
				content: message.content,
				details: message.details,
				errorMessage: message.errorMessage,
			},
		};
		const metaOptions = this.#replayToolMetaOptions(sessionId);
		const notifications = mapAgentSessionEventToAcpSessionUpdates(endEvent, sessionId, {
			cwd,
			...metaOptions,
			getToolArgs: toolCallId => (toolCallId === message.toolCallId ? options.toolArgs : undefined),
			resolveImageData: (data, _mimeType) => resolveImageDataSync(this.#blobs, data),
		});
		if (options.includeStart === false) {
			return notifications;
		}
		return [
			...mapAgentSessionEventToAcpSessionUpdates(startEvent, sessionId, { cwd, ...metaOptions }),
			...notifications,
		];
	}

	/**
	 * The tool-call `_meta` options of a replay: an MCP call is tagged only while
	 * the open session still has its tool registered.
	 */
	#replayToolMetaOptions(sessionId: string): {
		airClient: boolean;
		lookupTool: (toolName: string) => MountedMCPToolRouteSource | undefined;
	} {
		const session = this.#sessions.get(sessionId)?.session;
		return {
			airClient: isAirClient(this.#clientCapabilities),
			lookupTool: name => session?.getToolByName(name),
		};
	}

	#buildReplayToolArgs(details: unknown): { path?: string } {
		if (typeof details !== "object" || details === null || !("path" in details)) {
			return {};
		}
		const value = (details as { path?: unknown }).path;
		return typeof value === "string" && value.length > 0 ? { path: value } : {};
	}

	#wrapReplayContent(
		sessionId: string,
		content: PromptRequest["prompt"],
		kind: "agent_message_chunk" | "user_message_chunk",
		messageId: string,
	): SessionNotification[] {
		return content.map(block => ({
			sessionId,
			update: {
				sessionUpdate: kind,
				content: block,
				messageId,
			},
		}));
	}

	#extractReplayContent(content: unknown, errorMessage: string | undefined): PromptRequest["prompt"] {
		const replay: PromptRequest["prompt"] = [];
		if (Array.isArray(content)) {
			for (const item of content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					replay.push({ type: "text", text: item.text });
					continue;
				}
				if (
					item.type === "image" &&
					"data" in item &&
					"mimeType" in item &&
					typeof item.data === "string" &&
					typeof item.mimeType === "string"
				) {
					replay.push({ type: "image", data: item.data, mimeType: item.mimeType });
				}
			}
		}
		if (replay.length === 0 && errorMessage) {
			replay.push({ type: "text", text: errorMessage });
		}
		return replay;
	}

	async #configureExtensions(record: ManagedSessionRecord): Promise<void> {
		if (record.extensionsConfigured) {
			return;
		}

		const uiContext = createAcpExtensionUiContext(
			this.#connection,
			() => record.session.sessionId,
			this.#clientCapabilities,
		);
		if (this.#clientCapabilities?.elicitation?.form != null) {
			record.setToolUIContext?.(uiContext, true);
			record.session.setUsageFallbackConfirmer((confirmation, signal) => {
				const reserve =
					confirmation.remainingPercent === undefined
						? "inside the configured reserve margin"
						: `${confirmation.remainingPercent.toFixed(1)}% remaining`;
				return uiContext.confirm(
					"Coding-plan reserve reached",
					`${confirmation.from} has ${reserve}. Switch to ${confirmation.to}? Choose No to keep using the current plan.`,
					{ signal },
				);
			});
		}

		const extensionRunner = record.session.extensionRunner;
		if (!extensionRunner) {
			record.extensionsConfigured = true;
			return;
		}

		extensionRunner.initialize(
			{
				sendMessage: (message, options) => {
					record.session.sendCustomMessage(message, options).catch((error: unknown) => {
						logger.warn("ACP extension sendMessage failed", { error });
					});
				},
				sendUserMessage: (content, options) => {
					this.#trackExtensionUserMessage(record, record.session.sendUserMessage(content, options));
				},
				appendEntry: (customType, data) => {
					record.session.sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					record.session.sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => record.session.getEnabledToolNames(),
				getAllTools: () => record.session.getAllToolInfos(),
				setActiveTools: toolNames => record.session.setActiveToolsByName(toolNames),
				getCommands: () => getSessionSlashCommands(record.session),
				setModel: async model => {
					const apiKey = await record.session.modelRegistry.getApiKey(model);
					if (!apiKey) {
						return false;
					}
					await record.session.setModel(model);
					return true;
				},
				getThinkingLevel: () => record.session.thinkingLevel,
				setThinkingLevel: level => record.session.setThinkingLevel(level),
				getServiceTiers: () => record.session.serviceTierByFamily,
				setServiceTier: (family, tier) => record.session.setServiceTierFamily(family, tier),
				getSessionName: () => record.session.sessionManager.getSessionName(),
				setSessionName: async name => {
					await record.session.sessionManager.setSessionName(name, "user");
				},
			},
			{
				getModel: () => record.session.model,
				isIdle: () => !record.session.isStreaming,
				abort: () => {
					void record.session.abort({ reason: USER_INTERRUPT_LABEL });
				},
				hasPendingMessages: () => record.session.queuedMessageCount > 0,
				shutdown: () => {},
				getContextUsage: () => record.session.getContextUsage(),
				getSystemPrompt: () => record.session.systemPrompt,
				runEphemeralTurn: args => record.session.runEphemeralTurn(args),
				compact: instructionsOrOptions => runExtensionCompact(record.session, instructionsOrOptions),
			},
			{
				getContextUsage: () => record.session.getContextUsage(),
				waitForIdle: () => record.session.agent.waitForIdle(),
				newSession: async options => {
					const success = await record.session.newSession({ parentSession: options?.parentSession });
					if (success && options?.setup) {
						await options.setup(record.session.sessionManager);
					}
					return { cancelled: !success };
				},
				branch: async entryId => {
					const result = await record.session.branch(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await record.session.navigateTree(targetId, { summarize: options?.summarize });
					return { cancelled: result.cancelled };
				},
				switchSession: async sessionPath => {
					const success = await record.session.switchSession(sessionPath);
					return { cancelled: !success };
				},
				reload: async () => {
					await record.session.reload();
				},
				compact: instructionsOrOptions => runExtensionCompact(record.session, instructionsOrOptions),
			},
			uiContext,
			"rpc",
		);
		await extensionRunner.emit({ type: "session_start" });
		record.extensionsConfigured = true;
	}

	async #configureMcpServers(record: ManagedSessionRecord, servers: McpServer[]): Promise<void> {
		if (record.mcpManager) {
			await record.mcpManager.disconnectAll();
		}
		// Drain any in-flight refresh queued by a previous configuration: a refresh
		// that already passed its manager guard could otherwise finish applying a
		// stale tool set after this reconfiguration installs the new one.
		await record.mcpRefreshChain;
		record.mcpRefreshChain = undefined;
		if (servers.length === 0) {
			record.mcpManager = undefined;
			await record.session.refreshMCPTools([]);
			return;
		}

		const manager = new MCPManager(record.session.sessionManager.getCwd());
		// `/mcp reauth` writes url-keyed credential rows; without the session's
		// auth storage the manager cannot resolve them on reconnect and a
		// successful reauthorization would leave the live server disconnected.
		manager.setAuthStorage(record.session.modelRegistry.authStorage);
		// MCP servers connect and reconnect independently, so `onToolsChanged` can fire
		// several times back to back. Each firing is chained onto `record.mcpRefreshChain`
		// so refreshes apply in order, and each one re-reads `manager.getTools()` at the
		// time it actually runs rather than the snapshot from when it was queued — so a
		// refresh can never apply a stale, smaller tool set after a newer one already landed.
		// The returned promise propagates failures (a session-level
		// `refreshMCPTools` rejection still fails setup); the stored chain
		// swallows them after logging so background firings only warn and the
		// chain never rejects. Connection failures do NOT fail setup — see
		// below: the record keeps the manager so `/mcp reauth` can recover.
		const enqueueMcpToolsRefresh = (): Promise<void> => {
			const run = (record.mcpRefreshChain ?? Promise.resolve()).then(async () => {
				if (record.mcpManager !== manager) return;
				await record.session.refreshMCPTools(manager.getTools());
			});
			record.mcpRefreshChain = run.catch(error => {
				logger.warn("ACP MCP tool refresh failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			return run;
		};
		manager.setOnToolsChanged(() => {
			// Failures are logged once via the stored chain's catch above.
			enqueueMcpToolsRefresh().catch(() => {});
		});
		const configs: MCPConfigMap = {};
		const sources: MCPSourceMap = {};
		for (const server of servers) {
			configs[server.name] = this.#toMcpConfig(server);
			sources[server.name] = {
				provider: "acp",
				providerName: "ACP Client",
				path: `acp://${server.name}`,
				level: "project",
			};
		}

		const result = await manager.connectServers(configs, sources);
		// A client-declared server whose initial connect fails (e.g. an expired
		// client-owned bearer answering 401 inside the startup window) must not
		// abort session creation: the record keeps the manager with the failed
		// definition, `/mcp reauth <name>` resolves it from the manager and the
		// reconnect hook retries with the fresh credential. The client is told
		// through a chunk instead of the session refusing to load.
		record.mcpManager = manager;
		await enqueueMcpToolsRefresh();
		// The failure chunk is queued, not sent: `#configureMcpServers` runs
		// inside `#registerPreparedSession`, before the newSession/loadSession
		// response has given the client this session id — a notification now
		// would be dropped as "unknown session" by clients like Zed (the same
		// race `#scheduleBootstrapUpdates` guards). `#emitBootstrapUpdates`
		// drains the queue behind that guard.
		for (const [name, message] of result.errors) {
			const type = configs[name]?.type;
			record.pendingMcpStartupChunks.push({ name, message, oauthCapable: type === "http" || type === "sse" });
		}
	}

	#toMcpConfig(server: McpServer): MCPServerConfig {
		if ("command" in server) {
			return {
				type: "stdio",
				command: server.command,
				args: server.args,
				env: this.#toNameValueMap(server.env),
			};
		}
		if (server.type === "http") {
			return {
				type: "http",
				url: server.url,
				headers: this.#toNameValueMap(server.headers),
			};
		}
		if (server.type === "sse") {
			return {
				type: "sse",
				url: server.url,
				headers: this.#toNameValueMap(server.headers),
			};
		}
		// The experimental ACP-channel transport (`type: "acp"`) is not advertised in
		// `mcpCapabilities`, so a spec-compliant client never sends it; reject defensively.
		throw new Error(`Unsupported MCP server transport: ${server.type}`);
	}

	#toNameValueMap(values: Array<{ name: string; value: string }>): { [name: string]: string } {
		const mapped: { [name: string]: string } = {};
		for (const value of values) {
			mapped[value.name] = value.value;
		}
		return mapped;
	}

	async #closeManagedSession(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		record.closedError ??= RequestError.resourceNotFound(sessionId);
		this.#sessions.delete(sessionId);
		await this.#cancelPromptForClose(record);
		await this.#disposeSessionRecord(record);
		this.#sessionListChanged();
	}

	async #cancelPromptForClose(record: ManagedSessionRecord): Promise<void> {
		const promptTurn = record.promptTurn;
		if (!isPromptTurnInFlight(promptTurn)) {
			return;
		}
		const cleanup = promptTurn.cleanup ?? this.#beginCancelCleanup(record, promptTurn);
		try {
			await cleanup;
		} catch (error) {
			logger.warn("Failed to abort ACP prompt during session close", { error });
		}
	}

	async #disposeSessionRecord(record: ManagedSessionRecord, reason?: postmortem.Reason): Promise<void> {
		record.lifetimeUnsubscribe?.();
		record.titleUnsubscribe?.();
		// Delivers the end of children still running before the session kills them,
		// but a client that stops reading must not hold the close: this path is also
		// the fallback when cancel cleanup times out.
		const subagentsSettled = record.subagentRelay?.dispose();
		record.asyncTaskRelay?.dispose();
		if (subagentsSettled) {
			const deadline = Promise.withResolvers<void>();
			const timer = setTimeout(deadline.resolve, this.#cancelCleanupTimeoutMs);
			try {
				await Promise.race([subagentsSettled, deadline.promise]);
			} finally {
				clearTimeout(timer);
			}
		}
		if (record.mcpManager) {
			try {
				await record.mcpManager.disconnectAll();
			} catch (error) {
				logger.warn("Failed to disconnect ACP MCP servers", { error });
			}
			record.mcpManager = undefined;
		}
		try {
			await record.session.dispose({ reason });
		} catch (error) {
			logger.warn("Failed to dispose ACP session", { error });
		}
	}

	async #disposeStandaloneSession(session: AgentSession, reason?: postmortem.Reason): Promise<void> {
		try {
			await session.dispose({ reason });
		} catch (error) {
			logger.warn("Failed to dispose ACP session", { error });
		}
	}

	/** Dispose every session owned by this ACP connection and await persisted teardown. */
	async dispose(reason?: postmortem.Reason): Promise<void> {
		if (this.#disposePromise) {
			await this.#disposePromise;
			return;
		}

		this.#disposePromise = (async () => {
			this.#listSubscriptions?.dispose();
			this.#listSubscriptions = undefined;
			const records = Array.from(this.#sessions.entries());
			this.#sessions.clear();
			await Promise.all(
				records.map(async ([sessionId, record]) => {
					try {
						record.closedError ??= RequestError.resourceNotFound(sessionId);
						await this.#cancelPromptForClose(record);
						await this.#disposeSessionRecord(record, reason);
					} catch (error) {
						logger.warn("Failed to clean up ACP session", { acpSessionId: sessionId, error });
					}
				}),
			);

			const initialSession = this.#initialSession;
			this.#initialSession = undefined;
			if (initialSession) {
				await this.#disposeStandaloneSession(initialSession, reason);
			}
		})();

		await this.#disposePromise;
	}
}
