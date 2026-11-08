/**
 * Host-independent `/loop` state, shared by the interactive TUI and ACP.
 *
 * Hosts own scheduling (when an iteration may start, how the prompt is
 * re-submitted, what suspends the loop); this module owns the loop's state and
 * the per-iteration gate: budget, then the `--while`/`--until` condition.
 */
import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import { describeLoopCondition, evaluateLoopCondition } from "./loop-condition";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	describeLoopLimitRuntime,
	isLoopLimitExhausted,
	type LoopLimitConfig,
} from "./loop-limit";

/** Outcome of {@link LoopModeState.checkIteration}. */
export type LoopGateVerdict =
	/** Run the next iteration. */
	| { kind: "continue" }
	/** The loop is over; `message` says why. The caller disables the loop. */
	| { kind: "stop"; message: string }
	/** The condition command was aborted (the loop was suspended or disabled meanwhile). */
	| { kind: "aborted" };

export interface LoopGateOptions {
	cwd: string;
	sessionId: string;
	isSessionCurrent?: () => boolean;
	/** Deadline for one condition evaluation (`loop.conditionTimeoutMs`). */
	timeoutMs: number;
}

export class LoopModeState {
	enabled = false;
	/** Suspended: the loop stays enabled but waits for a new prompt. */
	paused = false;
	/** The prompt re-submitted after each yield; unset until the user sends one. */
	prompt: string | undefined = undefined;
	limit: LoopLimitRuntime | undefined = undefined;
	condition: LoopConditionConfig | undefined = undefined;
	#conditionAbort: AbortController | undefined;

	enable(limit: LoopLimitConfig | undefined, condition: LoopConditionConfig | undefined): void {
		this.enabled = true;
		this.paused = false;
		this.prompt = undefined;
		this.limit = createLoopLimitRuntime(limit);
		this.condition = condition;
	}

	/** Turn the loop off; returns whether it was on. */
	disable(): boolean {
		const wasEnabled = this.enabled;
		this.enabled = false;
		this.paused = false;
		this.prompt = undefined;
		this.limit = undefined;
		this.condition = undefined;
		this.abortCondition();
		return wasEnabled;
	}

	/**
	 * Suspend without disabling: drop the captured prompt and any running
	 * condition. The next prompt the user sends becomes the new loop prompt.
	 */
	pause(): void {
		this.prompt = undefined;
		this.paused = true;
		this.abortCondition();
	}

	/**
	 * Record a user-sent prompt as the loop prompt. Any condition still checking
	 * the previous iteration is aborted: that iteration is superseded either way.
	 */
	setPrompt(prompt: string): void {
		if (!this.enabled) return;
		this.abortCondition();
		this.prompt = prompt;
		this.paused = false;
	}

	abortCondition(): void {
		this.#conditionAbort?.abort();
		this.#conditionAbort = undefined;
	}

	/**
	 * Decide whether the next iteration runs, without spending budget. An
	 * exhausted budget stops the loop before the condition command runs, so the
	 * command never runs once more for a loop that is already over. The
	 * condition is a continuation signal: callers check it only after the first
	 * iteration. The command is an await point; callers re-check that the loop
	 * is still current before acting on the verdict.
	 */
	async checkIteration(options: LoopGateOptions): Promise<LoopGateVerdict> {
		if (isLoopLimitExhausted(this.limit)) return { kind: "stop", message: "Loop limit reached. Loop mode disabled." };
		const condition = this.condition;
		if (!condition) return { kind: "continue" };
		// A prior evaluation can still be in flight when the next iteration
		// starts; drop it instead of leaking a child process nothing can reach.
		this.abortCondition();
		const controller = new AbortController();
		this.#conditionAbort = controller;
		try {
			const verdict = await evaluateLoopCondition(condition, { ...options, signal: controller.signal });
			if (verdict.kind === "halt" || verdict.kind === "error") return { kind: "stop", message: verdict.message };
			return verdict;
		} finally {
			if (this.#conditionAbort === controller) this.#conditionAbort = undefined;
		}
	}

	/** Spend one iteration of the budget; false when none is left. */
	consumeIteration(): boolean {
		return consumeLoopLimitIteration(this.limit);
	}

	/**
	 * The "Loop mode enabled." notice for a just-enabled loop. `suspendHint`
	 * names the host's way to suspend it (a key in the TUI, cancel in ACP).
	 */
	describeEnabled(limit: LoopLimitConfig | undefined, hasPrompt: boolean, suspendHint: string): string {
		const limitSuffix = limit ? ` Limited to ${describeLoopLimit(limit)}.` : "";
		const remainingSuffix = this.limit ? ` ${describeLoopLimitRuntime(this.limit)}.` : "";
		const conditionSuffix = this.condition ? ` Continuing ${describeLoopCondition(this.condition)}.` : "";
		const tail = hasPrompt ? "Repeating it after each turn." : "Your next prompt will repeat after each turn.";
		return `Loop mode enabled.${limitSuffix}${remainingSuffix}${conditionSuffix} ${tail} ${suspendHint} suspends the ongoing loop; /loop again to disable.`;
	}
}
