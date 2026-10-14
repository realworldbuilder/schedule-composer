// A light markdown renderer for assistant text: paragraphs, bullet and numbered lists,
// headings, inline code, bold, italic. Built as Preact nodes, never innerHTML.
import type { ComponentChildren } from 'preact';
import { fmtDatesIn } from '../util';

export function Markdown({ text }: { text: string }) {
  return <>{blocks(text)}</>;
}

function blocks(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0, key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) buf.push(lines[i++]!);
      i++;
      out.push(<pre key={key++} class="code">{buf.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { out.push(<div key={key++} class="md-h">{inline(h[2]!)}</div>); i++; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const items: ComponentChildren[] = [];
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*([-*•]|\d+[.)])\s+/, '');
        i++;
        // continuation lines indented under the bullet
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) item += ' ' + lines[i++]!.trim();
        items.push(<li key={items.length}>{inline(item)}</li>);
      }
      out.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) rows.push(lines[i++]!);
      const cells = rows.filter((r) => !/^\|\s*:?-+/.test(r)).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      out.push(
        <table key={key++} class="md-table">
          <tbody>{cells.map((r, ri) => <tr key={ri}>{r.map((c, ci) => ri === 0 ? <th key={ci}>{inline(c)}</th> : <td key={ci}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!) && !lines[i]!.startsWith('```') && !/^#{1,4}\s/.test(lines[i]!) && !lines[i]!.startsWith('|')) buf.push(lines[i++]!);
    out.push(<p key={key++}>{inline(buf.join(' '))}</p>);
  }
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/g;

export function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0, m: RegExpExecArray | null, k = 0;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(fmtDatesIn(text.slice(last, m.index)));
    const s = m[0];
    if (s.startsWith('`')) out.push(<code key={k++}>{s.slice(1, -1)}</code>);
    else if (s.startsWith('**')) out.push(<strong key={k++}>{fmtDatesIn(s.slice(2, -2))}</strong>);
    else out.push(<em key={k++}>{s.slice(1, -1)}</em>);
    last = m.index + s.length;
  }
  if (last < text.length) out.push(fmtDatesIn(text.slice(last)));
  return out;
}
