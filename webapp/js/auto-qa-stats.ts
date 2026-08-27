export const WILSON_Z = 1.959964;
export const DEFAULT_QA_THRESHOLD_X = 0.85;
export const DEFAULT_QA_SOFT_X = 0.3;
export const DEFAULT_QA_N_MIN = 20;
export const DEFAULT_QA_PEER_M = 8;
export const DEFAULT_QA_MARK_PEER_M = 3;
export const DEFAULT_QA_ROLE_SHARE = 0.5;
export const DEFAULT_QA_WITHIN_FONT_RATE = 0.5;

/**
 * Wilson score interval 95% lower bound for k successes in n observations.
 * This is the Auto QA label confidence, not k/n.
 */
export function wilsonLowerBound(k: number, n: number): number {
    if (n <= 0 || k < 0) {
        return 0;
    }
    const clampedK = Math.min(k, n);
    const pHat = clampedK / n;
    const z2 = WILSON_Z * WILSON_Z;
    const denom = 1 + z2 / n;
    const centre = (pHat + z2 / (2 * n)) / denom;
    const margin =
        (WILSON_Z * Math.sqrt((pHat * (1 - pHat) + z2 / (4 * n)) / n)) / denom;
    return centre - margin;
}

const UNI_IDENTITY = /^uni([0-9A-Fa-f]+)(.*)$/;

export function parseUniIdentity(
    identity: string
): { codepoint: number; suffix: string } | null {
    const match = UNI_IDENTITY.exec(identity);
    if (!match) {
        return null;
    }
    const codepoint = Number.parseInt(match[1], 16);
    if (!Number.isFinite(codepoint) || codepoint < 0) {
        return null;
    }
    return { codepoint, suffix: match[2] || '' };
}

export function isCombiningMarkCodepoint(codepoint: number): boolean {
    if (codepoint >= 0x300 && codepoint <= 0x36f) {
        return true;
    }
    try {
        return /\p{Mn}/u.test(String.fromCodePoint(codepoint));
    } catch {
        return false;
    }
}

export function isCombiningMarkIdentity(identity: string): boolean {
    const parsed = parseUniIdentity(identity);
    if (!parsed) {
        return false;
    }
    return isCombiningMarkCodepoint(parsed.codepoint);
}
