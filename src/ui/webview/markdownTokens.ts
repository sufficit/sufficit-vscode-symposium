export interface MarkdownLinkToken {
    image: boolean;
    label: string;
    href: string;
}

/** Fresh regex because callers iterate it and therefore mutate lastIndex. */
export function inlineTokenRegex(): RegExp {
    return /(!?\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
}

export function parseMarkdownLinkToken(token: string): MarkdownLinkToken | undefined {
    const match = token.match(/^(!?)\[([^\]]*)\]\(([^)]+)\)$/);
    if (!match) {
        return undefined;
    }
    let href = match[3].trim();
    if (href.startsWith("<") && href.endsWith(">")) {
        href = href.slice(1, -1).trim();
    }
    if (!href) {
        return undefined;
    }
    return { image: match[1] === "!", label: match[2], href };
}

export function isExternalMarkdownLink(href: string): boolean {
    return /^(https?|mailto|vscode):/i.test(href);
}

export function isRemoteMarkdownImage(href: string): boolean {
    return /^https?:/i.test(href);
}

export function isInlineMarkdownImage(href: string): boolean {
    return /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,/i.test(href);
}

export function isLocalMarkdownTarget(href: string): boolean {
    if (!href || href.startsWith("#")) {
        return false;
    }
    if (/^[A-Za-z]:[\\/]/.test(href)) {
        return true;
    }
    return /^file:/i.test(href) || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href);
}
