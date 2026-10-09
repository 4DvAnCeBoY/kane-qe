# kane-qe v2: watch kane-cli from Claude Code

A Claude Code mod that shows what kane-cli (KaneAI) is doing, without being asked. Claude runs kane-cli; the mod reads what kane-cli leaves on disk and shows it. The mod never starts a test by itself.

## What you see

| Surface | What it shows |
|---|---|
| **Band** (three rows above the prompt, the kane mascot on the left) | Row 1: `idle` with this session's passed/failed counts, `running` with the test's name and time, `N runs` with one coloured cell per run, or `suite` with one cell per test and `5 of 12 tests done · 3 running · 4 left`. Row 2: the step a single run is on; `now` and each running test with its time; a failure the moment it happens (`✗ checkout_guest failed on Fill the shipping address`); `last run ✓ login · 2h ago` from earlier sessions; or `⚠ 2 files changed, untested [ Test this change ]`. Row 3: assurance, `47% proven · 4 use cases`, or `not set up [ Set up now ]`. The mascot's eyes move while a test runs. |
| **Pane** (`/kane` or `[ Open ]`) | **Runs**: a card per run (failed first, red border), or one row per test for a suite. Press a name for its steps: done steps with a tick and time, the current or failing step expanded to *think*, *act* and each *check*, the failure's *why*, *kind* (kane's category, severity, confidence) and *where*, then *Open evidence*. **Assurance**: designed and proven bars, failing/blocked counts and when it last ran, a card per use case with what it still owes, or a card that offers to set it up with Claude. |
| **After Claude changes code** | When a turn ends with edited files (by the edit tools or a shell command; not docs, not git-ignored) and no kane-cli run since, the band warns and offers *Test this change*. The card lists the changed files and saved tests that mention the same feature, with their last result and *Run it*. Only when none does, Claude drafts an objective from the diff (also on *Draft a new objective*); *Run the objective* hands it to Claude with the app's start URL. A kane-cli run that starts after the last edit clears the warning. |

## Settings

`/config` → kane-qe:

| Setting | Default | |
|---|---|---|
| After Claude changes code | `offer` | `offer`: the band offers a test. `auto`: Claude is held once at the end of its turn to test the change. `off`: nothing |
| kane-cli command | `kane-cli` | Used only for `kane-cli cover gaps --json` (read-only, no credits) |

`/kane auto`, `/kane ask`, `/kane off` change it for this session. `/kane assurance` opens the Assurance tab.

## How it reads kane-cli

- Live runs: `~/.testmuai/kaneai/sessions/active/<pid>.json`, once a second; only runs whose `cwd` is inside this project, and only while the pid is alive.
- Each run's `events.ndjson` (and each suite member's own stream, read once more when it ends), from where it last stopped. Structured lines only, never kane-cli's human output. Unknown events and fields are skipped; lines that are not JSON are skipped and counted; a stream with a newer wire version shows its name and time and says so.
- Names come from the command Claude ran (`kane-cli testmd run login_test.md` → `login_test.md`), then kane-cli's own `recording_state`, then the objective.
- Failure facts come from `run_end.verdict` (root cause, category, severity, confidence), never guessed.
- Assurance: `kane-cli cover gaps --json` at session start and after each run, when the project has a `.context` folder.
- The last ten results per project are kept in the mod's store (`recentByProject`, apart from v1's `history`) for `last run …`.

## Develop

```
claude plugin validate kane-qe
claude plugin test kane-qe          # adapter table, band states at 60/80/120 columns, recorded streams, pane and band on terminal and desktop, change tracking, stale pointers, assurance
node kane-qe/tests/fixtures/build.mjs   # after adding a recorded stream to tests/fixtures/*.ndjson
```

Layout: `hooks/adapter.ts` (wire line → internal event, the only place raw field names appear), `hooks/model.ts` (pure: events → runs, runs → band rows and pane text), `hooks/sources.ts` (pointer and byte-offset helpers), `hooks/register.tsx` (polling, hooks and drawing), `hooks/mascot.ts` (the mascot, unchanged from the design).

v1 (the cockpit that starts runs, with Insights, Tests, History and Setup tabs and model tools) is on the `main` branch.
