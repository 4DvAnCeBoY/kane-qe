// Per-step signals as a heat grid: one row per metric, one column per step,
// shaded by how much happened there. Hover a cell for its count; click it to
// select that step: `ui.message` { type: 'step', n }.
import type { ClientModule } from 'claude-code'

type Row = { name: string; values: number[]; rgb: [number, number, number] }
type Props = { steps: number[]; rows: Row[]; selected?: number }
type State = { hover?: { r: number; c: number } }

const BG: [number, number, number] = [28, 33, 45]

function hex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

function shade(rgb: [number, number, number], t: number): string {
  const k = t <= 0 ? 0 : 0.25 + 0.75 * Math.min(1, t)
  return hex([BG[0] + (rgb[0] - BG[0]) * k, BG[1] + (rgb[1] - BG[1]) * k, BG[2] + (rgb[2] - BG[2]) * k])
}

const Heat: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? {}
  const columns = Math.max(30, (surface.columns || 60) - 1)
  const nameW = 13
  const cellW = Math.max(3, Math.min(8, Math.floor((columns - nameW) / Math.max(1, props.steps.length))))
  const visible = Math.max(1, Math.floor((columns - nameW) / cellW))
  const steps = props.steps.slice(0, visible)

  const at = (x: number, y: number) => {
    const r = y - 1
    const c = Math.floor((x - nameW) / cellW)
    return r >= 0 && r < props.rows.length && c >= 0 && c < steps.length ? { r, c } : undefined
  }
  surface.onPointer(e => {
    const cell = at(e.x, e.y)
    if (e.type === 'leave') return surface.setState({})
    if (e.type === 'move' && (cell?.r !== state.hover?.r || cell?.c !== state.hover?.c)) surface.setState({ hover: cell })
    if (e.type === 'down' && cell && e.button === 'left') surface.post({ type: 'step', n: steps[cell.c] ?? 0 })
  })

  // Keys the grid does not use are the pane's hotkeys (tabs, views): hand them on.
  surface.onKey(e => surface.post({ type: 'key', key: e.key }))

  const hover = state.hover
  const hoverRow = hover ? props.rows[hover.r] : undefined
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text>{' '.repeat(nameW)}</Text>
        {steps.map(n => (
          <Text key={`h-${n}`} color={n === props.selected ? '#fbbf24' : undefined} dimColor={n !== props.selected}>
            {String(n).padStart(Math.ceil(cellW / 2) + 1).padEnd(cellW)}
          </Text>
        ))}
      </Box>
      {props.rows.map((row, r) => {
        const max = Math.max(1, ...row.values)
        return (
          <Box key={`r-${row.name}`} flexDirection="row">
            <Text dimColor>{row.name.slice(0, nameW - 1).padEnd(nameW)}</Text>
            {steps.map((_, c) => {
              const v = row.values[c] ?? 0
              const isOn = hover?.r === r && hover?.c === c
              return (
                <Text key={`c-${r}-${c}`} backgroundColor={shade(row.rgb, v / max)} color={isOn ? '#fbbf24' : '#e5e7eb'} bold={isOn}>
                  {(v ? String(v) : '·').padStart(Math.ceil((cellW + 1) / 2)).padEnd(cellW)}
                </Text>
              )
            })}
          </Box>
        )
      })}
      <Text dimColor wrap="wrap">
        {hover && hoverRow
          ? `Step ${steps[hover.c]} · ${hoverRow.name}: ${hoverRow.values[hover.c] ?? 0}  (click to select the step)`
          : 'Hover a cell for its count · click to select that step'}
      </Text>
    </Box>
  )
}

export default Heat
