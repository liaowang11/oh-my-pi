import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { runInteractiveBashPty } from "../../src/tools/bash-interactive";
import { KeybindingsManager } from "../../src/config/keybindings/keybindings";
import type { ExtensionUiHost } from "../../src/extensibility/extensions/render-types";
import type { ExtensionCustomFactory } from "../../src/extensibility/extensions/types";
import { ensureTheme } from "../../src/ui/theme/service";
import { extensionTheme } from "../../src/ui/extensions/render-output";
import { createRoot } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

type InteractiveUi = Pick<NonNullable<AgentToolContext["ui"]>, "custom">;
/** A UI whose `custom()` builds the console view against a 100x30 host and resolves with what it reports. */
function headlessUi(): InteractiveUi {
	const custom: InteractiveUi["custom"] = async <T>(factory: ExtensionCustomFactory<T>): Promise<T> => {
		const { promise, resolve } = Promise.withResolvers<T>();
		const host: ExtensionUiHost = {
			requestRender() {},
			size: () => ({ columns: 100, rows: 30 }),
			suspend: run => run(),
		};
		ensureTheme();
		await createRoot(() => factory(host, extensionTheme(currentTheme()), KeybindingsManager.inMemory(), resolve));
		return promise;
	};
	return { custom };
}

const unavailable = process.platform === "win32" || Bun.env.PI_NO_PTY === "1" || !fs.existsSync("/bin/bash");
describe("messaging env in interactive PTY commands", () => {
	let temp: TempDir;
	beforeEach(async () => {
		temp = TempDir.createSync("@messaging-env-pty-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: temp.path() });
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: temp.path(),
				OMP_MESSAGING_SOCKET: "parent-socket",
				OMP_MESSAGING_TOKEN: "parent-token",
			},
			prefix: undefined,
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		temp.removeSync();
	});

	it.skipIf(unavailable)("removes both inherited and overlay credentials from a helper's real PTY child", async () => {
		const command = 'printf "socket=<%s> token=<%s>" "${OMP_MESSAGING_SOCKET-unset}" "${OMP_MESSAGING_TOKEN-unset}"';
		const result = await runInteractiveBashPty(headlessUi(), {
			command,
			application: "/bin/sh",
			args: ["-c", command],
			cwd: temp.path(),
			timeoutMs: 15_000,
			env: { OMP_MESSAGING_SOCKET: "overlay-socket", OMP_MESSAGING_TOKEN: "overlay-token" },
			stripEnv: ["OMP_MESSAGING_SOCKET", "OMP_MESSAGING_TOKEN"],
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("socket=<> token=<>");
	});
});
