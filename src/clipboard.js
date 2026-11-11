'use strict';

/**
 * Copy/paste plumbing for editors that only expose their text through the clipboard.
 *
 * Copies are captured inside the page (DataTransfer.setData and navigator.clipboard.writeText),
 * with the real system clipboard as a fallback. A sentinel is written before every copy, so a
 * copy that never happened raises an error instead of returning stale or empty text.
 */

const COPY = 'ControlOrMeta+C';
const PASTE = 'ControlOrMeta+V';
const CAPTURE_TIMEOUT_MS = 2000;

const permittedContexts = new WeakSet();

/** Runs in the browser. Idempotent per page load. */
function installHooks() {
    if (window.__botClipboard) return;

    const clip = navigator.clipboard;
    const systemWrite = clip?.writeText?.bind(clip);
    const systemRead = clip?.readText?.bind(clip);

    const state = {
        copied: null,
        // While set, the page's own paste handling (VS Code web reads navigator.clipboard) receives this text.
        pending: null,
        async writeSystem(text) {
            try { await systemWrite?.(text); } catch { /* permission or focus denied */ }
        },
        async readSystem() {
            try { return systemRead ? await systemRead() : null; } catch { return null; }
        },
    };
    window.__botClipboard = state;

    const setData = DataTransfer.prototype.setData;
    DataTransfer.prototype.setData = function (format, data) {
        if (/^text(\/plain)?$/i.test(format)) state.copied = String(data ?? '');
        return setData.call(this, format, data);
    };

    if (!clip) return;

    if (systemWrite) {
        clip.writeText = (text) => {
            state.copied = String(text ?? '');
            return systemWrite(text);
        };
    }

    clip.readText = async () => (state.pending !== null ? state.pending : (systemRead ? systemRead() : ''));

    const systemReadItems = clip.read?.bind(clip);
    if (systemReadItems && typeof ClipboardItem === 'function') {
        clip.read = async () => (state.pending !== null
            ? [new ClipboardItem({ 'text/plain': new Blob([state.pending], { type: 'text/plain' }) })]
            : systemReadItems());
    }
}

async function prepare(page) {
    const context = page.context();
    if (!permittedContexts.has(context)) {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
        permittedContexts.add(context);
    }
    await page.evaluate(installHooks);
}

/** Presses copy in the focused element and returns exactly what it copied. */
async function copy(page) {
    await prepare(page);

    const sentinel = `codechef-bot:${Date.now()}:${Math.random()}`;
    await page.evaluate(async (marker) => {
        await window.__botClipboard.writeSystem(marker);
        window.__botClipboard.copied = null;
    }, sentinel);

    await page.keyboard.press(COPY);

    const captured = await page
        .waitForFunction(() => window.__botClipboard?.copied != null, null, { timeout: CAPTURE_TIMEOUT_MS })
        .then(() => page.evaluate(() => window.__botClipboard.copied), () => null);
    if (captured !== null) return captured;

    const system = await page.evaluate(() => window.__botClipboard?.readSystem() ?? null);
    if (system !== null && system !== sentinel) return system;

    throw new Error('[clipboard] Copy produced no text; the editor probably did not have focus.');
}

/** Dispatches a paste event carrying `text` to the focused element. True if the page handled it. */
async function pasteEvent(page, text) {
    return page.evaluate((value) => {
        const target = document.activeElement;
        if (!target || target === document.body) return false;
        const data = new DataTransfer();
        data.setData('text/plain', value);
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        return !target.dispatchEvent(event);
    }, text);
}

/**
 * Presses paste with `text` served both ways a page can read it: through navigator.clipboard
 * (how VS Code web handles Ctrl+V) and on the real system clipboard (native paste events).
 */
async function pasteWithKeyboard(page, text) {
    await prepare(page);
    await page.evaluate(async (value) => {
        window.__botClipboard.pending = value;
        await window.__botClipboard.writeSystem(value);
    }, text);

    try {
        await page.keyboard.press(PASTE);
        await page.waitForTimeout(300);
    } finally {
        await page.evaluate(() => {
            if (window.__botClipboard) window.__botClipboard.pending = null;
        }).catch(() => {});
    }
}

/**
 * Runs VS Code's own paste command through the embedder API, serving `text` as the clipboard.
 * Returns false when the page does not expose `window.workbench.commands`.
 */
async function pasteWithCommand(page, text) {
    await prepare(page);
    return page.evaluate(async (value) => {
        const commands = window.workbench?.commands;
        if (typeof commands?.executeCommand !== 'function') return false;
        window.__botClipboard.pending = value;
        try {
            await commands.executeCommand('editor.action.clipboardPasteAction');
            return true;
        } finally {
            window.__botClipboard.pending = null;
        }
    }, text);
}

module.exports = { copy, pasteEvent, pasteWithKeyboard, pasteWithCommand };