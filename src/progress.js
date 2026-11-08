const fs = require('fs');
const path = require('path');

// Remembers where the bot got to, so the next `npm start` resumes without editing .env.
const PROGRESS_PATH = path.join(__dirname, '..', 'progress.json');

function load() {
    try {
        return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function save(data) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2));
}

/** Replaces the problem code at the end of a course problem URL. */
function withProblemCode(baseUrl, code) {
    const match = /^(.*\/problems\/)[^/?#]+/.exec(baseUrl || '');
    if (!match) {
        throw new Error(`Can't turn "${code}" into a link without a previous problem URL. ` +
            'Pass the full link once: npm start <problem-url>');
    }
    return `${match[1]}${code}`;
}

/**
 * Picks the problem to start from, in priority order:
 *   1. `npm start <url>` or `npm start <PROBLEMCODE>` (code reuses the last course URL)
 *   2. PROBLEM_URL in .env, if it changed since the last run
 *   3. where the last run stopped (progress.json)
 *   4. PROBLEM_URL in .env
 */
function resolveStartUrl(arg, envUrl) {
    const saved = load();
    const input = (arg || '').trim();

    if (/^https?:\/\//i.test(input)) return input;
    if (input) return withProblemCode(saved.url || envUrl, input);

    if (envUrl && envUrl !== saved.envUrl) return envUrl;
    if (saved.url && !saved.finished) {
        console.log(`Resuming from where the last run stopped: ${saved.url}`);
        return saved.url;
    }
    if (saved.finished) {
        throw new Error(`The last run finished its module at ${saved.url}. ` +
            'Start the next module with: npm start <problem-url>');
    }
    if (envUrl) return envUrl;
    throw new Error('No problem to start from. Run: npm start <problem-url>');
}

module.exports = { load, save, resolveStartUrl };
