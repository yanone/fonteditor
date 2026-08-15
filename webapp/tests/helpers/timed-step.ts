import { test } from '@playwright/test';

/**
 * Wrap an async action as a Playwright test.step so the step-timing reporter
 * can attribute wall time to named phases across the suite.
 */
export async function timedStep<T>(
    title: string,
    action: () => Promise<T>
): Promise<T> {
    return test.step(title, action);
}
