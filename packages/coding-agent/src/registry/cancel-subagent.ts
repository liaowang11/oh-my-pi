import type { AgentSession } from "../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import { AgentLifecycleManager } from "./agent-lifecycle";
import { type AgentRef, AgentRegistry } from "./agent-registry";

/** A running subagent bound to its live registry ref. */
export interface LiveSubagent {
	ref: AgentRef;
	session: AgentSession;
}

/**
 * The running, live registry ref of subagent `id`, or `undefined` when it is
 * unknown, finished, accepted, parked, aborted, or another session's agent.
 *
 * Agent ids are unique only within one parent session's artifacts scope, and
 * the process-global registry keeps the latest ref per id, so the ref must
 * carry the transcript file the caller recorded for its own subagent
 * (`<artifactsDir>/<id>.jsonl`). The ref must also still be `running`: it goes
 * `idle` once the parent accepts its result, and a running ref always holds a
 * live session.
 */
export function resolveLiveSubagent(id: string, sessionFile: string): LiveSubagent | undefined {
	const ref = AgentRegistry.global().get(id);
	if (ref?.kind !== "sub" || ref.status !== "running" || !ref.session || ref.sessionFile !== sessionFile) {
		return undefined;
	}
	return { ref, session: ref.session };
}

/**
 * Hard-kill one running subagent through the same path as the Agent Hub /
 * collab `kill` command. Aborting the live turn and releasing the registry ref
 * as an `aborted` tombstone settles the owning `task` call (foreground or
 * background) with an aborted result, and disposing the session cancels its
 * nested children.
 *
 * Returns `false` (a no-op) unless {@link resolveLiveSubagent} finds the
 * subagent, so cancelling a vanished subagent counts as success. Rejects when
 * the tombstone cannot be persisted or the abort fails; the subagent is still
 * detached and disposed.
 */
export async function cancelLiveSubagent(id: string, sessionFile: string): Promise<boolean> {
	const live = resolveLiveSubagent(id, sessionFile);
	if (!live) return false;
	// Start the release first: it publishes the `aborted` tombstone synchronously,
	// so the executor cannot accept the run's result (flipping the ref to idle)
	// while the abort below is still settling. Settle both together so a failed
	// tombstone write is reported here instead of escaping as an unhandled
	// rejection while the abort is pending.
	const [released, aborted] = await Promise.allSettled([
		AgentLifecycleManager.global().release(id, live.ref, { tombstone: true }),
		live.session.abort({ reason: USER_INTERRUPT_LABEL }),
	]);
	if (released.status === "rejected") throw released.reason;
	if (aborted.status === "rejected") throw aborted.reason;
	return released.value;
}
