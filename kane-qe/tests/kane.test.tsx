import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyEvent, ciCommand, fitSteps, mergeHistory, shortUrl, tidyStep, describeBalance, describeIdentity, parseWhoami, resolveAuth, coachObjective, finishRun, needsCoaching, newRun, parseConfig, parseRunArgs, parseTests, report, routeKane, runArgs } from '../hooks/kane'

const line = (o: object) => JSON.stringify({ v: 1, ts: '2026-10-05T00:00:00Z', ...o })

const RUN_STREAM = [
  line({ type: 'stream_start', cli_version: '0.8.10', surface: 'run', pid: 4242, session_dir: '/s/1' }),
  line({ step: 1, status: 'running', remark: 'Open login page' }),
  line({ step: 1, status: 'done', remark: 'Opened login page' }),
  line({ step: 2, status: 'done', remark: 'Typed credentials and clicked Sign in' }),
  line({ step: 3, status: 'done', remark: 'Asserted dashboard greeting' }),
  line({
    type: 'run_end',
    status: 'passed',
    one_liner: 'Logged in and saw Welcome, Ana',
    summary: 'All checks passed',
    duration: 41,
    credits_consumed: 3,
    final_state: { greeting: 'Welcome, Ana' },
    session_dir: '/s/1',
    run_dir: '/s/1/runs/1/run-test',
    test_url: 'https://test-manager.example/t/1',
  }),
].join('\n') + '\n'

const OK = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function fakeKane(argv: readonly string[]) {
  const cmd = argv.slice(1).join(' ')
  if (cmd === '--version') return OK('0.8.10\n')
  if (cmd === 'whoami') return OK('Logged in as ana@example.com\n')
  if (cmd.startsWith('config show')) return OK(JSON.stringify({ profile: 'default', env: 'prod', mode: 'testing', project_name: 'Web', folder_name: 'Smoke' }))
  if (cmd === 'balance') return OK('Available credits: 120\nTotal credits: 500\n')
  if (cmd.startsWith('testmd list')) return OK(JSON.stringify({ path: '.testmuai/tests/login_test.md', name: 'login', tags: ['smoke'], synced: true, has_meta: true }) + '\n')
  return OK('', 0)
}

describe('NDJSON reducer', () => {
  test('folds a passing `run --agent` stream', () => {
    let run = newRun('r1', 'run', 'login', 'model', 0)
    for (const l of RUN_STREAM.trim().split('\n')) run = applyEvent(run, JSON.parse(l))
    run = finishRun(run, 0, 50_000)
    expect(run.status).toBe('passed')
    expect(run.pid).toBe(4242)
    expect(run.steps.length).toBe(3)
    expect(run.steps[0]?.status).toBe('done')
    expect(run.durationS).toBe(41)
    expect(run.finalState).toEqual({ greeting: 'Welcome, Ana' })
    expect(report(run)).toContain('greeting')
  })

  test('maps exit codes when no run_end arrived', () => {
    const base = newRun('r', 'run', 'x', 'pane', 0)
    expect(finishRun(base, 1, 1000).status).toBe('error')
    expect(finishRun({ ...base, steps: [{ n: 1, status: 'failed', text: 'x' }] }, 1, 1000).status).toBe('failed')
    expect(finishRun(base, 2, 1000).status).toBe('error')
    expect(finishRun(base, 3, 1000).status).toBe('cancelled')
  })

  test('timeout in run_end reads as cancelled', () => {
    const run = applyEvent(newRun('r', 'run', 'x', 'pane', 0), { type: 'run_end', status: 'failed', reason: 'Timeout after 300s' })
    expect(run.status).toBe('cancelled')
  })

  test('testmd steps and done; per-step run_end is ignored', () => {
    let run = newRun('t', 'testmd', 'login_test.md', 'pane', 0)
    run = applyEvent(run, { type: 'test_md_step_start', step_index: 0, heading: 'Open site' })
    run = applyEvent(run, { type: 'run_end', status: 'failed' })
    run = applyEvent(run, { type: 'test_md_step_end', step_index: 0, status: 'passed' })
    run = applyEvent(run, { type: 'test_md_done', overall_status: 'passed', duration_s: 12 })
    expect(run.steps).toEqual([{ n: 1, status: 'passed', text: 'Open site' }])
    expect(run.status).toBe('passed')
  })

  test('testrun members become rows', () => {
    let run = newRun('s', 'testrun', 'suite', 'pane', 0)
    run = applyEvent(run, { type: 'testrun_plan', members: [{ path: 'a_test.md' }, { path: 'b_test.md' }], valid: true })
    run = applyEvent(run, { type: 'testrun_member_end', path: 'b_test.md', status: 'failed' })
    run = applyEvent(run, { type: 'testrun_done', overall_status: 'failed' })
    expect(run.steps.map(s => s.status)).toEqual(['pending', 'failed'])
    expect(run.status).toBe('failed')
  })

  test('argv, args and parsers', () => {
    expect(runArgs({ objective: 'go', url: 'https://a.b', headless: true, variables: { u: { value: 'x' } } })).toEqual([
      'run', 'go', '--agent', '--url', 'https://a.b', '--headless', '--variables', '{"u":{"value":"x"}}',
    ])
    expect(parseRunArgs('https://x.io log in')).toEqual({ url: 'https://x.io', objective: 'log in' })
    expect(parseRunArgs('just do it')).toEqual({ objective: 'just do it' })
    expect(parseTests('noise\n{"path":"a_test.md","name":"a","tags":["smoke"],"synced":false,"has_meta":true}\n')[0]?.tags).toEqual(['smoke'])
    expect(parseConfig('{"profile":"w","project_id":null,"final_validation":false,"network_ws":true}')).toEqual({ profile: 'w', final_validation: 'off', network_ws: 'on' })
  })
})

/** What the engine would answer beneath the plugin during a session. */
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__kane-qe__${e.name}` } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.copy', () => ({ value: { isCopied: true } }) as never)
  on('prompt.submit', () => ({}) as never)
  on('prompt.fill', () => ({ value: { isFilled: true } }) as never)
  return clock
}

describe('engine', () => {
  test('kane_run streams into the pane and answers the model', { timeoutMs: 15_000 }, async ($, on) => {
    const spawned: string[][] = []
    on('process.run', ($, e) => fakeKane(e.argv))
    on('process.spawn', async function* ($, e) {
      spawned.push([...e.argv])
      yield { stream: 'stdout' as const, text: RUN_STREAM.slice(0, 120) }
      yield { stream: 'stdout' as const, text: RUN_STREAM.slice(120) }
      return { value: { code: 0, signal: null } }
    })

    world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

    const answer = await $.tool.call({ tool: 'mcp__kane-qe__kane_run', objective: 'Log in and assert Welcome', url: 'https://app.test' } as never)
    expect(String((answer as { result?: unknown }).result)).toContain('PASSED')
    expect(String((answer as { result?: unknown }).result)).toContain('Welcome, Ana')
    expect(spawned[0]).toEqual(['kane-cli', 'run', 'Log in and assert Welcome', '--agent', '--url', 'https://app.test', '--headless', '--timeout', '600'])

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({
        plugin: 'kane-qe',
        surface,
        component: 'Pane',
        requestId: 'kane-qe',
        props: { title: 'Kane QE', isFocused: true, bodyColumns: 80, placement: 'dock' },
        viewport: { columns: 80, rows: 40 },
      } as never)
      expect(await ui.find({ text: /PASSED/ })).toBeDefined()
      expect(await ui.find({ text: /Asserted dashboard greeting/ })).toBeDefined()
      await ui.press({ key: 'tab-history' })
      expect(await ui.find({ text: /1\/1 passed/ })).toBeDefined()
      await ui.press({ key: 'tab-tests' })
      expect(await ui.find({ text: /login/ })).toBeDefined()
      await ui.press({ key: 'tab-run' })
      await ui.unmount()
    }
  })

  test('a failed run offers triage, and a missing binary is reported', { timeoutMs: 15_000 }, async ($, on) => {
    on('process.run', () => {
      throw new Error('ENOENT')
    })
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: line({ step: 1, status: 'failed', remark: 'Button not found' }) + '\n' }
      return { value: { code: 1, signal: null } }
    })
    world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    const answer = await $.tool.call({ tool: 'mcp__kane-qe__kane_run', objective: 'Click Buy' } as never)
    expect(String((answer as { result?: unknown }).result)).toContain('FAILED')

    const ui = await $.ui.mount({
      plugin: 'kane-qe',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'kane-qe',
      props: { title: 'Kane QE', isFocused: true, bodyColumns: 80, placement: 'dock' },
      viewport: { columns: 80, rows: 40 },
    } as never)
    expect(await ui.find({ key: 'run-triage' })).toBeDefined()
    await ui.press({ key: 'tab-setup' })
    expect(await ui.find({ text: /Could not start/ })).toBeDefined()
    expect(await ui.find({ key: 's-install' })).toBeDefined()
    await ui.unmount()
  })

  test('mirrors a kane-cli run started elsewhere, live, into the pane and history', { timeoutMs: 15_000 }, async ($, on) => {
    const clock = world(on)
    mock.env(on, { HOME: '/home/qa' })
    const active = '/home/qa/.testmuai/kaneai/sessions/active'
    const dir = '/home/qa/.testmuai/kaneai/sessions/2026-10-05_10-00-00_ab12'
    const files: Record<string, string> = {
      [`${active}/777.json`]: JSON.stringify({ pid: 777, cwd: '/work/shop', surface: 'run', session_dir: dir, started: '2026-10-05T10:00:00Z', cli_version: '0.8.20', host_agent: 'cursor' }),
      [`${dir}/tui.log`]: 'RUN 1 START objective="Add a hoodie to the cart and assert the badge shows 1" url=https://shop.test\n',
      [`${dir}/events.ndjson`]: line({ type: 'stream_start', surface: 'run', pid: 777 }) + '\n' + line({ step: 1, status: 'done', remark: 'Opened shop' }) + '\n',
    }
    let isAlive = true
    on('fs.exists', ($, e) => ({ value: e.path in files || e.path === active }) as never)
    on('fs.list', () => ({ value: Object.keys(files).filter(f => f.startsWith(active + '/')).map(f => ({ name: f.slice(active.length + 1), kind: 'file', size: 1 })) }) as never)
    on('fs.read', ($, e) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }) as never)
    on('fs.stat', ($, e) => (e.path in files ? { value: { kind: 'file', size: files[e.path]!.length, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }) as never)
    on('process.run', ($, e) => {
      if (e.argv[0] === 'kill') return OK('', isAlive ? 0 : 1)
      return fakeKane(e.argv)
    })
    on('process.spawn', async function* () {
      return { value: { code: 0, signal: null } }
    })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

    await clock.advance(2000)
    await clock.settle()
    const ui = await $.ui.mount({
      plugin: 'kane-qe',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'kane-qe',
      props: { title: 'Kane QE', isFocused: true, bodyColumns: 100, placement: 'dock' },
      viewport: { columns: 100, rows: 40 },
    } as never)
    expect(await ui.find({ text: /RUNNING/ })).toBeDefined()
    expect(await ui.find({ text: /hoodie/ })).toBeDefined()
    expect(await ui.find({ text: /via cursor in shop/ })).toBeDefined()
    expect(await ui.find({ text: /Opened shop/ })).toBeDefined()

    // The run finishes: a verdict lands, the pointer goes away, the process exits.
    files[`${dir}/events.ndjson`] += line({ step: 2, status: 'done', remark: 'Badge shows 1' }) + '\n' + line({ type: 'run_end', status: 'passed', one_liner: 'Hoodie added, badge 1', duration: 33 }) + '\n'
    delete files[`${active}/777.json`]
    isAlive = false
    await clock.advance(2000)
    await clock.settle()
    expect(await ui.find({ text: /PASSED/ })).toBeDefined()
    expect(await ui.find({ text: /Hoodie added, badge 1/ })).toBeDefined()
    await ui.press({ key: 'tab-history' })
    expect(await ui.find({ text: /1\/1 passed/ })).toBeDefined()
    expect(await ui.find({ key: 'h-rerun-0' })).toBeDefined()
    await ui.unmount()
  })

  test('a model kane_run draws as an interactive card in the transcript', { timeoutMs: 15_000 }, async ($, on) => {
    world(on)
    on('process.run', ($, e) => fakeKane(e.argv))
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: RUN_STREAM }
      return { value: { code: 0, signal: null } }
    })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'mcp__kane-qe__kane_run', tool_use_id: 'toolu_1', objective: 'Log in and assert Welcome' } as never)

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const card = await $.ui.mount({
        plugin: 'kane-qe',
        surface,
        component: 'ToolUse',
        requestId: 'toolu_1',
        props: { tool_use_id: 'toolu_1', tool: 'mcp__kane-qe__kane_run', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
        viewport: { columns: 100, rows: 40 },
      } as never)
      expect(await card.find({ text: /Kane run · PASSED/ })).toBeDefined()
      expect(await card.find({ text: /greeting = Welcome, Ana/ })).toBeDefined()
      expect(await card.find({ key: 'card-code' })).toBeDefined()
      expect(await card.find({ key: 'card-rerun' })).toBeDefined()
      await card.press({ key: 'card-open' })
      await card.unmount()
    }
    // A row for some other call is left to the engine.
    const other = await $.ui.mount({
      plugin: 'kane-qe',
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'toolu_1',
      props: { tool: 'mcp__kane-qe__kane_run', output: 'x', isErrored: false },
    } as never)
    expect(await other.find({ text: /full report handed to Claude/ })).toBeDefined()
    await other.unmount()
  })

  test('/kane routes what was typed: objective runs, vague objective is coached, tabs open', { timeoutMs: 15_000 }, async ($, on) => {
    const clock = world(on)
    const spawned: string[][] = []
    on('process.run', ($, e) => fakeKane(e.argv))
    on('process.spawn', async function* ($, e) {
      spawned.push([...e.argv])
      yield { stream: 'stdout' as const, text: RUN_STREAM }
      return { value: { code: 0, signal: null } }
    })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

    const ran = await $.command.run({ command: 'kane', args: 'run search headphones on https://shop.test and assert 3 results show' } as never)
    expect(String(ran.text)).toContain('Kane run started')
    await clock.settle()

    const held = await $.command.run({ command: 'kane', args: 'suggest best headphones' } as never)
    expect(String(held.text)).toContain('Held before running')
    const pane = await $.ui.mount({
      plugin: 'kane-qe',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'kane-qe',
      props: { title: 'Kane QE', isFocused: true, bodyColumns: 100, placement: 'inline' },
      viewport: { columns: 100, rows: 40 },
    } as never)
    expect(await pane.find({ text: /No check in this objective/ })).toBeDefined()
    expect(await pane.find({ key: 'coach-claude' })).toBeDefined()
    expect(await pane.find({ key: 'run-headed' })).toBeUndefined()
    expect(spawned.length).toBe(1)
    await pane.press({ key: 'coach-run' })
    await clock.settle()
    expect(spawned.length).toBe(2)
    expect(spawned[1]).toContain('suggest best headphones')
    expect(await pane.find({ key: 'run-ci' })).toBeDefined()

    await $.command.run({ command: 'kane', args: 'history' } as never)
    expect(await pane.find({ text: /passed/ })).toBeDefined()
    expect(await pane.find({ key: 'h-report' })).toBeDefined()
    const help = await $.command.run({ command: 'kane', args: 'help' } as never)
    expect(String(help.text)).toContain('/kane path/to/name_test.md')
    await pane.unmount()
  })

  test('a new run replaces the finished one shown in the cockpit', { timeoutMs: 15_000 }, async ($, on) => {
    world(on)
    on('process.run', ($, e) => fakeKane(e.argv))
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: RUN_STREAM }
      return { value: { code: 0, signal: null } }
    })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'mcp__kane-qe__kane_run', tool_use_id: 't1', objective: 'find feature of testmu.ai and assert it shows' } as never)
    await $.tool.call({ tool: 'mcp__kane-qe__kane_run', tool_use_id: 't2', objective: 'search headphones and assert results show' } as never)
    const pane = await $.ui.mount({
      plugin: 'kane-qe',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'kane-qe',
      props: { title: 'Kane QE', isFocused: true, bodyColumns: 100, placement: 'dock' },
      viewport: { columns: 100, rows: 40 },
    } as never)
    expect(await pane.find({ text: /search headphones and assert results show/ })).toBeDefined()
    expect(await pane.find({ text: /find feature of testmu/ })).toBeUndefined()
    await pane.press({ key: 'tab-history' })
    expect(await pane.find({ text: /2\/2 passed/ })).toBeDefined()
    expect(await pane.find({ text: /find feature of testmu/ })).toBeDefined()
    await pane.unmount()
  })

  test('a running card offers Stop (not Rerun) and the cockpit form follows the run', { timeoutMs: 15_000 }, async ($, on) => {
    const clock = world(on)
    on('process.run', ($, e) => fakeKane(e.argv))
    let finish = () => {}
    const finished = new Promise<void>(resolve => (finish = resolve))
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: line({ step: 1, status: 'running', remark: 'Open shop' }) + '\n' }
      await finished
      return { value: { code: 0, signal: null } }
    })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    const call = $.tool.call({ tool: 'mcp__kane-qe__kane_run', tool_use_id: 'live', objective: 'search iPod and assert results show', url: 'https://shop.test' } as never)
    await clock.settle()
    const card = await $.ui.mount({
      plugin: 'kane-qe',
      surface: 'terminal',
      component: 'ToolUse',
      requestId: 'live',
      props: { tool_use_id: 'live', tool: 'mcp__kane-qe__kane_run', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
      viewport: { columns: 100, rows: 40 },
    } as never)
    expect(await card.find({ text: /RUNNING/ })).toBeDefined()
    expect(await card.find({ key: 'card-stop' })).toBeDefined()
    expect(await card.find({ key: 'card-rerun' })).toBeUndefined()
    const pane = await $.ui.mount({
      plugin: 'kane-qe',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'kane-qe',
      props: { title: 'Kane QE', isFocused: true, bodyColumns: 80, placement: 'dock' },
      viewport: { columns: 80, rows: 40 },
    } as never)
    expect(await pane.find({ key: 'url' })).toBeDefined()
    expect(await pane.find({ text: /Tab move · Enter press/ })).toBeDefined()
    finish()
    await call
    await card.unmount()
    await pane.unmount()
  })

  test('a run with no URL gets the configured default; one kane refuses to start is a setup error', { timeoutMs: 15_000 }, async ($, on) => {
    world(on)
    const spawned: string[][] = []
    on('process.run', ($, e) => (e.argv.slice(1).join(' ').startsWith('config show') ? OK(JSON.stringify({ default_url: 'https://default.test' })) : fakeKane(e.argv)))
    on('process.spawn', async function* ($, e) {
      spawned.push([...e.argv])
      yield { stream: 'stdout' as const, text: line({ type: 'run_end', status: 'failed', reason: 'No start URL provided.', credits_consumed: 0 }) + '\n' }
      return { value: { code: 1, signal: null } }
    })
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    const answer = await $.tool.call({ tool: 'mcp__kane-qe__kane_run', objective: 'open and assert the title' } as never)
    expect(spawned[0]?.slice(-2)).toEqual(['--url', 'https://default.test'])
    expect(String((answer as { result?: unknown }).result)).toContain('ERROR')
  })
})

describe('entry point', () => {
  test('routeKane reads intent from free text', () => {
    expect(routeKane('')).toEqual({ kind: 'home' })
    expect(routeKane('history')).toEqual({ kind: 'tab', tab: 'history' })
    expect(routeKane('run')).toEqual({ kind: 'tab', tab: 'run' })
    expect(routeKane('run suggest best headphones')).toEqual({ kind: 'run', objective: 'suggest best headphones' })
    expect(routeKane('https://x.io log in and assert ok')).toEqual({ kind: 'run', objective: 'log in and assert ok', url: 'https://x.io' })
    expect(routeKane('.testmuai/tests/login_test.md')).toEqual({ kind: 'test', path: '.testmuai/tests/login_test.md' })
    expect(routeKane('replay login_test.md')).toEqual({ kind: 'test', path: 'login_test.md' })
    expect(routeKane('suite --tags smoke --parallel 3')).toEqual({ kind: 'suite', args: ['--tags', 'smoke', '--parallel', '3'] })
    expect(routeKane('triage')).toEqual({ kind: 'triage' })
    expect(routeKane('cases checkout with coupons')).toEqual({ kind: 'cases', feature: 'checkout with coupons' })
    expect(routeKane('which tests failed twice?')).toEqual({ kind: 'ask', text: 'which tests failed twice?' })
    expect(routeKane('stop')).toEqual({ kind: 'stop' })
    expect(routeKane('test that login works and assert welcome')).toEqual({ kind: 'run', objective: 'test that login works and assert welcome' })
  })

  test('coach flags objectives that verify nothing or use unset variables', () => {
    expect(needsCoaching(coachObjective('suggest best headphones'))).toBe(true)
    expect(needsCoaching(coachObjective('search headphones and assert 3 results show'))).toBe(false)
    expect(needsCoaching(coachObjective("store the price as 'price'"))).toBe(false)
    expect(coachObjective('log in as {{user}} with {{secrets.pw}} and verify welcome').variables).toEqual(['user'])
  })

  test('CI command is headless, NDJSON and authenticated from pipeline secrets', () => {
    expect(ciCommand(['run', "add item and assert it's in cart", '--agent', '--url', 'https://s.io'])).toBe(
      `kane-cli run 'add item and assert it'\\''s in cart' --agent --url https://s.io --headless --username "$LT_USERNAME" --access-key "$LT_ACCESS_KEY"`,
    )
  })
  test('login state trusts a working balance over a stale whoami; identity and credits read cleanly', () => {
    expect(resolveAuth(1, 0)).toBe('ok')
    expect(resolveAuth(1, 1)).toBe('none')
    expect(resolveAuth(3, 1)).toBe('unreachable')
    expect(resolveAuth(0, undefined)).toBe('ok')
    const box = '│  Profile       default  │\n│  Method        oauth    │\n│  User          qa-lead  │\n│  Token         valid    │'
    expect(describeIdentity(parseWhoami(box))).toBe('qa-lead · oauth · token valid')
    expect(describeBalance('Available credits: 838.6522\nTotal credits: 1200')).toBe('838.65 of 1200 credits left')
  })
  test('narrow-pane helpers: tidy steps, short URLs, history merge', () => {
    expect(tidyStep('wait: PRIMARY: wait 1000 ms')).toBe('wait: wait 1000 ms')
    expect(tidyStep('wait: queued plan (2 steps): click A; click B')).toBe('wait: plan: click A; click B')
    expect(shortUrl('https://shop.io/index.php?route=product%2Fsearch&search=iPod')).toBe('shop.io/index.php?route=product/search&search=iPod')
    expect(shortUrl('not a url')).toBe('not a url')
    const a = [{ id: 'a', endedAt: 3 }, { id: 'b', endedAt: 1 }]
    const b = [{ id: 'b', endedAt: 1 }, { id: 'c', endedAt: 2 }]
    expect(mergeHistory(a, b).map(x => x.id)).toEqual(['a', 'c', 'b'])
  })
  test('fitSteps keeps the newest steps that fit the rows left', () => {
    const steps = [{ text: 'a'.repeat(50) }, { text: 'b'.repeat(50) }, { text: 'c'.repeat(10) }]
    expect(fitSteps(steps, 20, 4).map(s => s.text[0])).toEqual(['b', 'c'])
    expect(fitSteps(steps, 200, 10).length).toBe(3)
    expect(fitSteps(steps, 20, 0).length).toBe(1)
  })
})
