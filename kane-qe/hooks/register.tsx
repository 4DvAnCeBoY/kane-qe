// kane-qe v2: watches kane-cli and shows it: a band of three rows above the prompt (with the mascot),
// a pane for runs and assurance, and a nudge to test what Claude just changed.
// The mod never starts a test: Claude runs kane-cli, the mod reads what kane-cli leaves on disk.
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderSurface, TextProps } from 'claude-code'
import type { AfterChange, Assurance, Change, HistoryEntry, Kind, Offer, Run, Status, Step, View } from '../types'
import { adapt, splitLines } from './adapter'
import type { Ev } from './adapter'
import { RANK } from './adapter'
import { PICTURE, RASTER, STEP_MS, mascotSvg, pixelFrame, poseAt, rasterCells } from './mascot'
import {
  C,
  ORDER,
  band,
  bar,
  currentStep,
  cut,
  debt,
  draftPrompt,
  elapsed,
  fmt,
  fold,
  foldMember,
  isTrackedEdit,
  kindLine,
  labelFromCommand,
  leaves,
  newRun,
  nm,
  nowText,
  objectiveFrom,
  parseCoverGaps,
  ago,
  savedTestsFor,
  startUrl,
  summary,
  tally,
} from './model'
import type { Item, Row, Span } from './model'
import { MAX_READ, afterBytes, inside, parsePointer, utf8Len } from './sources'
import type { Pointer } from './sources'

const PANE = 'kane-qe'

const runsAtom = atom({ plugin: 'kane-qe', key: 'runs' } as const, [] as Run[])
const viewAtom = atom({ plugin: 'kane-qe', key: 'view' } as const, { tab: 'runs', open: '' } as View)
const tickAtom = atom({ plugin: 'kane-qe', key: 'tick' } as const, 0)
const assuranceAtom = atom({ plugin: 'kane-qe', key: 'assurance' } as const, { state: 'unknown' } as Assurance)
const changeAtom = atom({ plugin: 'kane-qe', key: 'change' } as const, null as Change | null)
const offerAtom = atom({ plugin: 'kane-qe', key: 'offer' } as const, null as Offer | null)
const modeAtom = atom({ plugin: 'kane-qe', key: 'mode' } as const, '' as '' | AfterChange)
const lastAtom = atom({ plugin: 'kane-qe', key: 'last' } as const, null as HistoryEntry | null)

type Kit = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'>
type Table = Elements[RenderSurface]
type Press = (act: string) => void

const GLYPH: Record<Status, [string, string]> = { running: ['◉', C.cyan], passed: ['✓', C.mint], failed: ['✗', C.coral], pending: ['○', C.dim] }

// ── module state: it starts over on a reload; what must last is in `$.state` / `$.store` ──

let setting: AfterChange = 'offer'
let kane: string[] = ['kane-cli']
let projectDir = ''
let activeDir = ''
/** One per file being followed: a run's own stream, or a suite member's. */
type Watch = { id: string; path: string; pointer?: string; pid?: number; bytes: number; rest: string; done: boolean; member?: string; parent?: string; closing?: boolean }
const watches = new Map<string, Watch>()
const seenPointers = new Set<string>()
/** kane-cli commands Claude ran, to name the runs they start. */
const commands: { label: string; surface: Kind; at: number; used: boolean }[] = []
let polling = false
/** The change a held stop already asked Claude to test (auto mode holds once per change). */
let heldFor = 0
const sites = new Set<string>()
let frame = 0
let thinking = false
let remote = false

// ── drawing ─────────────────────────────────────────────────────────────

function text(ui: Kit, s: Span) {
  const p: TextProps = {}
  if (s.c !== undefined) p.color = s.c
  if (s.bg !== undefined) p.backgroundColor = s.bg
  if (s.b) p.bold = true
  if (s.d) p.dimColor = true
  // A chip: the fill is on a box as well, for surfaces that paint no background behind text.
  if (s.bg !== undefined) return <ui.Box backgroundColor={s.bg}>{<ui.Text {...p}>{s.t}</ui.Text>}</ui.Box>
  return <ui.Text {...p}>{s.t}</ui.Text>
}

const item = (ui: Kit, i: Item) => (Array.isArray(i) ? <ui.Box flexDirection="row">{i.filter(s => s.t !== '').map(s => text(ui, s))}</ui.Box> : text(ui, i))

function line(ui: Kit, press: Press, r: Row) {
  if (r.items.length === 0 && !r.button) return <ui.Text> </ui.Text>
  return (
    <ui.Box flexDirection="row" gap={1}>
      {r.items.map(i => item(ui, i))}
      {r.button ? <ui.Button key={r.button.key} label={r.button.label} variant="primary" onPress={() => press(r.button?.act ?? '')} /> : null}
    </ui.Box>
  )
}

// The surface decides, not the table: a surface with no cell grid still answers `Raster`, as an empty box.
function mascot(table: Table, surface: RenderSurface, think: boolean, n: number) {
  if (surface === 'terminal' && 'Raster' in table) return <table.Raster key="mascot" columns={RASTER.columns} rows={RASTER.rows} cells={rasterCells(pixelFrame(poseAt(think, n)))} />
  // A plain image, redrawn per frame: an animated SVG needs a framed document, which paints its own backdrop.
  if ('Svg' in table) return <table.Svg source={mascotSvg(poseAt(think, n))} alt="kane mascot" width={PICTURE.width} height={PICTURE.height} />
  return <table.Text color={C.purple}>kane</table.Text>
}

const glyph = (ui: Kit, s: Status) => <ui.Text color={GLYPH[s][1]}>{GLYPH[s][0]}</ui.Text>

/** A label and its text side by side, so a wrapped text keeps its column. */
function fact(ui: Kit, label: string, value: string, color?: string) {
  return (
    <ui.Box flexDirection="row" gap={1}>
      <ui.Box width={7} flexShrink={0}>
        <ui.Text dimColor>{label}</ui.Text>
      </ui.Box>
      <ui.Box flexGrow={1} flexShrink={1}>
        {color ? <ui.Text color={color}>{value}</ui.Text> : <ui.Text>{value}</ui.Text>}
      </ui.Box>
    </ui.Box>
  )
}

const meta = (r: Run) => [r.kind, r.target].filter(Boolean).join(' · ')

function runCard(ui: Kit, press: Press, r: Run, now: number, width: number) {
  const isSuite = r.kind === 'testrun' && r.members
  const c = isSuite ? tally(r.members ?? []) : undefined
  const second = c ? `${c.passed + c.failed} of ${c.total} tests done${c.running ? ` · ${c.running} running` : ''}${c.failed ? ` · ${c.failed} failed` : ''}` : summary(r)
  return (
    <ui.Box key={`card-${r.id}`} flexDirection="column" borderStyle="round" borderColor={r.status === 'failed' ? C.coral : C.dim} paddingX={1}>
      <ui.Box flexDirection="row" gap={1}>
        {glyph(ui, r.status)}
        <ui.Button key={`run-${r.id}`} label={cut(r.label, Math.max(16, width - 16))} plain onPress={() => press(`run:${r.id}`)} />
        <ui.Text dimColor>{r.status === 'pending' ? '' : fmt(elapsed(r, now))}</ui.Text>
      </ui.Box>
      <ui.Text>{cut(second, Math.max(20, width * 2))}</ui.Text>
      {meta(r) ? <ui.Text dimColor>{meta(r)}</ui.Text> : null}
    </ui.Box>
  )
}

function memberRow(ui: Kit, press: Press, r: Run, now: number, width: number) {
  const nameRoom = Math.max(12, Math.floor(width * 0.4))
  const stepRoom = Math.max(10, width - nameRoom - 14)
  const tail = r.status === 'pending' ? '' : r.status === 'running' ? `${cut(nowText(r), stepRoom)} · ${fmt(elapsed(r, now))}` : fmt(elapsed(r, now))
  return (
    <ui.Box key={`member-${r.id}`} flexDirection="row" gap={1}>
      {glyph(ui, r.status)}
      <ui.Button key={`run-${r.id}`} label={cut(nm(r), nameRoom)} plain onPress={() => press(`run:${r.id}`)} />
      <ui.Text dimColor>{tail}</ui.Text>
    </ui.Box>
  )
}

const sortRuns = (list: readonly Run[]) => [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.startedAt - a.startedAt)
/** A suite's tests by state, each state in the plan's order. */
const sortMembers = (list: readonly Run[]) => list.map((m, i) => ({ m, i })).sort((a, b) => ORDER[a.m.status] - ORDER[b.m.status] || a.i - b.i).map(x => x.m)

function suiteView(ui: Kit, press: Press, s: Run, now: number, width: number, back: boolean) {
  const c = tally(s.members ?? [])
  return (
    <ui.Box flexDirection="column">
      <ui.Box flexDirection="row" gap={1}>
        {back ? <ui.Button key="back" label="‹ Runs" plain dimColor onPress={() => press('back')} /> : null}
        <ui.Text bold>{cut(s.label, width - 10)}</ui.Text>
      </ui.Box>
      <ui.Text dimColor>{c.total ? `${c.passed + c.failed} of ${c.total} done · ${c.running} running · ${c.pending} waiting` : 'planning the suite'}</ui.Text>
      <ui.Text> </ui.Text>
      {sortMembers(s.members ?? []).map(m => memberRow(ui, press, m, now, width))}
    </ui.Box>
  )
}

function runsView(ui: Kit, press: Press, runs: readonly Run[], now: number, width: number, last: HistoryEntry | null) {
  if (runs.length === 0) {
    return (
      <ui.Box flexDirection="column">
        <ui.Text dimColor>No kane-cli run in this session yet. Ask Claude to test something, or run kane-cli in a terminal here: it shows up by itself.</ui.Text>
        {last ? <ui.Text dimColor>{`last run ${last.status === 'passed' ? '✓' : '✗'} ${nm(last)} · ${ago(now - last.at)}`}</ui.Text> : null}
      </ui.Box>
    )
  }
  const only = runs.length === 1 ? runs[0] : undefined
  if (only?.kind === 'testrun' && only.members) return suiteView(ui, press, only, now, width, false)
  return <ui.Box flexDirection="column">{sortRuns(runs).map(r => runCard(ui, press, r, now, width))}</ui.Box>
}

function stepTime(s: Step, now: number): string {
  if (!s.startedAt) return ''
  if (s.status === 'running') return fmt((now - s.startedAt) / 1000)
  return s.endedAt ? fmt((s.endedAt - s.startedAt) / 1000) : ''
}

function runDetail(ui: Kit, press: Press, r: Run, now: number, width: number) {
  const tone = r.status === 'failed' ? C.coral : r.status === 'passed' ? C.mint : C.purple
  const finished = r.status === 'passed' || r.status === 'failed'
  const status = [fmt(elapsed(r, now)), r.kind, r.target, finished && r.credits !== undefined ? `${Math.round(r.credits * 10) / 10} credits` : ''].filter(Boolean).join(' · ')
  const failing = r.status === 'failed' ? currentStep(r) : undefined
  const kind = kindLine(r)
  return (
    <ui.Box flexDirection="column">
      <ui.Box flexDirection="row" gap={1}>
        <ui.Button key="back" label="‹ Runs" plain dimColor onPress={() => press('back')} />
        <ui.Text bold>{cut(r.label, width - 10)}</ui.Text>
      </ui.Box>
      <ui.Box flexDirection="row" gap={1}>
        <ui.Text color={tone} bold>
          {r.status === 'pending' ? 'waiting' : r.status}
        </ui.Text>
        <ui.Text dimColor>{r.status === 'pending' ? '' : status}</ui.Text>
      </ui.Box>
      {r.newer ? <ui.Text dimColor>this kane-cli is newer than the mod: step detail is not read</ui.Text> : null}
      {r.waiting ? fact(ui, 'asks', r.waiting, C.orange) : null}
      {r.skipped ? <ui.Text dimColor>{`${r.skipped} line${r.skipped === 1 ? '' : 's'} of its stream could not be read and ${r.skipped === 1 ? 'was' : 'were'} skipped`}</ui.Text> : null}
      <ui.Text> </ui.Text>
      {r.status === 'failed' && r.failure?.why ? fact(ui, 'why', r.failure.why) : null}
      {r.status === 'failed' && kind ? fact(ui, 'kind', kind) : null}
      {r.status === 'failed' && r.failure?.where ? fact(ui, 'where', r.failure.where) : null}
      {r.status === 'failed' ? <ui.Text> </ui.Text> : null}
      {r.steps.map((s, i) => {
        if (r.kind === 'run' && s.status === 'pending') return null
        const open = s.status === 'running' || s === failing
        return (
          <ui.Box key={`step-${i}`} flexDirection="column">
            <ui.Box flexDirection="row" gap={1}>
              {glyph(ui, s.status)}
              <ui.Box flexShrink={1}>
                <ui.Text bold={open} dimColor={s.status === 'pending'}>
                  {s.text || (s.status === 'running' ? 'working…' : `step ${i + 1}`)}
                </ui.Text>
              </ui.Box>
              <ui.Text dimColor>{stepTime(s, now)}</ui.Text>
            </ui.Box>
            {open ? (
              <ui.Box flexDirection="column" paddingLeft={4}>
                {s.think ? fact(ui, 'think', s.think) : null}
                {s.act ? fact(ui, 'act', s.act) : null}
                {(s.checks ?? []).map(c => fact(ui, 'check', `${c.ok ? '✓' : '✗'} ${c.text}`, c.ok ? C.mint : C.coral))}
              </ui.Box>
            ) : null}
          </ui.Box>
        )
      })}
      {finished && r.sessionDir ? <ui.Text> </ui.Text> : null}
      {finished && r.sessionDir ? <ui.Button key="evidence" label="Open evidence" variant="primary" onPress={() => press(`evidence:${r.id}`)} /> : null}
    </ui.Box>
  )
}

function offerView(ui: Kit, press: Press, o: Offer | null, change: Change | null, now: number) {
  const files = o?.files ?? change?.files ?? []
  const saved = o?.saved ?? []
  const hasDraft = !!(o && (o.drafting || o.objective || o.note))
  return (
    <ui.Box flexDirection="column">
      <ui.Box flexDirection="row" gap={1}>
        <ui.Button key="back" label="‹ Runs" plain dimColor onPress={() => press('back')} />
        <ui.Text bold>Test this change</ui.Text>
      </ui.Box>
      <ui.Text color={C.orange}>{change ? '⚠ This change has not been tested' : 'A kane-cli run has covered this change'}</ui.Text>
      <ui.Text> </ui.Text>
      {files.slice(0, 8).map((f, i) => fact(ui, i === 0 ? 'changed' : '', f.startsWith(`${projectDir}/`) ? f.slice(projectDir.length + 1) : f))}
      {files.length > 8 ? <ui.Text dimColor>{`        +${files.length - 8} more`}</ui.Text> : null}
      <ui.Text> </ui.Text>
      {hasDraft ? (
        <ui.Box flexDirection="column">
          <ui.Text bold>Suggested objective</ui.Text>
          {o?.drafting ? <ui.Text dimColor>Claude is drafting one…</ui.Text> : o?.objective ? <ui.Text>{o.objective}</ui.Text> : <ui.Text dimColor>{o?.note ?? ''}</ui.Text>}
          <ui.Text> </ui.Text>
        </ui.Box>
      ) : null}
      {saved.length ? (
        <ui.Box flexDirection="column">
          <ui.Text bold>Saved tests that touch this</ui.Text>
          {saved.slice(0, 4).map(t => {
            const last = o?.last?.[t]
            return (
              <ui.Box key={`saved-${t}`} flexDirection="row" gap={1}>
                <ui.Box flexShrink={1}>
                  <ui.Text dimColor>{last ? `${t} · last ${last.status === 'passed' ? '✓' : '✗'} ${ago(now - last.at)}` : t}</ui.Text>
                </ui.Box>
                <ui.Button key={`saved-run-${t}`} label="Run it" onPress={() => press(`saved:${t}`)} />
              </ui.Box>
            )
          })}
          <ui.Text> </ui.Text>
        </ui.Box>
      ) : null}
      <ui.Box flexDirection="row" gap={1}>
        {o?.objective ? <ui.Button key="offer-run" label="Run the objective" variant="primary" onPress={() => press('offer-run')} /> : null}
        {!hasDraft ? <ui.Button key="offer-draft" label="Draft a new objective" onPress={() => press('offer-draft')} /> : null}
        <ui.Button key="offer-skip" label="Not now" onPress={() => press('offer-skip')} />
      </ui.Box>
    </ui.Box>
  )
}

function assureView(ui: Kit, press: Press, a: Assurance, now: number) {
  if (a.state === 'unknown') return <ui.Text dimColor>Reading the requirement store…</ui.Text>
  if (a.state === 'none') {
    return (
      <ui.Box flexDirection="column" borderStyle="round" borderColor={C.yellow} paddingX={1}>
        <ui.Text color={C.yellow} bold>
          Assurance is not set up
        </ui.Text>
        <ui.Text dimColor>Assurance turns a requirement into use cases, designs tests for them, and tracks which ones a real run has proven.</ui.Text>
        <ui.Text> </ui.Text>
        <ui.Text dimColor>○ ingest ── ○ extract ── ○ design ── ○ prove</ui.Text>
        <ui.Text> </ui.Text>
        <ui.Button key="setup" label="Set it up with Claude" variant="primary" onPress={() => press('setup')} />
      </ui.Box>
    )
  }
  const pct = (n: number | undefined) => (n === undefined ? '   –' : `${String(n).padStart(3)}%`)
  const debtLine = [a.failing ? `${a.failing} failing` : '', a.blocked ? `${a.blocked} blocked` : '', a.lastRunAt ? `run ${ago(now - a.lastRunAt)}` : a.provenPct === undefined ? 'nothing run yet' : ''].filter(Boolean).join(' · ')
  return (
    <ui.Box flexDirection="column">
      <ui.Box flexDirection="row" gap={1}>
        <ui.Text dimColor>designed</ui.Text>
        {item(ui, bar(24, a.designedPct / 100, C.yellow))}
        <ui.Text color={C.yellow} bold>{`${a.designedPct}%`}</ui.Text>
      </ui.Box>
      <ui.Box flexDirection="row" gap={1}>
        <ui.Text dimColor>proven  </ui.Text>
        {item(ui, bar(24, (a.provenPct ?? 0) / 100, C.yellow))}
        <ui.Text color={C.yellow} bold>
          {a.provenPct === undefined ? '–' : `${a.provenPct}%`}
        </ui.Text>
      </ui.Box>
      {debtLine ? <ui.Text dimColor>{debtLine}</ui.Text> : null}
      <ui.Text> </ui.Text>
      {a.useCases.map(u => (
        <ui.Box key={`uc-${u.id}`} flexDirection="column" borderStyle="round" borderColor={C.dim} paddingX={1}>
          <ui.Box flexDirection="row" gap={1}>
            <ui.Text bold>{u.id}</ui.Text>
            {debt(u).map(s => text(ui, s))}
          </ui.Box>
          <ui.Box flexDirection="row" gap={1}>
            <ui.Text dimColor>designed</ui.Text>
            {item(ui, bar(6, u.designed / 100, C.yellow))}
            <ui.Text>{pct(u.designed)}</ui.Text>
            <ui.Text dimColor>proven</ui.Text>
            {item(ui, bar(6, (u.proven ?? 0) / 100, C.yellow))}
            <ui.Text>{pct(u.proven)}</ui.Text>
          </ui.Box>
        </ui.Box>
      ))}
    </ui.Box>
  )
}

// ── reading kane-cli ─────────────────────────────────────────────────────

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'Kane', columns: 58, rows: 28 })
}

const modeOf = (m: '' | AfterChange): AfterChange => (m === '' ? setting : m)

async function alive($: EngineInterface, pid: number | undefined): Promise<boolean> {
  if (!pid) return false
  const r = await $.process.run(['kill', '-0', String(pid)], { timeoutMs: 3000 }).catch(() => undefined)
  return r?.exitCode === 0
}

/** The text a file gained since the last read, as whole lines. */
async function readNew($: EngineInterface, w: Watch): Promise<string[]> {
  const st = await $.fs.stat(w.path).catch(() => undefined)
  if (!st || st.size <= w.bytes) return []
  let chunk: string
  if (st.size > MAX_READ) {
    const r = await $.process.run(['tail', '-c', `+${w.bytes + 1}`, w.path], { timeoutMs: 10_000 }).catch(() => undefined)
    if (!r || r.exitCode !== 0) return []
    chunk = r.stdout
  } else {
    const all = await $.fs.read(w.path).catch(() => undefined)
    if (all === undefined) return []
    chunk = afterBytes(all, w.bytes)
  }
  w.bytes += utf8Len(chunk)
  const { lines, rest } = splitLines(w.rest + chunk)
  w.rest = rest
  return lines
}

/** The label Claude's own command gives a run that started just now in this project. */
function claimCommand(surface: Kind, started: number): string | undefined {
  const c = [...commands].reverse().find(x => !x.used && x.surface === surface && started >= x.at - 5_000 && started - x.at < 120_000)
  if (!c) return undefined
  c.used = true
  return c.label
}

/** Applies one file's new lines to the runs; reports the runs that just ended. */
function applyLines(runs: Run[], w: Watch, lines: readonly string[], now: number): { runs: Run[]; ended: Run[] } {
  const ended: Run[] = []
  const id = w.parent ?? w.id
  let i = runs.findIndex(r => r.id === id)
  if (i === -1) return { runs, ended }
  let next = [...runs]
  for (const l of lines) {
    const a = adapt(l, now)
    if (a.bad) {
      const at = next.findIndex(r => r.id === id)
      if (at >= 0 && !w.member) next[at] = { ...next[at]!, skipped: (next[at]!.skipped ?? 0) + 1 }
    }
    for (const ev of a.events) {
      const before = next[i]!
      const after = w.member ? foldMember(before, w.member, ev) : fold(before, ev)
      next[i] = after
      if (!w.member && ev.k === 'memberStart' && ev.logPath && !watches.has(ev.logPath)) {
        watches.set(ev.logPath, { id: ev.logPath, path: ev.logPath, bytes: 0, rest: '', done: false, member: ev.path, parent: id })
      }
      // A member that ended is read once more (its last lines may hold the failure), then left.
      if (!w.member && ev.k === 'memberEnd' && ev.logPath) {
        const m = watches.get(ev.logPath)
        if (m) m.closing = true
        else watches.set(ev.logPath, { id: ev.logPath, path: ev.logPath, bytes: 0, rest: '', done: false, member: ev.path, parent: id, closing: true })
      }
      if (terminal(before, ev)) {
        w.done = true
        ended.push(after)
      }
    }
  }
  i = next.findIndex(r => r.id === id)
  return { runs: next, ended }
}

function terminal(run: Run, ev: Ev): boolean {
  if (ev.k === 'suiteDone' || ev.k === 'mdDone') return true
  return ev.k === 'runEnd' && run.kind === 'run'
}

/** Once a second: new live runs from their pointers, new lines from every file still being followed. */
async function poll($: EngineInterface) {
  if (polling || !activeDir || !projectDir) return
  polling = true
  try {
    const now = await $.clock.now()
    let runs = await read($, runsAtom)
    let changed = false
    const ended: Run[] = []
    const listing = await $.fs.list(activeDir).catch(() => [])
    const present = new Set(listing.map(e => e.name))
    for (const e of listing) {
      if (!e.name.endsWith('.json') || seenPointers.has(e.name)) continue
      seenPointers.add(e.name)
      const p = parsePointer((await $.fs.read(`${activeDir}/${e.name}`).catch(() => '')) ?? '', now)
      if (!p || !inside(p.cwd, projectDir) || !(await alive($, p.pid))) continue
      runs = startWatch(runs, p, e.name)
      changed = true
    }
    // Members first, so a suite's end reads its members' last lines; a member a suite names now is read now too.
    const visited = new Set<Watch>()
    const pending = () => [...watches.values()].filter(w => !w.done && !visited.has(w)).sort((a, b) => Number(!a.member) - Number(!b.member))
    for (let w = pending()[0]; w; w = pending()[0]) {
      visited.add(w)
      const lines = await readNew($, w)
      if (lines.length) {
        const r = applyLines(runs, w, lines, now)
        runs = r.runs
        ended.push(...r.ended)
        changed = true
      }
      if (w.closing) w.done = true
      // A killed kane-cli leaves no terminal line: once its pointer is gone and its pid with it, the run is over.
      if (!w.done && !w.member && w.pointer && !present.has(w.pointer) && !(await alive($, w.pid))) {
        w.done = true
        runs = runs.map(r => (r.id === w.id && (r.status === 'running' || r.status === 'pending') ? { ...r, status: 'failed' as const, endedAt: now, failure: r.failure ?? { why: 'kane-cli exited before it reported a result' } } : r))
        const r = runs.find(x => x.id === w.id)
        if (r) ended.push(r)
        changed = true
      }
    }
    for (const [k, w] of watches) if (w.done) watches.delete(k)
    if (changed) await update($, runsAtom, () => runs)
    for (const r of ended) await finished($, r)
    if (runs.some(r => r.status === 'running' || r.status === 'pending')) await update($, tickAtom, n => n + 1)
  } finally {
    polling = false
  }
}

function startWatch(runs: Run[], p: Pointer, pointer: string): Run[] {
  const id = p.sessionDir
  const label = claimCommand(p.surface, p.started)
  const run = newRun(id, p.surface, p.sessionDir, p.started, { pid: p.pid, cwd: p.cwd, ...(label ? { label, labelRank: RANK.command } : {}) })
  // A reload follows the file again from its start, replacing what the last module folded.
  watches.set(id, { id, path: `${p.sessionDir}/events.ndjson`, pointer, pid: p.pid, bytes: 0, rest: '', done: false })
  const keep = runs.find(r => r.id === id)
  const fresh = keep ? { ...run, label: keep.labelRank && keep.labelRank >= RANK.command ? keep.label : run.label, labelRank: Math.max(keep.labelRank ?? 0, run.labelRank ?? 0) } : run
  return [...runs.filter(r => r.id !== id), fresh]
}

/** A run reached its end: remember it, refresh assurance, and clear a change it covered. */
async function finished($: EngineInterface, r: Run) {
  if (r.status !== 'passed' && r.status !== 'failed') return
  const entry: HistoryEntry = { label: r.label, status: r.status, at: r.endedAt ?? r.startedAt, where: r.failure?.where }
  await update($, lastAtom, () => entry)
  const all = await recent($)
  all[projectDir] = [entry, ...(all[projectDir] ?? [])].slice(0, 10)
  await $.store.set(RECENT, all).catch(() => undefined)
  const change = await read($, changeAtom)
  if (change && r.startedAt > change.lastAt) {
    await update($, changeAtom, () => null)
    await update($, offerAtom, () => null)
  }
  await refreshAssurance($)
}

async function refreshAssurance($: EngineInterface) {
  if (!projectDir) return
  const has = await $.fs.exists(`${projectDir}/.context`).catch(() => false)
  if (!has) {
    await update($, assuranceAtom, () => ({ state: 'none' }) as Assurance)
    return
  }
  const r = await $.process.run([...kane, 'cover', 'gaps', '--json'], { cwd: projectDir, timeoutMs: 30_000 }).catch(() => undefined)
  if (!r) return
  if (r.exitCode !== 0 && /no context store/i.test(`${r.stderr}${r.stdout}`)) {
    await update($, assuranceAtom, () => ({ state: 'none' }) as Assurance)
    return
  }
  const a = parseCoverGaps(r.stdout)
  if (a.state === 'ready') await update($, assuranceAtom, () => a)
}

/** The last results per project. Its own key: v1 of this plugin kept a list under `history` in the same store. */
const RECENT = 'recentByProject'

async function recent($: EngineInterface): Promise<Record<string, HistoryEntry[]>> {
  const v = await $.store.get(RECENT).catch(() => undefined)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, HistoryEntry[]>) : {}
}

async function loadLast($: EngineInterface) {
  const all = await recent($)
  const last = all[projectDir]?.[0]
  if (last) await update($, lastAtom, () => last)
}

// ── after Claude changes code ────────────────────────────────────────────

async function ignored($: EngineInterface, path: string): Promise<boolean> {
  const r = await $.process.run(['git', 'check-ignore', '-q', path], { cwd: projectDir, timeoutMs: 3000 }).catch(() => undefined)
  return r?.exitCode === 0
}

async function noteEdit($: EngineInterface, path: string) {
  if (!path || !inside(path, projectDir) || !isTrackedEdit(path.slice(projectDir.length + 1)) || (await ignored($, path))) return
  const now = await $.clock.now()
  await update($, changeAtom, c => (c ? { ...c, files: c.files.includes(path) ? c.files : [...c.files, path], lastAt: now } : { files: [path], firstAt: now, lastAt: now, shown: false }))
}

/** The files a Bash command changed, as Claude Code reports them beside its output. */
function bashChanges(result: unknown): string[] {
  const diff = (result as { bashEditDiff?: { changedFiles?: unknown; files?: unknown } } | undefined)?.bashEditDiff
  if (!diff) return []
  if (Array.isArray(diff.changedFiles)) return diff.changedFiles.filter((f): f is string => typeof f === 'string')
  return Array.isArray(diff.files) ? diff.files.map(f => (f as { filePath?: unknown }).filePath).filter((f): f is string => typeof f === 'string') : []
}

async function savedTests($: EngineInterface): Promise<{ name: string; text: string }[]> {
  const dir = `${projectDir}/.testmuai/tests`
  const list = await $.fs.list(dir).catch(() => [])
  const out: { name: string; text: string }[] = []
  for (const e of list.filter(x => x.name.endsWith('_test.md')).slice(0, 40)) {
    out.push({ name: e.name, text: (await $.fs.read(`${dir}/${e.name}`).catch(() => '')) ?? '' })
  }
  return out
}

async function openOffer($: EngineInterface) {
  const change = await read($, changeAtom)
  if (!change) return
  const files = change.files
  await update($, viewAtom, v => ({ ...v, tab: 'runs' as const, open: 'offer' }))
  await openPane($)
  const tests = await savedTests($)
  const saved = savedTestsFor(files, tests)
  const history = (await recent($))[projectDir] ?? []
  const last: Record<string, HistoryEntry> = {}
  for (const name of saved) {
    const hit = history.find(h => h.label === name || h.label.endsWith(`/${name}`))
    if (hit) last[name] = hit
  }
  await update($, offerAtom, () => ({ files, drafting: false, saved, url: startUrl(tests), last }))
  // A saved test that covers the change comes first; Claude drafts a new objective only when none does.
  if (saved.length === 0) await draftObjective($)
}

/** Claude writes the objective from the changed paths and their diff. */
async function draftObjective($: EngineInterface) {
  const o = await read($, offerAtom)
  if (!o) return
  await update($, offerAtom, x => (x ? { ...x, drafting: true, note: undefined } : x))
  const rel = o.files.map(f => (f.startsWith(`${projectDir}/`) ? f.slice(projectDir.length + 1) : f))
  const d = await $.process.run(['git', 'diff', '--', ...rel], { cwd: projectDir, timeoutMs: 10_000 }).catch(() => undefined)
  const diff = (d?.stdout ?? '').slice(0, 8000)
  const reply = await $.model.fork({ prompt: draftPrompt(rel, diff) }).catch(() => undefined)
  const objective = reply?.isAnswered ? objectiveFrom(reply.text) : ''
  await update($, offerAtom, x => (x ? { ...x, drafting: false, objective: objective || undefined, note: objective ? undefined : `No draft: ${reply && !reply.isAnswered ? reply.reason : 'Claude did not answer'}.` } : x))
}

function autoInstruction(files: readonly string[], saved: readonly string[]): string {
  const rel = files.map(f => (f.startsWith(`${projectDir}/`) ? f.slice(projectDir.length + 1) : f))
  const reuse = saved.length ? ` A saved test may already cover it: ${saved.slice(0, 3).map(s => `.testmuai/tests/${s}`).join(', ')} (kane-cli testmd run <file> --agent --headless).` : ''
  return `kane-qe: you changed ${rel.join(', ')} and no kane-cli run has tested it yet. Before you finish, test the change in a browser with kane-cli (kane-cli run "<what a user does and what must be true>" --agent --headless).${reuse} Then report the result.`
}

// ── actions ──────────────────────────────────────────────────────────────

async function act($: EngineInterface, a: string) {
  const at = a.indexOf(':')
  const k = at < 0 ? a : a.slice(0, at)
  const arg = at < 0 ? '' : a.slice(at + 1)
  if (k === 'open') await openPane($)
  else if (k === 'tab') {
    await update($, viewAtom, v => ({ ...v, tab: arg === 'assure' ? ('assure' as const) : ('runs' as const), open: '' }))
    await openPane($)
  } else if (k === 'run') await update($, viewAtom, v => ({ ...v, open: arg, tab: 'runs' as const }))
  else if (k === 'back') await update($, viewAtom, v => ({ ...v, open: '' }))
  else if (k === 'offer') await openOffer($)
  else if (k === 'offer-draft') await draftObjective($)
  else if (k === 'offer-run') {
    const o = await read($, offerAtom)
    if (!o?.objective) return
    await update($, viewAtom, v => ({ ...v, open: '' }))
    await update($, offerAtom, () => null)
    const url = o.url ? ` --url ${o.url}` : ''
    const hint = o.url ? '' : ' kane-cli needs a start page: pass --url with this app\'s URL unless `kane-cli config show` has a default_url.'
    void $.prompt.submit({ text: `Test my last change with kane-cli: kane-cli run "${o.objective.replace(/"/g, "'")}"${url} --agent --headless.${hint} Then report the result.` }).catch(() => undefined)
  } else if (k === 'saved') {
    await update($, viewAtom, v => ({ ...v, open: '' }))
    await update($, offerAtom, () => null)
    void $.prompt.submit({ text: `Test my last change with the saved kane-cli test: kane-cli testmd run .testmuai/tests/${arg} --agent --headless. Then report the result.` }).catch(() => undefined)
  } else if (k === 'offer-skip') {
    await update($, offerAtom, () => null)
    await update($, changeAtom, c => (c ? { ...c, shown: false } : c))
    await update($, viewAtom, v => ({ ...v, open: '' }))
  } else if (k === 'evidence') {
    const r = leaves(await read($, runsAtom)).concat(await read($, runsAtom)).find(x => x.id === arg)
    const dir = r?.sessionDir || arg
    void $.prompt.submit({ text: `Open the evidence for the kane-cli run in ${dir}.` }).catch(() => undefined)
  } else if (k === 'setup') {
    void $.prompt.submit({
      text: 'Set up kane-cli assurance for this project: ask me for the requirement (a PRD file, a Jira, Confluence or Linear link, or a web page), ingest it with kane-cli, extract the use cases and design tests (use --mode agent), then show me the coverage with kane-cli cover gaps.',
    }).catch(() => undefined)
  }
}

// ── the mascot's animation ───────────────────────────────────────────────

/** Where the mascot is an image, step its frame by redrawing the sites that show it. */
async function pulse($: EngineInterface) {
  if (!thinking || !remote) return
  frame += 1
  await update($, tickAtom, n => n + 1)
}

function paint($: EngineInterface) {
  if (!thinking || sites.size === 0) return
  if (!remote) frame += 1
  const cells = rasterCells(pixelFrame(poseAt(true, frame)))
  for (const requestId of sites) void $.ui.blit({ requestId, key: 'mascot', cells }).catch(() => sites.delete(requestId))
}

// ── the mod ──────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const o = options as Record<string, unknown>
  setting = o.afterChange === 'auto' || o.afterChange === 'off' ? o.afterChange : 'offer'
  kane = String(o.kaneCommand ?? 'kane-cli').trim().split(/\s+/).filter(Boolean)
  if (kane.length === 0) kane = ['kane-cli']

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    projectDir = String((e as { cwd?: unknown }).cwd ?? '').replace(/\/$/, '')
    const home = await $.env.get('HOME').catch(() => undefined)
    if (home) activeDir = `${home}/.testmuai/kaneai/sessions/active`
    await $.command.register({ name: 'kane', description: 'Kane: open the runs pane; /kane assurance; /kane auto | ask | off for changes', argumentHint: '[assurance | auto | ask | off]' })
    $.clock.every(1000, () => void poll($).catch(() => undefined))
    $.clock.every(STEP_MS, () => paint($))
    $.clock.every(STEP_MS, () => void pulse($).catch(() => undefined))
    void loadLast($).catch(() => undefined)
    void refreshAssurance($).catch(() => undefined)
    return started
  })

  on('command.run', { command: 'kane' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '' || arg === 'runs') {
      await act($, 'tab:runs')
      return { text: 'Kane pane opened. It follows every kane-cli run in this folder by itself.' }
    }
    if (arg === 'assurance' || arg === 'assure') {
      await refreshAssurance($)
      await act($, 'tab:assure')
      return { text: 'Kane: assurance for this project.' }
    }
    if (arg === 'auto' || arg === 'ask' || arg === 'off') {
      const mode: AfterChange = arg === 'ask' ? 'offer' : arg
      await update($, modeAtom, () => mode)
      return { text: `Kane: after Claude changes code, ${mode === 'auto' ? 'Claude tests it before it finishes' : mode === 'offer' ? 'the band offers to test it' : 'nothing happens'} (this session).` }
    }
    return { text: 'Kane: /kane opens the pane · /kane assurance · /kane auto | ask | off sets what happens after Claude changes code.' }
  })

  on('tool.call', async ($, e, next) => {
    const now = await $.clock.now().catch(() => 0)
    if (e.tool === 'Bash') {
      const named = labelFromCommand(String(e.command ?? ''))
      if (named) {
        commands.push({ ...named, at: now, used: false })
        if (commands.length > 20) commands.shift()
      }
    }
    const result = await next(e)
    const ok = !('deny' in result && result.deny) && !result.isError
    if (ok && (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit')) {
      const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
      void noteEdit($, String(input.file_path ?? input.notebook_path ?? '')).catch(() => undefined)
    }
    // Claude also changes code from the shell (sed, printf > file): the Bash result lists what it changed.
    if (ok && e.tool === 'Bash') {
      for (const path of bashChanges((result as { result?: unknown }).result)) void noteEdit($, path).catch(() => undefined)
    }
    return result
  })

  // The turn is ending: an untested change is offered (offer), or Claude is held once to test it (auto).
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const change = await read($, changeAtom)
    const mode = modeOf(await read($, modeAtom))
    if (!change || mode === 'off' || result.block) return result
    if (mode === 'offer') {
      if (!change.shown) await update($, changeAtom, c => (c ? { ...c, shown: true } : c))
      return result
    }
    if ((e as { stop_hook_active?: boolean }).stop_hook_active || heldFor === change.lastAt) return result
    heldFor = change.lastAt
    const saved = savedTestsFor(change.files, await savedTests($).catch(() => []))
    return { ...result, block: autoInstruction(change.files, saved) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const runs = await read($, runsAtom)
    await read($, tickAtom)
    const change = await read($, changeAtom)
    const mode = modeOf(await read($, modeAtom))
    const now = await $.clock.now()
    const shownChange = change && mode !== 'off' && (mode === 'auto' || change.shown) ? { files: change.files.length, mode: mode === 'auto' ? ('auto' as const) : ('offer' as const) } : undefined
    const model = band(runs, { assurance: await read($, assuranceAtom), change: shownChange, last: await read($, lastAtom), now, columns: e.props.bodyColumns - RASTER.columns - 1 })
    thinking = model.think
    const table = $.ui.resolve(e)
    if (e.surface === 'terminal') sites.add(e.requestId)
    else remote = true
    const press: Press = a => void act($, a).catch(() => undefined)
    return (
      <table.Box flexDirection="row" gap={1}>
        {mascot(table, e.surface, model.think, frame)}
        <table.Box flexDirection="column">{model.rows.map(r => line(table, press, r))}</table.Box>
      </table.Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await read($, viewAtom)
    await read($, tickAtom)
    const runs = await read($, runsAtom)
    const now = await $.clock.now()
    const all = leaves(runs)
    const c = tally(all)
    const width = Math.max(30, e.props.bodyColumns - 2)
    const table = $.ui.resolve(e)
    const ui: Kit = table
    if (e.surface === 'terminal') sites.add(e.requestId)
    else remote = true
    const press: Press = a => void act($, a).catch(() => undefined)
    const opened = all.find(r => r.id === v.open) ?? runs.find(r => r.id === v.open)
    let body
    if (v.tab === 'assure') body = assureView(ui, press, await read($, assuranceAtom), now)
    else if (v.open === 'offer') body = offerView(ui, press, await read($, offerAtom), await read($, changeAtom), now)
    else if (opened?.kind === 'testrun' && opened.members) body = suiteView(ui, press, opened, now, width, true)
    else if (opened) body = runDetail(ui, press, opened, now, width)
    else body = runsView(ui, press, runs, now, width, await read($, lastAtom))
    return (
      <ui.Box flexDirection="column">
        <ui.Box flexDirection="row" gap={1}>
          {mascot(table, e.surface, c.running > 0, frame)}
          <ui.Box flexDirection="column">
            <ui.Text color={C.purple} bold>
              kane
            </ui.Text>
            <ui.Text dimColor>{c.running > 0 ? `${c.running} running` : c.total > 0 ? `${c.passed} passed · ${c.failed} failed` : 'idle'}</ui.Text>
            <ui.Box flexDirection="row" gap={1}>
              <ui.Button key="tab-runs" label="Runs" variant={v.tab === 'runs' ? 'primary' : 'secondary'} onPress={() => press('tab:runs')} />
              <ui.Button key="tab-assure" label="Assurance" variant={v.tab === 'assure' ? 'primary' : 'secondary'} onPress={() => press('tab:assure')} />
            </ui.Box>
          </ui.Box>
        </ui.Box>
        <ui.Text> </ui.Text>
        {body}
      </ui.Box>
    )
  })
}
