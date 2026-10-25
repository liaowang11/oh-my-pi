/**
 * Subscription rate limits pushed on `usage_update._meta["_claude/rateLimit"]`,
 * the key claude-agent-acp forwards the Claude SDK's `rate_limit_info` under,
 * so a client that renders claude-agent-acp's limits renders omp's unchanged.
 *
 * claude-agent-acp sends one window per update; a client keeps the latest
 * report per `rateLimitType`. omp maps each window of its own usage reports
 * that applies to the session's model and account, and leaves out any field
 * the report does not know.
 */
import { resolveUsedFraction, type UsageLimit, type UsageReport, type UsageStatus } from "@oh-my-pi/pi-ai";
import type { OAuthAccountIdentity } from "../../session/auth-storage";
import { limitMatchesActiveAccount } from "../../slash-commands/helpers/active-oauth-account";

/** The `_meta` key of a `usage_update`'s rate-limit window. */
export const RATE_LIMIT_META_KEY = "_claude/rateLimit";

/** One window in the Claude SDK's `rate_limit_info` shape. */
export interface RateLimitInfo {
	status: "allowed" | "allowed_warning" | "rejected";
	/** The window, e.g. `five_hour`, `seven_day`, `seven_day_opus`. */
	rateLimitType: string;
	/** Fraction used, 0..1 (above 1 in overage). */
	utilization?: number;
	/** Epoch seconds. */
	resetsAt?: number;
}

const STATUS: Partial<Record<UsageStatus, RateLimitInfo["status"]>> = {
	ok: "allowed",
	warning: "allowed_warning",
	exhausted: "rejected",
};

/** The Claude SDK's names for the windows it reports; any other window keeps omp's id. */
const WINDOW_TYPES: Record<string, string> = {
	"5h": "five_hour",
	"7d": "seven_day",
};

/**
 * The windows of `reports` for the session's provider, model, and account.
 * A limit with no known status, or no window, is left out. Without an
 * identity every account's limits apply, as in the status line.
 */
export function rateLimitInfos(
	reports: readonly UsageReport[],
	context: { provider: string; modelId: string; identity: OAuthAccountIdentity | undefined },
): RateLimitInfo[] {
	const infos: RateLimitInfo[] = [];
	for (const report of reports) {
		if (report.provider !== context.provider) continue;
		for (const limit of report.limits) {
			if (context.identity && !limitMatchesActiveAccount(report, limit, context.identity)) continue;
			if (limit.scope.modelId && limit.scope.modelId !== context.modelId) continue;
			const info = rateLimitInfo(limit);
			if (info) infos.push(info);
		}
	}
	return infos;
}

function rateLimitInfo(limit: UsageLimit): RateLimitInfo | undefined {
	const status = limit.status ? STATUS[limit.status] : undefined;
	const windowId = limit.scope.windowId ?? limit.window?.id;
	if (!status || !windowId) return undefined;
	const base = WINDOW_TYPES[windowId] ?? windowId;
	const tier = limit.scope.tier?.trim().toLowerCase();
	const utilization = resolveUsedFraction(limit);
	const resetsAt = limit.window?.resetsAt;
	return {
		status,
		rateLimitType: tier ? `${base}_${tier}` : base,
		...(utilization !== undefined ? { utilization } : {}),
		...(resetsAt !== undefined ? { resetsAt: Math.round(resetsAt / 1000) } : {}),
	};
}

/**
 * Words the Claude SDK lists in `USAGE_LIMIT_ERROR_PREFIXES`, the stable
 * start of the message a turn a usage limit stopped fails with. A client that
 * reads claude-agent-acp's usage-limit failures by them reads omp's too.
 */
const USAGE_LIMIT_PREFIX = "You've hit your";

/**
 * The message a prompt turn a usage limit stopped fails with: the provider,
 * then when the limit resets, written as the Claude CLI writes it (`resets
 * 8pm (Asia/Shanghai)`, `resets Oct 27, 8pm (Asia/Shanghai)`), so a client
 * parsing the CLI's reset parses omp's. An unknown or past reset is left out.
 */
export function usageLimitFailureText(
	provider: string,
	resetAtMs: number | undefined,
	nowMs = Date.now(),
	timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
	const text = `${USAGE_LIMIT_PREFIX} ${provider} usage limit`;
	if (resetAtMs === undefined || resetAtMs <= nowMs) return text;
	return `${text} · resets ${formatResetTime(resetAtMs, nowMs, timeZone)} (${timeZone})`;
}

/**
 * en-US on a 12-hour clock, minutes dropped when zero and the meridiem
 * lowercased: `8pm` on the day of `nowMs`, `Oct 27, 8pm` on another day,
 * `Jan 2, 2027, 8pm` in another year, all in `timeZone`.
 */
function formatResetTime(resetAtMs: number, nowMs: number, timeZone: string): string {
	const format = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
	const parts = (ms: number) => {
		const fields: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
		for (const part of format.formatToParts(ms)) fields[part.type] = part.value;
		return fields;
	};
	const reset = parts(resetAtMs);
	const now = parts(nowMs);
	const minute = reset.minute === "00" ? "" : `:${reset.minute}`;
	const time = `${reset.hour}${minute}${reset.dayPeriod?.toLowerCase()}`;
	if (reset.year !== now.year) return `${reset.month} ${reset.day}, ${reset.year}, ${time}`;
	if (reset.month !== now.month || reset.day !== now.day) return `${reset.month} ${reset.day}, ${time}`;
	return time;
}
