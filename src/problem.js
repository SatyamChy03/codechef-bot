const fs = require('fs');
const path = require('path');
const config = require('./config');

// Every matching element is a candidate content section. Sections are merged in page
// order; nested matches are folded into their outermost match. Falls back to <body>.
const CONTENT_SELECTORS = [
    '[class*="problem-statement"]',
    '[class*="problemStatement"]',
    '[class*="ProblemStatement"]',
    '[id*="problem-statement"]',
    '[class*="statement"]',
    '[class*="problem-body"]',
    '[class*="question"]',
    '[class*="Question"]',
    '[class*="task"]',
    '[class*="Task"]',
    '[class*="description"]',
    '[role="tabpanel"]',
    'main',
    'article',
];
const MIN_STATEMENT_LENGTH = 200;
// Buttons that reveal collapsed content. Deliberately excludes links and "view all" so we never navigate away.
const EXPAND_PATTERN = /^\s*(show more|read more|expand|expand all|show all)\s*$/i;

async function openProblem(page, url = config.problemUrl) {
    if (page.url() !== url) {
        console.log('Navigating to problem...');
        await page.goto(url);
    }

    // Continue as soon as either an editor or the mobile "desktop version" prompt appears,
    // instead of always waiting a fixed 5s for a prompt that desktop pages never show.
    const desktopBtn = page.locator('text=Open Desktop Version');
    await Promise.race([
        desktopBtn.waitFor({ state: 'visible', timeout: 15000 }),
        page.locator('.ace_editor').first().waitFor({ state: 'attached', timeout: 15000 }),
    ]).catch(() => {});
    if (await desktopBtn.isVisible().catch(() => false)) {
        await desktopBtn.click();
        await page.waitForTimeout(3000);
    }
}

/** True when CodeChef shows the logged-out 403 page (expired session). */
async function isAccessDenied(page) {
    return page.evaluate(() => /Access to this contest is restricted|please login to your CodeChef account/i
        .test(document.body ? document.body.innerText : ''));
}

/**
 * Finds the next problem in the module. Prefers the top-bar "Next" link (it carries the next
 * problem's URL); falls back to clicking the bottom "Next" button and waiting for the URL to
 * change. Returns the next URL, or null at the end of the module.
 */
async function goToNextProblem(page) {
    const current = page.url();
    // The top bar renders after the editor; give the link a moment (it's absent at module end).
    await page.waitForFunction(() => [...document.querySelectorAll('a[href]')]
        .some((a) => /^\s*Next\s*›?\s*$/i.test(a.innerText || '')), null, { timeout: 8000 })
        .catch(() => {});
    const href = await page.evaluate(() => {
        const link = [...document.querySelectorAll('a[href]')]
            .find((a) => /^\s*Next\s*›?\s*$/i.test(a.innerText || ''));
        return link ? link.href : null;
    });
    if (href && href !== current) return href;

    const button = page.locator('button').filter({ hasText: /^\s*Next\s*$/i }).last();
    if (!(await button.isVisible().catch(() => false))) return null;
    await button.click();
    const moved = await page.waitForURL((u) => u.href !== current, { timeout: 15000 })
        .then(() => true, () => false);
    return moved ? page.url() : null;
}

/** Opens <details> and clicks "Show more"-style buttons so collapsed text becomes copyable. */
async function expandCollapsedContent(page) {
    await page.evaluate(() => {
        document.querySelectorAll('details:not([open])').forEach((details) => { details.open = true; });
    });
    const expanders = page.locator('button, [role="button"]').filter({ hasText: EXPAND_PATTERN });
    for (const expander of await expanders.all()) {
        if (await expander.isVisible().catch(() => false)) {
            await expander.click({ timeout: 2000 }).catch(() => {});
        }
    }
    await page.waitForTimeout(500);
}

/**
 * Runs in the browser. Collects every main-content section (statement, all
 * questions/tasks, hidden tab panels) while skipping navigation, header,
 * footer, and the code editor. Must stay self-contained.
 */
function extractMainContent(selectors) {
    // KaTeX renders each formula twice (MathML + HTML), which innerText garbles. Temporarily
    // swap each formula for its TeX source, e.g. "$1 \le M \le 45000$", and undo it at the end.
    const texSpans = [];
    const hiddenKatex = [];
    for (const katex of document.querySelectorAll('.katex')) {
        const tex = katex.querySelector('annotation[encoding="application/x-tex"]');
        if (!tex) continue;
        const span = document.createElement('span');
        span.textContent = `$${tex.textContent.trim()}$`;
        katex.after(span);
        texSpans.push(span);
        hiddenKatex.push([katex, katex.style.display]);
        katex.style.display = 'none';
    }

    try {
        return collect();
    } finally {
        texSpans.forEach((span) => span.remove());
        hiddenKatex.forEach(([katex, display]) => { katex.style.display = display; });
    }

    function collect() {
    const isExcluded = (element) =>
        element.closest('header, nav, footer, [role="navigation"], [role="banner"], .ace_editor')
        || element.querySelector('.ace_editor');
    const tidy = (text) => (text || '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const isRendered = (element) => element.getClientRects().length > 0;
    const countImages = (element) => [...element.querySelectorAll('img, canvas, svg')]
        .filter((image) => image.tagName !== 'svg' || image.getBoundingClientRect().width > 100)
        .length;

    const candidates = new Set();
    for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
            if (!isExcluded(element)) candidates.add(element);
        }
    }
    const list = [...candidates];
    const outermost = list
        .filter((element) => !list.some((other) => other !== element && other.contains(element)))
        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

    // Hidden tab panels (e.g. "Task 2" not selected) are skipped by innerText, so read them separately.
    const hiddenPanels = [...document.querySelectorAll('[role="tabpanel"]')]
        .filter((panel) => !isExcluded(panel) && !isRendered(panel));

    const sections = [];
    const seen = new Set();
    let imageCount = 0;
    for (const element of [...outermost, ...hiddenPanels]) {
        const text = tidy(isRendered(element) ? element.innerText : element.textContent);
        if (text.length < 40 || seen.has(text) || sections.some((section) => section.includes(text))) continue;
        seen.add(text);
        sections.push(text);
        imageCount += countImages(element);
    }
    return { text: sections.join('\n\n---\n\n'), imageCount, sectionCount: sections.length };
    }
}

/**
 * Reads the statement's sample tests as [{ input, output }]. On practice pages they are
 * consecutive <pre> blocks (input, output) inside a "values" container. Call this before
 * any Run, so the output panel's own <pre> blocks can't be mistaken for samples.
 */
async function readSamples(page) {
    const blocks = await page.evaluate(() => {
        const all = [...document.querySelectorAll('pre')]
            .filter((pre) => !pre.closest('.ace_editor'));
        const inValues = all.filter((pre) => pre.closest('[class*="values"]'));
        return (inValues.length ? inValues : all).map((pre) => pre.innerText.replace(/\r\n/g, '\n').trim());
    });
    if (!blocks.length || blocks.length % 2 !== 0) return [];
    const samples = [];
    for (let i = 0; i < blocks.length; i += 2) samples.push({ input: blocks[i], output: blocks[i + 1] });
    return samples;
}

/**
 * Copies all the main content of the page as text: the statement and every
 * question/task section, including collapsed parts and unselected tab panels.
 * Returns { text, imageCount }. Images can't be copied as text, so callers may
 * want screenshots when imageCount > 0.
 */
async function readProblemText(page) {
    await expandCollapsedContent(page);
    let result = await page.evaluate(extractMainContent, CONTENT_SELECTORS);

    if (result.text.length < MIN_STATEMENT_LENGTH) {
        console.log('Main content sections not found; using full page text.');
        result = { text: (await page.innerText('body')).trim(), imageCount: 0, sectionCount: 1 };
    }

    fs.mkdirSync(config.debugDir, { recursive: true });
    const savedPath = path.join(config.debugDir, 'last-problem.txt');
    fs.writeFileSync(savedPath, result.text);
    console.log(`Copied ${result.sectionCount} content section(s), ${result.text.length} chars -> ${savedPath}`);
    return { text: result.text, imageCount: result.imageCount };
}

/**
 * Runs in the browser. Finds the main scrollable area (the largest overflow
 * container, or the document) and either measures it or scrolls it.
 * Must stay self-contained because Playwright serializes it.
 */
function scrollMainArea({ action, position }) {
    const candidates = [...document.querySelectorAll('*')].filter((element) => {
        const style = getComputedStyle(element);
        return element.scrollHeight > element.clientHeight + 100 &&
            ['auto', 'scroll'].includes(style.overflowY) &&
            element.clientHeight > 200;
    });
    const target = candidates.sort((a, b) =>
        (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)
    )[0] || document.scrollingElement;

    if (action === 'measure') {
        return { scrollHeight: target.scrollHeight, clientHeight: target.clientHeight };
    }
    if (target === document.scrollingElement) {
        window.scrollTo(0, position);
    } else {
        target.scrollTop = position;
    }
    return null;
}

/** Returns Gemini inlineData parts for top / middle / bottom viewport screenshots. */
async function captureScreenshots(page) {
    const { scrollHeight, clientHeight } = await page.evaluate(scrollMainArea, { action: 'measure' });
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const positions = maxScroll > 100 ? [0, Math.round(maxScroll / 2), maxScroll] : [0];

    const parts = [];
    for (const [index, position] of positions.entries()) {
        await page.evaluate(scrollMainArea, { action: 'scroll', position });
        await page.waitForTimeout(500);
        const screenshot = await page.screenshot({ type: 'png', fullPage: false });
        console.log(`Captured screenshot ${index + 1}/${positions.length} at scroll position ${position}`);
        parts.push({ inlineData: { data: screenshot.toString('base64'), mimeType: 'image/png' } });
    }
    await page.evaluate(scrollMainArea, { action: 'scroll', position: 0 });
    return parts;
}

module.exports = { openProblem, isAccessDenied, goToNextProblem, readProblemText, readSamples, captureScreenshots };
