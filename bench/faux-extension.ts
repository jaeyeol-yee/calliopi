// Pi extension for benchmark smoke runs: registers the `faux/bench` model, which plays the calls listed
// in the JSON file named by $BENCH_FAUX in order, so the runner, oracle and report can be checked with
// no API key and no cost. Loaded only by bench/run.ts (pi -e) for faux/* arms.
//
//   [{ "tool": "edit", "args": { "path": "src/greet.js", "edits": [ … ] } }, { "text": "Fixed." }]
//
// A tool call ends a model call (the tool result starts the next); a text ends the turn.
import fs from 'node:fs';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type Call = { text: string } | { tool: string; args?: Record<string, unknown> };

export default function (pi: ExtensionAPI) {
  const file = process.env.BENCH_FAUX;
  const calls: Call[] = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'bench', name: 'bench', reasoning: false }] });
  faux.setResponses(Array.from({ length: calls.length + 1 }, (_, i) => () => {
    const c = calls[i];
    if (!c) return fauxAssistantMessage('(no more scripted calls)');
    if ('tool' in c) return fauxAssistantMessage([fauxToolCall(c.tool, (c.args ?? {}) as Parameters<typeof fauxToolCall>[1])], { stopReason: 'toolUse' });
    return fauxAssistantMessage([fauxText(c.text)], { stopReason: 'stop' });
  }));
  pi.registerProvider(faux.provider);
}
