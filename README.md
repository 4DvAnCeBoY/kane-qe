# kane-qe

A [KaneAI](https://www.lambdatest.com/kane-ai) testing cockpit for [Claude Code](https://claude.com/claude-code), built on [kane-cli](https://github.com/LambdaTest/kane-cli) v16.

Type `/kane` and describe what to test. The mod runs it with kane-cli, streams the steps live into a side pane, reads the run's evidence to tell you who owns a failure (the product, the test, the run's settings, or the agent), and keeps everything you explored in one place. Claude can drive it too, with nine tools.

- **Run** objectives in plain English from the pane, `/kane`, or by asking Claude; runs started in a terminal or CI are followed live as well.
- **Insights** per run: verdict owner, wasted effort (repeated clicks, unchanged pages, used-up step budget), a step timeline with screenshots, network and console per step, time split between the model and the browser.
- **Tests** library with suites on this machine or the LambdaTest HyperExecute grid, on web, Android emulators or iOS simulators.
- **Assurance**: requirement (PRD, Jira, Confluence, Linear, web page) → use cases → designed tests → proven coverage, with kane's questions answered by buttons.
- **History**: runs, trends, credits, web vitals, and Sites, which groups exploration by site and asks Claude what to explore next.

**Read more:**
- **[Field Guide](https://4dvanceboy.github.io/kane-qe/)**: features, flows, commands, tools, hotkeys, and a 5-minute chaptered video recorded in a real session ([mp4](guide/kane-qe-tour.mp4)).
- **[Explained simply](https://4dvanceboy.github.io/kane-qe/explainer.html)**: what it does and why, in plain words, with diagrams and charts from real runs.

## Requirements

- Claude Code with mods (function-hook plugins) enabled.
- kane-cli: `npm install -g @testmuai/kane-cli`, then sign in from the Claude prompt with `! kane-cli login --oauth`.
- Optional: the `remote-execution` kane-cli plugin and a HyperExecute MultiOS plan for grid suites; macOS on Apple Silicon with Xcode or Android Studio for local mobile runs.

## Install

From GitHub, as a marketplace:

```
/plugin marketplace add 4DvAnCeBoY/kane-qe
/plugin install kane-qe@kane-qe
```

From a local clone, for one session or permanently:

```
claude --plugin-dir /path/to/kane-qe/kane-qe
```

or add the folder to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.

Then type `/kane` (or `/kane help`).

## Settings

`/config` → kane-qe:

| Setting | Default | |
|---|---|---|
| kane-cli command | `kane-cli` | Any launcher, e.g. `node ~/kane-cli/dist/index.js` |
| Default run timeout | 600 s | For runs started from the pane or by Claude |
| Mirror other kane-cli runs | on | Follow runs started in terminals, CI and other agents |
| Open the pane at session start | `never` | `kane-projects` opens it where the folder has saved tests, evidence or a requirement store; `always` |

## Repository layout

| Path | What |
|---|---|
| `kane-qe/` | The mod: manifest, hooks module (`hooks/register.tsx`), pure helpers, chart surfaces, state contract (`types/`), tests |
| `.claude-plugin/marketplace.json` | Marketplace manifest, so the repo installs with `/plugin marketplace add` |
| `guide/` | The Field Guide, the plain-language explainer, the walkthrough video and the script that records it |
| `.github/workflows/` | CI (validate and test on every push) and the GitHub Pages deploy for `guide/` |
| `proposal/` | The design proposal for the Insights features |

## Develop

```
claude plugin validate kane-qe     # manifest, hooks and state contract
claude plugin validate .           # marketplace manifest
claude plugin test kane-qe         # 52 tests: reducers, parsers, attribution, pane flows
```

Edit `kane-qe/` and an interactive session that loads it from `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` reloads on save.

To re-record the walkthrough after changes (needs `vhs`, `tmux`, `ffmpeg`, a kane login, and a kane project folder with saved tests and a requirement store):

```
KANE_DEMO_DIR=/path/to/demo-project guide/run_tour.sh
```

It records `guide/tour-raw.mp4` and writes chapter times to `guide/chapters.json`.

## License

[MIT](LICENSE)
