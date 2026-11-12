// Result of one program run inside an overlay pane.
export interface PtyRunResult {
  exitCode: number;
  signal?: number;
  stopped?: boolean;
}

export type RunProgram = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<PtyRunResult>;
