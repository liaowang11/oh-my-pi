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
 * Whether the client advertised `capability` under a supported AIR version
 * (a finite integer >= 1). Tolerates malformed `_meta`: wire data is unvalidated.
 */
export function clientSupportsAirCapability(capabilities: ClientCapabilities | undefined, capability: string): boolean {
	const air = asRecord(asRecord(capabilities?._meta)[JETBRAINS_META_KEY])[AIR_META_KEY];
	const record = asRecord(air);
	const version = record.version;
	const advertised = record[AIR_CAPABILITIES_KEY];
	return (
		typeof version === "number" &&
		Number.isInteger(version) &&
		version >= AIR_EXTENSION_VERSION &&
		Array.isArray(advertised) &&
		advertised.includes(capability)
	);
}

/** Whether the client renders `async_task_*` updates. */
export function clientSupportsAsyncTasks(capabilities: ClientCapabilities | undefined): boolean {
	return clientSupportsAirCapability(capabilities, AIR_ASYNC_TASKS_CAPABILITY);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
