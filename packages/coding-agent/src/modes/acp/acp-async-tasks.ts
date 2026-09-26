/**
 * Relays omp background jobs (bash/eval) to the client through the JetBrains
 * AIR `asyncTasks` ACP extension: `async_task_spawned` once a job runs in the
 * background, throttled `async_task_progress`, then one terminal
 * `async_task_state_update`. The client stops a task with
 * {@link ASYNC_TASK_STOP_METHOD}. Wire shapes match claude-agent-acp.
 *
 * `task` jobs are skipped: subagents already reach the client as child
 * sessions through `AcpSubagentRelay`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { RequestError, type AsyncTaskState, type SessionNotification } from "@oh-my-pi/pi-utils/acp";
import type { AsyncJob, AsyncJobChangeEvent, AsyncJobManager } from "../../async/job-manager";

/** Extension method: stop one background task without cancelling the prompt turn. */
export const ASYNC_TASK_STOP_METHOD = "_session/async_task/stop";

/** Params of an {@link ASYNC_TASK_STOP_METHOD} request. */
export type AsyncTaskStopRequest = { sessionId: string; asyncTaskId: string };

/** Minimum gap between two progress updates for the same task. */
export const ASYNC_TASK_PROGRESS_THROTTLE_MS = 500;
const SUMMARY_MAX_WIDTH = 200;

/** Validate raw JSON-RPC params into an {@link AsyncTaskStopRequest}. */
export function parseAsyncTaskStopRequest(params: { [key: string]: unknown }): AsyncTaskStopRequest {
	const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
	const asyncTaskId = typeof params.asyncTaskId === "string" ? params.asyncTaskId.trim() : "";
	if (!sessionId) {
		throw RequestError.invalidParams(undefined, "async task stop params require a non-empty sessionId");
	}
	if (!asyncTaskId) {
		throw RequestError.invalidParams(undefined, "async task stop params require a non-empty asyncTaskId");
	}
	return { sessionId, asyncTaskId };
}

export interface AcpAsyncTaskRelayOptions {
	sessionId: string;
	manager: AsyncJobManager;
	/** Registry id of the session's agent; only jobs it owns are relayed. */
	ownerId: string | undefined;
	send: (notification: SessionNotification) => Promise<void>;
}

type AnnouncedTask = {
	toolCallId: string | undefined;
	outputFilePath: string | undefined;
	terminal: boolean;
	lastProgressAt: number;
	lastSummary: string | undefined;
	pendingSummary: string | undefined;
	timer: NodeJS.Timeout | undefined;
};

const TERMINAL_STATE: Record<Exclude<AsyncJob["status"], "running">, AsyncTaskState> = {
	completed: "completed",
	failed: "failed",
	cancelled: "stopped",
};

export class AcpAsyncTaskRelay {
	readonly #options: AcpAsyncTaskRelayOptions;
	readonly #announced = new Map<string, AnnouncedTask>();
	// Foreground jobs released while still running: never announced.
	readonly #released = new Set<string>();
	readonly #backgroundedToolCalls = new Set<string>();
	#unsubscribe: (() => void) | undefined;
	#chain: Promise<void> = Promise.resolve();

	constructor(options: AcpAsyncTaskRelayOptions) {
		this.#options = options;
		this.#unsubscribe = options.manager.onJobChange(event => this.#onChange(event));
	}

	/** Resolves once every notification queued so far has been delivered. */
	flush(): Promise<void> {
		return this.#chain;
	}

	/**
	 * True once a job started by `toolCallId` has been announced. Membership is
	 * recorded synchronously at announce time, before the spawn is delivered, so
	 * a `tool_call_update` forwarded right after the tool returns is stamped.
	 */
	isBackgroundedToolCall(toolCallId: string): boolean {
		return this.#backgroundedToolCalls.has(toolCallId);
	}

	/** Whether the client may stop `asyncTaskId`: an announced task not yet terminal. */
	canStop(asyncTaskId: string): boolean {
		const task = this.#announced.get(asyncTaskId);
		return task !== undefined && !task.terminal;
	}

	/**
	 * Stop relaying. Announced tasks still running are closed with `stopped`
	 * first: the session that owned them is going away (close/shutdown cancels
	 * its jobs after this), and the client must not keep a running card
	 * forever. Sends still queue on the chain, so a failing connection only logs.
	 */
	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const [jobId, task] of this.#announced) {
			if (!task.terminal) this.#publishTerminal(jobId, task, "stopped", undefined);
		}
		this.#announced.clear();
		this.#released.clear();
		this.#backgroundedToolCalls.clear();
	}

	#onChange(event: AsyncJobChangeEvent): void {
		const { job } = event;
		if (job.ownerId !== this.#options.ownerId || job.type === "task") return;
		switch (event.kind) {
			case "registered":
				// A reused id is a new job: drop any state left by the previous one.
				this.#forget(job.id);
				// Foreground-backed jobs wait for `backgrounded` (or `released`).
				if (!job.foreground) this.#announce(job);
				return;
			case "backgrounded":
				this.#announce(job);
				return;
			case "released":
				// A job released after it settled is discarded at once and emits
				// nothing more; only a still-running one needs remembering.
				if (job.endTime === undefined) this.#released.add(job.id);
				return;
			case "progress":
				this.#onProgress(job, event.text);
				return;
			case "output_file":
				this.#onOutputFile(job);
				return;
			case "cancelled":
				// Report the stop now; the body's later `settled` is then ignored.
				this.#publishTerminalFor(job, "stopped", undefined);
				return;
			case "settled":
				if (this.#released.delete(job.id) || job.status === "running") return;
				this.#publishTerminalFor(job, TERMINAL_STATE[job.status], terminalSummary(job));
				return;
		}
	}

	#forget(jobId: string): void {
		const task = this.#announced.get(jobId);
		if (task?.timer) clearTimeout(task.timer);
		this.#announced.delete(jobId);
		this.#released.delete(jobId);
	}

	#announce(job: AsyncJob): void {
		if (this.#announced.has(job.id) || this.#released.has(job.id)) return;
		this.#announced.set(job.id, {
			toolCallId: job.toolCallId,
			outputFilePath: job.outputFilePath,
			terminal: false,
			lastProgressAt: 0,
			lastSummary: undefined,
			pendingSummary: undefined,
			timer: undefined,
		});
		if (job.toolCallId) this.#backgroundedToolCalls.add(job.toolCallId);
		this.#enqueue({
			sessionId: this.#options.sessionId,
			update: {
				sessionUpdate: "async_task_spawned",
				asyncTaskId: job.id,
				name: job.label,
				taskType: job.type === "bash" ? "shell" : job.type,
				description: job.label,
				// Per-type choice, to confirm against the JetBrains client: a bash job
				// already has its own tool_call card in the transcript, an eval cell
				// promoted to the background does not render one worth keeping.
				showInTranscript: job.type === "eval",
				canStop: true,
				...(job.outputFilePath ? { outputFilePath: job.outputFilePath } : {}),
				...(job.toolCallId ? { toolCallId: job.toolCallId } : {}),
			},
		});
		// Auto-background promotion can race completion: the job may already be
		// terminal by the time it is promoted.
		if (job.status !== "running") {
			this.#publishTerminalFor(
				job,
				TERMINAL_STATE[job.status],
				job.endTime === undefined ? undefined : terminalSummary(job),
			);
		}
	}

	#publishTerminalFor(job: AsyncJob, state: AsyncTaskState, summary: string | undefined): void {
		const task = this.#announced.get(job.id);
		if (task) this.#publishTerminal(job.id, task, state, summary);
	}

	#onProgress(job: AsyncJob, text: string | undefined): void {
		const task = this.#announced.get(job.id);
		if (!task || task.terminal || job.status !== "running") return;
		const summary = text === undefined ? undefined : summarizeLine(lastNonEmptyLine(text));
		if (!summary || summary === (task.pendingSummary ?? task.lastSummary)) return;
		const elapsed = Date.now() - task.lastProgressAt;
		if (!task.timer && elapsed >= ASYNC_TASK_PROGRESS_THROTTLE_MS) {
			this.#sendProgress(job.id, task, summary);
			return;
		}
		task.pendingSummary = summary;
		task.timer ??= setTimeout(() => {
			task.timer = undefined;
			this.#flushPendingProgress(job.id, task);
		}, ASYNC_TASK_PROGRESS_THROTTLE_MS - elapsed);
	}

	/**
	 * A metadata-only progress update: the durable output path became known
	 * (bash learns it only once the sink has actually written the file). Bypasses
	 * the summary throttle; the terminal edge repeats the path so a client that
	 * joins late still sees it.
	 */
	#onOutputFile(job: AsyncJob): void {
		const task = this.#announced.get(job.id);
		if (!task || task.terminal || !job.outputFilePath || task.outputFilePath === job.outputFilePath) return;
		task.outputFilePath = job.outputFilePath;
		this.#enqueue({
			sessionId: this.#options.sessionId,
			update: {
				sessionUpdate: "async_task_progress",
				asyncTaskId: job.id,
				outputFilePath: task.outputFilePath,
				...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
			},
		});
	}

	#flushPendingProgress(jobId: string, task: AnnouncedTask): void {
		const summary = task.pendingSummary;
		task.pendingSummary = undefined;
		if (summary === undefined || task.terminal) return;
		this.#sendProgress(jobId, task, summary);
	}

	#sendProgress(jobId: string, task: AnnouncedTask, summary: string): void {
		task.lastProgressAt = Date.now();
		task.lastSummary = summary;
		this.#enqueue({
			sessionId: this.#options.sessionId,
			update: {
				sessionUpdate: "async_task_progress",
				asyncTaskId: jobId,
				summary,
				...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
			},
		});
	}

	#publishTerminal(jobId: string, task: AnnouncedTask, state: AsyncTaskState, summary: string | undefined): void {
		if (task.terminal) return;
		if (task.timer) {
			clearTimeout(task.timer);
			task.timer = undefined;
		}
		this.#flushPendingProgress(jobId, task);
		task.terminal = true;
		this.#enqueue({
			sessionId: this.#options.sessionId,
			update: {
				sessionUpdate: "async_task_state_update",
				asyncTaskId: jobId,
				state,
				...(summary ? { summary } : {}),
				...(task.outputFilePath ? { outputFilePath: task.outputFilePath } : {}),
				...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
			},
		});
	}

	// Change events arrive synchronously in order; deliver on one chain so the
	// wire keeps that order.
	#enqueue(notification: SessionNotification): void {
		this.#chain = this.#chain.then(async () => {
			try {
				await this.#options.send(notification);
			} catch (error) {
				logger.warn("Failed to relay ACP async task update", {
					sessionId: notification.sessionId,
					update: notification.update.sessionUpdate,
					error: String(error),
				});
			}
		});
	}
}

function terminalSummary(job: AsyncJob): string | undefined {
	const text = job.status === "failed" ? job.errorText : (job.resultText ?? job.errorText);
	return text === undefined ? undefined : summarizeLine(firstNonEmptyLine(text));
}

function firstNonEmptyLine(text: string): string | undefined {
	for (const line of text.split("\n")) {
		if (line.trim()) return line;
	}
	return undefined;
}

function lastNonEmptyLine(text: string): string | undefined {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim()) return lines[i];
	}
	return undefined;
}

function summarizeLine(line: string | undefined): string | undefined {
	const trimmed = line?.trim();
	return trimmed ? truncateToWidth(trimmed, SUMMARY_MAX_WIDTH) : undefined;
}
