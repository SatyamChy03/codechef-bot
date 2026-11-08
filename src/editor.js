'use strict';

const config = require('./config');

// Practice problems use a single Ace editor plus a language dropdown. The bot names that
// one file "solution.<ext>" so the AI knows the language from the extension.
// Lab/project pages (Monaco editor with file tabs) are deliberately not supported.

const baseName = (filePath) => String(filePath || '').split(/[\\/]/).pop();
const normalize = (text) => String(text ?? '')
  .replace(/[ \t]+$/gm, '')
  .replace(/\r\n/g, '\n')
  .trimEnd();

const EDITOR_WAIT_MS = 60000;
let currentFile = null;

const aceReady = async (page) => (await page.locator('.ace_editor').count()) > 0;
const isLabPage = async (page) => (await page.locator('.monaco-editor').count()) > 0;

function extensionForLanguage(language) {
  const lang = language.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^c\+\+/.test(lang)) return 'cpp';
  if (/^(python|pypy)/.test(lang)) return 'py';
  if (/^c#/.test(lang)) return 'cs';
  const map = {
    c: 'c', java: 'java', javascript: 'js', go: 'go', typescript: 'ts',
    php: 'php', kotlin: 'kt', rust: 'rs', r: 'r', ocaml: 'ml',
  };
  return map[lang] || null;
}

/** Runs in the browser: the language dropdown's current value ('' while loading). */
function readLanguage() {
  const native = document.querySelector('.MuiSelect-nativeInput');
  const combo = document.querySelector('#language-select');
  return ((native && native.value) || (combo && combo.innerText) || '').replace(/​/g, '').trim();
}

async function selectLanguage(page, wanted) {
  const current = await page.evaluate(readLanguage);
  if (current.toLowerCase() === wanted.toLowerCase()) return current;

  console.log(`[editor] switching language ${current || '(unknown)'} -> ${wanted}`);
  // Accept a native "your code will be reset" confirm if one appears.
  const acceptDialog = (dialog) => dialog.accept().catch(() => {});
  page.once('dialog', acceptDialog);
  try {
    await page.locator('#language-select, [role="combobox"]').first().click();
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await page.getByRole('option', { name: new RegExp(`^\\s*${escaped}\\s*$`, 'i') }).first()
      .click({ timeout: 10000 });
    const confirm = page.getByRole('button', { name: /^\s*(yes|ok|confirm|change|continue)\s*$/i }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    let selected = '';
    for (let tick = 0; tick < 20; tick += 1) {
      selected = await page.evaluate(readLanguage);
      if (selected.toLowerCase() === wanted.toLowerCase()) break;
      await page.waitForTimeout(500);
    }
    if (selected.toLowerCase() !== wanted.toLowerCase()) {
      throw new Error(`[editor] could not switch language to "${wanted}" (still "${selected}")`);
    }
  } finally {
    page.off('dialog', acceptDialog);
  }
  await page.waitForTimeout(1500); // the starter code for the new language loads after the switch
  return wanted;
}

/** Waits for the language dropdown to load, optionally switches it, and returns "solution.<ext>". */
async function detectFileName(page) {
  await page.waitForFunction(readLanguage, null, { timeout: 30000 })
    .catch(() => console.warn('[editor] language dropdown did not load within 30s'));
  let language = await page.evaluate(readLanguage);
  if (config.language) language = await selectLanguage(page, config.language);

  const ext = extensionForLanguage(language);
  if (!ext) console.warn(`[editor] unknown language "${language}"; naming the file solution.txt`);
  currentFile = `solution.${ext || 'txt'}`;
  console.log(`[editor] practice editor detected: language=${language || 'unknown'}, file=${currentFile}`);
  return currentFile;
}

/** Returns ["solution.<ext>"] once the practice editor is ready, or [] if none appears. */
async function listOpenFiles(page) {
  const deadline = Date.now() + EDITOR_WAIT_MS;
  while (Date.now() < deadline) {
    if (await aceReady(page)) return [await detectFileName(page)];
    if (await isLabPage(page)) {
      throw new Error('This is a lab/project page (Monaco editor). Only practice problems are supported.');
    }
    await page.waitForTimeout(1000);
  }
  console.warn(`[editor] no practice editor found within ${EDITOR_WAIT_MS / 1000}s`);
  return [];
}

async function activeFileName() {
  return currentFile;
}

function aceGetValue() {
  const node = document.querySelector('.ace_editor');
  const instance = node && node.env && node.env.editor;
  return instance ? instance.getValue() : null;
}

function aceSetValue(text) {
  const node = document.querySelector('.ace_editor');
  const instance = node && node.env && node.env.editor;
  if (!instance) return null;
  instance.setValue(text, -1);
  instance.clearSelection();
  return instance.getValue();
}

async function readFiles(page, fileNames) {
  const value = await page.evaluate(aceGetValue);
  if (value == null) throw new Error('[editor] could not read the practice editor.');
  return Object.fromEntries(fileNames.map((name) => [name, value]));
}

async function writeFile(page, fileName, content) {
  const after = await page.evaluate(aceSetValue, String(content));
  if (after == null || normalize(after) !== normalize(content)) {
    throw new Error(`[editor] ${baseName(fileName)}: write verification failed`);
  }
  return after;
}

module.exports = {
  baseName,
  normalize,
  listOpenFiles,
  activeFileName,
  readFiles,
  writeFile,
};
