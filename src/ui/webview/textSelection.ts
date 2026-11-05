/** Keep native selection endpoints when streaming Markdown replaces its nodes.
 * Endpoints outside the updated body retain their original DOM positions. */
export function preserveTextSelection(body: HTMLElement, render: () => void): void {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) {
        render();
        return;
    }
    const capture = (node: Node, offset: number) => {
        if (!body.contains(node)) return { node, offset, textOffset: undefined };
        const range = document.createRange();
        range.selectNodeContents(body);
        range.setEnd(node, offset);
        return { node, offset, textOffset: range.toString().length };
    };
    const anchor = capture(selection.anchorNode, selection.anchorOffset);
    const focus = capture(selection.focusNode, selection.focusOffset);
    render();
    if (anchor.textOffset === undefined && focus.textOffset === undefined) return;
    const resolve = (point: ReturnType<typeof capture>): [Node, number] => {
        if (point.textOffset === undefined) return [point.node, point.offset];
        let remaining = point.textOffset;
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
            const length = node.textContent?.length || 0;
            if (remaining <= length) return [node, remaining];
            remaining -= length;
        }
        return [body, body.childNodes.length];
    };
    const [anchorNode, anchorOffset] = resolve(anchor);
    const [focusNode, focusOffset] = resolve(focus);
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
}
