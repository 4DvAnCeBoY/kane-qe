"""Drives a real Claude Code session (tmux socket kqvid, session kq) through every
kane-qe feature while VHS records the attached terminal. Writes chapter times to
chapters.json. Clicks are SGR mouse events at the on-screen position of a label."""
import json
import re
import subprocess
import sys
import time

T = ['tmux', '-L', 'kqvid']
START = time.time()
CHAPTERS: list[dict] = []


def sh(args):
    return subprocess.run(T + args, capture_output=True, text=True).stdout


def screen() -> list[str]:
    return sh(['capture-pane', '-t', 'kq', '-p']).split('\n')


def pane_left(lines: list[str]) -> int:
    """The pane's first column: where its header starts (the transcript is to its left)."""
    for line in lines:
        if 'KaneAI v' in line:
            return max(0, line.index('KaneAI v') - 2)
    return 0


def find(label: str, last: bool = False, anywhere: bool = False):
    lines = screen()
    left = 0 if anywhere else pane_left(lines)
    hits = [(y, line.index(label, left)) for y, line in enumerate(lines) if label in line[left:]]
    if not hits:
        return None
    y, x = hits[-1] if last else hits[0]
    return x + 1 + min(2, len(label) // 2), y + 1


def click(label: str, last: bool = False, wait: float = 1.2) -> bool:
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


def type_text(text: str, per_char: float = 0.035, wait: float = 0.6):
    for ch in text:
        sh(['send-keys', '-t', 'kq', '-l', ch])
        time.sleep(per_char)
    time.sleep(wait)


def wait_for(pattern: str, timeout: float = 240, every: float = 1.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if re.search(pattern, '\n'.join(screen())):
            return True
        time.sleep(every)
    print(f'  ! timed out waiting for {pattern}', file=sys.stderr)
    return False


def chapter(title: str, detail: str):
    t = round(time.time() - START, 1)
    CHAPTERS.append({'t': t, 'title': title, 'detail': detail})
    print(f'[{t:6.1f}s] {title}', file=sys.stderr)


def prompt(text: str, wait: float = 2.0):
    type_text(text)
    keys('Enter', wait=wait)


# ── the tour ─────────────────────────────────────────────────────────────

chapter('One entry point: /kane', '/kane help lists everything; /kane opens the cockpit pane with its tabs.')
time.sleep(2)
prompt('/kane help', wait=4)
prompt('/kane', wait=4)

chapter('Setup & health', 'Version, login, credits, project; run-mode toggles; mobile tooling doctor and grid plugin check.')
click('[ Setup ]', wait=3)
click('[ Check iOS tooling ]', wait=6)
click('[ Check grid plugin ]', wait=5)

chapter('Run from the pane, live', 'Objective + URL, Run headless: steps stream in, the band above the prompt and the status line follow.')
click('Run ] [ Insights', wait=2)
click('e.g. Log in as', wait=0.8)
type_text('Open the Desktops category and assert products are listed; store the first product name as first_product')
click('https://kaneai-playground', wait=0.8)
type_text('https://ecommerce-playground.lambdatest.io', wait=0.5)
click('[ Run headless ]', wait=8)

chapter('Runs from anywhere, side by side', 'A run started in a terminal is mirrored live next to the pane run: the strip, the band and the status line count both.')
subprocess.Popen('cd "$KANE_DEMO_DIR" && kane-cli run "Search for iPod and assert at least 4 products are listed" --url https://ecommerce-playground.lambdatest.io --headless --agent > /dev/null 2>&1', shell=True)
wait_for(r'2 runs in progress|Kane ×2', timeout=40)
time.sleep(18)
wait_for(r'✓ PASSED run|✗ FAILED run', timeout=240)
# and for the terminal run to finish too, so Insights opens on a settled pair
end = time.time() + 180
while time.time() < end and re.search(r'runs? in progress|Kane ×', '\n'.join(screen())):
    time.sleep(2)
time.sleep(4)

chapter('Insights: who owns the result', 'Evidence pack read per step: verdict owner, wasted effort, interactive timeline, step screenshot.')
click('[ Insights ]', wait=5)
wait_for(r'CLEAN|PAGE SIGNALS|PRODUCT BUG|NEEDS A LOOK|CLI / MODEL', timeout=60)
time.sleep(3)
# Open a step: its timing, network, console and the screenshot as terminal cells.
row = find('navigate', last=False)
if row:
    x, y = row
    for seq in (f'\x1b[<0;{x};{y}M', f'\x1b[<0;{x};{y}m'):
        sh(['send-keys', '-t', 'kq', '-H', *[f'{b:02x}' for b in seq.encode()]])
    time.sleep(6)
click('Signals', wait=4)
click('Time split', wait=4)
click('Timeline', wait=2)
click('[ Evidence viewer ]', wait=8)

chapter('Tests, cloud grid & devices', 'Saved tests with status/sync; run on this machine or the HyperExecute grid; Android/iOS device picker.')
click('[ Tests ]', wait=3)
click('[ Cloud grid ]', wait=4)
click('[ iOS ]', wait=10)
click('iphone 15, 17.5', wait=0.6)
type_text('iphone 15', wait=2)
click('iPhone 15 17.5', wait=2)
click('[ 17.5 ]', wait=2)
click('status', wait=4)
click('[ This machine ]', wait=1)
click('[ Web ]', wait=2)

chapter('Assurance: requirements to coverage', 'Ingest → extract → review → design → run & cover, with questions answered by buttons and proven coverage.')
click('[ Assurance ]', wait=8)
click('[ View graph ]', wait=6)

chapter('History: runs, trends, credits, quality, sites', 'Five views; Sites groups exploration by site with scenarios, pages reached and “What to explore next”.')
click('[ History ]', wait=3)
click('Trends', wait=4)
click('Credits', wait=4)
click('Quality', wait=4)
click('Sites', wait=6)

chapter('Claude drives kane', 'Ask in plain words: Claude runs kane_run, the transcript card streams live, then reads the evidence.')
keys('Escape', wait=1.5)
prompt('Use kane_run (headless) on https://ecommerce-playground.lambdatest.io to open My Account > Login and assert the E-Mail and Password fields are shown. Then call kane_insights and give me a 2-line summary.', wait=5)
wait_for(r'Kane run · (PASSED|FAILED)', timeout=300)
# Claude is done when its working spinner ("esc to interrupt") is gone.
end = time.time() + 180
time.sleep(4)
while time.time() < end and re.search(r'esc to interrupt', '\n'.join(screen())):
    time.sleep(2)
time.sleep(8)

chapter('End', 'kane-qe: one /kane cockpit for KaneAI testing inside Claude Code.')
time.sleep(3)
json.dump(CHAPTERS, open(sys.argv[1] if len(sys.argv) > 1 else 'chapters.json', 'w'), indent=2)
print('DONE', round(time.time() - START, 1), file=sys.stderr)
