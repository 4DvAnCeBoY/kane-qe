import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { attribute, buildInsights, parseHar, parseRunLog, parseZipListing, repeatedExtractions, summarizeCoverage } from '../hooks/insights'
import type { EvidenceFiles } from '../hooks/insights'
import { bmpToRaster, fromBase64, toBase64 } from '../hooks/image'

/** A 2×2 top-down 24-bit BMP: red, green on top; blue, white below. */
function tinyBmp(): Uint8Array {
  const b = new Uint8Array(54 + 2 * 8)
  const v = new DataView(b.buffer)
  b[0] = 0x42
  b[1] = 0x4d
  v.setUint32(2, b.length, true)
  v.setUint32(10, 54, true)
  v.setUint32(14, 40, true)
  v.setInt32(18, 2, true)
  v.setInt32(22, -2, true)
  v.setUint16(26, 1, true)
  v.setUint16(28, 24, true)
  const px = [[0, 0, 255], [0, 255, 0], [255, 0, 0], [255, 255, 255]] // BGR
  px.forEach(([bl, g, r], i) => {
    const o = 54 + Math.floor(i / 2) * 8 + (i % 2) * 3
    b[o] = bl!
    b[o + 1] = g!
    b[o + 2] = r!
  })
  return b
}

const DIR = '/home/qa/.testmuai/kaneai/sessions/s1'
const PACK = `${DIR}/evidence/e1.evidence`
const T = 'tests/search-abc'

const LISTING = [
  ' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name',
  '--------  ------  ------- ---- ---------- ----- --------  ----',
  `  1000  Defl:N      500  50% 10-05-2026 21:59 aaaaaaa1  ${T}/steps/1-0-1/screenshot.jpg`,
  `  1000  Defl:N      500  50% 10-05-2026 21:59 bbbbbbb2  ${T}/steps/2-0-2/screenshot.jpg`,
  `  1000  Defl:N      500  50% 10-05-2026 21:59 bbbbbbb2  ${T}/steps/3-0-3/screenshot.jpg`,
  `  1000  Defl:N      500  50% 10-05-2026 21:59 bbbbbbb2  ${T}/steps/4-0-4/screenshot.jpg`,
].join('\n')

const RESULT = `status: failed\nduration_ms: 40000\nenvironment:\n  os: macOS\n  browser: Chrome\n  browser_version: '154'\n  resolution: 1920x1080\nsteps:\n${[
  [1, 'navigate', 'passed', 1000],
  [2, 'click', 'passed', 7000],
  [3, 'analyze', 'passed', 25000],
  [4, 'assert', 'failed', 0],
]
  .map(([n, k, st, ms]) => `  - id: 0-${n}\n    ordinal: ${n}\n    status: ${st}\n    kind: ${k}\n    duration_ms: ${ms}\n    action_id: x${n}`)
  .join('\n')}\n`

const STEPS = [
  { kind: 'navigate', status: 'passed', summary: 'navigate: Navigate to https://shop.test/', duration_ms: 3, url: 'https://shop.test/', ordinal: 1, id: '0-1' },
  { kind: 'click', status: 'passed', summary: 'click: Click Search', duration_ms: 3, url: 'https://shop.test/search', ordinal: 2, id: '0-2' },
  { kind: 'analyze', status: 'passed', summary: 'analyze: products are shown', duration_ms: 3, url: 'https://shop.test/search', ordinal: 3, id: '0-3' },
  { kind: 'assert', status: 'failed', summary: 'assert: at least one product appears', duration_ms: 3, url: 'https://shop.test/search', ordinal: 4, id: '0-4' },
]
  .map(s => JSON.stringify(s, null, 2))
  .join('')

const har = (entries: object[]) => JSON.stringify({ log: { entries } })
const CLEAN_HAR = har([
  { _step: '0-1', response: { status: 200 }, request: { url: 'https://shop.test/' }, time: 40 },
  { _step: '0-2', response: { status: 200 }, request: { url: 'https://shop.test/search' }, time: 60 },
  { _step: '0-2', _failed: true, response: { status: 0 }, request: { url: 'https://ads.example/pixel' }, time: 5 },
])
const BROKEN_HAR = har([
  { _step: '0-1', response: { status: 200 }, request: { url: 'https://shop.test/' }, time: 40 },
  { _step: '0-2', response: { status: 403 }, request: { url: 'https://shop.test/undefined/analytics/event' }, time: 20 },
  { _step: '0-3', response: { status: 503 }, request: { url: 'https://api.shop.test/products' }, time: 900 },
])

const RUN_LOG = [
  '⏱️  [step_1_navigate] completed in 0.900s',
  '⏱️  [step_1_total] completed in 1.000s',
  '⏱️  [step_2_pull_1] completed in 4.000s',
  '⏱️  [step_2_dom_action] completed in 1.500s',
  '⏱️  [step_2_total] completed in 7.000s',
  '[BrowserRunner] Starting-Node: analyzer_v3 Step: 3 keys=[\'present\']',
  "[BrowserRunner] Analyzer(v3): turns=9 tools=['grep_page'] committed=1 failed=0 provider_ms=20000 tool_ms=100 total_ms=20100",
  "[BrowserRunner] Analyzer(v3):   grep_page('product') -> 0 matches for 'product'",
  '⏱️  [step_3_analyze_v3] completed in 20.100s',
  '⏱️  [step_3_total] completed in 25.000s',
].join('\n')

const runEnd = (o: object) => JSON.stringify({ type: 'run_end', v: 1, ...o })
const FAIL_EVENTS = runEnd({
  status: 'failed',
  duration: 40,
  credits_consumed: 21.5,
  verdict: { family: 'automation_bug', category: 'agent_misstep', severity: 'minor', confidence: 0.93, bug_title: 'Agent read an empty page as results', relevant_steps: [2, 3] },
})

const files = (o: Partial<EvidenceFiles> = {}): EvidenceFiles => ({
  sessionDir: DIR,
  pack: PACK,
  label: 'search headphones and assert results',
  events: FAIL_EVENTS,
  listing: parseZipListing(LISTING),
  resultYaml: RESULT,
  stepJsons: STEPS,
  har: CLEAN_HAR,
  console: '',
  runLog: RUN_LOG,
  failureYaml: "suggested_fix: Use a search term the catalog stocks.\nother: x",
  runSummary: JSON.stringify({ config: { max_steps: 15 } }),
  ...o,
})

describe('evidence reading', () => {
  test('a failure with no page errors where it failed is the CLI loop or the model', () => {
    const ins = buildInsights(files())
    expect(ins.attribution.kind).toBe('automation')
    expect(ins.attribution.headline).toContain('Likely the CLI loop or the model')
    expect(ins.loopSignals.some(s => s.includes('committed an answer although 1 of its page searches found nothing'))).toBe(true)
    expect(ins.loopSignals.some(s => s.includes('Steps 2–4: the page did not change'))).toBe(true)
    expect(ins.steps.find(s => s.n === 3)?.isCulprit).toBe(true)
    expect(ins.steps.find(s => s.n === 2)?.modelMs).toBe(4000)
    expect(ins.verdict?.fix).toBe('Use a search term the catalog stocks.')
    expect(ins.environment).toBe('Chrome 154 · macOS · 1920x1080')
  })

  test('page errors at the failing steps make kane\'s "automation" verdict worth a second look', () => {
    const ins = buildInsights(files({ har: BROKEN_HAR }))
    expect(ins.attribution.kind).toBe('unclear')
    expect(ins.attribution.evidence.join(' ')).toContain('HTTP 503 api.shop.test/products (step 3)')
  })

  test('a product verdict without page evidence is not trusted blindly', () => {
    const events = runEnd({ status: 'failed', duration: 40, verdict: { family: 'product_bug', relevant_steps: [3] } })
    expect(buildInsights(files({ events })).attribution.kind).toBe('unclear')
    expect(buildInsights(files({ events, har: BROKEN_HAR })).attribution.kind).toBe('product')
  })

  test('a passing run with a broken first-party URL is flagged as a likely product bug', () => {
    const events = runEnd({ status: 'passed', duration: 30 })
    const ins = buildInsights(files({ events, har: BROKEN_HAR }))
    expect(ins.attribution.kind).toBe('signals')
    expect(ins.attribution.headline).toBe('Passed, but the page shows a likely product bug')
    expect(ins.attribution.evidence[0]).toContain('/undefined/analytics/event (step 2), a broken URL')
    const clean = buildInsights(files({ events }))
    expect(clean.attribution.kind).toBe('clean')
  })

  test('a run kane refused to start is neither a product bug nor the model', () => {
    const events = runEnd({ status: 'failed', duration: 3.4, credits_consumed: 0, reason: 'No start URL provided.' })
    const ins = buildInsights(files({ events, resultYaml: 'status: failed\nsteps:\n', stepJsons: '', listing: [], runLog: '' }))
    expect(ins.attribution.kind).toBe('unknown')
    expect(ins.attribution.headline).toBe('kane-cli refused to start the run: No start URL provided.')
  })

  test('the same extraction later in the run is flagged, back to back is left to the other rule', () => {
    const step = (n: number, kind: string, summary: string, ms = 1000) => ({ ...buildInsights(files()).steps[0]!, n, kind, summary, ms })
    expect(
      repeatedExtractions([
        step(5, 'analyze', "analyze: the first product's price is stored as {{price}}", 44700),
        step(6, 'assert', 'assert: at least one product appears'),
        step(7, 'analyze', "analyze: the first product's price is stored as {{price}}", 13000),
      ]),
    ).toEqual(['Steps 5 and 7: the model extracted {{price}} twice (13.0s spent on the repeat)'])
    expect(repeatedExtractions([step(2, 'analyze', 'analyze: title is saved as {{t}}'), step(3, 'analyze', 'analyze: title is saved as {{t}}')])).toEqual([])
    expect(repeatedExtractions([step(2, 'analyze', 'analyze: price is {{a}}'), step(4, 'analyze', 'analyze: name is {{b}}')])).toEqual([])
    expect(repeatedExtractions([step(2, 'analyze', 'analyze: PRIMARY: the cart has 2 items'), step(4, 'analyze', 'analyze: the cart has 2 items')])).toEqual([
      'Steps 2 and 4: the model extracted the same value twice (1.0s spent on the repeat)',
    ])
  })

  test('third-party failures are noise, first-party and broken URLs are not', () => {
    const h = parseHar(BROKEN_HAR, 'shop.test')
    expect(h.issues.map(i => [i.status, i.isFirstParty, i.isSuspicious])).toEqual([
      [403, true, true],
      [503, true, false],
    ])
    expect(parseHar(CLEAN_HAR, 'shop.test').issues).toEqual([])
    expect(parseRunLog(RUN_LOG).perStep.get(2)).toEqual({ totalMs: 7000, modelMs: 4000, browserMs: 1500 })
    expect(attribute({ ...buildInsights(files()), status: 'running' }).kind).toBe('unknown')
  })
})

const OK = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, {
    history: [
      { id: 'h1', kind: 'run', label: 'search headphones and assert results', status: 'failed', durationS: 40, credits: 21.5, sessionDir: DIR, endedAt: 999_000, rerun: ['run', 'search headphones and assert results', '--agent'] },
      { id: 'h2', kind: 'run', label: 'search headphones and assert results', status: 'passed', durationS: 30, credits: 18, sessionDir: '/home/qa/.testmuai/kaneai/sessions/s2', endedAt: 998_000, rerun: [] },
    ],
  })
  mock.env(on, { HOME: '/home/qa', TMPDIR: '/tmp/' })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__kane-qe__${e.name}` } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.copy', () => ({ value: { isCopied: true } }) as never)
  on('prompt.submit', () => ({}) as never)
  on('fs.list', ($, e) => (e.path === `${DIR}/evidence` ? { value: [{ name: 'e1.evidence', kind: 'file', size: 1 }] } : { value: [] }) as never)
  on('fs.exists', () => ({ value: false }) as never)
  on('fs.read', ($, e) =>
    (e.path === `${DIR}/events.ndjson` ? { value: FAIL_EVENTS } : /preview-\d+\.bmp$/.test(e.path) ? { value: { base64: toBase64(tinyBmp()) } } : { deny: 'ENOENT' }) as never,
  )
  const sips: string[][] = []
  on('process.run', ($, e) => {
    const [cmd, ...rest] = e.argv
    if (cmd === 'unzip' && rest[0] === '-lv') return OK(LISTING)
    if (cmd === 'unzip' && rest[0] === '-p') {
      const pattern = rest[2] ?? ''
      if (pattern.endsWith('result.yaml')) return OK(RESULT)
      if (pattern.endsWith('step.json')) return OK(STEPS)
      if (pattern.endsWith('network.har')) return OK(CLEAN_HAR)
      if (pattern.endsWith('run.log')) return OK(RUN_LOG)
      return OK('', 11)
    }
    if (cmd === 'mkdir') {
      sips.push([...e.argv])
      return OK('')
    }
    if (cmd === 'unzip') return OK('')
    if (cmd === 'sips') {
      sips.push([...e.argv])
      return OK('')
    }
    return OK(cmd === 'kane-cli' && rest[0] === '--version' ? '0.8.20\n' : '')
  })
  return { clock, sips }
}

describe('insights in the cockpit', () => {
  test('Insights shows who owns the failure, an interactive timeline, and a step with its screenshot', { timeoutMs: 15_000 }, async ($, on) => {
    const { clock, sips } = world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    await clock.settle()
    const pane = await $.ui.mount({
      plugin: 'kane-qe',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'kane-qe',
      props: { title: 'Kane QE', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } },
      viewport: { columns: 90, rows: 60 },
    } as never)
    await pane.press({ key: 'tab-insights' })
    await clock.settle()
    const has = async (name: string, q: object) => { if ((await pane.find(q as never)) === undefined) throw new Error(`missing: ${name}`) }
    await has('owner', { text: /CLI \/ MODEL/ })
    await has('fix', { key: 'ins-fix' })
    await has('flaky', { key: 'ins-flaky' })
    await has('committed', { text: /committed an answer although/ })
    await (pane as unknown as { pointer: (e: object) => Promise<void> }).pointer({ type: 'down', x: 20, y: 2, button: 'left', in: 'ins-timeline' })
    await clock.settle()
    await has('step panel', { text: /Step 3 · analyze · passed · 25.0s · culprit/ })
    if (sips.map(a => a[0]).join(',') !== 'mkdir,sips') throw new Error(`expected mkdir then sips, got ${sips.map(a => a[0]).join(',')}`)
    await has('shot link', { text: /Open full screenshot/ })
    await has('cell preview', { type: 'Raster' })
    // With the chart focused, the pane's hotkeys still work: the chart hands them on.
    await (pane as unknown as { key: (e: object) => Promise<void> }).key({ key: '8', in: 'ins-timeline' })
    await clock.settle()
    await has('time view via hotkey', { key: 'ins-time' })
    await (pane as unknown as { key: (e: object) => Promise<void> }).key({ key: '4', in: 'ins-time' })
    await clock.settle()
    await has('history via hotkey', { key: 'hv-trends' })
    await pane.press({ key: 'tab-insights' })
    await clock.settle()
    await pane.press({ key: 'iv-time' })
    expect(await pane.find({ key: 'ins-time' })).toBeDefined()
    await pane.press({ key: 'iv-signals' })
    expect(await pane.find({ text: /No HTTP errors/ })).toBeDefined()
    await pane.unmount()
  })

  test('History trends flag the flaky objective and open a run on click', { timeoutMs: 15_000 }, async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    await clock.settle()
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const pane = await $.ui.mount({
        plugin: 'kane-qe',
        surface,
        component: 'Pane',
        requestId: 'kane-qe',
        props: { title: 'Kane QE', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } },
        viewport: { columns: 90, rows: 60 },
      } as never)
      await pane.press({ key: 'tab-history' })
      await pane.press({ key: 'hv-trends' })
      expect(await pane.find({ text: /Flaky: search headphones and assert results — passed 1, failed 1/ })).toBeDefined()
      await pane.press({ key: 'hv-credits' })
      expect(await pane.find({ text: /39.5 credits over 2 runs/ })).toBeDefined()
      await pane.press({ key: 'hv-quality' })
      expect(await pane.find({ key: 'q-vitals' })).toBeDefined()
      await pane.press({ key: 'hv-runs' })
      await pane.unmount()
    }
    const pane = await $.ui.mount({
      plugin: 'kane-qe',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'kane-qe',
      props: { title: 'Kane QE', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } },
      viewport: { columns: 90, rows: 60 },
    } as never)
    await pane.press({ key: 'tab-history' })
    await pane.press({ key: 'hv-trends' })
    await (pane as unknown as { post: (d: object, s: object) => Promise<void> }).post({ type: 'pick', chart: 'history', id: 'h1' }, { in: 'hist-trend' })
    await clock.settle()
    expect(await pane.find({ text: /CLI \/ MODEL/ })).toBeDefined()
    await pane.unmount()
  })
})

describe('screenshot preview', () => {
  test('a BMP becomes half-block cells: top pixel as foreground, bottom as background', () => {
    const r = bmpToRaster(tinyBmp())!
    expect([r.columns, r.rows]).toEqual([2, 1])
    expect([...new Uint32Array(r.cells.buffer)]).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
    const bytes = tinyBmp()
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes])
  })
})

describe('coverage', () => {
  test('reads kane-cli cover gaps --json as it really comes back', () => {
    // Captured from kane-cli 0.8.20 after ingesting and extracting a one-use-case PRD.
    const real = {
      stage: 'all',
      rollup_version: 1,
      design_completeness: { pct: 0, acs_designed: '0/0', usecases_complete: '0/1', ucs_needing_scenarios: 1 },
      usecases: [
        {
          id: 'uc-1',
          title: 'Search for a product',
          risk: 'med',
          design_completeness: { pct: 0, status: 'undesigned' },
          pending: [{ ref: 'uc-1', kind: 'zero-scenario', why: 'use-case has no scenarios', ready_command: 'kane-cli design tests --use-case uc-1' }],
        },
      ],
      other: [],
    }
    expect(summarizeCoverage(real)).toEqual([
      'Design completeness 0% · 0/1 use cases complete · 0/0 acceptance criteria designed',
      'uc-1 Search for a product · risk med · 0% designed · 1 open',
      '  ↳ use-case has no scenarios → kane-cli design tests --use-case uc-1',
    ])
    expect(summarizeCoverage({ design_completeness: { pct: 0 }, usecases: [] })[1]).toContain('No use cases yet')
  })
})

describe('history from disk', () => {
  test('sessions the mod never saw (terminal, CI, lost history) come back into History', { timeoutMs: 15_000 }, async ($, on) => {
    const clock = mock.clock(on, { now: 2_000_000 })
    mock.store(on)
    mock.env(on, { HOME: '/home/qa' })
    on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
    on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
    on('tool.register', ($, e) => ({ value: { tool: `mcp__kane-qe__${e.name}` } }) as never)
    on('process.run', () => OK('') as never)
    on('fs.list', ($, e) =>
      (e.path === '/home/qa/.testmuai/kaneai/sessions'
        ? { value: [{ name: 'active', kind: 'dir', size: 0 }, { name: 'abc123', kind: 'dir', size: 0 }] }
        : { value: [] }) as never,
    )
    on('fs.exists', () => ({ value: false }) as never)
    on('fs.read', ($, e) =>
      (e.path === '/home/qa/.testmuai/kaneai/sessions/abc123/session.json'
        ? { value: JSON.stringify({ started_at: '2026-10-05T10:00:00Z', ended_at: '2026-10-05T10:01:30Z', credits_consumed: 12.345, runs: [{ objective: 'Check the  login\nflow and assert welcome', status: 'failed' }] }) }
        : { deny: 'ENOENT' }) as never,
    )
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    await clock.settle()
    const pane = await $.ui.mount({
      plugin: 'kane-qe',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'kane-qe',
      props: { title: 'Kane QE', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 50 } },
      viewport: { columns: 100, rows: 50 },
    } as never)
    await pane.press({ key: 'tab-history' })
    expect(await pane.find({ text: /Check the login flow and assert welcome/ })).toBeDefined()
    expect(await pane.find({ text: /90s · .* · 12.35 cr/ })).toBeDefined()
    await pane.unmount()
  })
})
