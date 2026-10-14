// XER files are Windows-1252. Some third-party exporters write UTF-8; detect that
// by a BOM or by the bytes being valid UTF-8 with at least one high byte.

const cp1252Decoder = new TextDecoder('windows-1252');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

let cp1252Map: Map<string, number> | null = null;
function table(): Map<string, number> {
  if (!cp1252Map) {
    cp1252Map = new Map();
    for (let b = 0; b < 256; b++) {
      const ch = cp1252Decoder.decode(new Uint8Array([b]));
      if (!cp1252Map.has(ch)) cp1252Map.set(ch, b);
    }
  }
  return cp1252Map;
}

export function decode(bytes: Uint8Array): { text: string; encoding: 'windows-1252' | 'utf-8' } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: utf8Strict.decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  let high = false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i]! >= 0x80) { high = true; break; }
  if (high) {
    try { return { text: utf8Strict.decode(bytes), encoding: 'utf-8' }; } catch { /* not utf-8 */ }
  }
  return { text: cp1252Decoder.decode(bytes), encoding: 'windows-1252' };
}

export class EncodingError extends Error {
  readonly char: string;
  constructor(char: string) {
    super(`"${char}" cannot be stored in an XER file (Windows-1252)`);
    this.char = char;
    this.name = 'EncodingError';
  }
}

/** True when every character of s survives a Windows-1252 round trip. */
export function isCp1252(s: string): boolean {
  const t = table();
  for (const ch of s) if (!t.has(ch)) return false;
  return true;
}

const FALLBACK: Record<string, string> = {
  'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ø': 'O', 'ø': 'o',
  '‐': '-', '‑': '-', '‒': '-', '―': '-', '′': "'", '″': '"',
  ' ': ' ', ' ': ' ', ' ': ' ', '→': '->', '←': '<-', '≤': '<=', '≥': '>=',
};

/** Replace characters outside Windows-1252 with close ASCII equivalents, or '?'. */
export function toCp1252(s: string): string {
  const t = table();
  let out = '';
  for (const ch of s) {
    if (t.has(ch)) { out += ch; continue; }
    if (FALLBACK[ch]) { out += FALLBACK[ch]; continue; }
    const n = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    out += n && n !== ch && isCp1252(n) ? n : '?';
  }
  return out;
}

export function encode(text: string, encoding: 'windows-1252' | 'utf-8'): Uint8Array {
  if (encoding === 'utf-8') return new TextEncoder().encode(text);
  const t = table();
  const out = new Uint8Array(text.length);
  let n = 0;
  for (const ch of text) {
    const b = t.get(ch);
    if (b === undefined) throw new EncodingError(ch);
    out[n++] = b;
  }
  return out.subarray(0, n);
}
