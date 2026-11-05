import { sanitizeText } from "@oh-my-pi/pi-utils";
import { Text } from "../components/text";
import { renderStatusLine } from "../render/index";
import {
	createCachedComponent,
	formatMoreItems,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenEmbeddedPaths,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import type { Theme } from "../theme/theme";
import type { Component } from "../tui";
import type { RenderResultOptions, ToolRenderResult } from "./renderer";

/** A scheduled prompt job as the cron tools report it. */
export interface CronJob {
	id: string;
	expression: string;
	prompt: string;
	recurring: boolean;
	durable: boolean;
	createdAt: number;
	expiresAt?: number;
	nextFireAt: number;
}

/** Cron tool result payloads: the created job, the job list, or a delete outcome. */
export type CronToolDetails = CronJob | { jobs: CronJob[] } | { deleted: boolean };

type CronRenderOperation = "create" | "list" | "delete";

interface CronRenderArgs {
	expression?: string;
	prompt?: string;
	recurring?: boolean;
	durable?: boolean;
	id?: string;
}

/** One display line: control sequences stripped, tabs expanded, newlines folded. */
export function cronDisplayLine(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/[\r\n]+/g, " ");
}

function cronTitle(text: string): string {
	return truncateToWidth(shortenEmbeddedPaths(cronDisplayLine(text)), TRUNCATE_LENGTHS.TITLE);
}

function isCronJob(details: CronToolDetails | undefined): details is CronJob {
	return details !== undefined && "expression" in details;
}

function cronMode(job: CronJob): string[] {
	const mode = [job.recurring ? "recurring" : "one-shot", job.durable ? "durable" : "session-only"];
	if (job.expiresAt !== undefined) mode.push(`expires ${new Date(job.expiresAt).toLocaleString()}`);
	return mode;
}

function cronJobRow(job: CronJob, theme: Theme): string {
	return [
		theme.fg("accent", cronDisplayLine(job.expression)),
		theme.fg("dim", cronDisplayLine(job.id)),
		theme.fg("dim", truncateToWidth(shortenEmbeddedPaths(cronDisplayLine(job.prompt)), TRUNCATE_LENGTHS.CONTENT)),
		theme.fg("dim", `next ${new Date(job.nextFireAt).toLocaleString()}`),
		...cronMode(job).map(value => theme.fg("dim", value)),
	].join(theme.sep.dot);
}

function createCronRenderer(op: CronRenderOperation) {
	return {
		inline: true,
		mergeCallAndResult: true,
		renderCall(args: CronRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
			const meta =
				op === "create"
					? [
							args.recurring === false ? "one-shot" : "recurring",
							args.durable === true ? "durable" : "session-only",
						]
					: [];
			const header = renderStatusLine(
				{
					icon: "pending",
					title: `Cron ${op}`,
					description:
						op === "create"
							? cronTitle(args.expression ?? "")
							: op === "delete"
								? cronTitle(args.id ?? "")
								: undefined,
					meta,
				},
				theme,
			);
			return new Text(header, 1, 0);
		},
		renderResult(
			result: ToolRenderResult<CronToolDetails>,
			options: RenderResultOptions,
			theme: Theme,
			args?: CronRenderArgs,
		): Component {
			const details = result.details;
			const text = result.content
				.filter(part => part.type === "text")
				.map(part => part.text ?? "")
				.join("\n")
				.trim();
			const body: string[] = [];
			let description =
				op === "create"
					? cronTitle(args?.expression ?? "")
					: op === "delete"
						? cronTitle(args?.id ?? "")
						: undefined;
			let meta: string[] = [];
			let icon: "error" | "warning" | undefined;

			if (result.isError) {
				icon = "error";
				body.push(
					theme.fg(
						"error",
						truncateToWidth(
							shortenEmbeddedPaths(cronDisplayLine(text || "Unknown error")),
							TRUNCATE_LENGTHS.CONTENT,
						),
					),
				);
			} else if (op === "create" && isCronJob(details)) {
				description = truncateToWidth(cronDisplayLine(details.expression), TRUNCATE_LENGTHS.TITLE);
				meta = [theme.fg("dim", `next ${new Date(details.nextFireAt).toLocaleString()}`), ...cronMode(details)];
				body.push(
					`${theme.fg("accent", cronDisplayLine(details.id))} ${theme.fg("dim", shortenEmbeddedPaths(cronDisplayLine(details.prompt)))}`,
				);
			} else if (op === "list" && details && "jobs" in details) {
				description = `${details.jobs.length} ${details.jobs.length === 1 ? "job" : "jobs"}`;
				body.push(...details.jobs.map(job => cronJobRow(job, theme)));
			} else if (op === "delete" && details && "deleted" in details) {
				meta = [details.deleted ? theme.fg("success", "deleted") : theme.fg("warning", "not found")];
				if (!details.deleted) icon = "warning";
			} else if (text) {
				body.push(theme.fg("toolOutput", cronDisplayLine(text)));
			}

			const header = renderStatusLine(
				{
					...(icon ? { icon } : { iconOverride: theme.styledSymbol("status.done", "accent") }),
					title: `Cron ${op}`,
					description,
					meta,
				},
				theme,
			);

			return createCachedComponent(
				() => options.expanded,
				(width, expanded) => {
					let visible = body;
					if (!expanded && body.length > PREVIEW_LIMITS.COLLAPSED_ITEMS) {
						const remaining = body.length - PREVIEW_LIMITS.COLLAPSED_ITEMS;
						visible = [
							...body.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS),
							theme.fg("dim", formatMoreItems(remaining, "job")),
						];
					}
					return [header, ...visible].map(line => truncateToWidth(line, width));
				},
				{ paddingX: 1 },
			);
		},
	};
}

export const cronCreateToolRenderer = createCronRenderer("create");
export const cronListToolRenderer = createCronRenderer("list");
export const cronDeleteToolRenderer = createCronRenderer("delete");
