'use strict';

const config = require('./config');
const clipboard = require('./clipboard');

const EDITOR_WAIT_MS = 60000;
const VERIFY_TIMEOUT_MS = 10000;
const SAVE_TIMEOUT_MS = 5000;
const CONTENT_LOAD_MS = 10000;

const SELECT_ALL = 'ControlOrMeta+A';
const SAVE = 'ControlOrMeta+S';
const CURSOR_TO_START = 'ControlOrMeta+Home';

const EDITOR_SURFACES = '.monaco-editor, .ace_editor, .CodeMirror, .cm-editor';
const MONACO = '.monaco-editor:visible';
const MONACO_TABS = '.tabs-container [role="tab"][data-resource-name]';
const PAUSED_PATTERN = /lab is paused|lab paused|workspace paused/i;
const RESUME_BUTTON = /^\s*(reload the page|reload|resume|reconnect)\s*$/i;

/* ------------------------------------------------------------------ text helpers */

function baseName(filePath) {
    return String(filePath || '').replace(/\\/g, '/').split('/').pop();
}

function normalize(text) {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .trimEnd();
}

const sameText = (a, b) => normalize(a) === normalize(b);
const cssString = (value) => JSON.stringify(String(value));

function describeMismatch(expected, actual) {
    const want = normalize(expected).split('\n');
    const got = normalize(actual).split('\n');
    const diverged = want.findIndex((line, i) => line !== got[i]);
    const at = diverged === -1 ? want.length : diverged;
    const show = (line) => (line === undefined ? '<end of file>' : JSON.stringify(line.slice(0, 80)));
    return `line ${at + 1} expected ${show(want[at])}, editor has ${show(got[at])} ` +
        `(${got.length} lines read, ${want.length} expected)`;
}

async function poll(page, check, timeoutMs, intervalMs = 400) {
    const deadline = Date.now() + timeoutMs;
    do {
        if (await check()) return true;
        await page.waitForTimeout(intervalMs);
    } while (Date.now() < deadline);
    return false;
}

const CLICK_POINT = { x: 5, y: 5 };
const FOCUS_TIMEOUT_MS = 1500;
// The element that actually receives keystrokes: EditContext div in current VS Code,
// hidden textarea in older Monaco, the content node in CodeMirror 6.
const KEYBOARD_INPUTS = '.native-edit-context, textarea.inputarea, .cm-content';

/** Moves the mouse off the editor so hover widgets close and cannot intercept the next click. */
async function parkMouse(page) {
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape').catch(() => {});
}

/**
 * Clicks into an editor surface and waits until keyboard focus is inside it. Falls back to
 * focusing the editor's input element directly. On failure, reports where focus and the click went.
 */
async function focusSurface(surface, clickTarget) {
    const page = surface.page();
    const target = clickTarget ? surface.locator(clickTarget).first() : surface;
    const isFocused = () => surface.evaluate((element) => element.contains(document.activeElement));

    await target.click({ position: CLICK_POINT, force: true });
    if (await poll(page, isFocused, FOCUS_TIMEOUT_MS, 100)) return;

    const input = surface.locator(KEYBOARD_INPUTS).first();
    if (await input.count()) {
        await input.focus().catch(() => {});
        if (await poll(page, isFocused, FOCUS_TIMEOUT_MS, 100)) return;
    }

    const box = await target.boundingBox();
    const point = box ? { x: box.x + CLICK_POINT.x, y: box.y + CLICK_POINT.y } : { x: 0, y: 0 };
    const report = await page.evaluate(({ x, y }) => {
        const describe = (element) => {
            if (!element) return 'nothing';
            const id = element.id ? `#${element.id}` : '';
            const classes = typeof element.className === 'string'
                ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map((name) => `.${name}`).join('')
                : '';
            return `<${element.tagName.toLowerCase()}${id}${classes}>`;
        };
        return {
            focused: describe(document.activeElement),
            clicked: describe(document.elementFromPoint(x, y)),
            windowFocused: document.hasFocus(),
        };
    }, point);

    throw new Error(`[editor] Could not focus the editor. Focus is on ${report.focused}; ` +
        `the click landed on ${report.clicked}` +
        (report.windowFocused ? '.' : '; the browser window itself is not focused.'));
}

/* ------------------------------------------------------------------ lab pause */

/** Clicks through the "Lab is paused" dialog, only when that dialog is actually showing. */
async function resumeLab(page) {
    const paused = await page
        .evaluate((source) => new RegExp(source, 'i').test(document.body?.innerText || ''), PAUSED_PATTERN.source)
        .catch(() => false);
    if (!paused) return false;

    console.log('[editor] Lab is paused; resuming...');
    await page.locator('a, button, [role="button"]').filter({ hasText: RESUME_BUTTON }).first()
        .click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.locator('.monaco-editor, .tabs-container [role="tab"]').first()
        .waitFor({ state: 'visible', timeout: 45000 });
    console.log('[editor] Lab resumed.');
    return true;
}

/* ------------------------------------------------------------------ in-page editors (Ace, CodeMirror 5, textarea) */

// Each accessor runs in the browser: reads when `value` is undefined, otherwise writes, then returns the text.

function aceValue(value) {
    const editor = document.querySelector('.ace_editor')?.env?.editor;
    if (!editor) return null;
    if (value !== undefined) {
        editor.setValue(value, -1);
        editor.clearSelection();
    }
    return editor.getValue();
}

function codeMirror5Value(value) {
    const editor = document.querySelector('.CodeMirror')?.CodeMirror;
    if (!editor) return null;
    if (value !== undefined) editor.setValue(value);
    return editor.getValue();
}

function standaloneTextareaValue({ surfaces, value }) {
    const element = [...document.querySelectorAll('textarea')].find((item) =>
        item.getClientRects().length > 0 && !item.classList.contains('inputarea') && !item.closest(surfaces));
    if (!element) return null;
    if (value !== undefined) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return element.value;
}

function inPageAdapter(label, accessor, toArg = (value) => value) {
    return {
        detect: (page) => page.evaluate(accessor, toArg(undefined)).then((value) => value !== null),
        list: async () => ['solution.txt'],
        async read(page) {
            const value = await page.evaluate(accessor, toArg(undefined));
            if (value === null) throw new Error(`[editor] Could not read the ${label} editor.`);
            return value;
        },
        async write(page, fileName, content) {
            const actual = await page.evaluate(accessor, toArg(content));
            if (actual === null || !sameText(actual, content)) {
                throw new Error(`[editor] ${label} write verification failed for ${fileName}.`);
            }
            return actual;
        },
    };
}

/* ------------------------------------------------------------------ Ace language selection */

function readLanguageFromDOM() {
    const native = document.querySelector('.MuiSelect-nativeInput');
    const combo = document.querySelector('#language-select');
    return ((native && native.value) || (combo && combo.innerText) || '').replace(/\u200b/g, '').trim();
}

function extensionForLanguage(language) {
    const lang = String(language || '').toLowerCase().trim();
    if (lang.startsWith('c++')) return 'cpp';
    if (lang.startsWith('python') || lang.startsWith('pypy')) return 'py';
    if (lang.startsWith('c#')) return 'cs';
    const extensions = {
        c: 'c', java: 'java', javascript: 'js', typescript: 'ts', go: 'go', php: 'php',
        kotlin: 'kt', rust: 'rs', r: 'r', ocaml: 'ml', sql: 'sql',
    };
    return extensions[lang] || null;
}

async function selectLanguage(page, wanted) {
    const matches = (value) => value.toLowerCase() === String(wanted).toLowerCase();
    const current = await page.evaluate(readLanguageFromDOM);
    if (matches(current)) return current;

    const acceptDialog = (dialog) => dialog.accept().catch(() => {});
    page.once('dialog', acceptDialog);
    try {
        await page.locator('#language-select, [role="combobox"]').first().click();
        await page.getByRole('option', { name: String(wanted), exact: true }).first().click({ timeout: 10000 });

        const confirm = page.getByRole('button', { name: /^(yes|ok|confirm|change|continue)$/i }).first();
        if (await confirm.isVisible().catch(() => false)) await confirm.click();

        let selected = '';
        const switched = await poll(page, async () => matches(selected = await page.evaluate(readLanguageFromDOM)), 6000, 300);
        if (!switched) throw new Error(`[editor] Could not switch language to ${wanted}.`);
        return selected;
    } finally {
        page.off('dialog', acceptDialog);
    }
}

const ace = {
    ...inPageAdapter('Ace', aceValue),
    detect: (page) => page.locator('.ace_editor:visible').count().then(Boolean),
    async list(page) {
        let language = await page.evaluate(readLanguageFromDOM).catch(() => '');
        if (config.language) language = await selectLanguage(page, config.language);
        const fileName = `solution.${extensionForLanguage(language) || 'txt'}`;
        console.log(`[editor] Ace detected: ${language || 'unknown'} (${fileName})`);
        return [fileName];
    },
};

const codemirror5 = {
    ...inPageAdapter('CodeMirror 5', codeMirror5Value),
    detect: (page) => page.locator('.CodeMirror:visible').count().then(Boolean),
};

const textarea = inPageAdapter('textarea', standaloneTextareaValue, (value) => ({ surfaces: EDITOR_SURFACES, value }));

/* ------------------------------------------------------------------ CodeMirror 6 (clipboard based) */

const codemirror6 = {
    detect: (page) => page.locator('.cm-editor:visible').count().then(Boolean),
    list: async () => ['solution.txt'],
    async read(page) {
        const surface = page.locator('.cm-editor:visible').first();
        await focusSurface(surface, '.cm-content');
        await page.keyboard.press(SELECT_ALL);
        const text = await clipboard.copy(page);
        await page.keyboard.press(CURSOR_TO_START);
        return text;
    },
    async write(page, fileName, content) {
        const surface = page.locator('.cm-editor:visible').first();
        await focusSurface(surface, '.cm-content');
        await page.keyboard.press(SELECT_ALL);
        await page.keyboard.insertText(content);
        const actual = await this.read(page);
        if (!sameText(actual, content)) {
            throw new Error(`[editor] CodeMirror 6 write verification failed for ${fileName}: ${describeMismatch(content, actual)}`);
        }
        return actual;
    },
};

/* ------------------------------------------------------------------ Monaco (VS Code lab) */

const monacoFiles = new Map(); // workspace-relative path -> { tabName, uri }

const monacoTab = (page, tabName) => page.locator(`${MONACO_TABS}[data-resource-name=${cssString(tabName)}]`);

function readWorkspaceRoot() {
    const raw = document.querySelector('meta#vscode-workbench-web-configuration')?.getAttribute('data-settings');
    if (!raw) return null;
    try {
        const settings = JSON.parse(raw);
        const folder = settings.folderUri || settings.workspaceUri;
        return typeof folder === 'string' ? folder : (folder?.path || folder?.fsPath || null);
    } catch {
        return null;
    }
}

function decodePath(value) {
    try { return decodeURIComponent(value); } catch { return value; }
}

function workspaceRelativePath(uri, root) {
    const clean = (value) => decodePath(String(value)).replace(/\\/g, '/').replace(/\/+$/, '');
    let filePath;
    try { filePath = clean(new URL(uri).pathname); } catch { filePath = clean(uri); }
    const base = clean(root);

    if (!filePath.startsWith(`${base}/`)) {
        throw new Error(`[editor] File is outside workspace. file=${filePath}; root=${base}`);
    }
    const relative = filePath.slice(base.length + 1);
    if (!relative || relative.split('/').includes('..')) {
        throw new Error(`[editor] Invalid workspace-relative path: ${relative}`);
    }
    return relative;
}

async function selectMonacoTab(page, tabName) {
    await monacoTab(page, tabName).first().click({ force: true });
    await page.locator(`${MONACO_TABS}[data-resource-name=${cssString(tabName)}][aria-selected="true"]`)
        .first().waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForTimeout(150);
}

/** Brings the file's tab forward and returns the editor surface showing exactly that file. */
async function monacoSurface(page, fileName) {
    const file = monacoFiles.get(fileName);
    if (!file) throw new Error(`[editor] ${fileName} is not an open Monaco tab; refusing to touch it.`);

    await resumeLab(page);
    const surface = page.locator(`.monaco-editor[data-uri=${cssString(file.uri)}]:visible`).first();
    if (!(await surface.count())) {
        await selectMonacoTab(page, file.tabName);
        await surface.waitFor({ state: 'visible', timeout: 15000 });
    }
    return surface;
}

/**
 * Runs in the browser: [lineNumber, text] pairs for the rows Monaco has rendered right now.
 * Rows are matched to line numbers by their vertical offset; a row with no number is the
 * wrapped continuation of the row above. Returns null when line numbers are not shown.
 */
function renderedMonacoLines(root) {
    const rows = (selector) => [...root.querySelectorAll(selector)]
        .map((element) => ({ element, top: Math.round(Number.parseFloat(element.style.top)) }))
        .filter((row) => Number.isFinite(row.top));

    const numbers = new Map(rows('.margin-view-overlays > div').map(({ element, top }) =>
        [top, Number.parseInt(element.querySelector('.line-numbers')?.textContent, 10)]));
    if (![...numbers.values()].some(Number.isFinite)) return null;

    const decorations = '[class*="ghost-text"], [class*="inlay"], .codelens-decoration';
    const lines = [];
    let current = null;

    for (const { element, top } of rows('.view-lines > .view-line').sort((a, b) => a.top - b.top)) {
        const clone = element.cloneNode(true);
        clone.querySelectorAll(decorations).forEach((node) => node.remove());
        // With renderWhitespace on, spaces and tabs are drawn as · and → inside .mtkw spans.
        clone.querySelectorAll('.mtkw').forEach((node) => {
            node.textContent = node.textContent.replace(/[\u00b7\u2192]/g, ' ');
        });
        const text = clone.textContent.replace(/\u00a0/g, ' ');
        const number = numbers.get(top);

        if (Number.isFinite(number)) {
            current = [number, text];
            lines.push(current);
        } else if (current) {
            current[1] += text;
        }
    }
    return lines;
}

const STABLE_STEPS_AT_END = 2;
const MAX_SCROLL_STEPS = 500;
const WHEEL_STEP_PX = 100;

/** Waits until Monaco has painted the current scroll position (also covers smooth scrolling). */
async function settleRender(page) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(80);
}

/**
 * Ways to move Monaco's viewport from the top of the file to the bottom.
 * Keyboard is deterministic (Ctrl+Home reveals line 1, PageDown moves exactly one page);
 * the wheel is a fallback for when the editor will not take keyboard focus.
 */
const MONACO_SCROLLERS = {
    async keyboard(page, surface) {
        await focusSurface(surface, '.view-lines');
        return {
            toTop: () => page.keyboard.press(CURSOR_TO_START),
            next: () => page.keyboard.press('PageDown'),
            done: () => page.keyboard.press(CURSOR_TO_START),
        };
    },
    async wheel(page, surface) {
        const box = await surface.boundingBox();
        if (!box) throw new Error('[editor] Editor has no bounding box.');
        const hover = () => page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        return {
            toTop: async () => { await hover(); await page.mouse.wheel(0, -1e7); },
            next: async () => { await hover(); await page.mouse.wheel(0, WHEEL_STEP_PX); },
            done: async () => { await hover(); await page.mouse.wheel(0, -1e7); },
        };
    },
};

/** "3-5, 9" style summary for log messages. */
function describeRanges(numbers) {
    const ranges = [];
    for (const n of numbers) {
        const last = ranges[ranges.length - 1];
        if (last && n === last[1] + 1) last[1] = n;
        else ranges.push([n, n]);
    }
    return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/**
 * Reads the whole file from the rendered DOM, paging from top to bottom with the given scroller.
 * Returns { text } on success or { problem } describing what was missed.
 */
async function readMonacoRendered(page, surface, scrollerName) {
    const scroller = await MONACO_SCROLLERS[scrollerName](page, surface);
    const lines = new Map();
    let lastSeen = -1;

    try {
        await scroller.toTop();
        await settleRender(page);

        for (let stable = 0, steps = 0; stable < STABLE_STEPS_AT_END && steps < MAX_SCROLL_STEPS; steps += 1) {
            const visible = await surface.evaluate(renderedMonacoLines);
            if (!visible) return { problem: 'line numbers are not shown' };
            for (const [number, text] of visible) lines.set(number, text);

            const highest = lines.size ? Math.max(...lines.keys()) : 0;
            stable = highest === lastSeen ? stable + 1 : 0;
            lastSeen = highest;

            await scroller.next();
            await settleRender(page);
        }
    } finally {
        await scroller.done().catch(() => {});
        await parkMouse(page);
    }

    if (!lines.size) return { problem: 'no lines rendered' };
    const total = Math.max(...lines.keys());
    const missing = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !lines.has(n));
    if (missing.length) return { problem: `lines ${describeRanges(missing)} of ${total} never rendered` };
    return { text: Array.from({ length: total }, (_, i) => lines.get(i + 1)).join('\n') };
}

async function readMonacoSurface(page, surface) {
    const problems = [];
    for (const scrollerName of Object.keys(MONACO_SCROLLERS)) {
        try {
            const { text, problem } = await readMonacoRendered(page, surface, scrollerName);
            if (text !== undefined) return text;
            problems.push(`${scrollerName}: ${problem}`);
        } catch (error) {
            problems.push(`${scrollerName}: ${error.message}`);
        }
    }

    console.warn(`[editor] Rendered read failed (${problems.join('; ')}); trying the clipboard.`);
    await focusSurface(surface, '.view-lines');
    await page.keyboard.press(SELECT_ALL);
    const text = await clipboard.copy(page);
    await page.keyboard.press(CURSOR_TO_START);
    return text;
}

async function saveMonaco(page, surface, fileName, content) {
    const { tabName } = monacoFiles.get(fileName);
    await focusSurface(surface, '.view-lines');
    await page.keyboard.press(SAVE);

    const saved = await page.locator(`${MONACO_TABS}[data-resource-name=${cssString(tabName)}]:not(.dirty)`)
        .first().waitFor({ state: 'attached', timeout: SAVE_TIMEOUT_MS })
        .then(() => true, () => false);
    if (!saved) console.warn(`[editor] ${fileName} still shows unsaved changes after Ctrl+S.`);

    const final = await readMonacoSurface(page, surface);
    if (!sameText(final, content)) {
        console.warn(`[editor] ${fileName} changed on save (formatter?): ${describeMismatch(content, final)}`);
    }
    return final;
}

/** Runs a VS Code command through the embedder API; false when the page does not expose one. */
function runWorkbenchCommand(page, commandId) {
    return page.evaluate(async (id) => {
        const commands = window.workbench?.commands;
        if (typeof commands?.executeCommand !== 'function') return false;
        await commands.executeCommand(id);
        return true;
    }, commandId).catch(() => false);
}

const hasMonacoSelection = (surface) =>
    surface.evaluate((element) => element.querySelectorAll('.view-overlays .selected-text').length > 0);

// Labs can swallow Ctrl+A, so the command API and an explicit range come before the shortcut.
const SELECT_ALL_METHODS = [
    ['select-all command', (page) => runWorkbenchCommand(page, 'editor.action.selectAll')],
    ['Ctrl+Home, Ctrl+Shift+End', async (page) => {
        await page.keyboard.press(CURSOR_TO_START);
        await page.keyboard.press('ControlOrMeta+Shift+End');
        return true;
    }],
    ['Ctrl+A', async (page) => { await page.keyboard.press(SELECT_ALL); return true; }],
];

/** True when Monaco shows a single blank line, i.e. the file is empty and there is nothing to select. */
const isMonacoEmpty = (surface) => surface.evaluate((element) => {
    const lines = element.querySelectorAll('.view-lines > .view-line');
    return lines.length === 1 && !lines[0].textContent.replace(/\u00a0/g, ' ').trim();
});

/** Selects the whole file and confirms Monaco shows a selection, so a paste replaces instead of inserting. */
async function selectAllMonaco(page, surface) {
    if (await isMonacoEmpty(surface)) return 'empty file';

    for (const [label, select] of SELECT_ALL_METHODS) {
        if (await select(page) === false) continue;
        await settleRender(page);
        if (await hasMonacoSelection(surface)) return label;
    }
    throw new Error('[editor] Could not select the editor contents; refusing to paste on top of existing code.');
}

// Tried in order after select-all. A strategy returns false when it does not apply on this page.
const PASTE_STRATEGIES = [
    ['workbench paste command', (page, content) => clipboard.pasteWithCommand(page, content)],
    ['inserted text', async (page, content) => { await page.keyboard.insertText(content); return true; }],
    ['keyboard paste', async (page, content) => { await clipboard.pasteWithKeyboard(page, content); return true; }],
    ['paste event', (page, content) => clipboard.pasteEvent(page, content)],
];

// Leading indentation is only compared where it changes meaning; elsewhere it is presentation,
// and both Monaco's auto-indent and its whitespace rendering can shift it.
const INDENT_SENSITIVE = /\.(py|pyw|yaml|yml|mk)$|(^|\/)Makefile$/i;
const stripIndent = (text) => normalize(text).replace(/^[ \t]+/gm, '');
const sameCode = (fileName, a, b) =>
    (INDENT_SENSITIVE.test(fileName) ? sameText(a, b) : stripIndent(a) === stripIndent(b));

const monaco = {
    detect: (page) => page.locator(MONACO).count().then(Boolean),

    async list(page) {
        const root = await page.evaluate(readWorkspaceRoot);
        if (!root) throw new Error('[editor] Could not read workspace root from workbench configuration.');

        const tabs = await page.locator(MONACO_TABS).evaluateAll((nodes) => nodes
            .map((node) => ({
                name: node.getAttribute('data-resource-name'),
                selected: node.getAttribute('aria-selected') === 'true',
            }))
            .filter((tab) => tab.name));
        if (!tabs.length) throw new Error('[editor] Monaco found, but no open file tabs were found.');

        const duplicate = tabs.find((tab, i) => tabs.findIndex((other) => other.name === tab.name) !== i);
        if (duplicate) throw new Error(`[editor] Two open tabs are named ${duplicate.name}; close one and retry.`);

        monacoFiles.clear();
        for (const tab of tabs) {
            await selectMonacoTab(page, tab.name);
            const uri = await page.locator(MONACO).first().getAttribute('data-uri');
            if (!uri) throw new Error(`[editor] Missing data-uri for open tab ${tab.name}.`);
            monacoFiles.set(workspaceRelativePath(uri, root), { tabName: tab.name, uri });
        }

        const original = tabs.find((tab) => tab.selected) || tabs[0];
        await selectMonacoTab(page, original.name);

        const names = [...monacoFiles.keys()];
        console.log(`[editor] Monaco: ${names.length} open file(s): ${names.join(', ')}`);
        const active = names.find((name) => monacoFiles.get(name).tabName === original.name);
        return [active, ...names.filter((name) => name !== active)];
    },

    async read(page, fileName) {
        const surface = await monacoSurface(page, fileName);
        let text = await readMonacoSurface(page, surface);

        // VS Code shows the editor before the lab server has sent the file, so an empty read
        // right after opening usually means "not loaded yet" rather than "empty file".
        const deadline = Date.now() + CONTENT_LOAD_MS;
        while (!normalize(text) && Date.now() < deadline) {
            await page.waitForTimeout(1000);
            text = await readMonacoSurface(page, surface);
        }
        return text;
    },

    async write(page, fileName, content) {
        const surface = await monacoSurface(page, fileName);
        let actual = '';

        let readError = null;

        // A read can fail while the editor is still repainting after the paste; that is a retry, not a failure.
        const verify = async () => {
            try {
                actual = await readMonacoSurface(page, surface);
                readError = null;
                return sameCode(fileName, actual, content);
            } catch (error) {
                readError = error;
                return false;
            }
        };
        const reason = () => (readError ? readError.message : describeMismatch(content, actual));

        for (const [label, paste] of PASTE_STRATEGIES) {
            await focusSurface(surface, '.view-lines');
            await selectAllMonaco(page, surface);
            if (await paste(page, content) === false) {
                console.log(`[editor] ${label} is not available on this page; skipping.`);
                continue;
            }

            if (await poll(page, verify, VERIFY_TIMEOUT_MS)) {
                console.log(`[editor] Wrote ${fileName} via ${label}.`);
                return saveMonaco(page, surface, fileName, content);
            }
            console.warn(`[editor] ${label} did not stick for ${fileName}: ${reason()}`);
        }

        throw new Error(`[editor] Monaco write verification failed for ${fileName}: ${reason()}`);
    },
};

/* ------------------------------------------------------------------ registry and public API */

// Detection order matters: Monaco pages can also contain textareas.
const ADAPTERS = { monaco, ace, codemirror5, codemirror6, textarea };

let active = null;
let currentFile = null;

async function detectEditorType(page) {
    await resumeLab(page);
    for (const [type, adapter] of Object.entries(ADAPTERS)) {
        if (await adapter.detect(page).catch(() => false)) return type;
    }
    return null;
}

function requireActive() {
    if (!active) throw new Error('[editor] No active editor detected; call listOpenFiles first.');
    return active;
}

async function listOpenFiles(page) {
    const deadline = Date.now() + EDITOR_WAIT_MS;
    while (Date.now() < deadline) {
        const type = await detectEditorType(page);
        if (type) {
            active = ADAPTERS[type];
            const files = await active.list(page);
            currentFile = files[0];
            return files;
        }
        await page.waitForTimeout(500);
    }
    throw new Error(`[editor] No supported editor found within ${EDITOR_WAIT_MS / 1000} seconds.`);
}

async function activeFileName() {
    return currentFile;
}

async function readFiles(page, fileNames) {
    const adapter = requireActive();
    if (!Array.isArray(fileNames) || !fileNames.length) {
        throw new Error('[editor] readFiles requires at least one file name.');
    }
    await resumeLab(page);

    const project = {};
    for (const fileName of fileNames) {
        project[fileName] = await adapter.read(page, fileName);
    }
    return project;
}

/** Writes a file and returns the text the editor ended up holding. */
async function writeFile(page, fileName, content) {
    const adapter = requireActive();
    if (typeof content !== 'string') throw new Error(`[editor] Source for ${fileName} must be a string.`);
    await resumeLab(page);
    currentFile = fileName;
    return adapter.write(page, fileName, content);
}

module.exports = {
    baseName,
    normalize,
    resumeLab,
    detectEditorType,
    listOpenFiles,
    activeFileName,
    readFiles,
    writeFile,
};