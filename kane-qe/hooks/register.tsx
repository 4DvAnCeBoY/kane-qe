import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { AssureJob, AssureQuestion, KaneAssurance, KaneGrid, KaneViewer, KaneCoach, KaneCoverage, KaneFocus, KaneHistoryView, KaneInsightsEntry, KaneShot, RunInsights, KaneEnv, KaneForm, KaneHistoryEntry, KaneRun, KaneRunKind, KaneTab, KaneTests } from '../types'
import {
  COLOR,
  ICON,
  ago,
  applyEvent,
  clip,
  finishRun,
  newRun,
  parseConfig,
  parseLine,
  parseRunArgs,
  parseTests,
  report,
  runArgs,
  splitCommand,
  suiteArgs,
  takeLines,
  testArgs,
  toHistory,
  fitSteps,
  rowsFor,
  mergeHistory,
  shortUrl,
  tidyStep,
  describeBalance,
  describeIdentity,
  parseWhoami,
  resolveAuth,
  ARTIFACTS,
  basename,
  kindOfSurface,
  labelFromEvent,
  objectiveFromLog,
  parsePointer,
  KANE_HELP,
  ciCommand,
  kaneArgv,
  OUT_OF_CREDITS,
  remoteFailure,
  coachObjective,
  needsCoaching,
  routeKane,
} from './kane'
import type { RunOptions, SuiteOptions, TestOptions } from './kane'
import { bmpToRaster, fromBase64, previewSize, toBase64 } from './image'
import {
  designedTestId,
  answerArgs,
  applyAssureEvent,
  countNodes,
  coverageUseCases,
  describeTestStatus,
  finishJob,
  kaneError,
  newJob,
  parseContextList,
  parseDevices,
  parseDoctor,
  parsePluginDoctor,
  parseSessions,
  parseSessionShow,
  splitWords,
  viewerUrl,
} from './assurance'
import { buildInsights, creditStats, flakyGroups, insightsReport, normalizeLabel, parseRunEnd, parseZipListing, siteGroups, summarizeCoverage } from './insights'

const PLUGIN = 'kane-qe'
const PANE = 'kane-qe'
const TOOL = (name: string) => `mcp__${PLUGIN}__${name}`
const AGENT_NAME = 'claude-code-kane-qe'

const tabAtom = atom({ plugin: 'kane-qe', key: 'tab' } as const, 'run' as KaneTab)
const runAtom = atom({ plugin: 'kane-qe', key: 'run' } as const, null as KaneRun | null)
const historyAtom = atom({ plugin: 'kane-qe', key: 'history' } as const, [] as KaneHistoryEntry[])
const testsAtom = atom({ plugin: 'kane-qe', key: 'tests' } as const, { isLoading: false, items: [] } as KaneTests)
const envAtom = atom({ plugin: 'kane-qe', key: 'env' } as const, {
  isChecking: false,
  isInstalled: false,
  auth: 'unknown',
  config: {},
} as KaneEnv)
const formAtom = atom({ plugin: 'kane-qe', key: 'form' } as const, { objective: '', url: '', tags: '' } as KaneForm)
const flashAtom = atom({ plugin: 'kane-qe', key: 'flash' } as const, '')
const coachAtom = atom({ plugin: 'kane-qe', key: 'coach' } as const, null as KaneCoach | null)
const insightsAtom = atom({ plugin: 'kane-qe', key: 'insights' } as const, {} as Record<string, KaneInsightsEntry>)
const focusAtom = atom({ plugin: 'kane-qe', key: 'focus' } as const, { view: 'timeline' } as KaneFocus)
const historyViewAtom = atom({ plugin: 'kane-qe', key: 'historyView' } as const, 'runs' as KaneHistoryView)
const shotAtom = atom({ plugin: 'kane-qe', key: 'shot' } as const, null as KaneShot | null)
const coverageAtom = atom({ plugin: 'kane-qe', key: 'coverage' } as const, { isLoading: false } as KaneCoverage)
const cardsAtom = atom({ plugin: 'kane-qe', key: 'cards' } as const, {} as Record<string, KaneRun>)
const assuranceAtom = atom({ plugin: 'kane-qe', key: 'assurance' } as const, {
  isLoading: false,
  sources: 0,
  useCases: 0,
  trusted: 0,
  derived: 0,
  stale: 0,
  nodes: [],
  sessions: [],
  usecases: [],
  source: '',
} as KaneAssurance)
const gridAtom = atom({ plugin: 'kane-qe', key: 'grid' } as const, { where: 'local', target: 'web', devices: [], isLoading: false, plugin: 'unknown' } as KaneGrid)
const viewerAtom = atom({ plugin: 'kane-qe', key: 'viewer' } as const, null as KaneViewer | null)
const testNotesAtom = atom({ plugin: 'kane-qe', key: 'testNotes' } as const, {} as Record<string, string>)
const liveAtom = atom({ plugin: 'kane-qe', key: 'live' } as const, {} as Record<string, KaneRun>)
const bootAtom = atom({ plugin: 'kane-qe', key: 'booted' } as const, false)

type $ = EngineInterface
type Json = Record<string, unknown>

const TABS: { id: KaneTab; label: string; hotkey: string }[] = [
  { id: 'run', label: 'Run', hotkey: '1' },
  { id: 'insights', label: 'Insights', hotkey: '2' },
  { id: 'tests', label: 'Tests', hotkey: '3' },
  { id: 'assure', label: 'Assurance', hotkey: 'a' },
  { id: 'history', label: 'History', hotkey: '4' },
  { id: 'setup', label: 'Setup', hotkey: '5' },
]

const SETTINGS: { key: string; action: string; label: string; values: string[] }[] = [
  { key: 'mode', action: 'set-mode', label: 'Mode', values: ['testing', 'action'] },
  { key: 'assertion_mode', action: 'set-assertion-mode', label: 'Assertions', values: ['dom', 'visual'] },
  { key: 'bug_detection', action: 'set-bug-detection', label: 'Bug detection', values: ['off', 'stop', 'continue'] },
  { key: 'final_validation', action: 'set-final-validation', label: 'Final check', values: ['off', 'on'] },
]

// Set from the plugin's options each time `register` runs.
let base = ['kane-cli']
let defaultTimeout = 600
let mirrorExternal = true
let openOnStart: 'kane-projects' | 'always' | 'never' = 'never'

// pids of kane-cli processes this mod launched, so the mirror never doubles them.
const ownPids = new Set<number>()

// Live runs of this module load, by run id; a reload kills their children.
const active = new Map<string, { pid?: number; stop: () => void }>()

function kane($: $, argv: string[], timeoutMs = 30_000) {
  return $.process.run([...base, ...argv], { timeoutMs, env: { KANE_CLI_USER_AGENT: AGENT_NAME, NO_COLOR: '1' } })
}

async function flash($: $, text: string) {
  await update($, flashAtom, () => text)
}

async function refreshEnv($: $) {
  await update($, envAtom, env => ({ ...env, isChecking: true, error: undefined }))
  let version: string | undefined
  try {
    const v = await kane($, ['--version'], 20_000)
    version = (v.stdout || v.stderr).trim().split('\n').pop()
  } catch (err) {
    await update($, envAtom, () => ({
      isChecking: false,
      isInstalled: false,
      auth: 'unknown' as const,
      config: {},
      error: `Could not start \`${base.join(' ')}\`: ${String(err instanceof Error ? err.message : err)}`,
    }))
    return
  }
  // balance first: it refreshes an expired OAuth token, which whoami alone does not.
  const [cfg, bal] = await Promise.allSettled([kane($, ['config', 'show', '--agent'], 20_000), kane($, ['balance'], 30_000)])
  const [who] = await Promise.allSettled([kane($, ['whoami'], 30_000)])
  const auth: KaneEnv['auth'] = resolveAuth(
    who.status === 'fulfilled' ? who.value.exitCode : undefined,
    bal.status === 'fulfilled' ? bal.value.exitCode : undefined,
  )
  const whoText = who.status === 'fulfilled' ? stripAnsi(who.value.stdout || who.value.stderr) : ''
  await update($, envAtom, () => ({
    isChecking: false,
    isInstalled: true,
    version,
    auth,
    whoami: whoText ? (auth === 'ok' ? describeIdentity(parseWhoami(whoText)) : compactBox(whoText)) : undefined,
    config: cfg.status === 'fulfilled' ? parseConfig(cfg.value.stdout) : {},
    balance:
      bal.status === 'fulfilled' && bal.value.exitCode === 0 ? describeBalance(stripAnsi(bal.value.stdout)) : undefined,
  }))
}

async function refreshTests($: $) {
  await update($, testsAtom, t => ({ ...t, isLoading: true, error: undefined }))
  try {
    const r = await kane($, ['testmd', 'list', '--json'], 30_000)
    const items = parseTests(r.stdout)
    await update($, testsAtom, () => ({
      isLoading: false,
      items,
      error: r.exitCode === 0 ? undefined : clip(stripAnsi(r.stderr || r.stdout), 200),
    }))
  } catch (err) {
    await update($, testsAtom, () => ({ isLoading: false, items: [], error: String(err instanceof Error ? err.message : err) }))
  }
}

async function pushHistory($: $, entry: KaneHistoryEntry) {
  // Several sessions share the store: merge with what is there rather than overwrite it.
  const stored = await $.store.get('history')
  const kept = Array.isArray(stored) ? (stored as KaneHistoryEntry[]) : []
  const next = await update($, historyAtom, list => mergeHistory([entry], mergeHistory(list ?? [], kept)))
  await $.store.set('history', next)
}

// ── what is live, everywhere at once ─────────────────────────────────

/** Keeps the list of runs in flight current: a running run is in it, a finished one leaves. */
async function track($: $, run: KaneRun) {
  await update($, liveAtom, live => {
    const rest = Object.fromEntries(Object.entries(live ?? {}).filter(([id]) => id !== run.id))
    return run.status === 'running' ? { ...rest, [run.id]: run } : rest
  })
  void refreshChrome($)
}

let lastStatus: string | undefined
let lastTitle = 'Kane QE'

/**
 * The status line and the pane's tab, from state: what is running now, else the
 * last result while it is fresh, else nothing. Called on every change and on a
 * timer, so "2m ago" ages and an old result clears instead of lingering.
 */
async function refreshChrome($: $) {
  try {
    await drawChrome($)
  } catch (error) {
    $.ui.log(`kane-qe status: ${String(error)}`, { to: 'debug' })
  }
}

let chromeSeq = 0

async function drawChrome($: $) {
  const seq = ++chromeSeq
  const [live, history, assurance] = await Promise.all([read($, liveAtom), read($, historyAtom), read($, assuranceAtom)])
  const now = await $.clock.now()
  const running = Object.values(live).sort((a, b) => b.startedAt - a.startedAt)
  const job = assurance.job?.status === 'running' ? assurance.job : undefined
  let text: string | undefined
  if (running.length) {
    const top = running[0]!
    const doing = stepLine(top) ?? top.progress ?? 'starting'
    text = `kane ◐ ${running.length > 1 ? `${running.length} running · ` : ''}${clip(top.label, 28)} · ${clip(doing, 40)}`
  } else if (job) {
    text = `kane ◐ ${clip(job.label, 40)}${job.activity.length ? ` · ${clip(job.activity[job.activity.length - 1]!, 30)}` : ''}`
  } else {
    const done = history[0]
    const age = done ? now - done.endedAt : Infinity
    if (done && age < 10 * 60_000) text = `kane ${ICON[done.status] ?? '?'} ${done.status} ${ago(age)} · ${clip(done.label, 36)}`
  }
  // Two draws can overlap (a run's update and the timer): only the newest one speaks.
  if (seq !== chromeSeq) return
  if (text !== lastStatus) {
    lastStatus = text
    $.ui.status(text)
  }
  // The pane's tab says the same at a glance; retitle only an open pane, never reopen a closed one.
  const lastRun = history[0]
  const title = running.length ? `Kane QE ◐${running.length > 1 ? running.length : ''}` : job ? 'Kane QE ◐' : lastRun && now - lastRun.endedAt < 10 * 60_000 ? `Kane QE ${ICON[lastRun.status] ?? ''}`.trim() : 'Kane QE'
  if (title !== lastTitle) {
    const panes = await $.ui.panes().catch(() => [])
    if (panes.some(p => p.id === PANE)) {
      lastTitle = title
      await $.ui.open({ id: PANE, title }).catch(() => undefined)
    }
  }
}

/**
 * What a run is doing, in words: kane names a running step only "Step 4" until it
 * finishes, so show the newest step that says something real.
 */
function stepLine(run: KaneRun): string | undefined {
  const last = run.steps[run.steps.length - 1]
  if (!last) return undefined
  if (last.detail) return `${tidyStep(last.text)} ↳ ${last.detail}`
  const said = [...run.steps].reverse().find(s => !/^Step \d+$/i.test(s.text.trim()))
  return said ? `step ${last.n} · ${tidyStep(said.text)}` : `step ${last.n}`
}

/** Puts the pane on screen for a run that just started, without taking the keys. */
async function ensurePane($: $) {
  const panes = await $.ui.panes().catch(() => [])
  if (!panes.some(p => p.id === PANE)) await $.ui.open({ id: PANE, title: lastTitle }).catch(() => undefined)
}

async function refreshBalance($: $) {
  try {
    const r = await kane($, ['balance'], 30_000)
    if (r.exitCode === 0) {
      const balance = describeBalance(stripAnsi(r.stdout))
      if (balance) await update($, envAtom, env => ({ ...env, balance }))
    }
  } catch {
    // keep the last reading
  }
}

/**
 * What changes when any run ends, whoever started it: Insights moves to it
 * (unless the person picked another run), credits, saved tests and coverage.
 */
async function afterRun($: $, run: KaneRun) {
  try {
    await settleRun($, run)
  } catch (error) {
    $.ui.log(`kane-qe after run: ${String(error)}`, { to: 'debug' })
  }
}

async function settleRun($: $, run: KaneRun) {
  if (run.sessionDir) {
    const focus = await read($, focusAtom)
    if (!focus.isPinned && focus.sessionDir !== run.sessionDir) {
      await update($, focusAtom, f => ({ ...f, sessionDir: run.sessionDir, step: undefined }))
      await update($, shotAtom, () => null)
    }
  }
  // Background refreshes: a failure here must never surface as an unhandled rejection.
  void refreshBalance($).catch(() => undefined)
  void refreshTests($).catch(() => undefined)
  if ((await read($, assuranceAtom)).hasStore) void refreshAssurance($).catch(() => undefined)
}

// Listing sizes of what other tools write into the project; a change means a tab is stale.
let projectSignature = ''

/** Notices work done outside the pane (a terminal, CI, another agent) and refreshes what it changed. */
async function watchProject($: $) {
  try {
    await checkProject($)
  } catch (error) {
    $.ui.log(`kane-qe watch: ${String(error)}`, { to: 'debug' })
  }
}

async function checkProject($: $) {
  if (!projectDir) return
  const sig = async (dir: string) => {
    try {
      return (await $.fs.list(`${projectDir}/${dir}`)).map(f => `${f.name}:${f.size ?? ''}`).sort().join('|')
    } catch {
      return ''
    }
  }
  const [commits, tests, evidence] = await Promise.all([sig('.context/commits'), sig('.testmuai/tests'), sig('.testmuai/evidence')])
  const next = `${commits}#${tests}#${evidence}`
  if (next === projectSignature) return
  const before = projectSignature.split('#')
  projectSignature = next
  if (!before[0] && !before[1] && !before[2] && before.length === 1) return // first look: nothing to compare yet
  if (tests !== before[1]) void refreshTests($).catch(() => undefined)
  if ((commits !== before[0] || evidence !== before[2]) && !isAssuring) void refreshAssurance($).catch(() => undefined)
}

/**
 * Runs one kane-cli NDJSON command to its end, folding every event into the
 * shared run view (the pane, the band, the status line) as it arrives.
 */
async function execute(
  $: $,
  kind: KaneRunKind,
  label: string,
  args: string[],
  source: KaneRun['source'],
  signal?: AbortSignal,
  callId?: string,
): Promise<KaneRun> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  let run: KaneRun = { ...newRun(id, kind, label, source, await $.clock.now()), callId, args }
  const publish = async () => {
    await update($, runAtom, cur => (cur === null || cur.id === id ? run : cur))
    if (callId) {
      await update($, cardsAtom, cards => {
        const kept = Object.entries(cards ?? {}).filter(([k]) => k !== callId).slice(-29)
        return { ...Object.fromEntries(kept), [callId]: run }
      })
    }
    await track($, run)
  }
  // A new run always takes the cockpit; later updates only touch it while it is still the one shown.
  await update($, runAtom, () => run)
  await update($, tabAtom, () => 'run')
  if (kind === 'run') {
    const urlAt = args.indexOf('--url')
    const url = urlAt === -1 ? '' : (args[urlAt + 1] ?? '')
    // args are ['run', <objective>, ...]: the label can be a display name ("Web vitals · …").
    const objective = args[0] === 'run' && typeof args[1] === 'string' ? args[1] : label
    await update($, formAtom, f => ({ ...f, objective, url }))
    await update($, coachAtom, () => null)
  }
  // Warn before credits run out mid-run (a run takes about 10-50).
  const left = Number(/(-?[\d.]+)\s+of\s+[\d.]+/.exec((await read($, envAtom)).balance ?? '')?.[1])
  if (Number.isFinite(left) && left < 15) run = { ...run, warnings: [...run.warnings, `Only ${left} credits left: a run usually takes 10-50, so this one may stop early.`] }
  await publish()
  void ensurePane($)

  const stream = $.process.spawn({
    argv: [...base, ...streamMembers(kaneArgv(await withStartUrl($, args)))],
    env: { KANE_CLI_USER_AGENT: AGENT_NAME, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  let isStopped = false
  const stop = () => {
    isStopped = true
    const pid = active.get(id)?.pid
    if (pid !== undefined) {
      void $.process.run(['kill', '-INT', String(pid)]).catch(() => undefined)
    } else {
      void stream.return(undefined as never)
    }
  }
  active.set(id, { stop })
  const onAbort = () => stop()
  signal?.addEventListener('abort', onAbort)

  let out = ''
  let err = ''
  let exitCode = 2
  try {
    for await (const piece of stream) {
      if (piece.stream === 'stderr') {
        const t = takeLines(err + piece.text)
        err = t.rest
        // kane's update banner is not part of any run's story.
        const said = t.lines.map(stripAnsi).filter(l => l.trim() && !/^Skill update available/.test(l))
        if (said.length) run = { ...run, stderrTail: [...run.stderrTail, ...said].slice(-15) }
        continue
      }
      const t = takeLines(out + piece.text)
      out = t.rest
      let changed = false
      for (const line of t.lines) {
        const evt = parseLine(line)
        if (!evt) continue
        const next = applyEvent(run, evt)
        if (next !== run) {
          run = next
          changed = true
        }
        if (evt.type === 'stream_start' && typeof evt.pid === 'number') {
            active.set(id, { pid: evt.pid, stop })
            ownPids.add(evt.pid)
          }
      }
      if (changed) await publish()
    }
    const ended = await stream.result
    exitCode = ended.code ?? (isStopped ? 3 : 1)
  } catch (error) {
    run = { ...run, errors: [...run.errors, `Could not run kane-cli: ${String(error instanceof Error ? error.message : error)}`] }
    exitCode = isStopped ? 3 : 2
  } finally {
    signal?.removeEventListener('abort', onAbort)
    const ownPid = active.get(id)?.pid
    if (ownPid !== undefined) ownPids.delete(ownPid)
    active.delete(id)
  }

  const tail = parseLine(out.trim())
  if (tail) run = applyEvent(run, tail)
  run = finishRun(run, exitCode, await $.clock.now())
  if (isStopped && run.status !== 'passed') run = { ...run, status: 'cancelled' }
  // A grid job HyperExecute refused (plan, quota, credentials) ends as "broken" members; say why.
  if (run.remoteJob?.log && !run.remoteJob.id && run.status !== 'passed') {
    const why = remoteFailure(await $.fs.read(run.remoteJob.log).catch(() => ''))
    if (why) run = { ...run, status: 'error', oneLiner: `The grid refused the job: ${why}`, errors: [...run.errors, `HyperExecute: ${why}`].slice(-5) }
  }
  await pushHistory($, toHistory(run, args))
  await publish()
  if (run.sessionDir) void loadInsights($, run.sessionDir, label)
  void afterRun($, run)

  const took = run.durationS !== undefined ? ` ${run.durationS}s` : ''
  $.ui.toast(`Kane ${run.status}${took}: ${clip(run.oneLiner ?? label, 70)}`)
  return run
}

/** A local suite also streams each member's own steps, so its rows move while members run. */
function streamMembers(argv: string[]): string[] {
  const isLocalSuite = argv[0] === 'testrun' && !argv.includes('--remote') && !argv.includes('--dry-run')
  return isLocalSuite && !argv.includes('--stream-members') ? [...argv, '--stream-members'] : argv
}

/** Starts a run that outlives the dispatch that asked for it (a press, a command). */
function launch($: $, kind: KaneRunKind, label: string, args: string[], source: KaneRun['source']) {
  void execute($, kind, label, args, source).catch(error => $.ui.log(`kane-qe: ${String(error)}`, { to: 'debug' }))
}

/**
 * Runs an objective, unless it would spend credits without verifying anything
 * (or leans on variables nobody set): then it is held in the cockpit with the
 * reason, for the person to run anyway or have Claude add checks.
 */
// ── insights: what a run's evidence pack says ───────────────────────────

const INSIGHTS_KEPT = 12
// Bump when the reading rules change: readings kept in state from an older version are redone.
const INSIGHTS_VERSION = 13

async function unzipText($: $, pack: string, pattern: string): Promise<string> {
  try {
    return (await $.process.run(['unzip', '-p', pack, pattern], { timeoutMs: 30_000 })).stdout
  } catch {
    return ''
  }
}

/** Reads a session's evidence pack once and keeps what it says, newest first. */
async function loadInsights($: $, sessionDir: string | undefined, label: string, isForced = false): Promise<RunInsights | undefined> {
  if (!sessionDir) return undefined
  const cached = (await read($, insightsAtom))[sessionDir]
  if (cached?.data && cached.version === INSIGHTS_VERSION && !isForced) return cached.data
  if (cached?.isLoading) return undefined
  await update($, insightsAtom, all => {
    const keep = Object.entries(all ?? {}).filter(([k]) => k !== sessionDir).slice(-(INSIGHTS_KEPT - 1))
    return { ...Object.fromEntries(keep), [sessionDir]: { isLoading: true } }
  })
  try {
    let pack: string | undefined
    try {
      const entry = (await $.fs.list(`${sessionDir}/evidence`)).find(e => e.name.endsWith('.evidence'))
      pack = entry ? `${sessionDir}/evidence/${entry.name}` : undefined
    } catch {
      pack = undefined
    }
    const events = await $.fs.read(`${sessionDir}/events.ndjson`).catch(() => '')
    const files = pack
      ? await Promise.all([
          $.process.run(['unzip', '-lv', pack], { timeoutMs: 20_000 }).then(r => r.stdout, () => ''),
          unzipText($, pack, 'tests/*/result.yaml'),
          unzipText($, pack, 'tests/*/steps/*/step.json'),
          unzipText($, pack, 'tests/*/logs/0-network.har'),
          unzipText($, pack, 'tests/*/logs/0-console.ndjson'),
          unzipText($, pack, 'tests/*/logs/0-run.log'),
          unzipText($, pack, 'tests/*/steps/*/failure.yaml'),
          unzipText($, pack, 'tests/*/v16-trajectory/0-run_summary.json'),
        ])
      : ['', '', '', '', '', '', '', '']
    const [listing, resultYaml, stepJsons, har, consoleText, runLog, failureYaml, runSummary] = files
    const data = buildInsights({
      sessionDir,
      pack,
      label,
      events,
      listing: parseZipListing(listing ?? ''),
      resultYaml: resultYaml ?? '',
      stepJsons: stepJsons ?? '',
      har: har ?? '',
      console: consoleText ?? '',
      runLog: runLog ?? '',
      failureYaml: failureYaml ?? '',
      runSummary: runSummary ?? '',
    })
    await update($, insightsAtom, all => ({ ...(all ?? {}), [sessionDir]: { isLoading: false, data, version: INSIGHTS_VERSION } }))
    const signals = data.httpIssues.filter(i => i.isFirstParty || i.isSuspicious).length + (data.consoleErrors ? 1 : 0)
    const next = await update($, historyAtom, list =>
      (list ?? []).map(h =>
        h.sessionDir === sessionDir
          ? {
              ...h,
              insight: { kind: data.attribution.kind, headline: data.attribution.headline, signals },
              // A run the account stopped (out of credits) is not a test failure.
              status: data.reason && OUT_OF_CREDITS.test(data.reason) && h.status === 'failed' ? ('error' as const) : h.status,
              vitals: Object.keys(data.vitals).length ? data.vitals : h.vitals,
              // Runs learned from disk carried the session's wall time; kane's own run time is the comparable one.
              durationS: h.id.startsWith('disk-') && data.durationMs ? Math.round(data.durationMs / 100) / 10 : h.durationS,
            }
          : h,
      ),
    )
    await $.store.set('history', next)
    return data
  } catch (error) {
    await update($, insightsAtom, all => ({ ...(all ?? {}), [sessionDir]: { isLoading: false, error: String(error instanceof Error ? error.message : error) } }))
    return undefined
  }
}

/**
 * Every kane-cli session leaves a folder under ~/.testmuai/kaneai/sessions,
 * whoever started it (this mod, a terminal, CI). History learns the ones it
 * has not seen, so runs from before the mod, or lost from its list, come back.
 */
async function backfillHistory($: $) {
  const home = await $.env.get('HOME').catch(() => undefined)
  if (!home) return
  const root = `${home}/.testmuai/kaneai/sessions`
  let names: string[] = []
  try {
    names = (await $.fs.list(root)).filter(e => e.kind === 'dir' && e.name !== 'active' && !e.name.startsWith('testrun-')).map(e => e.name)
  } catch {
    return
  }
  // Entries pointing outside kane's sessions folder at something that is gone (a test run's
  // temp folder) cannot be read again: drop them. kane's own folders stay, even once deleted.
  const current = await read($, historyAtom)
  const stale: string[] = []
  for (const h of current) {
    if (h.sessionDir && !h.sessionDir.startsWith(root) && !(await $.fs.exists(h.sessionDir).catch(() => true))) stale.push(h.id)
  }
  if (stale.length) {
    const kept = await update($, historyAtom, list => (list ?? []).filter(h => !stale.includes(h.id)))
    await $.store.set('history', kept)
  }
  // A "failed" run that spent no credits never ran (kane refused to start it): it is an error,
  // and counting it as a failure would mark a healthy test as flaky.
  const neverRan = (h: KaneHistoryEntry) => (h.status === 'failed' || h.status === 'error') && h.credits === 0 && h.insight?.kind !== 'unknown'
  if ((await read($, historyAtom)).some(neverRan)) {
    // Drop any earlier reading too, so the evidence is read again under today's rules.
    const relabelled = await update($, historyAtom, list => (list ?? []).map(h => (neverRan(h) ? { ...h, status: 'error' as const, insight: undefined } : h)))
    await $.store.set('history', relabelled)
  }
  // Reruns learned from disk before the start URL was kept: add it.
  const urlFixes = new Map<string, string[]>()
  for (const h of await read($, historyAtom)) {
    if (!h.id.startsWith('disk-') || !h.sessionDir || h.rerun.includes('--url')) continue
    const url = await sessionUrl($, h.sessionDir)
    if (url) urlFixes.set(h.id, [...h.rerun, '--url', url])
  }
  if (urlFixes.size) {
    const fixed = await update($, historyAtom, list => (list ?? []).map(h => (urlFixes.has(h.id) ? { ...h, rerun: urlFixes.get(h.id)! } : h)))
    await $.store.set('history', fixed)
  }
  // Runs followed from a terminal before their objective could be read keep a generic name
  // ("kane-cli run in proj"): name them from their own events, and give them their URL to rerun.
  const names2 = new Map<string, { label: string; rerun: string[] }>()
  for (const h of await read($, historyAtom)) {
    if (!h.sessionDir || !/^kane-cli \w+ in /.test(h.label)) continue
    const events = await $.fs.read(`${h.sessionDir}/events.ndjson`).catch(() => '')
    const label = events.split('\n').map(l => parseLine(l.trim())).map(e => (e ? labelFromEvent(e) : undefined)).find(Boolean)
    if (!label) continue
    const url = await sessionUrl($, h.sessionDir)
    const rerun = h.kind === 'run' ? ['run', label, '--agent', ...(url ? ['--url', url] : [])] : h.rerun
    names2.set(h.id, { label, rerun: h.rerun.length ? h.rerun : rerun })
  }
  if (names2.size) {
    const named = await update($, historyAtom, list => (list ?? []).map(h => (names2.has(h.id) ? { ...h, ...names2.get(h.id)! } : h)))
    await $.store.set('history', named)
  }
  // Runs learned from disk before kane's own run time was used: correct them once.
  const fixes = new Map<string, number>()
  for (const h of await read($, historyAtom)) {
    if (!h.id.startsWith('disk-') || !h.sessionDir) continue
    const end = parseRunEnd(await $.fs.read(`${h.sessionDir}/events.ndjson`).catch(() => ''))
    const seconds = typeof end?.duration === 'number' ? Math.round(end.duration * 10) / 10 : undefined
    if (seconds !== undefined && seconds !== h.durationS) fixes.set(h.id, seconds)
  }
  if (fixes.size) {
    const fixed = await update($, historyAtom, list => (list ?? []).map(h => (fixes.has(h.id) ? { ...h, durationS: fixes.get(h.id) } : h)))
    await $.store.set('history', fixed)
  }
  const known = new Set((await read($, historyAtom)).map(h => h.sessionDir).filter(Boolean))
  const found: KaneHistoryEntry[] = []
  for (const name of names) {
    const dir = `${root}/${name}`
    if (known.has(dir)) continue
    try {
      const session = JSON.parse(await $.fs.read(`${dir}/session.json`)) as Record<string, unknown>
      const first = (Array.isArray(session.runs) ? session.runs[0] : undefined) as Record<string, unknown> | undefined
      const objective = typeof first?.objective === 'string' ? first.objective.replace(/\s+/g, ' ').trim() : undefined
      if (!objective) continue
      const started = Date.parse(String(session.started_at ?? ''))
      const ended = Date.parse(String(session.ended_at ?? ''))
      const status = first?.status === 'passed' ? 'passed' : first?.status === 'failed' ? 'failed' : 'error'
      const end = parseRunEnd(await $.fs.read(`${dir}/events.ndjson`).catch(() => ''))
      const runSeconds = typeof end?.duration === 'number' ? Math.round(end.duration * 10) / 10 : undefined
      found.push({
        id: `disk-${name}`,
        kind: 'run',
        label: objective,
        status,
        durationS: runSeconds ?? (Number.isFinite(started) && Number.isFinite(ended) ? Math.round((ended - started) / 100) / 10 : undefined),
        credits: typeof session.credits_consumed === 'number' ? Math.round(session.credits_consumed * 100) / 100 : undefined,
        sessionDir: dir,
        endedAt: Number.isFinite(ended) ? ended : Number.isFinite(started) ? started : 0,
        rerun: await (async () => {
          const url = await sessionUrl($, dir)
          return url ? ['run', objective, '--agent', '--url', url] : ['run', objective, '--agent']
        })(),
      })
    } catch {
      // a session that never wrote session.json: skip it
    }
  }
  if (!found.length) return
  const next = await update($, historyAtom, list => mergeHistory(list ?? [], found))
  await $.store.set('history', next)
}

/** Shows one run in the Insights tab, reading its evidence if it has not been read. */
async function focusRun($: $, sessionDir: string | undefined, label: string) {
  if (!sessionDir) {
    await flash($, 'That run left no session folder to read.')
    return
  }
  // The person chose this run: a later run does not take Insights away from it.
  await update($, focusAtom, f => ({ ...f, sessionDir, step: undefined, isPinned: true }))
  await update($, shotAtom, () => null)
  await update($, tabAtom, () => 'insights')
  await loadInsights($, sessionDir, label)
}

/** Opens Insights on the run in focus, else the latest one with a session folder. */
async function openInsights($: $) {
  const focus = await read($, focusAtom)
  const run = await read($, runAtom)
  const history = await read($, historyAtom)
  const target = focus.sessionDir ?? (run?.status !== 'running' ? run?.sessionDir : undefined) ?? history.find(h => h.sessionDir)?.sessionDir
  if (!target) {
    await update($, tabAtom, () => 'insights')
    return
  }
  const label = history.find(h => h.sessionDir === target)?.label ?? run?.label ?? target
  await focusRun($, target, label)
}

/**
 * kane-cli refuses a headless `run` with no start URL ("No start URL provided"),
 * even with a default in its config: give it the configured default.
 */
async function withStartUrl($: $, args: readonly string[]): Promise<string[]> {
  if (args[0] !== 'run' || args.includes('--url')) return [...args]
  let url = (await read($, envAtom)).config.default_url
  if (!url) {
    try {
      url = parseConfig((await kane($, ['config', 'show', '--agent'], 20_000)).stdout).default_url
    } catch {
      url = undefined
    }
  }
  return url ? [...args, '--url', url] : [...args]
}

/** The start URL a session ran against, from its execution record. */
async function sessionUrl($: $, dir: string): Promise<string | undefined> {
  try {
    const exec = JSON.parse(await $.fs.read(`${dir}/execution.json`)) as Record<string, unknown>
    return typeof exec.url === 'string' && /^https?:/.test(exec.url) ? exec.url : undefined
  } catch {
    return undefined
  }
}

/** The pane's hotkeys, for keys a focused chart passed on: 1-5 and a tabs, 6-9 the tab's views. */
async function paneHotkey($: $, key: string) {
  const hit = TABS.find(t => t.hotkey === key)
  if (hit) {
    const target = hit.id
    if (target === 'assure') void refreshAssurance($)
    if (target === 'insights') await openInsights($)
    else await update($, tabAtom, () => target)
    // The chart that had the keys is gone with its tab: put the focus on the new tab's
    // button so the very next key reaches the pane instead of being spent finding a home.
    await $.ui.focus({ requestId: PANE, key: `tab-${target}` }).catch(() => undefined)
    return
  }
  const view = ['6', '7', '8', '9', '0'].indexOf(key)
  if (view === -1) return
  const tab = await read($, tabAtom)
  if (tab === 'insights' && view < 3) {
    const v = (['timeline', 'signals', 'time'] as const)[view]!
    await update($, focusAtom, f => ({ ...f, view: v }))
  } else if (tab === 'history') {
    const v = (['runs', 'trends', 'credits', 'quality', 'sites'] as const)[view]!
    await update($, historyViewAtom, () => v)
  }
}

// The pane's last drawn width, so a screenshot preview is cut to fit it.
let lastPaneColumns = 90

/** kitty and Ghostty draw real images; every other terminal gets the cell preview. */
async function pixelTerminal($: $): Promise<boolean> {
  const [term, program, kitty] = await Promise.all([
    $.env.get('TERM').catch(() => undefined),
    $.env.get('TERM_PROGRAM').catch(() => undefined),
    $.env.get('KITTY_WINDOW_ID').catch(() => undefined),
  ])
  return Boolean(kitty) || /kitty/i.test(term ?? '') || /ghostty/i.test(program ?? '')
}

/** Selects a step and pulls its screenshot out of the pack as a PNG the terminal can draw. */
async function selectStep($: $, n: number) {
  const focus = await update($, focusAtom, f => ({ ...f, step: n }))
  const ins = focus.sessionDir ? (await read($, insightsAtom))[focus.sessionDir]?.data : undefined
  const step = ins?.steps.find(s => s.n === n)
  if (!ins?.pack || !step?.screenshot) {
    await update($, shotAtom, () => null)
    return
  }
  const key = `${ins.sessionDir}#${n}`
  await update($, shotAtom, () => ({ key, isLoading: true }))
  try {
    const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp/').replace(/\/?$/, '/')
    const dir = `${tmp}kane-qe/${basename(ins.sessionDir)}/${n}`
    // unzip -d makes only the last folder level; make the whole path first.
    await $.process.run(['mkdir', '-p', dir], { timeoutMs: 10_000 })
    const pulled = await $.process.run(['unzip', '-o', '-j', ins.pack, step.screenshot, '-d', dir], { timeoutMs: 20_000 })
    if (pulled.exitCode !== 0) throw new Error(`Could not extract the screenshot: ${clip(pulled.stderr || pulled.stdout, 160)}`)
    const jpg = `${dir}/screenshot.jpg`
    const png = `${dir}/step.png`
    const isPixelTerminal = await pixelTerminal($)
    let pngPath: string | undefined
    let preview: { columns: number; rows: number; cells: string } | undefined
    if (isPixelTerminal) {
      const made = await $.process.run(['sips', '-s', 'format', 'png', '-Z', '1280', jpg, '--out', png], { timeoutMs: 20_000 })
      pngPath = made.exitCode === 0 ? png : undefined
    } else {
      // Two pixels per cell, sized to the pane: sips scales, the mod packs the cells.
      const size = previewSize(lastPaneColumns - 4)
      const bmp = `${dir}/preview-${size.width}.bmp`
      const made = await $.process.run(['sips', '-s', 'format', 'bmp', '-z', String(size.height), String(size.width), jpg, '--out', bmp], { timeoutMs: 20_000 })
      if (made.exitCode === 0) {
        const read = await $.fs.read(bmp, { as: 'bytes' })
        const raster = bmpToRaster(fromBase64(read.base64))
        if (raster) preview = { columns: raster.columns, rows: raster.rows, cells: toBase64(raster.cells) }
      }
    }
    await update($, shotAtom, s => (s?.key === key ? { key, isLoading: false, jpg, png: pngPath, preview, isPixelTerminal } : s))
  } catch (error) {
    await update($, shotAtom, s => (s?.key === key ? { key, isLoading: false, error: String(error instanceof Error ? error.message : error) } : s))
  }
}

/** Runs the same arguments several times in a row and reports how often it passed. */
function checkFlaky($: $, kind: KaneRunKind, label: string, args: string[], times = 3) {
  void (async () => {
    let passed = 0
    for (let i = 0; i < times; i++) {
      await flash($, `Flakiness check: run ${i + 1} of ${times}…`)
      const run = await execute($, kind, label, args, 'pane')
      if (run.status === 'error') {
        await flash($, `Flakiness check stopped: the run could not start (${clip(run.reason ?? run.stderrTail.slice(-1)[0] ?? 'setup error', 120)}).`)
        return
      }
      if (run.status === 'passed') passed++
      if (run.status === 'cancelled') break
    }
    await flash($, passed === times ? `Stable: passed ${passed} of ${times}.` : passed === 0 ? `Consistently failing: 0 of ${times} passed.` : `Flaky: passed ${passed} of ${times}.`)
  })().catch(error => $.ui.log(`kane-qe flaky check: ${String(error)}`, { to: 'debug' }))
}

function measureVitals($: $, url: string | undefined) {
  const objective = 'Open the page, wait for it to finish loading, then store all web vitals metrics (LCP, CLS, INP, FCP and TTFB)'
  launch($, 'run', `Web vitals${url ? ` · ${url}` : ''}`, runArgs({ objective, url, headless: true, timeoutSeconds: defaultTimeout }), 'pane')
}

async function checkCoverage($: $) {
  await update($, coverageAtom, () => ({ isLoading: true }))
  try {
    const r = await kane($, ['cover', 'gaps', '--json'], 60_000)
    const text = stripAnsi(r.stdout).trim()
    if (r.exitCode !== 0 || !text.startsWith('{')) {
      const said = stripAnsi(`${r.stderr}\n${r.stdout}`)
      const reason = /error:\s*(.+)$/m.exec(said)?.[1] ?? 'No requirement graph in this project yet.'
      await update($, coverageAtom, () => ({ isLoading: false, error: clip(reason, 300), checkedAt: Date.now() }))
      return
    }
    await update($, coverageAtom, () => ({ isLoading: false, summary: summarizeCoverage(JSON.parse(text) as Record<string, unknown>), checkedAt: Date.now() }))
  } catch (error) {
    await update($, coverageAtom, () => ({ isLoading: false, error: String(error instanceof Error ? error.message : error), checkedAt: Date.now() }))
  }
}

// ── the assurance loop: requirement → use cases → designed tests → coverage ──

/** The store's state, paused sessions (with their questions) and what coverage still owes. */
async function refreshAssurance($: $) {
  await update($, assuranceAtom, a => ({ ...a, isLoading: true, error: undefined }))
  const [list, sessions, gaps] = await Promise.allSettled([
    kane($, ['context', 'list', '--json'], 30_000),
    kane($, ['context', 'sessions', '--json'], 30_000),
    kane($, ['cover', 'gaps', '--json'], 60_000),
  ])
  const listed = list.status === 'fulfilled' ? list.value : undefined
  const nodes = listed ? parseContextList(listed.stdout) : []
  const said = listed ? stripAnsi(`${listed.stderr}\n${listed.stdout}`) : ''
  const hasStore = Boolean(listed && listed.exitCode === 0 && !/no (assurance |context )?store|NO_STORE|not initiali[sz]ed/i.test(said))
  let found = sessions.status === 'fulfilled' ? parseSessions(sessions.value.stdout) : []
  // A paused session's questions, so they can be answered from the pane.
  found = await Promise.all(
    found.slice(0, 4).map(async s => {
      if (!s.pending) return s
      try {
        const shown = await kane($, ['context', 'sessions', 'show', s.sid, '--json'], 30_000)
        return { ...s, questions: parseSessionShow(shown.stdout) }
      } catch {
        return s
      }
    }),
  )
  let cover: ReturnType<typeof coverageUseCases> = { usecases: [] }
  if (gaps.status === 'fulfilled' && stripAnsi(gaps.value.stdout).trim().startsWith('{')) {
    try {
      cover = coverageUseCases(JSON.parse(stripAnsi(gaps.value.stdout)) as Json)
    } catch {
      cover = { usecases: [] }
    }
  }
  const designed = await designedTests($)
  await update($, assuranceAtom, a => ({
    ...a,
    isLoading: false,
    designed,
    hasStore: hasStore && nodes.length > 0,
    error: listed && listed.exitCode !== 0 ? kaneError(said) : list.status === 'rejected' ? String(list.reason) : undefined,
    nodes,
    ...countNodes(nodes),
    sessions: found,
    designPct: cover.pct,
    provenPct: cover.provenPct,
    provenAt: cover.provenAt,
    proven: cover.proven,
    usecases: cover.usecases,
    checkedAt: Date.now(),
  }))
}

// The session's project folder: where kane-cli keeps .context/ and .testmuai/tests/.
let projectDir = ''

/** Designed tests on disk, by the assurance id design stamped in each. */
async function designedTests($: $): Promise<string[]> {
  if (!projectDir) return []
  const dir = `${projectDir}/.testmuai/tests`
  try {
    const files = (await $.fs.list(dir)).filter(f => f.name.endsWith('_test.md'))
    const ids = await Promise.all(files.slice(0, 200).map(async f => designedTestId(await $.fs.read(`${dir}/${f.name}`).catch(() => ''))))
    return [...new Set(ids.filter((x): x is string => Boolean(x)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch {
    return []
  }
}

// The one assurance command in flight: these write to a single-writer store.
let assureStop: (() => void) | undefined
// Claimed before the first await, so two quick presses cannot start two writers.
let isAssuring = false

/** Runs one headless (`--mode agent`) assurance command, streaming it into the Assurance tab. */
async function runAssure($: $, label: string, argv: string[], sid?: string): Promise<AssureJob | undefined> {
  if (isAssuring) {
    const cur = (await read($, assuranceAtom)).job
    await flash($, `Wait for "${clip(cur?.label ?? 'the assurance command', 40)}" to finish: the assurance store takes one writer at a time.`)
    return undefined
  }
  isAssuring = true
  try {
    return await streamAssure($, label, argv, sid)
  } finally {
    isAssuring = false
  }
}

async function streamAssure($: $, label: string, argv: string[], sid?: string): Promise<AssureJob> {
  const id = `as-${Date.now().toString(36)}`
  // Answering a paused session: carry its id so the pane does not offer the same questions twice.
  let job: AssureJob = { ...newJob(id, label, argv, await $.clock.now()), sid }
  const publish = () => update($, assuranceAtom, a => ({ ...a, job }))
  await publish()
  await update($, tabAtom, () => 'assure')
  void ensurePane($)
  void refreshChrome($)
  const stream = $.process.spawn({ argv: [...base, ...argv], env: { KANE_CLI_USER_AGENT: AGENT_NAME, FORCE_COLOR: '0', NO_COLOR: '1' } })
  let isStopped = false
  assureStop = () => {
    isStopped = true
    void stream.return(undefined as never)
  }
  let out = ''
  let err = ''
  let exitCode = 1
  try {
    for await (const piece of stream) {
      if (piece.stream === 'stderr') {
        err = (err + piece.text).slice(-4000)
        continue
      }
      const t = takeLines(out + piece.text)
      out = t.rest
      let changed = false
      for (const line of t.lines) {
        const evt = parseLine(line)
        if (!evt) continue
        const next = applyAssureEvent(job, evt)
        if (next !== job) {
          job = next
          changed = true
        }
      }
      if (changed) await publish()
    }
    const tail = parseLine(out.trim())
    if (tail) job = applyAssureEvent(job, tail)
    exitCode = (await stream.result).code ?? (isStopped ? 130 : 1)
  } catch (error) {
    job = { ...job, errors: [...job.errors, `Could not run kane-cli: ${String(error instanceof Error ? error.message : error)}`] }
  } finally {
    assureStop = undefined
  }
  job = finishJob(isStopped && job.status === 'running' ? { ...job, status: 'interrupted' } : job, exitCode, await $.clock.now(), stripAnsi(err))
  await publish()
  const said = job.status === 'paused' ? `paused on ${job.questions.length || 'a'} question${job.questions.length === 1 ? '' : 's'}` : job.status
  void refreshChrome($)
  $.ui.toast(`Kane ${clip(label, 50)}: ${said}${job.credits ? ` · ${job.credits} credits` : ''}`)
  void refreshAssurance($)
  return job
}

/** Runs a follow-up kane printed (`ready_command`, `next[]`): assurance verbs headless here, test runs as runs. */
function runReady($: $, command: string) {
  const words = splitWords(command)
  const argv = words[0] === 'kane-cli' ? words.slice(1) : words
  if (argv[0] === 'testmd' && argv[1] === 'run' && argv[2]) {
    launch($, 'testmd', argv[2], testArgs({ path: argv[2], headless: true, timeoutSeconds: defaultTimeout }), 'pane')
    return
  }
  if (argv[0] === 'testrun') {
    launch($, 'testrun', `suite ${argv.slice(2).join(' ')}`.trim(), kaneArgv(argv), 'pane')
    return
  }
  const isAgentVerb = ['context', 'design', 'maintain'].includes(argv[0] ?? '')
  const full = isAgentVerb && !argv.includes('--mode') ? [...argv, '--mode', 'agent'] : argv
  void runAssure($, clip(argv.slice(0, 4).join(' '), 60), full)
}

/** Answers one paused question by its option (1-based) or in words. */
async function answerQuestion($: $, from: Pick<AssureJob, 'argv' | 'sid' | 'resume' | 'verb'>, question: AssureQuestion, answer: string) {
  const argv = answerArgs(from, question.id, answer)
  if (!argv) {
    await flash($, 'This pause has no resume command; answer it in a terminal.')
    return
  }
  await runAssure($, `Answer: ${clip(question.header ?? question.text, 40)}`, argv.includes('--mode') ? argv : [...argv, '--mode', 'agent'], from.sid)
}

async function answerWithClaude($: $, from: Pick<AssureJob, 'resume' | 'verb'>, questions: readonly AssureQuestion[]) {
  await $.prompt.submit({
    text: [
      `kane-cli's assurance ${from.verb ?? 'session'} paused on ${questions.length} question(s) about my requirements. Help me answer them.`,
      ...questions.map(q => `- ${q.id} (${q.risk ?? '?'} risk): ${q.text}${q.rationale ? `\n  why: ${q.rationale}` : ''}\n  options: ${q.options.map((o, i) => `${i + 1}) ${o.label}${q.recommended === i ? ' [recommended]' : ''}${o.detail ? ` — ${o.detail}` : ''}`).join('; ')}`),
      'Read the requirement source if it helps (kane-cli context view --json, or the file I ingested). Recommend an answer for each with one line of reasoning, and ask me before answering anything high-risk.',
      from.resume ? `Then answer with Bash: ${from.resume} --answer <id>=<option number or words> (repeat --answer per question).` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  })
}

async function reviewWithClaude($: $) {
  await $.prompt.submit({
    text: [
      "Review the unreviewed (derived) items in this project's kane-cli assurance store as a senior QE.",
      'List them with `kane-cli context list --inferred --json`, read each with `kane-cli context explain <id> --json` and the source lines it cites.',
      'For each, recommend approve or skip with one line of reasoning (is it really in the requirement, is it testable, is anything missing).',
      'Ask me before applying, then run `kane-cli context review --approve <ids…> --mode agent` (and `--skip <ids…>` for the rest).',
    ].join('\n'),
  })
}

async function approveUseCase($: $, id: string) {
  const r = await kane($, ['context', 'review', '--approve', id, '--mode', 'agent'], 60_000)
  await flash($, r.exitCode === 0 ? `Approved ${id}: it can be designed now.` : `Could not approve ${id}: ${kaneError(stripAnsi(`${r.stderr}\n${r.stdout}`)) ?? `exit ${r.exitCode}`}`)
  await refreshAssurance($)
}

async function viewGraph($: $) {
  const dir = (await $.env.get('TMPDIR')) || '/tmp'
  const out = `${dir.replace(/\/$/, '')}/kane-qe-graph-${Date.now().toString(36)}.html`
  const r = await kane($, ['context', 'view', '--no-open', '--out', out], 60_000)
  if (r.exitCode !== 0) {
    await flash($, `Could not draw the graph: ${kaneError(stripAnsi(`${r.stderr}\n${r.stdout}`)) ?? `exit ${r.exitCode}`}`)
    return
  }
  await update($, assuranceAtom, a => ({ ...a, graphPath: out }))
  await flash($, 'Graph ready: open it with the link in the Assurance tab.')
}

// ── where suites run: this machine or the HyperExecute grid ──────────

async function checkGridPlugin($: $) {
  await update($, gridAtom, g => ({ ...g, plugin: 'checking' as const }))
  try {
    const r = await kane($, ['plugin', 'doctor', 'remote-execution'], 30_000)
    await update($, gridAtom, g => ({ ...g, plugin: parsePluginDoctor(r.stdout) }))
  } catch {
    await update($, gridAtom, g => ({ ...g, plugin: 'unknown' as const }))
  }
}

async function installGridPlugin($: $) {
  await update($, gridAtom, g => ({ ...g, plugin: 'checking' as const }))
  await flash($, 'Installing the remote-execution plugin…')
  const r = await kane($, ['plugin', 'install', 'remote-execution'], 300_000).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }))
  await flash($, r.exitCode === 0 ? 'Grid plugin installed.' : `Plugin install failed: ${kaneError(stripAnsi(`${r.stderr}\n${r.stdout}`)) ?? `exit ${r.exitCode}`}`)
  await checkGridPlugin($)
}

/** Devices for a target: the grid catalog with --remote, else what this machine has. */
async function loadDevices($: $) {
  const g = await read($, gridAtom)
  if (g.target === 'web') return
  await update($, gridAtom, x => ({ ...x, isLoading: true, error: undefined }))
  const argv = ['devices', 'list', '--target', g.target, ...(g.where === 'grid' ? ['--remote'] : []), '--agent']
  try {
    const r = await kane($, argv, 60_000)
    const devices = parseDevices(r.stdout)
    await update($, gridAtom, x => ({
      ...x,
      isLoading: false,
      devices,
      // An empty list arrives as {"total":0}: say so in words, keep real errors as kane printed them.
      error: devices.length
        ? undefined
        : /"total"\s*:\s*0/.test(r.stdout)
          ? `No ${g.target === 'simulator' ? 'iOS simulators' : 'Android emulators'} ${g.where === 'grid' ? 'in the grid catalog' : 'on this machine'}.`
          : (kaneError(stripAnsi(`${r.stderr}\n${r.stdout}`)) ?? 'No devices found.'),
    }))
  } catch (error) {
    await update($, gridAtom, x => ({ ...x, isLoading: false, devices: [], error: String(error instanceof Error ? error.message : error) }))
  }
}

async function setGrid($: $, change: Partial<Pick<KaneGrid, 'where' | 'target' | 'device' | 'osVersion'>>) {
  const before = await read($, gridAtom)
  const next = await update($, gridAtom, g => ({
    ...g,
    ...change,
    // A new place or platform has its own catalog: forget the picked device.
    ...(change.where !== undefined || change.target !== undefined ? { device: undefined, osVersion: undefined, devices: [], filter: undefined } : {}),
  }))
  if ((change.where !== undefined && change.where !== before.where) || (change.target !== undefined && change.target !== before.target)) {
    if (next.where === 'grid' && next.plugin !== 'ok') void checkGridPlugin($)
    if (next.target !== 'web') void loadDevices($)
    if (next.where === 'local' && next.target !== 'web') void runDoctor($, next.target)
  }
}

/** The suite options the Tests tab's place and device add. */
function gridOptions(g: KaneGrid): Pick<SuiteOptions, 'remote' | 'deviceName' | 'osVersion'> {
  return {
    remote: g.where === 'grid' || undefined,
    deviceName: g.target !== 'web' ? g.device : undefined,
    osVersion: g.target !== 'web' ? g.osVersion : undefined,
  }
}

async function runDoctor($: $, target: 'emulator' | 'simulator') {
  await update($, gridAtom, g => ({ ...g, doctor: { target, isLoading: true, checks: [] } }))
  try {
    const r = await kane($, ['doctor', '--target', target], 120_000)
    const checks = parseDoctor(stripAnsi(r.stdout + '\n' + r.stderr))
    await update($, gridAtom, g => ({
      ...g,
      doctor: { target, isLoading: false, checks, error: checks.length ? undefined : (kaneError(stripAnsi(`${r.stderr}\n${r.stdout}`)) ?? `exit ${r.exitCode}`) },
    }))
  } catch (error) {
    await update($, gridAtom, g => ({ ...g, doctor: { target, isLoading: false, checks: [], error: String(error instanceof Error ? error.message : error) } }))
  }
}

// ── the evidence viewer and a test's Test Manager state ──────────────

let viewerStop: (() => void) | undefined

/** Ends the `evidence serve` for a pack: closing the stream alone can leave the server listening. */
function killViewer($: $, pack: string) {
  // pkill -f takes a regex: match the path literally.
  const literal = pack.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  void $.process.run(['pkill', '-INT', '-f', `evidence serve ${literal}`], { timeoutMs: 5_000 }).catch(() => undefined)
}

/** Serves one pack to evidence.lambdatest.com from a local port, until stopped or replaced. */
async function openViewer($: $, pack: string) {
  viewerStop?.()
  await update($, viewerAtom, () => ({ pack, isStarting: true }))
  const stream = $.process.spawn({ argv: [...base, 'evidence', 'serve', pack], env: { KANE_CLI_USER_AGENT: AGENT_NAME, NO_COLOR: '1' } })
  let isDone = false
  viewerStop = () => {
    isDone = true
    void stream.return(undefined as never)
    killViewer($, pack)
    viewerStop = undefined
  }
  const timer = $.clock.after(20_000, () => {
    viewerStop?.()
    void update($, viewerAtom, v => (v?.pack === pack ? { pack, isStarting: false, error: 'evidence serve printed no viewer link within 20s, so it was stopped.' } : v))
  })
  let seen = ''
  void (async () => {
    try {
      for await (const piece of stream) {
        if (isDone) break
        seen = (seen + piece.text).slice(-6000)
        const url = viewerUrl(seen)
        if (url) {
          timer.cancel()
          await update($, viewerAtom, v => (v?.pack === pack ? { pack, url, isStarting: false } : v))
          await flash($, 'Evidence viewer is ready: open it with the link in Insights.')
        }
      }
      const ended = await stream.result.catch(() => ({ code: 1 }))
      if (!isDone) {
        await update($, viewerAtom, v => (v?.pack === pack ? { pack, isStarting: false, error: kaneError(stripAnsi(seen)) ?? `evidence serve stopped (exit ${ended.code ?? '?'})` } : v))
      }
    } catch (error) {
      await update($, viewerAtom, v => (v?.pack === pack ? { pack, isStarting: false, error: String(error instanceof Error ? error.message : error) } : v))
    }
  })()
}

async function closeViewer($: $) {
  viewerStop?.()
  await update($, viewerAtom, () => null)
}

async function validatePack($: $, pack: string) {
  const r = await kane($, ['evidence', 'validate', pack], 60_000)
  const said = stripAnsi(`${r.stdout}\n${r.stderr}`).split('\n').map(l => l.trim()).filter(l => l && !/^Skill update available/.test(l))
  await flash($, said.slice(-1)[0] ?? `evidence validate exit ${r.exitCode}`)
}

async function testStatus($: $, path: string) {
  const r = await kane($, ['testmd', 'status', path], 30_000)
  await update($, testNotesAtom, n => ({ ...n, [path]: describeTestStatus(stripAnsi(`${r.stdout}\n${r.stderr}`)) }))
}

async function testSync($: $, path: string) {
  await update($, testNotesAtom, n => ({ ...n, [path]: 'Syncing the test bundle to Test Manager…' }))
  const r = await kane($, ['testmd', 'sync', path], 120_000)
  const said = stripAnsi(`${r.stdout}\n${r.stderr}`)
  await update($, testNotesAtom, n => ({ ...n, [path]: r.exitCode === 0 ? `Synced: ${clip(said.split('\n').map(l => l.trim()).filter(l => l && !/^Skill update/.test(l)).slice(-1)[0] ?? 'done', 120)}` : `Sync failed: ${kaneError(said) ?? `exit ${r.exitCode}`}` }))
  void refreshTests($)
}

async function startObjective(
  $: $,
  objective: string,
  url: string | undefined,
  headless: boolean,
  source: KaneRun['source'],
  isCoached = true,
): Promise<'started' | 'coached' | 'empty'> {
  if (!objective.trim()) {
    await flash($, 'Type an objective first.')
    return 'empty'
  }
  await flash($, '')
  await update($, formAtom, f => ({ ...f, objective, url: url ?? f.url }))
  const coaching = coachObjective(objective)
  if (isCoached && needsCoaching(coaching)) {
    await update($, coachAtom, () => ({ objective, url: url || undefined, headless, ...coaching }))
    await update($, tabAtom, () => 'run')
    return 'coached'
  }
  await update($, coachAtom, () => null)
  launch($, 'run', objective, runArgs({ objective, url: url || undefined, headless, timeoutSeconds: defaultTimeout }), source)
  return 'started'
}

async function addChecksWithClaude($: $, coach: KaneCoach) {
  await update($, coachAtom, () => null)
  await $.prompt.submit({
    text: [
      `Improve this KaneAI objective before running it: "${coach.objective}"${coach.url ? ` (URL: ${coach.url})` : ''}.`,
      coach.hasNoCheck ? 'It has no verification: add 1-3 concrete assertions a QE would expect ("assert …"), and "store … as \'name\'" for any value worth keeping.' : '',
      coach.variables.length ? `It uses ${coach.variables.map(v => `{{${v}}}`).join(', ')}: ask me for values or pass them as variables (secret:true for credentials).` : '',
      `Show me the rewritten objective in one line, then run it with ${TOOL('kane_run')}.`,
    ]
      .filter(Boolean)
      .join('\n'),
  })
}

async function copyCi($: $, args: readonly string[] | undefined, surface?: Parameters<$['ui']['copy']>[0]['surface']) {
  if (!args?.length) return
  const text = ciCommand(args)
  const copied = await $.ui.copy({ text, surface }).catch(() => ({ isCopied: false as const }))
  await flash($, copied.isCopied ? 'Copied the CI command (set LT_USERNAME / LT_ACCESS_KEY as pipeline secrets).' : `CI: ${text}`)
}

async function triage($: $, sessionDir: string | undefined, label: string, oneLiner?: string) {
  const ins = sessionDir ? await loadInsights($, sessionDir, label) : undefined
  const where = sessionDir
    ? `The session directory is ${sessionDir}. Its ${ARTIFACTS}. Older layouts may also have runs/<n>/ with run_summary.json, step_NNN.json and screenshots/.`
    : 'Find the latest session under ~/.testmuai/kaneai/sessions/ (newest directory).'
  await $.prompt.submit({
    text: [
      `Triage this failed KaneAI (kane-cli) run as a QE engineer: "${label}".`,
      oneLiner ? `kane-cli reported: ${oneLiner}` : '',
      ins ? `What the evidence pack shows (read by the kane-qe mod):\n${insightsReport(ins)}` : '',
      'Rule: if the page logged no errors (network or console) at the failing steps, treat it as a CLI loop or model problem, not a product bug.',
      where,
      'Read the run summary and the failing step files, look at the screenshot of the failing step, and tell me:',
      '1) the failing step and what the agent saw, 2) whether this is a product bug, a test/objective problem, or flakiness (env/timing/selector),',
      '3) a concrete fix: a rewritten objective or test step, or a bug report (title, steps to reproduce, expected vs actual, evidence paths).',
    ]
      .filter(Boolean)
      .join('\n'),
  })
}

async function openPane($: $, tab?: KaneTab) {
  if (tab) await update($, tabAtom, () => tab)
  // Opened with the keys, so Tab, arrows, Enter and the hotkeys reach it at once; Esc hands them back.
  await $.ui.open({ id: PANE, title: 'Kane QE', focus: true })
}

/**
 * Loads what the pane shows: login and credits, saved tests, history (with runs
 * found on disk) and their evidence readings. Runs at session start, and again
 * when state was reset under the mod (/clear) and the pane or /kane is next used.
 */
async function restoreState($: $) {
  await update($, bootAtom, () => true)
  const stored = await $.store.get('history')
  if (Array.isArray(stored)) await update($, historyAtom, list => mergeHistory(list ?? [], stored as KaneHistoryEntry[]))
  void refreshEnv($).then(() => refreshTests($))
  void backfillHistory($)
    .then(async () => {
      // Newest first, one at a time: owner marks and Sites cover a working session without a burst of unzips.
      for (const h of (await read($, historyAtom)).filter(x => x.sessionDir && !x.insight).slice(0, 25)) {
        await loadInsights($, h.sessionDir, h.label)
      }
      // Readings kept in state from older rules: redo the one in focus so the open tab is current.
      const focus = await read($, focusAtom)
      const kept = focus.sessionDir ? (await read($, insightsAtom))[focus.sessionDir] : undefined
      if (focus.sessionDir && kept?.data && kept.version !== INSIGHTS_VERSION) await loadInsights($, focus.sessionDir, kept.data.label, true)
    })
    .catch(error => $.ui.log(`kane-qe history: ${String(error)}`, { to: 'debug' }))
}

/** Reloads state once after a reset (/clear clears it without a new session.start). */
async function ensureBooted($: $) {
  if (await read($, bootAtom)) return
  await restoreState($)
}

// ── tools the model can call ─────────────────────────────────────────

async function registerTools($: $) {
  await $.tool.register({
    name: 'kane_run',
    description:
      'Run a KaneAI browser test with kane-cli from a plain-English objective and wait for the verdict. Streams live into the user\'s Kane QE pane. ' +
      'Write objectives as actions ("click Sign in"), assertions ("assert the cart shows 2 items"; also network/console/perf/cookie/localStorage checks in plain English, e.g. "assert no console errors", "assert POST /api/login returned 200") ' +
      'and extractions ("store the order id as \'order_id\'" → returned in final_state). Use {{var}} for variables. Returns status, one-liner, steps, extracted values and the run dir for debugging. ' +
      'Exit semantics: passed / failed (test failed) / error (setup, auth, usage) / cancelled (timeout or stop). Use headless:true unless the user wants to watch.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'What to do and verify, in plain English' },
        url: { type: 'string', description: 'Start URL (defaults to the kane-cli config default_url)' },
        headless: { type: 'boolean', description: 'Run the browser headless (default true)' },
        max_steps: { type: 'number', description: 'Max agent steps (kane default 50)' },
        timeout_seconds: { type: 'number', description: `Run timeout (default ${defaultTimeout})` },
        variables: { type: 'object', description: 'Variables: {"name": {"value": "...", "secret": true}} or plain {"name": "value"}' },
        name: { type: 'string', description: 'Persist as a reusable *_test.md under .testmuai/tests and upload to Test Manager ([a-zA-Z0-9_-]+)' },
        mode: { type: 'string', enum: ['testing', 'action'] },
        assertion_mode: { type: 'string', enum: ['dom', 'visual'] },
        final_validation: { type: 'boolean', description: 'Add a final whole-objective validation checkpoint' },
        bug_detection: { type: 'string', enum: ['off', 'stop', 'continue'] },
        code_export: { type: 'boolean', description: 'Export Playwright code for the run' },
        code_language: { type: 'string', enum: ['python', 'javascript'] },
        target: { type: 'string', enum: ['desktop', 'emulator', 'simulator'], description: 'A virtual Android (emulator) or iOS (simulator) device on this Mac instead of desktop Chrome; needs app and kane_devices to pick a device' },
        device_name: { type: 'string', description: 'Mobile device as kane_devices lists it' },
        os_version: { type: 'string', description: 'Mobile OS version, e.g. 14 or 17.5' },
        app: { type: 'string', description: 'App under test for a mobile run: a local .apk (emulator) / .zip of the .app (simulator), or an uploaded APP… id' },
        variables_file: { type: 'string', description: 'Load variables from a JSON file' },
      },
      required: ['objective'],
    },
  })
  await $.tool.register({
    name: 'kane_test_run',
    description:
      'Replay a saved KaneAI test file (*_test.md) with kane-cli testmd run (self-healing replay on by default). Streams into the Kane QE pane and returns per-step results.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the *_test.md file' },
        headless: { type: 'boolean', description: 'default true' },
        author: { type: 'boolean', description: 'Re-author the test in place and commit a new version' },
        adaptive_heal: { type: 'boolean', description: 'Self-heal broken steps (default true)' },
        timeout_seconds: { type: 'number' },
      },
      required: ['path'],
    },
  })
  await $.tool.register({
    name: 'kane_suite_run',
    description:
      'Run many authored *_test.md tests as one suite with kane-cli testrun (select by paths, tags or regex; optional parallelism). Returns per-test pass/fail. Use dry_run to validate the plan first.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        tags: { type: 'string', description: 'Comma-separated tags, e.g. "smoke,checkout"' },
        match: { type: 'string', description: 'Regex over test paths' },
        parallel: { type: 'number', description: 'Parallel workers (web only)' },
        fail_fast: { type: 'boolean' },
        headless: { type: 'boolean', description: 'default true' },
        dry_run: { type: 'boolean', description: 'Resolve the plan (and with remote, the grid preflight and device) without running or spending anything' },
        remote: { type: 'boolean', description: 'Run on the LambdaTest HyperExecute cloud grid instead of this machine (web on grid Chrome, mobile on grid emulators/simulators). Needs the remote-execution plugin and a HyperExecute plan; try dry_run first' },
        device_name: { type: 'string', description: 'Device for mobile members (kane_devices; with remote, a grid catalog name like "Pixel 7")' },
        os_version: { type: 'string', description: 'OS version for mobile members' },
      },
    },
  })
  await $.tool.register({
    name: 'kane_devices',
    description:
      'List the mobile devices kane-cli can run on: Android emulators or iOS simulators on this Mac, or with remote:true the HyperExecute grid catalog. ' +
      'For a local target it also reports kane-cli doctor (missing Xcode / Android SDK and the fix). Use before kane_run target or kane_suite_run device_name.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['emulator', 'simulator'] },
        remote: { type: 'boolean', description: 'The grid catalog instead of this machine' },
      },
      required: ['target'],
    },
  })
  await $.tool.register({
    name: 'kane_assure',
    description:
      "Drive kane-cli's assurance loop headless (--mode agent) and show it in the Kane QE pane's Assurance tab: requirement → use cases → designed tests → coverage. " +
      'action: status (store, use cases, paused questions, coverage gaps — free) | ingest (source = file path or Jira/Confluence/Linear/web URL; lands it and extracts use cases — uses credits) | ' +
      'extract (pending sources — credits) | design (use_case → acceptance criteria, scenarios and *_test.md tests — credits) | answer (resume a paused session: session = its resume command or sid, answers = {question_id: option number or words}) | ' +
      'approve (use_cases = ids to promote to trusted) | evolve (re-design stale use cases after a requirement changed — credits) | sync (push/pull the store with the team location). ' +
      'A pause returns its questions: ask the user about high-risk ones before answering.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'ingest', 'extract', 'design', 'answer', 'approve', 'evolve', 'sync'] },
        source: { type: 'string' },
        use_case: { type: 'string' },
        use_cases: { type: 'array', items: { type: 'string' } },
        max: { type: 'number', description: 'design: most scenario+test pairs to keep' },
        allow_unreviewed: { type: 'boolean', description: 'design: design a use case not yet approved' },
        session: { type: 'string' },
        answers: { type: 'object', description: '{"q1": "1"} or {"q1": "free text"}' },
      },
      required: ['action'],
    },
  })
  await $.tool.register({
    name: 'kane_tests_list',
    description: 'List the KaneAI *_test.md tests in this project (path, name, tags, synced to Test Manager).',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'kane_status',
    description: 'Show kane-cli version, login state, active profile/env, Test Manager project/folder, run settings and credit balance.',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'kane_insights',
    description:
      'Read a kane-cli run\'s evidence pack and say who most likely owns the result: product bug (backed by page errors), automation (CLI loop or model, when the page logged no errors where it failed), or a passing run with hidden page signals. ' +
      'Returns per-step timing (model vs browser), network and console findings per step, kane\'s own verdict, loop signals and the evidence pack path. Defaults to the latest run.',
    inputSchema: { type: 'object', properties: { session_dir: { type: 'string', description: 'A ~/.testmuai/kaneai/sessions/<id> folder; default the latest run' } } },
  })
  await $.tool.register({
    name: 'kane_generate',
    description:
      'Generate test scenarios and cases with KaneAI from a feature description (kane-cli generate). Returns scenarios/cases and a request_id. ' +
      'Call again with save:true and request_id to write them as *_test.md files under .testmuai/tests.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'Feature, user story or requirement to cover' },
        scenario_limit: { type: 'number', description: '1-20' },
        per_scenario_limit: { type: 'number', description: '1-20' },
        save: { type: 'boolean' },
        request_id: { type: 'string', description: 'Required with save:true' },
      },
    },
  })
}

export const register: Register = (on, options) => {
  base = splitCommand(String(options.kaneCommand ?? 'kane-cli'))
  defaultTimeout = Number(options.defaultTimeoutSeconds ?? 600) || 600
  mirrorExternal = options.mirrorExternalRuns !== false
  openOnStart = options.openPaneOnStart === 'always' || options.openPaneOnStart === 'kane-projects' ? options.openPaneOnStart : 'never'

  // ── session lifecycle ────────────────────────────────────────────────

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    projectDir = String((e as { cwd?: unknown }).cwd ?? '').replace(/\/$/, '')

    await $.command.register({
      name: 'kane',
      description: 'KaneAI: run a test in plain English, replay a saved test, or open the QE cockpit',
      argumentHint: '[objective | url objective | file_test.md | tests | history | suite | triage | cases <feature> | help]',
    })

    await registerTools($)

    // A reload or restart leaves no child behind: settle any run that was mid-flight.
    await update($, runAtom, r => (r && r.status === 'running' ? { ...r, status: 'cancelled' as const, errors: [...r.errors, 'Interrupted by a reload'] } : r))
    // This load's children are new: a reload ended the last one's runs (the mirror re-finds outside ones).
    await update($, liveAtom, () => ({}))
    lastStatus = undefined
    // By default the cockpit stays closed until /kane or a run. Opted in, it opens where the project itself
    // uses kane: saved tests, evidence or a requirement store. ~/.testmuai is kane-cli's global config, not a project.
    void (async () => {
      const home = await $.env.get('HOME').catch(() => undefined)
      const has = (path: string) => $.fs.exists(`${projectDir}/${path}`).catch(() => false)
      const usesKane = Boolean(projectDir) && projectDir !== home && ((await has('.testmuai/tests')) || (await has('.testmuai/evidence')) || (await has('.context')))
      if (openOnStart === 'always' || (openOnStart === 'kane-projects' && usesKane)) await ensurePane($)
    })().catch(() => undefined)
    $.clock.every(15_000, () => void refreshChrome($))
    $.clock.every(3_000, () => void watchProject($))
    await update($, assuranceAtom, a => (a.job?.status === 'running' ? { ...a, job: { ...a.job, status: 'interrupted' as const, errors: [...a.job.errors, 'Interrupted by a reload'] } } : a))
    // This load cannot reach a viewer the last one started: end it rather than leave it listening.
    const oldViewer = await read($, viewerAtom)
    if (oldViewer) killViewer($, oldViewer.pack)
    await update($, viewerAtom, () => null)
    await restoreState($)
    if (mirrorExternal) $.clock.every(2000, () => void pollExternal($))
    return started
  })


  // ── slash commands ───────────────────────────────────────────────────

  on('command.run', { command: 'kane' }, async ($, e) => {
    await ensureBooted($)
    const intent = routeKane(e.args)
    const open = async (tab?: KaneTab) => {
      if (tab) await update($, tabAtom, () => tab)
      return $.ui.open({ id: PANE, title: 'Kane QE', focus: true })
    }
    switch (intent.kind) {
      case 'help':
        return { text: KANE_HELP }
      case 'home':
      case 'tab': {
        if (intent.kind === 'tab' && intent.tab === 'insights') await openInsights($)
        if (intent.kind === 'tab' && intent.tab === 'assure') void refreshAssurance($)
        const opened = await open(intent.kind === 'tab' ? intent.tab : undefined)
        return {
          text: opened.isPlaced
            ? 'Kane QE cockpit opened (Esc returns to the prompt; ctrl+x tab comes back). /kane help lists what /kane understands.'
            : `Kane QE cockpit is open but not drawn yet: ${opened.reason}`,
        }
      }
      case 'run': {
        await open('run')
        const started = await startObjective($, intent.objective, intent.url, false, 'command')
        if (started === 'coached') return { text: `Held before running: ${intent.objective} — see the cockpit (Run anyway, or let Claude add checks).` }
        return { text: `Kane run started: ${intent.objective}${intent.url ? ` @ ${intent.url}` : ''}` }
      }
      case 'test':
        await open('run')
        launch($, 'testmd', intent.path, testArgs({ path: intent.path, timeoutSeconds: defaultTimeout }), 'command')
        return { text: `Replaying ${intent.path}` }
      case 'suite': {
        await open('run')
        const label = intent.args.length ? `suite ${intent.args.join(' ')}` : 'suite (all tests)'
        launch($, 'testrun', label, ['testrun', 'run', ...intent.args], 'command')
        return { text: `Kane suite started: ${label}` }
      }
      case 'ingest': {
        await open('assure')
        await update($, assuranceAtom, a => ({ ...a, source: intent.source }))
        void runAssure($, `Ingest & extract ${clip(intent.source, 40)}`, ['context', 'ingest', intent.source, '--mode', 'agent'])
        return { text: `Ingesting ${intent.source} and extracting use cases (uses credits). Questions kane asks show in the Assurance tab.` }
      }
      case 'stop': {
        const n = active.size
        assureStop?.()
        for (const a of active.values()) a.stop()
        return { text: n ? `Stopping ${n} Kane run(s).` : 'No Kane run is in progress.' }
      }
      case 'insights': {
        const words = intent.query.toLowerCase().split(/\s+/).filter(Boolean)
        const hit = (await read($, historyAtom)).find(h => h.sessionDir && words.every(w => h.label.toLowerCase().includes(w)))
        if (!hit) {
          await open('history')
          return { text: `No run matches "${intent.query}". Pick one in History.` }
        }
        await focusRun($, hit.sessionDir, hit.label)
        await open()
        return { text: `Insights: ${hit.label}` }
      }
      case 'triage': {
        const failed = (await read($, historyAtom)).find(entry => entry.status === 'failed' || entry.status === 'error')
        if (!failed) return { text: 'No failed Kane run in history.' }
        await triage($, failed.sessionDir, failed.label, failed.oneLiner)
        return { text: `Triaging: ${failed.label}` }
      }
      case 'cases':
        await $.prompt.submit({
          text: [
            `Use the ${TOOL('kane_generate')} tool to generate KaneAI test cases for: ${intent.feature}`,
            'Then review them as a senior QE: show scenarios and cases as a table, flag gaps (negative paths, boundaries, auth/permissions, accessibility, error states),',
            'and ask me whether to save them as *_test.md files (call the tool again with save: true and the request_id).',
          ].join('\n'),
        })
        return { text: `Generating test cases for: ${intent.feature}` }
      case 'ask':
        await $.prompt.submit({
          text: `${intent.text}\n\n(About my KaneAI / kane-cli testing. Use the ${TOOL('kane_status')} / ${TOOL('kane_tests_list')} tools and the sessions under ~/.testmuai/kaneai/sessions/ as needed.)`,
        })
        return { text: 'Asking Claude…' }
    }
  })

  const args = (e: unknown) => e as Json
  const optStr = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const optBool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)

  function normalizeVariables(v: unknown): Record<string, unknown> | undefined {
    if (!v || typeof v !== 'object') return undefined
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Json)) {
      out[k] = val !== null && typeof val === 'object' ? val : { value: val }
    }
    return out
  }

  on('tool.call', { tool: 'mcp__kane-qe__kane_run' }, async ($, e, next) => {
    const a = args(e)
    const o: RunOptions = {
      objective: optStr(a.objective) ?? '',
      url: optStr(a.url),
      headless: optBool(a.headless) ?? true,
      maxSteps: optNum(a.max_steps),
      timeoutSeconds: optNum(a.timeout_seconds) ?? defaultTimeout,
      variables: normalizeVariables(a.variables),
      name: optStr(a.name),
      mode: a.mode === 'action' || a.mode === 'testing' ? a.mode : undefined,
      assertionMode: a.assertion_mode === 'dom' || a.assertion_mode === 'visual' ? a.assertion_mode : undefined,
      finalValidation: optBool(a.final_validation),
      bugDetection: a.bug_detection === 'off' || a.bug_detection === 'stop' || a.bug_detection === 'continue' ? a.bug_detection : undefined,
      codeExport: optBool(a.code_export),
      codeLanguage: a.code_language === 'python' || a.code_language === 'javascript' ? a.code_language : undefined,
      target: a.target === 'emulator' || a.target === 'simulator' || a.target === 'desktop' ? a.target : undefined,
      deviceName: optStr(a.device_name),
      osVersion: optStr(a.os_version),
      app: optStr(a.app),
      variablesFile: optStr(a.variables_file),
    }
    if (!o.objective) return { result: 'objective is required' }
    const run = await execute($, 'run', o.objective, runArgs(o), 'model', next.signal, e.tool_use_id)
    return { result: report(run) }
  })

  on('tool.call', { tool: 'mcp__kane-qe__kane_test_run' }, async ($, e, next) => {
    const a = args(e)
    const o: TestOptions = {
      path: optStr(a.path) ?? '',
      headless: optBool(a.headless) ?? true,
      author: optBool(a.author),
      adaptiveHeal: optBool(a.adaptive_heal),
      timeoutSeconds: optNum(a.timeout_seconds) ?? defaultTimeout,
    }
    if (!o.path) return { result: 'path is required' }
    const run = await execute($, 'testmd', o.path, testArgs(o), 'model', next.signal, e.tool_use_id)
    return { result: report(run) }
  })

  on('tool.call', { tool: 'mcp__kane-qe__kane_suite_run' }, async ($, e, next) => {
    const a = args(e)
    const o: SuiteOptions = {
      paths: Array.isArray(a.paths) ? a.paths.filter((p): p is string => typeof p === 'string') : undefined,
      tags: optStr(a.tags),
      match: optStr(a.match),
      parallel: optNum(a.parallel),
      failFast: optBool(a.fail_fast),
      headless: optBool(a.headless) ?? true,
      dryRun: optBool(a.dry_run),
      remote: optBool(a.remote),
      deviceName: optStr(a.device_name),
      osVersion: optStr(a.os_version),
    }
    const label = `suite ${[o.tags && `tags=${o.tags}`, o.match && `match=${o.match}`, o.paths?.length && `${o.paths.length} paths`].filter(Boolean).join(' ') || '(all)'}${o.remote ? ' · grid' : ''}${o.deviceName ? ` · ${o.deviceName}` : ''}`
    const run = await execute($, 'testrun', label, suiteArgs(o), 'model', next.signal, e.tool_use_id)
    return { result: report(run) }
  })

  on('tool.call', { tool: 'mcp__kane-qe__kane_devices' }, async ($, e) => {
    const a = args(e)
    const target = a.target === 'simulator' ? 'simulator' : 'emulator'
    const isRemote = optBool(a.remote) === true
    await setGrid($, { where: isRemote ? 'grid' : 'local', target })
    await loadDevices($)
    const g = await read($, gridAtom)
    const lines = g.devices.slice(0, 60).map(d => `${d.name}  os ${d.osVersions.join(', ')}`)
    if (!isRemote) {
      await runDoctor($, target)
      const doc = (await read($, gridAtom)).doctor
      if (doc?.checks.length) lines.push('', `kane-cli doctor --target ${target}:`, ...doc.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}${c.fix ? `\n    fix: ${c.fix}` : ''}`))
    } else if (g.plugin !== 'ok') {
      await checkGridPlugin($)
      if ((await read($, gridAtom)).plugin === 'missing') lines.push('', 'The remote-execution plugin is not installed: kane-cli plugin install remote-execution (also needs a HyperExecute plan).')
    }
    return { result: [`${isRemote ? 'Grid catalog' : 'This machine'} · ${target} · ${g.devices.length} device(s)${g.error ? ` · ${g.error}` : ''}`, ...lines].join('\n') }
  })

  on('tool.call', { tool: 'mcp__kane-qe__kane_assure' }, async ($, e) => {
    const a = args(e)
    const action = optStr(a.action) ?? 'status'
    const summarize = async (job: AssureJob | undefined) => {
      if (!job) return 'Another assurance command is still running; try again when it finishes.'
      await refreshAssurance($)
      const st = await read($, assuranceAtom)
      return [
        `${job.label}: ${job.status}${job.credits ? ` · ${job.credits} credits` : ''}`,
        ...job.errors.map(x => `error: ${x}`),
        ...job.messages,
        job.committed.length ? `committed: ${job.committed.join(', ')}` : '',
        ...job.questions.map(q => `QUESTION ${q.id} (${q.risk ?? '?'} risk): ${q.text}\n  ${q.options.map((o, i) => `${i + 1}) ${o.label}${q.recommended === i ? ' [recommended]' : ''}`).join('  ')}`),
        job.resume ? `resume: ${job.resume}` : '',
        job.next.length ? `next: ${job.next.join(' | ')}` : '',
        `store: ${st.sources} sources · ${st.useCases} use cases (${st.trusted} trusted, ${st.derived} to review) · ${st.stale} stale${st.designPct !== undefined ? ` · design ${Math.round(st.designPct)}%` : ''}`,
      ]
        .filter(Boolean)
        .join('\n')
    }
    switch (action) {
      case 'ingest': {
        const source = optStr(a.source)
        if (!source) return { result: 'source is required' }
        return { result: await summarize(await runAssure($, `Ingest & extract ${clip(source, 40)}`, ['context', 'ingest', source, '--mode', 'agent'])) }
      }
      case 'extract':
        return { result: await summarize(await runAssure($, 'Extract use cases', ['context', 'extract', '--mode', 'agent'])) }
      case 'design': {
        const uc = optStr(a.use_case)
        if (!uc) return { result: 'use_case is required' }
        const argv = ['design', 'tests', '--use-case', uc, '--mode', 'agent']
        if (optNum(a.max)) argv.push('--max', String(optNum(a.max)))
        if (optBool(a.allow_unreviewed)) argv.push('--allow-unreviewed')
        return { result: await summarize(await runAssure($, `Design tests for ${uc}`, argv)) }
      }
      case 'answer': {
        const st = await read($, assuranceAtom)
        const given = optStr(a.session)
        const resume = given?.startsWith('kane-cli') ? given : (st.sessions.find(x => x.sid === given)?.resume ?? (st.job?.status === 'paused' ? st.job.resume : undefined) ?? st.sessions[0]?.resume)
        if (!resume) return { result: 'No paused session to answer.' }
        const answers = a.answers && typeof a.answers === 'object' ? Object.entries(a.answers as Json) : []
        const words = splitWords(resume)
        const argv = [...words.slice(words[0] === 'kane-cli' ? 1 : 0), ...answers.flatMap(([k, v]) => ['--answer', `${k}=${String(v)}`])]
        return { result: await summarize(await runAssure($, 'Answer kane\'s questions', argv.includes('--mode') ? argv : [...argv, '--mode', 'agent'])) }
      }
      case 'approve': {
        const ids = Array.isArray(a.use_cases) ? a.use_cases.filter((x): x is string => typeof x === 'string') : optStr(a.use_case) ? [optStr(a.use_case)!] : []
        if (!ids.length) return { result: 'use_cases is required' }
        const r = await kane($, ['context', 'review', '--approve', ...ids, '--mode', 'agent'], 60_000)
        await refreshAssurance($)
        return { result: r.exitCode === 0 ? `Approved ${ids.join(', ')}.` : `context review exit ${r.exitCode}: ${kaneError(stripAnsi(`${r.stderr}\n${r.stdout}`)) ?? ''}` }
      }
      case 'evolve':
        return { result: await summarize(await runAssure($, 'Evolve stale designs', ['maintain', 'evolve', '--from-stale', '--mode', 'agent'])) }
      case 'sync':
        return { result: await summarize(await runAssure($, 'Sync with the team', ['context', 'sync', '--mode', 'agent'])) }
      default: {
        await refreshAssurance($)
        const st = await read($, assuranceAtom)
        if (!st.hasStore) return { result: `No requirement store in ${projectDir || 'this folder'} yet. Start with action:"ingest" and a requirement file (PRD, user story) or a Jira / Confluence / Linear / web URL.` }
        return {
          result: [
            `store: ${st.sources} sources · ${st.useCases} use cases (${st.trusted} trusted, ${st.derived} to review) · ${st.stale} stale${st.designPct !== undefined ? ` · design ${Math.round(st.designPct)}%` : ''}`,
            ...st.nodes.map(n => `${n.label} ${n.id} "${n.title}" trust=${n.trust} ${n.fresh}`),
            ...st.sessions.map(x => `paused ${x.verb} ${x.sid}: ${x.pending} question(s) · resume: ${x.resume}${(x.questions ?? []).map(q => `\n  ${q.id}: ${q.text} — ${q.options.map((o, i) => `${i + 1}) ${o.label}`).join('  ')}`).join('')}`),
            ...st.usecases.map(u => `${u.id} ${u.title} · ${u.pct !== undefined ? `${Math.round(u.pct)}% designed` : 'not designed'}${u.pending.map(p => `\n  gap: ${p.why}${p.cmd ? ` → ${p.cmd}` : ''}`).join('')}`),
          ].join('\n'),
        }
      }
    }
  })

  on('tool.call', { tool: 'mcp__kane-qe__kane_tests_list' }, async $ => {
    await refreshTests($)
    const t = await read($, testsAtom)
    if (t.error && t.items.length === 0) return { result: `kane-cli testmd list failed: ${t.error}` }
    if (t.items.length === 0) return { result: 'No *_test.md tests found (create some with kane_run name:"…" or kane_generate save:true).' }
    return {
      result: t.items
        .map(i => `${i.path}  name=${i.name}${i.tags.length ? `  tags=${i.tags.join(',')}` : ''}  ${i.hasMeta ? 'authored' : 'not-authored'}${i.synced ? ' synced' : ''}`)
        .join('\n'),
    }
  })

  on('tool.call', { tool: 'mcp__kane-qe__kane_status' }, async $ => {
    await refreshEnv($)
    const env = await read($, envAtom)
    if (!env.isInstalled) return { result: env.error ?? 'kane-cli is not installed. Install: npm install -g @testmuai/kane-cli' }
    return {
      result: [
        `kane-cli ${env.version ?? '?'} · auth: ${env.auth}`,
        env.whoami ? `whoami: ${env.whoami}` : '',
        env.balance ? `balance: ${env.balance}` : '',
        `config: ${JSON.stringify(env.config)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  })

  on('tool.call', { tool: 'mcp__kane-qe__kane_insights' }, async ($, e) => {
    const asked = optStr(args(e).session_dir)
    const history = await read($, historyAtom)
    const run = await read($, runAtom)
    const dir = asked ?? (run?.status !== 'running' ? run?.sessionDir : undefined) ?? history.find(h => h.sessionDir)?.sessionDir
    if (!dir) return { result: 'No kane run with a session folder yet.' }
    const label = history.find(h => h.sessionDir === dir)?.label ?? dir
    const ins = await loadInsights($, dir, label, true)
    return { result: ins ? insightsReport(ins) : `Could not read the evidence in ${dir}.` }
  })

  on('ui.message', async ($, e) => {
    const data = (e.data ?? {}) as { type?: string; n?: number; id?: string; chart?: string; key?: string }
    if (data.type === 'key' && data.key) await paneHotkey($, data.key)
    if (data.type === 'step' && typeof data.n === 'number') await selectStep($, data.n)
    if (data.type === 'pick' && data.id) {
      const entry = (await read($, historyAtom)).find(h => h.id === data.id)
      if (entry) {
        await focusRun($, entry.sessionDir, entry.label)
        // The clicked chart left with its tab: keep the keys in the pane.
        await openPane($).catch(() => undefined)
      }
    }
    return {}
  })

  on('tool.call', { tool: 'mcp__kane-qe__kane_generate' }, async ($, e) => {
    const a = args(e)
    const objective = optStr(a.objective)
    const requestId = optStr(a.request_id)
    const isSave = optBool(a.save) === true
    let argv: string[]
    if (isSave) {
      if (!requestId) return { result: 'save:true needs request_id from a previous kane_generate call' }
      argv = ['generate', '--save', '--req', requestId, '--agent']
    } else {
      if (!objective) return { result: 'objective is required' }
      argv = ['generate', objective, '--agent']
      const sl = optNum(a.scenario_limit)
      const pl = optNum(a.per_scenario_limit)
      if (sl) argv.push('--scenario-limit', String(sl))
      if (pl) argv.push('--per-scenario-limit', String(pl))
    }
    $.ui.status(isSave ? 'kane ◐ saving generated tests' : `kane ◐ generating cases · ${clip(objective ?? '', 30)}`)
    let r
    try {
      r = await kane($, argv, 600_000)
    } catch (err) {
      $.ui.status(undefined)
      return { result: `kane-cli generate could not run: ${String(err instanceof Error ? err.message : err)}` }
    }
    $.ui.status(undefined)
    const keep = new Set(['generate_snapshot', 'generate_clarification', 'generate_save_result', 'generate_done', 'error'])
    const events = r.stdout
      .split('\n')
      .map(l => parseLine(l.trim()))
      .filter((x): x is Json => !!x && keep.has(String(x.type)))
    if (isSave) void refreshTests($)
    return {
      result: [
        `kane-cli generate exit ${r.exitCode}`,
        ...events.map(ev => JSON.stringify(ev)),
        events.length === 0 ? clip(stripAnsi(r.stderr || r.stdout), 1500) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  })

  // ── what the model is told ───────────────────────────────────────────

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      ...composed,
      sections: [
        ...composed.sections,
        {
          id: 'kane-qe:guide',
          scope: 'session' as const,
          text:
            'KaneAI QE tools are available (kane-qe mod). For browser testing prefer the mcp__kane-qe__kane_* tools over raw Bash/Playwright: ' +
            'they run kane-cli v16 with --agent, stream live into the user\'s Kane QE pane, and return a verdict. ' +
            'Split long journeys (>15 steps) into several kane_run calls. On failure, read the run dir (run_summary.json, step_NNN.json, screenshots/step_NNN.png) before concluding; ' +
            'classify as product bug vs test problem vs flake. Never put real secrets in objectives: pass them as variables with secret:true and reference {{name}}. ' +
            'Suites can run on the HyperExecute cloud grid (kane_suite_run remote:true, dry_run first) and on Android/iOS devices (kane_devices, then device_name / os_version). ' +
            'For requirement-driven testing use kane_assure: ingest a PRD/ticket, extract use cases, approve them, design tests, then read coverage; it pauses with questions the user should answer.',
        },
      ],
    }
  })

  // ── the band above the prompt while a run is live ────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [live, assurance] = await Promise.all([read($, liveAtom), read($, assuranceAtom)])
    const runs = Object.values(live).sort((a, b) => b.startedAt - a.startedAt)
    const job = assurance.job?.status === 'running' ? assurance.job : undefined
    if (e.props.hasSurvey || (!runs.length && !job)) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 80
    const top = runs[0]
    const doing = top
      ? `${top.label} — ${stepLine(top) ?? top.progress ?? 'starting browser…'}`
      : `${job!.label}${job!.activity.length ? ` — ${job!.activity[job!.activity.length - 1]}` : ''}`
    return (
      <Box flexDirection="row" gap={1}>
        <Text color="cyan">{runs.length > 1 ? `◐ Kane ×${runs.length}` : '◐ Kane'}</Text>
        <Text>{clip(doing, Math.max(10, width - (runs.length > 1 ? 36 : 26)))}</Text>
        <Button key="kane-band-open" label="Open" onPress={() => void openPane($, job && !top ? 'assure' : 'run')} />
        {top && <Button key="kane-band-stop" label={runs.length > 1 ? 'Stop all' : 'Stop'} onPress={() => runs.forEach(r => active.get(r.id)?.stop())} />}
      </Box>
    )
  })

  // ── the model's kane calls as live cards in the transcript ───────────

  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__kane-qe__kane_run' } }, ($, e, next) => runCard($, e, next))
  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__kane-qe__kane_test_run' } }, ($, e, next) => runCard($, e, next))
  on('ui.render', { component: 'ToolUse', props: { tool: 'mcp__kane-qe__kane_suite_run' } }, ($, e, next) => runCard($, e, next))
  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__kane-qe__kane_run' } }, ($, e, next) => compactResult($, e, next))
  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__kane-qe__kane_test_run' } }, ($, e, next) => compactResult($, e, next))
  on('ui.render', { component: 'ToolResult', props: { tool: 'mcp__kane-qe__kane_suite_run' } }, ($, e, next) => compactResult($, e, next))

  // ── the cockpit pane ─────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    void ensureBooted($).catch(() => undefined)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link } = ui
    const Input = 'Input' in ui ? ui.Input : undefined
    const Client = 'Client' in ui ? ui.Client : undefined
    const Image = 'Image' in ui ? ui.Image : undefined
    const Raster = 'Raster' in ui ? ui.Raster : undefined
    const width = Math.max(30, e.props.bodyColumns ?? e.viewport?.columns ?? 80)
    lastPaneColumns = width
    // The pane's own visible rows, not the terminal's: the prompt and footer take the rest.
    const height = Math.max(12, e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30)

    const [tab, env, run, history, tests, form, flashText, coach, insights, focus, historyView, shot, coverage, assurance, grid, viewer, testNotes, live] = await Promise.all([
      read($, tabAtom),
      read($, envAtom),
      read($, runAtom),
      read($, historyAtom),
      read($, testsAtom),
      read($, formAtom),
      read($, flashAtom),
      read($, coachAtom),
      read($, insightsAtom),
      read($, focusAtom),
      read($, historyViewAtom),
      read($, shotAtom),
      read($, coverageAtom),
      read($, assuranceAtom),
      read($, gridAtom),
      read($, viewerAtom),
      read($, testNotesAtom),
      read($, liveAtom),
    ])
    // Runs in flight, newest first: the Run tab shows one and lists the rest, Insights says they are coming.
    const liveRuns = Object.values(live).sort((a, b) => b.startedAt - a.startedAt)
    const liveLine = (r: KaneRun) => {
      const last = r.steps[r.steps.length - 1]
      return `◐ ${clip(r.label, 30)} · ${last ? `step ${last.n}` : 'starting'}${r.source === 'external' ? ` · ${r.hostAgent ?? 'terminal'}` : r.source === 'model' ? ' · Claude' : ''}`
    }
    const liveStrip = (keyPrefix: string) =>
      liveRuns.length > (run && live[run.id] ? 1 : 0) ? (
        <Box key={`${keyPrefix}-live`} flexDirection="column">
          <Text color="cyan">{`${liveRuns.length} run${liveRuns.length === 1 ? '' : 's'} in progress`}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {liveRuns.slice(0, 6).map(r => (
              <Button
                key={`${keyPrefix}-live-${r.id}`}
                label={`${run?.id === r.id ? '▸ ' : ''}${liveLine(r)}`}
                variant={run?.id === r.id ? 'primary' : 'secondary'}
                onPress={() =>
                  void (async () => {
                    await update($, runAtom, () => r)
                    await update($, tabAtom, () => 'run')
                  })()
                }
              />
            ))}
          </Box>
        </Box>
      ) : null

    const authText =
      !env.isInstalled ? (env.isChecking ? 'checking…' : 'kane-cli not found')
      : env.auth === 'ok' ? `● ${env.config.profile ?? 'signed in'}${env.config.env ? `/${env.config.env}` : ''}`
      : env.auth === 'unreachable' ? '● server unreachable'
      : env.auth === 'none' ? '○ not logged in'
      : '…'
    const authColor = env.auth === 'ok' ? 'green' : env.isInstalled ? 'yellow' : 'red'
    const project = env.config.project_name ? `${env.config.project_name}${env.config.folder_name ? ` / ${env.config.folder_name}` : ''}` : undefined

    const header = (
      <Box flexDirection="column" key="hdr">
        <Box flexDirection="row" gap={1}>
          <Text bold color="magenta">KaneAI</Text>
          <Text dimColor>{env.version ? `v${env.version}` : ''}</Text>
          <Text color={authColor}>{authText}</Text>
        </Box>
        {project && <Text dimColor>{clip(`TMS: ${project}`, width)}</Text>}
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {TABS.map(t => (
            <Button
              key={`tab-${t.id}`}
              label={tab === t.id ? `▸ ${t.label}` : t.label}
              hotkey={t.hotkey}
              variant={tab === t.id ? 'primary' : 'secondary'}
              onPress={() => {
                if (t.id === 'assure') void refreshAssurance($)
                void (t.id === 'insights' ? openInsights($) : update($, tabAtom, () => t.id))
              }}
            />
          ))}
        </Box>
        {flashText ? <Text color="yellow">{clip(flashText, width)}</Text> : null}
      </Box>
    )

    const hint = e.props.isFocused
      ? width >= 100
        ? 'Tab/↑↓ move · Enter press · 1-5 a tabs · 6-0 views · r run · s stop · t triage · Esc back to prompt'
        : 'Tab move · Enter press · 1-5 a tabs · 6-0 views · Esc prompt'
      : `Not focused — ${e.viewport?.isFullscreen ? 'click here or ' : ''}press ctrl+x then tab (or run /kane) to use the buttons`

    // ── Run tab
    const runTab = () => {
      const isRunning = run?.status === 'running'
      // Rows everything but the steps takes, measured at this width, so the steps get what is left.
      const inner = width - 4
      const isNarrow = width < 70
      const checklistText = `Getting started  ✓ installed  ✓ logged in  ✓ project  ✓ first run  ○ saved test`
      const fixed =
        5 + // header, tabs, gaps
        rowsFor(hint, width) +
        rowsFor(checklistText, width) +
        (run ? rowsFor(`✗ FAILED ${run.kind} · 000.0s · 00.00 credits · via ${run.hostAgent ?? ''} in ${basename(run.cwd)}`, inner) : 0) +
        (isNarrow ? 4 : 2) + // objective and URL fields
        1 + // buttons
        2 + // the result box's border
        (run ? rowsFor(run.label, inner) + 1 : 0) +
        (run?.oneLiner ? rowsFor(run.oneLiner, inner) : 0) +
        (run?.finalState ? Object.values(run.finalState).slice(0, 4).reduce<number>((n, v) => n + rowsFor(String(v), inner), 0) : 0) +
        (run?.testUrl || run?.sessionDir ? 2 : 0) +
        (run ? run.errors.length + run.warnings.length : 0)
      const shownSteps = run ? fitSteps(run.steps, inner - 5, Math.max(3, height - fixed)) : []
      const stepColor = (s: string) => COLOR[s] ?? (s === 'running' ? 'cyan' : undefined)
      if (!env.isInstalled && !run) {
        return (
          <Box flexDirection="column" key="run">
            <Text bold>{env.isChecking ? 'Looking for kane-cli…' : 'Step 1 of 3 — install kane-cli'}</Text>
            {!env.isChecking && <Text dimColor>{clip(env.error ?? 'kane-cli was not found on PATH.', width * 2)}</Text>}
            {!env.isChecking && (
              <Box flexDirection="row" gap={1}>
                <Button key="gate-install" label="Install kane-cli" variant="primary" autoFocus onPress={() => void $.prompt.fill({ text: '! npm install -g @testmuai/kane-cli' })} />
                <Button key="gate-recheck" label="Re-check" onPress={() => void refreshEnv($)} />
              </Box>
            )}
          </Box>
        )
      }
      if (env.auth === 'none' && !run) {
        return (
          <Box flexDirection="column" key="run">
            <Text bold>Step 2 of 3 — log in to LambdaTest</Text>
            <Text dimColor>{clip('Sign-in opens your browser. It has to run from your prompt (Claude cannot finish OAuth for you). CI uses --username / --access-key instead.', width * 2)}</Text>
            <Box flexDirection="row" gap={1}>
              <Button key="gate-login" label="Log in" variant="primary" autoFocus onPress={() => void $.prompt.fill({ text: '! kane-cli login --oauth' })} />
              <Button key="gate-recheck" label="I'm logged in — re-check" onPress={() => void refreshEnv($)} />
            </Box>
          </Box>
        )
      }
      const checklist = [
        { label: 'installed', isDone: env.isInstalled },
        { label: 'logged in', isDone: env.auth === 'ok' },
        { label: 'project', isDone: Boolean(env.config.project_name) },
        { label: 'first run', isDone: history.length > 0 },
        { label: 'saved test', isDone: tests.items.length > 0 },
      ]
      const isOnboarding = checklist.some(c => !c.isDone)
      return (
        <Box flexDirection="column" key="run">
          {liveStrip('run')}
          {isOnboarding && (
            <Text wrap="wrap">{`Getting started  ${checklist.map(c => `${c.isDone ? '✓' : '○'} ${c.label}`).join('  ')}`}</Text>
          )}
          {Input ? (
            <Box flexDirection="column">
              {width < 70 && <Text dimColor>Objective</Text>}
              <Input
                key="objective"
                label={width < 70 ? undefined : 'Objective'}
                placeholder="e.g. Log in as {{user}} and assert the dashboard greets them"
                value={form.objective}
                submitLabel="Run"
                onInput={v => {
                  void update($, formAtom, f => ({ ...f, objective: v }))
                  if (coach) void update($, coachAtom, () => null)
                }}
                onSubmit={v => void read($, formAtom).then(f => startObjective($, v, f.url, false, 'pane'))}
              />
              {width < 70 && <Text dimColor>URL</Text>}
              <Input
                key="url"
                label={width < 70 ? undefined : 'URL'}
                placeholder={env.config.default_url ?? 'https://… (optional)'}
                value={form.url}
                onInput={v => void update($, formAtom, f => ({ ...f, url: v }))}
                onSubmit={v => void update($, formAtom, f => ({ ...f, url: v }))}
              />
            </Box>
          ) : (
            <Text dimColor>Use /kane [url] &lt;objective&gt; on this surface.</Text>
          )}
          {coach && (
            <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
              {coach.hasNoCheck && (
                <Text color="yellow">{clip("⚠ No check in this objective — kane will act but won't verify anything.", width - 4)}</Text>
              )}
              {coach.hasNoCheck && (
                <Text dimColor>{clip('Add one, e.g. "…and assert at least 3 results are shown", or "store the price as \'price\'".', (width - 4) * 2)}</Text>
              )}
              {coach.variables.length > 0 && (
                <Text color="yellow">
                  {clip(`⚠ Uses ${coach.variables.map(v => `{{${v}}}`).join(', ')} — kane fills these only from .testmuai/variables/*.json.`, (width - 4) * 2)}
                </Text>
              )}
              <Box flexDirection="row" gap={1}>
                <Button key="coach-claude" label="Let Claude add checks" variant="primary" autoFocus onPress={() => void addChecksWithClaude($, coach)} />
                <Button key="coach-run" label="Run anyway" onPress={() => void startObjective($, coach.objective, coach.url, coach.headless, 'pane', false)} />
                <Button key="coach-dismiss" label="Edit" onPress={() => void update($, coachAtom, () => null)} />
              </Box>
            </Box>
          )}
          {!coach && (<Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button
              key="run-headed"
              label="Run"
              hotkey="r"
              variant="primary"
              onPress={() => void read($, formAtom).then(f => startObjective($, f.objective, f.url, false, 'pane'))}
            />
            <Button
              key="run-headless"
              label="Run headless"
              hotkey="h"
              onPress={() => void read($, formAtom).then(f => startObjective($, f.objective, f.url, true, 'pane'))}
            />
            {isRunning && <Button key="run-stop" label="Stop" hotkey="s" onPress={() => active.get(run.id)?.stop()} />}
            {!isRunning && run && (run.status === 'failed' || run.status === 'error') && (
              <Button key="run-triage" label="Triage with Claude" hotkey="t" onPress={() => void triage($, run.sessionDir, run.label, run.oneLiner)} />
            )}
            {!isRunning && run?.status === 'passed' && run.sessionDir && (
              <Button
                key="run-code"
                label="Playwright code"
                hotkey="p"
                onPress={() =>
                  void $.prompt.submit({
                    text: `Read the Playwright test kane-cli exported for this passing run (${run.sessionDir}/code-export/test.py, plus requirements.txt and .env.example). Explain what it covers, then propose how to add it to this repo's test suite (location, naming, fixtures, env vars, CI), adapting style to existing tests if any. Objective was: "${run.label}"`,
                  })
                }
              />
            )}
            {!isRunning && run?.sessionDir && (
              <Button key="run-insights" label="Insights" hotkey="i" variant={run.status === 'passed' ? 'secondary' : 'primary'} onPress={() => void focusRun($, run.sessionDir, run.label)} />
            )}
            {!isRunning && run?.args && run.status !== 'error' && (
              <Button key="run-ci" label="Copy CI command" hotkey="c" onPress={pressed => void copyCi($, run.args, pressed.surface)} />
            )}
            {!isRunning && run?.kind === 'run' && run.status === 'passed' && (
              <Button
                key="run-save"
                label="Ask Claude to save as test"
                onPress={() =>
                  void $.prompt.submit({
                    text: `Re-run this passing KaneAI objective with ${TOOL('kane_run')} and a descriptive name (snake_case) so it is saved as a reusable *_test.md: "${run.label}"`,
                  })
                }
              />
            )}
          </Box>)}
          {coach ? null : run ? (
            <Box flexDirection="column" borderStyle="round" borderColor={COLOR[run.status] ?? 'gray'} paddingX={1}>
              <Box flexDirection="row" gap={1}>
                <Box flexShrink={0}>
                  <Text bold color={COLOR[run.status]}>{`${ICON[run.status] ?? ''} ${run.status.toUpperCase()}`}</Text>
                </Box>
                <Text dimColor>
                  {[run.kind, run.durationS !== undefined ? `${run.durationS}s` : undefined, run.credits !== undefined ? `${run.credits} credits` : undefined, run.source === 'external' ? `via ${run.hostAgent ?? 'terminal'} in ${basename(run.cwd)}` : run.source]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </Box>
              <Text bold wrap="wrap">{run.label}</Text>
              {run.progress && <Text dimColor>{run.progress}</Text>}
              {run.device && <Text dimColor wrap="wrap">{`Grid device: ${run.device}`}</Text>}
              {run.remoteJob?.url && <Link key="run-job" href={run.remoteJob.url} label="HyperExecute job ↗" />}
              {run.steps.length === 0 && isRunning && <Text dimColor>Launching browser…</Text>}
              {run.steps.length > shownSteps.length && <Text dimColor>{`… ${run.steps.length - shownSteps.length} earlier step${run.steps.length - shownSteps.length === 1 ? '' : 's'}`}</Text>}
              {shownSteps.map(s => (
                <Box key={`step-${s.n}`} flexDirection="row">
                  <Text color={stepColor(s.status)} dimColor={s.status === 'pending'}>{`${ICON[s.status] ?? '·'} ${String(s.n).padStart(2)} `}</Text>
                  <Box flexShrink={1} flexDirection="column">
                    <Text color={stepColor(s.status)} dimColor={s.status === 'pending'} wrap="wrap">{tidyStep(s.text)}</Text>
                    {s.detail && <Text dimColor wrap="wrap">{`↳ ${s.detail}`}</Text>}
                  </Box>
                </Box>
              ))}
              {run.oneLiner && <Text color={COLOR[run.status]} wrap="wrap">{run.oneLiner}</Text>}
              {run.finalState &&
                Object.entries(run.finalState)
                  .slice(0, 4)
                  .map(([k, v]) => {
                    const isUrl = typeof v === 'string' && /^https?:\/\//.test(v)
                    const shown = typeof v === 'string' ? (isUrl ? shortUrl(v) : v) : JSON.stringify(v)
                    return (
                      <Box key={`fs-${k}`} paddingLeft={2}>
                        <Text wrap={isUrl ? 'truncate-middle' : 'wrap'}>{`${k} = ${shown}`}</Text>
                      </Box>
                    )
                  })}
              {run.errors.map((m, i) => <Text key={`err-${i}`} color="red" wrap="wrap">{m}</Text>)}
              {run.status === 'error' && run.errors.length === 0 && run.stderrTail.slice(-3).map((m, i) => <Text key={`se-${i}`} color="red" dimColor wrap="wrap">{m}</Text>)}
              {run.warnings.map((m, i) => <Text key={`warn-${i}`} color="yellow" wrap="wrap">{`⚠ ${m}`}</Text>)}
              {!isRunning && (run.testUrl || run.sessionDir) && (
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  {run.testUrl && <Link key="run-report" href={run.testUrl} label="Test Manager report ↗" />}
                  {run.testUrl && <Button key="run-copy-link" label="Copy link" onPress={pressed => void $.ui.copy({ text: run.testUrl ?? '', surface: pressed.surface }).then(() => flash($, 'Copied the Test Manager link.'))} />}
                  {run.sessionDir && <Button key="run-copy-dir" label="Copy path" onPress={pressed => void $.ui.copy({ text: run.sessionDir ?? '', surface: pressed.surface }).then(() => flash($, `Copied ${run.sessionDir}`))} />}
                </Box>
              )}
            </Box>
          ) : (
            <Box flexDirection="column" paddingTop={1}>
              <Text dimColor>{clip('No run yet. Try: "assert the cart badge shows 2" · "assert no console errors" · "store the order number as \'order_id\'"', width * 2)}</Text>
            </Box>
          )}
        </Box>
      )
    }

    // ── Tests tab
    const testsTab = () => {
      const opts = gridOptions(grid)
      const isGrid = grid.where === 'grid'
      const isMobile = grid.target !== 'web'
      const where = `${isGrid ? 'the grid' : 'this machine'}${isMobile ? ` · ${grid.device ?? 'any device'}${grid.osVersion ? ` ${grid.osVersion}` : ''}` : ''}`
      const versions = grid.devices.find(d => d.name === grid.device)?.osVersions ?? []
      const words = (grid.filter ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const shownDevices = grid.devices.filter(d => words.every(w => `${d.name} ${d.osVersions.join(' ')}`.toLowerCase().includes(w)))
      const deviceRows = isMobile ? Math.min(6, shownDevices.length) : 0
      const room = Math.max(3, height - 16 - (isMobile ? deviceRows + 4 : 0) - (isGrid && grid.plugin === 'missing' ? 2 : 0))
      const runOne = (path: string) =>
        isGrid || opts.deviceName || opts.osVersion
          ? launch($, 'testrun', `${basename(path)} · ${where}`, suiteArgs({ paths: [path], headless: true, ...opts }), 'pane')
          : launch($, 'testmd', path, testArgs({ path, timeoutSeconds: defaultTimeout }), 'pane')
      return (
        <Box flexDirection="column" key="tests">
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text dimColor>Run on</Text>
            <Button key="g-local" label="This machine" variant={!isGrid ? 'primary' : 'secondary'} onPress={() => void setGrid($, { where: 'local' })} />
            <Button key="g-grid" label="Cloud grid" variant={isGrid ? 'primary' : 'secondary'} onPress={() => void setGrid($, { where: 'grid' })} />
            <Text dimColor>·</Text>
            {(['web', 'emulator', 'simulator'] as const).map(t => (
              <Button key={`g-t-${t}`} label={t === 'web' ? 'Web' : t === 'emulator' ? 'Android' : 'iOS'} variant={grid.target === t ? 'primary' : 'secondary'} onPress={() => void setGrid($, { target: t })} />
            ))}
          </Box>
          {isGrid && grid.plugin === 'checking' && <Text dimColor>Checking the grid plugin…</Text>}
          {isGrid && grid.plugin === 'missing' && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text color="yellow" wrap="wrap">The grid needs kane-cli's remote-execution plugin (and a HyperExecute plan).</Text>
              <Button key="g-install" label="Install grid plugin" variant="primary" onPress={() => void installGridPlugin($)} />
            </Box>
          )}
          {isMobile && (
            <Box flexDirection="column">
              {grid.isLoading && <Text dimColor>{`Loading ${isGrid ? 'the grid catalog' : 'devices on this machine'}…`}</Text>}
              {grid.error && <Text color="yellow" wrap="wrap">{grid.error}</Text>}
              {!isGrid && grid.doctor?.target === grid.target && grid.doctor.checks.some(c => !c.ok) && (
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  <Text color="yellow" wrap="wrap">{`${grid.doctor.checks.filter(c => !c.ok).length} mobile tooling check(s) failing on this Mac.`}</Text>
                  <Button key="g-doc" label="See Setup" onPress={() => void update($, tabAtom, () => 'setup')} />
                  <Button key="g-use-grid" label="Use the grid instead" onPress={() => void setGrid($, { where: 'grid' })} />
                </Box>
              )}
              {Input && grid.devices.length > 6 && (
                <Input
                  key="g-filter"
                  label={width < 70 ? undefined : 'Device'}
                  placeholder={grid.target === 'simulator' ? 'iphone 15, 17.5 …' : 'pixel, 14 …'}
                  value={grid.filter ?? ''}
                  onInput={v => void update($, gridAtom, g => ({ ...g, filter: v }))}
                  onSubmit={v => void update($, gridAtom, g => ({ ...g, filter: v }))}
                />
              )}
              {shownDevices.slice(0, deviceRows).map((d, i) => (
                <Box key={`dev-${i}`} flexDirection="row" gap={1}>
                  <Button key={`dev-pick-${i}`} label={`${grid.device === d.name ? '▸ ' : ''}${clip(d.name, Math.max(12, Math.floor(width * 0.45)))}`} plain onPress={() => void setGrid($, { device: d.name, osVersion: d.osVersions[d.osVersions.length - 1] })} />
                  <Text dimColor>{clip(d.osVersions.join(' · '), Math.max(6, Math.floor(width * 0.4)))}</Text>
                </Box>
              ))}
              {shownDevices.length > deviceRows && <Text dimColor>{`… ${shownDevices.length - deviceRows} more: type in Device to narrow`}</Text>}
              {grid.devices.length > 0 && shownDevices.length === 0 && <Text dimColor>{`No device matches "${grid.filter}".`}</Text>}
              {grid.device && versions.length > 1 && (
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  <Text dimColor>OS</Text>
                  {versions.map(v => (
                    <Button key={`os-${v}`} label={v} variant={grid.osVersion === v ? 'primary' : 'secondary'} onPress={() => void setGrid($, { osVersion: v })} />
                  ))}
                </Box>
              )}
            </Box>
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="tests-refresh" label={tests.isLoading ? 'Loading…' : 'Refresh'} hotkey="f" onPress={() => void refreshTests($)} />
            <Button key="tests-all" label={isGrid ? 'Run all on grid' : 'Run all'} onPress={() => launch($, 'testrun', `suite (all tests) · ${where}`, suiteArgs({ headless: true, ...opts }), 'pane')} />
            <Button key="tests-dry" label={isGrid ? 'Dry run (grid preflight)' : 'Dry run'} onPress={() => launch($, 'testrun', `suite dry-run · ${where}`, suiteArgs({ dryRun: true, ...opts }), 'pane')} />
          </Box>
          {Input && (
            <Input
              key="tags"
              label="Run by tags"
              placeholder="smoke,checkout"
              value={form.tags}
              submitLabel="Run suite"
              onInput={v => void update($, formAtom, f => ({ ...f, tags: v }))}
              onSubmit={v => {
                void update($, formAtom, f => ({ ...f, tags: v }))
                if (v.trim()) launch($, 'testrun', `suite tags=${v.trim()} · ${where}`, suiteArgs({ tags: v.trim(), headless: true, ...opts }), 'pane')
              }}
            />
          )}
          {tests.error && <Text color="red">{clip(tests.error, width)}</Text>}
          {!tests.isLoading && tests.items.length === 0 && !tests.error && (
            <Text dimColor>No *_test.md tests here. Save a passing run as a test, try /kane cases &lt;feature&gt;, or design them from a requirement in Assurance.</Text>
          )}
          {tests.items.slice(0, room).map((t, i) => (
            <Box key={`t-${i}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Button key={`t-run-${i}`} label="▶" plain onPress={() => runOne(t.path)} />
                <Box flexShrink={1}>
                  <Text color={t.hasMeta ? undefined : 'yellow'} wrap="truncate-end">{t.name}</Text>
                </Box>
                <Text dimColor>{clip(`${t.tags.map(x => `#${x}`).join(' ')}${t.synced ? ' ☁' : ''}`, Math.max(6, Math.floor(width * 0.3)))}</Text>
                <Button key={`t-status-${i}`} label="status" plain onPress={() => void testStatus($, t.path)} />
                {t.hasMeta && <Button key={`t-sync-${i}`} label="sync" plain onPress={() => void testSync($, t.path)} />}
              </Box>
              {testNotes[t.path] && (
                <Box paddingLeft={2}>
                  <Text dimColor wrap="wrap">{testNotes[t.path]}</Text>
                </Box>
              )}
            </Box>
          ))}
          {tests.items.length > room && <Text dimColor>{`… ${tests.items.length - room} more`}</Text>}
        </Box>
      )
    }

    // ── Insights tab: what the evidence pack says about one run
    const KIND_LOOK: Record<string, { label: string; color: string }> = {
      product: { label: 'PRODUCT BUG', color: 'red' },
      unclear: { label: 'NEEDS A LOOK', color: 'yellow' },
      automation: { label: 'CLI / MODEL', color: 'cyan' },
      signals: { label: 'PAGE SIGNALS', color: 'yellow' },
      clean: { label: 'CLEAN', color: 'green' },
      unknown: { label: 'DID NOT RUN', color: 'gray' },
    }
    const insightsTab = () => {
      const dir = focus.sessionDir ?? (run?.status !== 'running' ? run?.sessionDir : undefined) ?? history.find(h => h.sessionDir)?.sessionDir
      const entry = dir ? insights[dir] : undefined
      const newest = history.find(h => h.sessionDir)
      const followBar = (
        <Box key="ins-follow" flexDirection="column">
          {liveRuns.length > 0 && (
            <Text color="cyan" wrap="wrap">{`${liveRuns.map(liveLine).join('   ')} — its evidence shows here when it finishes${focus.isPinned ? '' : ' (Insights follows the newest run)'}.`}</Text>
          )}
          {focus.isPinned && newest?.sessionDir && newest.sessionDir !== dir && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text dimColor wrap="wrap">{`Showing a run you picked. Newer: ${clip(newest.label, 50)} (${newest.status}).`}</Text>
              <Button
                key="ins-latest"
                label="Follow latest"
                onPress={() =>
                  void (async () => {
                    await update($, focusAtom, f => ({ ...f, isPinned: false, sessionDir: newest.sessionDir, step: undefined }))
                    await update($, shotAtom, () => null)
                    await loadInsights($, newest.sessionDir, newest.label)
                  })()
                }
              />
            </Box>
          )}
        </Box>
      )
      if (!dir) return <Box key="ins" flexDirection="column">{followBar}<Text dimColor>No finished run yet. Run a test, then its evidence shows here.</Text></Box>
      if (!entry?.data) {
        return (
          <Box flexDirection="column" key="ins">
            <Text dimColor>{entry?.isLoading ? 'Reading the evidence pack…' : entry?.error ? `Could not read the evidence: ${entry.error}` : 'Evidence not read yet.'}</Text>
            {!entry?.isLoading && <Button key="ins-load" label="Read evidence" variant="primary" onPress={() => void loadInsights($, dir, history.find(h => h.sessionDir === dir)?.label ?? dir, true)} />}
          </Box>
        )
      }
      const ins = entry.data
      if (!ins.pack && ins.steps.length === 0 && ins.status === 'unknown') {
        return (
          <Box flexDirection="column" key="ins">
            <Text bold wrap="wrap">{ins.label}</Text>
            <Text dimColor wrap="wrap">{`This run's session folder is gone or has no evidence (${dir}). kane-cli cleans old sessions; runs on another machine leave nothing here.`}</Text>
            <Button key="ins-history" label="Pick another run in History" onPress={() => void update($, tabAtom, () => 'history')} />
          </Box>
        )
      }
      const look = KIND_LOOK[ins.attribution.kind] ?? KIND_LOOK.unknown!
      const rerun = history.find(h => h.sessionDir === dir)?.rerun ?? []
      const kindOfRun: KaneRunKind = history.find(h => h.sessionDir === dir)?.kind ?? 'run'
      const report = insightsReport(ins)
      const step = focus.step !== undefined ? ins.steps.find(x => x.n === focus.step) : undefined
      const shotHere = shot && step && shot.key === `${ins.sessionDir}#${step.n}` ? shot : undefined
      const imageCols = Math.min(width - 2, 80)
      const timelineSteps = ins.steps.map(x => ({
        n: x.n,
        kind: x.kind,
        status: x.status,
        ms: x.ms,
        modelMs: x.modelMs,
        browserMs: x.browserMs,
        summary: tidyStep(x.summary),
        requests: x.requests,
        failedRequests: x.failedRequests,
        http: x.httpIssues.map(i => `HTTP ${i.status}${i.isSuspicious ? ' (broken URL)' : ''}`).join(', '),
        consoleErrors: x.consoleErrors,
        isCulprit: x.isCulprit,
        isRelevant: x.isRelevant,
        isUnchanged: x.isUnchanged,
      }))
      const otherMs = Math.max(0, ins.durationMs - ins.modelMs - ins.browserMs)
      const byKind = new Map<string, number>()
      for (const x of ins.steps) byKind.set(x.kind, (byKind.get(x.kind) ?? 0) + x.ms)
      const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`
      const issues = [...ins.httpIssues].sort((a, b) => Number(b.isSuspicious) - Number(a.isSuspicious) || Number(b.isFirstParty) - Number(a.isFirstParty) || b.status - a.status)
      return (
        <Box flexDirection="column" key="ins" gap={1}>
          {followBar}
          <Box flexDirection="column">
            <Text bold wrap="wrap">{ins.label}</Text>
            <Text dimColor wrap="wrap">
              {[ins.status, sec(ins.durationMs), ins.credits !== undefined ? `${ins.credits} credits` : undefined, `${ins.steps.length} steps`, ins.environment].filter(Boolean).join(' · ')}
            </Text>
          </Box>
          <Box flexDirection="column" borderStyle="round" borderColor={look.color} paddingX={1}>
            <Text bold color={look.color} wrap="wrap">{`${look.label} · ${ins.attribution.headline}`}</Text>
            {ins.attribution.evidence.slice(0, 6).map((ev, i) => (
              <Text key={`ev-${i}`} wrap="wrap">{`• ${ev}`}</Text>
            ))}
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {(ins.attribution.kind === 'automation' || ins.attribution.kind === 'unclear') && (
                <Button
                  key="ins-fix"
                  label="Fix the test with Claude"
                  variant={ins.attribution.kind === 'automation' ? 'primary' : 'secondary'}
                  onPress={() =>
                    void $.prompt.submit({
                      text: `This kane-cli run failed and the evidence points at the automation (CLI loop or model), not the product. Rewrite the objective so the agent cannot make the same mistake (explicit assertions, the no-results case, fewer ambiguous steps), show it in one line, then run it with ${TOOL('kane_run')}.\n\n${report}`,
                    })
                  }
                />
              )}
              {(ins.attribution.kind === 'product' || ins.attribution.kind === 'signals' || ins.attribution.kind === 'unclear') && (
                <Button
                  key="ins-bug"
                  label="Draft bug report with Claude"
                  variant={ins.attribution.kind === 'unclear' ? 'secondary' : 'primary'}
                  onPress={() =>
                    void $.prompt.submit({
                      text: `Draft a product bug report from this kane-cli run's evidence. Use only what the evidence shows: title, environment, steps to reproduce, expected vs actual, the failing requests (URL, status, step) and console errors, and the evidence pack path. If the evidence does not support a product bug, say so instead.\n\n${report}`,
                    })
                  }
                />
              )}
              {rerun.length > 0 && <Button key="ins-rerun" label="Rerun" onPress={() => launch($, kindOfRun, ins.label, rerun, 'pane')} />}
              {rerun.length > 0 && (
                <Button key="ins-flaky" label="Check flakiness ×3" onPress={() => checkFlaky($, kindOfRun, ins.label, rerun)} />
              )}
              <Button key="ins-refresh" label="Re-read" onPress={() => void loadInsights($, dir, ins.label, true)} />
            </Box>
          </Box>
          {ins.loopSignals.length > 0 && ins.attribution.kind !== 'automation' && ins.attribution.kind !== 'unclear' && (
            <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
              <Text bold color="yellow">Wasted effort · time and credits the run did not need</Text>
              {ins.loopSignals.slice(0, 5).map((sig, i) => (
                <Text key={`we-${i}`} wrap="wrap">{`• ${sig}`}</Text>
              ))}
            </Box>
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {(['timeline', 'signals', 'time'] as const).map(v => (
              <Button
                key={`iv-${v}`}
                hotkey={v === 'timeline' ? '6' : v === 'signals' ? '7' : '8'}
                label={`${focus.view === v ? '▸ ' : ''}${v === 'timeline' ? 'Timeline' : v === 'signals' ? 'Signals' : 'Time split'}`}
                variant={focus.view === v ? 'primary' : 'secondary'}
                onPress={() => void update($, focusAtom, f => ({ ...f, view: v }))}
              />
            ))}
          </Box>
          {focus.view === 'timeline' &&
            (Client ? (
              <Client key="ins-timeline" module="./timeline.client.tsx" props={{ steps: timelineSteps, selected: focus.step ?? null }} />
            ) : (
              <Box flexDirection="column">
                {timelineSteps.map(x => (
                  <Button key={`ts-${x.n}`} label={`${x.status === 'failed' ? '✗' : '✓'} ${x.n} ${x.kind} ${sec(x.ms)}${x.isCulprit ? ' ◆' : ''}`} plain onPress={() => void selectStep($, x.n)} />
                ))}
              </Box>
            ))}
          {focus.view === 'signals' && (
            <Box flexDirection="column">
              {Client ? (
                <Client
                  key="ins-heat"
                  module="./heat.client.tsx"
                  props={{
                    steps: ins.steps.map(x => x.n),
                    selected: focus.step ?? null,
                    rows: [
                      { name: 'requests', values: ins.steps.map(x => x.requests), rgb: [96, 165, 250] },
                      { name: 'failed req', values: ins.steps.map(x => x.failedRequests), rgb: [251, 191, 36] },
                      { name: 'HTTP errors', values: ins.steps.map(x => x.httpIssues.length), rgb: [248, 113, 113] },
                      { name: 'console err', values: ins.steps.map(x => x.consoleErrors), rgb: [248, 113, 113] },
                      { name: 'console warn', values: ins.steps.map(x => x.consoleWarnings), rgb: [251, 191, 36] },
                    ],
                  }}
                />
              ) : (
                <Text dimColor>{`${ins.requests} requests, ${ins.failedRequests} failed, ${ins.consoleErrors} console errors`}</Text>
              )}
              <Text dimColor wrap="wrap">{`${ins.requests} requests · ${ins.failedRequests} failed${ins.p95Ms !== undefined ? ` · p95 ${ins.p95Ms} ms` : ''} · ${ins.consoleErrors} console errors · ${ins.consoleWarnings} warnings`}</Text>
              {issues.slice(0, 6).map((i, k) => (
                <Text key={`hi-${k}`} color={i.isSuspicious || (i.isFirstParty && i.status >= 500) ? 'red' : i.isFirstParty ? 'yellow' : undefined} dimColor={!i.isFirstParty && !i.isSuspicious} wrap="truncate-middle">
                  {`${i.status} step ${i.step} ${i.isFirstParty ? 'site' : '3rd-party'} ${i.url}${i.isSuspicious ? '  ← broken URL' : ''}`}
                </Text>
              ))}
              {issues.length === 0 && <Text color="green">No HTTP errors.</Text>}
            </Box>
          )}
          {focus.view === 'time' && (
            <Box flexDirection="column">
              <Text dimColor>Where the run's time went</Text>
              {Client ? (
                <Client
                  key="ins-time"
                  module="./bars.client.tsx"
                  props={{
                    chart: 'time',
                    hint: 'Model = the LLM deciding and checking. Browser = page actions, screenshots, accessibility tree. Waits & overhead = waits, setup, upload and evidence sealing.',
                    bars: [
                      { id: 'model', label: 'Model (LLM)', value: ins.modelMs, color: '#f59e0b', valueText: sec(ins.modelMs), note: `${Math.round((ins.modelMs / Math.max(1, ins.durationMs)) * 100)}% of the run spent in the model` },
                      { id: 'browser', label: 'Browser', value: ins.browserMs, color: '#60a5fa', valueText: sec(ins.browserMs), note: `${Math.round((ins.browserMs / Math.max(1, ins.durationMs)) * 100)}% in browser work` },
                      { id: 'other', label: 'Waits & overhead', value: otherMs, color: '#6b7280', valueText: sec(otherMs), note: 'Setup, waits, upload and evidence sealing' },
                      ...[...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k, ms]) => ({ id: `kind-${k}`, label: `  ${k} steps`, value: ms, color: '#a78bfa', valueText: sec(ms), note: `${ins.steps.filter(x => x.kind === k).length} ${k} steps` })),
                    ],
                  }}
                />
              ) : (
                <Text>{`model ${sec(ins.modelMs)} · browser ${sec(ins.browserMs)} · other ${sec(otherMs)}`}</Text>
              )}
            </Box>
          )}
          {step && (
            <Box flexDirection="column" borderStyle="round" borderColor={step.isCulprit ? 'red' : 'gray'} paddingX={1}>
              <Text bold wrap="wrap">{`Step ${step.n} · ${step.kind} · ${step.status} · ${sec(step.ms)}${step.isCulprit ? ' · culprit' : ''}`}</Text>
              <Text wrap="wrap">{tidyStep(step.summary)}</Text>
              {step.url && <Text dimColor wrap="truncate-middle">{shortUrl(step.url)}</Text>}
              <Text dimColor wrap="wrap">{`model ${sec(step.modelMs)} · browser ${sec(step.browserMs)} · ${step.requests} requests${step.failedRequests ? `, ${step.failedRequests} failed` : ''} · ${step.consoleErrors} console errors`}</Text>
              {step.isUnchanged && <Text color="yellow">The page did not change from the step before (identical screenshot).</Text>}
              {step.httpIssues.map((i, k) => (
                <Text key={`shi-${k}`} color={i.isSuspicious ? 'red' : 'yellow'} wrap="truncate-middle">{`HTTP ${i.status} ${i.url}`}</Text>
              ))}
              {step.consoleSamples.map((c, k) => (
                <Text key={`sc-${k}`} color="red" dimColor wrap="wrap">{`console: ${c}`}</Text>
              ))}
              {shotHere?.isLoading && <Text dimColor>Extracting the screenshot…</Text>}
              {shotHere?.preview && Raster && (
                <Raster key="shot-preview" columns={shotHere.preview.columns} rows={shotHere.preview.rows} cells={shotHere.preview.cells} />
              )}
              {shotHere?.png && Image && e.surface === 'terminal' && (
                <Image key="shot" source={{ file: shotHere.png, format: 'png' }} columns={imageCols} rows={Math.max(6, Math.round((imageCols * 9) / 32))} alt={`Screenshot of step ${step.n}. Your terminal does not draw images here; open it with the link below.`} />
              )}
              {shotHere?.jpg && <Link key="shot-link" href={`file://${shotHere.jpg}`} label="Open full screenshot ↗" />}
              {shotHere?.error && <Text color="red" wrap="wrap">{shotHere.error}</Text>}
            </Box>
          )}
          {ins.pack && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              {viewer?.pack === ins.pack && viewer.url ? (
                <Link key="ins-viewer-link" href={viewer.url} label="Open in the evidence viewer ↗" />
              ) : (
                <Button
                  key="ins-viewer"
                  label={viewer?.pack === ins.pack && viewer.isStarting ? 'Starting viewer…' : 'Evidence viewer'}
                  hotkey="v"
                  onPress={() => void openViewer($, ins.pack!)}
                />
              )}
              {viewer?.pack === ins.pack && viewer.url && <Button key="ins-viewer-stop" label="Stop viewer" plain onPress={() => void closeViewer($)} />}
              <Button key="ins-validate" label="Validate pack" plain onPress={() => void validatePack($, ins.pack!)} />
              {viewer?.pack === ins.pack && viewer.error && <Text color="red" wrap="wrap">{viewer.error}</Text>}
            </Box>
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="ins-copy" label="Copy evidence summary" plain onPress={pressed => void $.ui.copy({ text: report, surface: pressed.surface }).then(() => flash($, 'Copied the evidence summary.'))} />
            {ins.pack && <Button key="ins-pack" label="Copy pack path" plain onPress={pressed => void $.ui.copy({ text: ins.pack ?? '', surface: pressed.surface }).then(() => flash($, `Copied ${ins.pack}`))} />}
          </Box>
        </Box>
      )
    }

    // ── Assurance tab: requirement → use cases → designed tests → coverage
    const assureTab = () => {
      const a = assurance
      const job = a.job
      const isBusy = job?.status === 'running'
      const JOB_LOOK: Record<string, { label: string; color: string }> = {
        running: { label: 'RUNNING', color: 'cyan' },
        complete: { label: 'DONE', color: 'green' },
        paused: { label: 'NEEDS YOUR ANSWER', color: 'yellow' },
        refused: { label: 'REFUSED', color: 'red' },
        error: { label: 'FAILED', color: 'red' },
        interrupted: { label: 'STOPPED', color: 'gray' },
      }
      const stage = !a.hasStore ? 0 : a.useCases === 0 ? 1 : a.trusted === 0 && a.derived > 0 ? 2 : (a.designPct ?? 0) < 100 ? 3 : 4
      const STAGES = ['Ingest', 'Extract', 'Review', 'Design', 'Run & cover']
      const isDerived = (id: string) => a.nodes.find(n => n.id === id)?.trust === 'derived'
      // The paused sessions besides the one the job already shows.
      const otherSessions = a.sessions.filter(x => !(x.sid === job?.sid && (job?.status === 'running' || job?.status === 'paused')) && x.pending > 0)
      // Designed tests on disk (t-1, t-2 …): the graph's ids `testrun --from-context` takes.
      const designedIds = a.designed ?? []
      const runDesigned = () => launch($, 'testrun', `designed tests ${designedIds.join(',')}`, ['testrun', 'run', '--from-context', designedIds.join(','), '--headless'], 'pane')
      const questionBox = (key: string, from: Pick<AssureJob, 'argv' | 'sid' | 'resume' | 'verb'>, questions: readonly AssureQuestion[]) => (
        <Box key={key} flexDirection="column" gap={1}>
          {questions.slice(0, 3).map(q => (
            <Box key={`${key}-${q.id}`} flexDirection="column">
              <Text bold wrap="wrap">{`${q.id}${q.risk ? ` · ${q.risk} risk` : ''} · ${q.text}`}</Text>
              {q.rationale && <Text dimColor wrap="wrap">{q.rationale}</Text>}
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {q.options.map((o, i) => (
                  <Button
                    key={`${key}-${q.id}-o${i}`}
                    label={`${i + 1} ${o.label}${q.recommended === i ? ' ★' : ''}`}
                    variant={q.recommended === i ? 'primary' : 'secondary'}
                    onPress={() => void answerQuestion($, from, q, String(i + 1))}
                  />
                ))}
              </Box>
              {q.options[q.recommended ?? -1]?.detail && <Text dimColor wrap="wrap">{`★ recommended: ${q.options[q.recommended ?? -1]!.detail}`}</Text>}
            </Box>
          ))}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key={`${key}-claude`} label="Let Claude answer" onPress={() => void answerWithClaude($, from, questions)} />
            {from.resume && <Button key={`${key}-copy`} label="Copy resume command" plain onPress={pressed => void $.ui.copy({ text: from.resume ?? '', surface: pressed.surface }).then(() => flash($, 'Copied the resume command.'))} />}
          </Box>
        </Box>
      )
      return (
        <Box flexDirection="column" key="assure" gap={1}>
          <Box flexDirection="column">
            <Text wrap="wrap">
              {STAGES.map((name, i) => `${i < stage ? '✓' : i === stage ? '▸' : '○'} ${name}`).join('  →  ')}
            </Text>
            <Text dimColor wrap="wrap">
              {a.isLoading && !a.checkedAt
                ? 'Reading the assurance store…'
                : a.hasStore
                  ? `${a.sources} source${a.sources === 1 ? '' : 's'} · ${a.useCases} use case${a.useCases === 1 ? '' : 's'} (${a.trusted} trusted, ${a.derived} to review)${a.stale ? ` · ${a.stale} stale` : ''}${a.designPct !== undefined ? ` · designed ${Math.round(a.designPct)}%` : ''}${a.provenPct !== undefined ? ` · proven ${Math.round(a.provenPct)}%` : ' · nothing run yet'}`
                  : 'No requirement store in this project yet. Ingest a PRD, a user story or a ticket: kane extracts use cases, designs tests that cite it, and tracks coverage.'}
            </Text>
          </Box>
          {Input && (
            <Box flexDirection="column">
              {width < 70 && <Text dimColor>Requirement</Text>}
              <Input
                key="assure-source"
                label={width < 70 ? undefined : 'Requirement'}
                placeholder="./docs/prd.md or a Jira / Confluence / Linear / web URL"
                value={a.source}
                submitLabel="Ingest & extract"
                onInput={v => void update($, assuranceAtom, x => ({ ...x, source: v }))}
                onSubmit={v => {
                  void update($, assuranceAtom, x => ({ ...x, source: v }))
                  if (v.trim()) void runAssure($, `Ingest & extract ${clip(v.trim(), 40)}`, ['context', 'ingest', v.trim(), '--mode', 'agent'])
                }}
              />
            </Box>
          )}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="as-refresh" label={a.isLoading ? 'Reading…' : 'Refresh'} hotkey="f" onPress={() => void refreshAssurance($)} />
            {designedIds.length > 0 && (
              <Button key="as-run-designed" label={`Run ${designedIds.length} designed test${designedIds.length === 1 ? '' : 's'}`} variant={stage >= 4 ? 'primary' : 'secondary'} onPress={runDesigned} />
            )}
            {a.hasStore && <Button key="as-extract" label="Extract pending sources" onPress={() => void runAssure($, 'Extract use cases', ['context', 'extract', '--mode', 'agent'])} />}
            {a.derived > 0 && <Button key="as-review" label={`Review ${a.derived} with Claude`} variant={stage === 2 ? 'primary' : 'secondary'} onPress={() => void reviewWithClaude($)} />}
            {a.stale > 0 && <Button key="as-evolve" label={`Evolve ${a.stale} stale`} onPress={() => void runAssure($, 'Evolve stale designs', ['maintain', 'evolve', '--from-stale', '--mode', 'agent'])} />}
            {a.hasStore && <Button key="as-graph" label="View graph" onPress={() => void viewGraph($)} />}
            {a.hasStore && <Button key="as-sync" label="Sync with team" onPress={() => void runAssure($, 'Sync with the team', ['context', 'sync', '--mode', 'agent'])} />}
            {isBusy && <Button key="as-stop" label="Stop" hotkey="s" onPress={() => assureStop?.()} />}
          </Box>
          {a.proven && <Text color={a.provenPct !== undefined && a.provenPct >= 100 ? 'green' : 'yellow'} wrap="wrap">{`Proven by runs: ${a.proven}${a.provenAt ? ` · last run ${ago(Date.now() - a.provenAt)}` : ''}`}</Text>}
          {liveRuns.length > 0 && <Text color="cyan" wrap="wrap">{`${liveRuns.map(liveLine).join('   ')} — coverage updates when it finishes.`}</Text>}
          {a.graphPath && <Link key="as-graph-link" href={`file://${a.graphPath}`} label="Open the requirement graph ↗" />}
          {a.error && !a.hasStore && <Text dimColor wrap="wrap">{a.error}</Text>}
          {job && (
            <Box flexDirection="column" borderStyle="round" borderColor={JOB_LOOK[job.status]?.color ?? 'gray'} paddingX={1}>
              <Text bold color={JOB_LOOK[job.status]?.color} wrap="wrap">{`${JOB_LOOK[job.status]?.label ?? job.status} · ${job.label}${job.credits ? ` · ${job.credits} credits` : ''}`}</Text>
              {(isBusy ? job.activity.slice(-3) : []).map((x, i) => <Text key={`ja-${i}`} dimColor wrap="truncate-end">{`· ${x}`}</Text>)}
              {job.messages.slice(-2).map((x, i) => <Text key={`jm-${i}`} wrap="wrap">{x}</Text>)}
              {job.committed.length > 0 && <Text color="green" wrap="wrap">{`Committed: ${job.committed.slice(-6).join(', ')}`}</Text>}
              {job.errors.map((x, i) => <Text key={`je-${i}`} color="red" wrap="wrap">{x}</Text>)}
              {job.variables && job.variables.names.length > 0 && (
                <Text color="yellow" wrap="wrap">{`These tests need values for ${job.variables.names.map(v => `{{${v}}}`).join(', ')}${job.variables.file ? ` (stubs in ${job.variables.file})` : ''}: fill them before running, or kane types the names as written.`}</Text>
              )}
              {job.status === 'complete' && job.variables && job.variables.names.length > 0 && (
                    <Button
                      key="job-fill-vars"
                      label="Fill variables with Claude"
                      onPress={() =>
                        void $.prompt.submit({
                          text: `kane-cli designed tests ${designedIds.join(', ')} that use ${job.variables?.names.map(v => `{{${v}}}`).join(', ')}${job.variables?.file ? `, stubbed in ${job.variables.file}` : ''}. Read the tests under .testmuai/tests/ and the requirement, propose realistic values for each variable (ask me for anything secret, and mark secrets as secret), and write them into that variables file.`,
                        })
                      }
                    />
              )}
              {job.status === 'paused' && job.questions.length > 0 && questionBox('jq', job, job.questions)}
              {job.status !== 'running' && job.status !== 'paused' && job.next.length > 0 && (
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  {job.next.slice(0, 3).map((cmd, i) => (
                    <Button key={`jn-${i}`} label={`▶ ${clip(cmd.replace(/^kane-cli\s+/, '').replace(/\s+--mode agent$/, ''), Math.max(16, width - 10))}`} plain onPress={() => runReady($, cmd)} />
                  ))}
                </Box>
              )}
            </Box>
          )}
          {otherSessions.map(x => (
            <Box key={`ses-${x.sid}`} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
              <Text bold color="yellow" wrap="wrap">{`Paused ${x.verb} · ${x.pending} question${x.pending === 1 ? '' : 's'} waiting${x.expiresAt ? ` · expires ${new Date(x.expiresAt).toLocaleString()}` : ''}`}</Text>
              {x.questions?.length ? questionBox(`sq-${x.sid}`, { argv: [], sid: x.sid, resume: x.resume, verb: x.verb }, x.questions) : <Button key={`ses-resume-${x.sid}`} label="Resume" onPress={() => runReady($, x.resume)} />}
            </Box>
          ))}
          {a.usecases.length > 0 && <Text bold>Use cases</Text>}
          {a.usecases.slice(0, Math.max(2, Math.floor((height - 18) / 3))).map(uc => (
            <Box key={`uc-${uc.id}`} flexDirection="column">
              <Text wrap="wrap">
                <Text color={uc.pct === undefined || uc.pct === 0 ? 'yellow' : uc.pct >= 100 ? 'green' : undefined} bold>{`${uc.pct !== undefined && uc.pct >= 100 ? '✓' : '○'} ${uc.id} `}</Text>
                {`${uc.title}${uc.risk ? ` · ${uc.risk} risk` : ''} · ${uc.pct !== undefined ? `${Math.round(uc.pct)}% designed` : 'not designed'}${isDerived(uc.id) ? ' · unreviewed' : ''}`}
              </Text>
              <Box flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={2}>
                {isDerived(uc.id) && <Button key={`uc-ok-${uc.id}`} label="Approve" plain onPress={() => void approveUseCase($, uc.id)} />}
                {(uc.pct ?? 0) < 100 && (
                  <Button
                    key={`uc-design-${uc.id}`}
                    label={isDerived(uc.id) ? 'Design anyway' : 'Design tests'}
                    plain
                    onPress={() => void runAssure($, `Design tests for ${uc.id}`, ['design', 'tests', '--use-case', uc.id, '--mode', 'agent', ...(isDerived(uc.id) ? ['--allow-unreviewed'] : [])])}
                  />
                )}
                {uc.pending.slice(0, 2).map((g, i) =>
                  g.cmd && !/design tests --use-case/.test(g.cmd) ? (
                    <Button key={`uc-gap-${uc.id}-${i}`} label={`▶ ${clip(g.why, 40)}`} plain onPress={() => runReady($, g.cmd!)} />
                  ) : null,
                )}
              </Box>
              {uc.pending.slice(0, 2).map((g, i) => (
                <Box key={`uc-why-${uc.id}-${i}`} paddingLeft={2}>
                  <Text dimColor wrap="wrap">{`↳ ${g.why}`}</Text>
                </Box>
              ))}
            </Box>
          ))}
          {a.hasStore && a.usecases.length === 0 && a.useCases === 0 && !isBusy && otherSessions.length === 0 && job?.status !== 'paused' && (
            <Text dimColor wrap="wrap">Sources are in but no use case yet: press "Extract pending sources".</Text>
          )}
        </Box>
      )
    }

    // ── History tab
    const historyTab = () => {
      const views = (
        <Box flexDirection="row" gap={1} flexWrap="wrap" key="hv">
          {(['runs', 'trends', 'credits', 'quality', 'sites'] as const).map(v => (
            <Button
              key={`hv-${v}`}
              hotkey={v === 'sites' ? '0' : String(6 + ['runs', 'trends', 'credits', 'quality'].indexOf(v))}
              label={`${historyView === v ? '▸ ' : ''}${v[0]!.toUpperCase()}${v.slice(1)}`}
              variant={historyView === v ? 'primary' : 'secondary'}
              onPress={() => void update($, historyViewAtom, () => v)}
            />
          ))}
        </Box>
      )
      const recent = history.slice(0, 14).reverse()
      const KIND_MARK: Record<string, string> = { product: '!', unclear: '?', automation: '~', signals: '⚠', clean: ' ' }
      if (historyView === 'sites') {
        const sites = siteGroups(history, insights)
        return (
          <Box flexDirection="column" key="history" gap={1}>
            {views}
            {liveStrip('sites')}
            {sites.length === 0 && <Text dimColor>No runs yet.</Text>}
            {sites.slice(0, 4).map(g => (
              <Box key={`site-${g.host}`} flexDirection="column" borderStyle="round" borderColor={g.failed ? 'yellow' : 'green'} paddingX={1}>
                <Text bold wrap="wrap">{`${g.host} · ${g.runs} run${g.runs === 1 ? '' : 's'} · ✓ ${g.passed} ✗ ${g.failed} · ${g.credits} credits · ${ago(Date.now() - g.lastAt)}`}</Text>
                {g.scenarios.slice(0, 6).map(sc => (
                  <Box key={`sc-${g.host}-${sc.id}`} flexDirection="row" gap={1}>
                    <Text color={sc.failed && !sc.passed ? 'red' : sc.failed ? 'yellow' : 'green'}>{sc.failed && sc.passed ? '≈' : sc.failed ? '✗' : '✓'}</Text>
                    <Box flexShrink={1}>
                      <Text wrap="truncate-end">{`${sc.label}${sc.passed + sc.failed > 1 ? `  (${sc.passed}/${sc.passed + sc.failed})` : ''}`}</Text>
                    </Box>
                    {sc.sessionDir && <Button key={`sc-ins-${sc.id}`} label="insights" plain onPress={() => void focusRun($, sc.sessionDir, sc.label)} />}
                  </Box>
                ))}
                {g.scenarios.length > 6 && <Text dimColor>{`… ${g.scenarios.length - 6} more scenarios`}</Text>}
                {g.pages.length > 0 && <Text dimColor wrap="wrap">{`Pages reached: ${g.pages.slice(0, 8).join('  ')}${g.pages.length > 8 ? ` +${g.pages.length - 8}` : ''}`}</Text>}
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  <Button
                    key={`site-next-${g.host}`}
                    label="What to explore next"
                    onPress={() =>
                      void $.prompt.submit({
                        text: [
                          `I'm exploring ${g.host} with KaneAI. Scenarios run so far (✓ passed, ✗ failed, ≈ both):`,
                          ...g.scenarios.map(sc => `- ${sc.failed && sc.passed ? '≈' : sc.failed ? '✗' : '✓'} ${sc.label}`),
                          g.pages.length ? `Pages reached: ${g.pages.join(', ')}` : '',
                          'As a QE discovering this app: list the features and pages not covered yet (navigation, forms, account, cart/checkout, search edge cases, errors, accessibility), propose the next 5 scenarios as kane objectives with assertions, highest value first,',
                          `and ask me which to run; then run the ones I pick with ${TOOL('kane_run')} (in parallel when they are independent).`,
                        ]
                          .filter(Boolean)
                          .join('\n'),
                      })
                    }
                  />
                  <Button key={`site-fails-${g.host}`} label="Triage the failures" plain onPress={() => {
                    const f = history.find(h => (h.status === 'failed' || h.status === 'error') && g.scenarios.some(sc => normalizeLabel(sc.label) === normalizeLabel(h.label)))
                    if (f) void triage($, f.sessionDir, f.label, f.oneLiner)
                    else void flash($, `No failed run on ${g.host}.`)
                  }} />
                </Box>
              </Box>
            ))}
          </Box>
        )
      }
      if (historyView === 'trends') {
        const flaky = flakyGroups(history)
        const failures = history.filter(h => h.status === 'failed' || h.status === 'error')
        const causes = new Map<string, number>()
        for (const f of failures) causes.set(f.insight?.kind ?? 'unread', (causes.get(f.insight?.kind ?? 'unread') ?? 0) + 1)
        return (
          <Box flexDirection="column" key="history" gap={1}>
            {views}
            <Text dimColor>{`Last ${recent.length} runs, oldest first · bar = duration · ✓ ${history.filter(h => h.status === 'passed').length}  ✗ ${failures.length}`}</Text>
            {Client ? (
              <Client
                key="hist-trend"
                module="./bars.client.tsx"
                props={{
                  chart: 'history',
                  bars: recent.map(h => ({
                    id: h.id,
                    label: `${new Date(h.endedAt).toTimeString().slice(0, 5)} ${h.label}`,
                    value: h.durationS ?? 0,
                    valueText: `${h.durationS ?? '?'}s`,
                    color: h.status === 'passed' ? (h.insight?.kind === 'signals' ? '#fbbf24' : '#4ade80') : h.status === 'cancelled' ? '#9ca3af' : '#f87171',
                    mark: KIND_MARK[h.insight?.kind ?? ''] ?? ' ',
                    note: `${h.status} · ${h.durationS ?? '?'}s${h.credits !== undefined ? ` · ${h.credits} cr` : ''}${h.insight ? ` · ${h.insight.headline}` : ''}  (click to open its insights)`,
                  })),
                }}
              />
            ) : (
              recent.map(h => <Text key={`tr-${h.id}`}>{`${ICON[h.status] ?? '?'} ${h.durationS ?? '?'}s ${h.label}`}</Text>)
            )}
            <Text dimColor>{'Marks: ! product bug  ? needs a look  ~ CLI / model  ⚠ page signals on a pass'}</Text>
            {failures.length > 0 && (
              <Text wrap="wrap">
                {`Failures by owner: ${[...causes.entries()].map(([k, n]) => `${KIND_LOOK[k]?.label.toLowerCase() ?? k} ${n}`).join(' · ')}`}
              </Text>
            )}
            {flaky.length > 0 ? (
              flaky.map((g, i) => <Text key={`fl-${i}`} color="yellow" wrap="wrap">{`Flaky: ${g.label} — passed ${g.passed}, failed ${g.failed}`}</Text>)
            ) : (
              <Text dimColor>No flaky objectives yet (none has both passed and failed).</Text>
            )}
          </Box>
        )
      }
      if (historyView === 'credits') {
        const stats = creditStats(history, env.balance)
        const usedShare = stats.left !== undefined && stats.total ? 1 - stats.left / stats.total : undefined
        const meterW = Math.max(10, Math.min(48, width - 10))
        return (
          <Box flexDirection="column" key="history" gap={1}>
            {views}
            {usedShare !== undefined && (
              <Box flexDirection="column">
                <Text>
                  <Text color="#fb923c">{'█'.repeat(Math.round(usedShare * meterW))}</Text>
                  <Text dimColor>{'░'.repeat(meterW - Math.round(usedShare * meterW))}</Text>
                </Text>
                <Text wrap="wrap">{`${stats.left} of ${stats.total} credits left${stats.runsLeft !== undefined ? ` · about ${stats.runsLeft} runs at your average` : ''}`}</Text>
              </Box>
            )}
            <Text dimColor wrap="wrap">{`${stats.used} credits over ${stats.runs} runs · ${stats.avg} per run on average`}</Text>
            {Client ? (
              <Client
                key="hist-credits"
                module="./bars.client.tsx"
                props={{
                  chart: 'credits',
                  bars: [...history]
                    .filter(h => typeof h.credits === 'number')
                    .sort((a, b) => (b.credits ?? 0) - (a.credits ?? 0))
                    .slice(0, 12)
                    .map(h => ({
                      id: h.id,
                      label: h.label,
                      value: h.credits ?? 0,
                      valueText: `${h.credits}`,
                      color: h.status === 'passed' ? '#60a5fa' : '#fb923c',
                      note: `${h.label} · ${h.status} · ${h.durationS ?? '?'}s${h.status !== 'passed' ? ' · credits spent on a run that failed' : ''}  (click to open)`,
                    })),
                }}
              />
            ) : (
              history.slice(0, 10).map(h => <Text key={`cr-${h.id}`}>{`${h.credits ?? '?'} cr  ${h.label}`}</Text>)
            )}
          </Box>
        )
      }
      if (historyView === 'quality') {
        const withVitals = history.filter(h => h.vitals && Object.keys(h.vitals).length).slice(0, 10).reverse()
        const url = form.url || env.config.default_url
        return (
          <Box flexDirection="column" key="history" gap={1}>
            {views}
            <Text bold>Web vitals</Text>
            {withVitals.length > 0 && Client ? (
              <Client
                key="hist-vitals"
                module="./bars.client.tsx"
                props={{
                  chart: 'vitals',
                  bars: withVitals.map(h => {
                    const v = h.vitals ?? {}
                    const lcp = v.lcp ?? 0
                    return {
                      id: h.id,
                      label: `${new Date(h.endedAt).toTimeString().slice(0, 5)} ${h.label}`,
                      value: lcp,
                      valueText: v.lcp !== undefined ? `LCP ${Math.round(lcp)}` : 'no LCP',
                      color: lcp <= 2500 ? '#4ade80' : lcp <= 4000 ? '#fbbf24' : '#f87171',
                      note: Object.entries(v).map(([k, n]) => `${k.toUpperCase()} ${n}`).join(' · '),
                    }
                  }),
                }}
              />
            ) : (
              <Text dimColor wrap="wrap">{withVitals.length ? withVitals.map(h => `${h.label}: ${JSON.stringify(h.vitals)}`).join('\n') : 'No vitals measured yet. kane records them when an objective asks for them.'}</Text>
            )}
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="q-vitals" label={`Measure web vitals${url ? ` on ${shortUrl(url)}` : ''}`} onPress={() => measureVitals($, url || undefined)} />
            </Box>
            <Text bold>Requirement coverage</Text>
            {coverage.isLoading && <Text dimColor>Checking coverage…</Text>}
            {coverage.summary?.map((line, i) => <Text key={`cov-${i}`} wrap="wrap">{line}</Text>)}
            {coverage.error && (
              <Text dimColor wrap="wrap">{`No coverage yet: ${coverage.error}. Ingest a requirement (PRD, user story) to start the graph.`}</Text>
            )}
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="q-cover" label="Check coverage" onPress={() => void checkCoverage($)} />
              {coverage.error && <Button key="q-ingest" label="Ingest a requirement" onPress={() => void $.prompt.fill({ text: '! kane-cli context ingest ' })} />}
            </Box>
            <Text bold>Flakiness</Text>
            <Text dimColor wrap="wrap">Open a run in Insights and press "Check flakiness ×3" to rerun it three times and get a pass rate.</Text>
          </Box>
        )
      }
      const room = Math.max(3, Math.floor((height - 12) / (width < 100 ? 2 : 1)))
      return (
        <Box flexDirection="column" key="history">
          {views}
          {history.length === 0 && <Text dimColor>No runs yet.</Text>}
          {history.length > 0 && (
            <Text dimColor>
              {`${history.filter(entry => entry.status === 'passed').length}/${history.length} passed · ${Math.round(history.reduce((n, entry) => n + (entry.credits ?? 0), 0) * 100) / 100} credits`}
            </Text>
          )}
          {history.slice(0, room).map((entry, i) => (
            <Box key={`h-${i}`} flexDirection={width < 100 ? 'column' : 'row'} gap={width < 100 ? 0 : 1}>
              <Box flexDirection="row" gap={1} flexShrink={1}>
                <Text color={COLOR[entry.status]}>{`${ICON[entry.status] ?? '?'}${KIND_MARK[entry.insight?.kind ?? ''] ?? ' '}`}</Text>
                <Box flexShrink={1}>
                  <Text wrap={width < 100 ? 'wrap' : 'truncate-end'}>{entry.label}</Text>
                </Box>
              </Box>
              <Box flexDirection="row" gap={1} paddingLeft={width < 100 ? 2 : 0}>
              <Text dimColor>{`${entry.durationS ?? '?'}s · ${ago(Date.now() - entry.endedAt)}${entry.credits !== undefined ? ` · ${entry.credits} cr` : ''}`}</Text>
              {entry.sessionDir && <Button key={`h-ins-${i}`} label="insights" plain onPress={() => void focusRun($, entry.sessionDir, entry.label)} />}
              {entry.rerun.length > 0 && (
                <Button
                  key={`h-rerun-${i}`}
                  label="↻"
                  plain
                  onPress={() => launch($, entry.kind, entry.label, entry.rerun, 'pane')}
                />
              )}
              {(entry.status === 'failed' || entry.status === 'error') && (
                <Button key={`h-triage-${i}`} label="triage" plain onPress={() => void triage($, entry.sessionDir, entry.label, entry.oneLiner)} />
              )}
              </Box>
            </Box>
          ))}
          {history.length > 0 && (
            <Box flexDirection="row" gap={1}>
              <Button
                key="h-report"
                label="Ask Claude for a QA report"
                onPress={() =>
                  void $.prompt.submit({
                    text:
                      'Write a concise QA run report from these KaneAI runs (newest first): pass rate, failures grouped by likely cause, flaky candidates (same label both passed and failed), credits used, and recommended next actions.\n' +
                      JSON.stringify(history.slice(0, 30).map(entry => ({ label: entry.label, kind: entry.kind, status: entry.status, oneLiner: entry.oneLiner, durationS: entry.durationS, credits: entry.credits, testUrl: entry.testUrl, sessionDir: entry.sessionDir, at: new Date(entry.endedAt).toISOString() }))),
                  })
                }
              />
              <Button
                key="h-clear"
                label="Clear"
                onPress={async () => {
                  await update($, historyAtom, () => [])
                  await $.store.set('history', [])
                }}
              />
            </Box>
          )}
        </Box>
      )
    }

    // ── Setup tab
    const setupTab = () => (
      <Box flexDirection="column" key="setup">
        <Box flexDirection="row" gap={1}>
          <Button key="s-refresh" label={env.isChecking ? 'Checking…' : 'Re-check'} hotkey="c" onPress={() => void refreshEnv($)} />
          {!env.isInstalled && (
            <Button key="s-install" label="Install kane-cli" variant="primary" onPress={() => void $.prompt.fill({ text: '! npm install -g @testmuai/kane-cli' })} />
          )}
          {env.isInstalled && env.auth !== 'ok' && (
            <Button key="s-login" label="Log in" variant="primary" onPress={() => void $.prompt.fill({ text: '! kane-cli login' })} />
          )}
          {env.isInstalled && (
            <Button key="s-skill" label="Install agent skill" onPress={() => void $.prompt.fill({ text: '! kane-cli install skill' })} />
          )}
        </Box>
        {env.error && <Text color="red">{clip(env.error, width * 2)}</Text>}
        {!env.isInstalled && !env.isChecking && (
          <Text dimColor>Set a custom launcher in /config → kane-qe → kane-cli command (e.g. node ~/…/kane-cli/dist/index.js).</Text>
        )}
        {env.whoami && <Text dimColor>{clip(env.whoami, width * 3)}</Text>}
        {env.balance && <Text>{clip(env.balance, width)}</Text>}
        {env.config.default_url && <Text dimColor>{clip(`Default URL: ${env.config.default_url}`, width)}</Text>}
        {env.config.window_size && <Text dimColor>{`Window: ${env.config.window_size}`}</Text>}
        {env.isInstalled &&
          SETTINGS.map(s => (
            <Box key={`set-${s.key}`} flexDirection="row" gap={1}>
              <Text>{s.label.padEnd(14)}</Text>
              {s.values.map(v => (
                <Button
                  key={`set-${s.key}-${v}`}
                  label={v}
                  variant={(env.config[s.key] ?? '') === v ? 'primary' : 'secondary'}
                  onPress={async () => {
                    const r = await kane($, ['config', s.action, v], 20_000)
                    await flash($, r.exitCode === 0 ? `${s.label} → ${v}` : clip(stripAnsi(r.stderr || r.stdout), 120))
                    await refreshEnv($)
                  }}
                />
              ))}
            </Box>
          ))}
        {env.isInstalled && (
          <Box flexDirection="column" paddingTop={1}>
            <Text bold>Mobile and cloud grid</Text>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="s-doc-android" label="Check Android tooling" onPress={() => void runDoctor($, 'emulator')} />
              <Button key="s-doc-ios" label="Check iOS tooling" onPress={() => void runDoctor($, 'simulator')} />
              <Button key="s-grid" label={grid.plugin === 'checking' ? 'Checking grid…' : 'Check grid plugin'} onPress={() => void checkGridPlugin($)} />
            </Box>
            {grid.plugin === 'ok' && <Text color="green">✓ Grid plugin installed: suites can run on HyperExecute (Tests → Cloud grid).</Text>}
            {grid.plugin === 'missing' && (
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Text color="yellow">✗ remote-execution plugin not installed</Text>
                <Button key="s-grid-install" label="Install grid plugin" onPress={() => void installGridPlugin($)} />
              </Box>
            )}
            {grid.doctor && (
              <Box flexDirection="column">
                <Text dimColor>{grid.doctor.isLoading ? `Checking ${grid.doctor.target} tooling…` : `kane-cli doctor --target ${grid.doctor.target}`}</Text>
                {grid.doctor.checks.map((c, i) => (
                  <Box key={`doc-${i}`} flexDirection="column">
                    <Text color={c.ok ? 'green' : 'red'} wrap="wrap">{`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`}</Text>
                    {c.fix && (
                      <Box paddingLeft={2}>
                        <Text dimColor wrap="wrap">{`fix: ${c.fix}`}</Text>
                      </Box>
                    )}
                  </Box>
                ))}
                {grid.doctor.error && <Text color="yellow" wrap="wrap">{grid.doctor.error}</Text>}
                {!grid.doctor.isLoading && grid.doctor.checks.some(c => !c.ok) && (
                  <Box flexDirection="row" gap={1} flexWrap="wrap">
                    <Button key="s-doc-install" label="Install managed tooling" onPress={() => void $.prompt.fill({ text: `! kane-cli doctor --target ${grid.doctor?.target ?? 'emulator'} --install` })} />
                    <Text dimColor wrap="wrap">No Mac setup needed for the grid: Tests → Cloud grid.</Text>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )}
      </Box>
    )

    const body = tab === 'assure' ? assureTab() : tab === 'tests' ? testsTab() : tab === 'history' ? historyTab() : tab === 'setup' ? setupTab() : tab === 'insights' ? insightsTab() : runTab()
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Text dimColor wrap="wrap">{hint}</Text>
        {body}
      </Box>
    )
  })
}

// ── transcript cards for the model's kane runs ───────────────────────

async function runCard($: $, e: RenderInput<'ToolUse'>, next: (e: RenderInput<'ToolUse'>) => Promise<RenderElement>): Promise<RenderElement> {
  const cards = await read($, cardsAtom)
  const run = cards[e.props.tool_use_id]
  if (!run) return next(e)
  const insight = run.sessionDir ? (await read($, insightsAtom))[run.sessionDir]?.data : undefined
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const width = Math.max(30, (e.viewport?.columns ?? 100) - 6)
  const isRunning = run.status === 'running'
  const status = isRunning ? 'running' : run.status
  const title = run.kind === 'testrun' ? 'Kane suite' : run.kind === 'testmd' ? 'Kane test' : 'Kane run'
  const shown = isRunning ? run.steps.slice(-4) : run.steps.slice(-6)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR[status] ?? 'gray'} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          <Text bold color={COLOR[status]}>{`${ICON[status] ?? '?'} ${title} · ${status.toUpperCase()}`}</Text>
        </Box>
        <Text dimColor>
          {[run.durationS !== undefined ? `${run.durationS}s` : undefined, run.credits !== undefined ? `${run.credits} credits` : undefined, `${run.steps.length} steps`]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </Box>
      <Text wrap="wrap">{run.label}</Text>
      {run.progress && <Text dimColor>{run.progress}</Text>}
      {shown.map(s => (
        <Box key={`c-${s.n}`} flexDirection="row">
          <Text color={COLOR[s.status]} dimColor={s.status === 'pending'}>{`${ICON[s.status] ?? '·'} ${String(s.n).padStart(2)} `}</Text>
          <Box flexShrink={1}>
            <Text color={COLOR[s.status]} dimColor={s.status === 'pending'} wrap="wrap">{tidyStep(s.text)}</Text>
          </Box>
        </Box>
      ))}
      {isRunning && shown.length === 0 && <Text dimColor>Launching browser…</Text>}
      {run.oneLiner && <Text color={COLOR[status]} wrap="wrap">{run.oneLiner}</Text>}
      {run.finalState &&
        Object.entries(run.finalState)
          .slice(0, 4)
          .map(([k, v]) => (
            <Text key={`cv-${k}`} wrap={typeof v === 'string' && /^https?:\/\//.test(v) ? 'truncate-middle' : 'wrap'}>
              {`  ${k} = ${typeof v === 'string' ? (/^https?:\/\//.test(v) ? shortUrl(v) : v) : JSON.stringify(v)}`}
            </Text>
          ))}
      {!isRunning && run.status === 'error' && run.stderrTail.slice(-2).map((m, i) => <Text key={`ce-${i}`} color="red">{clip(m, width)}</Text>)}
      {insight && (
        <Text color={insight.attribution.kind === 'product' ? 'red' : insight.attribution.kind === 'automation' ? 'cyan' : insight.attribution.kind === 'clean' ? 'green' : 'yellow'} wrap="wrap">
          {`Evidence: ${insight.attribution.headline}`}
        </Text>
      )}
      {run.testUrl && <Link key="card-report" href={run.testUrl} label="Test Manager report ↗" />}
      <Box flexDirection="row" gap={1}>
        <Button key="card-open" label="Open cockpit" onPress={() => void openPane($, 'run')} />
        {!isRunning && run.sessionDir && <Button key="card-insights" label="Insights" onPress={() => void focusRun($, run.sessionDir, run.label).then(() => openPane($))} />}
        {isRunning && <Button key="card-stop" label="Stop" onPress={() => active.get(run.id)?.stop()} />}
        {!isRunning && (run.status === 'failed' || run.status === 'error') && (
          <Button key="card-triage" label="Triage" variant="primary" onPress={() => void triage($, run.sessionDir, run.label, run.oneLiner)} />
        )}
        {!isRunning && run.status === 'passed' && run.sessionDir && (
          <Button
            key="card-code"
            label="Playwright code"
            onPress={() =>
              void $.prompt.submit({
                text: `Read the Playwright test kane-cli exported for this passing run (${run.sessionDir}/code-export/test.py, plus requirements.txt and .env.example). Explain what it covers, then propose how to add it to this repo's test suite. Objective was: "${run.label}"`,
              })
            }
          />
        )}
        {!isRunning && run.kind === 'run' && (
          <Button key="card-rerun" label="Rerun" onPress={() => launch($, 'run', run.label, runArgs({ objective: run.label, headless: true, timeoutSeconds: defaultTimeout }), 'pane')} />
        )}
      </Box>
    </Box>
  )
}

async function compactResult($: $, e: RenderInput<'ToolResult'>, next: (e: RenderInput<'ToolResult'>) => Promise<RenderElement>): Promise<RenderElement> {
  const cards = await read($, cardsAtom)
  if (!e.requestId || !cards[e.requestId]) return next(e)
  const { Text } = $.ui.resolve(e)
  return <Text dimColor>  full report handed to Claude · details in /kane</Text>
}

// ── mirroring runs started elsewhere ───────────────────────────────────
// kane-cli publishes ~/.testmuai/kaneai/sessions/active/<pid>.json while a run
// is live and mirrors its stdout to <session_dir>/events.ndjson; follow both.

type Watch = { pid: number; dir: string; offset: number; run: KaneRun; isLabelled: boolean; rerun: string[]; memberOffsets?: Map<string, number>; sizes?: Map<string, number> }

/** True when a file grew since the last look: an unchanged log is not read again. */
async function hasGrown($: $, w: Watch, file: string): Promise<boolean> {
  const size = (await $.fs.stat(file).catch(() => undefined))?.size
  if (size === undefined) return false
  const sizes = (w.sizes ??= new Map())
  if (sizes.get(file) === size) return false
  sizes.set(file, size)
  return true
}

const watches = new Map<number, Watch>()
let isPolling = false

async function isAlive($: $, pid: number): Promise<boolean> {
  try {
    return (await $.process.run(['kill', '-0', String(pid)], { timeoutMs: 5000 })).exitCode === 0
  } catch {
    return false
  }
}

async function pollExternal($: $) {
  if (isPolling) return
  isPolling = true
  try {
    const home = await $.env.get('HOME')
    if (!home) return
    const activeDir = `${home}/.testmuai/kaneai/sessions/active`
    const entries = (await $.fs.exists(activeDir)) ? await $.fs.list(activeDir) : []
    const live = new Set<number>()
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const pid = Number(entry.name.slice(0, -5))
      if (!Number.isInteger(pid) || ownPids.has(pid)) continue
      live.add(pid)
      if (watches.has(pid)) continue
      let ptr
      try {
        ptr = parsePointer(await $.fs.read(`${activeDir}/${entry.name}`))
      } catch {
        continue
      }
      if (!ptr || ptr.host_agent === AGENT_NAME || !(await isAlive($, pid))) continue
      await beginWatch($, ptr)
    }
    for (const w of [...watches.values()]) {
      await tailWatch($, w)
      if (!live.has(w.pid) || !(await isAlive($, w.pid))) await endWatch($, w)
    }
  } catch (error) {
    $.ui.log(`kane-qe mirror: ${String(error)}`, { to: 'debug' })
  } finally {
    isPolling = false
  }
}

async function beginWatch($: $, ptr: NonNullable<ReturnType<typeof parsePointer>>) {
  const kind = kindOfSurface(ptr.surface)
  const id = `ext-${ptr.pid}-${Date.now().toString(36)}`
  const startedAt = ptr.started ? Date.parse(ptr.started) || (await $.clock.now()) : await $.clock.now()
  const run: KaneRun = {
    ...newRun(id, kind, `kane-cli ${ptr.surface ?? 'run'} in ${basename(ptr.cwd)}`, 'external', startedAt),
    pid: ptr.pid,
    sessionDir: ptr.session_dir,
    hostAgent: ptr.host_agent,
    cwd: ptr.cwd,
  }
  const w: Watch = { pid: ptr.pid, dir: ptr.session_dir, offset: 0, run, isLabelled: false, rerun: [] }
  watches.set(ptr.pid, w)
  active.set(id, { pid: ptr.pid, stop: () => void $.process.run(['kill', '-INT', String(ptr.pid)]).catch(() => undefined) })
  const cur = await read($, runAtom)
  if (!cur || cur.status !== 'running') await update($, runAtom, () => run)
  await track($, run)
  void ensurePane($)
  $.ui.toast(`Kane: following a ${ptr.surface ?? 'run'} started by ${ptr.host_agent ?? 'a terminal'}`)
}

async function tailWatch($: $, w: Watch) {
  const file = `${w.dir}/events.ndjson`
  let text = ''
  try {
    if (await hasGrown($, w, file)) text = await $.fs.read(file)
  } catch {
    return
  }
  let run = w.run
  if (text.length > w.offset) {
    const { lines, rest } = takeLines(text.slice(w.offset))
    w.offset = text.length - rest.length
    for (const line of lines) {
      const evt = parseLine(line)
      if (!evt) continue
      run = applyEvent(run, evt)
      const label = w.isLabelled ? undefined : labelFromEvent(evt)
      if (label) {
        run = { ...run, label }
        w.isLabelled = true
        if (evt.type === 'recording_state' && run.kind === 'testmd') w.rerun = ['testmd', 'run', label, '--agent']
      }
    }
  }
  // A suite's members log to their own sessions: follow each one's steps too.
  for (const member of run.steps.filter(s => s.log && s.status === 'running')) {
    const offsets = (w.memberOffsets ??= new Map())
    let memberText = ''
    try {
      if (!(await hasGrown($, w, member.log!))) continue
      memberText = await $.fs.read(member.log!)
    } catch {
      continue
    }
    const from = offsets.get(member.log!) ?? 0
    if (memberText.length <= from) continue
    const { lines, rest } = takeLines(memberText.slice(from))
    offsets.set(member.log!, memberText.length - rest.length)
    for (const line of lines) {
      const evt = parseLine(line)
      if (evt) run = applyEvent(run, { type: 'testrun_member_event', member: { path: member.text }, event: evt })
    }
  }
  if (!w.isLabelled) {
    try {
      const objective = objectiveFromLog(await $.fs.read(`${w.dir}/tui.log`))
      if (objective) {
        run = { ...run, label: objective }
        w.isLabelled = true
        if (run.kind === 'run') w.rerun = ['run', objective, '--agent']
      }
    } catch {
      // no log yet
    }
  }
  if (run === w.run) return
  w.run = run
  await update($, runAtom, cur => (cur === null || cur.id === run.id || cur.status !== 'running' ? run : cur))
  await track($, run)
}

async function endWatch($: $, w: Watch) {
  watches.delete(w.pid)
  active.delete(w.run.id)
  await tailWatch($, w)
  let run = w.run
  if (run.status === 'running') run = { ...run, errors: [...run.errors, 'The run ended without a verdict (killed or crashed).'] }
  run = finishRun(run, run.status === 'running' ? 3 : 0, await $.clock.now())
  await pushHistory($, toHistory(run, w.rerun))
  await update($, runAtom, cur => (cur?.id === run.id ? run : cur))
  await track($, run)
  if (run.sessionDir) void loadInsights($, run.sessionDir, run.label)
  void afterRun($, run)
  $.ui.toast(`Kane (${run.hostAgent ?? 'external'}) ${run.status}: ${clip(run.oneLiner ?? run.label, 70)}`)
}

/** kane-cli draws boxes for humans; keep the words, one ` · `-joined line. */
function compactBox(text: string): string {
  return text
    .split('\n')
    .map(l => l.replace(/[╭╮╰╯│─┌┐└┘├┤┬┴┼]/g, '').replace(/\s{2,}/g, ' ').trim())
    .filter(Boolean)
    .join(' · ')
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}
