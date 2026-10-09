// What kane-cli leaves on disk, as plain values: the live-run pointer and byte offsets into event files.
// The reads themselves (`$.fs`, `$.process`) live in register.tsx; this file only shapes what they return.

import type { Kind } from '../types'

/** `~/.testmuai/kaneai/sessions/active/<pid>.json`, kept while a kane-cli process runs. */
export type Pointer = { pid: number; cwd: string; surface: Kind; sessionDir: string; started: number; cli?: string }

/** `$.fs.read` refuses files above this; past it the tail is read with `tail -c`. */
export const MAX_READ = 4 * 1024 * 1024

export function parsePointer(text: string, now = 0): Pointer | undefined {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!o || typeof o.pid !== 'number' || typeof o.session_dir !== 'string') return undefined
  const surface = o.surface === 'testmd' || o.surface === 'testrun' ? o.surface : 'run'
  const started = Date.parse(String(o.started ?? ''))
  return {
    pid: o.pid,
    cwd: typeof o.cwd === 'string' ? o.cwd.replace(/\/$/, '') : '',
    surface,
    sessionDir: o.session_dir.replace(/\/$/, ''),
    started: Number.isFinite(started) ? started : now,
    cli: typeof o.cli_version === 'string' ? o.cli_version : undefined,
  }
}

/** True when `dir` is `root` or inside it: another project's runs stay out. */
export function inside(dir: string, root: string): boolean {
  if (!dir || !root) return false
  const r = root.replace(/\/$/, '')
  return dir === r || dir.startsWith(`${r}/`)
}

/** UTF-8 length of a string: event files hold “curly quotes” and other multi-byte text. */
export function utf8Len(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4
      i += 1
    } else n += 3
  }
  return n
}

/** The text after its first `bytes` UTF-8 bytes. */
export function afterBytes(s: string, bytes: number): string {
  let n = 0
  let i = 0
  while (i < s.length && n < bytes) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4
      i += 1
    } else n += 3
    i += 1
  }
  return s.slice(i)
}
