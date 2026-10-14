// Browser-only settings for the static build: API key and model live in localStorage on this device.
export interface LocalSettings { apiKey: string; model: string; effort: '' | 'low' | 'medium' | 'high' | 'xhigh' }

export const MODELS: { id: string; label: string; inPerM: number; outPerM: number }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (recommended)', inPerM: 4, outPerM: 20 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)', inPerM: 2, outPerM: 10 },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (most capable, pricier)', inPerM: 10, outPerM: 50 },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)', inPerM: 0.1, outPerM: 0.5 },
];

const KEY = 'sc.local.settings';
let cur: LocalSettings = load();
const listeners = new Set<() => void>();

function load(): LocalSettings {
  try { const v = localStorage.getItem(KEY); if (v) return { apiKey: '', model: 'claude-opus-5-5', effort: '', ...(JSON.parse(v) as Partial<LocalSettings>) }; } catch { /* ignore */ }
  return { apiKey: '', model: 'claude-opus-5-5', effort: '' };
}
export function getSettings(): LocalSettings { return cur; }
export function saveSettings(s: Partial<LocalSettings>): void {
  cur = { ...cur, ...s };
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* private mode */ }
  for (const l of listeners) l();
}
export function onSettings(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function costOf(model: string, inTok: number, outTok: number): number {
  const m = MODELS.find((x) => x.id === model) ?? MODELS[0]!;
  return (inTok * m.inPerM + outTok * m.outPerM) / 1_000_000;
}
