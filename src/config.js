const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing ${name}. Add it to .env (see .env.example).`);
    }
    return value;
}

function intEnv(name, fallback) {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer (got "${raw}").`);
    }
    return value;
}

module.exports = {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    // Thinking models can take well over a minute on hard problems.
    geminiTimeoutMs: intEnv('GEMINI_TIMEOUT_MS', 180000),
    // Retries per model for temporary errors (503 "high demand", timeouts); waits 5s, 10s, 20s...
    geminiRetries: intEnv('GEMINI_RETRIES', 2),
    // Tried in order after GEMINI_MODEL fails (also on 429, since free quotas are per model).
    geminiFallbackModels: (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.6-flash,gemini-3-flash-preview')
        .split(',').map((name) => name.trim()).filter(Boolean),
    aiMinIntervalMs: intEnv('AI_MIN_INTERVAL_MS', 2000),
    // Max AI requests in any 60s window (free tiers allow only a few per minute).
    aiRpm: Math.max(1, intEnv('AI_RPM', 5)),
    // Gemini thinking level (low|medium|high, or "default" to let the model decide). Thinking tokens
    // are billed as output; first attempts use AI_THINKING, fix attempts AI_FIX_THINKING.
    aiThinking: process.env.AI_THINKING || 'low',
    aiFixThinking: process.env.AI_FIX_THINKING || 'high',
    aiMaxOutputTokens: intEnv('AI_MAX_OUTPUT_TOKENS', 16384),
    nvidiaApiKey: process.env.NVIDIA_API_KEY || '',
    nvidiaModel: process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v4.1-flash',

    username: requireEnv('CODECHEF_USERNAME'),
    password: requireEnv('CODECHEF_PASSWORD'),
    // Optional: `npm start <url|CODE>` or progress.json usually decide the start problem (see progress.js).
    problemUrl: (process.env.PROBLEM_URL || '').trim(),
    startArg: process.argv[2] || '',

    headless: process.env.HEADLESS === 'true',
    // Practice (Ace editor) pages only: switch the language dropdown to this option, e.g. "C++" or "Python3".
    language: (process.env.LANGUAGE || '').trim(),
    useScreenshots: process.env.USE_SCREENSHOTS === 'true',
    maxFixAttempts: intEnv('MAX_FIX_ATTEMPTS', 3),
    // After each problem, follow "Next" and solve the next one, up to MAX_PROBLEMS per run.
    autoNext: process.env.AUTO_NEXT !== 'false',
    maxProblems: Math.max(1, intEnv('MAX_PROBLEMS', 10)),
    // Second "reviewer" AI call before the first run. auto = only when the problem has no sample
    // tests to check against; otherwise the sample run checks the solution.
    review: ['auto', 'always', 'never'].includes(process.env.REVIEW) ? process.env.REVIEW : 'auto',
    runTimeoutMs: intEnv('RUN_TIMEOUT_MS', 120000),
    submitOnFailure: process.env.SUBMIT_ON_FAILURE === 'true',

    authStatePath: path.join(ROOT, 'auth.json'),
    debugDir: path.join(ROOT, 'debug'),
};
