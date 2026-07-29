import { Logger } from './logger';

const console = new Logger('RenameGlyphsDialog');

function commonSubstring(names: string[]): string {
    if (names.length === 0) return '';
    const [first, ...rest] = names;
    let best = '';
    for (let start = 0; start < first.length; start++) {
        for (let end = first.length; end > start + best.length; end--) {
            const candidate = first.slice(start, end);
            if (rest.every((name) => name.includes(candidate)))
                return candidate;
        }
    }
    return best;
}

/** Append `text` with each occurrence of `term` wrapped in a colored mark span. */
function appendMarkedText(
    parent: HTMLElement,
    text: string,
    term: string,
    markClass: string
): void {
    if (!term) {
        parent.appendChild(document.createTextNode(text));
        return;
    }
    const parts = text.split(term);
    parts.forEach((part, index) => {
        if (part) parent.appendChild(document.createTextNode(part));
        if (index < parts.length - 1) {
            const mark = document.createElement('span');
            mark.className = markClass;
            mark.textContent = term;
            parent.appendChild(mark);
        }
    });
}

/**
 * Build the after-name display by mirroring search/replace, so only the
 * substituted segments are marked (not incidental occurrences of `replace`).
 */
function appendReplacedMarkedText(
    parent: HTMLElement,
    name: string,
    search: string,
    replace: string
): void {
    if (!search) {
        parent.appendChild(document.createTextNode(name));
        return;
    }
    const parts = name.split(search);
    parts.forEach((part, index) => {
        if (part) parent.appendChild(document.createTextNode(part));
        if (index < parts.length - 1) {
            if (replace) {
                const mark = document.createElement('span');
                mark.className = 'rename-glyphs-replace-mark';
                mark.textContent = replace;
                parent.appendChild(mark);
            }
        }
    });
}

export class RenameGlyphsDialog {
    private readonly modal = document.getElementById('rename-glyphs-modal');
    private readonly content = document.getElementById(
        'rename-glyphs-modal-content'
    );
    private searchInput: HTMLInputElement | null = null;
    private replaceInput: HTMLInputElement | null = null;
    private preview: HTMLTableSectionElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private selectedNames: string[] = [];

    constructor() {
        this.buildContent();
        this.registerEvents();
    }

    open(): void {
        const glyphOverview = window.glyphOverviewInstance;
        this.selectedNames = glyphOverview?.getSelectedGlyphNames?.() || [];
        if (!this.modal || this.selectedNames.length === 0) return;
        this.searchInput!.value = commonSubstring(this.selectedNames);
        this.replaceInput!.value = '';
        this.updatePreview();
        this.modal.style.display = 'flex';
        requestAnimationFrame(() => this.searchInput?.focus());
    }

    private close(): void {
        if (this.modal) this.modal.style.display = 'none';
    }

    private buildContent(): void {
        if (!this.content) return;
        const fields = document.createElement('div');
        fields.className = 'rename-glyphs-fields';
        const addField = (labelText: string): HTMLInputElement => {
            const label = document.createElement('label');
            label.textContent = labelText;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'rename-glyphs-input';
            label.appendChild(input);
            fields.appendChild(label);
            return input;
        };
        this.searchInput = addField('Search');
        this.replaceInput = addField('Replace');
        const previewWrap = document.createElement('div');
        previewWrap.className = 'rename-glyphs-preview-wrap';
        const table = document.createElement('table');
        table.className = 'rename-glyphs-preview';
        table.innerHTML =
            '<colgroup><col><col></colgroup><thead><tr><th>Before</th><th>After</th></tr></thead>';
        this.preview = document.createElement('tbody');
        table.appendChild(this.preview);
        previewWrap.appendChild(table);
        const actions = document.createElement('div');
        actions.className = 'find-glyph-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'ai-login-button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => this.close());
        this.confirmButton = document.createElement('button');
        this.confirmButton.type = 'button';
        this.confirmButton.className = 'ai-login-button';
        this.confirmButton.disabled = true;
        this.confirmButton.addEventListener('click', () => this.rename());
        actions.append(cancel, this.confirmButton);
        this.content.replaceChildren(fields, previewWrap, actions);
    }

    private registerEvents(): void {
        document
            .getElementById('rename-glyphs-modal-close-btn')
            ?.addEventListener('click', () => this.close());
        this.modal?.addEventListener('click', (event) => {
            if (event.target === this.modal) this.close();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.modal?.style.display === 'flex')
                this.close();
        });
        this.searchInput?.addEventListener('input', () => this.updatePreview());
        this.replaceInput?.addEventListener('input', () =>
            this.updatePreview()
        );
    }

    private getRenames(): Map<string, string> {
        const search = this.searchInput?.value || '';
        const replace = this.replaceInput?.value || '';
        return new Map(
            this.selectedNames
                .map(
                    (name) =>
                        [
                            name,
                            search ? name.split(search).join(replace) : name
                        ] as const
                )
                .filter(([before, after]) => before !== after)
        );
    }

    /** Preflight conflicts keyed by current glyph name. */
    private getPreflightErrors(
        renames: Map<string, string>
    ): Map<string, string> {
        const allNames = new Set(
            window.currentFontModel?.glyphs.map((glyph) => glyph.name) || []
        );
        const errors = new Map<string, string>();
        const targetSources = new Map<string, string[]>();
        if (!this.searchInput?.value) {
            for (const name of this.selectedNames) {
                errors.set(name, 'Enter text to search for.');
            }
        }
        for (const [oldName, newName] of renames) {
            if (!newName) {
                errors.set(oldName, 'Glyph names cannot be empty.');
            }
            const sources = targetSources.get(newName) || [];
            sources.push(oldName);
            targetSources.set(newName, sources);
            allNames.delete(oldName);
        }
        for (const [newName, sources] of targetSources) {
            if (sources.length > 1) {
                for (const source of sources) {
                    errors.set(source, `Duplicates ${newName}.`);
                }
            }
            if (allNames.has(newName)) {
                for (const source of sources) {
                    errors.set(source, 'already exists');
                }
            }
        }
        return errors;
    }

    private canConfirm(
        renames: Map<string, string>,
        errors: Map<string, string>
    ): boolean {
        return renames.size > 0 && errors.size === 0;
    }

    private updatePreview(): void {
        const renames = this.getRenames();
        const errors = this.getPreflightErrors(renames);
        const search = this.searchInput?.value || '';
        const replace = this.replaceInput?.value || '';
        this.preview?.replaceChildren(
            ...this.selectedNames.map((name) => {
                const row = document.createElement('tr');
                const before = document.createElement('td');
                appendMarkedText(
                    before,
                    name,
                    search,
                    'rename-glyphs-search-mark'
                );
                const after = document.createElement('td');
                const glyphName = document.createElement('span');
                glyphName.className = 'rename-glyphs-result';
                if (renames.has(name)) {
                    appendReplacedMarkedText(glyphName, name, search, replace);
                } else {
                    glyphName.textContent = name;
                }
                const error = errors.get(name);
                if (error) {
                    glyphName.classList.add('has-error');
                    const comment = document.createElement('small');
                    comment.className = 'rename-glyphs-comment';
                    comment.textContent = error;
                    after.append(glyphName, comment);
                } else {
                    after.appendChild(glyphName);
                }
                row.append(before, after);
                return row;
            })
        );
        if (this.confirmButton) {
            this.confirmButton.disabled = !this.canConfirm(renames, errors);
            this.confirmButton.textContent = `Rename ${renames.size} Glyph${renames.size === 1 ? '' : 's'}`;
        }
    }

    private rename(): void {
        const renames = this.getRenames();
        const errors = this.getPreflightErrors(renames);
        if (!this.canConfirm(renames, errors) || !window.currentFontModel)
            return;
        try {
            window.currentFontModel.renameGlyphs(renames);
            this.close();
        } catch (error) {
            console.error('Could not rename glyphs', error);
        }
    }
}

window.renameGlyphsDialog = new RenameGlyphsDialog();
