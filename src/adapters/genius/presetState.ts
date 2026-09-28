/** Normalizes a preset selection: "default" (any case) means "let the
 *  backend/service default decide" and is represented as an empty preset id
 *  (no --preset flag passed to the CLI).
 */
export function explicitPreset(value: string): string {
    const preset = value.trim();
    return preset.toLowerCase() === "default" ? "" : preset;
}
