import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { renderFigure } from "../src/cli/figure-cli";

const CLI = path.join(import.meta.dir, "..", "src", "cli.ts");

describe("omp figure", () => {
	it("draws a mermaid flowchart as box art, picking a layout that fits the width", () => {
		const source = "graph LR\n  A --> B --> C --> D --> E";
		const wide = renderFigure({ kind: "mermaid", input: source, width: 200 });
		const narrow = renderFigure({ kind: "mermaid", input: source, width: 20 });
		expect(wide.exitCode).toBe(0);
		expect(wide.stdout).toContain("►");
		expect(wide.stdout).toMatch(/│ A ├/);
		// LR at 200 columns stays one row of boxes; at 20 it is redrawn top-down.
		const widest = (text: string) => Math.max(...text.split("\n").map(line => Bun.stringWidth(line)));
		expect(widest(narrow.stdout)).toBeLessThan(widest(wide.stdout));
		expect(widest(narrow.stdout)).toBeLessThanOrEqual(20);
	});

	it("fails with a message for a diagram type the renderer cannot draw", () => {
		const result = renderFigure({ kind: "mermaid", input: 'pie\n  "a": 1' });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("cannot render");
	});

	it("renders a batch of math as one JSON line per input line, in order", () => {
		const input = [
			JSON.stringify({ src: "\\frac{a}{b}", display: true }),
			JSON.stringify({ src: "x_i + \\frac12" }),
			"not json",
		].join("\n");
		const result = renderFigure({ kind: "math", input });
		expect(result.exitCode).toBe(0);
		const lines = result.stdout
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(lines).toHaveLength(3);
		// Display math is a 2-D stack: numerator, bar, denominator.
		expect(lines[0].text.split("\n")).toEqual([" a ", "───", " b "]);
		// Inline math stays on one line.
		expect(lines[1].text).toBe("xᵢ + ½");
		expect(lines[2].error).toContain("invalid");
	});

	it("runs through the CLI on stdin", async () => {
		const proc = Bun.spawn([process.execPath, CLI, "figure", "mermaid", "--width", "80"], {
			stdin: new TextEncoder().encode("graph LR\n  A --> B"),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/│ A ├─+►│ B │/);
	}, 30_000);
});
