const config = require('./config');

const BUSY_PATTERN = /\b(running|compiling|executing|submitting|evaluating|judging|in queue|queued|pending|fetching|loading|processing)\b/i;
const FAIL_PATTERN = /compilation error|compile error|compiler error|runtime error|wrong answer|time limit exceeded|memory limit exceeded|segmentation fault|exception|traceback|\berror\b|\bfailed\b|\bfailure\b/i;
const PASS_PATTERN = /all tests? (?:cases? )?passed|\baccepted\b|\bpassed\b|\bsuccess(?:ful)?\b|correct answer/i;
const COUNT_PATTERN = /(\d+)\s*(?:\/|out of|of)\s*(\d+)\s*(?:test\s*cases?|tests?)?\s*passed/gi;

const SETTLE_TICKS = 3;
const NO_CHANGE_GRACE_MS = 10000;

const splitLines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
const tokens = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).join(' ');

/** Classifies output text as 'pass', 'fail', or 'unknown'. Heuristic; tune to CodeChef's wording. */
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

/** Page text without the code editors, so the code itself never looks like "new output". */
function pageText(page) {
    return page.evaluate(() => {
        const editors = [...document.querySelectorAll('.ace_editor')];
        const previous = editors.map((node) => node.style.display);
        editors.forEach((node) => { node.style.display = 'none'; });
        try {
            return document.body.innerText;
        } finally {
            editors.forEach((node, index) => { node.style.display = previous[index]; });
        }
    });
}

/**
 * Runs in the browser. Returns the text under the last element labelled `heading`
 * (e.g. "Your Output" in the practice output panel), or null if there is none.
 */
function readPanel(heading) {
    const labels = [...document.querySelectorAll('body *')].filter((element) =>
        element.children.length <= 1 && (element.innerText || '').trim().toLowerCase() === heading.toLowerCase());
    const label = labels[labels.length - 1];
    if (!label) return null;
    if (label.nextElementSibling) return label.nextElementSibling.innerText;
    const parentText = label.parentElement ? label.parentElement.innerText : '';
    return parentText.slice(parentText.indexOf(label.innerText) + label.innerText.length);
}

/**
 * Clicks a button, then waits until the page settles: the text stops changing for a few
 * seconds and nothing new looks busy. Returns only the lines that appeared after the click
 * (approximating the output panel), or the full page text if none did.
 */
async function clickAndWaitForOutcome(page, button, timeoutMs) {
    const before = await pageText(page);
    const beforeLines = new Set(splitLines(before));
    await button.click();

    const start = Date.now();
    let previous = before;
    let stableTicks = 0;
    let sawChange = false;
    let current = before;

    while (Date.now() - start < timeoutMs) {
        await page.waitForTimeout(1000);
        current = await pageText(page);
        if (current !== before) sawChange = true;
        stableTicks = current === previous ? stableTicks + 1 : 0;
        previous = current;

        const fresh = splitLines(current).filter((line) => !beforeLines.has(line)).join('\n');
        const settled = stableTicks >= SETTLE_TICKS && !BUSY_PATTERN.test(fresh);
        if (settled && (sawChange || Date.now() - start > NO_CHANGE_GRACE_MS)) {
            return { output: fresh || current, timedOut: false };
        }
    }

    const fresh = splitLines(current).filter((line) => !beforeLines.has(line)).join('\n');
    return { output: fresh || current, timedOut: true };
}

/**
 * Practice pages don't judge a Run; they only show "Your Output" for the custom input
 * (pre-filled with sample 1). Compare it with the matching sample's expected output.
 */
async function judgeAgainstSamples(page, samples, panelText) {
    const yourOutput = await page.evaluate(readPanel, 'Your Output');
    if (yourOutput == null) return null;

    const customInput = await page.evaluate(() => {
        const box = [...document.querySelectorAll('textarea')]
            .find((textarea) => !textarea.closest('.ace_editor'));
        return box ? box.value : '';
    });
    const sample = samples.find((s) => tokens(s.input) === tokens(customInput)) || samples[0];
    const passed = tokens(yourOutput) === tokens(sample.output);
    // Keep the report small: it is sent to the AI on every fix attempt. "Your Output" also
    // carries compiler/runtime errors, so the rest of the panel is only a fallback.
    const shown = yourOutput.trim() || panelText;
    const report = `Sample input:\n${sample.input}\n\nExpected output:\n${sample.output}\n\nYour output:\n${shown}`;
    return { output: report, verdict: passed ? 'pass' : 'fail' };
}

async function runProject(page, samples = []) {
    const runButton = page.locator('button, [role="button"]')
        .filter({ hasText: /^\s*Run\s*$/i }).first();
    await runButton.waitFor({ state: 'visible', timeout: 30000 });

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
    let submitButton = page.getByRole('button', { name: /^\s*submit\s*$/i }).first();
    if (await submitButton.count() === 0) {
        submitButton = page.locator('[class*="submit__btn"]').first();
    }
    await submitButton.waitFor({ state: 'visible', timeout: 15000 });

    console.log('Submitting...');
    const { output, timedOut } = await clickAndWaitForOutcome(page, submitButton, config.runTimeoutMs);
    return { output, verdict: timedOut ? 'unknown' : classify(output) };
}

module.exports = { runProject, submit, classify };
