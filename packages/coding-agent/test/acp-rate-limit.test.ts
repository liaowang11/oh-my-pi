import { describe, expect, it } from "bun:test";
import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { rateLimitInfos } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-rate-limit";

const RESET_MS = 1_800_000_000_000;

function limit(id: string, fields: Partial<UsageLimit> & Pick<UsageLimit, "scope">): UsageLimit {
	return { id, label: id, amount: { unit: "percent" }, ...fields };
}

function report(provider: string, email: string, limits: UsageLimit[]): UsageReport {
	return { provider, fetchedAt: 0, limits, metadata: { email } };
}

describe("ACP rate-limit mapping", () => {
	it("maps the session's provider, model, and account windows into claude-agent-acp's rate_limit_info", () => {
		const reports = [
			report("anthropic", "me@example.com", [
				limit("anthropic:5h", {
					scope: { provider: "anthropic", windowId: "5h" },
					window: { id: "5h", label: "5 Hour", resetsAt: RESET_MS },
					amount: { unit: "percent", usedFraction: 0.92 },
					status: "warning",
				}),
				limit("anthropic:7d:opus", {
					scope: { provider: "anthropic", windowId: "7d", tier: "opus" },
					amount: { unit: "percent", used: 100 },
					status: "exhausted",
				}),
				// Unknown status: nothing faithful to report.
				limit("anthropic:7d", {
					scope: { provider: "anthropic", windowId: "7d" },
					status: "unknown",
				}),
				// Scoped to another model.
				limit("anthropic:5h:other", {
					scope: { provider: "anthropic", windowId: "5h", modelId: "claude-other" },
					status: "ok",
				}),
				limit("anthropic:daily", {
					scope: { provider: "anthropic", windowId: "daily" },
					amount: { unit: "percent", usedFraction: 0.1 },
					status: "ok",
				}),
			]),
			report("anthropic", "other@example.com", [
				limit("anthropic:5h", { scope: { provider: "anthropic", windowId: "5h" }, status: "exhausted" }),
			]),
			report("openai-codex", "me@example.com", [
				limit("codex:5h", { scope: { provider: "openai-codex", windowId: "5h" }, status: "exhausted" }),
			]),
		];

		const infos = rateLimitInfos(reports, {
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			identity: { email: "me@example.com" },
		});

		expect(infos).toEqual([
			// `resetsAt` in epoch seconds, as the SDK sends it.
			{ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.92, resetsAt: RESET_MS / 1000 },
			{ status: "rejected", rateLimitType: "seven_day_opus", utilization: 1 },
			{ status: "allowed", rateLimitType: "daily", utilization: 0.1 },
		]);
	});
});
