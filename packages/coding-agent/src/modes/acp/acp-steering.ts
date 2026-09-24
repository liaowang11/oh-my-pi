/**
 * `_session/steering` — the ACP steering extension.
 *
 * A client uses this to inject a message into the turn that is *currently
 * running*, instead of sending a second `session/prompt` that would implicitly
 * cancel it. The steered content streams its output through the existing
 * `session/update` feed and the in-flight `session/prompt` keeps ownership of
 * its `PromptResponse`, because steering never creates a prompt turn of its
 * own. That is what makes it safe on a turn the client did not start: attaching
 * a new prompt subscription to a running turn would let that turn's `agent_end`
 * settle the wrong request.
 *
 * Method name, params and outcomes match the contract already shipped by
 * codex-acp and claude-agent-acp, so a client that speaks steering to either of
 * those needs no omp-specific code.
 */
import { type PromptRequest, RequestError } from "@oh-my-pi/pi-utils/acp";

/** Extension method name, per the shared ACP steering contract. */
export const SESSION_STEERING_METHOD = "_session/steering";

/**
 * What the agent should do when a steer arrives with no turn running.
 * `promptRequired` is opt-in: without it the agent keeps the established
 * default of starting a detached turn (see {@link SteerResponse}).
 */
export type SteerIdleBehavior = "promptRequired";

/** Params of a {@link SESSION_STEERING_METHOD} request. */
export type SteerRequest = {
	sessionId: string;
	prompt: PromptRequest["prompt"];
	_meta?: { steering?: { idleBehavior?: SteerIdleBehavior } };
};

/**
 * Where the steered message landed:
 *
 * - `injected` — it joined the running turn; its output arrives on
 *   `session/update`, not in this response.
 * - `startedNewTurn` — nothing was running, so a turn was started detached from
 *   any client request. That turn's `PromptResponse` has no owner, so prefer
 *   `promptRequired` for new clients.
 * - `promptRequired` — nothing was running and nothing was done. Opt in through
 *   `_meta.steering.idleBehavior` and resend the content as a plain
 *   `session/prompt`, whose own lifecycle then owns the turn's result.
 */
export type SteerResponse =
	| { outcome: "injected" }
	| { outcome: "startedNewTurn" }
	| { outcome: "promptRequired"; reason: "noRunningTurn" };

/**
 * `InitializeResponse._meta` advertisement clients probe to decide whether they
 * may send {@link SESSION_STEERING_METHOD}. A fresh object per call: `_meta` is
 * handed to the client as part of a mutable response.
 */
export function steeringCapabilityMeta(): Record<string, unknown> {
	return { steering: { supported: true } };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Validate raw JSON-RPC params into a {@link SteerRequest}. Content blocks are
 * left to `#convertPromptBlocks`, which already tolerates unknown block types;
 * only `sessionId`, a non-empty `prompt` array and a known `idleBehavior` are
 * checked here so a malformed request fails as `-32602` rather than as an
 * internal error deeper in the session layer.
 */
export function parseSteerRequest(params: { [key: string]: unknown }): SteerRequest {
	const sessionId = params.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "`sessionId` must be a non-empty string");
	}
	const prompt = params.prompt;
	if (!Array.isArray(prompt) || prompt.length === 0) {
		throw RequestError.invalidParams(undefined, "`prompt` must be a non-empty array of content blocks");
	}
	const idleBehavior = asRecord(asRecord(params._meta)?.steering)?.idleBehavior;
	if (idleBehavior !== undefined && idleBehavior !== "promptRequired") {
		throw RequestError.invalidParams(
			undefined,
			`unsupported \`_meta.steering.idleBehavior\`: ${JSON.stringify(idleBehavior)}`,
		);
	}
	return {
		sessionId,
		prompt: prompt as PromptRequest["prompt"],
		...(idleBehavior === undefined ? {} : { _meta: { steering: { idleBehavior } } }),
	};
}
