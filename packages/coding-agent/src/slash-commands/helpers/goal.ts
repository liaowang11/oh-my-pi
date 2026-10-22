import { prompt } from "@oh-my-pi/pi-utils";
import { isGoalInterviewActive } from "../../goals/mode";
import { cfgGoalEnabled } from "../../goals/settings";
import type { GoalModeState } from "../../goals/state";
import guidedGoalInterviewPrompt from "../../prompts/goals/guided-goal-interview.md" with { type: "text" };
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";

export type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop", "budget"]);

export function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (GOAL_SUBCOMMANDS.has(first as GoalSubcommand)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

function goalDetails(state: GoalModeState | undefined): string {
	const goal = state?.goal;
	if (!goal) return "No goal set.";
	const budgetLine =
		goal.tokenBudget === undefined
			? `${goal.tokensUsed} (no budget)`
			: `${goal.tokensUsed} / ${goal.tokenBudget} (${Math.max(0, goal.tokenBudget - goal.tokensUsed)} left)`;
	return [
		`Objective: ${goal.objective}`,
		`Status: ${goal.status}`,
		`Tokens: ${budgetLine}`,
		`Time spent: ${goal.timeUsedSeconds} seconds`,
	].join("\n");
}

/** What the goal state helpers need from a slash-command runtime. */
type GoalRuntimeContext = Pick<SlashCommandRuntime, "session" | "settings">;

async function setGoalToolEnabled(runtime: GoalRuntimeContext, enabled: boolean): Promise<void> {
	const tools = runtime.session.getEnabledToolNames().filter(name => name !== "goal");
	await runtime.session.setActiveToolsByName(enabled ? [...tools, "goal"] : tools);
}

export async function handleAcpGuidedGoalCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { session } = runtime;
	if (!cfgGoalEnabled.get(runtime.settings)) {
		await runtime.output("Goal mode is disabled. Enable it in settings (goal.enabled).");
		return;
	}
	if (session.getPlanModeState()?.enabled) {
		await runtime.output("Exit plan mode first.");
		return;
	}
	if (session.getVibeModeState()?.enabled) {
		await runtime.output("Exit vibe mode first.");
		return;
	}
	if (session.getGoalModeState()) {
		await runtime.output("A goal already exists. Use /goal to manage it, or /goal drop to start over.");
		return;
	}
	if (isGoalInterviewActive(session)) {
		await runtime.output("A goal interview is already in progress. Use /goal drop to stop it.");
		return;
	}

	const kickoff = prompt.render(guidedGoalInterviewPrompt, { initial: command.args.trim() || undefined });
	const previousTools = session.getEnabledToolNames();
	if (!previousTools.includes("goal")) {
		try {
			await session.setActiveToolsByName([...previousTools, "goal"]);
		} catch (error) {
			await session.setActiveToolsByName(previousTools);
			throw error;
		}
	}
	if (!session.getEnabledToolNames().includes("goal")) {
		await session.setActiveToolsByName(previousTools);
		await runtime.output("Goal tool is unavailable in this session.");
		return;
	}
	return { prompt: kickoff, synthetic: true };
}

const PAUSED_GOAL_REFUSAL = "Resume the current goal first, or drop it before setting a new objective.";

/** Create the goal, or replace an active one's objective. Returns why it refused, if it did. */
async function setGoalState(objective: string, runtime: GoalRuntimeContext): Promise<string | undefined> {
	const { session } = runtime;
	const state = session.getGoalModeState();
	if (state && !state.enabled) return PAUSED_GOAL_REFUSAL;
	if (state?.enabled) {
		await session.goalRuntime.replaceGoal({ objective });
		return undefined;
	}
	await setGoalToolEnabled(runtime, true);
	if (!session.getEnabledToolNames().includes("goal")) return "Goal tool is unavailable in this session.";
	try {
		await session.goalRuntime.createGoal({ objective });
	} catch (error) {
		await setGoalToolEnabled(runtime, false);
		throw error;
	}
	return undefined;
}

/** Drop the goal, or stop a goal interview. Reports which, if either, there was. */
async function dropGoalState(runtime: GoalRuntimeContext): Promise<"dropped" | "interview" | "none"> {
	const { session } = runtime;
	if (!session.getGoalModeState()) {
		if (!isGoalInterviewActive(session)) return "none";
		await setGoalToolEnabled(runtime, false);
		return "interview";
	}
	await session.goalRuntime.dropGoal();
	await setGoalToolEnabled(runtime, false);
	return "dropped";
}

/** A goal change requested outside a slash command, as ACP `_session/goal` sends it. */
export type AcpGoalAction = { action: "set"; objective: string } | { action: "clear" };

/**
 * Apply `action` as `/goal set <objective>` or `/goal drop` would, with the
 * same checks, but without starting a turn. Returns why it refused, if it did;
 * clearing when there is no goal is not a refusal.
 */
export async function applyAcpGoalAction(
	runtime: GoalRuntimeContext,
	action: AcpGoalAction,
): Promise<string | undefined> {
	const refusal = acpGoalActionRefusal(runtime, action);
	if (refusal) return refusal;
	if (action.action === "set") return await setGoalState(action.objective, runtime);
	await dropGoalState(runtime);
	return undefined;
}

/** Why `action` cannot run now, if it cannot; changes nothing. */
export function acpGoalActionRefusal(runtime: GoalRuntimeContext, action: AcpGoalAction): string | undefined {
	const { session } = runtime;
	const state = session.getGoalModeState();
	if (action.action === "set" && !cfgGoalEnabled.get(runtime.settings)) {
		return "Goal mode is disabled. Enable it in settings (goal.enabled).";
	}
	if (session.getPlanModeState()?.enabled) return "Exit plan mode first.";
	if (session.getVibeModeState()?.enabled) return "Exit vibe mode first.";
	if (action.action === "set" && state && !state.enabled) return PAUSED_GOAL_REFUSAL;
	return undefined;
}

async function setGoal(objective: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!objective) {
		await runtime.output("Usage: /goal set <objective>");
		return;
	}
	const refusal = await setGoalState(objective, runtime);
	if (refusal) {
		await runtime.output(refusal);
		return;
	}
	return { prompt: objective };
}

function parseBudget(value: string): number | undefined | null {
	if (value.toLowerCase() === "off") return undefined;
	if (!/^[1-9]\d*$/.test(value)) return null;
	const budget = Number(value);
	return Number.isSafeInteger(budget) ? budget : null;
}

export async function handleAcpGoalCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { session } = runtime;
	const { sub, rest } = parseGoalSubcommand(command.args);
	const state = session.getGoalModeState();
	const interviewing = isGoalInterviewActive(session);
	if (
		!cfgGoalEnabled.get(runtime.settings) &&
		((!state && !interviewing) || sub === "set" || sub === "resume" || (!sub && Boolean(rest)))
	) {
		await runtime.output("Goal mode is disabled. Enable it in settings (goal.enabled).");
		return;
	}
	if (session.getPlanModeState()?.enabled) {
		await runtime.output("Exit plan mode first.");
		return;
	}
	if (session.getVibeModeState()?.enabled) {
		await runtime.output("Exit vibe mode first.");
		return;
	}
	if (sub === "show" || (!sub && !rest)) {
		await runtime.output(interviewing ? "Goal interview in progress." : goalDetails(state));
		return;
	}
	if (sub === "set" || !sub) return await setGoal(rest, runtime);
	if (sub === "pause") {
		if (!state?.enabled) {
			await runtime.output("No active goal to pause.");
			return;
		}
		await session.goalRuntime.pauseGoal();
		await setGoalToolEnabled(runtime, false);
		await runtime.output("Goal mode paused.");
		return;
	}
	if (sub === "resume") {
		if (state?.enabled || state?.goal.status !== "paused") {
			await runtime.output("No paused goal to resume.");
			return;
		}
		await setGoalToolEnabled(runtime, true);
		if (!session.getEnabledToolNames().includes("goal")) {
			await runtime.output("Goal tool is unavailable in this session.");
			return;
		}
		try {
			await session.goalRuntime.resumeGoal();
		} catch (error) {
			await setGoalToolEnabled(runtime, false);
			throw error;
		}
		await runtime.output("Goal mode resumed.");
		return;
	}
	if (sub === "drop") {
		const dropped = await dropGoalState(runtime);
		await runtime.output(
			dropped === "dropped"
				? "Goal dropped."
				: dropped === "interview"
					? "Goal interview stopped."
					: "No goal to drop.",
		);
		return;
	}
	if (!state?.enabled) {
		await runtime.output(
			state?.goal.status === "paused" ? "Resume the goal before adjusting the budget." : "No active goal.",
		);
		return;
	}
	if (!rest) {
		await runtime.output("Usage: /goal budget <positive integer|off>");
		return;
	}
	const budget = parseBudget(rest);
	if (budget === null) {
		await runtime.output("Goal budget must be a positive integer or `off`.");
		return;
	}
	await session.goalRuntime.onBudgetMutated(budget);
	await runtime.output(budget === undefined ? "Goal budget cleared." : `Goal budget set to ${budget}.`);
}
