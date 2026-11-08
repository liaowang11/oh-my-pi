import type { ImageContent } from "@oh-my-pi/pi-ai";
import { dispatchBackgroundTan } from "../../session/background-tan";
import type { InteractiveModeContext } from "../types";

export class TanCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	/** Dispatch `work` to a background clone of this session; resolves `false` when nothing was dispatched. */
	async start(work: string, images?: ImageContent[]): Promise<boolean> {
		const result = await dispatchBackgroundTan(work, {
			session: this.ctx.session,
			sessionManager: this.ctx.sessionManager,
			settings: this.ctx.settings,
			mcpManager: this.ctx.mcpManager,
			images,
		});
		if (result.status === "usage") {
			this.ctx.showStatus(result.message);
			return false;
		}
		if (result.status === "error") {
			this.ctx.showError(result.message);
			return false;
		}
		if (!result.wasStreaming) this.ctx.rebuildChatFromMessages();
		this.ctx.showStatus(`Dispatched background tan ${result.jobId}`);
		return true;
	}
}
