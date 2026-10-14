import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { parseXer, parseXerText } from '../lib/xer/parse.ts';
import { serializeXer, serializeXerText } from '../lib/xer/serialize.ts';
import { decode, encode, isCp1252, toCp1252 } from '../lib/xer/encoding.ts';

const samples = readdirSync('samples').filter((f) => f.endsWith('.xer'));

describe('xer round trip', () => {
  for (const name of samples) {
    it(`byte-exact: ${name}`, () => {
      const bytes = new Uint8Array(readFileSync(`samples/${name}`));
      const f = parseXer(bytes);
      expect(f.tables.length).toBeGreaterThan(3);
      expect(Buffer.from(serializeXer(f)).equals(Buffer.from(bytes))).toBe(true);
    });
  }

  it('keeps ragged rows ragged', () => {
    const f = parseXer(new Uint8Array(readFileSync('samples/PredecessorCalendar.xer')));
    const task = f.tables.find((t) => t.name === 'TASK')!;
    expect(task.fields.length).toBe(59);
    expect(task.rows[0]!.length).toBe(58);
  });

  it('CRLF, no trailing newline, explicit trailing empties', () => {
    const text = 'ERMHDR\t8.2\r\n%T\tA\r\n%F\tx\ty\tz\r\n%R\t1\t\t\r\n%R\t2\r\n%E';
    const f = parseXerText(text);
    expect(f.eol).toBe('\r\n');
    expect(f.trailingNewline).toBe(false);
    expect(f.tables[0]!.rows[0]).toEqual(['1', '', '']);
    expect(serializeXerText(f)).toBe(text);
  });

  it('tail after %E survives', () => {
    const text = 'ERMHDR\t8.2\n%T\tA\n%F\tx\n%E\njunk\n';
    const f = parseXerText(text);
    expect(serializeXerText(f)).toBe(text);
  });

  it('cp1252 bytes decode to curly quotes and re-encode exactly', () => {
    const base = readFileSync('samples/PredecessorCalendar.xer');
    const i = base.indexOf('\tTest\t');
    const mod = Buffer.concat([base.subarray(0, i + 1), Buffer.from([0x54, 0x92, 0x73, 0x20, 0x96]), base.subarray(i + 5)]);
    const f = parseXer(new Uint8Array(mod));
    expect(f.encoding).toBe('windows-1252');
    const task = f.tables.find((t) => t.name === 'TASK')!;
    expect(task.rows[0]![task.fields.indexOf('task_name')]).toBe('T’s –');
    expect(Buffer.from(serializeXer(f)).equals(mod)).toBe(true);
  });

  it('utf-8 input is detected', () => {
    const { encoding, text } = decode(new TextEncoder().encode('ERMHDR\t8é\n%E\n'));
    expect(encoding).toBe('utf-8');
    expect(text).toContain('é');
  });

  it('encode rejects emoji, toCp1252 downgrades', () => {
    expect(isCp1252('café – ok')).toBe(true);
    expect(isCp1252('\u{1F642}')).toBe(false);
    expect(() => encode('\u{1F642}', 'windows-1252')).toThrow(/cannot be stored/);
    expect(toCp1252('naïve \u{1F642} Ł')).toBe('naïve ? L');
  });
});
