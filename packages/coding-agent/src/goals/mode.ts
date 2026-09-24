import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { SessionContext } from "../session/session-context";
import { cfgGoalEnabled } from "./settings";
import { type GoalModeState, goalFromModeData } from "./state";

/** Continuation prompts ride in as hidden custom messages of this type. */
export const GOAL_CONTINUATION_MESSAGE_TYPE = "goal-continuation";

type GoalModeSession = Pick<AgentSession, "settings" | "sessionManager" | "goalRuntime" | "setGoalModeState">;

/**
 * Rebuild goal mode from a resumed session's persisted mode entry. Returns
 * `undefined` when the context holds no goal mode, `null` when a stored goal
 * was discarded (goal mode disabled in settings, unreadable, or already
 * finished), and the restored state otherwise. An active goal comes back
 * paused unless `preserveActiveGoal` is set.
 */
export async function restoreGoalMode(
	session: GoalModeSession,
	context: Pick<SessionContext, "mode" | "modeData">,
	options?: { preserveActiveGoal?: boolean },
): Promise<GoalModeState | null | undefined> {
	if (context.mode !== "goal" && context.mode !== "goal_paused") return undefined;
	if (!cfgGoalEnabled.get(session.settings)) {
		session.goalRuntime.clearAccounting();
		session.sessionManager.appendModeChange("none");
		return null;
	}
	const goal = goalFromModeData(context.modeData);
	// A goal the tool completed or dropped only reaches disk as `goal` mode when
	// the process ended before the host appended its closing mode change.
	if (!goal || goal.status === "complete" || goal.status === "dropped") {
		session.sessionManager.appendModeChange("none");
		return null;
	}
	session.setGoalModeState({ enabled: context.mode === "goal", mode: "active", goal });
	return (await session.goalRuntime.onThreadResumed({ preserveActiveGoal: options?.preserveActiveGoal })) ?? null;
}

/**
 * Close a goal the `goal` tool marked complete: clear the state and persist the
 * mode exit plus a `goal-completed` record. Returns whether a goal was closed.
 */
export function completeExitingGoal(
	session: Pick<AgentSession, "sessionManager" | "getGoalModeState" | "setGoalModeState">,
): boolean {
	const state = session.getGoalModeState();
	if (state?.mode !== "exiting") return false;
	session.setGoalModeState(undefined);
	session.sessionManager.appendModeChange("none");
	session.sessionManager.appendCustomEntry("goal-completed", {
		objective: state.goal.objective,
		tokensUsed: state.goal.tokensUsed,
		tokenBudget: state.goal.tokenBudget,
		timeUsedSeconds: state.goal.timeUsedSeconds,
	});
	return true;
}

/**
 * `/guided-goal` exposes the `goal` tool before any goal exists so the
 * interview can end with `goal create`; that pairing is the only marker of an
 * interview in progress.
 */
export function isGoalInterviewActive(
	session: Pick<AgentSession, "getGoalModeState" | "getEnabledToolNames">,
): boolean {
	return !session.getGoalModeState() && session.getEnabledToolNames().includes("goal");
}

/** Model-visible tool activity, excluding call IDs and timestamps that differ on every turn. */
export function goalContinuationActivity(messages: AgentMessage[]): string {
	const digests: string[] = [];
	const record = (value: unknown): void => {
		const serialized = stableStringifyJson(value);
		digests.push(`${serialized.length}:${Bun.hash(serialized).toString(16)}`);
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") record(["call", block.name, block.arguments]);
			}
		} else if (message.role === "toolResult") {
			record(["result", message.toolName, message.content, message.isError === true]);
		}
	}
	return digests.join(":");
}

/**
 * A continuation turn that did no tool work, or repeated the previous
 * continuation's work exactly, is not making progress: stop auto-continuing
 * until the user speaks again.
 */
export function isStalledGoalContinuation(activity: string, previousActivity: string | undefined): boolean {
	return activity.length === 0 || activity === previousActivity;
}
