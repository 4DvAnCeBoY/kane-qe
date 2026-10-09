export type Status = 'pending' | 'running' | 'passed' | 'failed'
export type Kind = 'run' | 'testmd' | 'testrun'

export type Check = { ok: boolean; text: string }

export type Step = {
  text: string
  status: Status
  startedAt?: number
  endedAt?: number
  think?: string
  act?: string
  checks?: Check[]
}

/** Failure facts, each taken from what kane-cli wrote (never guessed). */
export type Failure = { why: string; where?: string; category?: string; severity?: string; confidence?: number }

export type Run = {
  /** The session dir, or the member path inside a suite. */
  id: string
  label: string
  kind: Kind
  target?: string
  status: Status
  startedAt: number
  endedAt?: number
  steps: Step[]
  credits?: number
  failure?: Failure
  members?: Run[]
  sessionDir: string
  pid?: number
  cwd?: string
  /** A question kane-cli is waiting on (ask_user). */
  waiting?: string
  /** The stream's wire version is newer than this mod reads. */
  newer?: boolean
  /** Replayed after the fact (remote grid): not animated. */
  postHoc?: boolean
  /** Lines of its stream that were not JSON: skipped, and counted. */
  skipped?: number
  /** Where the label came from; a better source replaces a weaker one. */
  labelRank?: number
}

export type UseCase = { id: string; designed: number; proven?: number; stale: number; toDesign: number; toCover: number }

export type Assurance =
  | { state: 'unknown' }
  | { state: 'none' }
  | {
      state: 'ready'
      designedPct: number
      provenPct?: number
      failing?: number
      blocked?: number
      lastRunAt?: number
      useCases: UseCase[]
    }

export type AfterChange = 'offer' | 'auto' | 'off'

/** Files Claude edited that no kane-cli run has covered since. */
export type Change = { files: string[]; firstAt: number; lastAt: number; shown: boolean }

/** `url`: the app's start page, as the project's saved tests name it. */
export type Offer = { files: string[]; objective?: string; drafting: boolean; note?: string; saved: string[]; url?: string; last?: Record<string, HistoryEntry> }

export type View = {
  tab: 'runs' | 'assure'
  /** The run shown in detail, `offer` for the offer card, or empty for the list. */
  open: string
}

export type HistoryEntry = { label: string; status: 'passed' | 'failed'; at: number; where?: string }

declare module 'claude-code' {
  interface PluginState {
    'kane-qe': {
      runs: Run[]
      view: View
      tick: number
      assurance: Assurance
      change: Change | null
      offer: Offer | null
      /** `/kane auto|ask|off` for this session; empty uses the setting. */
      mode: '' | AfterChange
      last: HistoryEntry | null
    }
  }
}
