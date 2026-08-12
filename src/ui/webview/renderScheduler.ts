/**
 * Runs expensive DOM reconstruction in bounded slices so Chromium can paint,
 * animate the loading indicator and process input between chunks.
 */
export interface RenderSliceOptions {
    budgetMs?: number;
    maxItemsPerSlice?: number;
    stillCurrent?: () => boolean;
    now?: () => number;
    yieldControl?: () => Promise<void>;
}

export async function renderInSlices<T>(
    items: readonly T[],
    render: (item: T, index: number) => void,
    options: RenderSliceOptions = {},
): Promise<boolean> {
    const budgetMs = Math.max(1, options.budgetMs ?? 8);
    const maxItems = Math.max(1, options.maxItemsPerSlice ?? 8);
    const stillCurrent = options.stillCurrent ?? (() => true);
    const now = options.now ?? (() => performance.now());
    const yieldControl = options.yieldControl ?? yieldToBrowser;

    // Give the loading state one paint before parsing markdown/building rows.
    if (items.length > 0) {
        await yieldControl();
    }
    let index = 0;
    while (index < items.length) {
        if (!stillCurrent()) return false;
        const started = now();
        let rendered = 0;
        do {
            render(items[index], index);
            index++;
            rendered++;
        } while (
            index < items.length &&
            rendered < maxItems &&
            now() - started < budgetMs &&
            stillCurrent()
        );
        if (index < items.length) {
            await yieldControl();
        }
    }
    return stillCurrent();
}

function yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => resolve());
        } else {
            setTimeout(resolve, 0);
        }
    });
}
