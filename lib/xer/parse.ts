import { XerParseError, type XerFile, type XerTable } from './types.ts';
import { decode } from './encoding.ts';

export function parseXer(bytes: Uint8Array): XerFile {
  const { text, encoding } = decode(bytes);
  const f = parseXerText(text);
  f.encoding = encoding;
  return f;
}

export function parseXerText(text: string): XerFile {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const file: XerFile = { header: [], tables: [], eol, trailingNewline: false, tail: '', encoding: 'windows-1252' };
  let table: XerTable | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const tab = line.indexOf('\t');
    const kind = tab === -1 ? line : line.slice(0, tab);
    const rest = () => (tab === -1 ? [] : line.slice(tab + 1).split('\t'));
    switch (kind) {
      case 'ERMHDR':
        file.header = rest();
        break;
      case '%T':
        table = { name: line.slice(tab + 1), fields: [], rows: [] };
        file.tables.push(table);
        break;
      case '%F':
        if (!table) throw new XerParseError('%F before any %T', i + 1);
        table.fields = rest();
        break;
      case '%R':
        if (!table) throw new XerParseError('%R before any %T', i + 1);
        table.rows.push(rest());
        break;
      case '%E': {
        const after = lines.slice(i + 1);
        // text.split(eol) yields one trailing '' when the file ends with eol.
        if (after.length >= 1 && after[after.length - 1] === '') { file.trailingNewline = true; after.pop(); }
        // Tail (rare) is kept verbatim: the eol after %E, the lines, and their ending.
        file.tail = after.length ? eol + after.join(eol) + (file.trailingNewline ? eol : '') : '';
        if (file.tail) file.trailingNewline = false;
        return file;
      }
      case '':
        if (i === lines.length - 1) { file.trailingNewline = true; return file; } // no %E, ends with eol
        throw new XerParseError('blank line inside XER', i + 1);
      default:
        throw new XerParseError(`unexpected line kind "${kind.slice(0, 20)}"`, i + 1);
    }
  }
  return file; // no %E and no trailing newline
}
