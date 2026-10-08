export type KaneTab = 'run' | 'insights' | 'tests' | 'assure' | 'history' | 'setup'

export type KaneRunKind = 'run' | 'testmd' | 'testrun'

export type KaneRunStatus = 'running' | 'passed' | 'failed' | 'error' | 'cancelled'

export type KaneStep = {
  n: number
  status: string
  text: string
  /** A suite member's live progress: its latest step, from the member's own events. */
  detail?: string
  /** A suite member's own event log (`log_path`), for following it from outside. */
  log?: string
}

export type KaneRun = {
  id: string
  kind: KaneRunKind
  label: string
  source: 'pane' | 'model' | 'command' | 'external'
  /** For a mirrored run: who launched it (kane-cli's host_agent) and where. */
  hostAgent?: string
  cwd?: string
  /** The model's tool call this run answers, so its transcript row can draw it. */
  callId?: string
  /** The kane-cli arguments it ran with, for rerun and the CI command. */
  args?: string[]
  status: KaneRunStatus
  startedAt: number
  endedAt?: number
  pid?: number
  steps: KaneStep[]
  progress?: string
  warnings: string[]
  errors: string[]
  stderrTail: string[]
  oneLiner?: string
  summary?: string
  reason?: string
  durationS?: number
  credits?: number
  testUrl?: string
  sessionDir?: string
  runDir?: string
  finalState?: Record<string, unknown>
  exitCode?: number
  /** A `--remote` suite: the HyperExecute job and the grid device it got. */
  remoteJob?: { id?: string; url?: string; log?: string }
  device?: string
}

export type KaneHistoryEntry = {
  /** What the evidence pack said, once read: who owns the result. */
  insight?: { kind: AttributionKind; headline: string; signals: number }
  vitals?: Record<string, number>
  id: string
  kind: KaneRunKind
  label: string
  status: KaneRunStatus
  oneLiner?: string
  durationS?: number
  credits?: number
  testUrl?: string
  sessionDir?: string
  endedAt: number
  rerun: string[]
}

export type KaneTest = {
  path: string
  name: string
  tags: string[]
  synced: boolean
  hasMeta: boolean
}

export type KaneTests = {
  isLoading: boolean
  error?: string
  items: KaneTest[]
}

export type KaneEnv = {
  isChecking: boolean
  isInstalled: boolean
  version?: string
  auth: 'ok' | 'none' | 'unreachable' | 'unknown'
  whoami?: string
  config: Record<string, string>
  balance?: string
  error?: string
}

/** An objective held back before it spends credits, with what to fix. */
export type KaneCoach = {
  objective: string
  url?: string
  headless: boolean
  hasNoCheck: boolean
  variables: string[]
}

export type KaneForm = {
  objective: string
  url: string
  tags: string
}


// ── insights read from a run's evidence pack ─────────────────────────

export type HttpIssue = {
  step: number
  status: number
  url: string
  isFirstParty: boolean
  /** A path or query carrying `undefined`, `null` or `NaN`: a client bug, not noise. */
  isSuspicious: boolean
}

export type StepInsight = {
  n: number
  kind: string
  status: string
  ms: number
  summary: string
  url?: string
  modelMs: number
  browserMs: number
  requests: number
  failedRequests: number
  httpIssues: HttpIssue[]
  consoleErrors: number
  /** First-party errors at this step no earlier step had logged (absent on readings from before it was counted). */
  consoleNew?: number
  /** Errors logged by other sites' scripts in the page (ad frames, trackers). */
  consoleThirdParty?: number
  consoleWarnings: number
  consoleSamples: string[]
  screenshot?: string
  isUnchanged: boolean
  isRelevant: boolean
  isCulprit: boolean
}

export type Verdict = {
  family?: string
  category?: string
  severity?: string
  confidence?: number
  title?: string
  rootCause?: string
  fix?: string
  relevantSteps: number[]
}

export type AttributionKind = 'product' | 'automation' | 'unclear' | 'signals' | 'clean' | 'unknown'

export type Attribution = {
  kind: AttributionKind
  headline: string
  evidence: string[]
}

export type RunInsights = {
  sessionDir: string
  pack?: string
  label: string
  status: string
  durationMs: number
  credits?: number
  /** kane's own reason line from run_end. */
  reason?: string
  host?: string
  environment?: string
  maxSteps?: number
  steps: StepInsight[]
  requests: number
  failedRequests: number
  p95Ms?: number
  httpIssues: HttpIssue[]
  consoleErrors: number
  consoleThirdParty?: number
  consoleWarnings: number
  verdict?: Verdict
  attribution: Attribution
  loopSignals: string[]
  modelMs: number
  browserMs: number
  vitals: Record<string, number>
  /** A passed check its own stored values disagree with ("differs" but both are "MacBook"). */
  contradictions?: string[]
}

export type KaneInsightView = 'timeline' | 'signals' | 'time'
export type KaneHistoryView = 'runs' | 'trends' | 'credits' | 'quality' | 'sites'

export type KaneFocus = {
  /** Picked by the person: a new run does not take Insights away from it. */
  isPinned?: boolean
  sessionDir?: string
  step?: number
  view: KaneInsightView
}

export type KaneInsightsEntry = { isLoading: boolean; error?: string; data?: RunInsights; /** The rules it was read under. */ version?: number }

export type KaneShot = {
  key: string
  isLoading: boolean
  png?: string
  jpg?: string
  error?: string
  /** The screenshot as half-block cells, for terminals without an image protocol (Warp, iTerm2). */
  preview?: { columns: number; rows: number; cells: string }
  /** kitty or Ghostty: the engine draws the PNG itself. */
  isPixelTerminal?: boolean
}

export type KaneCoverage = { isLoading: boolean; summary?: string[]; error?: string; checkedAt?: number }

// ── the assurance loop: requirements → use cases → designed tests → coverage

export type AssureQuestion = {
  id: string
  header?: string
  text: string
  risk?: string
  rationale?: string
  options: { label: string; detail?: string }[]
  /** 0-based, as kane sends it; `--answer` takes 1-based. */
  recommended?: number
  allowFreeText: boolean
}

/** One headless (`--mode agent`) assurance command as it streams. */
export type AssureJob = {
  id: string
  label: string
  argv: string[]
  verb?: string
  status: 'running' | 'complete' | 'paused' | 'refused' | 'error' | 'interrupted'
  activity: string[]
  messages: string[]
  credits?: number
  sid?: string
  resume?: string
  questions: AssureQuestion[]
  next: string[]
  errors: string[]
  committed: string[]
  /** Variables designed tests use that no variable file has a value for yet. */
  variables?: { file?: string; names: string[] }
  startedAt: number
  endedAt?: number
}

export type AssureSession = { sid: string; verb: string; pending: number; resume: string; expiresAt?: string; questions?: AssureQuestion[] }

export type KaneAssurance = {
  isLoading: boolean
  error?: string
  hasStore?: boolean
  sources: number
  useCases: number
  trusted: number
  derived: number
  stale: number
  nodes: { id: string; label: string; title: string; trust: string; fresh: string }[]
  sessions: AssureSession[]
  designPct?: number
  /** Share of acceptance criteria a run has actually proven (kane's execution facts). */
  provenPct?: number
  proven?: string
  /** When the newest run that coverage counts started (epoch ms). */
  provenAt?: number
  usecases: { id: string; title: string; risk?: string; pct?: number; pending: { why: string; cmd?: string }[] }[]
  job?: AssureJob
  checkedAt?: number
  graphPath?: string
  /** The requirement field: a path or a Jira / Confluence / Linear / web URL. */
  source: string
  /** Assurance ids (t-1 …) of the designed *_test.md files in this project. */
  designed?: string[]
}

// ── where suites run: this machine or the HyperExecute grid, web or a device

export type KaneDevice = { name: string; osVersions: string[] }
export type DoctorCheck = { ok: boolean; name: string; detail?: string; fix?: string }

export type KaneGrid = {
  where: 'local' | 'grid'
  target: 'web' | 'emulator' | 'simulator'
  device?: string
  osVersion?: string
  /** Narrows a long catalog: "iphone 15", "pixel", "17.5". */
  filter?: string
  devices: KaneDevice[]
  isLoading: boolean
  error?: string
  plugin: 'ok' | 'missing' | 'unknown' | 'checking'
  doctor?: { target: 'emulator' | 'simulator'; isLoading: boolean; checks: DoctorCheck[]; error?: string }
}

/** `evidence serve` for one pack: the hosted viewer reads it from a local port. */
export type KaneViewer = { pack: string; url?: string; isStarting: boolean; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'kane-qe': {
      tab: KaneTab
      run: KaneRun | null
      history: KaneHistoryEntry[]
      tests: KaneTests
      env: KaneEnv
      form: KaneForm
      flash: string
      coach: KaneCoach | null
      insights: Record<string, KaneInsightsEntry>
      focus: KaneFocus
      historyView: KaneHistoryView
      shot: KaneShot | null
      coverage: KaneCoverage
      assurance: KaneAssurance
      grid: KaneGrid
      viewer: KaneViewer | null
      /** Per test path: the last `testmd status` / `sync` reading. */
      testNotes: Record<string, string>
      /** Runs the model started, by tool_use_id, for their transcript cards. */
      cards: Record<string, KaneRun>
      /** Every run in flight right now, by id: this mod's, Claude's and ones started elsewhere. */
      live: Record<string, KaneRun>
      /** Set once this session's state is loaded; /clear resets state and with it this, so it reloads. */
      booted: boolean
    }
  }
}
