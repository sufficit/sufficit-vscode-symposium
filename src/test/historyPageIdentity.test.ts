import assert from "node:assert/strict";
import test from "node:test";
import { historyTurns } from "../ahp/historyProjection";
import { reconcileLoadedTurns } from "../ahp/turnReconciliation";

test("older history pages retain distinct turn identities when prepended", () => {
    const newest = historyTurns([{ role: "user", text: "recent" }]);
    const older = historyTurns([{ role: "user", text: "old" }], "render-1024");
    const combined = reconcileLoadedTurns({ turns: newest, activeTurn: undefined }, older, false);
    assert.equal(combined.length, 2);
    assert.deepEqual(
        combined.map((turn) => turn.message.text),
        ["old", "recent"],
    );
    assert.notEqual(combined[0].id, combined[1].id);
});
