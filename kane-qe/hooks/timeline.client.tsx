// A run's steps as a waterfall: each bar starts where the steps before it
// ended and is as long as the step took, coloured by what the step did.
// Hover a row for the step's timing, network and console; click (or ↑↓ Enter)
// to select it: `ui.message` { type: 'step', n }.
import type { ClientModule } from 'claude-code'

type Step = {
  n: number
  kind: string
  status: string
  ms: number
  modelMs: number
  browserMs: number
  summary: string
  requests: number
  failedRequests: number
  http: string
  consoleErrors: number
  isCulprit: boolean
  isRelevant: boolean
  isUnchanged: boolean
}
type Props = { steps: Step[]; selected?: number }
type State = { hover?: number; cursor?: number }

const KIND: Record<string, string> = {
  navigate: '#60a5fa',
  type: '#a78bfa',
  click: '#34d399',
  wait: '#6b7280',
  analyze: '#f59e0b',
  assert: '#f87171',
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

const Timeline: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? {}
  const steps = props.steps
  const total = Math.max(1, steps.reduce((a, s) => a + s.ms, 0))
  const columns = Math.max(30, (surface.columns || 60) - 1)
  const head = 15 // "✗10 analyze   "
  const tail = 10 // " 137.3s ◆" plus a spare cell so a row never wraps
  const barW = Math.max(6, columns - head - tail)
  const active = state.hover ?? state.cursor ?? steps.findIndex(s => s.n === props.selected)
  const select = (i: number) => {
    const s = steps[i]
    if (s) surface.post({ type: 'step', n: s.n })
  }

  surface.onPointer(e => {
    const i = e.y
    const inside = i >= 0 && i < steps.length
    if (e.type === 'leave') return surface.setState({ ...state, hover: undefined })
    if (e.type === 'move' && inside && i !== state.hover) surface.setState({ ...state, hover: i })
    if (e.type === 'down' && inside && e.button === 'left') {
      surface.setState({ ...state, cursor: i })
      select(i)
    }
  })
  surface.onKey(e => {
    const at = state.cursor ?? Math.max(0, active)
    if (e.key === 'down') surface.setState({ ...state, cursor: Math.min(steps.length - 1, at + 1), hover: undefined })
    else if (e.key === 'up') surface.setState({ ...state, cursor: Math.max(0, at - 1), hover: undefined })
    else if (e.key === 'return') select(at)

    // Keys the chart does not use are the pane's hotkeys (tabs, views): hand them on.
    else surface.post({ type: 'key', key: e.key })
  })

  let before = 0
  const rows = steps.map((s, i) => {
    const start = Math.floor((before / total) * barW)
    const len = Math.max(1, Math.round((s.ms / total) * barW))
    before += s.ms
    const isOn = i === active
    const ok = s.status === 'passed' || s.status === 'done'
    const mark = s.isCulprit ? '◆' : s.isRelevant ? '◇' : s.isUnchanged ? '=' : ' '
    return (
      <Box key={`s-${s.n}`} flexDirection="row">
        <Text color={isOn ? '#fbbf24' : ok ? '#4ade80' : '#f87171'} bold={isOn}>{`${isOn ? '▸' : ok ? '✓' : '✗'}${String(s.n).padStart(2)} `}</Text>
        <Text dimColor={!isOn}>{s.kind.slice(0, 10).padEnd(11)}</Text>
        <Text>{' '.repeat(Math.min(start, barW - 1))}</Text>
        <Text color={KIND[s.kind] ?? '#9ca3af'}>{'█'.repeat(Math.min(len, barW - Math.min(start, barW - 1)))}</Text>
        <Text>{' '.repeat(Math.max(0, barW - Math.min(start, barW - 1) - Math.min(len, barW - Math.min(start, barW - 1))))}</Text>
        <Text dimColor={!isOn}>{` ${secs(s.ms).padStart(6)}`}</Text>
        <Text color={s.isCulprit ? '#f87171' : '#fbbf24'}>{` ${mark}`}</Text>
      </Box>
    )
  })

  const s = active >= 0 ? steps[active] : undefined
  return (
    <Box flexDirection="column">
      {rows}
      <Text dimColor>{'◆ culprit  ◇ relevant to the verdict  = page unchanged  ·  click or ↑↓ Enter to select'}</Text>
      {s ? (
        <Box flexDirection="column">
          <Text bold wrap="wrap">{`Step ${s.n} · ${s.kind} · ${secs(s.ms)} — ${s.summary}`}</Text>
          <Text dimColor wrap="wrap">
            {`model ${secs(s.modelMs)} · browser ${secs(s.browserMs)} · ${s.requests} requests${s.failedRequests ? ` (${s.failedRequests} failed)` : ''}${s.consoleErrors ? ` · ${s.consoleErrors} console errors` : ''}${s.http ? ` · ${s.http}` : ''}`}
          </Text>
        </Box>
      ) : (
        <Text dimColor>Hover a step for its timing, network and console.</Text>
      )}
    </Box>
  )
}

export default Timeline
