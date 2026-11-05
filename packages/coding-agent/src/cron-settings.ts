import { register } from "./config/registry";

export const cfgCronEnabled = register({
	id: "cron.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "Modes",
		label: "Scheduled Prompts",
		description: "Give top-level sessions the cron_create, cron_list, and cron_delete tools",
	},
});
