async function inspectEditorRuntime(page) {
    return page.evaluate(() => {
        const editors = [
            ...document.querySelectorAll('.monaco-editor')
        ];

        const tabs = [
            ...document.querySelectorAll(
                '.tabs-container [role="tab"]'
            )
        ];

        const globalNames = Object.keys(window).filter((key) =>
            /monaco|editor|workbench|vscode|code|ace/i.test(key)
        );

        return {
            url: location.href,

            editorCount: editors.length,

            editors: editors.map((editor) => ({
                className: editor.className,
                dataUri: editor.getAttribute('data-uri'),
                ariaLabel: editor.querySelector(
                    'textarea.inputarea'
                )?.getAttribute('aria-label'),

                visibleLines: editor.querySelectorAll(
                    '.view-line'
                ).length,

                renderedText: editor.querySelector(
                    '.view-lines'
                )?.innerText
            })),

            tabs: tabs.map((tab) => ({
                name: tab.getAttribute('data-resource-name'),
                selected: tab.getAttribute('aria-selected'),
                label: tab.getAttribute('aria-label')
            })),

            globals: globalNames,

            monacoAvailable: Boolean(window.monaco),

            monacoEditorAvailable: Boolean(
                window.monaco?.editor
            ),

            clipboardAvailable: Boolean(
                navigator.clipboard
            )
        };
    });
}