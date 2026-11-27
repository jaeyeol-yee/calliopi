// The benchmark's model catalog: only what Pi does not know. Prices, context windows and the effort
// levels a model accepts are read from the installed Pi at runtime (loadPi), so they never go stale
// here. A model's family and lineage (the same product line across versions) are facts; its tier is a
// hypothesis until a benchmark places it, and a newer version is not assumed to be better.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type Tier = 'flagship' | 'workhorse' | 'utility';

export interface CatalogModel {
  /** provider/id, as `pi --model` takes it. */
  id: string;
  family: string;
  /** The product line across versions; `order` ranks versions within it (higher is newer). */
  lineage: string;
  order: number;
  /** A guess to be replaced by measurement. */
  tier?: Tier;
  /** The oldest Pi whose catalog has the model. */
  minPi?: string;
}

const m = (id: string, family: string, lineage: string, order: number, tier?: Tier, minPi?: string): CatalogModel =>
  ({ id, family, lineage, order, ...(tier ? { tier } : {}), ...(minPi ? { minPi } : {}) });

export const CATALOG: CatalogModel[] = [
  m('anthropic/claude-fable-5', 'anthropic', 'claude-fable', 1, 'flagship'),
  m('anthropic/claude-fable-5-1', 'anthropic', 'claude-fable', 2, 'flagship'),
  m('anthropic/claude-fable-5-2', 'anthropic', 'claude-fable', 3, 'flagship'),
  m('anthropic/claude-opus-5', 'anthropic', 'claude-opus', 1, 'workhorse'),
  m('anthropic/claude-opus-5-5', 'anthropic', 'claude-opus', 2, 'workhorse'),
  m('anthropic/claude-sonnet-5', 'anthropic', 'claude-sonnet', 1, 'utility'),
  m('anthropic/claude-sonnet-5-5', 'anthropic', 'claude-sonnet', 2, 'utility'),
  m('anthropic/claude-haiku-4-5', 'anthropic', 'claude-haiku', 1),
  m('anthropic/claude-haiku-5-5', 'anthropic', 'claude-haiku', 2),
  m('openai/gpt-6-astra', 'openai', 'gpt-astra', 1, 'flagship'),
  m('openai/gpt-6.2-astra', 'openai', 'gpt-astra', 2, 'flagship', '1.6.0'),
  m('openai/gpt-5.6-sol', 'openai', 'gpt-sol', 1, 'workhorse'),
  m('openai/gpt-6-sol', 'openai', 'gpt-sol', 2, 'workhorse'),
  m('openai/gpt-6.1-sol', 'openai', 'gpt-sol', 3, 'workhorse'),
  m('openai/gpt-6.2-sol', 'openai', 'gpt-sol', 4, 'workhorse', '1.6.0'),
  m('openai/gpt-5.6-terra', 'openai', 'gpt-terra', 1, 'utility'),
  m('openai/gpt-6.1-terra', 'openai', 'gpt-terra', 2, 'utility'),
  m('openai/gpt-5.6-luna', 'openai', 'gpt-luna', 1),
  m('openai/gpt-6-luna', 'openai', 'gpt-luna', 2),
];

export const catalogModel = (id: string) => CATALOG.find(c => c.id === id);

/** Effort levels from least to most, as Pi names them. */
export const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const versionAtLeast = (version: string, min: string) => {
  const a = version.split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

export interface PiModel {
  id: string;
  contextWindow: number;
  /** Dollars per million tokens. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  efforts: string[];
}

export interface PiCatalog { version: string; source: string; get(id: string): PiModel | undefined }

/** The model catalog of the Pi that will run the benchmark: the managed install's current release, else this repository's dev dependency. */
export async function loadPi(env: NodeJS.ProcessEnv = process.env): Promise<PiCatalog> {
  const root = env.PI_MANAGED_INSTALL_ROOT ?? path.join(os.homedir(), '.pi', 'agent', 'install');
  let version = '', dist = '';
  try {
    version = fs.readFileSync(path.join(root, 'current-version'), 'utf8').trim();
    dist = path.join(root, 'releases', version, 'node_modules', '@earendil-works', 'pi-ai', 'dist');
    if (!fs.existsSync(path.join(dist, 'providers', 'all.js'))) dist = '';
  } catch { dist = ''; }
  type All = { getBuiltinModel(p: string, id: string): any };
  type Models = { getSupportedThinkingLevels(model: unknown): string[] };
  let all: All, models: Models, source: string;
  if (dist) {
    all = await import(pathToFileURL(path.join(dist, 'providers', 'all.js')).href);
    models = await import(pathToFileURL(path.join(dist, 'models.js')).href);
    source = dist;
  } else {
    all = await import('@earendil-works/pi-ai/providers/all' as string);
    models = await import('@earendil-works/pi-ai' as string);
    const pkg = path.resolve(import.meta.dirname, '..', '..', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
    version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
    source = 'node_modules';
  }
  return {
    version, source,
    get(id) {
      const at = id.indexOf('/');
      if (at < 0) return undefined;
      const model = all.getBuiltinModel(id.slice(0, at), id.slice(at + 1));
      if (!model) return undefined;
      return { id, contextWindow: model.contextWindow, cost: model.cost, efforts: models.getSupportedThinkingLevels(model) };
    },
  };
}
