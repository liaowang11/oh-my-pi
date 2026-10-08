import type { SessionStats, SessionUsageSlice } from "../../session/agent-session-types";

const formatCount = (value: number): string => value.toLocaleString("en-US");

export function formatCreditValue(value: number): string {
	return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatSliceDetail(slice: SessionUsageSlice): string {
	const { input, output, cacheRead, cacheWrite } = slice.tokens;
	const parts = [`in ${formatCount(input)}`, `out ${formatCount(output)}`];
	if (cacheRead > 0) parts.push(`cache read ${formatCount(cacheRead)}`);
	if (cacheWrite > 0) parts.push(`cache write ${formatCount(cacheWrite)}`);
	return parts.join(" · ");
}

function formatSliceSummary(label: string, slice: SessionUsageSlice, unit: string): string {
	const calls = `${formatCount(slice.calls)} ${unit}${slice.calls === 1 ? "" : "s"}`;
	return `${label}  ${formatCount(slice.tokens.total)} tok · $${slice.cost.toFixed(4)} · ${calls} (${formatSliceDetail(slice)})`;
}

/**
 * One line per provider/model, largest first, then the unattributed subagent
 * total. Empty when the session has no recorded usage.
 */
export function formatSessionModelBreakdown(stats: SessionStats): string[] {
	const lines = (stats.models ?? []).map(entry =>
		formatSliceSummary(`${entry.provider}/${entry.model}`, entry, "call"),
	);
	if (stats.subagents) lines.push(formatSliceSummary("subagents", stats.subagents, "run"));
	return lines;
}

export interface SessionReportContext {
	title: string | undefined;
	cwd: string;
	/** Active model as `provider/id`, when one is selected. */
	model: string | undefined;
}

/** Plain-text `/session` report for ACP and other text-mode hosts. */
export function buildSessionReportText(stats: SessionStats, context: SessionReportContext): string {
	const lines = [`Session: ${stats.sessionId}`, `Title: ${context.title}`, `CWD: ${context.cwd}`];
	lines.push(`File: ${stats.sessionFile ?? "In-memory"}`);
	lines.push(`Model: ${context.model ?? "none selected"}`);
	if (stats.routedModels !== undefined) {
		const served = Object.entries(stats.routedModels)
			.sort(([aId, aCount], [bId, bCount]) => bCount - aCount || aId.localeCompare(bId))
			.map(([id, count]) => `${id}${count > 1 ? ` ×${count}` : ""}`);
		lines.push(`Served: ${served.join(", ")}`);
	}

	lines.push(
		"",
		"Messages",
		`User: ${stats.userMessages}`,
		`Assistant: ${stats.assistantMessages}`,
		`Tool Calls: ${stats.toolCalls}`,
		`Tool Results: ${stats.toolResults}`,
		`Total: ${stats.totalMessages}`,
	);

	const { tokens } = stats;
	lines.push("", "Tokens", `Input: ${formatCount(tokens.input)}`, `Output: ${formatCount(tokens.output)}`);
	if (tokens.cacheRead > 0) lines.push(`Cache Read: ${formatCount(tokens.cacheRead)}`);
	if (tokens.cacheWrite > 0) lines.push(`Cache Write: ${formatCount(tokens.cacheWrite)}`);
	lines.push(`Total: ${formatCount(tokens.total)}`);

	const modelLines = formatSessionModelBreakdown(stats);
	if (modelLines.length > 0) lines.push("", "Models", ...modelLines.map(line => `  ${line}`));

	const premiumRequests = Math.round((stats.premiumRequests + Number.EPSILON) * 100) / 100;
	if (stats.cost > 0 || premiumRequests > 0 || stats.credits !== undefined) {
		lines.push("", "Cost");
		if (stats.cost > 0) lines.push(`Cost: ${stats.cost.toFixed(4)}`);
		if (premiumRequests > 0) lines.push(`Premium Requests: ${formatCount(premiumRequests)}`);
		if (stats.credits !== undefined) {
			lines.push(
				`Credits: ${formatCreditValue(stats.credits.cost)}`,
				`Committed Credits: ${formatCreditValue(stats.credits.committedCost)}`,
				`Committed ACU: ${formatCreditValue(stats.credits.acuCost)}`,
			);
		}
	}
	return lines.join("\n");
}
