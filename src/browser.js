const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');

async function launch() {
    const browser = await chromium.launch({ headless: config.headless });
    const hasSavedSession = fs.existsSync(config.authStatePath);
    const context = await browser.newContext({
        storageState: hasSavedSession ? config.authStatePath : undefined,
        viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    return { browser, context, page };
}

async function saveDebugArtifacts(page, label = 'failure') {
    try {
        fs.mkdirSync(config.debugDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const base = path.join(config.debugDir, `${stamp}-${label}`);
        await page.screenshot({ path: `${base}.png`, fullPage: true });
        fs.writeFileSync(`${base}.html`, await page.content());
        console.error(`Saved debug artifacts: ${base}.png and ${base}.html`);
    } catch (error) {
        console.error(`Could not save debug artifacts: ${error.message}`);
    }
}

module.exports = { launch, saveDebugArtifacts };
