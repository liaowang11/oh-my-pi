/**
 * `omp figure`: draw a figure the TUI draws, for another front end.
 *
 * - `mermaid`: one diagram's source in, its ASCII/Unicode art out, laid out to
 *   fit `width` the way the TUI picks a layout.
 * - `math`: a batch of LaTeX math as JSON lines (`{"src", "display"?}`), one
 *   JSON line out per input line in the same order: `{"text"}` or `{"error"}`.
 *   Display math gets the 2-D layout; inline math stays on one line. Colors
 *   (`\textcolor`) arrive as SGR escapes.
 *
 * Pure: the command wrapper owns stdin/stdout, so tests call this directly.
 */
import { latexToBlock } from "@oh-my-pi/pi-tui/latex-block";
import { latexToUnicode } from "@oh-my-pi/pi-tui/latex-to-unicode";
import { resolveMermaidAscii } from "@oh-my-pi/pi-tui/theme/mermaid-cache";

export type FigureKind = "mermaid" | "math";

export interface FigureOptions {
	kind: FigureKind;
	input: string;
	/** Maximum columns for a mermaid layout. Omitted keeps the authored layout. */
	width?: number;
}

export interface FigureResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export function renderFigure(options: FigureOptions): FigureResult {
	return options.kind === "mermaid" ? renderMermaid(options.input, options.width) : renderMath(options.input);
}

function renderMermaid(source: string, width: number | undefined): FigureResult {
	const art = resolveMermaidAscii(source, width === undefined ? undefined : { maxWidth: width });
	if (art === null) return { exitCode: 1, stdout: "", stderr: "omp figure: cannot render this mermaid diagram\n" };
	return { exitCode: 0, stdout: art.endsWith("\n") ? art : `${art}\n`, stderr: "" };
}

function renderMath(input: string): FigureResult {
	const out: string[] = [];
	for (const line of input.split("\n")) {
		if (line.trim() === "") continue;
		out.push(JSON.stringify(renderMathItem(line)));
	}
	return { exitCode: 0, stdout: out.length > 0 ? `${out.join("\n")}\n` : "", stderr: "" };
}

function renderMathItem(line: string): { text: string } | { error: string } {
	let item: unknown;
	try {
		item = JSON.parse(line);
	} catch {
		return { error: "invalid JSON line" };
	}
	if (typeof item !== "object" || item === null || typeof (item as { src?: unknown }).src !== "string") {
		return { error: 'invalid item: expected {"src": string, "display"?: boolean}' };
	}
	const { src, display } = item as { src: string; display?: unknown };
	return { text: display === true ? latexToBlock(src).join("\n") : latexToUnicode(src) };
}
