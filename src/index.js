'use strict';

for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => original(`[${new Date().toISOString()}]`, ...args);
}

const config = require('./config');
const { launch, saveDebugArtifacts } = require('./browser');
const { ensureLoggedIn } = require('./auth');
const {
    openProblem,
    isAccessDenied,
    goToNextProblem,
    readProblemText,
    readSamples,
    captureScreenshots,
} = require('./problem');
const editor = require('./editor');
const gemini = require('./gemini');
const prompts = require('./prompts');
const runner = require('./runner');
const progress = require('./progress');

const SUPPORTED_EDITORS = new Set(['ace', 'monaco']);
const EDITOR_DETECT_MS = 60000;

const tail = (text, lines = 30) => String(text ?? '').split('\n').slice(-lines).join('\n');
const oneLine = (text) => tail(text, 3).replace(/\n/g, ' | ');

/* ------------------------------------------------------------------ file helpers */

/** Maps the AI's returned paths onto open file names; anything else is ignored. */
function keepKnownFiles(files, fileNames) {
    const byBaseName = new Map(fileNames.map((name) => [editor.baseName(name), name]));
    const known = {};

    for (const [filePath, content] of Object.entries(files)) {
        const target = fileNames.includes(filePath) ? filePath : byBaseName.get(editor.baseName(filePath));
        if (target) known[target] = content;
        else console.warn(`Ignoring ${filePath}: not an open file in the IDE.`);
    }
    return known;
}

/** Writes files whose contents differ and keeps `project` in sync with what the editor holds. */
async function writeChangedFiles(page, project, changes) {
    let written = 0;
    for (const [fileName, source] of Object.entries(changes)) {
        if (editor.normalize(source) === editor.normalize(project[fileName] ?? '')) continue;
        project[fileName] = editor.normalize(await editor.writeFile(page, fileName, source));
        written += 1;
    }
    return written;
}

/**
 * The editor waits for file contents to load before reporting a file as empty, so an empty file here
 * is genuinely empty. Say so loudly: if it is not empty in the browser, stop the bot and report it.
 */
function warnAboutEmptyFiles(project) {
    const empty = Object.keys(project).filter((name) => !editor.normalize(project[name]));
    if (empty.length) {
        console.warn(`${empty.join(', ')} is empty; the AI will write it from scratch. ` +
            'If the file has code in the browser, press Ctrl+C now and report this.');
    }
}

/* ------------------------------------------------------------------ solving steps */

async function readStatement(page) {
    const { text: problemText, imageCount } = await readProblemText(page);
    const samples = await readSamples(page);
    if (samples.length) console.log(`Found ${samples.length} sample test(s); runs will be checked against them.`);

    let screenshots = [];
    if (config.useScreenshots) {
        screenshots = await captureScreenshots(page);
    } else if (imageCount > 0) {
        console.warn(`The statement contains ${imageCount} image(s). Set USE_SCREENSHOTS=true if the AI needs them.`);
    }
    return { problemText, samples, screenshots };
}

/** CodeChef mounts lab editors asynchronously, so poll instead of taking one snapshot. */
async function waitForEditor(page) {
    const deadline = Date.now() + EDITOR_DETECT_MS;
    let type = null;
    while (Date.now() < deadline && !type) {
        type = await editor.detectEditorType(page);
        if (!type) await page.waitForTimeout(500);
    }
    console.log(`[editor-detection] ${type || 'none'}`);
    if (!SUPPORTED_EDITORS.has(type)) {
        throw new Error(`Unsupported or unrecognized editor: ${type || 'none'}. Supported: ${[...SUPPORTED_EDITORS].join(', ')}.`);
    }
    return type;
}

async function draftSolution(page, { problemText, project, fileNames, screenshots, review }) {
    console.log('Asking the AI for a solution...');
    const solution = await gemini.generate(prompts.solvePrompt({ problemText, files: project }), screenshots);
    const draft = { ...project, ...keepKnownFiles(solution.files, fileNames) };

    if (review) {
        console.log('Reviewing the generated solution...');
        const reviewed = await gemini.generate(prompts.reviewPrompt({ problemText, files: draft }));
        Object.assign(draft, keepKnownFiles(reviewed.files, fileNames));
    }

    const written = await writeChangedFiles(page, project, draft);
    if (!written) console.log('Editor already holds the solution; checking it as is.');
}

/** Checks the solution and asks the AI for fixes until it passes or attempts run out. */
async function checkAndFix(page, { problemText, project, fileNames, verification }) {
    for (let attempt = 0; ; attempt += 1) {
        const result = await verification.check(page);
        console.log(`${verification.label} ${attempt + 1} verdict: ${result.verdict}`);
        if (result.verdict === 'pass') return { passed: true, result };

        console.log(String(result.output).split('\n').slice(0, 25).join('\n'));
        if (attempt >= config.maxFixAttempts) return { passed: false, result };

        console.log(`Asking the AI to fix it (attempt ${attempt + 1}/${config.maxFixAttempts})...`);
        const fix = await gemini.generate(
            prompts.fixPrompt({ problemText, files: project, runOutput: result.output, attempt: attempt + 1 }),
            [],
            { thinking: config.aiFixThinking }
        );

        const changed = await writeChangedFiles(page, project, keepKnownFiles(fix.files, fileNames));
        if (!changed) {
            const assumed = result.verdict === 'unknown' && fix.allPassed;
            console.log(assumed
                ? 'Output was ambiguous, but the AI judged every test passed.'
                : 'The AI proposed no changes; stopping the fix loop.');
            return { passed: assumed, assumed, result };
        }
    }
}

async function solveProblem(page) {
    const { problemText, samples, screenshots } = await readStatement(page);
    const editorType = await waitForEditor(page);
    const verification = runner.verificationFor(editorType, samples);

    const fileNames = await editor.listOpenFiles(page);
    if (!fileNames.length) throw new Error('No project files found in the editor.');
    const project = await editor.readFiles(page, fileNames);
    warnAboutEmptyFiles(project);
    console.log(`Read ${fileNames.length} file(s): ${fileNames.join(', ')}`);

    // Review only when nothing automated will check the solution.
    const review = config.review === 'always' ||
        (config.review === 'auto' && !samples.length && !verification.submits);
    await draftSolution(page, { problemText, project, fileNames, screenshots, review });

    const outcome = await checkAndFix(page, { problemText, project, fileNames, verification });

    if (verification.submits) {
        const status = outcome.passed && !outcome.assumed ? 'accepted'
            : outcome.result.verdict === 'fail' ? 'rejected'
                : 'submitted';
        return { status, detail: oneLine(outcome.result.output) };
    }

    if (!outcome.passed && !config.submitOnFailure) {
        console.error(`Tests did not pass; not submitting. Last output:\n${tail(outcome.result.output)}`);
        return { status: 'not-passed', detail: 'sample/run did not pass' };
    }

    const result = await runner.submit(page);
    console.log(`Submission verdict: ${result.verdict}\n${tail(result.output)}`);
    const status = { pass: 'accepted', fail: 'rejected' }[result.verdict] || 'submitted';
    return { status, detail: oneLine(result.output) };
}

/* ------------------------------------------------------------------ main loop */

// Stop only for AI-provider failures that moving to the next problem will not fix.
const isFatalAiError = (error) => /AI providers unavailable|quota|429|Too Many Requests/i.test(error.message);

async function openWithSession(page, context, url) {
    await openProblem(page, url);
    if (await isAccessDenied(page)) {
        console.warn('Session expired (403 page); logging in again...');
        await ensureLoggedIn(page, context);
        await page.goto(url);
        await openProblem(page, url);
    }
}

function printSummary(results) {
    if (!results.length) return;
    console.log('===== Summary');
    for (const result of results) {
        console.log(`${result.status.padEnd(12)} ${String(result.seconds).padStart(4)}s  ` +
            `${result.url.split('/').pop()}  ${result.detail || ''}`);
    }
}

async function main() {
    const { browser, context, page } = await launch();
    const results = [];

    try {
        await ensureLoggedIn(page, context);
        const visited = new Set();
        let url = progress.resolveStartUrl(config.startArg, config.problemUrl);

        for (let index = 1; url && index <= config.maxProblems; index += 1) {
            if (visited.has(url)) {
                console.log(`Already handled ${url}; stopping.`);
                break;
            }
            visited.add(url);
            console.log(`===== Problem ${index}/${config.maxProblems}: ${url}`);

            const started = Date.now();
            progress.save({ url, finished: false, envUrl: config.problemUrl });
            await openWithSession(page, context, url);

            let result;
            let fatal = false;
            try {
                result = await solveProblem(page);
            } catch (error) {
                await saveDebugArtifacts(page, 'problem-failure');
                console.error(error);
                result = { status: 'error', detail: error.message.split('\n')[0] };
                fatal = isFatalAiError(error);
            }
            results.push({ url, ...result, seconds: Math.round((Date.now() - started) / 1000) });

            if (fatal) {
                console.error('AI provider unavailable or out of quota; stopping.');
                break;
            }
            if (!config.autoNext) break;

            const current = url;
            url = await goToNextProblem(page);
            if (url) {
                progress.save({ url, finished: false, envUrl: config.problemUrl });
            } else {
                progress.save({ url: current, finished: true, envUrl: config.problemUrl });
                console.log('No next problem (end of module). Start another module with: npm start <problem-url>');
            }
        }
    } finally {
        await browser.close();
        printSummary(results);
        if (!results.length || results.some((result) => result.status !== 'accepted')) {
            process.exitCode = 1;
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});