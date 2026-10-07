// Pure kane-cli helpers: argv building and the NDJSON stream reducer.
// No `$` here, so tests can drive it directly.
import type { KaneHistoryEntry, KaneRun, KaneRunKind, KaneRunStatus, KaneTest } from '../types'

type Json = Record<string, unknown>

export type RunOptions = {
  objective: string
  url?: string
  headless?: boolean
  maxSteps?: number
  timeoutSeconds?: number
  variables?: Record<string, unknown>
  name?: string
  mode?: 'action' | 'testing'
  assertionMode?: 'dom' | 'visual'
  finalValidation?: boolean
  bugDetection?: 'off' | 'stop' | 'continue'
  codeExport?: boolean
  codeLanguage?: 'python' | 'javascript'
  /** A virtual device on this machine instead of desktop Chrome (macOS Apple Silicon). */
  target?: 'desktop' | 'emulator' | 'simulator'
  deviceName?: string
  osVersion?: string
  /** The app under test: a local build (.apk / .zip) or an uploaded APP… id. */
  app?: string
  variablesFile?: string
}

export type TestOptions = {
  path: string
  headless?: boolean
  author?: boolean
  adaptiveHeal?: boolean
  timeoutSeconds?: number
}

export type SuiteOptions = {
  paths?: string[]
  tags?: string
  match?: string
  parallel?: number
  failFast?: boolean
  headless?: boolean
  dryRun?: boolean
  /** Dispatch the suite to the HyperExecute grid (needs the remote-execution plugin). */
  remote?: boolean
  deviceName?: string
  osVersion?: string
}

export function splitCommand(command: string): string[] {
  const parts = command.trim().split(/\s+/).filter(Boolean)
  return parts.length > 0 ? parts : ['kane-cli']
}

export function runArgs(o: RunOptions): string[] {
  const a = ['run', o.objective, '--agent']
  if (o.url) a.push('--url', o.url)
  if (o.headless) a.push('--headless')
  if (o.maxSteps) a.push('--max-steps', String(o.maxSteps))
  if (o.timeoutSeconds) a.push('--timeout', String(o.timeoutSeconds))
  if (o.variables && Object.keys(o.variables).length > 0) a.push('--variables', JSON.stringify(o.variables))
  if (o.name) a.push('--name', o.name)
  if (o.mode) a.push('--mode', o.mode)
  if (o.assertionMode) a.push('--assertion-mode', o.assertionMode)
  if (o.finalValidation !== undefined) a.push('--final-validation', o.finalValidation ? 'on' : 'off')
  if (o.bugDetection) a.push('--bug-detection', o.bugDetection)
  if (o.codeExport) {
    a.push('--code-export')
    if (o.codeLanguage) a.push('--code-language', o.codeLanguage)
  }
  if (o.target && o.target !== 'desktop') a.push('--target', o.target)
  if (o.deviceName) a.push('--device-name', o.deviceName)
  if (o.osVersion) a.push('--os-version', o.osVersion)
  if (o.app) a.push('--app', o.app)
  if (o.variablesFile) a.push('--variables-file', o.variablesFile)
  return a
}

export function testArgs(o: TestOptions): string[] {
  const a = ['testmd', 'run', o.path, '--agent']
  if (o.headless) a.push('--headless')
  if (o.author) a.push('--author')
  if (o.adaptiveHeal === false) a.push('--no-adaptive-heal')
  if (o.timeoutSeconds) a.push('--timeout', String(o.timeoutSeconds))
  return a
}

/** kane-cli 0.8 refuses `--agent` on `testrun` (it streams NDJSON whenever stdout is not a terminal). */
export function kaneArgv(args: readonly string[]): string[] {
  return args[0] === 'testrun' ? args.filter(a => a !== '--agent') : [...args]
}

export function suiteArgs(o: SuiteOptions): string[] {
  const a = ['testrun', 'run', ...(o.paths ?? [])]
  if (o.tags) a.push('--tags', o.tags)
  if (o.match) a.push('--match', o.match)
  if (o.parallel && o.parallel > 1) a.push('--parallel', String(o.parallel))
  if (o.failFast) a.push('--on-failure', 'fail-fast')
  // Every grid member runs headless already.
  if (o.headless && !o.remote) a.push('--headless')
  if (o.remote) a.push('--remote')
  if (o.deviceName) a.push('--device-name', o.deviceName)
  if (o.osVersion) a.push('--os-version', o.osVersion)
  if (o.dryRun) a.push('--dry-run')
  return a
}

export function newRun(id: string, kind: KaneRunKind, label: string, source: KaneRun['source'], startedAt: number): KaneRun {
  return { id, kind, label, source, status: 'running', startedAt, steps: [], warnings: [], errors: [], stderrTail: [] }
}

/** Splits buffered stream text into complete lines, returning the unfinished remainder. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.map(l => l.trim()).filter(Boolean), rest }
}

export function parseLine(line: string): Json | undefined {
  if (!line.startsWith('{')) return undefined
  try {
    const v: unknown = JSON.parse(line)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined
  } catch {
    return undefined
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function upsertStep(steps: KaneRun['steps'], n: number, status: string, text?: string): KaneRun['steps'] {
  const i = steps.findIndex(s => s.n === n)
  if (i === -1) return [...steps, { n, status, text: text ?? '' }].sort((a, b) => a.n - b.n)
  const next = [...steps]
  const prev = next[i]!
  next[i] = { n, status, text: text ?? prev.text }
  return next
}

function statusOf(v: unknown): KaneRunStatus | undefined {
  if (v === 'passed' || v === 'pass' || v === 'success') return 'passed'
  if (v === 'failed' || v === 'fail' || v === 'broken') return 'failed'
  if (v === 'cancelled' || v === 'interrupted') return 'cancelled'
  return undefined
}

/** Folds one NDJSON event (run / testmd / testrun surfaces) into the run view. */
export function applyEvent(run: KaneRun, e: Json): KaneRun {
  const type = str(e.type)

  // `run --agent` step lines carry no `type`: detect them by `step`.
  if (type === undefined && typeof e.step === 'number') {
    return { ...run, steps: upsertStep(run.steps, e.step, str(e.status) ?? 'running', str(e.remark)) }
  }

  switch (type) {
    case 'stream_start':
      return { ...run, pid: num(e.pid) ?? run.pid, sessionDir: str(e.session_dir) ?? run.sessionDir }
    case 'warning':
      return { ...run, warnings: [...run.warnings, str(e.message) ?? String(e.code ?? 'warning')].slice(-5) }
    case 'error':
      return { ...run, errors: [...run.errors, str(e.message) ?? 'error'].slice(-5) }
    case 'test_md_step_start': {
      const n = (num(e.step_index) ?? run.steps.length) + 1
      return { ...run, steps: upsertStep(run.steps, n, 'running', str(e.heading)) }
    }
    case 'test_md_step_end': {
      const n = (num(e.step_index) ?? 0) + 1
      return { ...run, steps: upsertStep(run.steps, n, str(e.status) ?? 'done') }
    }
    case 'testrun_plan': {
      const members = Array.isArray(e.members) ? (e.members as Json[]) : []
      // An invalid plan is kane's only word on why a suite cannot start: say it plainly.
      if (e.valid === false) {
        const issues = [e.errors, e.issues, e.problems].flatMap(x => (Array.isArray(x) ? x : [])).map(x => (typeof x === 'string' ? x : str((x as Json).message) ?? JSON.stringify(x)))
        const why = members.length === 0 ? 'No saved *_test.md tests matched this selection in this folder (check --match / --tags, or save a test first).' : 'kane-cli rejected the suite plan.'
        return { ...run, steps: members.map((m, i) => ({ n: i + 1, status: 'pending', text: str(m.path) ?? `member ${i + 1}` })), errors: [...run.errors, why, ...issues].slice(-5) }
      }
      return { ...run, steps: members.map((m, i) => ({ n: i + 1, status: 'pending', text: str(m.path) ?? `member ${i + 1}` })) }
    }
    // Never-recorded members (a freshly designed test) are authored, with their own pair of events.
    case 'testrun_member_start':
    case 'testrun_member_end':
    case 'testrun_authored_member_start':
    case 'testrun_authored_member_end': {
      const path = str(e.path) ?? '?'
      // The plan names members by absolute path, the end events by project-relative path.
      const i = run.steps.findIndex(s => s.text === path || s.text.endsWith(`/${path}`) || path.endsWith(`/${s.text}`))
      const n = i === -1 ? run.steps.length + 1 : run.steps[i]!.n
      const status = type.endsWith('_start') ? 'running' : (str(e.status) ?? 'done')
      // Keep the plan's name for a known member, so every later event still finds it.
      const steps = upsertStep(run.steps, n, status, i === -1 ? path : undefined).map(s =>
        s.n !== n ? s : { ...s, log: str(e.log_path) ?? s.log, detail: type.endsWith('_start') ? s.detail : undefined },
      )
      return { ...run, steps }
    }
    // `--stream-members`: one member's own event, wrapped. Its latest step becomes the row's detail.
    case 'testrun_member_event': {
      const member = (e.member ?? {}) as Json
      const inner = (e.event ?? {}) as Json
      const path = str(member.path)
      const detail = memberDetail(inner)
      if (!path || !detail) return run
      const i = run.steps.findIndex(s => s.text === path || s.text.endsWith(`/${path}`) || path.endsWith(`/${s.text}`))
      if (i === -1) return run
      return { ...run, steps: run.steps.map((s, k) => (k === i ? { ...s, detail } : s)) }
    }
    case 'testrun_progress':
      return { ...run, progress: `${num(e.done) ?? 0}/${num(e.total) ?? '?'} done · ${num(e.pending) ?? 0} pending` }
    case 'run_end': {
      // testmd emits one run_end per step; only the plain `run` surface ends on it.
      if (run.kind !== 'run') return run
      const s = statusOf(e.status)
      const reason = str(e.reason)
      const isCancel = reason !== undefined && /cancel|timeout/i.test(reason)
      // kane reports some setup refusals ("No start URL provided") as a failed run with
      // no step and no credits spent: that is an error to fix, not a test that failed.
      const credits = num(e.credits_consumed)
      const isSetupFailure = s === 'failed' && run.steps.length === 0 && (credits === undefined || credits === 0)
      // Out of credits mid-run: the account stopped it, the test did not fail.
      const isOutOfCredits = reason !== undefined && OUT_OF_CREDITS.test(reason)
      return {
        ...run,
        status: isCancel ? 'cancelled' : isSetupFailure || isOutOfCredits ? 'error' : (s ?? run.status),
        oneLiner: isOutOfCredits ? 'Out of KaneAI credits: the run stopped before testing anything. Top up, then rerun.' : (str(e.one_liner) ?? run.oneLiner),
        summary: str(e.summary) ?? run.summary,
        reason: reason ?? run.reason,
        durationS: num(e.duration) ?? run.durationS,
        credits: num(e.credits_consumed) !== undefined ? Math.round(num(e.credits_consumed)! * 100) / 100 : run.credits,
        testUrl: str(e.test_url) ?? run.testUrl,
        sessionDir: str(e.session_dir) ?? run.sessionDir,
        runDir: str(e.run_dir) ?? run.runDir,
        finalState:
          e.final_state && typeof e.final_state === 'object' && Object.keys(e.final_state).length > 0
            ? (e.final_state as Record<string, unknown>)
            : run.finalState,
      }
    }
    case 'test_md_summary':
      return { ...run, durationS: num(e.duration_s) ?? run.durationS }
    case 'test_md_done':
    case 'testrun_done':
      return { ...run, status: statusOf(e.overall_status) ?? run.status, durationS: num(e.duration_s) ?? run.durationS }
    // A `--remote` suite wraps the testrun stream in these.
    case 'remote_start':
      return { ...run, progress: `dispatching to the grid (${str(e.backend) ?? 'hyper'})…`, remoteJob: { ...run.remoteJob, log: str(e.log_path) } }
    case 'remote_device':
      return { ...run, device: [str(e.name), str(e.os_version)].filter(Boolean).join(' ') || run.device }
    case 'remote_app':
      return { ...run, warnings: [...run.warnings, `app ${basename(str(e.path))} → ${str(e.app_id) || '(dry run)'} (${str(e.source) ?? 'uploaded'})`].slice(-5) }
    case 'remote_dispatched':
      // An empty job id means HyperExecute refused the dispatch; the reason is only in its log.
      return str(e.job_id)
        ? { ...run, remoteJob: { ...run.remoteJob, id: str(e.job_id), url: str(e.job_url) }, progress: 'running on the HyperExecute grid' }
        : { ...run, progress: 'the grid did not accept the job' }
    case 'remote_error':
      return { ...run, errors: [...run.errors, `${str(e.detail) ?? 'the grid refused this selection'}${str(e.code) ? ` [${str(e.code)}]` : ''}`].slice(-5) }
    case 'remote_done':
      return {
        ...run,
        status: statusOf(e.overall_status ?? e.status) ?? run.status,
        remoteJob: { ...run.remoteJob, id: str(e.job_id) ?? run.remoteJob?.id },
        durationS: num(e.duration_s) ?? run.durationS,
      }
    default:
      return run
  }
}

/** One line of a suite member's progress from its own event, or undefined when the event says nothing new. */
export function memberDetail(e: Json): string | undefined {
  const type = str(e.type)
  if (type === 'step_end') return `step ${num(e.index) ?? '?'} ${str(e.status) === 'failed' ? '✗' : '✓'} ${tidyStep(str(e.summary) ?? '')}`.trim()
  if (type === 'step_start') return `step ${num(e.index) ?? '?'} …`
  if (type === 'test_md_step_start') return `${str(e.heading) ?? `section ${(num(e.step_index) ?? 0) + 1}`} …`
  // A replayed (`run --agent`-shaped) step line has no type.
  if (type === undefined && typeof e.step === 'number') return `step ${e.step} ${str(e.status) === 'failed' ? '✗' : str(e.status) === 'running' ? '…' : '✓'} ${tidyStep(str(e.remark) ?? '')}`.trim()
  if (type === 'run_end') return str(e.one_liner) ?? undefined
  return undefined
}

/** Why HyperExecute refused a job, from its log ("Error: ERR::DIS::RESP  Unable to dispatch job. …"). */
export function remoteFailure(log: string): string | undefined {
  const lines = log.split('\n').map(l => l.trim()).filter(Boolean)
  const hit = [...lines].reverse().find(l => /^Error:|\berror\s+ERR::/.test(l))
  return hit?.replace(/^Error:\s*/, '').replace(/^.*?\berror\s+(?=ERR::)/, '').replace(/^ERR::[A-Z:]+\s+/, '').trim() || undefined
}

export const OUT_OF_CREDITS = /credits? exhausted|insufficient credits|out of credits/i

/** Settles the run once the process has exited, using kane-cli's exit-code contract. */
export function finishRun(run: KaneRun, exitCode: number, endedAt: number): KaneRun {
  let status: KaneRunStatus = run.status
  if (status === 'running') {
    // Exit 1 with no step and no verdict is a setup failure (e.g. not logged in), not a failed test.
    const isSetupFailure = exitCode === 1 && run.steps.length === 0 && run.oneLiner === undefined
    status = exitCode === 0 ? 'passed' : exitCode === 1 && !isSetupFailure ? 'failed' : exitCode === 3 ? 'cancelled' : 'error'
  } else if (exitCode === 2 && status !== 'cancelled') {
    status = 'error'
  }
  const durationS = run.durationS ?? Math.round((endedAt - run.startedAt) / 1000)
  // Steps still "running" when the process is gone never finished: do not leave them spinning.
  const steps = run.steps.map(s => (s.status === 'running' ? { ...s, status: 'cancelled' } : s))
  return { ...run, status, exitCode, endedAt, durationS, steps }
}

export function toHistory(run: KaneRun, rerun: string[]): KaneHistoryEntry {
  return {
    id: run.id,
    kind: run.kind,
    label: run.label,
    status: run.status,
    oneLiner: run.oneLiner,
    durationS: run.durationS,
    credits: run.credits,
    testUrl: run.testUrl,
    sessionDir: run.sessionDir,
    endedAt: run.endedAt ?? run.startedAt,
    rerun,
  }
}

export const ICON: Record<string, string> = {
  running: '◐',
  pending: '·',
  done: '✓',
  passed: '✓',
  failed: '✗',
  broken: '✗',
  error: '!',
  stopped: '■',
  cancelled: '■',
  interrupted: '■',
}

export const COLOR: Record<string, string> = {
  running: 'cyan',
  passed: 'green',
  done: 'green',
  failed: 'red',
  broken: 'red',
  error: 'red',
  cancelled: 'yellow',
  stopped: 'yellow',
  interrupted: 'yellow',
}

/** A compact, model-readable report of a finished run. */
export function report(run: KaneRun): string {
  const lines: string[] = []
  lines.push(`kane-cli ${run.kind} ${run.status.toUpperCase()} (exit ${run.exitCode ?? '?'}) — ${run.label}`)
  if (run.oneLiner) lines.push(`One-liner: ${run.oneLiner}`)
  if (run.summary && run.summary !== run.oneLiner) lines.push(`Summary: ${run.summary}`)
  if (run.reason) lines.push(`Reason: ${run.reason}`)
  const facts = [
    run.durationS !== undefined ? `duration ${run.durationS}s` : undefined,
    run.credits !== undefined ? `credits ${run.credits}` : undefined,
    `${run.steps.length} steps`,
  ].filter(Boolean)
  lines.push(facts.join(' · '))
  if (run.steps.length > 0) {
    lines.push('Steps:')
    for (const s of run.steps.slice(-40)) lines.push(`  ${s.n}. [${s.status}] ${s.text}`)
  }
  if (run.finalState) lines.push(`Extracted values (final_state): ${JSON.stringify(run.finalState)}`)
  if (run.warnings.length) lines.push(`Warnings: ${run.warnings.join(' | ')}`)
  if (run.errors.length) lines.push(`Errors: ${run.errors.join(' | ')}`)
  if (run.testUrl) lines.push(`Test Manager: ${run.testUrl}`)
  if (run.remoteJob?.url || run.remoteJob?.id) lines.push(`HyperExecute job: ${run.remoteJob.url ?? run.remoteJob.id}${run.device ? ` · device ${run.device}` : ''}`)
  if (run.sessionDir) {
    lines.push(`Session dir: ${run.sessionDir}`)
    lines.push(`  ${ARTIFACTS}`)
  }
  if (run.status === 'error' && run.stderrTail.length) lines.push(`stderr tail:\n${run.stderrTail.join('\n')}`)
  return lines.join('\n')
}

/** What a kane-cli 0.8.x session dir holds, for whoever debugs a run. */
export const ARTIFACTS =
  'artifacts: execution.json (per-step instructions, results, timings), events.ndjson (the stream), tui.log, runner-stderr.log, ' +
  'evidence/*.evidence (pack: `kane-cli evidence validate|serve`), code-export/test.py (exported Playwright test)'

export function parseTests(stdout: string): KaneTest[] {
  const out: KaneTest[] = []
  for (const line of stdout.split('\n')) {
    const e = parseLine(line.trim())
    if (!e || typeof e.path !== 'string') continue
    out.push({
      path: e.path,
      name: str(e.name) ?? e.path,
      tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : [],
      synced: e.synced === true,
      hasMeta: e.has_meta === true,
    })
  }
  return out
}

/** `config show --agent` prints one JSON object; keep its scalar values as strings. */
export function parseConfig(stdout: string): Record<string, string> {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end <= start) return {}
  const obj = parseLine(stdout.slice(start, end + 1))
  if (!obj) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue
    // Switches come back as booleans; the CLI's setters speak on/off.
    out[k] = typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  return out
}

/** `/kane-run https://site.com Log in and assert …` → url + objective. */
export function parseRunArgs(args: string): { url?: string; objective: string } {
  const trimmed = args.trim()
  const m = /^(https?:\/\/\S+)\s+([\s\S]+)$/.exec(trimmed)
  if (m) return { url: m[1], objective: m[2]!.trim() }
  return { objective: trimmed }
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function clip(text: string, width: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= width ? one : `${one.slice(0, Math.max(1, width - 1))}…`
}

/** The pointer kane-cli writes at ~/.testmuai/kaneai/sessions/active/<pid>.json while a run is live. */
export type ActivePointer = {
  pid: number
  cwd?: string
  surface?: string
  session_dir: string
  started?: string
  host_agent?: string
}

export function parsePointer(text: string): ActivePointer | undefined {
  const o = parseLine(text.trim())
  if (!o || typeof o.pid !== 'number' || typeof o.session_dir !== 'string') return undefined
  return {
    pid: o.pid,
    cwd: str(o.cwd),
    surface: str(o.surface),
    session_dir: o.session_dir,
    started: str(o.started),
    host_agent: str(o.host_agent),
  }
}

/** A human label from a stream event, when the event names what is being run. */
export function labelFromEvent(e: Json): string | undefined {
  if (e.type === 'run_start') return str(e.objective)
  // kane-cli 0.8 names the objective first in its plan: "Navigate to <url> then <objective>".
  if (e.type === 'bifurcation' && Array.isArray(e.flows) && typeof e.flows[0] === 'string') {
    return (e.flows[0] as string).replace(/^Navigate to \S+ then\s+/i, '').trim() || undefined
  }
  if (e.type === 'recording_state') return str(e.test_path) ?? str(e.session_name)
  if (e.type === 'testrun_plan' && Array.isArray(e.members)) return `suite (${e.members.length} tests)`
  return undefined
}

/** The first objective the session's tui.log recorded (`RUN 1 START objective="…"`). */
export function objectiveFromLog(text: string): string | undefined {
  const m = /RUN \d+ START objective="([^"]*)"/.exec(text)
  return m?.[1] ? m[1] : undefined
}

export function kindOfSurface(surface: string | undefined): KaneRunKind {
  return surface === 'testmd' ? 'testmd' : surface === 'testrun' ? 'testrun' : 'run'
}

export function basename(path: string | undefined): string {
  if (!path) return ''
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

// ── /kane <anything>: one entry point, routed by what was typed ─────────

export type KaneIntent =
  | { kind: 'home' }
  | { kind: 'help' }
  | { kind: 'tab'; tab: 'run' | 'insights' | 'tests' | 'assure' | 'history' | 'setup' }
  | { kind: 'ingest'; source: string }
  | { kind: 'run'; objective: string; url?: string }
  | { kind: 'test'; path: string }
  | { kind: 'suite'; args: string[] }
  | { kind: 'triage' }
  | { kind: 'insights'; query: string }
  | { kind: 'cases'; feature: string }
  | { kind: 'stop' }
  | { kind: 'ask'; text: string }

const QUESTION_WORDS = new Set(['which', 'what', 'why', 'how', 'when', 'who', 'summarize', 'summarise', 'explain', 'compare'])

export function routeKane(raw: string): KaneIntent {
  const text = raw.trim()
  if (!text) return { kind: 'home' }
  const [first = '', ...restWords] = text.split(/\s+/)
  const word = first.toLowerCase()
  const rest = restWords.join(' ')
  const tail = rest.toLowerCase()

  if (['home', 'cockpit', 'open'].includes(word) && !rest) return { kind: 'home' }
  if (word === 'help' || word === '?') return { kind: 'help' }
  if (word === 'insights' && rest) return { kind: 'insights', query: rest }
  if (['insights', 'tests', 'history', 'setup'].includes(word) && !rest) return { kind: 'tab', tab: word as 'insights' | 'tests' | 'history' | 'setup' }
  if (['assure', 'assurance', 'coverage', 'requirements'].includes(word) && !rest) return { kind: 'tab', tab: 'assure' }
  if (word === 'ingest' && rest) return { kind: 'ingest', source: rest }
  // The same suite on the HyperExecute grid.
  if (word === 'grid' || word === 'remote') return { kind: 'suite', args: [...restWords, '--remote'] }
  if (['stop', 'cancel'].includes(word) && !rest) return { kind: 'stop' }
  if (['triage', 'debug'].includes(word) && ['', 'last', 'last failure', 'last run'].includes(tail)) return { kind: 'triage' }
  if (word === 'suite' || word === 'testrun') return { kind: 'suite', args: restWords }
  if ((word === 'cases' || word === 'generate') && rest) return { kind: 'cases', feature: rest }

  // A saved test file, bare or after run/test/replay.
  const isTestFile = (s: string) => /\.md$/i.test(s) && !/\s/.test(s)
  if (isTestFile(text)) return { kind: 'test', path: text }
  if (['run', 'test', 'replay'].includes(word) && isTestFile(rest)) return { kind: 'test', path: rest }

  if (word === 'run' && !rest) return { kind: 'tab', tab: 'run' }
  const objectiveText = word === 'run' ? rest : text

  if (/\?\s*$/.test(objectiveText) || QUESTION_WORDS.has(word)) return { kind: 'ask', text }

  const { url, objective } = parseRunArgs(objectiveText)
  return url ? { kind: 'run', objective, url } : { kind: 'run', objective }
}

export const KANE_HELP = [
  '/kane                               open the cockpit',
  '/kane <objective>                   run it now ("run" in front is optional)',
  '/kane https://site.com <objective>  run it on that URL',
  '/kane path/to/name_test.md          replay a saved test',
  '/kane insights [words]              what a run\'s evidence says (latest, or the newest matching run)',
  '/kane tests | history | setup       open that tab',
  '/kane suite [--tags smoke] [--parallel 3]   run a suite',
  '/kane grid [--tags smoke] [--parallel 4]    run a suite on the HyperExecute cloud grid',
  '/kane assure                        requirements → use cases → designed tests → coverage',
  '/kane ingest <prd.md | Jira/Confluence/Linear/web URL>   start the assurance loop from a requirement',
  '/kane triage                        have Claude diagnose the last failure',
  '/kane cases <feature>               generate test cases with KaneAI',
  '/kane stop                          stop running tests',
  '/kane <question>?                   ask Claude about your kane runs',
].join('\n')

// Namespaces kane-cli fills in itself, so an unset {{…}} there is not a gap.
const BUILTIN_VARS = /^(secrets|global|environment|totp|smart)\./

export type Coaching = { hasNoCheck: boolean; variables: string[] }

/** What a QE would flag before spending credits on an objective. */
export function coachObjective(objective: string): Coaching {
  const hasCheck = /\b(assert|asserts|verify|verifies|check|checks|confirm|ensure|expect|validate|should|must|store|extract|make sure)\b/i.test(objective)
  const variables = [...objective.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map(m => m[1]!).filter(v => !BUILTIN_VARS.test(v))
  return { hasNoCheck: !hasCheck, variables: [...new Set(variables)] }
}

export function needsCoaching(c: Coaching): boolean {
  return c.hasNoCheck || c.variables.length > 0
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** The same run as a CI step: headless, NDJSON, basic auth from the pipeline's secrets. */
export function ciCommand(args: readonly string[]): string {
  const a = kaneArgv(args)
  // `testrun` has no --agent: off a terminal it streams NDJSON by itself.
  if (a[0] !== 'testrun' && !a.includes('--agent')) a.push('--agent')
  if (!a.includes('--headless')) a.push('--headless')
  return ['kane-cli', ...a.map(shellQuote), '--username "$LT_USERNAME" --access-key "$LT_ACCESS_KEY"'].join(' ')
}

// ── identity and credits, as kane-cli prints them for humans ────────────

export type Identity = { user?: string; method?: string; token?: string; profile?: string; env?: string; detail?: string }

/** Reads the `whoami` box (ANSI already stripped): "User  name", "Token  valid", … */
export function parseWhoami(text: string): Identity {
  const field = (name: string) => {
    const m = new RegExp(`${name}\\s{2,}([^│\\n]+?)\\s*(?:│|$)`, 'm').exec(text)
    return m?.[1]?.trim() || undefined
  }
  return { user: field('User'), method: field('Method'), token: field('Token'), profile: field('Profile'), env: field('Environment'), detail: field('Detail') }
}

export function describeIdentity(id: Identity): string | undefined {
  const parts = [id.user, id.method, id.token ? `token ${id.token}` : undefined].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

/** "Available credits: 838.65 / Total credits: 1200" → "838.65 of 1200 credits left". */
export function describeBalance(text: string): string | undefined {
  // An overdrawn account reads below zero (a run can spend past the last credit).
  const available = /Available credits:\s*(-?[\d.,]+)/i.exec(text)?.[1]
  const total = /Total credits:\s*([\d.,]+)/i.exec(text)?.[1]
  if (!available) return undefined
  const n = Number(available.replace(/,/g, ''))
  const shown = Number.isFinite(n) ? String(Math.round(n * 100) / 100) : available
  if (Number.isFinite(n) && n <= 0) return `out of credits (${shown}${total ? ` of ${total}` : ''}): top up before running`
  return total ? `${shown} of ${total} credits left` : `${shown} credits left`
}

/**
 * Whether kane-cli can act for the person. `whoami` never refreshes an expired
 * OAuth access token, while a call that does work (balance) refreshes it, so a
 * working balance outranks a stale whoami.
 */
export function resolveAuth(whoamiExit: number | undefined, balanceExit: number | undefined): 'ok' | 'none' | 'unreachable' | 'unknown' {
  if (whoamiExit === 0 || balanceExit === 0) return 'ok'
  if (whoamiExit === 3) return 'unreachable'
  if (whoamiExit === undefined && balanceExit === undefined) return 'unknown'
  return 'none'
}

// ── fitting long kane-cli text into narrow panes ────────────────────────

/** Step remarks carry planner noise ("PRIMARY: ", "queued plan (2 steps): ") a reader does not need. */
export function tidyStep(text: string): string {
  // A suite member is its test file: the name says enough, the folders do not fit.
  if (/^\/\S+_test\.md$/.test(text.trim())) return text.trim().split('/').pop()!
  return text.replace(/\bPRIMARY:\s*/g, '').replace(/queued plan \(\d+ steps?\):\s*/i, 'plan: ').replace(/\s+/g, ' ').trim()
}

/** A URL value shown as host + path, so it reads in a narrow pane. */
export function shortUrl(value: string): string {
  try {
    const u = new URL(value)
    const path = decodeURIComponent(u.pathname + u.search).replace(/\/$/, '')
    return `${u.host}${path}`
  } catch {
    return value
  }
}

/** Newest first, one entry per run id: lists from several sessions merge instead of overwriting. */
export function mergeHistory<T extends { id: string; endedAt: number }>(a: readonly T[], b: readonly T[], limit = 50): T[] {
  const byId = new Map<string, T>()
  for (const entry of [...b, ...a]) byId.set(entry.id, entry)
  return [...byId.values()].sort((x, y) => y.endedAt - x.endedAt).slice(0, limit)
}

/** Rows a text takes when wrapped at `columns`. */
export function rowsFor(text: string, columns: number): number {
  return Math.max(1, Math.ceil(text.length / Math.max(10, columns)))
}

/** The newest steps whose wrapped rows fit in `budget`, oldest of them first. */
export function fitSteps<T extends { text: string }>(steps: readonly T[], columns: number, budget: number): T[] {
  const kept: T[] = []
  let used = 0
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]! as T & { detail?: string }
    const need = rowsFor(tidyStep(step.text), columns) + (step.detail ? rowsFor(step.detail, columns - 2) : 0)
    if (kept.length > 0 && used + need > budget) break
    kept.unshift(steps[i]!)
    used += need
  }
  return kept
}
