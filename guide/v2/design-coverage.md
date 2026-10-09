# kane-qe v2 against its design

The design ([kane-cli mod: terminal build guide](https://claude.ai/artifact/5DkzYxGqMSc6jWS9s1ddVw)) has three parts: what to build (17 features), how it looks (13 screens) and how to build it (rules and sections 1–14). This is how v2 meets each one, and how that was checked.

How each item was checked:
- **live**: in a real Claude Code session in a terminal, with a real kane-cli run;
- **staged**: a real Claude Code session, with kane-cli runs written to disk in kane-cli 0.8.20's own format, by `sleep` processes standing in for kane-cli;
- **test**: `claude plugin test kane-qe` (81 tests).

## Features (design part 1, "What to build")

| # | Feature | v2 | Checked |
|---|---|---|---|
| 1 | Always-on status band | Three rows above the prompt, mascot on the left, in every session | live |
| 2 | Works by watching | Live runs found from `~/.testmuai/kaneai/sessions/active/` once a second; nothing to start | live (on the band within 2 s of a kane-cli start) |
| 3 | Animated mascot | Eyes move while something runs (4 distinct frames measured), still when idle (1 frame) | live |
| 4 | One test running | `running` chip, name, elapsed time; row 2 is the step, with no step number | live |
| 5 | Many tests at once | One coloured cell per run, passed/running/waiting counts, `now` row | staged, test |
| 6 | Suite progress | One cell per test, `5 of 12 tests done · 3 running · 4 left`, running tests on row 2 | live (3-test suite), staged (12), test |
| 7 | Failures shown at once | The newest failure takes row 2 the moment it happens, in a suite too | live, staged |
| 8 | Results when idle | `✓ 4 passed · ✗ 1 failed`, the failed test and its step; `last run ✓ login · 2h ago` from earlier sessions | live, test |
| 9 | Details pane | `/kane` or `[ Open ]`: Runs and Assurance tabs | live |
| 10 | Step-by-step view | Steps with ticks and times; the current or failing step opens to think, act and checks | staged, test |
| 11 | Failure explanation | why, kind (category · severity · confidence), where, the failing check, *Open evidence* | staged, live (kane's own verdict) |
| 12 | Assurance coverage | Row 3 `47% proven · 4 use cases`; the tab's bars, failing/blocked, last run, use-case cards | live (real requirement store) |
| 13 | Assurance set-up prompt | `not set up [ Set up now ]`; the tab's card with *Set it up with Claude* | live |
| 14 | Untested-change warning | After an edit (edit tools or shell), `⚠ 1 file changed, untested [ Test this change ]` | live |
| 15 | Drafted test for the change | Saved tests that touch the change first, with last result and *Run it*; else Claude drafts an objective from the diff | live |
| 16 | Auto-test setting | `offer` / `auto` / `off`, and `/kane auto · ask · off` per session; auto holds Claude once per change | live (Claude held, ran kane-cli, reported) |
| 17 | Safe with kane-cli updates | Unknown events skipped, non-JSON lines counted, a newer wire version shows name and time only | test |

## Screens (design part 1)

All thirteen were compared with the design's screenshots in a real terminal: Nothing has run yet · Idle, with results · Claude changed code · The offer card · One test running · Step detail, while running · A failed run · Several runs at once · Several runs, partly done · A suite starting · A suite, midway · A failure during a suite · Assurance · Assurance not set up. Screenshots are in this folder.

Two differences, both deliberate:
- The design lists a test file's coming steps as dim circles. kane-cli's stream gives no step total, and the build spec says never to show one, so only steps that have started are listed.
- The design's cards say "Chrome 154". kane-cli 0.8.20 reports a device and OS for mobile runs but no browser name, so a desktop run shows only its kind.

## Build rules (design part 2)

| Rule | v2 |
|---|---|
| The mod watches; it never starts a test | It runs only `kane-cli cover gaps --json`, `kill -0`, `git check-ignore` and `git diff`; tests are run by Claude, through prompts the person's buttons send |
| Structured data only | Pointer JSON and `events.ndjson` lines; kane-cli's human output is never read |
| No guesses on screen | What kane-cli does not report is left out (step totals, credits while running, balance, browser) |
| Ignore what you do not know | `adapter.ts` dispatches on known types and skips the rest |
| Every behaviour has a test; README changes with it | 79 tests; both READMEs describe v2 |
| Code shape: sources → adapter → model → views | `sources.ts`, `adapter.ts` (only place raw field names appear), `model.ts` (pure), `register.tsx` |
| Faults 1–5 in the prototype | All fixed: wrapped text keeps its column, waiting markers in the dim colour, card borders in the dim colour, cuts sized from the pane width, no background on band or pane |

## Use cases

| Who and when | What they get | Checked |
|---|---|---|
| A QE asks Claude to test a flow | The band picks the run up by itself and shows the step it is on; nothing to type into the mod | live |
| A run started in a terminal, a script or CI on this machine, in this project | Shown the same way; another project's runs and dead processes are not | live, test |
| A test fails | Which test, which step, kane's own reason and how sure it is, the failing check, the evidence | live, staged |
| Several flows tested in parallel, or a whole suite | Cells and counts, what is running now, failures as they happen, one row per test in the pane | live, staged |
| Claude changed code and is about to finish | A warning with a one-press test (offer), or Claude made to test it first (auto) | live |
| A saved test already covers the change | Offered first, with its last result, instead of a new objective | live |
| A team tracks requirement coverage | Proven and designed coverage on every screen, debt per use case, set-up when missing | live |
| Coming back the next day | `last run ✓ login · 2h ago` for this project | live, test |
| A light terminal theme, a narrow terminal | A darker palette on light themes; every band row fits its width | test, live (80 columns) |
| kane-cli is upgraded | The display keeps working; a newer wire format says so instead of breaking | test |

## Not checked

- **The desktop app.** The band and pane are mounted on the desktop surface in tests (the mascot as an image there), but not opened in the app itself.
- **The light palette in a live session**: switching a session's theme changes the person's global setting, so it is covered by a test only.

## Found while checking, and fixed

- A run Claude was held for (auto) and still did not test kept promising "Claude will test this"; it now offers the button.
- Files other tools write during a long kane-cli command were counted as edits; hidden tool folders never count now.
- The held stop now carries the app's start URL, like the offer card.

And while recording the walkthrough with real runs:
- *Run it* now passes the start URL too: when a saved step no longer replays (the site renamed a button), kane-cli retries it fresh and needs one.
- A saved test keeps kane's investigated verdict (it has a category) over a later failure without one, such as that retry refused for want of a URL.
- *Open* and *Test this change* bring the Kane pane in front of another pane in the dock: Claude Code opens its Diff pane after an edit, which hid the card.
- A saved test named for the changed feature now outranks one that only mentions it.
