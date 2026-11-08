import { hasTerminalMultiplexerSession } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { launchError, runStep } from "./shared";
import type { SupportedMultiplexerCapabilities, TerminalLaunchBackend, TerminalLaunchProvider } from "./types";

const capabilities = {
	displayName: "Rex",
	supported: true,
	pane: {
		displayName: "block",
		execution: ["direct"],
		direction: ["right", "down"],
		focus: true,
		name: true,
	},
	window: {
		displayName: "window",
		execution: ["direct"],
		focus: true,
	},
} as const satisfies SupportedMultiplexerCapabilities;

const SPLIT_DIRECTIONS = { right: "right", down: "below" } as const;

/**
 * Rex panes are blocks split beside the calling block (`REX_BLOCK`) and tabs
 * are windows, both in the calling session (`REX_SESSION`). Values ride in
 * `--flag=value` form so text starting with `-` is never read as a flag. The
 * CLI prints no ID without `--json`, so the result carries none.
 */
const launchRex: TerminalLaunchBackend<"rex", typeof capabilities> = async (request, { environment, runCli }) => {
	if (!hasTerminalMultiplexerSession("rex", environment)) {
		throw launchError(request, "capability", "rex launch requires an active Rex session.");
	}
	const session = environment.REX_SESSION!.trim();
	const argv =
		request.placement === "pane" ? ["rex", "split", "-s", session] : ["rex", "window", "new", "-s", session];
	if (request.placement === "pane") {
		const block = environment.REX_BLOCK?.trim();
		if (block) argv.push("-b", block);
		argv.push(`--split=${SPLIT_DIRECTIONS[request.direction ?? "right"]}`);
	}
	argv.push(`--cwd=${request.cwd}`);
	if (request.placement === "pane" && request.name) argv.push(`--label=${request.name}`);
	if (request.focus === false) argv.push("--focus=false");
	argv.push("--", ...request.command);
	await runStep(request, request.placement === "pane" ? "split" : "window new", argv, request.cwd, runCli);
	return { multiplexer: "rex", placement: request.placement };
};

export const rexLaunchProvider: TerminalLaunchProvider<"rex", typeof capabilities> = {
	capabilities,
	launch: launchRex,
};
