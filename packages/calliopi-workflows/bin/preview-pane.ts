// Entry point of the /cl-preview side pane: node preview-pane.ts <config.json>.
// Started by the extension in a multiplexer pane; the pane closes when this exits.
import fs from 'node:fs';
import { runPane, markClosed, type PaneConfig } from '#lib/preview-pane.ts';

const configPath = process.argv[2];
if (!configPath) { process.stderr.write('usage: preview-pane.ts <config.json>\n'); process.exit(2); }
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as PaneConfig;
process.title = 'cl-preview';
try { await runPane(config); }
catch (error) {
  process.stderr.write(`cl-preview: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally { markClosed(config.dir); }
