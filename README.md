# codechef-bot

A Playwright bot that works through CodeChef course **practice** problems with an AI model (Google Gemini, with an optional NVIDIA-hosted fallback). For each problem it:

1. reads the statement and sample tests,
2. asks the AI for a solution,
3. runs it against the samples,
4. asks the AI to fix it if the samples fail,
5. submits once the samples pass,
6. follows **Next** to the following problem in the module.

Only practice pages (one editor with a language dropdown) are supported. Lab/project pages are detected and skipped.

> **Use it only where automation is allowed.** Check your course's rules and CodeChef's terms first. Never use it for graded or proctored assessments. Use it on your own account at your own risk.

## Requirements

- Node.js 20.6 or newer (the start script uses `--env-file`)
- A CodeChef account with access to the course
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/). The free tier works but has low per-minute and per-day limits.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env    # then fill in the values
```

Required values in `.env`:

| Variable | Meaning |
|---|---|
| `GEMINI_API_KEY` | Gemini API key |
| `CODECHEF_USERNAME` / `CODECHEF_PASSWORD` | Your CodeChef login |

`PROBLEM_URL` is optional (see [Choosing where to start](#choosing-where-to-start)).

## Usage

```bash
npm start                         # resume where the last run stopped (or use PROBLEM_URL)
npm start <problem-url>           # start from a specific problem
npm start PREP50                  # start from a problem code in the same course as last time
```

The bot logs in once and saves the session to `auth.json`. If the session expires (CodeChef shows a 403 page), it logs in again. Each run ends with a summary:

```
===== Summary
accepted     41s  PROBLEM_A
not-passed   95s  PROBLEM_B  sample/run did not pass
```

### Choosing where to start

The start problem is chosen in this order:

1. The argument to `npm start`: a full link, or a problem code that reuses the last course link.
2. `PROBLEM_URL` in `.env`, if you changed it since the last run.
3. Where the last run stopped, saved in `progress.json`.

When a module is finished, start the next one with `npm start <first-problem-url>`.

## Configuration

All settings are optional. Defaults are listed in `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.5-flash` | Main model |
| `GEMINI_FALLBACK_MODELS` | `gemini-3.6-flash,gemini-3-flash-preview` | Models tried in order if the main one fails or runs out of quota |
| `GEMINI_RETRIES` | `2` | Retries per model on temporary errors (503, timeouts), waiting 5s, then 10s |
| `GEMINI_TIMEOUT_MS` | `180000` | Time limit for one AI call |
| `AI_RPM` | `5` | Most AI requests allowed in any 60-second window |
| `AI_MIN_INTERVAL_MS` | `2000` | Minimum gap between AI requests |
| `AI_THINKING` / `AI_FIX_THINKING` | `low` / `high` | Gemini thinking level for first attempts and for fix attempts (`low`, `medium`, `high` or `default`) |
| `NVIDIA_API_KEY`, `NVIDIA_MODEL` | (unset) | Optional last-resort provider |
| `LANGUAGE` | (current) | Switch the editor's language dropdown, e.g. `C++`, `Python3`, `Java` |
| `AUTO_NEXT` / `MAX_PROBLEMS` | `true` / `10` | Follow **Next** after each problem; maximum problems per run |
| `MAX_FIX_ATTEMPTS` | `3` | AI fix attempts after a failed sample run |
| `REVIEW` | `auto` | Extra AI review before the first run: `auto` (only when there are no samples), `always`, `never` |
| `SUBMIT_ON_FAILURE` | `false` | Submit even if the samples fail |
| `HEADLESS` | `false` | Run the browser without a window |
| `USE_SCREENSHOTS` | `false` | Also send screenshots of the statement, for problems with images |

## How it works

| File | Role |
|---|---|
| `src/index.js` | Main loop: open a problem, solve it, follow Next, print the summary |
| `src/auth.js` | Logs in and saves the session |
| `src/problem.js` | Reads the statement (KaTeX formulas become `$TeX$`) and the sample tests; finds the next problem |
| `src/editor.js` | Detects the editor and language; reads and writes the code |
| `src/gemini.js` | AI calls: JSON responses, retries, model fallback, rate limiting, token logging |
| `src/prompts.js` | Short prompts, to keep token use low |
| `src/runner.js` | Clicks Run or Submit and waits for the result |
| `src/progress.js` | Remembers where to resume |

**Checking a run:** on practice pages, **Run** doesn't judge your code; it only shows "Your Output" for the sample input. The bot compares that with the sample's expected output. Matching the samples doesn't guarantee the hidden tests pass.

**Token use:** each AI call logs a line like `[tokens] gemini-3.5-flash/low: in=618 out=364 thinking=0 total=982`. Thinking stays `low` for first attempts and switches to `high` only when the code needs fixing.

## Troubleshooting

- **The AI hangs or returns 503 "high demand":** a model can be overloaded for a while. The bot retries, then moves on to `GEMINI_FALLBACK_MODELS`. You can also set a different `GEMINI_MODEL`.
- **429 / quota exceeded:** free-tier limits are per model and per day. The bot tries the next model, and stops the run if every model is out. Run `npm start` again later to resume.
- **Something failed on the page:** a screenshot and the page HTML are saved in `debug/`, and the copied statement is in `debug/last-problem.txt`. The bot relies on CodeChef's current page layout, so site changes can break it.

## Files that are never committed

`.env` (keys and password), `auth.json` (session cookies), `progress.json` and `debug/` are all in `.gitignore`.
