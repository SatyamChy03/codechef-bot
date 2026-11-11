'use strict';

const config = require('./config');

/* ------------------------------------------------------------------ output classification (practice pages) */

const BUSY_PATTERN =
    /\b(running|compiling|executing|submitting|evaluating|judging|in queue|queued|pending|fetching|loading|processing)\b/i;
const FAIL_PATTERN =
    /compilation error|compile error|compiler error|runtime error|wrong answer|time limit exceeded|memory limit exceeded|segmentation fault|exception|traceback|\berror\b|\bfailed\b|\bfailure\b/i;
const PASS_PATTERN =
    /all tests? (?:cases? )?passed|\baccepted\b|\bpassed\b|\bsuccess(?:ful)?\b|correct answer/i;
const COUNT_PATTERN =
    /(\d+)\s*(?:\/|out of|of)\s*(\d+)\s*(?:test\s*cases?|tests?)?\s*passed/gi;

const SETTLE_TICKS = 3;
const NO_CHANGE_GRACE_MS = 10000;

const splitLines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
const tokens = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).join(' ');

/** Classifies free-form output text as pass, fail or unknown. */
function classify(text) {
    const counts = [...text.matchAll(COUNT_PATTERN)];
    if (counts.length) {
        const [, passed, total] = counts[counts.length - 1].map(Number);
        return passed === total && total > 0 ? 'pass' : 'fail';
    }
    const withoutZeroes = text.replace(/\b0\s+(?:failed|failures?|errors?)\b/gi, '');
    if (FAIL_PATTERN.test(withoutZeroes)) return 'fail';
    if (PASS_PATTERN.test(withoutZeroes)) return 'pass';
    return 'unknown';
}

/* ------------------------------------------------------------------ page helpers */

/** Page text with code editors hidden, so source code never looks like output. */
function pageText(page) {
    return page.evaluate(() => {
        const editors = [...document.querySelectorAll('.ace_editor, .monaco-editor')];
        const previous = editors.map((node) => node.style.display);
        editors.forEach((node) => { node.style.display = 'none'; });
        try {
            return document.body.innerText;
        } finally {
            editors.forEach((node, index) => { node.style.display = previous[index]; });
        }
    });
}

/** Runs in the browser: text under the last element whose own text equals `heading`. */
function readPanel(heading) {
    const labels = [...document.querySelectorAll('body *')].filter((element) =>
        element.children.length <= 1 &&
        (element.innerText || '').trim().toLowerCase() === heading.toLowerCase());
    const label = labels[labels.length - 1];
    if (!label) return null;
    if (label.nextElementSibling) return label.nextElementSibling.innerText;
    const parentText = label.parentElement ? label.parentElement.innerText : '';
    return parentText.slice(parentText.indexOf(label.innerText) + label.innerText.length);
}

async function findRunButton(page) {
    const button = page.locator('button, [role="button"]').filter({ hasText: /^\s*Run\s*$/i }).first();
    await button.waitFor({ state: 'visible', timeout: 30000 });
    return button;
}

async function findSubmitButton(page) {
    let button = page.getByRole('button', { name: /^\s*submit\s*$/i }).first();
    if (await button.count() === 0) button = page.locator('[class*="submit__btn"]').first();
    await button.waitFor({ state: 'visible', timeout: 15000 });
    return button;
}

/** Clicks a button and waits until the page text stops changing and nothing looks busy. */
async function clickAndWaitForOutcome(page, button, timeoutMs) {
    const before = await pageText(page);
    const beforeLines = new Set(splitLines(before));
    const freshLines = (text) => splitLines(text).filter((line) => !beforeLines.has(line)).join('\n');

    await button.click();

    const start = Date.now();
    let previous = before;
    let current = before;
    let stableTicks = 0;
    let sawChange = false;

    while (Date.now() - start < timeoutMs) {
        await page.waitForTimeout(1000);
        current = await pageText(page);
        if (current !== before) sawChange = true;
        stableTicks = current === previous ? stableTicks + 1 : 0;
        previous = current;

        const fresh = freshLines(current);
        const settled = stableTicks >= SETTLE_TICKS && !BUSY_PATTERN.test(fresh);
        if (settled && (sawChange || Date.now() - start > NO_CHANGE_GRACE_MS)) {
            return { output: fresh || current, timedOut: false };
        }
    }
    return { output: freshLines(current) || current, timedOut: true };
}

/** Compares the custom-input output panel against the matching sample. */
async function judgeAgainstSamples(page, samples, panelText) {
    const yourOutput = await page.evaluate(readPanel, 'Your Output');
    if (yourOutput == null) return null;

    const customInput = await page.evaluate(() => {
        const box = [...document.querySelectorAll('textarea')]
            .find((textarea) => !textarea.closest('.ace_editor, .monaco-editor'));
        return box ? box.value : '';
    });

    const sample = samples.find((s) => tokens(s.input) === tokens(customInput)) || samples[0];
    const passed = tokens(yourOutput) === tokens(sample.output);
    return {
        output: `Sample input:\n${sample.input}\n\nExpected output:\n${sample.output}\n\nYour output:\n${yourOutput.trim() || panelText}`,
        verdict: passed ? 'pass' : 'fail',
    };
}

/* ------------------------------------------------------------------ practice pages: Run, then Submit */

async function runProject(page, samples = []) {
    const runButton = await findRunButton(page);
    console.log('Running the project...');
    const { output, timedOut } = await clickAndWaitForOutcome(page, runButton, config.runTimeoutMs);

    if (timedOut) {
        console.warn(`Run did not settle within ${config.runTimeoutMs / 1000}s.`);
        return { output, verdict: 'unknown' };
    }
    if (samples.length) {
        const judged = await judgeAgainstSamples(page, samples, output);
        if (judged) return judged;
    }
    return { output, verdict: classify(output) };
}

async function submit(page) {
    const submitButton = await findSubmitButton(page);
    console.log('Submitting...');
    const { output, timedOut } = await clickAndWaitForOutcome(page, submitButton, config.runTimeoutMs);
    return { output, verdict: timedOut ? 'unknown' : classify(output) };
}

/* ------------------------------------------------------------------ labs: Submit runs the hidden test suite */

// CSS-module class names carry a hash suffix (e.g. _testUnit_1unr7_52), so match on the stable prefix.
const TEST_UNIT = '[class*="_testUnit_"]';
const TEST_START_GRACE_MS = 20000;
const DETAIL_CHARS = 1200;

/** Runs in the browser: one entry per test in the Test results panel. */
function readTestUnits(unitSelector) {
    const clean = (text) => String(text || '')
        .replace(/(?:\u001b|\u241b)?\[[0-9;]*m/g, '') // ANSI colour codes from the test runner
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return [...document.querySelectorAll(unitSelector)].map((unit) => {
        const icon = unit.querySelector('svg');
        const marker = [icon?.getAttribute('data-testid'), icon?.getAttribute('class')].filter(Boolean).join(' ');
        const titleNode = unit.querySelector('[class*="_test_"]') || unit.firstElementChild || unit;
        const title = clean(titleNode.textContent).replace(/\s+/g, ' ');
        const detail = clean([...unit.children]
            .filter((child) => child !== titleNode && !child.contains(titleNode))
            .map((child) => child.textContent)
            .join('\n'));

        const running = Boolean(unit.querySelector('[role="progressbar"], [class*="CircularProgress"], [class*="spinner"]'));
        let state = 'unknown';
        if (running) state = 'running';
        else if (/idle|StopIcon|Pending|Hourglass|Schedule/i.test(marker)) state = 'pending';
        else if (/pass|success|Check|Done/i.test(marker)) state = 'pass';
        else if (/fail|error|Close|Clear|Cancel/i.test(marker)) state = 'fail';

        return { title, state, detail, marker };
    });
}

const testSignature = (tests) => JSON.stringify(tests.map((test) => [test.title, test.state, test.detail.length]));
const isBusy = (tests) => !tests.length || tests.some((test) => test.state === 'running' || test.state === 'pending');

function formatTestReport(tests) {
    const passed = tests.filter((test) => test.state === 'pass').length;
    const lines = [`Test results: ${passed}/${tests.length} passed`];
    for (const test of tests) {
        const label = test.state === 'unknown' ? `UNKNOWN icon: ${test.marker}` : test.state.toUpperCase();
        lines.push(`[${label}] ${test.title}`);
        if (test.state !== 'pass' && test.detail) {
            lines.push(test.detail.slice(0, DETAIL_CHARS).replace(/^/gm, '    '));
        }
    }
    return lines.join('\n');
}

/**
 * Waits for the panel to show fresh results: first for the run to start (results change or go busy),
 * then until every test has a final state that stays the same for two ticks.
 */
async function waitForTestResults(page, before, timeoutMs) {
    const start = Date.now();
    let started = false;
    let previous = '';
    let stableTicks = 0;
    let tests = [];

    while (Date.now() - start < timeoutMs) {
        await page.waitForTimeout(1000);
        tests = await page.evaluate(readTestUnits, TEST_UNIT);
        const signature = testSignature(tests);
        const busy = isBusy(tests);

        if (busy || signature !== before) started = true;
        if (!started && Date.now() - start < TEST_START_GRACE_MS) continue;

        stableTicks = signature === previous ? stableTicks + 1 : 0;
        previous = signature;
        if (!busy && stableTicks >= 2) return { tests, timedOut: false };
    }
    return { tests, timedOut: true };
}

async function submitAndReadTests(page) {
    const before = testSignature(await page.evaluate(readTestUnits, TEST_UNIT));
    const submitButton = await findSubmitButton(page);

    console.log('Submitting and waiting for test results...');
    await submitButton.click();
    const { tests, timedOut } = await waitForTestResults(page, before, config.runTimeoutMs);

    if (!tests.length) {
        return { verdict: 'unknown', output: 'No test results appeared after submitting.', tests };
    }
    if (timedOut) console.warn(`Tests did not finish within ${config.runTimeoutMs / 1000}s.`);

    const allPassed = tests.every((test) => test.state === 'pass');
    const anyFailed = tests.some((test) => test.state === 'fail');
    const verdict = timedOut ? 'unknown' : allPassed ? 'pass' : anyFailed ? 'fail' : 'unknown';
    return { verdict, output: formatTestReport(tests), tests };
}

/* ------------------------------------------------------------------ strategy selection */

/**
 * How a solution gets checked, per editor type.
 * `submits: true` means checking already submits, so no separate submit step follows.
 */
function verificationFor(editorType, samples = []) {
    if (editorType === 'monaco') {
        return { label: 'Tests', submits: true, check: (page) => submitAndReadTests(page) };
    }
    return { label: 'Run', submits: false, check: (page) => runProject(page, samples) };
}

module.exports = {
    classify,
    runProject,
    submit,
    submitAndReadTests,
    verificationFor,
};