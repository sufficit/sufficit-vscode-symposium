import test from "node:test";
import assert from "node:assert/strict";
import { renderInSlices } from "../ui/webview/renderScheduler";

test("history rendering yields between bounded slices and preserves order", async () => {
    const rendered: number[] = [];
    let yields = 0;
    let clock = 0;

    const completed = await renderInSlices(
        [1, 2, 3, 4, 5],
        (item) => {
            rendered.push(item);
            clock += 2;
        },
        {
            budgetMs: 3,
            maxItemsPerSlice: 2,
            now: () => clock,
            yieldControl: () => {
                yields++;
                return Promise.resolve();
            },
        },
    );

    assert.equal(completed, true);
    assert.deepEqual(rendered, [1, 2, 3, 4, 5]);
    assert.ok(yields >= 3, `expected multiple browser yields, received ${yields}`);
});

test("history rendering stops when a newer session invalidates the cycle", async () => {
    const rendered: number[] = [];
    let current = true;
    let yields = 0;

    const completed = await renderInSlices([1, 2, 3, 4], (item) => rendered.push(item), {
        maxItemsPerSlice: 1,
        stillCurrent: () => current,
        yieldControl: () => {
            yields++;
            if (yields === 2) current = false;
            return Promise.resolve();
        },
    });

    assert.equal(completed, false);
    assert.deepEqual(rendered, [1]);
});
