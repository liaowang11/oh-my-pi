import { describe, expect, it } from "bun:test";
import { classifyMultiplexer, insideMultiplexer } from "../src/driver/mux/detect";

describe("Rex multiplexer detection", () => {
	it("classifies Rex after nested multiplexers without moving it off the direct render path", () => {
		const rexEnv = { REX_SESSION: "s-1", REX_BLOCK: "b-7", TERM_PROGRAM: "rex" };
		expect(classifyMultiplexer(rexEnv)).toBe("rex");
		expect(insideMultiplexer(rexEnv)).toBe(false);
		expect(classifyMultiplexer({ ...rexEnv, TMUX: "session" })).toBe("tmux");
		expect(classifyMultiplexer({ ...rexEnv, ZELLIJ: "session" })).toBe("zellij");
		expect(classifyMultiplexer({ TERM_PROGRAM: "rex" })).toBe(null);
		expect(classifyMultiplexer({ REX_BLOCK: "b-7" })).toBe(null);
		expect(classifyMultiplexer({ REX_SESSION: " " })).toBe(null);
	});
});
