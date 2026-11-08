// Prompts are kept short on purpose: every token here is sent on every AI call.

const SYSTEM_INSTRUCTION = `You solve CodeChef coding tasks. The problem statement is the specification.
Formulas are TeX between $ signs.
Single file "solution.<ext>": write one complete program in that language that reads stdin and prints
exactly the Output Format, handles all test cases, keeps any class name from the starter code, and is
fast enough for the constraints. Prefer the simplest correct approach using the standard library.
Return complete file contents in "files" (path = exact given name), only for files you change.
No comments in code. "notes": at most 15 words.`;

const MAX_RUN_OUTPUT_CHARS = 2000;

const filesBlock = (files) => JSON.stringify(files);
const clip = (text, max) => (text.length > max ? `...${text.slice(-max)}` : text);

function solvePrompt({ problemText, files }) {
    return `Files:\n${filesBlock(files)}\n\nProblem:\n${problemText}`;
}

// Only used when a problem has no sample tests to check against (see REVIEW in config.js).
function reviewPrompt({ problemText, files }) {
    return `Review and fix this solution before it is run. Check correctness, input/output format,
edge cases, and complexity against the constraints. Return only changed files.

Files:\n${filesBlock(files)}\n\nProblem:\n${problemText}`;
}

function fixPrompt({ problemText, files, runOutput, attempt }) {
    return `Fix attempt ${attempt}: the code below failed. Find the root cause and return corrected files.
Set "allPassed" true only if the output shows every test passed (then return no files).

Run result:\n${clip(runOutput, MAX_RUN_OUTPUT_CHARS)}

Files:\n${filesBlock(files)}\n\nProblem:\n${problemText}`;
}

module.exports = { SYSTEM_INSTRUCTION, solvePrompt, reviewPrompt, fixPrompt };
