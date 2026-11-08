const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const OpenAI = require('openai');
const config = require('./config');
const { SYSTEM_INSTRUCTION } = require('./prompts');

// Gemini schemas can't express "object with arbitrary keys", so files are an array of {path, content}.
const RESPONSE_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        files: {
            type: SchemaType.ARRAY,
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    path: { type: SchemaType.STRING },
                    content: { type: SchemaType.STRING },
                },
                required: ['path', 'content'],
            },
        },
        allPassed: { type: SchemaType.BOOLEAN },
        notes: { type: SchemaType.STRING },
    },
    required: ['files'],
};

const makeModel = (name) => new GoogleGenerativeAI(config.geminiApiKey).getGenerativeModel({
    model: name,
    systemInstruction: SYSTEM_INSTRUCTION,
});

/** Full generationConfig for one request (the SDK replaces, not merges, per-request config). */
function generationConfig(thinking) {
    const generation = {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.2,
        maxOutputTokens: config.aiMaxOutputTokens,
    };
    if (thinking && thinking !== 'default') generation.thinkingConfig = { thinkingLevel: thinking };
    return generation;
}
const modelNames = config.geminiApiKey
    ? [...new Set([config.geminiModel, ...config.geminiFallbackModels])]
    : [];
const models = modelNames.map((name) => ({ name, model: makeModel(name) }));
const fallbackClient = config.nvidiaApiKey
    ? new OpenAI({ baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: config.nvidiaApiKey })
    : null;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastRequestAt = 0;
const requestTimes = [];

/** Enforces AI_MIN_INTERVAL_MS between requests and at most AI_RPM requests per rolling minute. */
async function waitForRateLimit() {
    for (;;) {
        const now = Date.now();
        while (requestTimes.length && now - requestTimes[0] >= 60000) requestTimes.shift();
        const gap = config.aiMinIntervalMs - (now - lastRequestAt);
        const windowWait = requestTimes.length >= config.aiRpm ? 60000 - (now - requestTimes[0]) : 0;
        const wait = Math.max(gap, windowWait);
        if (wait <= 0) break;
        if (windowWait > 0) console.log(`Rate limit: ${config.aiRpm} requests/min reached; waiting ${Math.ceil(wait / 1000)}s...`);
        await sleep(wait);
    }
    lastRequestAt = Date.now();
    requestTimes.push(lastRequestAt);
}

/** Seconds Google asks us to wait (RetryInfo on a 429), or null. */
function retryDelaySeconds(error) {
    const info = (error.errorDetails || []).find((d) => String(d['@type'] || '').endsWith('RetryInfo'));
    const match = info && /^(\d+(?:\.\d+)?)s$/.exec(String(info.retryDelay || ''));
    return match ? Number(match[1]) : null;
}

function logUsage(name, usage) {
    if (!usage) return;
    const thoughts = usage.thoughtsTokenCount || 0;
    console.log(`[tokens] ${name}: in=${usage.promptTokenCount || 0} out=${usage.candidatesTokenCount || 0}` +
        ` thinking=${thoughts} total=${usage.totalTokenCount || 0}`);
}

class InvalidResponseError extends Error {}

function isRetryable(error) {
    // A 429 can be a short burst limit or an exhausted daily quota, but retrying
    // blindly is harmful for the latter and the SDK does not expose a stable shape.
    if (error.status === 429 || error.statusText === 'Too Many Requests') {
        return false;
    }
    return RETRYABLE_STATUS.has(error.status)
        || /timed out|fetch failed|ECONNRESET|ETIMEDOUT|overloaded/i.test(error.message);
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Gemini timed out after ${ms / 1000}s.`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseResponse(text) {
    const cleaned = String(text)
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new InvalidResponseError('Model response did not contain JSON.');
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed.files)) {
        throw new InvalidResponseError('Gemini response has no "files" array.');
    }
    const files = {};
    for (const entry of parsed.files) {
        if (!entry || typeof entry.path !== 'string' || !entry.path.trim() || typeof entry.content !== 'string') {
            throw new InvalidResponseError(`Gemini returned an invalid file entry: ${JSON.stringify(entry).slice(0, 120)}`);
        }
        files[entry.path.trim()] = entry.content;
    }
    return { files, allPassed: parsed.allPassed === true, notes: parsed.notes || '' };
}

function toOpenAiParts(prompt, parts) {
    return [
        { type: 'text', text: prompt },
        ...parts.map((part) => ({
            type: 'image_url',
            image_url: {
                url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
            },
        })),
    ];
}

async function generateWithFallback(prompt, parts) {
    if (!fallbackClient) {
        throw new Error('AI providers unavailable: Gemini failed and NVIDIA_API_KEY is not configured.');
    }
    await waitForRateLimit();
    const result = await withTimeout(
        fallbackClient.chat.completions.create({
            model: config.nvidiaModel,
            messages: [
                { role: 'system', content: SYSTEM_INSTRUCTION },
                { role: 'user', content: toOpenAiParts(prompt, parts) },
            ],
            temperature: 0.2,
            max_tokens: config.aiMaxOutputTokens,
        }),
        config.geminiTimeoutMs
    );
    const content = result.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((item) => item.text || '').join('') : content;
    if (!text) throw new InvalidResponseError('NVIDIA returned an empty response.');
    return parseResponse(text);
}

const isQuotaError = (error) => error.status === 429 || error.statusText === 'Too Many Requests';

/**
 * Sends a prompt (plus optional image parts) and returns { files, allPassed, notes }.
 * Tries each Gemini model in order: temporary errors are retried with growing waits,
 * quota errors move straight to the next model, then NVIDIA is the last resort.
 */
async function generate(prompt, parts = [], { thinking = config.aiThinking } = {}) {
    if (!models.length) {
        console.warn('Gemini is not configured; using NVIDIA fallback.');
        return generateWithFallback(prompt, parts);
    }
    let lastError;
    for (const { name, model } of models) {
        for (let attempt = 0; ; attempt += 1) {
            try {
                await waitForRateLimit();
                const result = await withTimeout(
                    model.generateContent({
                        contents: [{ role: 'user', parts: [{ text: prompt }, ...parts] }],
                        generationConfig: generationConfig(thinking),
                    }),
                    config.geminiTimeoutMs
                );
                logUsage(`${name}/${thinking}`, result.response.usageMetadata);
                const response = parseResponse(result.response.text());
                if (response.notes) console.log(`Gemini (${name}): ${response.notes}`);
                return response;
            } catch (error) {
                lastError = error;
                const short = error.message.split('\n')[0].slice(0, 160);
                // A per-minute 429 says how long to wait; a daily-quota 429 asks for hours, so move on.
                const askedDelay = isQuotaError(error) ? retryDelaySeconds(error) : null;
                if (askedDelay != null && askedDelay <= 90 && attempt < config.geminiRetries) {
                    console.warn(`${name} rate-limited; waiting ${Math.ceil(askedDelay)}s as requested...`);
                    await sleep(Math.ceil(askedDelay) * 1000);
                    continue;
                }
                if (!isQuotaError(error) && isRetryable(error) && attempt < config.geminiRetries) {
                    const delay = 5000 * 2 ** attempt;
                    console.warn(`${name} failed (${short}); retry ${attempt + 1}/${config.geminiRetries} in ${delay / 1000}s...`);
                    await sleep(delay);
                    continue;
                }
                console.warn(`${name} unavailable (${short}); trying the next model.`);
                break;
            }
        }
    }
    if (!fallbackClient) {
        const quota = isQuotaError(lastError) ? ' (quota exhausted)' : '';
        throw new Error(`AI providers unavailable: all Gemini models failed${quota} and NVIDIA_API_KEY is not configured. ` +
            `Last error: ${lastError.message.split('\n')[0].slice(0, 200)}`);
    }
    return generateWithFallback(prompt, parts);
}

module.exports = { generate };
