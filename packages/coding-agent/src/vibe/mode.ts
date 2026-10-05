/**
 * Host-independent Vibe mode entry/exit, shared by the interactive TUI and ACP.
 *
 * Hosts own their UI state (status lines, prompt ordering); this module owns
 * the session-side transition: toolset swap, mode state, director context,
 * mode persistence, and worker teardown.
 */
import { formatModelString } from "../config/model-resolver";
import type { AgentSession } from "../session/agent-session";
import { type VibeOwnerScope, type VibeParentSession, VibeSessionRegistry } from "./runtime";

/** What a host must keep between {@link enterVibeMode} and {@link exitVibeMode}. */
export interface VibeModeHandle {
	ownerScope: VibeOwnerScope;
	/** Toolset active before entry; restored on exit. */
	previousTools: string[];
}

/** The {@link VibeParentSession} view of a top-level session. */
export function vibeParentSessionOf(session: AgentSession): VibeParentSession {
	const sessionManager = session.sessionManager;
	return {
		getAgentId: () => session.getAgentId() ?? null,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		sessionManager,
		asyncJobManager: session.asyncJobManager,
		settings: session.settings,
		// Resolve restored/switched-to workers against this session's active model
		// (same as the spawn-path ToolSession), not the settings default. This is
		// the primary fallback in resolveAgentModelPatterns, so the `good` worker's
		// pi/task inheritance tracks the reopened session's model.
		getActiveModelString: () => (session.model ? formatModelString(session.model) : undefined),
	};
}

/**
 * Enter Vibe mode: strip the toolset to `read`, optional parent-owned `todo`,
 * and the vibe tools, mark the session, steer the director context into a
 * running turn, and record the `mode_change` (unless `persistModeChange` is
 * false, e.g. when restoring a session already persisted in vibe mode).
 */
export async function enterVibeMode(
	session: AgentSession,
	options?: { persistModeChange?: boolean; previousTools?: string[] },
): Promise<VibeModeHandle> {
	const registry = VibeSessionRegistry.global();
	const ownerScope = registry.ownerScope(vibeParentSessionOf(session));
	registry.activateScope(ownerScope);
	const previousTools = options?.previousTools ?? session.getEnabledToolNames();
	const baseTools = ["read"];
	if (session.hasBuiltInTool("todo")) baseTools.push("todo");
	await session.activateVibeTools(baseTools);
	session.setVibeModeState({ enabled: true });
	if (session.isStreaming) {
		await session.sendVibeModeContext({ deliverAs: "steer" });
	}
	if (options?.persistModeChange !== false) {
		session.sessionManager.appendModeChange("vibe", { previousTools });
	}
	return { ownerScope, previousTools };
}

/**
 * Exit Vibe mode: abort the running turn, kill every worker in the owner scope
 * (which records the mode exit), and restore the pre-vibe toolset. The
 * queued-message drain stays suppressed meanwhile so a queued steer cannot
 * restart on the still-live vibe tools (issue #8326). Returns the kill count.
 */
export async function exitVibeMode(session: AgentSession, handle: VibeModeHandle | undefined): Promise<number> {
	let killed = 0;
	await session.runModeExitTeardown(async () => {
		if (session.isStreaming) {
			await session.abort();
		}
		killed = await VibeSessionRegistry.global().killAll(vibeParentSessionOf(session), handle?.ownerScope);
		await session.deactivateVibeTools(handle?.previousTools ?? []);
		session.setVibeModeState(undefined);
	});
	return killed;
}
