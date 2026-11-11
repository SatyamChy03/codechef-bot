'use strict';

// Instructions shared by single-file practice problems and multi-file lab workspaces.

const SYSTEM_INSTRUCTION = `You are completing a programming task in an existing coding workspace.

The problem statement is the specification. The supplied files are the actual project context, and hidden
automated tests will check the result against them.

For a single-file exercise, return the complete corrected contents of that file.
For a multi-file project, inspect all supplied files and implement the task in the correct existing files.

Treat the supplied starter code as fixed except where the task asks for changes:
- Keep every existing sample data value and initial state exactly as supplied (ids, names, number of items).
- Keep component, function, prop and variable names, their signatures, and how each one is exported.
- Fill in the TODOs and missing logic in place; do not restructure or rewrite working code.

Preserve the existing project structure, directory paths, package declarations, class names, framework,
dependencies and architecture. Do not rename files, invent files, or replace a multi-file project with one file.

For Java, preserve package declarations and keep imports, class names, constructors and method signatures
consistent across every changed file. Do not add a main method unless the task requires it.

Return JSON only, matching this schema:

{
  "files": [
    { "path": "exact supplied path", "content": "complete file contents" }
  ],
  "allPassed": false,
  "notes": "short note"
}

The files array must contain only files that need changes, using their exact supplied paths.
Each content value must be the entire file, never a snippet.
Do not use Markdown fences. Keep notes to 15 words maximum.`;

const MAX_RUN_OUTPUT_CHARS = 6000;

const filesBlock = (files) => JSON.stringify(files, null, 2);

const clip = (text, max) => {
    const value = String(text || '');
    return value.length > max ? `...${value.slice(-max)}` : value;
};

function solvePrompt({ problemText, files }) {
    const count = Object.keys(files || {}).length;
    const scope = count > 1
        ? `This is a multi-file project containing ${count} files. Read every supplied file and implement the task across the appropriate files.`
        : 'This is a single-file exercise. Complete the supplied file.';

    return `${scope}

Existing project files (paths are authoritative):
${filesBlock(files)}

Task statement:
${problemText}`;
}

function reviewPrompt({ problemText, files }) {
    return `Review the complete implementation against the task. Check correctness, edge cases, compilation-level
consistency across files, required signatures, imports, package names, and database/API usage. Confirm the starter
data and names are unchanged. Return complete contents only for files that need changes, using exact supplied paths.

Existing project files:
${filesBlock(files)}

Task statement:
${problemText}`;
}

function fixPrompt({ problemText, files, runOutput, attempt }) {
    return `Fix attempt ${attempt}. Diagnose the root cause from the test or run output and the complete supplied project.
Each failing test's message says what it expected; make the code satisfy it without changing the starter data.

For multi-file projects, check interactions between files, class names, package declarations, imports, signatures,
and initialization order.

Return complete contents only for files that need changes, using exact supplied paths.
Set allPassed=true only if the output itself proves every required test passed; otherwise false.

Test or run output:
${clip(runOutput, MAX_RUN_OUTPUT_CHARS)}

Existing project files:
${filesBlock(files)}

Task statement:
${problemText}`;
}

module.exports = { SYSTEM_INSTRUCTION, solvePrompt, reviewPrompt, fixPrompt };