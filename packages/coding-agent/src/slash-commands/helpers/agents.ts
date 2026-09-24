import {
	type AgentsHubDeps,
	agentOverrideRecord,
	describeAgentProperty,
	disabledAgentNames,
	type HubAgent,
	type PropertyKind,
	setAgentPropertyOverride,
} from "@oh-my-pi/pi-tui/overlays/agents-hub";
import type { SettingPath } from "../../config/settings";
import { createAgentsHubDeps } from "../../modes/agents-hub-deps";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand, usage } from "./parse";

const USAGE = [
	"Usage: /agents [list]",
	"       /agents enable|disable <name>",
	"       /agents model <name> <pattern|default>",
	"       /agents prewalk|advisor <name> <on|off|pattern|default>",
].join("\n");

const PROPERTY_SETTING: Record<PropertyKind, SettingPath> = {
	model: "task.agentModelOverrides",
	prewalk: "task.agentPrewalk",
	advisor: "task.agentAdvisor",
};

/**
 * Protocol hosts pin these paths to their defaults as runtime overrides when
 * the user left them unset (`applyAcpDefaultSettingOverrides`). Overrides merge
 * last and replace arrays, so a persisted `set` alone would never reach the
 * running session. Dropping the pin once the user writes a value hands the
 * key back to their settings, as it would be had they configured it upfront.
 */
function releaseHostDefault(runtime: SlashCommandRuntime, path: SettingPath): void {
	runtime.settings.clearOverride(path);
}

/**
 * `describeAgentProperty` without the name prefix, with one change for text
 * output: the model shows the declared pattern rather than the effective list,
 * which expands a role alias such as `@smol` into its whole fallback chain.
 */
function describeProperty(deps: AgentsHubDeps, agent: HubAgent, property: PropertyKind): string {
	if (property !== "model") return describeAgentProperty(deps, agent, property).slice(agent.name.length + 1);
	const declared = agent.overrideModel ?? agent.model?.join(",") ?? "session model";
	const resolved = deps.resolvePatterns(deps.effectiveModelPatterns(agent));
	return `model: ${declared}${resolved ? ` → ${resolved}` : ""}`;
}

function describeAgent(deps: AgentsHubDeps, agent: HubAgent): string {
	const properties = (["model", "prewalk", "advisor"] as const).map(property =>
		describeProperty(deps, agent, property),
	);
	return `${agent.name} [${agent.source}] ${agent.disabled ? "disabled" : "enabled"} · ${properties.join(" · ")}`;
}

/** Text-mode `/agents`: list agents and edit the per-agent settings the TUI agents hub edits. */
export async function handleAcpAgentsCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const deps = createAgentsHubDeps(
		runtime.cwd,
		runtime.settings,
		runtime.session.modelRegistry,
		() => runtime.session.effectiveExtensionRoots,
	);
	const agents = await deps.loadAgents();
	const { verb, rest } = parseSubcommand(command.args);

	if (!verb || (verb === "list" && !rest)) {
		if (agents.length === 0) return usage("No agents found.", runtime);
		await runtime.output(agents.map(agent => describeAgent(deps, agent)).join("\n"));
		return commandConsumed();
	}

	const [name, ...valueTokens] = rest.split(/\s+/).filter(Boolean);
	const value = valueTokens.join(" ");
	const agent = name ? agents.find(entry => entry.name === name) : undefined;
	if (name && !agent) {
		return usage(`Unknown agent: ${name}. Known agents: ${agents.map(entry => entry.name).join(", ")}`, runtime);
	}

	if ((verb === "enable" || verb === "disable") && agent && !value) {
		agent.disabled = verb === "disable";
		deps.setDisabledAgents(disabledAgentNames(agents));
		releaseHostDefault(runtime, "task.disabledAgents");
		return usage(`${agent.name} ${agent.disabled ? "disabled" : "enabled"}`, runtime);
	}

	if ((verb === "model" || verb === "prewalk" || verb === "advisor") && agent && value) {
		setAgentPropertyOverride(agent, verb, value === "default" ? undefined : value);
		deps.setOverrides(verb, agentOverrideRecord(agents, verb));
		releaseHostDefault(runtime, PROPERTY_SETTING[verb]);
		return usage(`${agent.name} ${describeProperty(deps, agent, verb)}`, runtime);
	}

	return usage(USAGE, runtime);
}
