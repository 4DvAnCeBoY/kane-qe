import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.parse('2026-10-08T10:00:00.000Z')
const HOME = '/home/qa'
const ACTIVE = `${HOME}/.testmuai/kaneai/sessions/active`
// A project under a tool folder (~/.claude/jobs/…) must still have its edits tracked.
const PROJECT = '/home/qa/.claude/jobs/1/shop'
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const line = (o: object, s = 0) => `${JSON.stringify({ ...o, v: 1, ts: at(s) })}\n`
const OK = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? stdout : '', isStdoutTruncated: false, isStderrTruncated: false } })

const BAND = {
  plugin: 'kane-qe',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'kane-qe',
  component: 'Pane',
  requestId: 'kane-qe',
  props: { title: 'Kane', isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type World = { files: Record<string, string>; alive: Set<number>; prompts: string[]; cover?: string; forkText?: string; ignored: Set<string>; bashResult?: unknown; store?: Record<string, unknown> }

/** The engine beneath the plugin: a fake disk, processes, and the calls the mod makes. */
function world(on: On, w: Partial<World> = {}): World & { clock: ReturnType<typeof mock.clock> } {
  const state: World = { files: {}, alive: new Set(), prompts: [], ignored: new Set(), ...w }
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, state.store)
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.blit', () => ({ value: {} }) as never)
  on('prompt.submit', ($, e) => {
    state.prompts.push(String((e as { text?: unknown }).text))
    return { text: String((e as { text?: unknown }).text) } as never
  })
  on('model.fork', () => ({ value: state.forkText ? { isAnswered: true, text: state.forkText } : { isAnswered: false, reason: 'nothing-to-fork' } }) as never)
  on('fs.exists', ($, e) => ({ value: e.path in state.files || Object.keys(state.files).some(f => f.startsWith(`${e.path}/`)) }) as never)
  on('fs.list', ($, e) => {
    const dir = `${e.path.replace(/\/$/, '')}/`
    const names = Object.keys(state.files).filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/'))
    return { value: names.map(f => ({ name: f.slice(dir.length), kind: 'file', size: state.files[f]!.length, mtimeMs: 0, isLink: false })) } as never
  })
  on('fs.read', ($, e) => (e.path in state.files ? { value: state.files[e.path] } : { deny: 'ENOENT' }) as never)
  on('fs.stat', ($, e) => (e.path in state.files ? { value: { kind: 'file', size: state.files[e.path]!.length, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('process.run', ($, e) => {
    const argv = e.argv
    if (argv[0] === 'kill') return OK('', state.alive.has(Number(argv[2])) ? 0 : 1) as never
    if (argv[0] === 'git' && argv[1] === 'check-ignore') return OK('', state.ignored.has(String(argv[3])) ? 0 : 1) as never
    if (argv[0] === 'git' && argv[1] === 'diff') return OK('+ postcode.trim()') as never
    if (argv.includes('cover')) return (state.cover ? OK(state.cover) : OK('error: no context store here', 1)) as never
    return OK('', 1) as never
  })
  on('tool.call', ($, e) => ({ result: (e as { tool?: string }).tool === 'Bash' && state.bashResult ? state.bashResult : { ok: true } }) as never)
  on('classic.Stop', () => ({}) as never)
  return Object.assign(state, { clock })
}

/** kane-cli starts a run: its pointer and its first lines. */
function startRun(w: World, pid: number, dir: string, surface: string, lines: string, cwd = PROJECT) {
  w.alive.add(pid)
  w.files[`${ACTIVE}/${pid}.json`] = JSON.stringify({ pid, cwd, surface, session_dir: dir, started: at(0), cli_version: '0.8.20', host_agent: 'claude-code' })
  w.files[`${dir}/events.ndjson`] = lines
}

/** kane-cli exits: the pointer goes and the process with it. */
function endRun(w: World, pid: number) {
  delete w.files[`${ACTIVE}/${pid}.json`]
  w.alive.delete(pid)
}

const S = `${HOME}/.testmuai/kaneai/sessions`

describe('drawing', () => {
  test('the band draws on the terminal and the desktop: mascot, idle, assurance, Open', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface } as never)
      expect(await ui.find({ type: 'Text', text: /idle/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /assurance/ })).toBeDefined()
      expect(await ui.find({ key: 'open' })).toBeDefined()
      expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('colours follow Claude Code’s theme: the design’s palette on dark, a darker one on light', async ($, on) => {
    const w = world(on)
    on('config.list', () => ({ value: [{ key: 'theme', value: 'light' }] }) as never)
    on('config.set', ($, e) => ({ value: (e as { value: unknown }).value }) as never)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    const assurance = async () => (await band.find({ type: 'Text', text: /^assurance$/ }))?.props.color
    expect(await assurance()).toBe('#9a7200')
    await $.config.set({ key: 'theme', value: 'dark' } as never)
    await w.clock.settle()
    expect(await assurance()).toBe('#ffd66b')
    await band.unmount()
  })

  test('the pane has Runs and Assurance; with no assurance it offers to set it up with Claude', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ ...PANE, surface } as never)
      expect(await pane.find({ type: 'Text', text: /No kane-cli run in this session yet/ })).toBeDefined()
      await pane.press({ key: 'tab-assure' })
      expect(await pane.find({ type: 'Text', text: /Assurance is not set up/ })).toBeDefined()
      await pane.press({ key: 'setup' })
      await pane.press({ key: 'tab-runs' })
      await pane.unmount()
    }
    expect(w.prompts[0]).toContain('Set up kane-cli assurance')
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /not set up/ })).toBeDefined()
    expect(await band.find({ key: 'setup' })).toBeDefined()
    await band.unmount()
  })
})

describe('watching kane-cli', () => {
  test('a testmd run Claude starts shows within two seconds, steps and all, then ends as a failed run', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    // Claude runs it: the command names the run.
    await $.tool.call({ tool: 'Bash', command: 'kane-cli testmd run .testmuai/tests/checkout_guest_test.md --agent --headless' } as never)
    const dir = `${S}/run-1`
    startRun(w, 501, dir, 'testmd', line({ type: 'test_md_step_start', step_index: 1, heading: 'Open the cart' }, 1))
    await w.clock.advance(2000)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /running/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /checkout_guest/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Open the cart/ })).toBeDefined()

    w.files[`${dir}/events.ndjson`] +=
      line({ type: 'test_md_step_end', step_index: 1, status: 'passed', duration_s: 5 }, 6) +
      line({ type: 'test_md_step_start', step_index: 2, heading: 'Fill the shipping address' }, 6) +
      line({ type: 'step_event', index: 1, event: 'reasoning', detail: 'the postcode field is empty' }, 7) +
      line({ type: 'step_event', index: 1, event: 'action', detail: 'Typing the postcode', action_type: 'type' }, 8) +
      line({ type: 'step_event', index: 1, event: 'assertion', detail: 'the page shows "Enter a valid postcode"', passed: false }, 9) +
      line({ type: 'run_end', status: 'failed', credits_consumed: 31.2, verdict: { root_cause: 'Postcode field rejects valid input', category: 'functional_defect', severity: 'high', confidence: 0.86 } }, 10) +
      line({ type: 'test_md_step_end', step_index: 2, status: 'failed', duration_s: 4 }, 10) +
      line({ type: 'test_md_done', overall_status: 'failed', duration_s: 10 }, 10)
    endRun(w, 501)
    await w.clock.advance(2000)
    await w.clock.settle()
    expect(await band.find({ type: 'Text', text: /1 failed/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /failed on/ })).toBeDefined()

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: `run-${dir}` })
    expect(await pane.find({ type: 'Text', text: /Postcode field rejects valid input/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /functional defect · high · 86% sure/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /✗ the page shows/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /31.2 credits/ })).toBeDefined()
    await pane.press({ key: 'evidence' })
    expect(w.prompts.at(-1)).toBe(`Open the evidence for the kane-cli run in ${dir}.`)
    await pane.unmount()
    await band.unmount()
  })

  test('three runs at once become cells; a suite counts its members from their own streams', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    for (const pid of [11, 12, 13]) startRun(w, pid, `${S}/r${pid}`, 'run', line({ type: 'stream_start', surface: 'run', pid }) + line({ step: 1, status: 'running', remark: 'Step 1' }))
    await w.clock.advance(1500)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /3 runs/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /3 running/ })).toBeDefined()
    for (const pid of [11, 12, 13]) {
      w.files[`${S}/r${pid}/events.ndjson`] += line({ type: 'run_end', status: 'passed', credits_consumed: 5 }, 9)
      endRun(w, pid)
    }
    await w.clock.advance(1500)
    await w.clock.settle()
    expect(await band.find({ type: 'Text', text: /✓ 3 passed/ })).toBeDefined()

    const sdir = `${S}/testrun-1`
    const a = `${PROJECT}/.testmuai/tests/login_test.md`
    const b = `${PROJECT}/.testmuai/tests/search_test.md`
    startRun(
      w,
      20,
      sdir,
      'testrun',
      line({ type: 'stream_start', surface: 'testrun', pid: 20 }) +
        line({ type: 'testrun_plan', members: [{ path: a }, { path: b }], parallel: 1 }) +
        line({ type: 'testrun_member_start', path: a, log_path: `${S}/m1/events.ndjson` }, 1) +
        line({ type: 'testrun_progress', running: ['.testmuai/tests/login_test.md'], pending: 1, done: 0, total: 2 }, 1),
    )
    w.files[`${S}/m1/events.ndjson`] = line({ type: 'test_md_step_start', step_index: 1, heading: 'Sign in as the test user' }, 2)
    await w.clock.advance(1500)
    await w.clock.settle()
    expect(await band.find({ type: 'Text', text: /0 of 2 tests done/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /login/ })).toBeDefined()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: `run-${sdir}` })
    expect(await pane.find({ type: 'Text', text: /Sign in as the/ })).toBeDefined()
    expect(await pane.find({ key: 'run-' + a })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })

  test('a stale pointer and another project’s run are not shown', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    startRun(w, 31, `${S}/x1`, 'run', line({ step: 1, status: 'running', remark: 'Step 1' }))
    w.alive.delete(31)
    startRun(w, 32, `${S}/x2`, 'run', line({ step: 1, status: 'running', remark: 'Step 1' }), '/work/other-project')
    await w.clock.advance(1500)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /idle/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /running/ })).toBeUndefined()
    await band.unmount()
  })

  test('the last result from an earlier session shows, beside v1’s own history in the same store', async ($, on) => {
    // v1 of this plugin keeps a list under `history` in the same store; v2 keeps its own record.
    const w = world(on, { store: { history: [{ id: 'v1-run', status: 'passed' }], recentByProject: { [PROJECT]: [{ label: 'login_test.md', status: 'passed', at: T0 - 7_200_000 }] } } })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /login · 2h ago/ })).toBeDefined()
    await band.unmount()
  })

  test('a stream with unknown events or a newer wire version never throws', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    startRun(w, 41, `${S}/n1`, 'run', 'not json\n' + line({ type: 'brand_new', x: 1 }) + `${JSON.stringify({ type: 'stream_start', v: 2, ts: at(0) })}\n` + '{"half":')
    await w.clock.advance(1500)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /newer than the mod/ })).toBeDefined()
    await band.unmount()
  })
})

describe('after Claude changes code', () => {
  async function edit($: { tool: { call: (i: never) => Promise<unknown> } }, path: string) {
    await $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as never)
  }

  test('offer: a turn ending with an edit raises the warning; the card drafts an objective and hands it to Claude; a later run clears it', async ($, on) => {
    const w = world(on, { forkText: 'Objective: Type a postcode with a space and check the order is placed.' })
    w.files[`${PROJECT}/.testmuai/tests/checkout_guest_test.md`] = 'Open https://shop.test/ and fill the shipping address as a guest'
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await edit($, `${PROJECT}/src/checkout/AddressForm.tsx`)
    await edit($, `${PROJECT}/README.md`)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /changed, untested/ })).toBeUndefined()
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    expect(await band.find({ type: 'Text', text: /1 file changed, untested/ })).toBeDefined()
    await band.press({ key: 'test' })
    await w.clock.settle()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    // A saved test covers it: offered first, no draft until asked.
    expect(await pane.find({ type: 'Text', text: /checkout_guest_test.md/ })).toBeDefined()
    expect(await pane.find({ key: 'saved-run-checkout_guest_test.md' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Suggested objective/ })).toBeUndefined()
    await pane.press({ key: 'offer-draft' })
    await w.clock.settle()
    expect(await pane.find({ type: 'Text', text: /Type a postcode with a space/ })).toBeDefined()
    await pane.press({ key: 'offer-run' })
    expect(w.prompts.at(-1)).toContain('kane-cli run "Type a postcode with a space and check the order is placed." --url https://shop.test/ --agent --headless')

    // Claude runs it; the run ends: the warning is gone.
    await w.clock.advance(5000)
    startRun(w, 61, `${S}/c1`, 'run', line({ step: 1, status: 'done', remark: 'Typed the postcode' }, 6) + line({ type: 'run_end', status: 'passed' }, 7))
    w.files[`${ACTIVE}/61.json`] = JSON.stringify({ pid: 61, cwd: PROJECT, surface: 'run', session_dir: `${S}/c1`, started: at(6) })
    await w.clock.advance(1500)
    await w.clock.settle()
    expect(await band.find({ type: 'Text', text: /changed, untested/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /✓ 1 passed/ })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })

  test('an edit made from the shell counts too: Bash reports the files it changed', async ($, on) => {
    const w = world(on, { bashResult: { stdout: '', bashEditDiff: { files: [], moreFiles: 0, changedFiles: [`${PROJECT}/src/cart.ts`] } } })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'Bash', command: "printf 'x' > src/cart.ts" } as never)
    await w.clock.settle()
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /1 file changed, untested/ })).toBeDefined()
    await band.unmount()
  })

  test('files other tools write while a kane-cli run goes are not Claude’s edits', async ($, on) => {
    const w = world(on, { bashResult: { stdout: '', bashEditDiff: { files: [], moreFiles: 0, changedFiles: [`${PROJECT}/src/cart.ts`] } } })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'Bash', command: 'kane-cli run "Add an iPod to the cart" --agent --headless' } as never)
    await w.clock.settle()
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /changed, untested/ })).toBeUndefined()
    await band.unmount()
  })

  test('auto: Claude is held once to test the change, never twice', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'kane', args: 'auto' } as never)
    await edit($, `${PROJECT}/src/cart.ts`)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /Claude will test this before it finishes/ })).toBeDefined()
    const first = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    expect(String((first as { block?: string }).block)).toContain('src/cart.ts')
    const again = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    expect((again as { block?: string }).block).toBeUndefined()
    // Claude finished without testing: the band stops promising and offers the test.
    expect(await band.find({ type: 'Text', text: /Claude will test this/ })).toBeUndefined()
    expect(await band.find({ key: 'test' })).toBeDefined()
    await band.unmount()
  })

  test('off: the band never mentions the change; ignored files never count', async ($, on) => {
    const w = world(on, { ignored: new Set([`${PROJECT}/dist/app.js`]) })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await edit($, `${PROJECT}/dist/app.js`)
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /changed, untested/ })).toBeUndefined()
    await $.command.run({ command: 'kane', args: 'off' } as never)
    await edit($, `${PROJECT}/src/cart.ts`)
    const r = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    expect((r as { block?: string }).block).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /changed, untested/ })).toBeUndefined()
    await band.unmount()
  })
})

describe('assurance', () => {
  test('a project with a requirement store shows proven coverage in the band and use cases in the pane', async ($, on) => {
    const w = world(on, {
      cover: JSON.stringify({
        design_completeness: { pct: 82 },
        proven: { pct: 47, failing: 2, blocked: 1, latest_run: { started_at: at(-7200) } },
        usecases: [{ id: 'uc-buy-as-a-guest', design_completeness: { pct: 75 }, proven: { pct: 38 }, stale_acs: 1, pending: [{ stage: 'cover' }] }],
      }),
    })
    w.files[`${PROJECT}/.context/commits/1`] = 'x'
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /47%/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /proven · 1 use case/ })).toBeDefined()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'tab-assure' })
    expect(await pane.find({ type: 'Text', text: /uc-buy-as-a-guest/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /2 failing · 1 blocked · run 2h ago/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1 stale/ })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })
})
