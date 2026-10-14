// Tiny fetch helpers for the HTTP half of PROTOCOL.md.
import type { CompactDiff, Snapshot } from '../lib/schedule/diff.ts';

export interface FileEntry { name: string; path: string; size: number; mtime: number | string }
export interface Health { ok: boolean; file: string | null; tasks: number; agent: 'max-login' | 'api-key'; model: string }
export interface History { undo: string[]; redo: string[] }
export interface NewProject { name: string; code: string; start: string; hoursPerDay: number; workDays: number[] }

export class ApiError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

async function call<T>(method: string, url: string, body?: unknown, raw?: { bytes: BodyInit; headers: Record<string, string> }): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : raw?.headers ?? {},
    body: body !== undefined ? JSON.stringify(body) : raw?.bytes,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  health: () => call<Health>('GET', '/api/health'),
  snapshot: () => call<Snapshot>('GET', '/api/snapshot'),
  files: () => call<{ files: FileEntry[] }>('GET', '/api/files'),
  open: (path: string) => call<Snapshot>('POST', '/api/open', { path }),
  newProject: (p: NewProject) => call<Snapshot>('POST', '/api/new', p),
  upload: (name: string, bytes: Blob) => call<Snapshot>('POST', '/api/upload', undefined, { bytes, headers: { 'X-Filename': name, 'content-type': 'application/octet-stream' } }),
  undo: (steps = 1) => call<CompactDiff>('POST', '/api/undo', { steps }),
  redo: () => call<CompactDiff>('POST', '/api/redo', {}),
  history: () => call<History>('GET', '/api/history'),
  chat: (text: string) => call<{ turn: string }>('POST', '/api/chat', { text }),
  interrupt: () => call<unknown>('POST', '/api/interrupt', {}),
  exportUrl: (name?: string) => `/api/export${name ? `?name=${encodeURIComponent(name)}` : ''}`,
};
