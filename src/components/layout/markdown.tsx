/**
 * A small Markdown renderer for the in-app guide.
 *
 * Deliberately not a library. The guide is written by us, in a subset we
 * control — headings, paragraphs, lists, fenced and indented code, inline
 * code, bold, links, and the one table in the shortcuts section — and a
 * full CommonMark parser is a large dependency to carry for that. More to
 * the point, the built app's CSP is `default-src 'self'` and a renderer
 * that produced raw HTML would be a hole; this one produces React elements
 * from a fixed grammar and cannot emit anything it does not know.
 *
 * Links open through the main process's safe opener (see
 * `electron/main/openExternal.ts`), never in-window — a guide that
 * navigated the app away from itself would be a very bad guide.
 */

import * as React from 'react'

export interface Heading {
  id: string
  level: number
  text: string
}

/** Stable, URL-safe id from a heading, matching what `render` assigns. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Headings in order, for a table of contents. */
export function extractHeadings(md: string): Heading[] {
  const out: Heading[] = []
  let inFence = false
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
    if (m) out.push({ id: slug(m[2]), level: m[1].length, text: m[2] })
  }
  return out
}

/* ---------- inline ---------- */

// Order matters: `**bold**` before `*italic*`, or the bold pair reads as
// two empty italics around a stray asterisk.
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(<https?:\/\/[^>]+>)|(\[[^\]]+\]\(https?:\/\/[^)]+\))/g

function renderInline(text: string, openLink: (url: string) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0
    if (idx > last) nodes.push(text.slice(last, idx))
    const tok = m[0]
    if (m[1]) {
      nodes.push(<code key={key++}>{tok.slice(1, -1)}</code>)
    } else if (m[2]) {
      nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    } else if (m[3]) {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    } else if (m[4]) {
      const url = tok.slice(1, -1)
      nodes.push(
        <a key={key++} href={url} onClick={(e) => { e.preventDefault(); openLink(url) }}>
          {url}
        </a>
      )
    } else if (m[5]) {
      const mm = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(tok)
      if (mm) {
        nodes.push(
          <a key={key++} href={mm[2]} onClick={(e) => { e.preventDefault(); openLink(mm[2]) }}>
            {mm[1]}
          </a>
        )
      }
    }
    last = idx + tok.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/* ---------- block ---------- */

export function renderMarkdown(
  md: string,
  openLink: (url: string) => void,
  classes: { h1?: string; h2?: string; h3?: string; p?: string; ul?: string; ol?: string; pre?: string; table?: string }
): React.ReactNode[] {
  const lines = md.split('\n')
  const out: React.ReactNode[] = []
  let i = 0
  let key = 0

  const flushPara = (buf: string[]) => {
    if (buf.length === 0) return
    out.push(
      <p key={key++} className={classes.p}>
        {renderInline(buf.join(' '), openLink)}
      </p>
    )
    buf.length = 0
  }

  const para: string[] = []

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code
    if (/^```/.test(line)) {
      flushPara(para)
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence
      out.push(
        <pre key={key++} className={classes.pre}>
          <code>{body.join('\n')}</code>
        </pre>
      )
      continue
    }

    // Indented code (4 spaces), only after a blank line
    if (/^ {4}\S/.test(line) && para.length === 0) {
      const body: string[] = []
      while (i < lines.length && (/^ {4}/.test(lines[i]) || lines[i].trim() === '')) {
        body.push(lines[i].replace(/^ {4}/, ''))
        i++
      }
      while (body.length && body[body.length - 1].trim() === '') body.pop()
      out.push(
        <pre key={key++} className={classes.pre}>
          <code>{body.join('\n')}</code>
        </pre>
      )
      continue
    }

    // Heading
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
    if (h) {
      flushPara(para)
      const level = h[1].length
      const id = slug(h[2])
      const cls = level === 1 ? classes.h1 : level === 2 ? classes.h2 : classes.h3
      const content = renderInline(h[2], openLink)
      out.push(
        level === 1 ? <h1 key={key++} id={id} className={cls}>{content}</h1>
        : level === 2 ? <h2 key={key++} id={id} className={cls}>{content}</h2>
        : <h3 key={key++} id={id} className={cls}>{content}</h3>
      )
      i++
      continue
    }

    // Table: header row, separator row, body rows
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara(para)
      const rows: string[][] = []
      const splitRow = (r: string) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const header = splitRow(line)
      i += 2
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(splitRow(lines[i++]))
      const hasHeader = header.some((c) => c.length > 0)
      out.push(
        <div key={key++} className={classes.table}>
          <table>
            {hasHeader ? (
              <thead>
                <tr>{header.map((c, ci) => <th key={ci}>{renderInline(c, openLink)}</th>)}</tr>
              </thead>
            ) : null}
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c, openLink)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // Lists
    const li = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(line)
    if (li) {
      flushPara(para)
      const ordered = /\d/.test(li[2])
      const items: string[] = []
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(lines[i])
        if (!m) break
        // A continuation line (indented, no bullet) joins the previous item.
        items.push(m[3])
        i++
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) {
          items[items.length - 1] += ' ' + lines[i].trim()
          i++
        }
      }
      const children = items.map((t, k) => <li key={k}>{renderInline(t, openLink)}</li>)
      out.push(
        ordered ? <ol key={key++} className={classes.ol}>{children}</ol>
        : <ul key={key++} className={classes.ul}>{children}</ul>
      )
      continue
    }

    // Blank line ends a paragraph
    if (line.trim() === '') {
      flushPara(para)
      i++
      continue
    }

    para.push(line.trim())
    i++
  }
  flushPara(para)
  return out
}
