// Share Button
// Handles share menu plus cloud invitation and membership management

import tippy, { Instance as TippyInstance } from 'tippy.js';
import 'tippy.js/dist/tippy.css';
import type {
    CloudAssetInvitation,
    CloudAssetMember,
    CloudOwnershipTransfer,
    CloudPlugin,
    CloudShareState
} from './cloud-plugin';
import {
    getOrCreateBackdrop,
    addTippyBackdropSupport,
    getTheme,
    setupMenuKeyboardNav
} from './tippy-utils';
import { Logger } from './logger';

const console = new Logger('ShareButton');

let shareMenuInstance: TippyInstance | null = null;
let shareDialogOverlay: HTMLDivElement | null = null;
let shareDialogDocumentListenerAttached = false;

type ShareRole = 'editor' | 'viewer';

type ShareDialogState = {
    isOpen: boolean;
    isLoading: boolean;
    isSubmitting: boolean;
    error: string | null;
    notice: string | null;
    shareState: CloudShareState | null;
    inviteEmail: string;
    inviteRole: ShareRole;
    transferEmail: string;
    previousOwnerRole: ShareRole;
    latestInviteUrl: string | null;
    latestTransferUrl: string | null;
};

let shareDialogState: ShareDialogState = {
    isOpen: false,
    isLoading: false,
    isSubmitting: false,
    error: null,
    notice: null,
    shareState: null,
    inviteEmail: '',
    inviteRole: 'editor',
    transferEmail: '',
    previousOwnerRole: 'editor',
    latestInviteUrl: null,
    latestTransferUrl: null
};

function getCloudPlugin(): CloudPlugin | null {
    return window.cloudPlugin || null;
}

function isCloudShareAvailable(): boolean {
    return !!getCloudPlugin()?.getCurrentAssetIdForSharing();
}

function escapeHtml(value: string | null | undefined): string {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTimestamp(timestamp: number | null | undefined): string {
    if (!timestamp) {
        return 'Unknown time';
    }
    return new Date(timestamp).toLocaleString();
}

function formatRole(role: string | null | undefined): string {
    if (!role) {
        return 'Unknown';
    }
    return role.charAt(0).toUpperCase() + role.slice(1);
}

function renderMemberRow(
    member: CloudAssetMember,
    canManage: boolean,
    ownerUserId: string
): string {
    const isOwner = member.userId === ownerUserId || member.role === 'owner';
    const controls =
        canManage && !isOwner
            ? `
            <form class="share-dialog-role-form" data-user-id="${escapeHtml(member.userId)}">
                <select class="share-dialog-select" name="role">
                    <option value="editor" ${member.role === 'editor' ? 'selected' : ''}>Editor</option>
                    <option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Viewer</option>
                </select>
                <button type="submit" class="share-dialog-secondary-button">Update</button>
                <button type="button" class="share-dialog-danger-button" data-share-dialog-action="remove-member" data-user-id="${escapeHtml(member.userId)}">Remove</button>
            </form>
        `
            : `<div class="share-dialog-pill">${formatRole(member.role)}</div>`;

    return `
        <li class="share-dialog-list-item">
            <div class="share-dialog-list-copy">
                <div class="share-dialog-list-title">${escapeHtml(member.email)}</div>
                <div class="share-dialog-list-meta">
                    ${isOwner ? 'Owner' : formatRole(member.role)}
                    ${member.invitedByEmail ? ` · Invited by ${escapeHtml(member.invitedByEmail)}` : ''}
                    · Added ${escapeHtml(formatTimestamp(member.createdAt))}
                </div>
            </div>
            <div class="share-dialog-list-actions">${controls}</div>
        </li>
    `;
}

function renderInvitationRow(
    invitation: CloudAssetInvitation,
    canManage: boolean
): string {
    return `
        <li class="share-dialog-list-item">
            <div class="share-dialog-list-copy">
                <div class="share-dialog-list-title">${escapeHtml(invitation.email)}</div>
                <div class="share-dialog-list-meta">
                    ${formatRole(invitation.role)}
                    ${invitation.targetUserEmail ? ` · Matches ${escapeHtml(invitation.targetUserEmail)}` : ''}
                    · Sent ${escapeHtml(formatTimestamp(invitation.lastSentAt || invitation.createdAt))}
                </div>
            </div>
            <div class="share-dialog-list-actions">
                <div class="share-dialog-pill">Pending</div>
                ${canManage ? `<button type="button" class="share-dialog-danger-button" data-share-dialog-action="revoke-invite" data-invitation-id="${escapeHtml(invitation.id)}">Revoke</button>` : ''}
            </div>
        </li>
    `;
}

function renderOwnershipTransferCard(
    ownershipTransfer: CloudOwnershipTransfer
): string {
    return `
        <div class="share-dialog-banner share-dialog-banner-info">
            <div class="share-dialog-banner-copy">
                <strong>Pending transfer to ${escapeHtml(ownershipTransfer.email)}</strong>
                <div class="share-dialog-banner-detail">
                    You will keep ${escapeHtml(formatRole(ownershipTransfer.previousOwnerRole))} access
                    ${ownershipTransfer.targetUserEmail ? ` · Matches ${escapeHtml(ownershipTransfer.targetUserEmail)}` : ''}
                    · Requested ${escapeHtml(formatTimestamp(ownershipTransfer.createdAt))}
                    ${ownershipTransfer.expiresAt ? ` · Expires ${escapeHtml(formatTimestamp(ownershipTransfer.expiresAt))}` : ''}
                </div>
            </div>
            <button type="button" class="share-dialog-danger-button" data-share-dialog-action="cancel-transfer">Cancel</button>
        </div>
    `;
}

function renderShareDialog(): void {
    if (!shareDialogOverlay) {
        return;
    }

    const shareState = shareDialogState.shareState;
    const canManage = shareState?.permissions?.canManage === true;
    const ownerUserId = shareState?.asset?.ownerUserId || '';
    const ownerEmail = shareState?.asset?.ownerEmail || null;
    const ownershipTransfer = shareState?.ownershipTransfer || null;
    const title = shareState?.asset?.name || 'Share Font';
    const showDevelopmentLinks = window.isDevelopment?.() ?? false;

    shareDialogOverlay.innerHTML = `
        <div class="share-dialog-backdrop" data-share-dialog-action="close"></div>
        <div class="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
            <div class="share-dialog-header">
                <div>
                    <div class="share-dialog-eyebrow">Cloud access</div>
                    <h2 id="share-dialog-title">${escapeHtml(title)}</h2>
                    <div class="share-dialog-subtitle">
                        ${shareState ? `${formatRole(shareState.asset.role)} access${ownerEmail ? ` · Owner ${escapeHtml(ownerEmail)}` : ''}` : 'Load sharing settings'}
                    </div>
                </div>
                <button type="button" class="share-dialog-icon-button" data-share-dialog-action="close" aria-label="Close share dialog">
                    <span class="material-symbols-outlined">close</span>
                </button>
            </div>

            <div class="share-dialog-body">
                ${shareDialogState.error ? `<div class="share-dialog-banner share-dialog-banner-error">${escapeHtml(shareDialogState.error)}</div>` : ''}
                ${shareDialogState.notice ? `<div class="share-dialog-banner share-dialog-banner-success">${escapeHtml(shareDialogState.notice)}</div>` : ''}
                ${
                    showDevelopmentLinks && shareDialogState.latestInviteUrl
                        ? `
                    <div class="share-dialog-banner share-dialog-banner-info">
                        <div class="share-dialog-banner-copy">
                            <strong>Latest invite link</strong>
                            <div class="share-dialog-banner-detail">Use this to test acceptance locally if email delivery is stubbed.</div>
                            <input class="share-dialog-input share-dialog-link-input" type="text" readonly value="${escapeHtml(shareDialogState.latestInviteUrl)}" />
                        </div>
                        <button type="button" class="share-dialog-secondary-button" data-share-dialog-action="copy-latest-link">Copy link</button>
                    </div>
                `
                        : ''
                }
                ${
                    showDevelopmentLinks && shareDialogState.latestTransferUrl
                        ? `
                    <div class="share-dialog-banner share-dialog-banner-info">
                        <div class="share-dialog-banner-copy">
                            <strong>Latest transfer link</strong>
                            <div class="share-dialog-banner-detail">Use this to review the ownership transfer locally if email delivery is stubbed.</div>
                            <input class="share-dialog-input share-dialog-link-input" type="text" readonly value="${escapeHtml(shareDialogState.latestTransferUrl)}" />
                        </div>
                        <button type="button" class="share-dialog-secondary-button" data-share-dialog-action="copy-latest-transfer-link">Copy link</button>
                    </div>
                `
                        : ''
                }
                ${
                    shareDialogState.isLoading
                        ? `
                    <div class="share-dialog-loading">
                        <span class="material-symbols-outlined">sync</span>
                        <span>Loading sharing settings…</span>
                    </div>
                `
                        : ''
                }
                ${
                    shareState
                        ? `
                    ${
                        canManage
                            ? `
                        <section class="share-dialog-section">
                            <div class="share-dialog-section-header">
                                <h3>Invite people</h3>
                                <p>Invite by email and choose whether they can edit or only view.</p>
                            </div>
                            <form class="share-dialog-invite-form">
                                <input class="share-dialog-input" type="email" name="email" placeholder="name@example.com" value="${escapeHtml(shareDialogState.inviteEmail)}" ${shareDialogState.isSubmitting ? 'disabled' : ''} required />
                                <select class="share-dialog-select" name="role" ${shareDialogState.isSubmitting ? 'disabled' : ''}>
                                    <option value="editor" ${shareDialogState.inviteRole === 'editor' ? 'selected' : ''}>Editor</option>
                                    <option value="viewer" ${shareDialogState.inviteRole === 'viewer' ? 'selected' : ''}>Viewer</option>
                                </select>
                                <button type="submit" class="share-dialog-primary-button" ${shareDialogState.isSubmitting ? 'disabled' : ''}>${shareDialogState.isSubmitting ? 'Sending…' : 'Send invite'}</button>
                            </form>
                        </section>

                        <section class="share-dialog-section">
                            <div class="share-dialog-section-header">
                                <h3>Transfer ownership</h3>
                                <p>Send a transfer request to another email. If they accept, you keep the selected fallback role.</p>
                            </div>
                            ${ownershipTransfer ? renderOwnershipTransferCard(ownershipTransfer) : '<div class="share-dialog-banner share-dialog-banner-info"><div class="share-dialog-banner-copy"><strong>No pending transfer</strong><div class="share-dialog-banner-detail">Ownership stays unchanged until someone accepts a transfer request.</div></div></div>'}
                            <form class="share-dialog-transfer-form">
                                <input class="share-dialog-input" type="email" name="email" placeholder="new-owner@example.com" value="${escapeHtml(shareDialogState.transferEmail)}" ${shareDialogState.isSubmitting ? 'disabled' : ''} required />
                                <select class="share-dialog-select" name="previousOwnerRole" ${shareDialogState.isSubmitting ? 'disabled' : ''}>
                                    <option value="editor" ${shareDialogState.previousOwnerRole === 'editor' ? 'selected' : ''}>Keep me as editor</option>
                                    <option value="viewer" ${shareDialogState.previousOwnerRole === 'viewer' ? 'selected' : ''}>Keep me as viewer</option>
                                </select>
                                <button type="submit" class="share-dialog-primary-button" ${shareDialogState.isSubmitting ? 'disabled' : ''}>${shareDialogState.isSubmitting ? 'Sending…' : ownershipTransfer ? 'Replace transfer' : 'Request transfer'}</button>
                            </form>
                        </section>
                    `
                            : `
                        <section class="share-dialog-section">
                            <div class="share-dialog-section-header">
                                <h3>Your access</h3>
                                <p>You can view the current membership list, but only the owner can change access.</p>
                            </div>
                        </section>
                    `
                    }

                    <section class="share-dialog-section">
                        <div class="share-dialog-section-header">
                            <h3>People with access</h3>
                            <p>${shareState.members.length} member${shareState.members.length === 1 ? '' : 's'}</p>
                        </div>
                        <ul class="share-dialog-list">
                            ${shareState.members.length ? shareState.members.map((member) => renderMemberRow(member, canManage, ownerUserId)).join('') : '<li class="share-dialog-empty">No members found.</li>'}
                        </ul>
                    </section>

                    <section class="share-dialog-section">
                        <div class="share-dialog-section-header">
                            <h3>Pending invites</h3>
                            <p>${shareState.invitations.length} pending</p>
                        </div>
                        <ul class="share-dialog-list">
                            ${shareState.invitations.length ? shareState.invitations.map((invitation) => renderInvitationRow(invitation, canManage)).join('') : '<li class="share-dialog-empty">No pending invites.</li>'}
                        </ul>
                    </section>
                `
                        : ''
                }
            </div>

            <div class="share-dialog-footer">
                <button type="button" class="share-dialog-secondary-button" data-share-dialog-action="refresh" ${shareDialogState.isLoading || shareDialogState.isSubmitting ? 'disabled' : ''}>Refresh</button>
                <button type="button" class="share-dialog-primary-button" data-share-dialog-action="close">Close</button>
            </div>
        </div>
    `;

    const inviteForm = shareDialogOverlay.querySelector(
        '.share-dialog-invite-form'
    ) as HTMLFormElement | null;
    if (inviteForm) {
        inviteForm.addEventListener('submit', (event) => {
            event.preventDefault();
            void handleInviteSubmit(inviteForm);
        });
    }

    const transferForm = shareDialogOverlay.querySelector(
        '.share-dialog-transfer-form'
    ) as HTMLFormElement | null;
    if (transferForm) {
        transferForm.addEventListener('submit', (event) => {
            event.preventDefault();
            void handleTransferSubmit(transferForm);
        });
    }

    shareDialogOverlay
        .querySelectorAll('.share-dialog-role-form')
        .forEach((formElement) => {
            formElement.addEventListener('submit', (event) => {
                event.preventDefault();
                void handleMemberRoleSubmit(formElement as HTMLFormElement);
            });
        });

    shareDialogOverlay
        .querySelectorAll('[data-share-dialog-action]')
        .forEach((element) => {
            element.addEventListener('click', async (event) => {
                const target = event.currentTarget as HTMLElement;
                const action = target.dataset.shareDialogAction;
                switch (action) {
                    case 'close':
                        closeShareDialog();
                        break;
                    case 'refresh':
                        await refreshShareDialogState();
                        break;
                    case 'copy-latest-link':
                        if (shareDialogState.latestInviteUrl) {
                            const success = await copyToClipboard(
                                shareDialogState.latestInviteUrl
                            );
                            shareDialogState.notice = success
                                ? 'Invite link copied to clipboard.'
                                : 'Failed to copy invite link.';
                            shareDialogState.error = success
                                ? null
                                : 'Clipboard access failed.';
                            renderShareDialog();
                        }
                        break;
                    case 'copy-latest-transfer-link':
                        if (shareDialogState.latestTransferUrl) {
                            const success = await copyToClipboard(
                                shareDialogState.latestTransferUrl
                            );
                            shareDialogState.notice = success
                                ? 'Transfer link copied to clipboard.'
                                : 'Failed to copy transfer link.';
                            shareDialogState.error = success
                                ? null
                                : 'Clipboard access failed.';
                            renderShareDialog();
                        }
                        break;
                    case 'revoke-invite':
                        await handleRevokeInvitation(
                            target.dataset.invitationId || ''
                        );
                        break;
                    case 'cancel-transfer':
                        await handleCancelOwnershipTransfer();
                        break;
                    case 'remove-member':
                        await handleRemoveMember(target.dataset.userId || '');
                        break;
                }
            });
        });
}

function ensureShareDialog(): HTMLDivElement {
    if (shareDialogOverlay) {
        return shareDialogOverlay;
    }

    shareDialogOverlay = document.createElement('div');
    shareDialogOverlay.className = 'share-dialog-overlay';
    document.body.appendChild(shareDialogOverlay);

    if (!shareDialogDocumentListenerAttached) {
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && shareDialogState.isOpen) {
                closeShareDialog();
            }
        });
        shareDialogDocumentListenerAttached = true;
    }

    return shareDialogOverlay;
}

function openShareDialog(): void {
    if (!isCloudShareAvailable()) {
        alert('Open a cloud font to manage invites and members.');
        return;
    }

    ensureShareDialog();
    shareDialogState = {
        isOpen: true,
        isLoading: true,
        isSubmitting: false,
        error: null,
        notice: null,
        shareState: null,
        inviteEmail: '',
        inviteRole: 'editor',
        transferEmail: '',
        previousOwnerRole: 'editor',
        latestInviteUrl: null,
        latestTransferUrl: null
    };
    shareDialogOverlay?.classList.add('visible');
    document.body.classList.add('share-dialog-open');
    renderShareDialog();
    void refreshShareDialogState();
}

function closeShareDialog(): void {
    shareDialogState.isOpen = false;
    shareDialogOverlay?.classList.remove('visible');
    document.body.classList.remove('share-dialog-open');
}

async function refreshShareDialogState(options?: {
    preserveInviteUrl?: boolean;
    preserveTransferUrl?: boolean;
    notice?: string | null;
}): Promise<void> {
    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        shareDialogState.isLoading = false;
        shareDialogState.error = 'Cloud sharing is unavailable in this window.';
        renderShareDialog();
        return;
    }

    shareDialogState.isLoading = true;
    shareDialogState.error = null;
    if (options?.notice !== undefined) {
        shareDialogState.notice = options.notice;
    }
    renderShareDialog();

    try {
        const shareState = await cloudPlugin.getShareState();
        shareDialogState.shareState = shareState;
        shareDialogState.isLoading = false;
        shareDialogState.error = null;
        if (!options?.preserveInviteUrl) {
            shareDialogState.latestInviteUrl = null;
        }
        if (!options?.preserveTransferUrl) {
            shareDialogState.latestTransferUrl = null;
        }
    } catch (error) {
        shareDialogState.isLoading = false;
        shareDialogState.error = (error as Error).message;
    }

    renderShareDialog();
}

async function handleInviteSubmit(form: HTMLFormElement): Promise<void> {
    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    const formData = new FormData(form);
    const email = String(formData.get('email') || '').trim();
    const role = String(formData.get('role') || 'editor') as ShareRole;
    if (!email) {
        shareDialogState.error = 'Enter an email address to send an invite.';
        renderShareDialog();
        return;
    }

    shareDialogState.inviteEmail = email;
    shareDialogState.inviteRole = role;
    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    shareDialogState.notice = null;
    renderShareDialog();

    try {
        const result = await cloudPlugin.inviteUser(email, role);
        shareDialogState.inviteEmail = '';
        shareDialogState.inviteRole = 'editor';
        shareDialogState.latestInviteUrl = result.inviteUrl || null;
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            notice: `Invitation sent to ${email}.`
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

async function handleTransferSubmit(form: HTMLFormElement): Promise<void> {
    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    const formData = new FormData(form);
    const email = String(formData.get('email') || '').trim();
    const previousOwnerRole = String(
        formData.get('previousOwnerRole') || 'editor'
    ) as ShareRole;
    if (!email) {
        shareDialogState.error =
            'Enter an email address to request an ownership transfer.';
        renderShareDialog();
        return;
    }

    if (
        shareDialogState.shareState?.ownershipTransfer &&
        !confirm(
            'A pending ownership transfer already exists. Creating a new transfer will cancel it. Continue?'
        )
    ) {
        return;
    }

    shareDialogState.transferEmail = email;
    shareDialogState.previousOwnerRole = previousOwnerRole;
    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    shareDialogState.notice = null;
    renderShareDialog();

    try {
        const result = await cloudPlugin.createOwnershipTransfer(
            email,
            previousOwnerRole
        );
        shareDialogState.transferEmail = '';
        shareDialogState.previousOwnerRole = 'editor';
        shareDialogState.latestTransferUrl = result.transferUrl || null;
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            preserveTransferUrl: true,
            notice: `Ownership transfer requested for ${email}.`
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

async function handleCancelOwnershipTransfer(): Promise<void> {
    if (!confirm('Cancel the pending ownership transfer?')) {
        return;
    }

    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    renderShareDialog();
    try {
        await cloudPlugin.cancelOwnershipTransfer();
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            notice: 'Ownership transfer canceled.'
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

async function handleRevokeInvitation(invitationId: string): Promise<void> {
    if (!invitationId) {
        return;
    }
    if (!confirm('Revoke this pending invitation?')) {
        return;
    }

    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    renderShareDialog();
    try {
        await cloudPlugin.revokeInvitation(invitationId);
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            notice: 'Invitation revoked.'
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

async function handleMemberRoleSubmit(form: HTMLFormElement): Promise<void> {
    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    const userId = form.dataset.userId || '';
    const roleSelect = form.querySelector('select[name="role"]');
    const role = (
        roleSelect instanceof HTMLSelectElement ? roleSelect.value : 'viewer'
    ) as ShareRole;

    if (!userId) {
        return;
    }

    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    renderShareDialog();
    try {
        await cloudPlugin.updateMemberRole(userId, role);
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            notice: 'Member role updated.'
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

async function handleRemoveMember(userId: string): Promise<void> {
    if (!userId) {
        return;
    }
    if (!confirm('Remove this member from the shared font?')) {
        return;
    }

    const cloudPlugin = getCloudPlugin();
    if (!cloudPlugin) {
        return;
    }

    shareDialogState.isSubmitting = true;
    shareDialogState.error = null;
    renderShareDialog();
    try {
        await cloudPlugin.removeMember(userId);
        shareDialogState.isSubmitting = false;
        await refreshShareDialogState({
            preserveInviteUrl: true,
            notice: 'Member removed.'
        });
    } catch (error) {
        shareDialogState.isSubmitting = false;
        shareDialogState.error = (error as Error).message;
        renderShareDialog();
    }
}

/**
 * Get the current URL for sharing
 */
function getCurrentUrl(): string {
    return window.location.href;
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        console.error('[ShareButton]', 'Failed to copy to clipboard:', err);
        return false;
    }
}

/**
 * Create HTML for share menu
 */
function createShareMenuHtml(): string {
    return `
        <div class="plugin-menu">
            <div class="plugin-menu-item" data-action="copy-url">
                <span class="material-symbols-outlined">link</span>
                <span>Copy URL</span>
            </div>
            <div class="plugin-menu-item ${isCloudShareAvailable() ? '' : 'plugin-menu-item-disabled'}" data-action="invite">
                <span class="material-symbols-outlined">group_add</span>
                <span>Invite People</span>
            </div>
            <div class="plugin-menu-item" data-action="email">
                <span class="material-symbols-outlined">email</span>
                <span>Send by Email</span>
            </div>
        </div>
    `;
}

/**
 * Open email client with pre-filled message
 */
function sendByEmail() {
    const url = getCurrentUrl();
    const fontManager = (window as any).fontManager;
    const currentFont = fontManager?.currentFont;
    const fontName = currentFont?.name || 'Font';
    const fontPath = currentFont?.path || 'Unknown';
    const pluginName = currentFont?.sourcePlugin?.getName() || 'Unknown';

    const subject = encodeURIComponent(`Check out this font: ${fontName}`);
    const body = encodeURIComponent(
        `I wanted to share this font with you:\n\n` +
            `Font: ${fontName}\n` +
            `Path: ${fontPath}\n` +
            `File Plugin: ${pluginName}\n\n` +
            `View and edit in Counterpunch Font Editor:\n` +
            `${url}\n\n` +
            `IMPORTANT: To open this font, you need to have the file at the same path (${fontPath}) in your "${pluginName}" file system. The URL only contains the editor state, not the font file itself.\n\n` +
            `Check out the font editor at https://counterpunch.space\n\n` +
            `Best regards`
    );

    const mailtoLink = `mailto:?subject=${subject}&body=${body}`;

    // Use hidden anchor element
    const anchor = document.createElement('a');
    anchor.href = mailtoLink;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    console.log('[ShareButton]', 'Opened email client');
}

/**
 * Initialize share button and menu
 */
export function initShareButton(): void {
    const shareButton = document.getElementById('share-btn');
    if (!shareButton) {
        console.error('[ShareButton]', 'Share button not found');
        return;
    }

    // Create backdrop
    const backdrop = getOrCreateBackdrop('share-menu-backdrop');

    // Create tippy menu
    const tippyResult = tippy(shareButton, {
        content: createShareMenuHtml(),
        allowHTML: true,
        interactive: true,
        trigger: 'manual',
        theme: getTheme(),
        placement: 'bottom-end',
        arrow: false,
        offset: [0, 4],
        appendTo: document.body,
        hideOnClick: false,
        zIndex: 9999,
        onCreate: (instance) => {
            // Setup click handler using event delegation (only once)
            instance.popper.addEventListener('click', async (e) => {
                const menuItem = (e.target as HTMLElement).closest(
                    '.plugin-menu-item'
                );
                if (!menuItem) return;

                const action = menuItem.getAttribute('data-action');

                // Hide menu immediately
                instance.hide();

                switch (action) {
                    case 'copy-url':
                        {
                            const url = getCurrentUrl();
                            const success = await copyToClipboard(url);
                            if (success) {
                                console.log(
                                    '[ShareButton]',
                                    'URL copied to clipboard'
                                );
                            } else {
                                alert('Failed to copy URL to clipboard');
                            }
                        }
                        break;
                    case 'email':
                        sendByEmail();
                        break;
                    case 'invite':
                        openShareDialog();
                        break;
                }
            });
        },
        onShown: (instance) => {
            const menu = instance.popper.querySelector('.plugin-menu');
            if (menu) {
                setupMenuKeyboardNav(menu);
            }
        }
    });

    shareMenuInstance = Array.isArray(tippyResult)
        ? (tippyResult[0] ?? null)
        : tippyResult;

    // Add backdrop and keyboard support
    addTippyBackdropSupport(shareMenuInstance, backdrop, {
        targetElement: shareButton,
        activeClass: 'share-button-active'
    });

    // Click handler to toggle menu
    shareButton.addEventListener('click', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();

        shareMenuInstance?.setContent(createShareMenuHtml());

        if (shareMenuInstance?.state.isVisible) {
            shareMenuInstance.hide();
        } else {
            shareMenuInstance?.show();
        }
    });

    console.log('[ShareButton]', 'Share button initialized');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShareButton);
} else {
    initShareButton();
}
