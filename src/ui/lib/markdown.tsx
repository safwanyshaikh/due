/**
 * A deliberately small Markdown renderer for admin-entered legal text. It builds React elements only, so
 * raw HTML in the source is shown as text, never parsed. Supports headings (#–###), paragraphs, bullet
 * and numbered lists, **bold**, *italic*, `code` and [links](https://…) limited to http(s) and mailto.
 */
import type { ReactNode } from 'react';

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

export function safeHref(href: string): string | null {
  const h = href.trim();
  return SAFE_HREF.test(h) ? h : null;
}

/** Inline formatting: links, bold, italic and code. Everything else stays plain text. */
export function renderInline(text: string, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}-${n++}`;
    if (m[1] !== undefined) {
      const href = safeHref(m[2]);
      out.push(
        href ? (
          <a key={key} href={href} rel="noopener noreferrer" target="_blank">
            {m[1]}
          </a>
        ) : (
          m[1]
        ),
      );
    } else if (m[3] !== undefined) out.push(<strong key={key}>{m[3]}</strong>);
    else if (m[4] !== undefined) out.push(<em key={key}>{m[4]}</em>);
    else if (m[5] !== undefined) out.push(<code key={key}>{m[5]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: 'h'; level: 2 | 3 | 4; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] };

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', text: para.join(' ') });
    para = [];
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      // Page titles are h1; document headings start at h2.
      blocks.push({ t: 'h', level: (h[1].length + 1) as 2 | 3 | 4, text: h[2] });
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const t = ul ? 'ul' : 'ol';
      if (para.length) {
        blocks.push({ t: 'p', text: para.join(' ') });
        para = [];
      }
      if (!list || list.t !== t) {
        if (list) blocks.push(list);
        list = { t, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    if (list) {
      blocks.push(list);
      list = null;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

export function SafeMarkdown({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        if (b.t === 'h') {
          const H = `h${b.level}` as 'h2' | 'h3' | 'h4';
          return <H key={k}>{renderInline(b.text, k)}</H>;
        }
        if (b.t === 'p') return <p key={k}>{renderInline(b.text, k)}</p>;
        const L = b.t;
        return (
          <L key={k}>
            {b.items.map((it, j) => (
              <li key={`${k}-${j}`}>{renderInline(it, `${k}-${j}`)}</li>
            ))}
          </L>
        );
      })}
    </div>
  );
}
