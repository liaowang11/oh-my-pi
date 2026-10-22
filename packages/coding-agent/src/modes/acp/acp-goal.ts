/**
 * The JetBrains AIR goal extension: `_session/goal` sets or clears a
 * session's goal, and `session_info_update._meta.jetbrains.air.goal` reports
 * it (a snapshot, or `null` once there is none). Wire shapes match
 * claude-agent-acp's `goal-extension.ts`, so a client needs no omp-specific
 * code. Only an AIR client is told about it.
 */
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import { RequestError } from "@oh-my-pi/pi-utils/acp";
import type { AcpGoalAction } from "../../slash-commands/helpers/goal";

export const GOAL_CONTROL_METHOD = "_session/goal";
const GOAL_EXTENSION_VERSION = 1;
const GOAL_ACTIONS = ["set", "clear"] as const;

export type GoalRequest = { sessionId: string } & AcpGoalAction;

/** AIR goal status; omp never reports `blocked`. */
export type GoalSnapshotStatus = "active" | "paused" | "blocked" | "limited" | "complete";

export type GoalSnapshot = {
	objective: string;
	status: GoalSnapshotStatus;
	createdAt: number;
	updatedAt: number;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	controlMethod: typeof GOAL_CONTROL_METHOD;
};

/** The capability advertised under `_meta.jetbrains.air.goal` of `initialize`. */
export function goalCapability(): { version: number; controlMethod: string; actions: string[] } {
	return { version: GOAL_EXTENSION_VERSION, controlMethod: GOAL_CONTROL_METHOD, actions: [...GOAL_ACTIONS] };
}

/** Validate `_session/goal` params; anything malformed is `-32602`. The objective is trimmed. */
export function parseGoalRequest(params: { [key: string]: unknown }): GoalRequest {
	const { sessionId, action, objective } = params;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams(undefined, "goal params require a non-empty sessionId");
	}
	if (action === "clear") return { sessionId, action };
	if (action !== "set") throw RequestError.invalidParams(undefined, 'goal action must be "set" or "clear"');
	const trimmed = typeof objective === "string" ? objective.trim() : "";
	if (!trimmed) throw RequestError.invalidParams(undefined, 'goal action "set" requires a non-empty objective');
	return { sessionId, action, objective: trimmed };
}

/** The AIR snapshot of a goal; `null` when there is none or it was dropped. */
export function toGoalSnapshot(goal: Goal | undefined | null): GoalSnapshot | null {
	if (!goal) return null;
	let status: GoalSnapshotStatus;
	switch (goal.status) {
		case "active":
		case "paused":
		case "complete":
			status = goal.status;
			break;
		case "budget-limited":
			status = "limited";
			break;
		case "dropped":
			return null;
	}
	const snapshot: GoalSnapshot = {
		objective: goal.objective,
		status,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		tokensUsed: goal.tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds,
		controlMethod: GOAL_CONTROL_METHOD,
	};
	if (goal.tokenBudget !== undefined) snapshot.tokenBudget = goal.tokenBudget;
	return snapshot;
}
