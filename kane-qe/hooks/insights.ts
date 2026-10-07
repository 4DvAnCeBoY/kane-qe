// Pure readers for a kane-cli session's evidence: no `$`, so tests drive them
// with the text the files hold. The loader in register.tsx feeds them.

import type { Attribution, HttpIssue, RunInsights, StepInsight, Verdict } from '../types'
import { OUT_OF_CREDITS, tidyStep } from './kane'

export type ZipEntry = { name: string; size: number; crc: string }

/** `unzip -lv` rows: Length Method Size Cmpr Date Time CRC-32 Name. */
export function parseZipListing(text: string): ZipEntry[] {
  const out: ZipEntry[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+([0-9a-f]{8})\s+(.+?)\s*$/.exec(line)
    if (m) out.push({ size: Number(m[1]), crc: m[2]!, name: m[3]! })
  }
  return out
}

/** Several JSON objects back to back (`unzip -p` of many files), split by brace depth. */
export function splitJsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>)
        } catch {
          // a torn object: skip it
        }
        start = -1
      }
    }
  }
  return out
}

export type ResultStep = { n: number; kind?: string; status: string; ms: number }

/** The `steps:` list of `tests/<slug>/result.yaml`, the per-step wall time kane records. */
export function parseResultYaml(text: string): { status?: string; durationMs?: number; environment?: string; steps: ResultStep[] } {
  const steps: ResultStep[] = []
  const at = text.indexOf('\nsteps:')
  const body = at === -1 ? '' : text.slice(at)
  for (const block of body.split(/\n\s*- id: /).slice(1)) {
    const field = (k: string) => new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim()
    const n = Number(field('ordinal'))
    if (!Number.isFinite(n)) continue
    steps.push({ n, kind: field('kind'), status: field('status') ?? '?', ms: Number(field('duration_ms') ?? 0) || 0 })
  }
  const top = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(text)?.[1]?.trim()
  const browser = /browser:\s*(\S+)/.exec(text)?.[1]
  const version = /browser_version:\s*'?([\w.]+)/.exec(text)?.[1]
  const os = /\bos:\s*(\S+)/.exec(text)?.[1]
  const res = /resolution:\s*(\S+)/.exec(text)?.[1]
  return {
    status: top('status'),
    durationMs: Number(top('duration_ms')) || undefined,
    environment: [browser && `${browser}${version ? ` ${version}` : ''}`, os, res].filter(Boolean).join(' · ') || undefined,
    steps,
  }
}

const MODEL_PHASES = /^(pull_\d+|analyze\w*|reason\w*|plan\w*|vision\w*)$/
const BROWSER_PHASES = /^(navigate|dom_action|screenshot|accessibility|ax_document|page_observer_api|click|type|scroll|wait\w*)$/

export type RunLog = {
  perStep: Map<number, { totalMs?: number; modelMs: number; browserMs: number }>
  signals: string[]
}

/** `0-run.log`: `⏱️ [step_N_<phase>] completed in Xs`, and the analyzer's own account of its turns. */
export function parseRunLog(text: string): RunLog {
  const perStep = new Map<number, { totalMs?: number; modelMs: number; browserMs: number }>()
  const signals: string[] = []
  // The analyzer prints its summary (turns, committed) before the searches it ran,
  // so a block is judged when the next one starts or the log ends.
  type Block = { step: number; turns: number; committed: number; zeroMatches: number }
  let block: Block | undefined
  const close = () => {
    if (!block) return
    if (block.committed > 0 && block.zeroMatches > 0) {
      signals.push(`Step ${block.step}: the model committed an answer although ${block.zeroMatches} of its page searches found nothing`)
    }
    if (block.turns >= 8) signals.push(`Step ${block.step}: the model needed ${block.turns} reasoning turns`)
    block = undefined
  }
  for (const line of text.split('\n')) {
    const t = /\[step_(\d+)_([a-z0-9_]+)\] completed in ([\d.]+)s/.exec(line)
    if (t) {
      const n = Number(t[1])
      const phase = t[2]!
      const ms = Math.round(Number(t[3]) * 1000)
      const row = perStep.get(n) ?? { modelMs: 0, browserMs: 0 }
      if (phase === 'total') row.totalMs = ms
      else if (MODEL_PHASES.test(phase)) row.modelMs += ms
      else if (BROWSER_PHASES.test(phase)) row.browserMs += ms
      perStep.set(n, row)
      continue
    }
    const start = /Starting-Node: analyzer\w* Step: (\d+)/.exec(line)
    if (start) {
      close()
      block = { step: Number(start[1]), turns: 0, committed: 0, zeroMatches: 0 }
      continue
    }
    if (!block) continue
    const done = /Analyzer\(v\d\): turns=(\d+).*committed=(\d+)/.exec(line)
    if (done) {
      block.turns = Number(done[1])
      block.committed = Number(done[2])
    } else if (/-> 0 matches/.test(line)) block.zeroMatches++
    else if (/^\[BrowserRunner\] (?!Analyzer)/.test(line) || /\[step_\d+_/.test(line)) close()
  }
  close()
  return { perStep, signals }
}

function stepOf(id: unknown): number | undefined {
  if (typeof id !== 'string') return undefined
  const n = Number(id.split('-').pop())
  return Number.isFinite(n) ? n : undefined
}

function registrable(host: string): string {
  return host.split('.').slice(-2).join('.')
}

export type HarSummary = {
  perStep: Map<number, { requests: number; failed: number }>
  issues: HttpIssue[]
  total: number
  failed: number
  p95Ms?: number
}

/** `logs/0-network.har` with kane's `_step` / `_failed` fields, split by step and party. */
export function parseHar(text: string, host: string | undefined): HarSummary {
  const perStep = new Map<number, { requests: number; failed: number }>()
  const issues: HttpIssue[] = []
  let total = 0
  let failed = 0
  const times: number[] = []
  let entries: Record<string, unknown>[] = []
  try {
    const har = JSON.parse(text) as { log?: { entries?: Record<string, unknown>[] } }
    entries = har.log?.entries ?? []
  } catch {
    return { perStep, issues, total, failed }
  }
  const site = host ? registrable(host) : undefined
  for (const e of entries) {
    const n = stepOf(e._step) ?? 0
    const response = (e.response ?? {}) as { status?: number }
    const request = (e.request ?? {}) as { url?: string }
    const status = Number(response.status ?? 0)
    const url = String(request.url ?? '')
    const isFailed = e._failed === true || status === 0 || status >= 400
    const row = perStep.get(n) ?? { requests: 0, failed: 0 }
    row.requests++
    total++
    if (isFailed) {
      row.failed++
      failed++
    }
    perStep.set(n, row)
    if (typeof e.time === 'number' && e.time >= 0) times.push(e.time)
    if (status >= 400) {
      let reqHost = ''
      try {
        reqHost = new URL(url).host
      } catch {
        // not a URL
      }
      issues.push({
        step: n,
        status,
        url,
        isFirstParty: Boolean(site && reqHost && registrable(reqHost) === site),
        isSuspicious: /\/(undefined|null|NaN)(\/|$|\?)|=(undefined|null|NaN)(&|$)/.test(url),
      })
    }
  }
  times.sort((a, b) => a - b)
  return { perStep, issues, total, failed, p95Ms: times.length ? Math.round(times[Math.floor(times.length * 0.95)]!) : undefined }
}

export type ConsoleSummary = Map<number, { errors: number; warnings: number; samples: string[]; signatures?: string[] }>

/** An error's shape without the parts that change between loads (ids, numbers, query strings), plus where it came from. */
export function consoleSignature(text: string, url?: string): string {
  let host = ''
  try {
    host = url ? new URL(url).host : ''
  } catch {
    host = ''
  }
  const shape = text
    .toLowerCase()
    // Long quoted text is page-specific detail (a CSP policy, a stack), not what the error is.
    .replace(/"[^"]{40,}"/g, '"…"')
    .replace(/https?:\/\/([^/\s?]+)\S*/g, '$1')
    .replace(/[0-9a-f]{6,}|\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
  return `${shape} @${host}`
}

export function parseConsole(text: string): ConsoleSummary {
  const out: ConsoleSummary = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const level = o.level
    if (level !== 'error' && level !== 'warning') continue
    const n = stepOf(o.step) ?? 0
    const row = out.get(n) ?? { errors: 0, warnings: 0, samples: [], signatures: [] }
    if (level === 'error') {
      row.errors++
      row.signatures?.push(consoleSignature(String(o.text ?? ''), typeof o.url === 'string' ? o.url : undefined))
      const text = String(o.text ?? '').replace(/\s+/g, ' ').slice(0, 140)
      if (row.samples.length < 3 && !row.samples.includes(text)) row.samples.push(text)
    } else row.warnings++
    out.set(n, row)
  }
  return out
}

/** The `run_end` line of `events.ndjson`, verdict included. */
export function parseRunEnd(eventsText: string): Record<string, unknown> | undefined {
  const lines = eventsText.split('\n').filter(l => l.includes('"run_end"'))
  const last = lines[lines.length - 1]
  if (!last) return undefined
  try {
    return JSON.parse(last) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function parseFailureFix(yaml: string): string | undefined {
  const m = /suggested_fix:\s*([\s\S]*?)(?:\n\S|$)/.exec(yaml)
  const text = m?.[1]?.replace(/\n\s+/g, ' ').replace(/^['"]|['"]$/g, '').trim()
  return text || undefined
}

function verdictOf(runEnd: Record<string, unknown> | undefined, fix?: string): Verdict | undefined {
  const v = runEnd?.verdict as Record<string, unknown> | undefined
  if (!v) return undefined
  const steps = Array.isArray(v.relevant_steps) ? v.relevant_steps.filter((x): x is number => typeof x === 'number') : []
  return {
    family: typeof v.family === 'string' ? v.family : undefined,
    category: typeof v.category === 'string' ? v.category : undefined,
    severity: typeof v.severity === 'string' ? v.severity : undefined,
    confidence: typeof v.confidence === 'number' ? v.confidence : undefined,
    title: typeof v.bug_title === 'string' ? v.bug_title : undefined,
    rootCause: typeof v.root_cause === 'string' ? v.root_cause : undefined,
    fix,
    relevantSteps: steps,
  }
}

const VITALS = ['lcp', 'cls', 'inp', 'fcp', 'ttfb', 'fid', 'tbt']

/** Web vitals a run stored ("store all web vitals"), by their usual names. */
export function vitalsFrom(values: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(values ?? {})) {
    const key = VITALS.find(name => new RegExp(`(^|_)${name}($|_)`, 'i').test(k))
    const raw = typeof v === 'object' && v !== null ? (v as Record<string, unknown>).extracted_value ?? (v as Record<string, unknown>).value : v
    const num = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/[^\d.]/g, ''))
    if (key && Number.isFinite(num) && String(raw ?? '').trim() !== '') out[key] = num
  }
  return out
}

/**
 * Who most likely owns a result, judged on the page's own evidence: kane's
 * verdict is the model's opinion, the network and console are what happened.
 * A failure with no page errors where it failed is not a product bug: it is
 * the CLI's loop or the model.
 */
export function attribute(ins: Omit<RunInsights, 'attribution'>): Attribution {
  const failing = ins.steps.filter(s => s.status === 'failed' || s.status === 'broken' || s.isCulprit || s.isRelevant)
  const at = new Set(failing.map(s => s.n))
  // A busy site logs errors on every page. What was already failing before the steps that
  // matter is background noise, not evidence: only what is new there counts.
  const endpoint = (url: string) => {
    try {
      const u = new URL(url)
      return `${u.host}${u.pathname}`
    } catch {
      return url.split('?')[0]!
    }
  }
  // Same endpoint and the same class of error: a 500 after earlier 404s is news, not noise.
  const seenBefore = (i: HttpIssue) =>
    ins.httpIssues.some(o => o.step < i.step && !at.has(o.step) && endpoint(o.url) === endpoint(i.url) && Math.floor(o.status / 100) === Math.floor(i.status / 100))
  const issuesHere = ins.httpIssues.filter(i => at.has(i.step) && (i.isFirstParty || i.isSuspicious))
  const issuesAt = issuesHere.filter(i => i.isSuspicious || !seenBefore(i))
  const consoleTotal = failing.reduce((n, s) => n + s.consoleErrors, 0)
  const consoleThirdAt = failing.reduce((n, s) => n + (s.consoleThirdParty ?? 0), 0)
  const consoleAt = failing.reduce((n, s) => n + (s.consoleNew ?? s.consoleErrors), 0)
  const consoleRepeatAt = Math.max(0, consoleTotal - consoleThirdAt - failing.reduce((n, s) => n + (s.consoleNew ?? s.consoleErrors), 0))
  const noise = [
    issuesHere.length > issuesAt.length ? `${issuesHere.length - issuesAt.length} HTTP error${issuesHere.length - issuesAt.length === 1 ? '' : 's'} the same endpoint already returned before the failure` : '',
    consoleThirdAt ? `${consoleThirdAt} console error${consoleThirdAt === 1 ? '' : 's'} from other sites' scripts (ads, trackers)` : '',
    consoleRepeatAt ? `${consoleRepeatAt} console error${consoleRepeatAt === 1 ? '' : 's'} the page was already logging earlier` : '',
  ].filter(Boolean)
  const noiseNote = noise.length ? [`Ignored as background noise: ${noise.join('; ')}`] : []
  const strong = ins.httpIssues.filter(i => i.isSuspicious || (i.isFirstParty && i.status >= 500))
  const describe = (i: HttpIssue) => `HTTP ${i.status} ${shortUrlForIssue(i.url)} (step ${i.step})${i.isSuspicious ? ', a broken URL' : ''}`
  const v = ins.verdict
  const saysProduct = v?.family === 'product_bug' || /product/i.test(v?.category ?? '')

  if (ins.reason && OUT_OF_CREDITS.test(ins.reason)) {
    return {
      kind: 'unknown',
      headline: 'Out of KaneAI credits: the run stopped before it could test anything',
      evidence: ['Not a product bug and not the test: top up credits (kane-cli balance), then rerun.'],
    }
  }
  if (ins.steps.length === 0 && !ins.credits && ins.status !== 'passed') {
    return {
      kind: 'unknown',
      headline: `kane-cli refused to start the run${ins.reason ? `: ${ins.reason}` : ''}`,
      evidence: ['No step ran and no credits were spent: fix the setup (URL, login, flags), not the test.'],
    }
  }
  if (ins.status === 'passed' || ins.status === 'success') {
    const firstParty = ins.httpIssues.filter(i => i.isFirstParty || i.isSuspicious)
    const thirdPartyConsole = ins.consoleThirdParty ?? 0
    const ownConsole = Math.max(0, ins.consoleErrors - thirdPartyConsole)
    if (firstParty.length || ownConsole > 0) {
      const evidence = [
        ...firstParty.slice(0, 4).map(describe),
        ownConsole ? `${ownConsole} console errors from the site itself` : '',
        thirdPartyConsole ? `(${thirdPartyConsole} more from other sites' scripts, ignored)` : '',
        ins.failedRequests ? `${ins.failedRequests} of ${ins.requests} requests failed (third-party included)` : '',
      ].filter(Boolean)
      return {
        kind: 'signals',
        headline: strong.length ? 'Passed, but the page shows a likely product bug' : 'Passed, with page errors worth a look',
        evidence,
      }
    }
    return thirdPartyConsole
      ? { kind: 'clean', headline: "Passed. Only other sites' scripts (ads, trackers) logged errors", evidence: [`${thirdPartyConsole} console errors from third-party frames, ignored`] }
      : { kind: 'clean', headline: 'Passed, and the page logged no errors', evidence: [] }
  }

  if (ins.status !== 'failed' && ins.status !== 'broken') return { kind: 'unknown', headline: 'No evidence pack to judge', evidence: [] }

  const pageEvidence = [...issuesAt.map(describe), consoleAt ? `${consoleAt} console errors at the failing steps` : ''].filter(Boolean)
  if (saysProduct) {
    return pageEvidence.length
      ? { kind: 'product', headline: 'Product bug, backed by the page evidence', evidence: pageEvidence }
      : {
          kind: 'unclear',
          headline: 'kane calls it a product bug, but the page logged no errors where it failed: check the screenshot before filing',
          evidence: [...noiseNote, ...ins.loopSignals],
        }
  }
  if (pageEvidence.length) {
    return {
      kind: 'unclear',
      headline: 'kane blames the automation, but the page had errors where it failed',
      evidence: pageEvidence,
    }
  }
  return {
    kind: 'automation',
    // kane can tell a wrong test (its data or expectation) from an agent misstep: say which.
    headline: `Not a product bug: ${noise.length ? 'nothing new went wrong on the page where it failed' : 'the page logged no errors where it failed'}. ${
      /config|budget|max_steps|timeout/i.test(`${v?.category ?? ''} ${ins.reason ?? ''}`) && !/stuck/i.test(ins.reason ?? '')
        ? "The run's settings stopped it (step limit or timeout): raise them and rerun."
        : /test_data|assertion|expectation|objective|fixture|test_design|locator/i.test(`${v?.category ?? ''} ${v?.family ?? ''}`)
          ? 'The test itself is wrong: fix its data or expectation.'
          : 'Likely the CLI loop or the model.'
    }`,
    evidence: [
      ...(v?.title ? [`kane: ${v.title}${v.confidence !== undefined ? ` (${Math.round(v.confidence * 100)}% confidence)` : ''}`] : []),
      ...noiseNote,
      ...ins.loopSignals,
    ],
  }
}

function shortUrlForIssue(url: string): string {
  try {
    const u = new URL(url)
    const path = `${u.pathname}${u.search}`
    return `${u.host}${path.length > 48 ? `${path.slice(0, 47)}…` : path}`
  } catch {
    return url.slice(0, 60)
  }
}

export type EvidenceFiles = {
  sessionDir: string
  pack?: string
  label: string
  events: string
  listing: ZipEntry[]
  resultYaml: string
  stepJsons: string
  har: string
  console: string
  runLog: string
  failureYaml: string
  runSummary: string
}

/** Everything a pack holds, folded into what the cockpit draws. */
export function buildInsights(f: EvidenceFiles): RunInsights {
  const runEnd = parseRunEnd(f.events)
  const result = parseResultYaml(f.resultYaml)
  const stepFiles = splitJsonObjects(f.stepJsons)
  const byOrdinal = new Map<number, Record<string, unknown>>()
  for (const s of stepFiles) if (typeof s.ordinal === 'number') byOrdinal.set(s.ordinal, s)
  const firstUrl = stepFiles.map(s => s.url).find((u): u is string => typeof u === 'string' && /^https?:/.test(u))
  let host: string | undefined
  try {
    host = firstUrl ? new URL(firstUrl).host : undefined
  } catch {
    host = undefined
  }
  const log = parseRunLog(f.runLog)
  const har = parseHar(f.har, host)
  const consoleByStep = parseConsole(f.console)
  const verdict = verdictOf(runEnd, parseFailureFix(f.failureYaml))
  let summary: Record<string, unknown> = {}
  try {
    summary = f.runSummary ? (JSON.parse(f.runSummary) as Record<string, unknown>) : {}
  } catch {
    summary = {}
  }
  const maxSteps = typeof (summary.config as Record<string, unknown> | undefined)?.max_steps === 'number' ? ((summary.config as Record<string, unknown>).max_steps as number) : undefined

  // Screenshots by step, in pack order; one identical to the step before means the page did not change.
  const shots = new Map<number, ZipEntry>()
  for (const e of f.listing) {
    const m = /steps\/(\d+)-\d+-\d+\/screenshot\.jpg$/.exec(e.name)
    if (m) shots.set(Number(m[1]), e)
  }

  // Console errors from other sites' scripts (ad frames, trackers) say nothing about this site.
  const site = host ? registrable(host) : undefined
  const isThirdParty = (sig: string) => {
    const from = sig.slice(sig.lastIndexOf(' @') + 2)
    return Boolean(site && from && registrable(from.replace(/:\d+$/, '')) !== site)
  }
  // First-party console errors no earlier step (or the page load before step 1) had already logged.
  const consoleNew = new Map<number, number>()
  const consoleThird = new Map<number, number>()
  const seenConsole = new Set<string>()
  for (const n of [...consoleByStep.keys()].sort((a, b) => a - b)) {
    const sigs = consoleByStep.get(n)?.signatures ?? []
    consoleThird.set(n, sigs.filter(isThirdParty).length)
    consoleNew.set(n, sigs.filter(x => !isThirdParty(x) && !seenConsole.has(x)).length)
    for (const x of sigs) seenConsole.add(x)
  }

  const relevant = new Set(verdict?.relevantSteps ?? [])
  const ordinals = result.steps.length ? result.steps.map(s => s.n) : [...byOrdinal.keys()].sort((a, b) => a - b)
  const failedAt = result.steps.find(s => s.status === 'failed' || s.status === 'broken')?.n
  const steps: StepInsight[] = ordinals.map(n => {
    const r = result.steps.find(s => s.n === n)
    const file = byOrdinal.get(n) ?? {}
    const timing = log.perStep.get(n)
    const net = har.perStep.get(n) ?? { requests: 0, failed: 0 }
    const con = consoleByStep.get(n) ?? { errors: 0, warnings: 0, samples: [] }
    const shot = shots.get(n)
    const prev = shots.get(n - 1)
    const ms = timing?.totalMs ?? r?.ms ?? 0
    // Older packs leave `kind` off some steps; the summary starts with it ("wait: …").
    const summaryKind = /^([a-z_]+):/.exec(String(file.summary ?? ''))?.[1]
    return {
      n,
      kind: r?.kind || (typeof file.kind === 'string' ? file.kind : '') || summaryKind || 'step',
      status: r?.status ?? String(file.status ?? '?'),
      ms,
      // A step kane recorded nothing for (a planning beat) still gets words.
      summary: String(file.summary ?? r?.kind ?? '') || '(no action recorded)',
      url: typeof file.url === 'string' ? file.url : undefined,
      modelMs: timing?.modelMs ?? 0,
      browserMs: timing?.browserMs ?? 0,
      requests: net.requests,
      failedRequests: net.failed,
      httpIssues: har.issues.filter(i => i.step === n),
      consoleErrors: con.errors,
      consoleNew: consoleNew.get(n) ?? con.errors,
      consoleThirdParty: consoleThird.get(n) ?? 0,
      consoleWarnings: con.warnings,
      consoleSamples: con.samples,
      screenshot: shot?.name,
      isUnchanged: Boolean(shot && prev && shot.crc === prev.crc),
      isRelevant: relevant.has(n),
      // kane's culprit is the last relevant step before the failure.
      isCulprit: Boolean(verdict && failedAt !== undefined && n === Math.max(...[...relevant].filter(x => x <= failedAt), -1)),
    }
  })

  const loopSignals = [...log.signals]
  const unchangedRuns: number[][] = []
  for (const s of steps) {
    if (s.isUnchanged) {
      const last = unchangedRuns[unchangedRuns.length - 1]
      if (last && last[last.length - 1] === s.n - 1) last.push(s.n)
      else unchangedRuns.push([s.n - 1, s.n])
    }
  }
  for (const run of unchangedRuns) if (run.length >= 3) loopSignals.push(`Steps ${run[0]}–${run[run.length - 1]}: the page did not change (identical screenshots)`)
  if (maxSteps && steps.length >= maxSteps * 0.9) loopSignals.push(`Used ${steps.length} of ${maxSteps} allowed steps`)
  for (let i = 1; i < steps.length; i++) {
    if (steps[i]!.summary && steps[i]!.summary === steps[i - 1]!.summary) loopSignals.push(`Steps ${steps[i - 1]!.n}–${steps[i]!.n}: the same action twice in a row`)
  }
  loopSignals.push(...repeatedExtractions(steps))
  loopSignals.push(...repeatedActions(steps))
  const waitMs = steps.filter(s => s.kind === 'wait').reduce((a, s) => a + s.ms, 0)
  const totalStepMs = steps.reduce((a, s) => a + s.ms, 0)
  if (totalStepMs > 0 && waitMs / totalStepMs > 0.4) loopSignals.push(`${Math.round((waitMs / totalStepMs) * 100)}% of step time was waiting`)

  const consoleErrors = [...consoleByStep.values()].reduce((a, c) => a + c.errors, 0)
  const consoleWarnings = [...consoleByStep.values()].reduce((a, c) => a + c.warnings, 0)
  const status = String(runEnd?.status ?? result.status ?? 'unknown')
  const memory = ((runEnd?.context as Record<string, unknown> | undefined)?.memory ?? {}) as Record<string, unknown>
  const finalState = (runEnd?.final_state ?? {}) as Record<string, unknown>

  const base: Omit<RunInsights, 'attribution'> = {
    sessionDir: f.sessionDir,
    pack: f.pack,
    label: f.label,
    status,
    durationMs: typeof runEnd?.duration === 'number' ? Math.round(runEnd.duration * 1000) : (result.durationMs ?? totalStepMs),
    credits: typeof runEnd?.credits_consumed === 'number' ? Math.round(runEnd.credits_consumed * 100) / 100 : undefined,
    reason: typeof runEnd?.reason === 'string' ? runEnd.reason : undefined,
    host,
    environment: result.environment,
    maxSteps,
    steps,
    requests: har.total,
    failedRequests: har.failed,
    p95Ms: har.p95Ms,
    httpIssues: har.issues,
    consoleErrors,
    consoleThirdParty: [...consoleThird.values()].reduce((a, b) => a + b, 0),
    consoleWarnings,
    verdict,
    loopSignals: [...new Set(loopSignals)],
    modelMs: steps.reduce((a, s) => a + s.modelMs, 0),
    browserMs: steps.reduce((a, s) => a + s.browserMs, 0),
    vitals: { ...vitalsFrom(memory), ...vitalsFrom(finalState) },
  }
  return { ...base, attribution: attribute(base) }
}

/** What an analyze step extracted: the `{{variables}}` it stored, else its tidied wording. */
function extractionKey(step: StepInsight): string | undefined {
  if (step.kind !== 'analyze') return undefined
  const vars = [...step.summary.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map(m => m[1]!).sort()
  if (vars.length) return `vars:${vars.join(',')}`
  const text = tidyStep(step.summary).toLowerCase().replace(/^analyze:\s*/, '').trim()
  return text ? `text:${text}` : undefined
}

/**
 * The model extracting the same thing again later in the run (not only back to back):
 * every repeat is model time and credits spent for an answer it already had.
 */
export function repeatedExtractions(steps: readonly StepInsight[]): string[] {
  const seen = new Map<string, StepInsight>()
  const out: string[] = []
  for (const step of steps) {
    const key = extractionKey(step)
    if (!key) continue
    const first = seen.get(key)
    if (!first) {
      seen.set(key, step)
      continue
    }
    if (first.n === step.n - 1) continue // back to back: already reported as the same action twice
    const what = key.startsWith('vars:') ? key.slice(5).split(',').map(v => `{{${v}}}`).join(', ') : 'the same value'
    out.push(`Steps ${first.n} and ${step.n}: the model extracted ${what} twice (${(step.ms / 1000).toFixed(1)}s spent on the repeat)`)
  }
  return out
}

/** A short text account for the model and for triage prompts. */
export function insightsReport(ins: RunInsights): string {
  const lines = [
    `${ins.attribution.headline}`,
    ...ins.attribution.evidence.map(e => `- ${e}`),
    `Run: ${ins.status}, ${(ins.durationMs / 1000).toFixed(1)}s${ins.credits !== undefined ? `, ${ins.credits} credits` : ''}, ${ins.steps.length} steps${ins.environment ? `, ${ins.environment}` : ''}`,
    `Time: model ${(ins.modelMs / 1000).toFixed(1)}s, browser ${(ins.browserMs / 1000).toFixed(1)}s`,
    `Network: ${ins.requests} requests, ${ins.failedRequests} failed; HTTP errors: ${ins.httpIssues.map(i => `${i.status} ${shortUrlForIssue(i.url)} @${i.step}${i.isFirstParty ? ' first-party' : ''}`).join('; ') || 'none'}`,
    `Console: ${ins.consoleErrors} errors, ${ins.consoleWarnings} warnings`,
    ...(ins.verdict ? [`kane verdict: ${ins.verdict.family ?? '?'} / ${ins.verdict.category ?? '?'} (${ins.verdict.confidence ?? '?'}) — ${ins.verdict.title ?? ''}`, ins.verdict.fix ? `kane suggested fix: ${ins.verdict.fix}` : ''] : []),
    ...(ins.loopSignals.length ? ['Loop / model signals:', ...ins.loopSignals.map(s => `- ${s}`)] : []),
    'Steps:',
    ...ins.steps.map(
      s =>
        `  ${s.n}. ${s.kind} ${s.status} ${(s.ms / 1000).toFixed(1)}s${s.isCulprit ? ' [culprit]' : s.isRelevant ? ' [relevant]' : ''}${s.isUnchanged ? ' [page unchanged]' : ''} — ${tidyStep(s.summary)}${s.httpIssues.length ? ` | HTTP ${s.httpIssues.map(i => i.status).join(',')}` : ''}${s.consoleErrors ? ` | ${s.consoleErrors} console errors` : ''}`,
    ),
    `Evidence pack: ${ins.pack ?? 'none'}`,
  ]
  return lines.filter(Boolean).join('\n')
}

// ── across runs ─────────────────────────────────────────────────────────

export type HistoryLike = { label: string; status: string; credits?: number; durationS?: number; endedAt: number }

export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Objectives that both passed and failed: the ones nobody can trust yet. */
export function flakyGroups<T extends HistoryLike>(history: readonly T[]): { label: string; passed: number; failed: number }[] {
  const groups = new Map<string, { label: string; passed: number; failed: number }>()
  for (const h of history) {
    const key = normalizeLabel(h.label)
    const g = groups.get(key) ?? { label: h.label, passed: 0, failed: 0 }
    if (h.status === 'passed') g.passed++
    else if (h.status === 'failed') g.failed++
    groups.set(key, g)
  }
  return [...groups.values()].filter(g => g.passed > 0 && g.failed > 0)
}

export function creditStats<T extends HistoryLike>(history: readonly T[], balanceText?: string): { used: number; runs: number; avg: number; left?: number; total?: number; runsLeft?: number } {
  const priced = history.filter(h => typeof h.credits === 'number')
  const used = Math.round(priced.reduce((a, h) => a + (h.credits ?? 0), 0) * 100) / 100
  const avg = priced.length ? Math.round((used / priced.length) * 100) / 100 : 0
  const left = Number(/(-?[\d.]+) of/.exec(balanceText ?? '')?.[1])
  const total = Number(/of ([\d.,]+)/.exec(balanceText ?? '')?.[1]?.replace(/,/g, ''))
  return {
    used,
    runs: priced.length,
    avg,
    left: Number.isFinite(left) ? left : undefined,
    total: Number.isFinite(total) ? total : undefined,
    runsLeft: Number.isFinite(left) && avg > 0 ? Math.floor(left / avg) : undefined,
  }
}

/**
 * `kane-cli cover gaps --json` as lines a pane can show: the design headline,
 * then each use case's open gaps with kane's own next command.
 */
export function summarizeCoverage(data: Record<string, unknown>): string[] {
  const out: string[] = []
  const dc = (data.design_completeness ?? {}) as Record<string, unknown>
  if (typeof dc.pct === 'number') {
    out.push(
      [
        `Design completeness ${Math.round(dc.pct)}%`,
        typeof dc.usecases_complete === 'string' ? `${dc.usecases_complete} use cases complete` : '',
        typeof dc.acs_designed === 'string' ? `${dc.acs_designed} acceptance criteria designed` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    )
  }
  const usecases = Array.isArray(data.usecases) ? (data.usecases as Record<string, unknown>[]) : []
  if (!usecases.length) out.push('No use cases yet: ingest a requirement, then run kane-cli context extract --mode agent.')
  for (const uc of usecases.slice(0, 6)) {
    const pending = Array.isArray(uc.pending) ? (uc.pending as Record<string, unknown>[]) : []
    const ucPct = ((uc.design_completeness ?? {}) as Record<string, unknown>).pct
    out.push(`${String(uc.id ?? '?')} ${String(uc.title ?? '')} · risk ${String(uc.risk ?? '?')} · ${typeof ucPct === 'number' ? `${Math.round(ucPct)}% designed` : 'not designed'} · ${pending.length} open`)
    for (const gap of pending.slice(0, 3)) {
      out.push(`  ↳ ${String(gap.why ?? gap.kind ?? 'gap')}${gap.ready_command ? ` → ${String(gap.ready_command)}` : ''}`)
    }
  }
  return out
}

export type SiteGroup = {
  host: string
  runs: number
  passed: number
  failed: number
  credits: number
  lastAt: number
  /** One row per distinct objective or test, newest first, with how often it passed. */
  scenarios: { label: string; status: string; passed: number; failed: number; sessionDir?: string; id: string }[]
  /** Page paths the agent reached on this site, from the runs whose evidence was read. */
  pages: string[]
}

function hostOf(text: string | undefined): string | undefined {
  if (!text) return undefined
  const m = /https?:\/\/([^/\s"']+)/.exec(text)
  return m ? m[1]!.replace(/^www\./, '') : undefined
}

/**
 * History by the site it ran against: what has been explored there, what held
 * up and what did not. A run's site is its evidence's host, else its --url,
 * else a URL in its objective.
 */
export function siteGroups(
  history: readonly { id: string; label: string; status: string; credits?: number; endedAt: number; rerun: readonly string[]; sessionDir?: string }[],
  readings: Readonly<Record<string, { data?: { host?: string; steps: readonly { url?: string }[] } }>>,
): SiteGroup[] {
  const groups = new Map<string, SiteGroup>()
  for (const h of history) {
    const data = h.sessionDir ? readings[h.sessionDir]?.data : undefined
    const urlAt = h.rerun.indexOf('--url')
    // A suite spans its tests' sites: it gets a group of its own rather than a guess.
    const isSuite = h.rerun[0] === 'testrun' || /^suite\b|^designed tests\b/.test(h.label)
    const host = isSuite
      ? 'Suites of saved tests'
      : (data?.host?.replace(/^www\./, '') ?? hostOf(urlAt === -1 ? undefined : h.rerun[urlAt + 1]) ?? hostOf(h.label) ?? 'Other runs (site not read yet)')
    const g = groups.get(host) ?? { host, runs: 0, passed: 0, failed: 0, credits: 0, lastAt: 0, scenarios: [], pages: [] }
    g.runs++
    if (h.status === 'passed') g.passed++
    if (h.status === 'failed' || h.status === 'error') g.failed++
    g.credits = Math.round((g.credits + (h.credits ?? 0)) * 100) / 100
    g.lastAt = Math.max(g.lastAt, h.endedAt)
    const key = normalizeLabel(h.label)
    const sc = g.scenarios.find(s => normalizeLabel(s.label) === key)
    if (sc) {
      if (h.status === 'passed') sc.passed++
      else if (h.status === 'failed' || h.status === 'error') sc.failed++
    } else {
      g.scenarios.push({ label: h.label, status: h.status, passed: h.status === 'passed' ? 1 : 0, failed: h.status === 'failed' || h.status === 'error' ? 1 : 0, sessionDir: h.sessionDir, id: h.id })
    }
    for (const s of data?.steps ?? []) {
      if (!s.url) continue
      try {
        const u = new URL(s.url)
        const page = `${u.pathname}${u.searchParams.get('route') ? `?route=${u.searchParams.get('route')}` : ''}`
        if (!g.pages.includes(page)) g.pages.push(page)
      } catch {
        // not a URL
      }
    }
    groups.set(host, g)
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt)
}

const FILLER = new Set(['click', 'clicking', 'clicked', 'the', 'a', 'an', 'to', 'on', 'in', 'for', 'of', 'button', 'link', 'option', 'primary', 'role', 'text', 'hints', 'position', 'radio', 'and', 'with', 'into', 'from', 'type', 'typing'])

const ELEMENTS = ['link', 'button', 'form', 'field', 'tab', 'menu', 'checkbox', 'radio', 'option', 'dropdown', 'icon', 'textbox']

function elementKinds(summary: string): Set<string> {
  const words = new Set(summary.toLowerCase().match(/[a-z]+/g) ?? [])
  return new Set(ELEMENTS.filter(k => words.has(k)))
}

function targetWords(summary: string): Set<string> {
  const words = tidyStep(summary)
    .toLowerCase()
    .replace(/^[a-z_]+:\s*/, '')
    .split('|')[0]!
    .match(/[a-z0-9]+/g) ?? []
  return new Set(words.filter(w => !FILLER.has(w) && w.length > 1))
}

/**
 * Back-to-back steps of the same kind on the same target, worded differently
 * ("Clicking Guest Checkout option" then "Guest Checkout option; role=radio"):
 * the agent repeated itself because the first try did not visibly land.
 */
export function repeatedActions(steps: readonly StepInsight[]): string[] {
  const out: string[] = []
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1]!
    const b = steps[i]!
    if (a.kind !== b.kind || !['click', 'type', 'select'].includes(a.kind) || a.summary === b.summary) continue
    const wa = targetWords(a.summary)
    const wb = targetWords(b.summary)
    if (!wa.size || !wb.size) continue
    // "Continue link" then "Continue button in the form" are two targets, not one tried twice.
    const kindsA = elementKinds(a.summary)
    const kindsB = elementKinds(b.summary)
    if (kindsA.size && kindsB.size && ![...kindsA].some(k => kindsB.has(k))) continue
    const shared = [...wa].filter(w => wb.has(w))
    if (shared.length < 2 || shared.length / Math.min(wa.size, wb.size) < 0.6) continue
    out.push(`Steps ${a.n}–${b.n}: the same ${a.kind} twice (${shared.slice(0, 4).join(' ')}), ${((b.ms) / 1000).toFixed(1)}s on the repeat`)
  }
  return out
}
