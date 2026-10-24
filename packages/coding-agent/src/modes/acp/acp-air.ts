/**
 * JetBrains AIR ACP extension negotiation.
 *
 * A client opts in through `clientCapabilities._meta.jetbrains.air =
 * { version, capabilities: [...] }`; the agent advertises the same shape in
 * the `initialize` response's top-level `_meta`. Payloads attached to
 * individual updates ride under `_meta.jetbrains.air.<capability>`. Shapes
 * match claude-agent-acp's `air-extension.ts` so a client needs no
 * omp-specific code.
 */
import type { ClientCapabilities } from "@oh-my-pi/pi-utils/acp";

/** Background tasks surfaced as `async_task_*` session updates. */
export const AIR_ASYNC_TASKS_CAPABILITY = "asyncTasks";
/**
 * The plan of an `xd://propose` call is a file: `rawInput.planFilePath` names
 * it, and the client reads the plan from it.
 */
export const AIR_PLAN_FILE_CAPABILITY = "planFile";
/** Marks an ask form's free-text field as the custom answer of a select field. */
export const AIR_CUSTOM_ANSWER_KEY = "customAnswer";
/**
 * `_meta.jetbrains.air` key of the goal extension: the `initialize` capability
 * object and the `session_info_update` goal snapshot (see `acp-goal.ts`).
 */
export const AIR_GOAL_KEY = "goal";
/**
 * `_meta.jetbrains.air` key of a shell tool call's description (its intent),
 * kept out of the standard `title`, which clients use as the command preview.
 */
export const AIR_COMMAND_TITLE_KEY = "commandTitle";
/** `_meta.jetbrains.air` flag marking a tool call that launches subagents. */
export const AIR_SUBAGENT_KEY = "subagent";
/**
 * The client renders subagents through AIR's own (earlier-draft) subagent
 * sessions, which offer no child cancel. Without it an AIR client takes the
 * subagents RFD form, child cancel included (claude-agent-acp parity).
 */
export const AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY = "nativeSubagentSessions";
/**
 * `_meta.jetbrains.air` key of a permission request's presentation: the
 * prompt's heading, its reason as `description`, and `defaultToNo`.
 */
export const AIR_PERMISSION_KEY = "permission";
/** AIR extension version this agent speaks. */
export const AIR_EXTENSION_VERSION = 1;

const JETBRAINS_META_KEY = "jetbrains";
const AIR_META_KEY = "air";
const AIR_CAPABILITIES_KEY = "capabilities";

/** The capability list this agent advertises, as a fresh `_meta` object. */
export function airCapabilityMeta(...capabilities: string[]): Record<string, unknown> {
	return withAirMeta(undefined, AIR_CAPABILITIES_KEY, capabilities);
}

/**
 * Merge one AIR payload into an existing `_meta`, preserving every other
 * namespace and any sibling AIR payloads. Pass `undefined` for a fresh object.
 */
export function withAirMeta(
	meta: Record<string, unknown> | null | undefined,
	capability: string,
	payload: unknown,
): Record<string, unknown> {
	const jetbrains = asRecord(meta?.[JETBRAINS_META_KEY]);
	const air = asRecord(jetbrains[AIR_META_KEY]);
	return {
		...meta,
		[JETBRAINS_META_KEY]: {
			...jetbrains,
			[AIR_META_KEY]: { ...air, version: AIR_EXTENSION_VERSION, [capability]: payload },
		},
	};
}

/**
 * Merge flat fields straight into `_meta.jetbrains.air` (no capability key),
 * as the session index's list rows and `session_info_update`s carry them.
 * Preserves every other namespace and sibling AIR field.
 */
export function withAirFields(
	meta: Record<string, unknown> | null | undefined,
	fields: Record<string, unknown>,
): Record<string, unknown> {
	const jetbrains = asRecord(meta?.[JETBRAINS_META_KEY]);
	const air = asRecord(jetbrains[AIR_META_KEY]);
	return {
		...meta,
		[JETBRAINS_META_KEY]: { ...jetbrains, [AIR_META_KEY]: { ...air, version: AIR_EXTENSION_VERSION, ...fields } },
	};
}

/**
 * Whether the client is an AIR client: it sent `_meta.jetbrains.air` with a
 * supported version (a finite integer >= 1). Only such a client is told about
 * AIR. Tolerates malformed `_meta`: wire data is unvalidated.
 */
export function isAirClient(capabilities: ClientCapabilities | undefined): boolean {
	const version = airClientMeta(capabilities).version;
	return typeof version === "number" && Number.isInteger(version) && version >= AIR_EXTENSION_VERSION;
}

/** Whether an AIR client advertised `capability`. */
export function clientSupportsAirCapability(capabilities: ClientCapabilities | undefined, capability: string): boolean {
	const advertised = airClientMeta(capabilities)[AIR_CAPABILITIES_KEY];
	return isAirClient(capabilities) && Array.isArray(advertised) && advertised.includes(capability);
}

function airClientMeta(capabilities: ClientCapabilities | undefined): Record<string, unknown> {
	return asRecord(asRecord(asRecord(capabilities?._meta)[JETBRAINS_META_KEY])[AIR_META_KEY]);
}

/** Whether the client renders `async_task_*` updates. */
export function clientSupportsAsyncTasks(capabilities: ClientCapabilities | undefined): boolean {
	return clientSupportsAirCapability(capabilities, AIR_ASYNC_TASKS_CAPABILITY);
}

/** Whether the client reads a proposed plan from the file `rawInput.planFilePath` names. */
export function clientSupportsPlanFile(capabilities: ClientCapabilities | undefined): boolean {
	return clientSupportsAirCapability(capabilities, AIR_PLAN_FILE_CAPABILITY);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
