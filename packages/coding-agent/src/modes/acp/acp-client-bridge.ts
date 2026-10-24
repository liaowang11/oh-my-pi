/**
 * ACP-side `ClientBridge` implementation. Wraps `AgentSideConnection` so the
 * `read`/`write`/`bash`/`edit` tools (and the permission gate in
 * `AgentSession`) can route through the client when it advertises the
 * relevant capabilities at `initialize` time.
 */
import { RequestError } from "@oh-my-pi/pi-utils/acp";
import type {
	PermissionOption as AcpPermissionOption,
	TerminalHandle as AcpTerminalHandle,
	AgentSideConnection,
	ClientCapabilities,
	RequestPermissionRequest,
	RequestPermissionResponse,
	ToolCallUpdate,
} from "@oh-my-pi/pi-utils/acp";
import { AIR_EXTENSION_VERSION, AIR_PERMISSION_KEY, isAirClient, withAirMeta } from "./acp-air";
import type {
	ClientBridge,
	ClientBridgeCapabilities,
	ClientBridgeCreateTerminalParams,
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
	ClientBridgeTerminalHandle,
} from "../../session/client-bridge";

/** Observes `session/request_permission` requests while they await the client. */
export interface AcpPermissionObserver {
	onPermissionPending(): void;
	onPermissionSettled(): void;
}

export function createAcpClientBridge(
	connection: AgentSideConnection,
	sessionId: string,
	clientCapabilities: ClientCapabilities | undefined,
	permissionObserver?: AcpPermissionObserver,
): ClientBridge {
	const capabilities: ClientBridgeCapabilities = {
		readTextFile: clientCapabilities?.fs?.readTextFile === true,
		writeTextFile: clientCapabilities?.fs?.writeTextFile === true,
		terminal: clientCapabilities?.terminal === true,
		// Permission requests are always usable on the connection; gating is
		// the agent's policy choice rather than a client capability.
		requestPermission: true,
	};

	const bridge: ClientBridge = { capabilities, deferAgentInitiatedTurns: true };

	if (capabilities.readTextFile) {
		bridge.readTextFile = async params => {
			const response = await connection.readTextFile({
				sessionId,
				path: params.path,
				...(typeof params.line === "number" ? { line: params.line } : {}),
				...(typeof params.limit === "number" ? { limit: params.limit } : {}),
			});
			return response.content;
		};
	}

	if (capabilities.writeTextFile) {
		bridge.writeTextFile = async params => {
			await connection.writeTextFile({
				sessionId,
				path: params.path,
				content: params.content,
			});
		};
	}

	if (capabilities.terminal) {
		bridge.createTerminal = (params: ClientBridgeCreateTerminalParams) =>
			createTerminalHandle(connection, sessionId, params);
	}

	const airClient = isAirClient(clientCapabilities);
	bridge.requestPermission = (toolCall, options, signal, steeringSignal) =>
		requestPermission(
			connection,
			sessionId,
			toolCall,
			options,
			signal,
			steeringSignal,
			permissionObserver,
			airClient,
		);

	return bridge;
}

async function createTerminalHandle(
	connection: AgentSideConnection,
	sessionId: string,
	params: ClientBridgeCreateTerminalParams,
): Promise<ClientBridgeTerminalHandle> {
	const handle = await connection.createTerminal({
		sessionId,
		command: params.command,
		...(params.args ? { args: params.args } : {}),
		...(params.env ? { env: params.env } : {}),
		...(params.cwd ? { cwd: params.cwd } : {}),
		...(typeof params.outputByteLimit === "number" ? { outputByteLimit: params.outputByteLimit } : {}),
	});
	return wrapTerminalHandle(handle);
}

function wrapTerminalHandle(handle: AcpTerminalHandle): ClientBridgeTerminalHandle {
	return {
		terminalId: handle.id,
		async currentOutput() {
			const out = await handle.currentOutput();
			return {
				output: out.output,
				truncated: out.truncated,
				exitStatus: out.exitStatus ?? null,
			};
		},
		async waitForExit() {
			const status = await handle.waitForExit();
			return { exitCode: status.exitCode ?? null, signal: status.signal ?? null };
		},
		async kill() {
			await handle.kill();
		},
		async release() {
			await handle.release();
		},
	};
}

async function requestPermission(
	connection: AgentSideConnection,
	sessionId: string,
	toolCall: ClientBridgePermissionToolCall,
	options: ClientBridgePermissionOption[],
	signal: AbortSignal | undefined,
	steeringSignal: AbortSignal | undefined,
	observer: AcpPermissionObserver | undefined,
	airClient: boolean,
): Promise<ClientBridgePermissionOutcome> {
	const update: ToolCallUpdate = {
		toolCallId: toolCall.toolCallId,
		title: toolCall.title,
		...(toolCall.kind ? { kind: toolCall.kind as ToolCallUpdate["kind"] } : {}),
		...(toolCall.status ? { status: toolCall.status as ToolCallUpdate["status"] } : {}),
		...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
		...(toolCall.content ? { content: toolCall.content as ToolCallUpdate["content"] } : {}),
		...(toolCall.locations ? { locations: toolCall.locations } : {}),
	};
	const acpOptions: AcpPermissionOption[] = options.map(option => ({
		optionId: option.optionId,
		name: option.name,
		kind: option.kind,
	}));
	const request: RequestPermissionRequest = {
		sessionId,
		toolCall: update,
		options: acpOptions,
	};
	// Only AIR gets the presentation, in claude-agent-acp's shape: the reason as
	// a `Reason: ` description, and `defaultToNo` when a stray keystroke must not
	// approve.
	const presentation = toolCall.presentation;
	if (airClient && (presentation?.reason || presentation?.defaultToNo)) {
		request._meta = withAirMeta(undefined, AIR_PERMISSION_KEY, {
			version: AIR_EXTENSION_VERSION,
			title: toolCall.title,
			...(presentation.reason ? { description: `Reason: ${presentation.reason}` } : {}),
			...(presentation.defaultToNo ? { defaultToNo: true } : {}),
		});
	}
	if (signal?.aborted) {
		return { outcome: "cancelled" };
	}
	// A turn abort or a queued user steer supersedes the dialog: cancel the
	// pending wire request (`$/cancel_request`) so the client is not left with a
	// live dialog for a tool call the loop has already reported as cancelled.
	const { promise, cancel } = connection.requestPermissionWithCancel(request);
	observer?.onPermissionPending();
	const settleObserver = () => observer?.onPermissionSettled();
	const withdrawn = Promise.withResolvers<void>();
	const onWithdraw = () => {
		cancel();
		withdrawn.resolve();
	};
	if (signal?.aborted || steeringSignal?.aborted) {
		onWithdraw();
		// `cancel()` rejects the wire promise with request-cancelled, and
		// nothing else observes it on this early-exit path; keep it handled so
		// the rejection cannot take down the process.
		void promise.catch(() => undefined);
		settleObserver();
		return { outcome: "cancelled" };
	}
	signal?.addEventListener("abort", onWithdraw, { once: true });
	steeringSignal?.addEventListener("abort", onWithdraw, { once: true });
	try {
		const winner = await Promise.race([
			promise.then(
				response => ({ kind: "response" as const, response }),
				error =>
					// `cancel()` rejects the wire promise with
					// request-cancelled; that rejection is the withdrawal
					// superseding the dialog, not a transport failure.
					error instanceof RequestError && error.code === -32800
						? { kind: "withdrawn" as const }
						: { kind: "error" as const, error },
			),
			withdrawn.promise.then(() => ({ kind: "withdrawn" as const })),
		]);
		if (winner.kind === "withdrawn") {
			return { outcome: "cancelled" };
		}
		if (winner.kind === "error") {
			throw winner.error;
		}
		return permissionOutcomeFromResponse(winner.response, options);
	} finally {
		signal?.removeEventListener("abort", onWithdraw);
		steeringSignal?.removeEventListener("abort", onWithdraw);
		settleObserver();
	}
}

function permissionOutcomeFromResponse(
	response: RequestPermissionResponse,
	options: ClientBridgePermissionOption[],
): ClientBridgePermissionOutcome {
	const outcome = response.outcome;
	if (outcome.outcome === "cancelled") {
		return { outcome: "cancelled" };
	}
	const matched = options.find(option => option.optionId === outcome.optionId);
	return {
		outcome: "selected",
		optionId: outcome.optionId,
		...(matched ? { kind: matched.kind } : {}),
	};
}
