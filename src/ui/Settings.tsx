// API key / model dialog for the static (GitHub Pages) build.
import { useEffect, useReducer, useState } from 'preact/hooks';
import { MODELS, getSettings, saveSettings, onSettings } from '../local/settings';

let open = false;
const listeners = new Set<() => void>();
export function openSettings(): void { open = true; for (const l of listeners) l(); }
function close(): void { open = false; for (const l of listeners) l(); }
export function useSettings() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { const fn = () => bump(0); listeners.add(fn); const off = onSettings(fn); return () => { listeners.delete(fn); off(); }; }, []);
  return { open, settings: getSettings() };
}

export function SettingsDialog() {
  const { open: isOpen, settings } = useSettings();
  const [key, setKey] = useState(settings.apiKey);
  const [model, setModel] = useState(settings.model);
  const [effort, setEffort] = useState(settings.effort);
  useEffect(() => { if (isOpen) { setKey(settings.apiKey); setModel(settings.model); setEffort(settings.effort); } }, [isOpen]);
  if (!isOpen) return null;
  const save = () => { saveSettings({ apiKey: key.trim(), model, effort }); close(); };
  return (
    <div class="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="modal">
        <div class="modal-head">Agent settings</div>
        <p class="muted">This build runs entirely in your browser. The key is stored only on this device (localStorage) and is sent straight to api.anthropic.com.</p>
        <label class="field"><span>Anthropic API key</span><input type="password" value={key} placeholder="sk-ant-..." autocomplete="off" onInput={(e) => setKey((e.currentTarget as HTMLInputElement).value)} /></label>
        <label class="field"><span>Model</span>
          <select value={model} onChange={(e) => setModel((e.currentTarget as HTMLSelectElement).value)}>{MODELS.map((m) => <option value={m.id}>{m.label}</option>)}</select>
        </label>
        <label class="field"><span>Effort</span>
          <select value={effort} onChange={(e) => setEffort((e.currentTarget as HTMLSelectElement).value as typeof effort)}>
            <option value="">Model default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option>
          </select>
        </label>
        <div class="modal-foot"><button class="tb ghost" onClick={close}>Cancel</button><button class="tb primary" onClick={save}>Save</button></div>
      </div>
    </div>
  );
}
