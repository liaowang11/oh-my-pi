import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-coding-agent/autocomplete/prompt-actions";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { SessionMentionCandidate } from "@oh-my-pi/pi-coding-agent/autocomplete/prompt-actions";

function providerWithSessions(basePath: string, sessions: SessionMentionCandidate[]) {
	return createPromptActionAutocompleteProvider({
		commands: [],
		basePath,
		sessionMentions: async () => sessions,
		keybindings: KeybindingsManager.inMemory(),
		copyCurrentLine: () => {},
		copyPrompt: () => {},
		undo: () => {},
		moveCursorToMessageEnd: () => {},
		moveCursorToMessageStart: () => {},
		moveCursorToLineStart: () => {},
		moveCursorToLineEnd: () => {},
	});
}

describe("session mention autocomplete", () => {
	it("preserves raw double backslashes and escaped quotes while completing a session mention", async () => {
		const name = String.raw`\\server\share "draft"`;
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/project",
			sessionMentions: async () => [{ name, cwd: "/other" }],
			keybindings: KeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});
		const line = String.raw`@"\\server\share \"draft\""`;
		const suggestions = await provider.getSuggestions([line], 0, line.length);
		const item = suggestions?.items.find(item => item.label === `@${name}`);
		expect(item?.value).toBe(line);
		if (!suggestions || !item) throw new Error("expected session mention suggestion");
		const completed = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
		expect(completed.lines[0]).toBe(`${line} `);
	});

	it("appends sessions after file results and quotes a live session token without replacing surrounding prose", async () => {
		using dir = TempDir.createSync("@omp-session-mentions-");
		await Bun.write(path.join(dir.path(), "release.txt"), "release");
		const provider = providerWithSessions(dir.path(), [
			{ name: "release notes", cwd: "/project" },
			{ name: 'release "draft"', cwd: "/draft" },
		]);
		const suggestions = await provider.getSuggestions(["tell @"], 0, 6);
		if (!suggestions) throw new Error("Expected file and session suggestions");
		const file = suggestions.items.findIndex(item => item.value.includes("release.txt"));
		const session = suggestions.items.findIndex(item => item.label === "@release notes");
		expect(file).toBeGreaterThanOrEqual(0);
		expect(session).toBeGreaterThan(file);
		expect(suggestions.items[session]?.description).toBe("session · /project");
		const applied = provider.applyCompletion(
			["tell @release and wait"],
			0,
			13,
			suggestions.items[session]!,
			suggestions.prefix,
		);
		expect(applied.lines).toEqual(['tell @"release notes"  and wait']);
		expect(applied.cursorCol).toBe('tell @"release notes" '.length);
		const quoted = suggestions.items.find(item => item.label === '@release "draft"')!;
		expect(provider.applyCompletion(["@"], 0, 1, quoted, "@").lines).toEqual(['@"release \\"draft\\"" ']);
	});

	it("sanitizes and bounds session mention labels while preserving raw completion and filtering", async () => {
		using dir = TempDir.createSync("@omp-peer-mentions-");
		const attack = "\x1b]0;PWNED\x07\x1b]52;c;SGVsbG8=\x07\x1b[31mpeer\x1b[0m\nrow\rreturn";
		const name = `${attack}${"x".repeat(500)}`;
		const provider = providerWithSessions(dir.path(), [{ name, cwd: name }]);
		const suggestions = await provider.getSuggestions(["@"], 0, 1);
		const item = suggestions?.items.find(item => item.value === `@"${name}"`);
		expect(item).toBeDefined();
		expect(item!.label).not.toContain("\x1b");
		expect(item!.label).not.toContain("\n");
		expect(item!.description).not.toContain("\x1b");
		expect(item!.description).not.toContain("\r");
		expect(item!.description).not.toContain("\n");
		expect(item!.label.length).toBeLessThan(name.length);
		expect(item!.description!.length).toBeLessThan(name.length);
		expect(provider.applyCompletion(["@"], 0, 1, item!, "@").lines).toEqual([`@"${name}" `]);
		const filtered = await provider.getSuggestions(["@PWNED"], 0, 6);
		expect(filtered?.items.some(candidate => candidate.value === item!.value)).toBe(true);
	});
});
