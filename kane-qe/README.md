# kane-qe — KaneAI (kane-cli v16) cockpit for Claude Code

A Claude Code mod for QE engineers. It drives `kane-cli` in NDJSON `--agent` mode and turns runs into a live, clickable workflow.

## What you get
| Surface | What it does |
|---|---|
| **`/kane` pane** | Tabs: **Run** (objective + URL → Run / Run headless / Stop, live steps, verdict, extracted values, Test Manager link), **Tests** (`*_test.md` library, ▶ per test, run-by-tags, dry run; run on *This machine* or the *Cloud grid* (HyperExecute), on Web, Android or iOS with a filterable device picker from `kane-cli devices list [--remote]`; per-test `status` and `sync` to Test Manager), **Assurance** (hotkey `a`, below), **History** (pass rate, credits, ↻ rerun, triage, "QA report"), **Setup** (version, login, credits, project/folder, one-click mode / assertion / bug-detection / final-validation toggles; *Mobile and cloud grid*: `kane-cli doctor` for Android / iOS with each fix, the grid plugin check and one-click install) |
| **Assurance tab (`/kane assure`, `/kane ingest <prd \| Jira / Confluence / Linear / web URL>`)** | kane-cli's requirement loop, headless (`--mode agent`): Ingest → Extract → Review → Design → Run & cover, with a stage strip and counts. Questions kane pauses on show with their options as buttons (★ = kane's recommendation) or *Let Claude answer*; use cases get *Approve*, *Design tests* and coverage gaps with kane's own next command; *Run N designed tests* (`testrun --from-context`), *Review with Claude*, *Evolve stale*, *View graph*, *Sync with team*. Variables designed tests still need are flagged, with *Fill variables with Claude* |
| **Mirror** | kane-cli runs started anywhere else (terminal, Bash, Cursor, CI on this machine) are followed live from `~/.testmuai/kaneai/sessions/active/`, with Stop, history and triage. Toggle: *Mirror other kane-cli runs* |
| **Insights tab (`/kane insights [words]`)** | Reads each run's evidence pack and says who owns the result: **product bug** (backed by page errors), **CLI / model** (the page logged no errors where it failed: the CLI loop or the LLM), **needs a look** (kane's verdict and the page disagree), or **page signals** on a pass (e.g. a first-party 503, a `/undefined/` URL). Interactive waterfall timeline (hover, click, ↑↓ Enter), per-step network/console heat grid, model-vs-browser time split, step detail with screenshot (inline on kitty/Ghostty, link elsewhere), loop signals (unchanged pages, model committing after empty searches, the same value extracted twice). Errors a site was already logging before the failure (same endpoint and error class, same console message) are ignored as background noise, so busy sites like Amazon are not mistaken for product bugs. *Evidence viewer* (`v`) serves the pack to evidence.lambdatest.com; *Validate pack* |
| **History views** | Runs (owner marks, insights per run) · Trends (duration bars by result, flaky objectives, failures by owner) · Credits (balance meter, forecast, spend per run) · Quality (web vitals trend + measure, requirement coverage via `kane-cli cover gaps`) |
| **Disk backfill** | Every kane-cli session under `~/.testmuai/kaneai/sessions` (terminal, CI, other agents) joins History, with evidence read in the background |
| **Model tool `kane_insights`** | Claude reads the same evidence before triaging; triage prompts carry it and the rule "no page errors at the failing step ⇒ CLI loop or model" |
| **Live band** | Above the prompt while a run is live: current step + Open / Stop |
| **Status line + toast** | `kane ◐ step 4 · …` → `kane ✓ passed 41s` |
| **One entry point: `/kane <anything>`** | `/kane` home · `/kane <objective>` runs it ("run" optional) · `/kane <url> <objective>` · `/kane file_test.md` replays · `/kane tests\|history\|setup` · `/kane suite --tags smoke` · `/kane grid --tags smoke` (HyperExecute) · `/kane assure` · `/kane ingest <source>` · `/kane triage` · `/kane cases <feature>` · `/kane stop` · `/kane <question>?` asks Claude · `/kane help` |
| **Objective coach** | Holds objectives with no assertion or unset `{{vars}}` before they spend credits: *Let Claude add checks* / *Run anyway* / *Edit* |
| **Guided start** | Run tab gates on install → login, then a checklist: installed · logged in · project · first run · saved test. *Copy CI command* turns any run into a headless pipeline step |
| **Model tools** | `kane_run` (also mobile: `target`, `device_name`, `os_version`, `app`), `kane_test_run`, `kane_suite_run` (also `remote` for the grid, `device_name`, `os_version`), `kane_devices`, `kane_assure` (status / ingest / extract / design / answer / approve / evolve / sync), `kane_tests_list`, `kane_status`, `kane_insights`, `kane_generate` (all stream into the pane) |
| **Claude workflows** | Triage a failure (reads run dir, screenshots → bug vs test vs flake + fix), save passing run as test, generate & review cases, QA report from history |

## Install
- Requires `kane-cli` (`npm i -g @testmuai/kane-cli`), signed in with `! kane-cli login --oauth` from the Claude prompt.
- From GitHub: `/plugin marketplace add 4DvAnCeBoY/kane-qe`, then `/plugin install kane-qe@kane-qe`.
- From a local folder: `claude --plugin-dir /path/to/kane-qe`, or add it to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.
- Custom launcher: `/config` → kane-qe → *kane-cli command* (e.g. `node ~/v16/kane-cli/dist/index.js`).
- The pane opens on `/kane` or when a run starts; `/config` → *Open the Kane QE pane at session start* changes that.

## Develop
`claude plugin validate kane-qe` · `claude plugin test kane-qe`

See the [feature guide](../guide/kane-qe-guide.html) for flows, hotkeys and the walkthrough video.
