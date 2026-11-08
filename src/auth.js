const config = require('./config');

const LOGIN_URL = 'https://www.codechef.com/login';
const isLoginPath = (url) => new URL(url).pathname.startsWith('/login');

/**
 * Logs in only when needed. A valid saved session (auth.json) redirects away
 * from /login or hides the form; an expired one falls through to a fresh login.
 */
async function ensureLoggedIn(page, context) {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    const nameField = page.locator('#edit-name');
    const formVisible = await nameField
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true, () => false);

    if (!isLoginPath(page.url()) || !formVisible) {
        console.log('Reusing saved session.');
        return;
    }

    console.log('Logging in...');
    await nameField.fill(config.username);
    await page.fill('#edit-pass', config.password);
    await page.locator('form:has(#edit-pass) input[type="submit"]').click({ noWaitAfter: true });
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });

    await context.storageState({ path: config.authStatePath });
    console.log('Login successful; session saved for next run.');
}

module.exports = { ensureLoggedIn };
