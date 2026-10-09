// Pure logic: internal events → runs, and runs + clock + settings → the band's rows and the pane's text.
// No `$` here, so tests drive it directly.

import type { Ev } from './adapter'
import { RANK } from './adapter'
import type { Assurance, Check, HistoryEntry, Kind, Run, Status, Step, UseCase } from '../types'

export const C = {
  purple: '#b388ff',
  lilac: '#cdb8ff',
  cyan: '#9fdcff',
  mint: '#7fe3b5',
  coral: '#ff8b94',
  orange: '#ffa45c',
  yellow: '#ffd66b',
  dim: '#8480a3',
  track: '#3a3658',
  chipRun: '#2c2350',
  chipIdle: '#1c1a2b',
} as const

// ── small text helpers ───────────────────────────────────────────────────

/** Seconds → "41s" or "1m 06s". */
export const fmt = (s: number): string => {
  const n = Math.max(0, Math.round(s))
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, '0')}s`
}
export const cut = (t: string, n: number): string => (t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t)
/** A test's short name: a saved test without its `_test.md`. */
export const nm = (r: Pick<Run, 'label'>): string => r.label.replace(/_test\.md$/, '')
export const ago = (ms: number): string => {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}
const base = (p: string): string => p.split('/').pop() ?? p
const PLACEHOLDER = /^Step \d+$/

/** Planner noise a reader does not need: "click: PRIMARY: x; role=…" → "x". */
export function tidyStep(text: string): string {
  let t = text.replace(/^\w+:\s+(?=PRIMARY:|Clicking|Typing|Selecting|Opening|Scrolling|Navigate|Type |Press)/, '')
  t = t.replace(/^PRIMARY:\s*/, '').replace(/\s*\|\s*HINTS:.*$/, '').replace(/;\s*role=.*$/, '')
  t = t.replace(/^queued plan \(\d+ steps?\):\s*/, '')
  return t.trim()
}

// ── runs ─────────────────────────────────────────────────────────────────

export function newRun(id: string, kind: Kind, sessionDir: string, startedAt: number, extra: Partial<Run> = {}): Run {
  return { id, label: kind === 'testrun' ? 'suite' : base(sessionDir), kind, status: 'running', startedAt, steps: [], sessionDir, labelRank: 0, ...extra }
}

const isLive = (s: Status) => s === 'running' || s === 'pending'

function setStep(steps: Step[], i: number, patch: Partial<Step>): Step[] {
  const next = [...steps]
  while (next.length <= i) next.push({ text: '', status: 'pending' })
  next[i] = { ...next[i]!, ...patch }
  return next
}

/** The step being worked on: the last running one. */
const currentIndex = (steps: readonly Step[]): number => {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.status === 'running') return i
  return -1
}

function relabel(run: Run, text: string, rank: number): Run {
  if (!text || rank < (run.labelRank ?? 0)) return run
  return { ...run, label: text, labelRank: rank }
}

/** Ends every step still running, as the run ended. */
function closeSteps(steps: readonly Step[], status: Status, at: number): Step[] {
  return steps.map(s => (s.status === 'running' ? { ...s, status, endedAt: at } : s))
}

const lastFailed = (steps: readonly Step[]): Step | undefined => [...steps].reverse().find(s => s.status === 'failed')

/** Folds one internal event into a run (a single run, a test file, or a suite). */
export function fold(run: Run, ev: Ev): Run {
  switch (ev.k) {
    case 'start':
      return { ...run, kind: ev.surface ?? run.kind, pid: ev.pid ?? run.pid }
    case 'newer':
      return { ...run, newer: true }
    case 'postHoc':
      return run.postHoc ? run : { ...run, postHoc: true }
    case 'label':
      return relabel(run, ev.text, ev.rank)
    case 'ask':
      return { ...run, waiting: ev.question }
    case 'error':
      return run.failure ? run : { ...run, failure: { why: ev.message } }
    case 'step': {
      const i = ev.n - 1
      const text = tidyStep(ev.text)
      if (ev.status === 'running') {
        const steps = setStep(closeSteps(run.steps, 'passed', ev.at), i, { status: 'running', startedAt: ev.at, text: PLACEHOLDER.test(text) ? '' : text })
        return { ...run, steps, waiting: undefined }
      }
      const prev = run.steps[i]
      const done: Partial<Step> = { status: ev.status === 'done' ? 'passed' : 'failed', endedAt: ev.at, text: text || prev?.text || '(no action recorded)' }
      if (!prev?.startedAt) done.startedAt = ev.at
      let next: Run = { ...run, steps: setStep(run.steps, i, done), waiting: undefined }
      if (text && (run.labelRank ?? 0) < RANK.firstStep) next = relabel(next, text, RANK.firstStep)
      return next
    }
    case 'runEnd': {
      const credits = ev.credits === undefined ? run.credits : (run.kind === 'testmd' ? (run.credits ?? 0) : 0) + ev.credits
      const facts = ev.status === 'failed' ? { why: ev.why ?? run.failure?.why ?? '', category: ev.category, severity: ev.severity, confidence: ev.confidence } : undefined
      // A test file's run_end closes one of its steps, not the test.
      if (run.kind === 'testmd') return { ...run, credits, failure: facts && facts.why ? { ...run.failure, ...facts } : run.failure }
      const steps = closeSteps(run.steps, ev.status, ev.at)
      const failure = facts ? { ...facts, why: facts.why || 'kane-cli reported a failure', where: lastFailed(steps)?.text || [...steps].reverse().find(s => s.text)?.text } : undefined
      return { ...run, status: ev.status, endedAt: ev.at, steps, credits, failure, waiting: undefined }
    }
    case 'mdStepStart': {
      const heading = PLACEHOLDER.test(ev.heading) ? '' : ev.heading
      return { ...run, steps: setStep(run.steps, ev.index - 1, { text: heading, status: 'running', startedAt: ev.at }) }
    }
    case 'runStart': {
      let next: Run = ev.target ? { ...run, target: ev.target } : run
      const i = currentIndex(next.steps)
      if (ev.objective && i >= 0 && !next.steps[i]!.text) next = { ...next, steps: setStep(next.steps, i, { text: ev.objective.replace(/\.$/, '') }) }
      if (ev.objective) next = relabel(next, ev.objective, RANK.objective)
      return next
    }
    case 'detail': {
      const i = currentIndex(run.steps)
      if (i < 0) return run
      const s = run.steps[i]!
      if (ev.kind === 'think') return { ...run, steps: setStep(run.steps, i, { think: ev.text }) }
      if (ev.kind === 'act') return { ...run, steps: setStep(run.steps, i, { act: ev.text }) }
      const checks: Check[] = [...(s.checks ?? []), { ok: ev.ok !== false, text: ev.text }]
      return { ...run, steps: setStep(run.steps, i, { checks }) }
    }
    case 'mdStepEnd':
      return { ...run, steps: setStep(run.steps, ev.index - 1, { status: ev.status === 'passed' ? 'passed' : 'failed', endedAt: ev.at }) }
    case 'mdDone': {
      const status: Status = ev.status === 'passed' ? 'passed' : 'failed'
      const steps = closeSteps(run.steps, status, ev.at)
      const failure = status === 'failed' ? { why: run.failure?.why || 'the test failed', ...run.failure, where: lastFailed(steps)?.text } : undefined
      return { ...run, status, endedAt: ev.at, steps, failure, waiting: undefined }
    }
    case 'plan': {
      const members = ev.members.map(p => newRun(p, 'testmd', '', ev.at, { label: base(p), status: 'pending', labelRank: RANK.command }))
      return { ...run, kind: 'testrun', members }
    }
    case 'memberStart':
      return withMember(run, ev.path, m => ({ ...m, status: 'running', startedAt: ev.at, sessionDir: ev.logPath ? ev.logPath.replace(/\/[^/]+$/, '') : m.sessionDir }))
    case 'progress': {
      let next = run
      for (const p of ev.running) next = withMember(next, p, m => (m.status === 'pending' ? { ...m, status: 'running', startedAt: ev.at } : m))
      return next
    }
    case 'memberEnd':
      return withMember(run, ev.path, m => {
        const status: Status = ev.status === 'passed' ? 'passed' : 'failed'
        const startedAt = m.status === 'pending' && ev.durationS !== undefined ? ev.at - ev.durationS * 1000 : m.startedAt
        const steps = closeSteps(m.steps, status, ev.at)
        const failure = status === 'failed' ? { why: m.failure?.why || ev.why || `kane-cli reported it ${ev.status}, with no reason`, ...m.failure, where: m.failure?.where ?? lastFailed(steps)?.text } : undefined
        return { ...m, status, startedAt, endedAt: ev.at, steps, failure }
      })
    case 'suiteDone': {
      const status: Status = ev.status === 'passed' ? 'passed' : 'failed'
      const members = (run.members ?? []).map(m => (m.status === 'running' ? { ...m, status: 'failed' as const, endedAt: ev.at, failure: { why: 'the suite ended before this test finished' } } : m))
      return { ...run, status, endedAt: ev.at, members }
    }
  }
}

/** Plan paths are absolute; progress lines may be relative to where the suite ran. */
export const samePath = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)

function withMember(run: Run, path: string, fn: (m: Run) => Run): Run {
  const members = run.members ?? []
  const i = members.findIndex(m => samePath(m.id, path))
  if (i === -1) return { ...run, kind: 'testrun', members: [...members, fn(newRun(path, 'testmd', '', run.startedAt, { label: base(path), status: 'pending', labelRank: RANK.command }))] }
  const next = [...members]
  next[i] = fn(members[i]!)
  return { ...run, members: next }
}

/** Folds a member's own stream (a test file) into the suite. Its end is the suite's to report. */
export function foldMember(run: Run, path: string, ev: Ev): Run {
  if (ev.k === 'label' || ev.k === 'start') return run
  return withMember(run, path, m => {
    const next = fold(m, ev)
    // The suite's member_end decides the member's result; its own stream only adds steps and facts.
    return ev.k === 'mdDone' && m.status === 'running' ? { ...next, status: m.status, endedAt: m.endedAt } : next
  })
}

/** Folds a whole recorded stream (tests and fixtures). */
export function replay(run: Run, events: readonly Ev[]): Run {
  return events.reduce(fold, run)
}

// ── counting ─────────────────────────────────────────────────────────────

/** The tests a run stands for: a suite's members, or the run itself. */
export const tests = (r: Run): Run[] => (r.kind === 'testrun' && r.members ? r.members : [r])
export const leaves = (runs: readonly Run[]): Run[] => runs.flatMap(tests)

export type Tally = { passed: number; failed: number; running: number; pending: number; total: number }
export function tally(list: readonly Run[]): Tally {
  const out: Tally = { passed: 0, failed: 0, running: 0, pending: 0, total: list.length }
  for (const r of list) out[r.status] += 1
  return out
}

/** Seconds a run has taken, or has been going. */
export const elapsed = (r: Run, now: number): number => ((r.endedAt ?? now) - r.startedAt) / 1000

/** The step a run is on (or failed on). */
export function currentStep(r: Run): Step | undefined {
  const i = currentIndex(r.steps)
  if (i >= 0) return r.steps[i]
  return lastFailed(r.steps)
}

/** What a run is doing now, in words. Surface `run` names a step only when it ends. */
export function nowText(r: Run): string {
  if (r.waiting) return `waiting for an answer: ${r.waiting}`
  const s = currentStep(r)
  if (s?.text) return s.text
  const done = [...r.steps].reverse().find(x => x.status !== 'running' && x.text)
  if (done) return `✓ ${done.text} · next step…`
  return 'starting the browser'
}

// ── the band ────────────────────────────────────────────────────────────

export type Span = { t: string; c?: string; bg?: string; b?: boolean; d?: boolean }
/** One piece of a row; an array is drawn with no gap between its spans. */
export type Item = Span | Span[]
export type RowButton = { key: string; label: string; act: string }
export type Row = { items: Item[]; button?: RowButton }
export type Band = { think: boolean; rows: [Row, Row, Row] }
export type BandOptions = {
  assurance: Assurance
  /** Files changed and untested: shown with a button (offer) or as Claude's next job (auto). */
  change?: { files: number; mode: 'offer' | 'auto' }
  last?: HistoryEntry | null
  now: number
  columns: number
}

const dim = (t: string): Span => ({ t, d: true })
const chip = (t: string, live: boolean): Span => ({ t: ` ${t} `, bg: live ? C.chipRun : C.chipIdle, c: live ? C.purple : C.dim, b: live })
const TONE: Record<Status, string> = { passed: C.mint, failed: C.coral, running: C.cyan, pending: C.dim }

/** One coloured cell per test; neighbours of one colour share a span. Past 40 tests, a proportional bar. */
export function cells(states: readonly Status[], width = 40): Span[] {
  if (states.length > 40) {
    const order: Status[] = ['passed', 'failed', 'running', 'pending']
    const out: Span[] = []
    let used = 0
    for (const s of order) {
      const n = states.filter(x => x === s).length
      if (!n) continue
      const w = Math.max(1, Math.round((n / states.length) * width))
      out.push({ t: (s === 'pending' ? '░' : '█').repeat(Math.min(w, width - used)), c: TONE[s] })
      used += w
    }
    return out
  }
  const out: Span[] = []
  for (const s of states) {
    const glyph = s === 'pending' ? '□' : '■'
    const last = out[out.length - 1]
    if (last && last.c === TONE[s]) last.t += glyph
    else out.push({ t: glyph, c: TONE[s] })
  }
  return out
}

export function bar(width: number, fraction: number, color: string): Span[] {
  const on = Math.round(width * Math.min(1, Math.max(0, fraction)))
  return [
    { t: '━'.repeat(on), c: color },
    { t: '─'.repeat(width - on), c: C.track },
  ]
}

export function assuranceRow(a: Assurance): Row {
  const head: Span = { t: 'assurance', c: C.yellow }
  if (a.state === 'none') return { items: [head, dim('not set up')], button: { key: 'setup', label: 'Set up now', act: 'tab:assure' } }
  if (a.state === 'unknown') return { items: [head] }
  const cases = `${a.useCases.length} use case${a.useCases.length === 1 ? '' : 's'}`
  if (a.provenPct === undefined) return { items: [head, bar(16, a.designedPct / 100, C.yellow), { t: `${a.designedPct}%`, c: C.yellow, b: true }, dim('designed · nothing run yet')] }
  return { items: [head, bar(16, a.provenPct / 100, C.yellow), { t: `${a.provenPct}%`, c: C.yellow, b: true }, dim(`proven · ${cases}`)] }
}

/** "now a 30s · b 28s · +2 more", as many as fit in `room` cells. */
function nowRow(live: readonly Run[], now: number, room: number): Row {
  const items: Item[] = [dim('now')]
  const nameRoom = Math.max(8, Math.min(28, Math.floor(room / 3) - 6))
  let used = 4
  let shown = 0
  for (const r of live) {
    const name = cut(nm(r), nameRoom)
    const time = fmt(elapsed(r, now))
    const need = name.length + time.length + 4
    if (shown > 0 && used + need > room - 9) break
    if (shown > 0) items.push(dim('·'))
    items.push({ t: name }, dim(time))
    used += need
    shown += 1
  }
  if (shown < live.length) items.push(dim(`· +${live.length - shown} more`))
  return { items }
}

function failRow(r: Run, room: number): Row {
  const name = cut(nm(r), Math.max(10, Math.floor(room / 3)))
  const where = r.failure?.where ?? currentStep(r)?.text
  const rest = Math.max(10, room - name.length - 14)
  if (where) return { items: [{ t: `✗ ${name}`, c: C.coral }, dim('failed on'), { t: cut(where, rest) }] }
  // No step to point at (kane-cli refused or stopped early): its own reason says why.
  const why = r.failure?.why
  return { items: [{ t: `✗ ${name}`, c: C.coral }, dim(why ? 'failed:' : 'failed'), ...(why ? [{ t: cut(why, rest) }] : [])] }
}

const newestFailed = (list: readonly Run[]): Run | undefined =>
  [...list].filter(r => r.status === 'failed').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]

/** Runs that share the screen with what is live now: live ones and those that ended since the first of them started. */
function batch(runs: readonly Run[]): Run[] {
  const live = runs.filter(r => isLive(r.status))
  if (live.length === 0) return []
  const from = Math.min(...live.map(r => r.startedAt))
  return runs.filter(r => isLive(r.status) || (r.endedAt ?? 0) >= from)
}

/** The three rows above the prompt. The first state that matches wins. */
export function band(runs: readonly Run[], o: BandOptions): Band {
  const open: RowButton = { key: 'open', label: 'Open', act: 'open' }
  const room = Math.max(30, o.columns)
  const live = runs.filter(r => isLive(r.status))
  const only = live.length === 1 ? live[0] : undefined
  const think = live.some(r => !r.postHoc)

  if (only?.kind === 'testrun' && only.members) {
    const c = tally(only.members)
    const running = only.members.filter(m => m.status === 'running')
    const failed = newestFailed(only.members)
    const counts = c.total > 0 ? [{ t: `${c.passed + c.failed} of ${c.total} tests done`, b: true }, dim(`· ${c.running} running · ${c.pending} left`)] : [dim('planning')]
    return {
      think,
      rows: [
        { items: [chip('suite', true), cells(only.members.map(m => m.status)), ...counts], button: open },
        failed ? failRow(failed, room) : nowRow(running, o.now, room),
        assuranceRow(o.assurance),
      ],
    }
  }

  if (only) {
    if (only.newer) return { think, rows: [{ items: [chip('running', true), { t: cut(nm(only), Math.max(12, room - 24)), b: true }, dim(fmt(elapsed(only, o.now)))], button: open }, { items: [dim('this kane-cli is newer than the mod')] }, assuranceRow(o.assurance)] }
    const step = nowText(only)
    return {
      think,
      rows: [
        { items: [chip('running', true), { t: cut(nm(only), Math.max(12, room - 24)), b: true }, dim(fmt(elapsed(only, o.now)))], button: open },
        { items: [only.waiting ? { t: cut(step, room), c: C.orange } : { t: cut(step, room) }] },
        assuranceRow(o.assurance),
      ],
    }
  }

  if (live.length > 1) {
    const all = leaves(batch(runs))
    const c = tally(all)
    const counts = [c.passed ? `${c.passed} passed` : '', c.failed ? `${c.failed} failed` : '', `${c.running} running`, c.pending ? `${c.pending} waiting` : ''].filter(Boolean).join(' · ')
    const now = nowRow(all.filter(r => r.status === 'running'), o.now, room)
    const failed = newestFailed(all)
    return {
      think,
      rows: [{ items: [chip(`${all.length} runs`, true), cells(all.map(r => r.status)), dim(counts)], button: open }, failed ? failRow(failed, room) : now, assuranceRow(o.assurance)],
    }
  }

  // idle: counts cover runs seen in this session
  const all = leaves(runs)
  const c = tally(all)
  const first: Item[] = [chip('idle', false)]
  if (c.passed) first.push({ t: `✓ ${c.passed} passed`, c: C.mint })
  if (c.passed && c.failed) first.push(dim('·'))
  if (c.failed) first.push({ t: `✗ ${c.failed} failed`, c: C.coral })
  let second: Row = { items: [] }
  const failed = newestFailed(all)
  if (o.change && o.change.mode === 'auto') second = { items: [{ t: `⚠ ${files(o.change.files)} changed, untested`, c: C.orange }, dim('· Claude will test this before it finishes')] }
  else if (o.change) second = { items: [{ t: `⚠ ${files(o.change.files)} changed, untested`, c: C.orange }], button: { key: 'test', label: 'Test this change', act: 'offer' } }
  else if (failed) second = failRow(failed, room)
  else if (all.length === 0 && o.last) second = { items: [dim('last run'), o.last.status === 'passed' ? { t: '✓', c: C.mint } : { t: '✗', c: C.coral }, dim(`${cut(nm(o.last), 30)} · ${ago(o.now - o.last.at)}`)] }
  return { think: false, rows: [{ items: first, button: open }, second, assuranceRow(o.assurance)] }
}

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`

/** A row as plain text, for tests and for surfaces that draw no colour. */
export const rowText = (r: Row): string =>
  r.items
    .map(i => (Array.isArray(i) ? i.map(s => s.t).join('') : i.t))
    .concat(r.button ? [`[${r.button.label}]`] : [])
    .join(' ')

// ── the pane ─────────────────────────────────────────────────────────────

export const ORDER: Record<Status, number> = { failed: 0, running: 1, passed: 2, pending: 3 }

/** A card's second line. */
export function summary(r: Run): string {
  if (r.status === 'running') return nowText(r)
  if (r.status === 'passed') return ['passed', `${r.steps.filter(s => s.text || s.status !== 'pending').length} steps`, r.credits !== undefined ? `${Math.round(r.credits * 10) / 10} credits` : ''].filter(Boolean).join(' · ')
  if (r.status === 'failed') return r.failure?.where ? `failed · ${r.failure.where}` : 'failed'
  return 'waiting to start'
}

/** "product bug · major · 90% sure", from the verdict's own fields only. */
export function kindLine(r: Run): string | undefined {
  const f = r.failure
  if (!f) return undefined
  const parts = [f.category?.replace(/_/g, ' '), f.severity, f.confidence !== undefined ? `${Math.round(f.confidence * 100)}% sure` : undefined].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

// ── assurance ────────────────────────────────────────────────────────────

/** `kane-cli cover gaps --json` → what the band and the pane show. */
export function parseCoverGaps(text: string): Assurance {
  const start = text.indexOf('{')
  if (start === -1) return { state: 'unknown' }
  let o: Record<string, any>
  try {
    o = JSON.parse(text.slice(start))
  } catch {
    return { state: 'unknown' }
  }
  const pct = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined)
  const proven = o.proven && typeof o.proven === 'object' ? o.proven : undefined
  const started = Date.parse(String(proven?.latest_run?.started_at ?? ''))
  const useCases: UseCase[] = (Array.isArray(o.usecases) ? o.usecases : []).map((u: Record<string, any>) => {
    const pending: Record<string, any>[] = Array.isArray(u.pending) ? u.pending : []
    return {
      id: String(u.id ?? u.title ?? 'use case'),
      designed: pct(u.design_completeness?.pct) ?? 0,
      proven: pct(u.proven?.pct),
      stale: typeof u.stale_acs === 'number' ? u.stale_acs : 0,
      toDesign: pending.filter(p => p.stage === 'design').length,
      toCover: pending.filter(p => p.stage === 'cover').length,
    }
  })
  return {
    state: 'ready',
    designedPct: pct(o.design_completeness?.pct) ?? 0,
    provenPct: pct(proven?.pct),
    failing: typeof proven?.failing === 'number' ? proven.failing : undefined,
    blocked: typeof proven?.blocked === 'number' ? proven.blocked : undefined,
    lastRunAt: Number.isFinite(started) ? started : undefined,
    useCases,
  }
}

/** A use case's debt, each with its colour: "1 stale", "2 to design", "3 to run". */
export function debt(u: UseCase): Span[] {
  const out: Span[] = []
  if (u.stale) out.push({ t: `${u.stale} stale`, c: C.orange })
  if (u.toDesign) out.push({ t: `${u.toDesign} to design`, c: C.dim })
  if (u.toCover) out.push({ t: `${u.toCover} to run`, c: C.dim })
  if (!out.length && u.proven === 100) out.push({ t: 'proven', c: C.mint })
  return out
}

// ── what Claude ran ──────────────────────────────────────────────────────

/** The run a Bash command starts, named from its own words: the best label kane-cli's runs can get. */
export function labelFromCommand(command: string): { label: string; surface: Kind } | undefined {
  const at = command.search(/\bkane-cli\b/)
  if (at === -1) return undefined
  const rest = command.slice(at)
  const md = rest.match(/\btestmd\s+run\s+(["']?)([^"'\s]+)\1/)
  if (md) return { label: base(md[2]!), surface: 'testmd' }
  const suite = rest.match(/\btestrun\s+run\b([^|;&\n]*)/)
  if (suite) {
    const flags = (suite[1] ?? '').match(/--(tags|from-context|filter)\s+(\S+)/)
    return { label: flags ? `suite · --${flags[1]} ${flags[2]}` : 'suite', surface: 'testrun' }
  }
  const run = rest.match(/\brun\s+(["'])([\s\S]*?)\1/)
  if (run && !/\b(testmd|testrun)\b/.test(rest.slice(0, run.index))) return { label: run[2]!.trim(), surface: 'run' }
  return undefined
}

// ── after Claude changes code ────────────────────────────────────────────

/** Edits that never need a browser test: docs, kane's own stores, tool folders. `path` is relative to the project. */
export function isTrackedEdit(path: string): boolean {
  if (/\.(md|mdx|markdown|txt|rst|adoc)$/i.test(path)) return false
  if (/(^|\/)(docs?|\.testmuai|\.context|\.claude|\.git|node_modules)\//.test(path)) return false
  return true
}

const GENERIC = new Set(['src', 'app', 'lib', 'index', 'main', 'utils', 'util', 'components', 'component', 'pages', 'page', 'test', 'tests', 'spec', 'hooks', 'types', 'tsx', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'html', 'json', 'the', 'and', 'for', 'with', 'helpers', 'helper', 'common', 'shared', 'core'])

/** Feature words in a path: "src/checkout/AddressForm.tsx" → checkout, address, form. */
export function featureWords(path: string): string[] {
  const words = path
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w))
  return [...new Set(words)]
}

/** Saved tests that mention a changed file's feature, best match first. */
export function savedTestsFor(changed: readonly string[], saved: readonly { name: string; text: string }[]): string[] {
  const words = [...new Set(changed.flatMap(featureWords))]
  if (!words.length) return []
  return saved
    .map(t => {
      const hay = `${t.name} ${t.text}`.toLowerCase()
      return { name: t.name, hits: words.filter(w => new RegExp(`\\b${w}`).test(hay)).length }
    })
    .filter(t => t.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map(t => t.name)
}

/** The start page the saved tests use most: kane-cli needs one when it has no default URL. */
export function startUrl(saved: readonly { text: string }[]): string | undefined {
  const count = new Map<string, number>()
  for (const t of saved) for (const m of t.text.matchAll(/https?:\/\/[^\s)"'`<>]+/g)) count.set(m[0], (count.get(m[0]) ?? 0) + 1)
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** What Claude is asked when the offer card opens. */
export function draftPrompt(files: readonly string[], diff: string): string {
  return [
    'Draft one browser test objective for the change below, for kane-cli (KaneAI) to run.',
    'One or two plain sentences: what a user does, and what must be true at the end. No preamble, no quotes, no code.',
    '',
    `Changed files: ${files.join(', ')}`,
    diff ? `\nDiff:\n${diff}` : '',
  ].join('\n')
}

/** The reply's objective: its first non-empty lines, without quotes or a leading label. */
export function objectiveFrom(reply: string): string {
  // The first paragraph: a fork can add a remark about the conversation after it.
  return (reply.trim().split(/\n\s*\n/)[0] ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
    .replace(/^(objective|test objective)\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()
}
