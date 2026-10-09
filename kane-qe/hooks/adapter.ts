// kane-cli's NDJSON wire → small internal events. The only file where raw wire field names appear.
// The contract only ever adds: unknown types and fields are skipped, a line that is not JSON is counted.

import type { Kind } from '../types'

export type Ev =
  | { k: 'start'; surface?: Kind; cli?: string; pid?: number; at: number }
  | { k: 'newer'; at: number }
  | { k: 'label'; text: string; rank: number; at: number }
  | { k: 'step'; n: number; status: 'running' | 'done' | 'failed' | 'stopped'; text: string; at: number }
  | { k: 'ask'; question: string; at: number }
  | { k: 'error'; message: string; at: number }
  | { k: 'runEnd'; status: 'passed' | 'failed'; credits?: number; why?: string; category?: string; severity?: string; confidence?: number; at: number }
  | { k: 'mdStepStart'; index: number; heading: string; at: number }
  | { k: 'runStart'; objective?: string; target?: string; at: number }
  | { k: 'detail'; kind: 'think' | 'act' | 'check'; text: string; ok?: boolean; at: number }
  | { k: 'mdStepEnd'; index: number; status: string; at: number }
  | { k: 'mdDone'; status: string; at: number }
  | { k: 'plan'; members: string[]; at: number }
  | { k: 'memberStart'; path: string; logPath?: string; at: number }
  | { k: 'progress'; running: string[]; pending: number; done: number; total: number; at: number }
  | { k: 'memberEnd'; path: string; status: string; durationS?: number; logPath?: string; why?: string; at: number }
  | { k: 'suiteDone'; status: string; at: number }
  | { k: 'postHoc' }

/** Label sources, weakest first: a stronger one replaces a weaker one. */
export const RANK = { firstStep: 1, objective: 2, recording: 3, command: 4 } as const

type Json = Record<string, unknown>
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const time = (o: Json, fallback: number): number => {
  const t = Date.parse(String(o.ts ?? ''))
  return Number.isFinite(t) ? t : fallback
}

/** Splits text into whole lines; a tail with no newline yet is handed back to wait for the rest. */
export function splitLines(text: string): { lines: string[]; rest: string } {
  const end = text.lastIndexOf('\n')
  if (end === -1) return { lines: [], rest: text }
  return { lines: text.slice(0, end).split('\n').filter(l => l.trim() !== ''), rest: text.slice(end + 1) }
}

/** One wire line → its events (most lines give one, unknown ones none). `bad` is set for a line that is not JSON. */
export function adapt(line: string, now = 0): { events: Ev[]; bad?: true } {
  let o: Json
  try {
    const parsed: unknown = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { events: [], bad: true }
    o = parsed as Json
  } catch {
    return { events: [], bad: true }
  }
  const at = time(o, now)
  if (o.v !== undefined && o.v !== 1) return { events: [{ k: 'newer', at }] }
  const out = one(o, at)
  if (o.post_hoc === true) out.unshift({ k: 'postHoc' })
  return { events: out }
}

function surfaceOf(v: unknown): Kind | undefined {
  return v === 'run' || v === 'testmd' || v === 'testrun' ? v : undefined
}

function one(o: Json, at: number): Ev[] {
  const type = str(o.type)
  // Surface `run` step lines carry no type.
  if (type === undefined) {
    const n = num(o.step)
    if (n === undefined || o.child_id !== undefined) return []
    const s = o.status
    const status = s === 'running' || s === 'done' || s === 'failed' || s === 'stopped' ? s : undefined
    if (!status) return []
    return [{ k: 'step', n, status, text: str(o.remark) ?? '', at }]
  }
  switch (type) {
    case 'stream_start':
      return [{ k: 'start', surface: surfaceOf(o.surface), cli: str(o.cli_version), pid: num(o.pid), at }]
    case 'recording_state': {
      const path = str(o.test_path)
      const text = path ? (path.split('/').pop() ?? path) : str(o.session_name)
      return text ? [{ k: 'label', text, rank: RANK.recording, at }] : []
    }
    case 'bifurcation': {
      // "Navigate to <url> then <objective>": the objective is the best name the run surface gives.
      const flows = Array.isArray(o.flows) ? o.flows : []
      const flow = str(flows[0])
      if (!flow) return []
      const objective = flow.replace(/^Navigate to \S+ then /i, '').split('\n')[0]!.trim()
      return objective ? [{ k: 'label', text: objective, rank: RANK.objective, at }] : []
    }
    case 'ask_user': {
      const q = str(o.question)
      return q ? [{ k: 'ask', question: q, at }] : []
    }
    case 'error': {
      const m = str(o.message)
      return m ? [{ k: 'error', message: m, at }] : []
    }
    case 'run_end': {
      const status = o.status === 'passed' ? 'passed' : o.status === 'failed' ? 'failed' : undefined
      if (!status) return []
      const v = o.verdict && typeof o.verdict === 'object' ? (o.verdict as Json) : {}
      const why = str(v.root_cause) ?? str(v.one_liner) ?? str(o.one_liner) ?? str(o.reason)
      return [
        {
          k: 'runEnd',
          status,
          credits: num(o.credits_consumed),
          why,
          category: str(v.category),
          severity: str(v.severity),
          confidence: num(v.confidence),
          at,
        },
      ]
    }
    case 'test_md_step_start': {
      const index = num(o.step_index)
      return index === undefined ? [] : [{ k: 'mdStepStart', index, heading: str(o.heading) ?? '', at }]
    }
    case 'run_start': {
      const env = o.environment && typeof o.environment === 'object' ? (o.environment as Json) : {}
      const device = env.device && typeof env.device === 'object' ? (env.device as Json) : {}
      const model = str(device.model)
      const os = str(device.os_version)
      const target = model ? [model, os].filter(Boolean).join(' · ') : undefined
      return [{ k: 'runStart', objective: str(o.objective), target, at }]
    }
    case 'step_event': {
      if (o.child_id !== undefined) return []
      const detail = str(o.detail) ?? ''
      if (o.event === 'reasoning') return detail ? [{ k: 'detail', kind: 'think', text: detail, at }] : []
      if (o.event === 'action') {
        const kind = str(o.action_type)
        return detail ? [{ k: 'detail', kind: 'act', text: kind ? `${kind}: ${detail}` : detail, at }] : []
      }
      if (o.event === 'assertion') return detail ? [{ k: 'detail', kind: 'check', text: detail, ok: o.passed !== false, at }] : []
      return []
    }
    case 'test_md_step_end': {
      const index = num(o.step_index)
      return index === undefined ? [] : [{ k: 'mdStepEnd', index, status: str(o.status) ?? 'passed', at }]
    }
    case 'test_md_done':
      return [{ k: 'mdDone', status: str(o.overall_status) ?? 'failed', at }]
    case 'testrun_plan': {
      const members = Array.isArray(o.members) ? o.members.map(m => str((m as Json | null)?.path)).filter((p): p is string => !!p) : []
      return [{ k: 'plan', members, at }]
    }
    case 'testrun_member_start': {
      const path = str(o.path)
      return path ? [{ k: 'memberStart', path, logPath: str(o.log_path), at }] : []
    }
    case 'testrun_progress': {
      const running = Array.isArray(o.running) ? o.running.map(str).filter((p): p is string => !!p) : []
      return [{ k: 'progress', running, pending: num(o.pending) ?? 0, done: num(o.done) ?? 0, total: num(o.total) ?? 0, at }]
    }
    case 'testrun_member_end': {
      const path = str(o.path)
      if (!path) return []
      const failure = o.failure && typeof o.failure === 'object' ? (o.failure as Json) : {}
      return [{ k: 'memberEnd', path, status: str(o.status) ?? 'failed', durationS: num(o.duration_s), logPath: str(o.log_path), why: str(failure.message), at }]
    }
    case 'testrun_done':
      return [{ k: 'suiteDone', status: str(o.overall_status) ?? 'failed', at }]
    default:
      return []
  }
}
