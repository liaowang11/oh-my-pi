import { type Type, type } from "@oh-my-pi/omptype";
import type {
	ForkSessionResponse,
	LoadSessionResponse,
	NewSessionResponse,
	PromptResponse,
	SessionNotification,
} from "./protocol";

/** Validation failure compatible with the used Zod error surface. */
export interface ValidationError {
	issues: Array<{ path: PropertyKey[]; message: string }>;
}
/** Successful validation result. */
export interface ValidationSuccess<T> {
	success: true;
	data: T;
}
/** Failed validation result. */
export interface ValidationFailure {
	success: false;
	error: ValidationError;
}
/** Runtime validator compatible with the used schema call shape. */
export interface Validator<T> {
	safeParse(value: unknown): ValidationSuccess<T> | ValidationFailure;
	parse(value: unknown): T;
}

/**
 * Wraps a structural schema in the Zod call shape. Schemas check the fields
 * ACP consumers read and keep every other key, so the result is the full
 * protocol value.
 */
function validator<T>(schema: Type, label: string): Validator<T> {
	return {
		safeParse(value) {
			const result = schema(value);
			if (!(result instanceof type.errors)) return { success: true, data: result as T };
			return {
				success: false,
				error: { issues: result.map(issue => ({ path: [...issue.path], message: issue.message })) },
			};
		},
		parse(value) {
			const result = schema(value);
			if (result instanceof type.errors) throw new Error(`Invalid ${label}: ${result.summary}`);
			return result as T;
		},
	};
}

const Modes = type({
	currentModeId: "string",
	availableModes: type({ id: "string", name: "string" }).array(),
}).or("null | undefined");

// Responses and notifications are also checked in-process, where absent optionals may be explicit `undefined`.
const sessionResponseFields = { "modes?": Modes, "configOptions?": "unknown[] | null | undefined" } as const;
const notArray = (value: object): boolean => !Array.isArray(value);
const SessionResponse = type(sessionResponseFields).narrow(notArray);
const IdentifiedSessionResponse = type({ sessionId: "string", ...sessionResponseFields }).narrow(notArray);

const ContentBlock = type({ type: "'text'", text: "string" })
	.or({ type: "'image' | 'audio'", data: "string", mimeType: "string" })
	.or({ type: "'resource_link'", uri: "string", name: "string" })
	.or({ type: "'resource'", resource: "object" });

const OptionalString = "string | null | undefined";
const OptionalObject = type("object").narrow(notArray).or("null | undefined");
const OptionalContentBlocks = ContentBlock.array().or("null | undefined");
const PlanUpdateContent = type({ planId: "string", type: "'items'", entries: "unknown[]" })
	.or({ planId: "string", type: "'file'", uri: "string" })
	.or({ planId: "string", type: "'markdown'", content: "string" })
	.narrow(notArray);
const SubagentWorkState = type({ state: "string", "stopReason?": OptionalString }).narrow(notArray);

const SessionUpdate = type({
	sessionUpdate: "'agent_message_chunk' | 'agent_thought_chunk' | 'user_message_chunk'",
	content: ContentBlock,
})
	.or({ sessionUpdate: "'tool_call'", toolCallId: "string", title: "string" })
	.or({ sessionUpdate: "'tool_call_update'", toolCallId: "string" })
	.or({
		sessionUpdate: "'subagent_update'",
		sessionId: "string",
		"title?": OptionalString,
		"description?": OptionalString,
		"state?": SubagentWorkState.or("null | undefined"),
		"capabilities?": OptionalObject,
	})
	.or({
		sessionUpdate: "'session_message'",
		messageId: "string",
		"senderSessionId?": OptionalString,
		"recipientSessionId?": OptionalString,
		"content?": OptionalContentBlocks,
	})
	.or({ sessionUpdate: "'plan'", entries: "unknown[]" })
	.or({ sessionUpdate: "'plan_update'", plan: PlanUpdateContent })
	.or({ sessionUpdate: "'plan_removed'", planId: "string" })
	.or({ sessionUpdate: "'notice'", severity: "string", title: "string", "description?": OptionalString })
	.or({
		sessionUpdate: "'compaction_update'",
		compactionId: "string",
		status: "string",
		"summary?": OptionalContentBlocks,
		"error?": OptionalString,
	})
	.or({ sessionUpdate: "'compaction_summary_chunk'", compactionId: "string", content: ContentBlock })
	.or({ sessionUpdate: "'current_mode_update'", currentModeId: "string" })
	.or({ sessionUpdate: "'available_commands_update'", availableCommands: "unknown[]" })
	.or({ sessionUpdate: "'config_option_update'", configOptions: "unknown[]" })
	.or({ sessionUpdate: "'session_info_update'", "title?": "string | null | undefined" })
	.or({ sessionUpdate: "'usage_update'", size: "number", used: "number" })
	.or({ sessionUpdate: "'state_update'", state: "'running' | 'requires_action' | 'idle'" });

/** Validator for new-session responses. */
export const zNewSessionResponse = validator<NewSessionResponse>(IdentifiedSessionResponse, "new session response");
/** Validator for load-session responses. */
export const zLoadSessionResponse = validator<LoadSessionResponse>(SessionResponse, "load session response");
/** Validator for fork-session responses. */
export const zForkSessionResponse = validator<ForkSessionResponse>(IdentifiedSessionResponse, "fork session response");
/** Validator for prompt responses. */
export const zPromptResponse = validator<PromptResponse>(
	type({ stopReason: "'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'" }),
	"prompt response",
);
/** Validator for session notifications. */
export const zSessionNotification = validator<SessionNotification>(
	type({ sessionId: "string", update: SessionUpdate }).narrow(notArray),
	"session notification",
);

/** ACP runtime validators. */
export const schema = {
	zNewSessionResponse,
	zLoadSessionResponse,
	zForkSessionResponse,
	zPromptResponse,
	zSessionNotification,
} as const;
