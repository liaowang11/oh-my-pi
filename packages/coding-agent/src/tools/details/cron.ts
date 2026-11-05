import { sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs } from "../../utils/text-width";

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

/** One display line: control sequences stripped, tabs expanded, newlines folded. */
export function cronDisplayLine(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/[\r\n]+/g, " ");
}
