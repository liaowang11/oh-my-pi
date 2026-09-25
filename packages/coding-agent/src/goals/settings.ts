import { register } from "../config/registry";

const DEFAULT_GOAL_CONTINUATION_MODES: string[] = ["interactive", "acp"];

export const cfgGoalEnabled = register({
	id: "goal.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Mode",
		description: "Enable per-session goal mode and the hidden goal tool",
	},
});

export const cfgGoalStatusInFooter = register({
	id: "goal.statusInFooter",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Status in Footer",
		description: "Show token budget alongside the goal indicator in the status line",
	},
});

export const cfgGoalContinuationModes = register({
	id: "goal.continuationModes",
	type: "array",
	default: DEFAULT_GOAL_CONTINUATION_MODES,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Goal Continuation Modes",
		description: "Run modes where active goals may auto-continue between turns",
	},
});

export const cfgTitleRefreshOnReplan = register({
	id: "title.refreshOnReplan",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Refresh Title on Replan",
		description: "Refresh generated session titles after todo init replans unless the title was set by the user",
	},
});
