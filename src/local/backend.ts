// Static-build backend: the Document, undo/redo, files and the agent all live in this tab.
import { api, ApiError, type FileEntry, type NewProject } from '../api';
import { applyPatch, chatEvent, setOnline, setSender, setSnapshot, refreshHistory } from '../store';
import { Document } from '../../lib/state.ts';
import { blankProject } from '../../lib/schedule/blank.ts';
import type { Patch, Snapshot } from '../../lib/schedule/diff.ts';
import { LocalAgent } from './agent';
import { getSettings, costOf } from './settings';
import templateXer from '../../samples/PredecessorCalendar.xer?raw';
import sampleXer from '../../samples/generated-200.xer?raw';

let doc: Document | null = null;
let exportUrl: { seq: number; url: string } | null = null;
const latin1 = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

const SAMPLES: Record<string, () => Uint8Array> = {
  'samples/generated-200.xer': () => latin1(sampleXer),
  'samples/PredecessorCalendar.xer': () => latin1(templateXer),
};

function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const agent = new LocalAgent({
  apiKey: () => getSettings().apiKey, model: () => getSettings().model, effort: () => getSettings().effort,
  doc: () => doc, emit: chatEvent, cost: costOf,
  saveExport: async (name, bytes) => { download(name, bytes); return { path: name, bytes: bytes.length }; },
});

function open(file: string, bytes: Uint8Array): Snapshot {
  const d = new Document(file, bytes);
  d.on('patch', (p: Patch) => { applyPatch(p); refreshHistory(); });
  doc = d;
  agent.reset();
  chatEvent({ kind: 'status', working: false });
  return d.snapshot();
}

function need(): Document { if (!doc) throw new ApiError(404, 'no file open'); return doc; }

export function initLocal(): void {
  try {
  Object.assign(api, {
    health: async () => ({ ok: true, file: doc?.file ?? null, tasks: doc?.snapshot().tasks.length ?? 0, agent: 'api-key', model: getSettings().model }),
    snapshot: async () => need().snapshot(),
    files: async (): Promise<{ files: FileEntry[] }> => ({ files: Object.keys(SAMPLES).map((p) => ({ name: p.split('/')[1]!, path: p, size: SAMPLES[p]!().length, mtime: '2026-10-13T00:00:00Z' })) }),
    open: async (path: string) => { const f = SAMPLES[path]; if (!f) throw new ApiError(404, 'unknown file'); const snap = open(path.split('/')[1]!, f()); setSnapshot(snap, true); return snap; },
    newProject: async (p: NewProject) => { const { file, bytes } = blankProject(p, templateXer); const snap = open(file, bytes); setSnapshot(snap, true); return snap; },
    upload: async (name: string, blob: Blob) => { const snap = open(name, new Uint8Array(await blob.arrayBuffer())); setSnapshot(snap, true); return snap; },
    undo: async (steps = 1) => need().undo('ui', { steps }),
    redo: async () => need().redo('ui'),
    history: async () => ({ undo: doc?.history.map((h) => h.label) ?? [], redo: doc?.redoStack.map((h) => h.label) ?? [] }),
    chat: async (text: string) => ({ turn: agent.send(text) }),
    interrupt: async () => { agent.interrupt(); return {}; },
    exportUrl: () => {
      if (!doc) return '#';
      if (!exportUrl || exportUrl.seq !== doc.seq) {
        if (exportUrl) URL.revokeObjectURL(exportUrl.url);
        exportUrl = { seq: doc.seq, url: URL.createObjectURL(new Blob([doc.exportBytes() as BlobPart], { type: 'application/octet-stream' })) };
      }
      return exportUrl.url;
    },
  });
  setSender((msg) => { if (msg.type === 'chat') agent.send(msg.text); else agent.interrupt(); return true; });
  setOnline(true);
  // Start on the bundled sample so there is something to look at.
  setSnapshot(open('generated-200.xer', SAMPLES['samples/generated-200.xer']!()), true);
  } catch (e) {
    console.error('initLocal failed', e);
    throw e;
  }
}
