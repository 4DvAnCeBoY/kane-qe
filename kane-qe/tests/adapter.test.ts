import { describe, expect, test } from 'claude-code/testing'

import { adapt, splitLines } from '../hooks/adapter'

const L = (o: Record<string, unknown>) => JSON.stringify({ ...o, v: 1, ts: '2026-10-08T10:00:00.000Z' })
const AT = Date.parse('2026-10-08T10:00:00.000Z')

describe('the adapter: one wire line → internal events', () => {
  const cases: { name: string; line: string; want: unknown[] }[] = [
    { name: 'stream_start', line: L({ type: 'stream_start', cli_version: '0.8.20', surface: 'testmd', pid: 9 }), want: [{ k: 'start', surface: 'testmd', cli: '0.8.20', pid: 9, at: AT }] },
    { name: 'recording_state names the test file', line: L({ type: 'recording_state', session_id: 's', test_path: '/p/.testmuai/tests/login_test.md' }), want: [{ k: 'label', text: 'login_test.md', rank: 3, at: AT }] },
    { name: 'bifurcation gives the objective', line: L({ type: 'bifurcation', flows: ['Navigate to https://a.b then Add a hoodie to the cart\nmore'], count: 1 }), want: [{ k: 'label', text: 'Add a hoodie to the cart', rank: 2, at: AT }] },
    { name: 'a run step line has no type', line: L({ step: 3, status: 'done', remark: 'click: Clicking Submit' }), want: [{ k: 'step', n: 3, status: 'done', text: 'click: Clicking Submit', at: AT }] },
    { name: 'a sub-agent step is skipped', line: L({ step: 3, status: 'done', remark: 'x', child_id: 'c1' }), want: [] },
    { name: 'ask_user', line: L({ type: 'ask_user', question: 'Which account?', step_index: 2 }), want: [{ k: 'ask', question: 'Which account?', at: AT }] },
    { name: 'error', line: L({ type: 'error', message: 'Browser crashed' }), want: [{ k: 'error', message: 'Browser crashed', at: AT }] },
    {
      name: 'run_end takes the verdict first',
      line: L({ type: 'run_end', status: 'failed', one_liner: 'top', credits_consumed: 43.3, verdict: { root_cause: 'Back button hidden', one_liner: 'v', category: 'functional_defect', severity: 'major', confidence: 0.9 } }),
      want: [{ k: 'runEnd', status: 'failed', credits: 43.3, why: 'Back button hidden', category: 'functional_defect', severity: 'major', confidence: 0.9, at: AT }],
    },
    { name: 'run_end without a verdict falls back to one_liner', line: L({ type: 'run_end', status: 'failed', one_liner: 'No euro option', reason: 'r' }), want: [{ k: 'runEnd', status: 'failed', credits: undefined, why: 'No euro option', category: undefined, severity: undefined, confidence: undefined, at: AT }] },
    { name: 'test_md_step_start', line: L({ type: 'test_md_step_start', step_index: 2, heading: 'Open the cart' }), want: [{ k: 'mdStepStart', index: 2, heading: 'Open the cart', at: AT }] },
    { name: 'run_start reads the device', line: L({ type: 'run_start', objective: 'o', environment: { device: { model: 'Pixel_7', os_version: '14' } } }), want: [{ k: 'runStart', objective: 'o', target: 'Pixel_7 · 14', at: AT }] },
    { name: 'reasoning is think', line: L({ type: 'step_event', index: 1, event: 'reasoning', detail: 'the form is open' }), want: [{ k: 'detail', kind: 'think', text: 'the form is open', at: AT }] },
    { name: 'action is act, with its type', line: L({ type: 'step_event', index: 1, event: 'action', detail: 'Typing the postcode', action_type: 'type' }), want: [{ k: 'detail', kind: 'act', text: 'type: Typing the postcode', at: AT }] },
    { name: 'assertion is a check', line: L({ type: 'step_event', index: 1, event: 'assertion', detail: 'URL has /cart', passed: false }), want: [{ k: 'detail', kind: 'check', text: 'URL has /cart', ok: false, at: AT }] },
    { name: 'other step events are skipped', line: L({ type: 'step_event', index: 1, event: 'screenshot', detail: 'x' }), want: [] },
    { name: 'test_md_step_end', line: L({ type: 'test_md_step_end', step_index: 2, status: 'failed', duration_s: 4 }), want: [{ k: 'mdStepEnd', index: 2, status: 'failed', at: AT }] },
    { name: 'test_md_done', line: L({ type: 'test_md_done', overall_status: 'passed', duration_s: 9 }), want: [{ k: 'mdDone', status: 'passed', at: AT }] },
    { name: 'testrun_plan', line: L({ type: 'testrun_plan', members: [{ path: '/p/a_test.md' }, { path: '/p/b_test.md' }], parallel: 2 }), want: [{ k: 'plan', members: ['/p/a_test.md', '/p/b_test.md'], at: AT }] },
    { name: 'testrun_member_start', line: L({ type: 'testrun_member_start', path: '/p/a_test.md', log_path: '/s/1/events.ndjson' }), want: [{ k: 'memberStart', path: '/p/a_test.md', logPath: '/s/1/events.ndjson', at: AT }] },
    { name: 'testrun_progress', line: L({ type: 'testrun_progress', running: ['a_test.md'], pending: 1, done: 0, total: 2 }), want: [{ k: 'progress', running: ['a_test.md'], pending: 1, done: 0, total: 2, at: AT }] },
    { name: 'testrun_member_end', line: L({ type: 'testrun_member_end', path: '/p/a_test.md', status: 'broken', duration_s: 5, failure: { message: 'boom' } }), want: [{ k: 'memberEnd', path: '/p/a_test.md', status: 'broken', durationS: 5, logPath: undefined, why: 'boom', at: AT }] },
    { name: 'testrun_done', line: L({ type: 'testrun_done', overall_status: 'cancelled' }), want: [{ k: 'suiteDone', status: 'cancelled', at: AT }] },
    { name: 'post_hoc lines are marked', line: L({ type: 'testrun_done', overall_status: 'passed', post_hoc: true }), want: [{ k: 'postHoc' }, { k: 'suiteDone', status: 'passed', at: AT }] },
    { name: 'an unknown type is skipped', line: L({ type: 'brand_new_event', x: 1 }), want: [] },
    { name: 'a newer wire version is flagged, not parsed', line: JSON.stringify({ type: 'run_end', status: 'passed', v: 2, ts: '2026-10-08T10:00:00.000Z' }), want: [{ k: 'newer', at: AT }] },
  ]
  for (const c of cases) {
    test(c.name, () => {
      expect(adapt(c.line).events).toEqual(c.want)
    })
  }

  test('a line that is not JSON is skipped and counted', () => {
    expect(adapt('{"type":"run_e')).toEqual({ events: [], bad: true })
    expect(adapt('[1,2]')).toEqual({ events: [], bad: true })
  })

  test('a half-written last line waits for the rest', () => {
    const first = splitLines('{"a":1}\n{"b":')
    expect(first).toEqual({ lines: ['{"a":1}'], rest: '{"b":' })
    expect(splitLines(`${first.rest}2}\n`)).toEqual({ lines: ['{"b":2}'], rest: '' })
  })
})
