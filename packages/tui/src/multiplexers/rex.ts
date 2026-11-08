import type { TerminalMultiplexerModule } from "./types";

/**
 * Rex is a terminal app whose blocks (panes) live in sessions it manages; each
 * terminal it opens exports `REX_SESSION` and `REX_BLOCK`. It is recognized for
 * launches, but it ranks below nested multiplexers and keeps the direct-terminal
 * render path it used before it was recognized (`TERM_PROGRAM=rex` capabilities).
 */
export const rexMultiplexer = {
	id: "rex",
	precedence: "outerApp",
	sessionEnvKeys: ["REX_SESSION"],
	ownsScreenGrid: false,
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.REX_SESSION?.trim());
	},
} as const satisfies TerminalMultiplexerModule;
