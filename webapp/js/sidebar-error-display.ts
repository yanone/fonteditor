// Sidebar Error Display
// Shows/hides error messages in the right sidebar when font compilation fails

import { Logger } from './logger';

const console = new Logger('SidebarErrorDisplay');

export class SidebarErrorDisplay {
    private rightSidebar: HTMLElement | null = null;
    private errorContainer: HTMLElement | null = null;
    private normalContent: HTMLElement[] = [];
    private initialized: boolean = false;

    constructor() {
        // Don't initialize here - wait until first use
    }

    private initialize() {
        if (this.initialized) {
            return;
        }

        // Get reference to right sidebar
        this.rightSidebar = document.getElementById('glyph-editor-sidebar');
        if (!this.rightSidebar) {
            console.warn('Right sidebar not found yet');
            return;
        }

        // Create error container (hidden by default)
        this.errorContainer = document.createElement('div');
        this.errorContainer.id = 'sidebar-error-display';
        this.errorContainer.style.display = 'none';
        // this.errorContainer.style.padding = '20px';
        this.errorContainer.style.textAlign = 'center';
        this.errorContainer.style.color = 'var(--text-primary)';
        this.rightSidebar.appendChild(this.errorContainer);

        this.initialized = true;
        console.log('[SidebarError] Initialized successfully');
    }

    /**
     * Show error message and hide normal sidebar content
     */
    showError(errorInput: unknown, source?: 'editing') {
        // Initialize on first use
        this.initialize();

        if (!this.rightSidebar || !this.errorContainer) {
            console.warn(
                '[SidebarError] Cannot show error - sidebar not available yet'
            );
            return;
        }

        const parsedError = this.parseErrorInput(errorInput);
        const featureErrorDetails =
            window.fontInfoManager?.getFeatureCompilationErrorDetails?.(
                errorInput
            ) || null;
        const title =
            source === 'editing'
                ? 'Editing Font Compilation Error'
                : 'Compilation Error';

        const renderedFeatureParsingMessage = featureErrorDetails
            ? `<div style="
                    font-size: 13px;
                    color: var(--text-primary);
                    line-height: 1.5;
                    text-align: center;
                    word-wrap: break-word;
                    overflow-wrap: break-word;
                    hyphens: auto;
                ">Feature code error in <strong>${this.escapeHtml(featureErrorDetails.label)}</strong>: ${this.escapeHtml(featureErrorDetails.message)}</div>`
            : '';

        const renderedMessages = featureErrorDetails
            ? renderedFeatureParsingMessage
            : parsedError.messages.length > 0
              ? parsedError.messages
                    .map(
                        (message) =>
                            `<div style="
                                    font-size: 12px;
                                    color: var(--text-secondary);
                                    line-height: 1.5;
                                    text-align: center;
                                    word-wrap: break-word;
                                    overflow-wrap: break-word;
                                    hyphens: auto;
                                ">${this.escapeHtml(message)}</div>`
                    )
                    .join('')
              : `<div style="
                        font-size: 12px;
                        color: var(--text-secondary);
                        line-height: 1.5;
                        text-align: center;
                    ">${this.escapeHtml(parsedError.fallback)}</div>`;

        const fallbackLocation = featureErrorDetails
            ? null
            : window.fontInfoManager?.getFeatureCompilationErrorLocation?.(
                  errorInput
              ) || null;

        const renderedLocation = fallbackLocation
            ? `<div style="
                    font-size: 12px;
                    color: var(--text-primary);
                    line-height: 1.5;
                    text-align: center;
                    background: var(--background-secondary);
                    border: 1px solid var(--border-primary);
                    border-radius: 6px;
                    padding: 8px 10px;
                ">Likely in ${this.escapeHtml(fallbackLocation.type)}: <strong>${this.escapeHtml(fallbackLocation.label)}</strong></div>`
            : '';

        const renderedOpenButton = featureErrorDetails
            ? `<button id="sidebar-open-feature-error-btn" style="
                    margin-top: 4px;
                    padding: 6px 10px;
                    border-radius: 6px;
                    border: 1px solid var(--border-primary);
                    background: var(--background-secondary);
                    color: var(--text-primary);
                    font-size: 12px;
                    cursor: pointer;
                ">Open in Features</button>`
            : '';

        window.fontInfoManager?.showFeatureCompilationError?.(errorInput);

        console.log('[SidebarError] Showing error in sidebar');

        // Store references to normal content
        this.normalContent = Array.from(
            this.rightSidebar.children
        ) as HTMLElement[];

        // Hide all normal content
        this.normalContent.forEach((child) => {
            if (child !== this.errorContainer) {
                child.style.display = 'none';
            }
        });

        // Create error display
        this.errorContainer.innerHTML = `
            <div style="
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 16px;
                margin-top: 60px;
            ">
                <div style="
                    width: 64px;
                    height: 64px;
                    border-radius: 50%;
                    background-color: var(--background-secondary);
                    border: 2px solid var(--border-primary);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 32px;
                ">⚠️</div>
                
                <div style="
                    font-weight: 600;
                    font-size: 14px;
                    color: var(--text-primary);
                    text-align: center;
                ">${title}</div>
                ${renderedLocation}
                ${renderedMessages}
                ${renderedOpenButton}
                
                <div style="
                    font-size: 12px;
                    color: var(--text-muted);
                    margin-top: 8px;
                    text-align: center;
                    line-height: 1.4;
                ">The font cannot be displayed until the compilation issue is resolved. Check the browser console for detailed error information.</div>
            </div>
        `;

        if (featureErrorDetails) {
            const openButton = this.errorContainer.querySelector(
                '#sidebar-open-feature-error-btn'
            ) as HTMLButtonElement | null;
            openButton?.addEventListener('click', () => {
                window.fontInfoManager?.openFeatureCompilationError?.(
                    errorInput
                );
            });
        }

        // Show error container
        this.errorContainer.style.display = 'block';
    }

    /**
     * Hide error message and restore normal sidebar content
     */
    hideError() {
        // Initialize if needed (in case hideError is called first)
        this.initialize();

        if (!this.rightSidebar || !this.errorContainer) {
            console.log(
                '[SidebarError] No error to hide (not initialized yet)'
            );
            return;
        }

        console.log('[SidebarError] Hiding error, restoring normal sidebar');

        window.fontInfoManager?.clearFeatureErrorHighlight?.();

        // Hide error container
        this.errorContainer.style.display = 'none';

        // Restore all normal content
        this.normalContent.forEach((child) => {
            if (child !== this.errorContainer) {
                child.style.display = '';
            }
        });

        this.normalContent = [];
    }

    /**
     * Parse error payload from string/Error/object into user-facing messages.
     */
    private parseErrorInput(errorInput: unknown): {
        messages: string[];
        fallback: string;
    } {
        const sources: unknown[] = [errorInput];

        if (errorInput instanceof Error) {
            sources.push(errorInput.message);
            const withPayload = errorInput as Error & {
                compilationErrorPayload?: unknown;
            };
            if (withPayload.compilationErrorPayload !== undefined) {
                sources.push(withPayload.compilationErrorPayload);
            }
        }

        for (const source of sources) {
            const messages = this.extractStructuredMessages(source);
            if (messages.length > 0) {
                return {
                    messages,
                    fallback: 'Compilation failed.'
                };
            }

            const rustStyleMessages = this.extractRustStyleMessages(source);
            if (rustStyleMessages.length > 0) {
                return {
                    messages: rustStyleMessages,
                    fallback: 'Compilation failed.'
                };
            }
        }

        const fallbackText =
            typeof errorInput === 'string'
                ? errorInput
                : errorInput instanceof Error
                  ? errorInput.message
                  : (() => {
                        try {
                            return JSON.stringify(errorInput);
                        } catch {
                            return String(errorInput);
                        }
                    })();

        return {
            messages: [],
            fallback: this.truncateForDisplay(
                fallbackText || 'Compilation failed.'
            )
        };
    }

    private extractStructuredMessages(source: unknown): string[] {
        const parsed = this.tryParseJsonLike(source);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return [];
        }

        const messages: string[] = [];
        const errorMap = parsed as Record<string, unknown>;

        Object.entries(errorMap).forEach(([category, issues]) => {
            if (!Array.isArray(issues)) {
                return;
            }

            issues.forEach((issue) => {
                if (!issue || typeof issue !== 'object') {
                    return;
                }

                const issueRecord = issue as Record<string, unknown>;
                const message =
                    typeof issueRecord.message === 'string'
                        ? issueRecord.message
                        : null;

                if (!message) {
                    return;
                }

                messages.push(
                    `${category}: ${this.truncateForDisplay(message)}`
                );
            });
        });

        return messages;
    }

    private extractRustStyleMessages(source: unknown): string[] {
        if (typeof source !== 'string') {
            return [];
        }

        if (!/featureparsing|featureerror/i.test(source)) {
            return [];
        }

        const messages: string[] = [];
        const messageMatch = source.match(/message:\s*"((?:[^"\\]|\\.)*)"/i);
        const spanMatch = source.match(/span:\s*(\d+)\.\.(\d+)/i);

        const parsedMessage = messageMatch?.[1]
            ? messageMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
            : 'Feature compilation error';

        const spanSuffix = spanMatch
            ? ` (span ${spanMatch[1]}..${spanMatch[2]})`
            : '';

        messages.push(
            `FeatureParsing: ${this.truncateForDisplay(parsedMessage + spanSuffix)}`
        );

        return messages;
    }

    private tryParseJsonLike(source: unknown): unknown {
        if (typeof source === 'string') {
            const trimmed = source.trim();
            if (
                !(
                    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
                    (trimmed.startsWith('[') && trimmed.endsWith(']'))
                )
            ) {
                return null;
            }
            try {
                return JSON.parse(trimmed);
            } catch {
                return null;
            }
        }

        if (source && typeof source === 'object') {
            return source;
        }

        return null;
    }

    private truncateForDisplay(text: string): string {
        if (text.length > 240) {
            return text.substring(0, 240) + '...';
        }
        return text;
    }

    /**
     * Escape HTML to prevent XSS
     */
    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Create global instance
export const sidebarErrorDisplay = new SidebarErrorDisplay();
