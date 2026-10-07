// Pure helpers for kane-cli's assurance loop (context / design / maintain), the
// cloud grid and mobile devices, the evidence viewer and doctor. No `$` here.
import type { AssureJob, AssureQuestion, AssureSession, KaneAssurance, KaneDevice, DoctorCheck } from '../types'

type Json = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Each stdout line that parses as a JSON object; banners and prose are skipped. */
export function jsonLines(text: string): Json[] {
  const out: Json[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t) as unknown
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o as Json)
    } catch {
      // not JSON
    }
  }
  return out
}

export function parseQuestions(v: unknown): AssureQuestion[] {
  if (!Array.isArray(v)) return []
  return (v as Json[]).map((q, i) => ({
    id: str(q.id) ?? `q${i + 1}`,
    header: str(q.header),
    text: str(q.text) ?? str(q.question) ?? '(no text)',
    risk: str(q.risk),
    rationale: str(q.rationale),
    options: Array.isArray(q.options)
      ? (q.options as Json[]).map(o => (typeof o === 'string' ? { label: o } : { label: str(o.label) ?? '?', detail: str(o.detail) }))
      : [],
    recommended: num(q.recommended_index),
    allowFreeText: q.allow_free_text !== false,
  }))
}

function nextCommands(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map(x => (typeof x === 'string' ? x : str((x as Json).cmd))).filter((x): x is string => Boolean(x))
}

export function newJob(id: string, label: string, argv: string[], startedAt: number): AssureJob {
  return { id, label, argv, status: 'running', activity: [], messages: [], questions: [], next: [], errors: [], committed: [], startedAt }
}

/**
 * Folds one `--mode agent` event (extract, design, evolve, reconcile, sync) into
 * the job the Assurance tab draws. Unknown types are kept out, as kane asks.
 */
export function applyAssureEvent(job: AssureJob, e: Json): AssureJob {
  const type = str(e.type)
  const verb = str(e.verb) ?? job.verb
  const add = (list: string[], text: string | undefined, keep = 6) => (text ? [...list, text].slice(-keep) : list)
  switch (type) {
    case 'run_start':
      return { ...job, verb }
    case 'ingested':
      return { ...job, verb, committed: add(job.committed, `source ${str(e.source_id) ?? '?'} ${str(e.status) ?? ''}`.trim(), 10) }
    case 'source_start':
      return { ...job, activity: add(job.activity, `reading ${str(e.source_id) ?? 'source'}${num(e.total) ? ` (${num(e.index)}/${num(e.total)})` : ''}`) }
    case 'agent_activity':
      return { ...job, activity: add(job.activity, str(e.label)) }
    case 'agent_message':
      return { ...job, messages: add(job.messages, str(e.text), 3) }
    case 'usage':
      return { ...job, credits: num(e.total_credits) ?? job.credits }
    case 'warning':
      return { ...job, messages: add(job.messages, str(e.message) ? `⚠ ${str(e.message)}` : undefined, 3) }
    case 'commit': {
      const minted = Array.isArray(e.minted) ? (e.minted as Json[]).map(m => str(m.logical_id)).filter((x): x is string => Boolean(x)) : []
      return { ...job, committed: [...job.committed, ...minted].slice(-10) }
    }
    // A receipt's `next` is guidance for kane's own agent, not for a person.
    case 'variables_declared':
    case 'variables_summary': {
      const names = Array.isArray(e.variables) ? (e.variables as Json[]).map(v => str(v.name)).filter((x): x is string => Boolean(x)) : []
      if (!names.length) return job
      const all = [...new Set([...(job.variables?.names ?? []), ...names])]
      return { ...job, variables: { file: str(e.file) ?? job.variables?.file, names: all } }
    }
    case 'held':
    case 'update_held':
      return { ...job, messages: add(job.messages, `${num(e.count) ?? '?'} item(s) held for your review`, 3) }
    case 'gate_refused':
      return { ...job, errors: add(job.errors, str(e.message) ?? str(e.reason) ?? 'A design gate refused the run', 4), next: nextCommands(e.next).length ? nextCommands(e.next) : job.next }
    case 'error':
      return { ...job, errors: add(job.errors, `${str(e.message) ?? 'error'}${str(e.code) ? ` [${str(e.code)}]` : ''}`, 4) }
    case 'session_paused':
    case 'evolve_paused':
      return {
        ...job,
        sid: str(e.sid) ?? job.sid,
        resume: str(e.resume) ?? job.resume,
        questions: parseQuestions(e.pending_questions),
        next: nextCommands(e.next).length ? nextCommands(e.next) : job.next,
      }
    case 'session_complete':
      return { ...job, questions: [] }
    case 'evolve_target':
      return { ...job, activity: add(job.activity, `${str(e.use_case) ?? 'use case'}: ${num(e.pairs) ?? '?'} scenario/test pairs affected`) }
    case 'reconcile_summary':
      return { ...job, messages: add(job.messages, `applied ${num(e.applied) ?? 0} · skipped ${num(e.skipped) ?? 0} · failed ${num(e.failed) ?? 0} · paused ${num(e.paused) ?? 0}`, 3) }
    case 'sync_pull_done':
      return { ...job, messages: add(job.messages, `pulled ${num(e.imported) ?? 0} record(s) from ${str(e.name) ?? 'the location'}`, 3) }
    case 'sync_push_done':
      return { ...job, messages: add(job.messages, `pushed ${num(e.pushed) ?? 0} record(s) to ${str(e.name) ?? 'the location'}`, 3) }
    case 'done': {
      const s = str(e.status)
      const status: AssureJob['status'] =
        s === 'complete' ? 'complete' : s === 'paused' ? 'paused' : s === 'refused' || s === 'aborted' ? 'refused' : s === 'interrupted' ? 'interrupted' : 'error'
      const next = nextCommands(e.next)
      return { ...job, status, next: next.length ? next : job.next }
    }
    default:
      return job
  }
}

/** Settles a job whose process ended without a `done` (a crash, a kill). */
export function finishJob(job: AssureJob, exitCode: number, endedAt: number, stderr: string): AssureJob {
  if (job.status !== 'running') return { ...job, endedAt }
  const status: AssureJob['status'] = exitCode === 0 ? 'complete' : exitCode === 3 ? 'paused' : exitCode === 2 ? 'refused' : 'error'
  const said = stderr.split('\n').map(l => l.trim()).filter(l => l && !/^Skill update available/.test(l))
  return { ...job, status, endedAt, errors: status === 'complete' || status === 'paused' ? job.errors : [...job.errors, ...said.slice(-2)].slice(-4) }
}

/** The command that answers a paused job's question with one of its options (1-based), or free text. */
export function answerArgs(job: Pick<AssureJob, 'argv' | 'sid' | 'resume' | 'verb'>, questionId: string, answer: string): string[] | undefined {
  if (job.resume) {
    const words = splitWords(job.resume)
    const at = words[0] === 'kane-cli' ? 1 : 0
    return [...words.slice(at), '--answer', `${questionId}=${answer}`]
  }
  // evolve's own question carries no session: answer by re-running the same command.
  if (job.verb === 'evolve' || job.argv[0] === 'maintain') return [...job.argv.filter(a => a !== '--answer'), '--answer', `${questionId}=${answer}`]
  return undefined
}

/** Splits a command line kane printed (it quotes with "…" when a value has spaces). */
export function splitWords(text: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** The assurance id design stamps in a test's frontmatter (`assurance:\n  id: t-1`). */
export function designedTestId(text: string): string | undefined {
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  return /(^|\n)assurance:\s*\n(?:[ \t]+.*\n)*?[ \t]+id:\s*([\w.-]+)/.exec(`${head}\n`)?.[2]
}

/** `context sessions --json`: one resumable session per line. */
export function parseSessions(text: string): AssureSession[] {
  return jsonLines(text)
    .filter(o => typeof o.sid === 'string')
    .map(o => ({
      sid: String(o.sid),
      verb: str(o.verb) ?? 'extract',
      pending: num(o.pendingCount) ?? num(o.pending) ?? 0,
      resume: str(o.resume) ?? '',
      expiresAt: str(o.expires_at),
    }))
}

/** `context sessions show <sid> --json`: the pending questions in the same shape as a pause. */
export function parseSessionShow(text: string): AssureQuestion[] {
  for (const o of jsonLines(text)) {
    const q = parseQuestions(o.pending_questions ?? o.questions)
    if (q.length) return q
  }
  return []
}

type ListedNode = KaneAssurance['nodes'][number]

/** `context list --json`: sources and use cases with trust and freshness. */
export function parseContextList(text: string): ListedNode[] {
  return jsonLines(text)
    .filter(o => typeof o.id === 'string')
    .map(o => ({ id: String(o.id), label: str(o.label) ?? 'node', title: str(o.title) ?? String(o.id), trust: str(o.trust) ?? '-', fresh: str(o.fresh) ?? 'fresh' }))
}

export function countNodes(nodes: readonly ListedNode[]): Pick<KaneAssurance, 'sources' | 'useCases' | 'trusted' | 'derived' | 'stale'> {
  const ucs = nodes.filter(n => n.label === 'usecase' || n.label === 'use-case' || n.id.startsWith('uc-'))
  return {
    sources: nodes.filter(n => n.label === 'source').length,
    useCases: ucs.length,
    trusted: ucs.filter(n => n.trust === 'trusted').length,
    derived: ucs.filter(n => n.trust === 'derived').length,
    stale: nodes.filter(n => n.fresh === 'stale' || n.fresh === 'orphaned').length,
  }
}

/** `cover gaps --json` use cases with what each still owes and kane's next command. */
export function coverageUseCases(data: Json): { pct?: number; provenPct?: number; proven?: string; provenAt?: number; usecases: KaneAssurance['usecases'] } {
  const dc = (data.design_completeness ?? {}) as Json
  const pr = (data.proven ?? {}) as Json
  const ucs = Array.isArray(data.usecases) ? (data.usecases as Json[]) : []
  return {
    pct: num(dc.pct),
    provenPct: num(pr.pct),
    provenAt: Date.parse(str(((pr.latest_run ?? {}) as Json).started_at) ?? '') || undefined,
    proven: str(pr.acs_proven) ? `${str(pr.acs_proven)} criteria proven${num(pr.failing) ? ` · ${num(pr.failing)} failing` : ''}${num(pr.not_run) ? ` · ${num(pr.not_run)} not run yet` : ''}` : undefined,
    usecases: ucs.map(uc => ({
      id: str(uc.id) ?? '?',
      title: str(uc.title) ?? '',
      risk: str(uc.risk),
      pct: num(((uc.design_completeness ?? {}) as Json).pct),
      pending: (Array.isArray(uc.pending) ? (uc.pending as Json[]) : []).map(p => ({ why: str(p.why) ?? str(p.kind) ?? 'gap', cmd: str(p.ready_command) })),
    })),
  }
}

// ── grid and devices ─────────────────────────────────────────────────

/** `devices list --target … [--remote] --agent`: one device per line. */
export function parseDevices(text: string): KaneDevice[] {
  return jsonLines(text)
    .filter(o => typeof o.name === 'string')
    .map(o => ({ name: String(o.name), osVersions: Array.isArray(o.os_versions) ? o.os_versions.map((x: unknown) => String(x)) : str(o.os_version) ? [String(o.os_version)] : [] }))
}

/** The first `error: …` kane printed, without its banner lines. */
export function kaneError(text: string): string | undefined {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const at = lines.findIndex(l => /^error:/i.test(l))
  if (at === -1) return lines.filter(l => !/^Skill update available/.test(l)).slice(-1)[0]
  return [lines[at]!.replace(/^error:\s*/i, ''), ...lines.slice(at + 1, at + 2)].join(' ')
}

/** `plugin doctor <name>`: ok when every check passed. */
export function parsePluginDoctor(text: string): 'ok' | 'missing' | 'unknown' {
  const o = jsonLines(text).find(x => x.type === 'plugin_doctor')
  if (!o || !Array.isArray(o.checks)) return 'unknown'
  return (o.checks as Json[]).every(c => c.ok === true) ? 'ok' : 'missing'
}

/** `doctor --target …` prose: "✓/✗ name — detail" with an indented "fix: …" under a failure. */
export function parseDoctor(text: string): DoctorCheck[] {
  const out: DoctorCheck[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const m = /^([✓✔✗✘!⚠])\s+(.+)$/.exec(line)
    if (m) {
      const [name, ...rest] = m[2]!.split(' — ')
      out.push({ ok: m[1] === '✓' || m[1] === '✔', name: name!.trim(), detail: rest.join(' — ').trim() || undefined })
      continue
    }
    const fix = /^fix:\s*(.+)$/.exec(line)
    const last = out[out.length - 1]
    if (fix && last) last.fix = fix[1]
  }
  return out
}

/** `evidence serve` prints the hosted viewer link once the pack is being served. */
export function viewerUrl(text: string): string | undefined {
  return /viewer\s+(https?:\/\/\S+)/.exec(text)?.[1]
}

/** A `testmd status` reading in one line. */
export function describeTestStatus(text: string): string {
  const o = jsonLines(text)[0]
  if (!o) return kaneError(text) ?? 'No status.'
  const parts = [
    o.has_meta === false ? 'not recorded yet (run it once to author it)' : 'recorded',
    str(o.project_name) ?? str(o.project) ? `project ${str(o.project_name) ?? str(o.project)}` : '',
    str(o.folder_name) ?? str(o.folder) ? `folder ${str(o.folder_name) ?? str(o.folder)}` : '',
    str(o.testcase_id) ?? str(o.test_case_id) ? `test case ${str(o.testcase_id) ?? str(o.test_case_id)}` : '',
    typeof o.in_sync === 'boolean' ? (o.in_sync ? 'in sync with Test Manager' : 'local recordings differ from the last upload') : '',
    typeof o.synced === 'boolean' ? (o.synced ? 'synced' : 'not synced') : '',
  ].filter(Boolean)
  return `${str(o.name) ?? 'test'}: ${parts.join(' · ')}`
}
