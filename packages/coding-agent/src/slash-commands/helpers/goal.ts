import { prompt } from "@oh-my-pi/pi-utils";
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

async function setGoalToolEnabled(runtime: SlashCommandRuntime, enabled: boolean): Promise<void> {
	const tools = runtime.session.getEnabledToolNames().filter(name => name !== "goal");
	await runtime.session.setActiveToolsByName(enabled ? [...tools, "goal"] : tools);
}

export async function handleAcpGuidedGoalCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { session } = runtime;
	if (!runtime.settings.get("goal.enabled")) {
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
	if (session.getEnabledToolNames().includes("goal")) {
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

async function setGoal(objective: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	if (!objective) {
		await runtime.output("Usage: /goal set <objective>");
		return;
	}
	const { session } = runtime;
	const state = session.getGoalModeState();
	if (state && !state.enabled) {
		await runtime.output("Resume the current goal first, or drop it before setting a new objective.");
		return;
	}
	if (state?.enabled) {
		await session.goalRuntime.replaceGoal({ objective });
	} else {
		await setGoalToolEnabled(runtime, true);
		if (!session.getEnabledToolNames().includes("goal")) {
			await runtime.output("Goal tool is unavailable in this session.");
			return;
		}
		try {
			await session.goalRuntime.createGoal({ objective });
		} catch (error) {
			await setGoalToolEnabled(runtime, false);
			throw error;
		}
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
	const interviewing = !state && session.getEnabledToolNames().includes("goal");
	if (
		!runtime.settings.get("goal.enabled") &&
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
		if (!state) {
			if (interviewing) {
				await setGoalToolEnabled(runtime, false);
				await runtime.output("Goal interview stopped.");
			} else {
				await runtime.output("No goal to drop.");
			}
			return;
		}
		await session.goalRuntime.dropGoal();
		await setGoalToolEnabled(runtime, false);
		await runtime.output("Goal dropped.");
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
