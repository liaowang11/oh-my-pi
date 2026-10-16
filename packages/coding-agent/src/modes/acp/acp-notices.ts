/**
 * ACP session notices (unstable RFD, https://agentclientprotocol.com/rfds/session-notices).
 *
 * Advisory text for the user — model fallbacks, retries, config warnings,
 * extension notifications — that is not part of the conversation. A client
 * that advertises `clientCapabilities.session.notices` gets a `notice`
 * update; every other client gets a bold-label agent message line under a
 * fresh `messageId`, so it never merges into the assistant's live reply.
 * Shapes match claude-agent-acp's `session-notices.ts`.
 */
import type { ClientCapabilities, SessionUpdate } from "@oh-my-pi/pi-utils/acp";
import type { AgentSessionEvent } from "../../session/agent-session";

export type SessionNoticeSeverity = "info" | "warning" | "error";

export interface SessionNotice {
	severity: SessionNoticeSeverity;
	/** Plain text that stands alone. */
	title: string;
	/** Plain-text detail or guidance. */
	description?: string;
}

/** Longest first line that may serve as a notice title on its own. */
export const MAX_NOTICE_TITLE_LENGTH = 256;

/** Whether the client advertised `clientCapabilities.session.notices` (an object). */
export function clientSupportsNotices(capabilities: ClientCapabilities | undefined): boolean {
	const notices = capabilities?.session?.notices;
	return typeof notices === "object" && notices !== null && !Array.isArray(notices);
}

export function noticeUpdate(notice: SessionNotice): SessionUpdate {
	return {
		sessionUpdate: "notice",
		severity: notice.severity,
		title: notice.title,
		...(notice.description ? { description: notice.description } : {}),
	};
}

/** The transcript rendering of a notice for clients without the capability. */
export function noticeTranscriptText(notice: SessionNotice): string {
	return notice.description ? `**${notice.title}:** ${notice.description}` : `**${notice.title}**`;
}

/**
 * A `notice` when the client can present one, else an agent message line
 * under its own `messageId`.
 */
export function noticeOrTranscriptUpdate(notice: SessionNotice, supportsNotices: boolean): SessionUpdate {
	if (supportsNotices) return noticeUpdate(notice);
	return {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text: noticeTranscriptText(notice) },
		messageId: crypto.randomUUID(),
	};
}

/** Drops inline markdown markers: notice fields are plain text. */
export function noticePlainText(text: string): string {
	return text
		.replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
		.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/(?<![\w`])`([^`\n]+)`(?![\w`])/g, "$1");
}

/**
 * Shapes free-form text into a title plus optional description: the first
 * line is the title when short enough, otherwise the whole text becomes the
 * description under `fallbackTitle`.
 */
export function splitNoticeText(text: string, fallbackTitle: string): Pick<SessionNotice, "title" | "description"> {
	const trimmed = noticePlainText(text).trim();
	if (!trimmed) return { title: fallbackTitle };
	const lineBreak = trimmed.search(/\r?\n/);
	const firstLine = lineBreak === -1 ? trimmed : trimmed.slice(0, lineBreak).trimEnd();
	const rest = lineBreak === -1 ? "" : trimmed.slice(lineBreak).trim();
	if (firstLine.length > MAX_NOTICE_TITLE_LENGTH) {
		return { title: fallbackTitle, description: trimmed };
	}
	return rest ? { title: firstLine, description: rest } : { title: firstLine };
}

const SEVERITY_TITLES: Record<SessionNoticeSeverity, string> = {
	info: "Notice",
	warning: "Warning",
	error: "Error",
};

/** A notice from free-form text, as an extension's `ui.notify` sends it. */
export function textNotice(text: string, severity: SessionNoticeSeverity = "info"): SessionNotice {
	return { severity, ...splitNoticeText(text, SEVERITY_TITLES[severity]) };
}

/**
 * The notice an `AgentSession` event carries, if any. `config_warnings_changed`
 * is not mapped here: it names no warning, so the caller diffs
 * `session.configWarnings` against what it already sent (see
 * {@link newConfigWarningNotices}). Auto-compaction failures are reported by
 * the compaction lifecycle, not as notices.
 */
export function mapSessionNoticeEvent(event: AgentSessionEvent): SessionNotice | undefined {
	switch (event.type) {
		case "notice":
			// Same source prefix as the TUI's status line.
			return textNotice(event.source ? `${event.source}: ${event.message}` : event.message, event.level);
		case "auto_retry_start":
			return {
				severity: "info",
				title: `Retrying (${event.attempt}/${event.maxAttempts})`,
				...(event.errorMessage ? { description: noticePlainText(event.errorMessage).trim() } : {}),
			};
		case "auto_retry_end":
			if (event.success) return undefined;
			return {
				severity: "error",
				title: `Retry failed after ${event.attempt} ${event.attempt === 1 ? "attempt" : "attempts"}`,
				...(event.finalError ? { description: noticePlainText(event.finalError).trim() } : {}),
			};
		case "retry_fallback_applied":
			return {
				severity: "warning",
				title: `Fallback: ${event.from} -> ${event.to}`,
				...(event.reason ? { description: noticePlainText(event.reason).trim() } : {}),
			};
		case "retry_fallback_succeeded":
			return { severity: "info", title: `Fallback model ${event.model} responded` };
		default:
			return undefined;
	}
}

/**
 * Warning notices for the config warnings not sent yet; records them in
 * `sent`, so a warning reaches the client once per session.
 */
export function newConfigWarningNotices(warnings: readonly string[], sent: Set<string>): SessionNotice[] {
	const notices: SessionNotice[] = [];
	for (const warning of warnings) {
		if (sent.has(warning)) continue;
		sent.add(warning);
		notices.push({ severity: "warning", ...splitNoticeText(warning, "Configuration warning") });
	}
	return notices;
}
