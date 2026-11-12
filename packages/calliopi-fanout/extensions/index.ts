// Calliopi cloud fan-out — Pi extension entry point. Wiring only; the parts live in subdirectories
// (Pi discovers top-level *.ts and */index.ts here, so subdirectories must not contain index.ts):
//   runtime/     shared state, tracker CLI, registry watcher, floating mount, launch flow, session lifecycle
//   components/  TUI components (floating list, inspector overlay)
//   commands/    /calliopi-fanout
//   tools/       calliopi_fanout_* tools for the model
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRuntime } from "#extensions/runtime/state.ts";
import { registerSession } from "#extensions/runtime/session.ts";
import { registerCommand } from "#extensions/commands/fanout-command.ts";
import { registerTools } from "#extensions/tools/fanout-tools.ts";

export default function (pi: ExtensionAPI) {
	const rt = createRuntime(pi);
	registerSession(rt);
	registerCommand(rt);
	registerTools(rt);
}
