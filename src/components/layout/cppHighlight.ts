/**
 * A very small C++ tokenizer, for reading rather than editing.
 *
 * Hand-rolled because the project ships no UI libraries and a syntax
 * highlighter is not a reason to start: the generated code is a narrow
 * dialect we produce ourselves, so a handful of token classes covers it
 * completely. A full grammar would buy nothing — nobody types in here.
 *
 * Scans line by line and carries only one piece of state across lines (are
 * we inside a block comment), which is what lets the view highlight a
 * window of a 900-line file without tokenizing the whole thing first.
 */

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'preproc'
  | 'punct'

export interface Token {
  kind: TokenKind
  text: string
}

/** Control flow and declaration keywords. */
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
  'continue', 'return', 'goto', 'new', 'delete', 'this', 'nullptr', 'true',
  'false', 'const', 'constexpr', 'static', 'inline', 'extern', 'volatile',
  'struct', 'class', 'enum', 'union', 'namespace', 'using', 'template',
  'typename', 'public', 'private', 'protected', 'virtual', 'override',
  'operator', 'sizeof', 'typedef', 'auto'
])

/** Types worth colouring apart, including the ones our emitters lean on. */
const TYPES = new Set([
  'void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double',
  'signed', 'unsigned', 'size_t', 'uint8_t', 'uint16_t', 'uint32_t',
  'uint64_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t'
])

const IDENT_START = /[A-Za-z_]/
const IDENT = /[A-Za-z0-9_]/
const DIGIT = /[0-9]/

export interface LineScan {
  tokens: Token[]
  /** Whether the NEXT line starts inside a block comment. */
  inBlockComment: boolean
}

export function scanLine(line: string, startInBlockComment: boolean): LineScan {
  const tokens: Token[] = []
  let inBlock = startInBlockComment
  let i = 0
  let plain = ''

  const flush = (): void => {
    if (plain) {
      tokens.push({ kind: 'plain', text: plain })
      plain = ''
    }
  }
  const push = (kind: TokenKind, text: string): void => {
    flush()
    tokens.push({ kind, text })
  }

  // A line that opened inside /* ... */ is comment until it closes.
  if (inBlock) {
    const end = line.indexOf('*/')
    if (end < 0) return { tokens: [{ kind: 'comment', text: line }], inBlockComment: true }
    push('comment', line.slice(0, end + 2))
    i = end + 2
    inBlock = false
  }

  // A preprocessor directive owns its whole line apart from a trailing
  // comment, which is close enough for reading and much simpler than
  // tokenizing macro syntax properly.
  const rest = line.slice(i)
  if (/^\s*#/.test(rest) && !inBlock) {
    const cut = rest.search(/\/\/|\/\*/)
    if (cut < 0) {
      push('preproc', rest)
      return { tokens, inBlockComment: false }
    }
    push('preproc', rest.slice(0, cut))
    i += cut
  }

  while (i < line.length) {
    const c = line[i]
    const next = line[i + 1]

    if (c === '/' && next === '/') {
      push('comment', line.slice(i))
      i = line.length
      break
    }
    if (c === '/' && next === '*') {
      const end = line.indexOf('*/', i + 2)
      if (end < 0) {
        push('comment', line.slice(i))
        return { tokens, inBlockComment: true }
      }
      push('comment', line.slice(i, end + 2))
      i = end + 2
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1
      push('string', line.slice(i, Math.min(j + 1, line.length)))
      i = j + 1
      continue
    }
    if (DIGIT.test(c) || (c === '.' && next && DIGIT.test(next))) {
      let j = i
      // One pass covers 0x1f, 1.5e-3 and 48000.f alike.
      while (j < line.length && /[0-9a-fA-FxX.eE+_'-]/.test(line[j])) {
        // `-`/`+` only continue a number straight after an exponent.
        if ((line[j] === '-' || line[j] === '+') && !/[eE]/.test(line[j - 1] ?? '')) break
        j++
      }
      while (j < line.length && /[fFuUlL]/.test(line[j])) j++
      push('number', line.slice(i, j))
      i = j
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i
      while (j < line.length && IDENT.test(line[j])) j++
      const word = line.slice(i, j)
      if (KEYWORDS.has(word)) push('keyword', word)
      else if (TYPES.has(word)) push('type', word)
      else plain += word
      i = j
      continue
    }
    if (/[{}()[\];,.<>=+\-*/%&|!?:~^]/.test(c)) {
      push('punct', c)
      i++
      continue
    }
    plain += c
    i++
  }

  flush()
  return { tokens, inBlockComment: inBlock }
}

/** Tokenize a whole file, carrying block-comment state between lines. */
export function scanFile(text: string): Token[][] {
  const out: Token[][] = []
  let inBlock = false
  for (const line of text.split('\n')) {
    const r = scanLine(line, inBlock)
    inBlock = r.inBlockComment
    out.push(r.tokens)
  }
  return out
}
