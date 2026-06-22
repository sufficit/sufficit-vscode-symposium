export interface ChangedFileItem {
    path: string;
    added: number;
    removed: number;
}

/** Tracks the net edited-files set for one live chat session. */
export class ChangedFilesState {
    private readonly files = new Map<string, { added: number; removed: number }>();

    record(path: string, added: number | undefined, removed: number | undefined): void {
        const current = this.files.get(path) ?? { added: 0, removed: 0 };
        current.added += added ?? 0;
        current.removed += removed ?? 0;
        this.files.set(path, current);
    }

    paths(): string[] {
        return [...this.files.keys()];
    }

    items(): ChangedFileItem[] {
        return [...this.files.entries()].map(([path, counts]) => ({
            path,
            added: counts.added,
            removed: counts.removed,
        }));
    }

    resolve(path: string): boolean {
        return this.files.delete(path);
    }
}
