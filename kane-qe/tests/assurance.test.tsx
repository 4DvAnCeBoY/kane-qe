import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  designedTestId,
  answerArgs,
  applyAssureEvent,
  countNodes,
  describeTestStatus,
  finishJob,
  newJob,
  parseContextList,
  parseDevices,
  parseDoctor,
  parsePluginDoctor,
  parseSessions,
  splitWords,
  viewerUrl,
} from '../hooks/assurance'
import { attribute, consoleSignature, repeatedActions, siteGroups } from '../hooks/insights'
import { applyEvent, ciCommand, describeBalance, finishRun, kaneArgv, remoteFailure, tidyStep, newRun, routeKane, runArgs, suiteArgs } from '../hooks/kane'
import type { RunInsights, StepInsight } from '../types'

// Captured from kane-cli 0.8.x: `context extract --mode agent` over a one-page PRD (abridged).
const SID = 'ext-20261005T203311-prd-search'
const RESUME = `kane-cli context extract --resume ${SID} --mode agent`
const QUESTION = {
  id: 'q1',
  header: 'empty search',
  text: 'What should happen if a shopper submits the search box without a product name?',
  risk: 'med',
  rationale: 'The source describes entering a product name before Search (L5) and a no-match message (L7), but not an empty query.',
  options: [
    { label: 'Leave unspecified', detail: 'Extract only the documented named-product search.' },
    { label: 'Reject empty query', detail: 'An empty query should be blocked.' },
    { label: 'Show all products' },
    { label: 'Show no-match message' },
  ],
  recommended_index: 0,
  allow_free_text: true,
}
const EXTRACT_STREAM = [
  { type: 'run_start', v: 1, verb: 'extract', mode: 'agent', session: 'as-1' },
  { type: 'corpus', v: 1, verb: 'extract', sources: [{ source_id: 'prd-search' }], skipped: [] },
  { type: 'source_start', v: 1, verb: 'extract', source_id: 'prd-search', index: 1, total: 1, resumed: false },
  { type: 'agent_activity', v: 1, verb: 'extract', kind: 'tool', label: '→ search graph…' },
  { type: 'usage', v: 1, verb: 'extract', credits: 3.67, total_credits: 3.67 },
  { type: 'usage', v: 1, verb: 'extract', credits: 0.76, total_credits: 4.42 },
  { type: 'session_paused', v: 1, verb: 'extract', sid: SID, resume: RESUME, expires_at: '2026-10-06T20:33:11.513Z', pending_questions: [QUESTION] },
  { type: 'done', v: 1, verb: 'extract', status: 'paused', exit_code: 3, next: [{ cmd: RESUME, why: 'resume the paused session' }] },
]

describe('assurance stream', () => {
  test('a paused extract carries its question, options and resume command', () => {
    let job = newJob('j', 'Extract use cases', ['context', 'extract', '--mode', 'agent'], 0)
    for (const e of EXTRACT_STREAM) job = applyAssureEvent(job, e)
    expect(job.status).toBe('paused')
    expect(job.verb).toBe('extract')
    expect(job.credits).toBe(4.42)
    expect(job.questions.length).toBe(1)
    expect(job.questions[0]?.options.map(o => o.label)).toEqual(['Leave unspecified', 'Reject empty query', 'Show all products', 'Show no-match message'])
    expect(job.questions[0]?.recommended).toBe(0)
    expect(job.activity).toContain('→ search graph…')
    // Option 2 answers by its 1-based number on the resume command.
    expect(answerArgs(job, 'q1', '2')).toEqual(['context', 'extract', '--resume', SID, '--mode', 'agent', '--answer', 'q1=2'])
  })

  test('a completed answer commits use cases; a crash without done is settled by the exit code', () => {
    let job = newJob('j', 'Answer', [], 0)
    job = applyAssureEvent(job, { type: 'commit', verb: 'extract', derived: 2, minted: [{ logical_id: 'uc-search-a-product' }, { logical_id: 'uc-no-match' }] })
    job = applyAssureEvent(job, { type: 'session_complete', sid: SID })
    job = applyAssureEvent(job, { type: 'done', status: 'complete', exit_code: 0 })
    expect(job.status).toBe('complete')
    expect(job.committed).toEqual(['uc-search-a-product', 'uc-no-match'])
    const crashed = finishJob(newJob('k', 'Design', [], 0), 1, 10, 'Skill update available: …\nerror: design gate refused\n')
    expect(crashed.status).toBe('error')
    expect(crashed.errors).toEqual(['error: design gate refused'])
  })

  test('evolve answers by re-running its own command', () => {
    const job = { argv: ['maintain', 'evolve', '--from-stale', '--mode', 'agent'], verb: 'evolve' as const, sid: undefined, resume: undefined }
    expect(answerArgs(job, 'evolve:uc-3', '1')).toEqual(['maintain', 'evolve', '--from-stale', '--mode', 'agent', '--answer', 'evolve:uc-3=1'])
  })

  test('store reads: sessions, nodes and command lines', () => {
    const sessions = parseSessions(`{"sid":"${SID}","mode":"agent","pendingCount":1,"verb":"extract","resume":"${RESUME}","expires_at":"2026-10-06T20:33:11.513Z"}\n`)
    expect(sessions).toEqual([{ sid: SID, verb: 'extract', pending: 1, resume: RESUME, expiresAt: '2026-10-06T20:33:11.513Z' }])
    const nodes = parseContextList(
      [
        '{"id":"prd-search","cid":"sha256:52dc","label":"source","title":"prd-search","trust":"-","fresh":"fresh"}',
        '{"id":"uc-search-a-product","label":"usecase","title":"Search for a product","trust":"derived","fresh":"fresh"}',
        '{"id":"uc-open-result","label":"usecase","title":"Open a result","trust":"trusted","fresh":"stale"}',
      ].join('\n'),
    )
    expect(countNodes(nodes)).toEqual({ sources: 1, useCases: 2, trusted: 1, derived: 1, stale: 1 })
    expect(designedTestId('---\nassurance:\n  id: t-1\n  base: sha256:a9e1\n---\n# Matching search')).toBe('t-1')
    expect(designedTestId('---\nname: login\n---\n# Login')).toBeUndefined()
    expect(splitWords('kane-cli testrun run --match "^tests/app/" --device-name "Pixel 7"')).toEqual(['kane-cli', 'testrun', 'run', '--match', '^tests/app/', '--device-name', 'Pixel 7'])
  })
})

describe('grid, devices, doctor, viewer', () => {
  test('reads what kane-cli prints for them', () => {
    expect(parseDevices('Skill update available\n\n{"name":"iPad (10th generation)","brand":"Apple","os_versions":["17.5","18.0"]}\n')).toEqual([{ name: 'iPad (10th generation)', osVersions: ['17.5', '18.0'] }])
    expect(parsePluginDoctor('{"type":"plugin_doctor","name":"remote-execution","checks":[{"id":"installed","ok":false,"level":"error"}]}')).toBe('missing')
    expect(parsePluginDoctor('{"type":"plugin_doctor","name":"remote-execution","checks":[{"id":"installed","ok":true}]}')).toBe('ok')
    const doctor = parseDoctor(
      [
        'Ios toolchain',
        ' ✗ Xcode — /Library/Developer/CommandLineTools has no usable xcodebuild (Command Line Tools only?)',
        '     fix: Install full Xcode from the App Store.',
        ' ✓ Node — v22',
      ].join('\n'),
    )
    expect(doctor).toEqual([
      { ok: false, name: 'Xcode', detail: '/Library/Developer/CommandLineTools has no usable xcodebuild (Command Line Tools only?)', fix: 'Install full Xcode from the App Store.' },
      { ok: true, name: 'Node', detail: 'v22' },
    ])
    expect(viewerUrl('serving 1 pack on http://127.0.0.1:50262\n  viewer  https://evidence.lambdatest.com/?pack=http%3A%2F%2F127.0.0.1\npress Ctrl-C')).toBe('https://evidence.lambdatest.com/?pack=http%3A%2F%2F127.0.0.1')
    expect(describeTestStatus('{"path":"/p/sab_kuch_test.md","name":"sab_kuch","has_meta":false}')).toBe('sab_kuch: not recorded yet (run it once to author it)')
  })

  test('remote and device flags, and the grid events of a remote suite', () => {
    expect(suiteArgs({ tags: 'smoke', remote: true, parallel: 4, headless: true, deviceName: 'Pixel 7', osVersion: '14' })).toEqual([
      'testrun', 'run', '--tags', 'smoke', '--parallel', '4', '--remote', '--device-name', 'Pixel 7', '--os-version', '14',
    ])
    expect(runArgs({ objective: 'Add the first item', target: 'emulator', app: './app.apk', deviceName: 'Pixel 7', osVersion: '15' })).toEqual([
      'run', 'Add the first item', '--agent', '--target', 'emulator', '--device-name', 'Pixel 7', '--os-version', '15', '--app', './app.apk',
    ])
    expect(tidyStep('/Users/qa/proj/.testmuai/tests/search_test.md')).toBe('search_test.md')
    // kane-cli 0.8 refuses --agent on testrun; old history entries still carry it.
    expect(kaneArgv(['testrun', 'run', '--agent', '--tags', 'smoke'])).toEqual(['testrun', 'run', '--tags', 'smoke'])
    expect(ciCommand(['testrun', 'run', '--tags', 'smoke'])).not.toContain('--agent')
    let run = newRun('r', 'testrun', 'suite · grid', 'pane', 0)
    run = applyEvent(run, { type: 'remote_start', backend: 'hyper' })
    run = applyEvent(run, { type: 'remote_device', platform: 'android', name: 'Pixel 7', os_version: '14' })
    run = applyEvent(run, { type: 'remote_dispatched', job_id: '24fc58b2', job_url: 'https://hyperexecute.lambdatest.com/hyperexecute/task?jobId=24fc58b2' })
    expect(run.device).toBe('Pixel 7 14')
    expect(run.remoteJob?.url).toContain('jobId=24fc58b2')
    run = applyEvent(run, { type: 'remote_done', status: 'passed', exit: 0, job_id: '24fc58b2' })
    expect(run.status).toBe('passed')
    // A refused dispatch: no job id, members end broken, the reason is only in the HyperExecute log.
    let refused = applyEvent(newRun('r3', 'testrun', 'designed', 'pane', 0), { type: 'testrun_plan', members: [{ path: '/p/.testmuai/tests/search_test.md' }] })
    refused = applyEvent(refused, { type: 'remote_start', backend: 'hyper', log_path: '/jobs/cc8e/hyper.log' })
    refused = applyEvent(refused, { type: 'remote_dispatched', job_id: '', job_url: '' })
    refused = applyEvent(refused, { type: 'testrun_authored_member_end', path: '.testmuai/tests/search_test.md', status: 'broken' })
    expect(refused.remoteJob).toEqual({ log: '/jobs/cc8e/hyper.log' })
    expect(refused.steps).toEqual([{ n: 1, status: 'broken', text: '/p/.testmuai/tests/search_test.md' }])
    expect(remoteFailure("Dispatch attempt returned status 200\nError: ERR::DIS::RESP     Unable to dispatch job. You're currently on Free trial plan and will need MultiOS plan to run this on mac.\n")).toBe(
      "Unable to dispatch job. You're currently on Free trial plan and will need MultiOS plan to run this on mac.",
    )
    run = applyEvent(newRun('r2', 'testrun', 'x', 'pane', 0), { type: 'remote_error', code: 'mobile_remote_mixed', detail: 'web and device members cannot share a job' })
    expect(run.errors[0]).toBe('web and device members cannot share a job [mobile_remote_mixed]')
  })

  test('a suite row follows its member live: the latest step shows under it', () => {
    const M = '/p/.testmuai/tests/search_test.md'
    let run = applyEvent(newRun('s', 'testrun', 'suite', 'pane', 0), { type: 'testrun_plan', members: [{ path: M }] })
    run = applyEvent(run, { type: 'testrun_authored_member_start', path: M, log_path: '/s/m1/events.ndjson' })
    expect(run.steps[0]).toEqual({ n: 1, status: 'running', text: M, log: '/s/m1/events.ndjson' })
    run = applyEvent(run, { type: 'testrun_member_event', member: { index: 0, path: '.testmuai/tests/search_test.md' }, event: { type: 'step_start', index: 2 } })
    expect(run.steps[0]?.detail).toBe('step 2 …')
    run = applyEvent(run, { type: 'testrun_member_event', member: { index: 0, path: '.testmuai/tests/search_test.md' }, event: { type: 'step_end', index: 2, status: 'passed', summary: 'PRIMARY: click: Search' } })
    expect(run.steps[0]?.detail).toBe('step 2 ✓ click: Search')
    run = applyEvent(run, { type: 'testrun_authored_member_end', path: '.testmuai/tests/search_test.md', status: 'passed' })
    expect(run.steps[0]?.status).toBe('passed')
    expect(run.steps[0]?.detail).toBeUndefined()
  })

  test('running out of credits is an account error, not a failed test', () => {
    let run = applyEvent(newRun('c', 'run', 'heading', 'model', 0), { step: 2, status: 'running', remark: 'Step 1' })
    run = applyEvent(run, { type: 'run_end', status: 'failed', reason: 'Credits exhausted: {"error":"insufficient credits"}', credits_consumed: 8.27 })
    run = finishRun(run, 1, 10)
    expect(run.status).toBe('error')
    expect(run.oneLiner).toContain('Out of KaneAI credits')
    expect(run.steps.every(st => st.status !== 'running')).toBe(true)
  })

  test('an overdrawn balance is shown, not dropped', () => {
    expect(describeBalance('Available credits: -2.894\nTotal credits:     1200\n')).toBe('out of credits (-2.89 of 1200): top up before running')
    expect(describeBalance('Available credits: 44.6782\nTotal credits:     1200\n')).toBe('44.68 of 1200 credits left')
  })

  test('an empty suite says why instead of failing silently', () => {
    const run = applyEvent(newRun('e', 'testrun', 'suite', 'pane', 0), { type: 'testrun_plan', members: [], valid: false })
    expect(run.errors[0]).toContain('No saved *_test.md tests matched')
  })

  test('/kane routes the assurance and grid words', () => {
    expect(routeKane('assure')).toEqual({ kind: 'tab', tab: 'assure' })
    expect(routeKane('ingest ./docs/prd.md')).toEqual({ kind: 'ingest', source: './docs/prd.md' })
    expect(routeKane('grid --tags smoke')).toEqual({ kind: 'suite', args: ['--tags', 'smoke', '--remote'] })
  })
})

describe('exploring a site', () => {
  test('history groups by site: scenarios with pass counts, pages reached', () => {
    const h = (id: string, label: string, status: string, url: string, endedAt: number, sessionDir?: string) => ({ id, label, status, endedAt, credits: 10, rerun: ['run', label, '--agent', '--url', url], sessionDir })
    const groups = siteGroups(
      [
        h('3', 'Search iPod and assert results', 'failed', 'https://ecommerce-playground.lambdatest.io', 3000),
        h('2', 'Search iPod and assert results', 'passed', 'https://ecommerce-playground.lambdatest.io', 2000, '/s/2'),
        h('1', 'Add to cart and assert count 1', 'passed', 'https://www.amazon.in', 1000),
      ],
      { '/s/2': { data: { host: 'ecommerce-playground.lambdatest.io', steps: [{ url: 'https://ecommerce-playground.lambdatest.io/index.php?route=product/search&search=iPod' }, { url: 'https://ecommerce-playground.lambdatest.io/' }] } } },
    )
    expect(groups.map(g => g.host)).toEqual(['ecommerce-playground.lambdatest.io', 'amazon.in'])
    expect(groups[0]).toMatchObject({ runs: 2, passed: 1, failed: 1, credits: 20 })
    expect(groups[0]?.scenarios).toHaveLength(1)
    expect(groups[0]?.scenarios[0]).toMatchObject({ passed: 1, failed: 1 })
    expect(groups[0]?.pages).toEqual(['/index.php?route=product/search', '/'])
  })
})

describe('repeated actions', () => {
  const st = (n: number, kind: string, summary: string) =>
    ({ n, kind, status: 'passed', ms: 6900, summary, modelMs: 0, browserMs: 0, requests: 0, failedRequests: 0, httpIssues: [], consoleErrors: 0, consoleWarnings: 0, consoleSamples: [], isUnchanged: false, isRelevant: false, isCulprit: false }) as StepInsight
  test('the same target clicked twice in other words is flagged; different targets are not', () => {
    expect(repeatedActions([st(13, 'click', 'click: Clicking Guest Checkout option'), st(14, 'click', 'click: PRIMARY: Guest Checkout option; role=radio; text="Guest Checkout"')])).toEqual([
      'Steps 13–14: the same click twice (guest checkout), 6.9s on the repeat',
    ])
    // Real runs: the search button then a result, and a link then the form's button, are two actions.
    expect(repeatedActions([st(4, 'click', 'click: Click "SEARCH"'), st(5, 'click', 'click: Clicking the iPod Nano product link from the first search result')])).toEqual([])
    expect(repeatedActions([st(5, 'click', 'click: Clicking Continue registration link'), st(6, 'click', 'click: Clicking Continue button in the registration form')])).toEqual([])
  })
})

describe('attribution on a noisy site', () => {
  const step = (n: number, over: Partial<StepInsight>): StepInsight => ({
    n, kind: 'click', status: 'passed', ms: 1000, summary: `step ${n}`, modelMs: 0, browserMs: 0, requests: 10, failedRequests: 0,
    httpIssues: [], consoleErrors: 0, consoleWarnings: 0, consoleSamples: [], isUnchanged: false, isRelevant: false, isCulprit: false, ...over,
  })
  const base = (steps: StepInsight[], issues: RunInsights['httpIssues']): Omit<RunInsights, 'attribution'> => ({
    sessionDir: '/s', label: 'amazon', status: 'failed', durationMs: 1, credits: 40, steps, requests: 100, failedRequests: 2, httpIssues: issues,
    consoleErrors: steps.reduce((a, s) => a + s.consoleErrors, 0), consoleWarnings: 0, loopSignals: [], modelMs: 0, browserMs: 0, vitals: {},
    verdict: { family: 'automation_bug', category: 'agent_misstep', confidence: 0.97, title: 'Agent selected an unavailable delivery location', relevantSteps: [5, 12] },
  })
  const bom = (s: number) => ({ step: s, status: 404, url: `https://www.amazon.com/gp/product/ajax/billOfMaterial?ref=bom&x=${s}`, isFirstParty: true, isSuspicious: false })

  test('errors the page was already logging before the failure do not make it a product question', () => {
    // Amazon: the same 404 at step 6 and step 12; every console error at the failing steps was seen earlier.
    const steps = [step(1, { consoleErrors: 3, consoleNew: 3 }), step(5, { consoleErrors: 13, consoleNew: 0, isRelevant: true }), step(6, { consoleErrors: 15, consoleNew: 1, httpIssues: [bom(6)] }), step(12, { consoleErrors: 14, consoleNew: 0, isRelevant: true, isCulprit: true, httpIssues: [bom(12)] })]
    const a = attribute(base(steps, [bom(6), bom(12)]))
    expect(a.kind).toBe('automation')
    expect(a.evidence.join('\n')).toContain('Ignored as background noise: 1 HTTP error the same endpoint already returned before the failure; 27 console errors the page was already logging earlier')
  })

  test('the same console error on another page has the same signature; a different property does not', () => {
    const csp = (policy: string) => `Loading the image 'https://target.digitalaudience.io/bakery' violates the following Content Security Policy directive: "default-src 'self' ${policy}"`
    expect(consoleSignature(csp('s.amazon-adsystem.com fonts.gstatic.com *.imdb.com'), 'https://s.amazon-adsystem.com/x')).toBe(
      consoleSignature(csp('aax-eu.amazon-adsystem.com *.firefox.etp m.media-amazon.com'), 'https://s.amazon-adsystem.com/y'),
    )
    expect(consoleSignature("TypeError: Cannot read properties of undefined (reading 'price')")).not.toBe(consoleSignature("TypeError: Cannot read properties of undefined (reading 'total')"))
  })

  test('a 500 where it failed is news even when the same endpoint 404ed earlier', () => {
    const e500 = { ...bom(12), status: 500 }
    const steps = [step(6, { httpIssues: [bom(6)] }), step(12, { isRelevant: true, isCulprit: true, httpIssues: [e500] })]
    expect(attribute(base(steps, [bom(6), e500])).kind).toBe('unclear')
  })

  test("a wrong test is named as such, not blamed on the model", () => {
    const steps = [step(3, { isRelevant: true, isCulprit: true })]
    const a = attribute({ ...base(steps, []), verdict: { family: 'automation_bug', category: 'test_data_issue', confidence: 0.98, title: 'Search fixture has no matching product', relevantSteps: [3] } })
    expect(a.kind).toBe('automation')
    expect(a.headline).toContain('The test itself is wrong')
    expect(attribute(base(steps, [])).headline).toContain('Likely the CLI loop or the model')
    const budget = attribute({ ...base(steps, []), reason: 'Maximum steps exceeded (9/8)', verdict: { family: 'automation_bug', category: 'config_issue', confidence: 0.96, relevantSteps: [3] } })
    expect(budget.headline).toContain("The run's settings stopped it")
  })

  test('a new error where it failed still needs a look', () => {
    const steps = [step(1, { consoleErrors: 3, consoleNew: 3 }), step(12, { consoleErrors: 4, consoleNew: 1, isRelevant: true, isCulprit: true })]
    expect(attribute(base(steps, [])).kind).toBe('unclear')
  })
})

// ── the cockpit ──────────────────────────────────────────────────────

const OK = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On, opts: { pluginOk?: boolean } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { HOME: '/home/qa', TMPDIR: '/tmp/' })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('tool.register', ($, e) => ({ value: { tool: `mcp__kane-qe__${e.name}` } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.copy', () => ({ value: { isCopied: true } }) as never)
  on('prompt.submit', () => ({}) as never)
  on('prompt.fill', () => ({ value: { isFilled: true } }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  on('fs.exists', () => ({ value: false }) as never)
  on('fs.read', () => ({ deny: 'ENOENT' }) as never)
  const calls: string[] = []
  on('process.run', ($, e) => {
    const cmd = e.argv.slice(1).join(' ')
    calls.push(cmd)
    if (cmd === '--version') return OK('0.8.21\n') as never
    if (cmd.startsWith('config show')) return OK('{"profile":"default","project_name":"Web"}') as never
    if (cmd === 'balance') return OK('Available credits: 120\nTotal credits: 500\n') as never
    if (cmd === 'context list --json')
      return OK('{"id":"prd-search","label":"source","title":"prd-search","trust":"-","fresh":"fresh"}\n{"id":"uc-search","label":"usecase","title":"Search for a product","trust":"derived","fresh":"fresh"}\n') as never
    if (cmd === 'context sessions --json') return OK(`{"sid":"${SID}","pendingCount":1,"verb":"extract","resume":"${RESUME}"}\n`) as never
    if (cmd === `context sessions show ${SID} --json`) return OK(JSON.stringify({ sid: SID, pending_questions: [QUESTION] })) as never
    if (cmd === 'cover gaps --json')
      return OK(JSON.stringify({ design_completeness: { pct: 0 }, usecases: [{ id: 'uc-search', title: 'Search for a product', risk: 'med', design_completeness: { pct: 0 }, pending: [{ why: 'use-case has no scenarios', ready_command: 'kane-cli design tests --use-case uc-search' }] }] })) as never
    if (cmd === 'plugin doctor remote-execution') return OK(`{"type":"plugin_doctor","checks":[{"id":"installed","ok":${opts.pluginOk ? 'true' : 'false'}}]}`) as never
    if (cmd === 'devices list --target simulator --remote --agent') return OK('{"name":"iPhone 15","os_versions":["17.5","18.0"]}\n{"name":"iPad Air","os_versions":["17.5"]}\n') as never
    if (cmd.startsWith('testmd list')) return OK('{"path":"tests/login_test.md","name":"login","tags":["smoke"],"has_meta":true}\n') as never
    return OK('') as never
  })
  const spawned: string[][] = []
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    if (e.argv.includes('--answer')) {
      yield { stream: 'stdout' as const, text: `${JSON.stringify({ type: 'commit', verb: 'extract', minted: [{ logical_id: 'uc-empty-search' }] })}\n${JSON.stringify({ type: 'done', status: 'complete', exit_code: 0 })}\n` }
    }
    return { value: { code: 0, signal: null } }
  })
  return { clock, calls, spawned }
}

const PANE = {
  plugin: 'kane-qe',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'kane-qe',
  props: { title: 'Kane QE', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 70 } },
  viewport: { columns: 100, rows: 70 },
}

describe('assurance and grid in the cockpit', () => {
  test('Assurance shows the loop, answers a paused question with one press, and designs a use case', { timeoutMs: 15_000 }, async ($, on) => {
    const { clock, spawned } = world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    await clock.settle()
    const pane = await $.ui.mount(PANE as never)
    await pane.press({ key: 'tab-assure' })
    await clock.settle()
    const has = async (name: string, q: object) => { if ((await pane.find(q as never)) === undefined) throw new Error(`missing: ${name}`) }
    await has('stage strip', { text: /✓ Ingest {2}→ {2}✓ Extract {2}→ {2}▸ Review/ })
    await has('counts', { text: /1 source · 1 use case \(0 trusted, 1 to review\) · designed 0% · nothing run yet/ })
    await has('paused session', { text: /Paused extract · 1 question waiting/ })
    await has('recommended option', { text: /1 Leave unspecified ★/ })
    await has('review', { key: 'as-review' })
    await has('approve', { key: 'uc-ok-uc-search' })
    await pane.press({ key: `sq-${SID}-q1-o1` })
    await clock.settle()
    expect(spawned[0]).toEqual(['kane-cli', 'context', 'extract', '--resume', SID, '--mode', 'agent', '--answer', 'q1=2'])
    await has('committed', { text: /Committed: uc-empty-search/ })
    await has('done', { text: /DONE · Answer: empty search/ })
    await pane.press({ key: 'uc-design-uc-search' })
    await clock.settle()
    expect(spawned[1]).toEqual(['kane-cli', 'design', 'tests', '--use-case', 'uc-search', '--mode', 'agent', '--allow-unreviewed'])
    await pane.unmount()
  })

  test('Tests runs a suite on the grid on a picked device, and offers the plugin when it is missing', { timeoutMs: 15_000 }, async ($, on) => {
    const { clock, spawned } = world(on)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
    await clock.settle()
    const pane = await $.ui.mount(PANE as never)
    await pane.press({ key: 'tab-tests' })
    await pane.press({ key: 'g-grid' })
    await clock.settle()
    expect(await pane.find({ key: 'g-install' })).toBeDefined()
    await pane.press({ key: 'g-t-simulator' })
    await clock.settle()
    expect(await pane.find({ text: /17\.5 · 18\.0/ })).toBeDefined()
    await pane.press({ key: 'dev-pick-0' })
    await pane.press({ key: 'os-17.5' })
    await pane.press({ key: 'tests-all' })
    await clock.settle()
    expect(spawned[0]).toEqual(['kane-cli', 'testrun', 'run', '--remote', '--device-name', 'iPhone 15', '--os-version', '17.5'])
    await pane.press({ key: 'tab-tests' })
    expect(await pane.find({ key: 't-sync-0' })).toBeDefined()
    await pane.unmount()
  })
})
