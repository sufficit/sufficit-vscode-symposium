/** Keeps the active selection when a late model discovery omits it. */
export function preserveSelectedModel(models: string[], selected: string): string[] {
    if (!selected || selected === "default" || models.includes(selected)) {
        return models;
    }
    return [selected, ...models];
}
