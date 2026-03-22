import type { UserspaceLocation } from './locations';

export type SavedVariationStateSnapshot = {
    selectionId: string;
    variationSettings: UserspaceLocation | null;
};

export class SavedVariationState {
    private selectionId: string | null = null;
    private variationSettings: UserspaceLocation | null = null;

    peek(): SavedVariationStateSnapshot | null {
        if (this.selectionId === null) {
            return null;
        }

        return {
            selectionId: this.selectionId,
            variationSettings: this.variationSettings
                ? { ...this.variationSettings }
                : null
        };
    }

    hasSavedState(): boolean {
        return this.selectionId !== null;
    }

    matchesCurrent(selectionId: string | null): boolean {
        return this.selectionId !== null && this.selectionId === selectionId;
    }

    save(
        selectionId: string | null,
        variationSettings: UserspaceLocation
    ): boolean {
        if (selectionId === null) {
            return false;
        }

        if (this.selectionId === selectionId) {
            return false;
        }

        this.selectionId = selectionId;
        this.variationSettings = { ...variationSettings };
        return true;
    }

    sync(
        selectionId: string | null,
        variationSettings: UserspaceLocation | null
    ): void {
        if (selectionId === null || variationSettings === null) {
            this.clear();
            return;
        }

        this.selectionId = selectionId;
        this.variationSettings = { ...variationSettings };
    }

    clear(): void {
        this.selectionId = null;
        this.variationSettings = null;
    }

    consume(): SavedVariationStateSnapshot | null {
        const snapshot = this.peek();
        this.clear();
        return snapshot;
    }
}
