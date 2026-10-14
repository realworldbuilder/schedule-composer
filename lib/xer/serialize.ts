import type { XerFile } from './types.ts';
import { encode } from './encoding.ts';

export function serializeXerText(x: XerFile, { terminator = true }: { terminator?: boolean } = {}): string {
  const out: string[] = [['ERMHDR', ...x.header].join('\t')];
  for (const t of x.tables) {
    out.push('%T\t' + t.name);
    out.push('%F\t' + t.fields.join('\t'));
    for (const r of t.rows) out.push('%R\t' + r.join('\t'));
  }
  if (terminator) out.push('%E');
  let s = out.join(x.eol);
  if (x.trailingNewline) s += x.eol;
  s += x.tail;
  return s;
}

export function serializeXer(x: XerFile): Uint8Array {
  return encode(serializeXerText(x), x.encoding);
}
