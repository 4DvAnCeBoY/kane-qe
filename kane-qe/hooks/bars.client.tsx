// A horizontal bar chart drawn on the terminal's own drawing thread: hover a
// row for its note, click (or ↑↓ then Enter) to pick it. Picks reach the hooks
// module as `ui.message` { type: 'pick', chart, id }.
import type { ClientModule } from 'claude-code'

type Bar = { id: string; label: string; value: number; color: string; valueText?: string; note?: string; mark?: string }
type Props = { chart: string; bars: Bar[]; selected?: string; unit?: string; hint?: string }
type State = { hover?: number; cursor?: number }

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

function blocks(width: number, ratio: number): string {
  const cells = Math.max(0, Math.min(1, ratio)) * width
  const full = Math.floor(cells)
  const rest = Math.round((cells - full) * 8)
  return '█'.repeat(full) + (rest >= 8 ? '█' : EIGHTHS[rest] ?? '')
}

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`
}

const Bars: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? {}
  const bars = props.bars
  const max = Math.max(1e-9, ...bars.map(b => b.value))
  const columns = Math.max(30, (surface.columns || 60) - 1)
  const labelW = Math.min(26, Math.max(8, Math.floor(columns * 0.34)))
  const valueW = Math.max(6, ...bars.map(b => (b.valueText ?? String(b.value)).length)) + 1
  const barW = Math.max(4, columns - labelW - valueW - 4)
  const active = state.hover ?? state.cursor
  const pick = (i: number) => {
    const bar = bars[i]
    if (bar) surface.post({ type: 'pick', chart: props.chart, id: bar.id })
  }

  surface.onPointer(e => {
    const i = e.y
    const inside = i >= 0 && i < bars.length
    if (e.type === 'leave') return surface.setState({ ...state, hover: undefined })
    if (e.type === 'move' && inside && i !== state.hover) surface.setState({ ...state, hover: i })
    if (e.type === 'down' && inside && e.button === 'left') {
      surface.setState({ ...state, cursor: i })
      pick(i)
    }
  })
  surface.onKey(e => {
    const at = state.cursor ?? 0
    if (e.key === 'down') surface.setState({ ...state, cursor: Math.min(bars.length - 1, at + 1), hover: undefined })
    else if (e.key === 'up') surface.setState({ ...state, cursor: Math.max(0, at - 1), hover: undefined })
    else if (e.key === 'return') pick(at)

    // Keys the chart does not use are the pane's hotkeys (tabs, views): hand them on.
    else surface.post({ type: 'key', key: e.key })
  })

  const shown = active !== undefined ? bars[active] : undefined
  return (
    <Box flexDirection="column">
      {bars.map((b, i) => {
        const isOn = i === active || b.id === props.selected
        return (
          <Box key={`b-${b.id}`} flexDirection="row">
            <Text color={isOn ? '#fbbf24' : undefined} bold={isOn}>{`${isOn ? '▸' : ' '}${b.mark ?? ' '}${fit(b.label, labelW - 2)} `}</Text>
            <Text color={b.color}>{blocks(barW, b.value / max).padEnd(barW)}</Text>
            <Text dimColor={!isOn}>{` ${(b.valueText ?? String(b.value)).padStart(valueW - 1)}`}</Text>
          </Box>
        )
      })}
      <Text dimColor wrap="wrap">
        {shown?.note ?? props.hint ?? 'Hover a bar for details · click or ↑↓ Enter to open'}
      </Text>
    </Box>
  )
}

export default Bars
