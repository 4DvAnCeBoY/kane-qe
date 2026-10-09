"""Drives a real Claude Code session (tmux socket kqvid, session kq) through kane-qe v2 while VHS
records the attached terminal. Every run in it is a real kane-cli run. Writes chapter times and the
waiting stretches (to speed up afterwards) to the JSON file named on the command line.
Clicks are SGR mouse events at the on-screen position of a label."""
import json
import os
import re
import subprocess
import sys
import time

T = ['tmux', '-L', 'kqvid']
START = time.time()
CHAPTERS: list[dict] = []
WAITS: list[list[float]] = []
DEMO = os.environ['KANE_DEMO_DIR']
URL = 'https://ecommerce-playground.lambdatest.io'


def now() -> float:
    return round(time.time() - START, 1)


def sh(args):
    return subprocess.run(T + args, capture_output=True, text=True).stdout


def screen() -> str:
    return sh(['capture-pane', '-t', 'kq', '-p'])


def band() -> str:
    """The band's three rows: from the mascot at column 0, left of the pane if one is open."""
    lines = screen().split('\n')
    for i, line in enumerate(lines):
        if line.startswith(' ▄▀▄▄▀▄'):
            return '\n'.join(l.split('│')[0] for l in lines[i:i + 3])
    return ''


def find(label: str, last: bool = False):
    lines = screen().split('\n')
    hits = [(y, line.index(label)) for y, line in enumerate(lines) if label in line]
    if not hits:
        return None
    y, x = hits[-1] if last else hits[0]
    return x + 1 + min(2, len(label) // 2), y + 1


def click(label: str, last: bool = False, wait: float = 1.5) -> bool:
    pos = find(label, last)
    if not pos:
        print(f'  ! not on screen: {label}', file=sys.stderr)
        return False
    x, y = pos
    for seq in (f'\x1b[<0;{x};{y}M', f'\x1b[<0;{x};{y}m'):
        sh(['send-keys', '-t', 'kq', '-H', *[f'{b:02x}' for b in seq.encode()]])
        time.sleep(0.08)
    time.sleep(wait)
    return True


def keys(*k: str, wait: float = 1.0):
    sh(['send-keys', '-t', 'kq', *k])
    time.sleep(wait)


def type_text(text: str, per_char: float = 0.03, wait: float = 0.6):
    for ch in text:
        sh(['send-keys', '-t', 'kq', '-l', ch])
        time.sleep(per_char)
    time.sleep(wait)


def prompt(text: str, wait: float = 2.0):
    type_text(text)
    keys('Enter', wait=wait)


def wait_for(pattern: str, timeout: float = 300, every: float = 1.0, fast: bool = True, on=None) -> bool:
    """Waits until the band (or `on`) matches; the stretch is marked to be sped up in the cut."""
    on = on or band
    t0 = now()
    end = time.time() + timeout
    ok = False
    while time.time() < end:
        if re.search(pattern, on()):
            ok = True
            break
        time.sleep(every)
    if fast and now() - t0 > 6:
        WAITS.append([t0 + 3, now() - 2])
    if not ok:
        print(f'  ! timed out waiting for {pattern}', file=sys.stderr)
    return ok


def wait_gone(pattern: str, timeout: float = 400, on=None):
    on = on or band
    t0 = now()
    end = time.time() + timeout
    while time.time() < end and re.search(pattern, on()):
        time.sleep(1.5)
    if now() - t0 > 6:
        WAITS.append([t0 + 3, now() - 2])


def chapter(title: str, detail: str):
    CHAPTERS.append({'t': now(), 'title': title, 'detail': detail})
    print(f'[{now():6.1f}s] {title}', file=sys.stderr)


def kane(*args: str):
    """A kane-cli run started outside Claude, in the project: as from another terminal.
    `testrun run` takes no --agent (it streams NDJSON when not on a terminal)."""
    flags = ['--headless'] if args[0] == 'testrun' else ['--agent', '--headless']
    subprocess.Popen(['kane-cli', *args, *flags], cwd=DEMO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ── the tour ─────────────────────────────────────────────────────────────

wait_for(r' idle ', timeout=60, fast=False)
chapter('The band', 'Always above the prompt: kane-cli is idle, and row 3 is requirement coverage. Nothing to start.')
time.sleep(5)

chapter('Claude runs a test, the band follows', 'Ask Claude; within two seconds the band shows the run, its time and the step it is on. The mascot moves while it runs.')
prompt(f'Run this and tell me the result in one line: kane-cli run "Open the Laptops category and assert products are listed" --url {URL} --agent --headless', wait=3)
wait_for(r' running ', timeout=60, fast=False)
time.sleep(10)
wait_for(r' idle ', timeout=300)
wait_gone(r'…\s*\(\d', timeout=180, on=screen)
time.sleep(4)

chapter('The pane: runs and steps', '/kane opens it. Press a run for its steps with their times.')
prompt('/kane', wait=3)
click('Open the Laptops category', wait=4)
time.sleep(3)
click('‹ Runs', wait=2)

chapter('Several runs at once, and a failure', 'Runs started anywhere in this project: one cell per run, what is running now; a failure takes row 2 the moment it happens.')
kane('run', 'Search for iPod Shuffle and assert it is listed', '--url', URL)
kane('run', 'Click Enable Notification, choose Safari, then click the previous-step button and assert the progress counter shows 2/5', '--url', 'https://kaneai-playground.lambdatest.io')
wait_for(r'2 runs', timeout=40, fast=False)
time.sleep(12)
wait_for(r' idle ', timeout=400)
time.sleep(3)

chapter('Why it failed', 'kane’s own verdict: why, what kind, how sure, where; the steps; Open evidence.')
click('Click Enable Notification', wait=4)
time.sleep(6)
click('‹ Runs', wait=2)

chapter('A suite', 'kane-cli testrun: one cell per test, done · running · left; one row per test in the pane.')
kane('testrun', 'run', '--parallel', '3')
wait_for(r' suite ', timeout=40, fast=False)
time.sleep(10)
wait_for(r' idle ', timeout=500)
time.sleep(3)

chapter('After Claude changes code', 'An edit and no test since: the band warns. The card offers the saved test that covers it, with its last result.')
prompt('In src/search/searchQuery.ts make searchQuery trim the query and collapse inner spaces. Use the Edit tool.', wait=3)
wait_for(r'changed, untested', timeout=180)
time.sleep(3)
click('[ Test this change ]', wait=4)
time.sleep(4)

chapter('Test the change', 'Run it hands the saved test to Claude; when the run ends, the warning clears.')
click('[ Run it ]', wait=3)
wait_for(r' running ', timeout=90, fast=False)
time.sleep(8)
wait_for(r' idle ', timeout=400)
wait_gone(r'…\s*\(\d', timeout=180, on=screen)
time.sleep(4)

chapter('Assurance', 'Designed and proven coverage from kane-cli cover gaps, and what each use case still owes.')
prompt('/kane assurance', wait=4)
time.sleep(6)

chapter('End', 'kane-qe v2: a band that watches kane-cli, a pane for runs and assurance, and a nudge to test what Claude changed.')
time.sleep(3)
json.dump({'chapters': CHAPTERS, 'waits': WAITS}, open(sys.argv[1] if len(sys.argv) > 1 else 'tour-v2.json', 'w'), indent=2)
print('DONE', now(), file=sys.stderr)
