import { describe, expect, test } from 'claude-code/testing'

import { adapt, splitLines } from '../hooks/adapter'
import type { Ev } from '../hooks/adapter'
import {
  band,
  featureWords,
  fold,
  foldMember,
  labelFromCommand,
  newRun,
  objectiveFrom,
  parseCoverGaps,
  rowText,
  rowWidth,
  savedTestsFor,
  tidyStep,
  isTrackedEdit,
} from '../hooks/model'
import type { BandOptions } from '../hooks/model'
import type { Assurance, Kind, Run } from '../types'
import { runFailed, runPassed, testmdPassed, testrunFailed, testrunPassed, testrunPassedMember } from './fixtures/fixtures'

const T0 = Date.parse('2026-10-08T10:00:00.000Z')
const READY: Assurance = { state: 'ready', designedPct: 82, provenPct: 47, useCases: [1, 2, 3, 4].map(i => ({ id: `uc-${i}`, designed: 80, proven: 40, stale: 0, toDesign: 0, toCover: 1 })) }
const opts = (o: Partial<BandOptions> = {}): BandOptions => ({ assurance: READY, now: T0 + 30_000, columns: 80, ...o })
const rows = (runs: Run[], o: Partial<BandOptions> = {}) => band(runs, opts(o)).rows.map(rowText)

const events = (stream: string): Ev[] => splitLines(stream).lines.flatMap(l => adapt(l).events)
const replay = (stream: string, kind: Kind, id = 'r'): Run => events(stream).reduce(fold, newRun(id, kind, `/s/${id}`, Date.parse(JSON.parse(stream.split('\n')[0]!).ts)))

/** A run built from a few events, timed from T0. */
function run(id: string, kind: Kind, evs: Ev[], start = T0): Run {
  return evs.reduce(fold, newRun(id, kind, `/s/${id}`, start))
}
const step = (n: number, status: 'running' | 'done' | 'failed', text: string, s = 0): Ev => ({ k: 'step', n, status, text, at: T0 + s * 1000 })
const label = (text: string): Ev => ({ k: 'label', text, rank: 4, at: T0 })
const passed = (s: number): Ev => ({ k: 'runEnd', status: 'passed', credits: 12.4, at: T0 + s * 1000 })
const failedEnd = (s: number, why = 'Postcode field rejects valid input'): Ev => ({ k: 'runEnd', status: 'failed', why, category: 'functional_defect', severity: 'major', confidence: 0.86, at: T0 + s * 1000 })

const one = () => run('one', 'run', [label('checkout_guest_test.md'), step(1, 'done', 'Open the cart', 5), step(2, 'running', 'Fill the shipping address', 6)])
const loginPassed = () => run('login', 'run', [label('login_test.md'), step(1, 'done', 'Sign in', 10), passed(20)], T0 - 600_000)
const checkoutFailed = () => run('co', 'run', [label('checkout_guest_test.md'), step(1, 'done', 'Open the cart', 5), step(2, 'failed', 'Fill the shipping address', 20), failedEnd(21)], T0 - 600_000)

function suite(states: ('pending' | 'running' | 'passed' | 'failed')[]): Run {
  const paths = states.map((_, i) => `/p/.testmuai/tests/t${i}_test.md`)
  let s = fold(newRun('suite', 'testrun', '/s/suite', T0), { k: 'plan', members: paths, at: T0 })
  s = fold(s, label('suite · --tags smoke'))
  states.forEach((st, i) => {
    if (st === 'pending') return
    s = fold(s, { k: 'memberStart', path: paths[i]!, at: T0 + 1000 })
    if (st === 'running') s = foldMember(s, paths[i]!, { k: 'mdStepStart', index: 1, heading: 'Open the page', at: T0 + 2000 })
    if (st === 'passed' || st === 'failed') {
      if (st === 'failed') s = foldMember(s, paths[i]!, { k: 'mdStepStart', index: 1, heading: 'Fill the shipping address', at: T0 + 2000 })
      s = fold(s, { k: 'memberEnd', path: paths[i]!, status: st, durationS: 9, at: T0 + 10_000 })
    }
  })
  return s
}

describe('the band, state by state, at 60, 80 and 120 columns', () => {
  for (const columns of [60, 80, 120]) {
    test(`nothing has run yet (${columns})`, () => {
      const r = rows([], { columns })
      expect(r[0]).toBe(' idle  [Open]')
      expect(r[1]).toBe('')
      expect(r[2]).toContain('47% proven · 4 use cases')
      expect(rows([], { columns, last: { label: 'login_test.md', status: 'passed', at: T0 - 7_200_000 } })[1]).toBe('last run ✓ login · 2h ago')
    })
    test(`idle, with results (${columns})`, () => {
      const r = rows([loginPassed(), checkoutFailed()], { columns })
      expect(r[0]).toContain('✓ 1 passed · ✗ 1 failed')
      expect(r[1]).toContain('✗ checkout_guest failed on Fill the shipping address')
    })
    test(`an untested change (${columns})`, () => {
      expect(rows([], { columns, change: { files: 2, mode: 'offer' } })[1]).toBe('⚠ 2 files changed, untested [Test this change]')
      expect(rows([], { columns, change: { files: 1, mode: 'auto' } })[1]).toBe(columns >= 80 ? '⚠ 1 file changed, untested · Claude will test this before it finishes' : '⚠ 1 file changed, untested · Claude will test it')
    })
    test(`one test running (${columns})`, () => {
      const r = rows([one()], { columns })
      expect(r[0]).toContain(' running  checkout_guest 30s [Open]')
      expect(r[1]).toBe('Fill the shipping address')
      expect(band([one()], opts({ columns })).think).toBe(true)
    })
    test(`several runs at once (${columns})`, () => {
      const r = rows([one(), run('b', 'run', [label('search_test.md'), step(1, 'running', 'Searching', 2)], T0 + 5000)], { columns })
      expect(r[0]).toContain(' 2 runs  ■■ 2 running')
      expect(r[1]).toMatch(/^now checkout_guest 30s/)
    })
    test(`a suite, midway, and a failure during it (${columns})`, () => {
      const mid = rows([suite(['passed', 'passed', 'running', 'pending'])], { columns })
      expect(mid[0]).toContain(' suite  ■■■□ 2 of 4 tests done · 1 running · 1 left [Open]')
      expect(mid[1]).toMatch(/^now t2 /)
      const bad = rows([suite(['passed', 'failed', 'running', 'pending'])], { columns })
      expect(bad[1]).toContain('✗ t1 failed on Fill the shipping address')
    })
  }

  test('a run refused before any step shows kane’s reason', () => {
    const r = run('u', 'run', [label('Type a postcode'), { k: 'runEnd', status: 'failed', why: 'No start URL provided. Pass --url', at: T0 + 1000 }])
    expect(rows([r])[1]).toContain('✗ Type a postcode failed: No start URL provided')
  })

  test('every state fits its width: names are cut, then items drop from the right, [ Open ] stays', () => {
    const long = 'Search for wireless noise cancelling headphones and add the cheapest one to the cart then verify the subtotal'
    const states: [Run[], Partial<BandOptions>][] = [
      [[run('l', 'run', [label(long), step(1, 'running', long, 2)])], {}],
      [[suite(Array(12).fill('pending').map((x, i) => (i < 3 ? 'running' : i === 4 ? 'failed' : x)))], {}],
      [[one(), run('b', 'run', [label(long), step(1, 'running', 'x', 2)])], {}],
      [[run('f', 'run', [label(long), step(1, 'failed', long, 2), failedEnd(3)])], {}],
      [[], { change: { files: 12, mode: 'auto' } }],
      [[], { change: { files: 12, mode: 'offer' } }],
      [[], { last: { label: `${long}_test.md`, status: 'passed', at: T0 - 9e6 } }],
    ]
    for (const columns of [51, 71, 111]) {
      for (const [runs, o] of states) {
        for (const r of band(runs, opts({ ...o, columns })).rows) expect(rowWidth(r)).toBeLessThanOrEqual(columns)
        expect(band(runs, opts({ ...o, columns })).rows[0].button?.key).toBe('open')
      }
    }
  })

  test('assurance: not set up, nothing run yet, unknown', () => {
    expect(rows([], { assurance: { state: 'none' } })[2]).toBe('assurance not set up [Set up now]')
    expect(rows([], { assurance: { state: 'ready', designedPct: 82, useCases: [] } })[2]).toBe('assurance ━━━━━━━━━━━━━─── 82% designed · nothing run yet')
    expect(rows([], { assurance: { state: 'unknown' } })[2]).toBe('assurance')
  })

  test('a newer kane-cli shows the run and says so, nothing else', () => {
    const r = rows([run('n', 'run', [label('login_test.md'), { k: 'newer', at: T0 }])])
    expect(r[0]).toContain('running  login')
    expect(r[1]).toBe('this kane-cli is newer than the mod')
  })

  test('a run waiting on a question says so on row 2, in the warning colour', () => {
    const b = band([run('q', 'run', [label('login_test.md'), step(1, 'done', 'Open the sign-in page', 2), { k: 'ask', question: 'Which account should I use?', at: T0 + 3000 }])], opts())
    expect(rowText(b.rows[1])).toBe('waiting for an answer: Which account should I use?')
    expect((b.rows[1].items[0] as { c?: string }).c).toBe('#ffa45c')
  })

  test('a grid run replayed after the fact does not animate the mascot', () => {
    const replayed = run('g', 'run', [{ k: 'postHoc' }, label('login_test.md'), step(1, 'running', 'Open the page', 1)])
    expect(band([replayed], opts()).think).toBe(false)
    expect(rows([replayed])[0]).toContain('running')
  })

  test('the mascot thinks only while something runs', () => {
    expect(band([one()], opts()).think).toBe(true)
    expect(band([loginPassed()], opts()).think).toBe(false)
  })

  test('past 40 tests the cells become a proportional bar', () => {
    const r = rows([suite([...Array(30).fill('passed'), ...Array(20).fill('pending'), 'running'])])
    expect(r[0]).not.toContain('□')
    expect(r[0]).toContain('of 51 tests done')
  })
})

describe('recorded streams replayed', () => {
  test('surface run, failed: kane’s own root cause, where, and credits', () => {
    const r = replay(runFailed, 'run')
    expect(r.status).toBe('failed')
    expect(r.label).toContain('Click Enable Notification')
    expect(r.failure?.why).toContain('previous-step control accepted the click')
    expect(r.failure?.category).toBe('functional_defect')
    expect(Math.round((r.credits ?? 0) * 100) / 100).toBe(43.31)
    expect(r.steps.every(s => s.status !== 'running')).toBe(true)
    expect(rows([r])[1]).toContain('failed on')
  })

  test('surface run, while running then passed', () => {
    const lines = splitLines(runPassed).lines
    const half = lines.slice(0, 12).flatMap(l => adapt(l).events).reduce(fold, newRun('p', 'run', '/s/p', Date.parse(JSON.parse(lines[0]!).ts)))
    expect(half.status).toBe('running')
    expect(rows([half], { now: half.startedAt + 60_000 })[0]).toContain('running')
    const r = replay(runPassed, 'run')
    expect(r.status).toBe('passed')
    expect(r.steps.length).toBeGreaterThan(4)
    expect(r.steps.every(s => !/^Step \d+$/.test(s.text))).toBe(true)
  })

  test('surface testmd: file steps named from their objective, with think, act and checks', () => {
    const r = replay(testmdPassed, 'testmd')
    expect(r.status).toBe('passed')
    expect(r.steps).toHaveLength(2)
    expect(r.steps[0]?.text).toBe('locate the catalog product-name search box')
    expect(r.steps[1]?.checks?.[0]?.ok).toBe(true)
    expect(r.steps[1]?.act).toBeDefined()
    expect(r.credits).toBeGreaterThan(30)
  })

  test('surface testrun: plan, member stream, and the end', () => {
    let s = replay(testrunPassed, 'testrun', 'suite')
    const path = s.members?.[0]?.id ?? ''
    for (const ev of events(testrunPassedMember)) s = foldMember(s, path, ev)
    expect(s.status).toBe('passed')
    expect(s.members).toHaveLength(1)
    expect(s.members?.[0]?.status).toBe('passed')
    expect(s.members?.[0]?.steps.length).toBeGreaterThan(0)
    const failed = replay(testrunFailed, 'testrun', 'suite2')
    expect(failed.status).toBe('failed')
    expect(failed.members?.[0]?.status).toBe('failed')
  })
})

describe('labels, edits and drafts', () => {
  test('a run is named from the command Claude ran', () => {
    expect(labelFromCommand('cd shop && kane-cli testmd run .testmuai/tests/login_test.md --agent')).toEqual({ label: 'login_test.md', surface: 'testmd' })
    expect(labelFromCommand(`kane-cli run "Add a hoodie to the cart" --agent --headless`)).toEqual({ label: 'Add a hoodie to the cart', surface: 'run' })
    expect(labelFromCommand('kane-cli testrun run --tags smoke --parallel 3')).toEqual({ label: 'suite · --tags smoke', surface: 'testrun' })
    expect(labelFromCommand('npm test')).toBeUndefined()
  })

  test('planner noise is dropped from step text', () => {
    expect(tidyStep('click: PRIMARY: Enable Notification toggle; role=switch; text="Off" | HINTS: right side')).toBe('Enable Notification toggle')
    expect(tidyStep('click: Clicking Safari in the list')).toBe('Clicking Safari in the list')
    expect(tidyStep('analyze: The wizard did not advance')).toBe('analyze: The wizard did not advance')
  })

  test('docs and tool folders are not changes to test', () => {
    expect(isTrackedEdit('src/checkout/Address.tsx')).toBe(true)
    expect(isTrackedEdit('README.md')).toBe(false)
    expect(isTrackedEdit('docs/guide.html')).toBe(false)
    expect(isTrackedEdit('.testmuai/tests/a_test.md')).toBe(false)
  })

  test('a saved test that mentions the changed feature is offered first', () => {
    expect(featureWords('src/checkout/AddressForm.tsx')).toEqual(['checkout', 'address', 'form'])
    const saved = [
      { name: 'login_test.md', text: 'Sign in as the test user' },
      { name: 'checkout_guest_test.md', text: 'Fill the shipping address and check out as a guest' },
    ]
    expect(savedTestsFor(['/p/src/checkout/AddressForm.tsx'], saved)).toEqual(['checkout_guest_test.md'])
    expect(savedTestsFor(['/p/src/utils/index.ts'], saved)).toEqual([])
  })

  test('the drafted objective is the reply, without labels or quotes', () => {
    expect(objectiveFrom('Objective: "Type a postcode with a space and check the order is placed."')).toBe('Type a postcode with a space and check the order is placed.')
    // Real reply: the fork added a remark about the conversation after the objective.
    expect(objectiveFrom('Type "Foo ?" into the search box\nand submit it.\n\nNothing to do here: I did not start that agent.')).toBe('Type "Foo ?" into the search box and submit it.')
  })
})

describe('assurance from cover gaps', () => {
  test('a full document', () => {
    const a = parseCoverGaps(
      `noise\n${JSON.stringify({
        stage: 'all',
        design_completeness: { pct: 82, acs_designed: '13/16' },
        proven: { pct: 47, failing: 2, blocked: 1, not_run: 6, latest_run: { started_at: '2026-10-08T08:00:00Z' } },
        usecases: [{ id: 'uc-buy-as-a-guest', design_completeness: { pct: 75 }, proven: { pct: 38 }, stale_acs: 1, pending: [{ stage: 'design' }, { stage: 'cover' }, { stage: 'cover' }] }, { id: null, title: 'Saved addresses', design_completeness: { pct: 100 }, stale_acs: 0, pending: [] }],
      })}`,
    )
    expect(a).toEqual({
      state: 'ready',
      designedPct: 82,
      provenPct: 47,
      failing: 2,
      blocked: 1,
      lastRunAt: Date.parse('2026-10-08T08:00:00Z'),
      useCases: [
        { id: 'uc-buy-as-a-guest', designed: 75, proven: 38, stale: 1, toDesign: 1, toCover: 2 },
        { id: 'Saved addresses', designed: 100, proven: undefined, stale: 0, toDesign: 0, toCover: 0 },
      ],
    })
  })

  test('nothing run yet has no proven', () => {
    const a = parseCoverGaps(JSON.stringify({ design_completeness: { pct: 60 }, usecases: [] }))
    expect(a.state === 'ready' && a.provenPct).toBe(undefined)
  })

  test('text that is not JSON is unknown', () => {
    expect(parseCoverGaps('error: something')).toEqual({ state: 'unknown' })
  })
})
