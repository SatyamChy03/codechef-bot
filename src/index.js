const addTimestamps = () => {
    for (const level of ['log', 'warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => original(`[${new Date().toISOString()}]`, ...args);
    }
};

addTimestamps();

const config = require('./config');
const { launch, saveDebugArtifacts } = require('./browser');
const { ensureLoggedIn } = require('./auth');
const { openProblem, isAccessDenied, goToNextProblem, readProblemText, readSamples, captureScreenshots } = require('./problem');
const editor = require('./editor');
const gemini = require('./gemini');
const prompts = require('./prompts');
const { runProject, submit } = require('./runner');
const progress = require('./progress');

/** Maps Gemini's returned paths onto the open tab names; drops files that aren't open. */
function keepKnownFiles(files, fileNames) {
    const byBaseName = new Map(fileNames.map((name) => [editor.baseName(name), name]));
    const known = {};
    for (const [path, content] of Object.entries(files)) {
        const tabName = fileNames.includes(path) ? path : byBaseName.get(editor.baseName(path));
        if (tabName) {
            known[tabName] = content;
        } else {
            console.warn(`Ignoring ${path}: not an open file in the IDE.`);
        }
    }
    return known;
}

/** Writes only files whose contents differ from what's in the editor. Returns the count written. */
async function writeChangedFiles(page, project, changes) {
    let written = 0;
    for (const [fileName, source] of Object.entries(changes)) {
        if (editor.normalize(source) === editor.normalize(project[fileName] ?? '')) continue;
        await editor.writeFile(page, fileName, source);
        project[fileName] = editor.normalize(source);
        written += 1;
    }
    return written;
}

const tail = (text, lines = 30) => text.split('\n').slice(-lines).join('\n');

/**
 * Solves the problem currently open in `page`. Returns { status, detail } where status is
 * 'accepted' | 'submitted' (verdict not recognised) | 'rejected' | 'not-passed' (sample/run failed, not submitted).
 */
async function solveProblem(page) {
        // --- Capture the problem and the whole project ---
        const { text: problemText, imageCount } = await readProblemText(page);
        const samples = await readSamples(page);
        if (samples.length) console.log(`Found ${samples.length} sample test(s); runs will be checked against them.`);
        let screenshots = [];
        if (config.useScreenshots) {
            screenshots = await captureScreenshots(page);
        } else if (imageCount > 0) {
            console.warn(`The statement contains ${imageCount} image(s) that text copying can't capture. ` +
                'Set USE_SCREENSHOTS=true if Gemini needs to see them.');
        }
        const fileNames = await editor.listOpenFiles(page);
        if (!fileNames.length) throw new Error('No project files found in the IDE tabs.');
        const activeFile = await editor.activeFileName(page);
        const project = await editor.readFiles(page, fileNames);
        console.log(`Read ${fileNames.length} file(s): ${fileNames.join(', ')}`);

        // --- Generate, then review ---
        console.log('Asking Gemini for a solution...');
        const solution = await gemini.generate(
            prompts.solvePrompt({ problemText, files: project }),
            screenshots
        );
        const draft = { ...project, ...keepKnownFiles(solution.files, fileNames) };

        const shouldReview = config.review === 'always' || (config.review === 'auto' && !samples.length);
        if (shouldReview) {
            console.log('Reviewing the generated solution...');
            const review = await gemini.generate(prompts.reviewPrompt({ problemText, files: draft }));
            Object.assign(draft, keepKnownFiles(review.files, fileNames));
        } else {
            console.log('Skipping the review call; the sample run will check the solution.');
        }

        const written = await writeChangedFiles(page, project, draft);
        if (!written) throw new Error('Gemini did not change any files; refusing to continue.');

        // --- Run and fix until tests pass or attempts run out ---
        let passed = false;
        let lastOutput = '';
        for (let attempt = 0; ; attempt += 1) {
            const run = await runProject(page, samples);
            lastOutput = run.output;
            console.log(`Run ${attempt + 1} verdict: ${run.verdict}`);
            if (run.verdict === 'pass') {
                passed = true;
                break;
            }
            if (attempt >= config.maxFixAttempts) break;

            console.log(`Asking Gemini to fix the run output (attempt ${attempt + 1}/${config.maxFixAttempts})...`);
            const fix = await gemini.generate(prompts.fixPrompt({
                problemText,
                files: project,
                runOutput: run.output,
                attempt: attempt + 1,
            }), [], { thinking: config.aiFixThinking });
            const changed = await writeChangedFiles(page, project, keepKnownFiles(fix.files, fileNames));
            if (!changed) {
                if (run.verdict === 'unknown' && fix.allPassed) {
                    console.log('Run output was ambiguous, but Gemini judged all tests passed.');
                    passed = true;
                } else {
                    console.log('Gemini proposed no changes; stopping the fix loop.');
                }
                break;
            }
        }

        // --- Submit only after a passing run ---
        if (!passed && !config.submitOnFailure) {
            console.error('Tests did not pass; not submitting. Last run output:\n' + tail(lastOutput));
            console.error('Set SUBMIT_ON_FAILURE=true to submit anyway.');
            return { status: 'not-passed', detail: 'sample/run did not pass' };
        }

        const result = await submit(page);
        console.log(`Submission verdict: ${result.verdict}\n${tail(result.output)}`);
        const status = { pass: 'accepted', fail: 'rejected' }[result.verdict] || 'submitted';
        return { status, detail: tail(result.output, 3).replace(/\n/g, ' | ') };
}

// AI failures that will also hit every later problem, so the loop should stop.
const isFatalAiError = (error) => /AI providers unavailable|quota|429|Too Many Requests/i.test(error.message);

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
            await openProblem(page, url);
            if (await isAccessDenied(page)) {
                console.warn('Session expired (403 page); logging in again...');
                await ensureLoggedIn(page, context);
                await page.goto(url);
                await openProblem(page, url);
            }

            let result;
            try {
                result = await solveProblem(page);
            } catch (error) {
                await saveDebugArtifacts(page, 'problem-failure');
                console.error(error);
                result = { status: 'error', detail: error.message.split('\n')[0] };
                if (isFatalAiError(error)) {
                    results.push({ url, ...result, seconds: Math.round((Date.now() - started) / 1000) });
                    console.error('AI provider unavailable or out of quota; stopping the run.');
                    break;
                }
            }
            results.push({ url, ...result, seconds: Math.round((Date.now() - started) / 1000) });

            if (!config.autoNext) break;
            const current = url;
            url = await goToNextProblem(page);
            if (url) {
                progress.save({ url, finished: false, envUrl: config.problemUrl });
            } else {
                progress.save({ url: current, finished: true, envUrl: config.problemUrl });
                console.log('No next problem (end of the module); stopping. Start the next module with: npm start <problem-url>');
            }
        }
    } finally {
        await browser.close();
        if (results.length) {
            console.log('===== Summary');
            for (const r of results) {
                console.log(`${r.status.padEnd(10)} ${String(r.seconds).padStart(4)}s  ${r.url.split('/').pop()}  ${r.detail || ''}`);
            }
        }
        if (!results.length || results.some((r) => r.status !== 'accepted')) process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
