# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Node.js (CommonJS) Playwright bot that solves CodeChef course **practice** problems with Gemini, with an optional NVIDIA fallback. Each problem goes: copy the statement and samples → AI writes a solution → run it against the sample → AI fixes it if needed → submit → follow **Next**. User-facing documentation is in `README.md`.

Scope is deliberate: only practice pages (a single Ace editor) are supported. Lab/project pages (a Monaco editor with file tabs) are refused in `editor.js`. Do not add code that gets around CodeChef's editor protections, such as its clipboard/paste blocking.

## Commands

- Install: `npm install`, then `npx playwright install chromium`.
- Run: `npm start`, `npm start <problem-url>`, or `npm start <PROBLEMCODE>`. Needs Node 20.6+ for `--env-file`.
- There is no test suite or linter. Syntax-check with `for f in src/*.js; do node --check $f; done`.
- To try one module, load the env and `require` it, e.g. `node --env-file=.env -e "require('./src/runner').classify('...')"`. Requiring `config.js` throws if `CODECHEF_USERNAME` or `CODECHEF_PASSWORD` is missing.
- Each real AI call uses free-tier quota (per model, per day), so keep live tests small.

## Architecture

`src/index.js`:
- `main()` logs in, picks the start URL (`progress.resolveStartUrl`), then loops: `openProblem`, then `solveProblem()`, then `goToNextProblem`.
- The loop stops at the end of the module, at `MAX_PROBLEMS`, or on a fatal AI error (all models down or out of quota). One problem failing doesn't stop it.
- It saves `progress.json` before each problem and after moving on, so a stopped run resumes at the unfinished problem.
- A 403 "Access restricted" page means the session expired, so it logs in again.

`solveProblem()`:
1. Read the statement and samples.
2. Solve. The review call runs only when there are no samples, or when `REVIEW=always`.
3. Write the code.
4. Run and fix, up to `MAX_FIX_ATTEMPTS` times. Fix attempts use `AI_FIX_THINKING`.
5. Submit only if the sample passed.

Modules:
- `problem.js`
  - **Statement:** collects every `CONTENT_SELECTORS` match (outermost only, in page order) and swaps KaTeX formulas for their TeX source, restoring them afterwards.
  - **Samples:** `readSamples` returns consecutive `<pre>` pairs inside `[class*="values"]`; it must run before any Run click.
  - **Next:** `goToNextProblem` prefers the top-bar "Next" `<a href>`, which renders late, so it waits up to 8s. It falls back to the bottom button.
- `editor.js`
  - Waits for `.ace_editor` and the MUI language dropdown (`.MuiSelect-nativeInput`, which fills in a few seconds after the editor; starter code shown before that is a placeholder).
  - Optionally switches the language to `LANGUAGE`, and names the single file `solution.<ext>`.
  - Reads and writes through `node.env.editor`.
- `runner.js`
  - **Waiting:** waits until the page text, excluding the editor, stops changing and no new text matches `BUSY_PATTERN` (which includes "Queued" and "Fetching").
  - **Practice Run isn't judged:** `judgeAgainstSamples` compares the "Your Output" panel with the sample's expected output, token by token. The custom-input box is pre-filled with sample 1.
  - **Submit:** the verdict comes from the `classify()` regexes.
- `gemini.js`
  - **Models:** tries `GEMINI_MODEL`, then `GEMINI_FALLBACK_MODELS`, in order, then NVIDIA. Temporary errors are retried, waiting 5s then 10s. A 429 moves to the next model, unless its `RetryInfo` asks for 90s or less, in which case it waits.
  - **Rate limit:** `waitForRateLimit` enforces `AI_MIN_INTERVAL_MS` and `AI_RPM` (a sliding 60s window).
  - **Request settings:** the SDK *replaces* `generationConfig` on each request rather than merging it, so `generationConfig(thinking)` builds the full object each time, including `thinkingConfig.thinkingLevel`.
  - **Token logging:** each call logs `[tokens] in/out/thinking`.
- `prompts.js`: kept deliberately short, since every token is sent on every call. Fix prompts get a clipped run report (expected vs your output).
- `progress.js`: start URL priority is CLI argument → `PROBLEM_URL` (if changed since the last run) → saved progress → `PROBLEM_URL`.

Code passed to `page.evaluate` / `waitForFunction` (`extractMainContent`, `scrollMainArea`, `readLanguage`, `readPanel`, `aceGetValue`, `aceSetValue`) runs in the browser, so it must stay self-contained (no closures or imports).

## Fragility

Every selector depends on CodeChef's current markup: `#edit-name`, `.ace_editor`, `.MuiSelect-nativeInput`, `#language-select`, the Run/Submit/Next buttons, `[class*="values"] pre`, and the "Your Output" label. When something breaks, check `debug/` (a screenshot, the page HTML, and `last-problem.txt`) and the live page before changing the logic.
