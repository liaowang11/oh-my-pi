/**
 * Draw a mermaid diagram or LaTeX math the way the TUI does, for other front ends.
 */
import { postmortem } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { figureHelp as commandHelp } from "../cli/command-help";
import { type FigureKind, renderFigure } from "../cli/figure-cli";
import { CliUsageError } from "../cli/usage-error";

export default class Figure extends Command {
	static description = commandHelp.description;
	static args = {
		kind: Args.string({
			description: "mermaid: diagram source on stdin; math: JSON lines {src, display?} on stdin",
			required: true,
			options: ["mermaid", "math"],
		}),
	};
	static flags = {
		width: Flags.integer({ char: "w", description: "Maximum columns for a mermaid layout" }),
	};

	static examples = [
		"printf 'graph LR\\n  A --> B' | omp figure mermaid -w 80",
		`echo '{"src":"\\\\frac{a}{b}","display":true}' | omp figure math`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Figure);
		if (flags.width !== undefined && flags.width <= 0) throw new CliUsageError("--width must be a positive integer");
		const result = renderFigure({
			kind: args.kind as FigureKind,
			input: await Bun.stdin.text(),
			width: flags.width,
		});
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		await postmortem.quit(result.exitCode);
	}
}
