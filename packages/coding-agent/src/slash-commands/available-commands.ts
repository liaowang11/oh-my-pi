import type { AvailableCommand } from "@oh-my-pi/pi-utils/acp";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { SkillsSettings } from "../extensibility/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner } from "../extensibility/extensions";
import { getSkillSlashCommandName, type Skill } from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands } from "../extensibility/slash-commands";
import { ACP_BUILTIN_RESERVED_NAMES, isAcpBuiltinShadowedName, RPC_BUILTIN_RESERVED_NAMES } from "./acp-builtins";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "./builtin-registry";

export type AvailableSlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

export interface InternalAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface AvailableCommandsSession {
	readonly extensionRunner?: ExtensionRunner;
	readonly customCommands: ReadonlyArray<LoadedCustomCommand>;
	readonly mcpPromptCommands?: ReadonlyArray<LoadedCustomCommand>;
	readonly skills: ReadonlyArray<Skill>;
	readonly skillsSettings?: SkillsSettings;
	readonly effectiveExtensionRoots?: EffectiveExtensionRoots;
	setSlashCommands(slashCommands: FileSlashCommand[]): void;
	sessionManager: { getCwd(): string };
}

export async function buildAvailableSlashCommands(
	session: AvailableCommandsSession,
	loadFileCommands: (cwd: string) => Promise<FileSlashCommand[]> = cwd =>
		loadSlashCommands({ cwd, extensionRoots: session.effectiveExtensionRoots }),
	host: "acp" | "rpc" = "acp",
): Promise<InternalAvailableSlashCommand[]> {
	const commands: InternalAvailableSlashCommand[] = [];
	const seenNames = new Set<string>();
	const reservedNames = host === "acp" ? ACP_BUILTIN_RESERVED_NAMES : RPC_BUILTIN_RESERVED_NAMES;
	const appendCommand = (command: InternalAvailableSlashCommand): void => {
		if (seenNames.has(command.name)) return;
		seenNames.add(command.name);
		commands.push(command);
	};

	for (const command of BUILTIN_SLASH_COMMANDS_INTERNAL) {
		const handler = host === "acp" ? (command.handleAcp ?? command.handle) : command.handle;
		if (!handler) continue;
		const hint = command.acpInputHint ?? command.inlineHint;
		appendCommand({
			name: command.name,
			aliases: command.aliases,
			description: command.acpDescription ?? command.description,
			input: hint ? { hint } : undefined,
			subcommands: command.subcommands,
			source: "builtin",
		});
		// ACP dispatch resolves builtin aliases before `session.prompt()` sees the
		// input, so a custom/file command sharing an alias would be advertised but
		// never run. Reserve aliases here too; commands unavailable to this host
		// are skipped above, so their aliases stay available.
		for (const alias of command.aliases ?? []) seenNames.add(alias);
	}

	if (session.skillsSettings?.enableSkillCommands) {
		for (const skill of session.skills) {
			appendCommand({
				name: getSkillSlashCommandName(skill),
				description: skill.description || `Run ${skill.name} skill`,
				input: { hint: "arguments" },
				source: "skill",
			});
		}
	}

	const runner = session.extensionRunner;
	if (runner) {
		for (const command of runner.getRegisteredCommands(reservedNames)) {
			if (isAcpBuiltinShadowedName(command.name, reservedNames)) continue;
			appendCommand({
				name: command.name,
				description: command.description ?? "(extension command)",
				input: { hint: "arguments" },
				source: "extension",
			});
		}
	}

	for (const command of session.customCommands) {
		const source: AvailableSlashCommandSource = command.path?.startsWith("mcp:") ? "mcp_prompt" : "custom";
		appendCommand({
			name: command.command.name,
			description: command.command.description,
			input: { hint: "arguments" },
			source,
		});
	}

	const fileCommands = await loadFileCommands(session.sessionManager.getCwd());
	session.setSlashCommands(fileCommands);
	for (const command of fileCommands) {
		appendCommand({
			name: command.name,
			description: command.description,
			input: command.argumentHint ? { hint: command.argumentHint } : undefined,
			source: "file",
		});
	}

	return commands;
}

export function toAcpAvailableCommands(commands: readonly InternalAvailableSlashCommand[]): AvailableCommand[] {
	return commands.map(command => ({
		name: command.name,
		description: command.description ?? "",
		input: command.input,
	}));
}
