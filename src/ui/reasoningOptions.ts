export interface ReasoningMenuOption {
    value: string;
    label: string;
}

const CANONICAL_REASONING_ORDER = ["minimal", "low", "medium", "high", "xhigh"];

/**
 * Render the backend's default effort at its natural position in the scale.
 * The visible option keeps the internal `default` value, so choosing it still
 * omits an explicit effort override when the command is built.
 */
export function buildReasoningMenuOptions(
    levels: readonly string[],
    defaultLevel: string,
): ReasoningMenuOption[] {
    const uniqueLevels = [...new Set(levels.filter((level) => !!level))];
    // Adapters are allowed to omit native levels, but the shared picker must
    // keep the same natural order even when an older host returns an unordered
    // or duplicated list.
    const orderedLevels = [
        ...CANONICAL_REASONING_ORDER.filter((level) => uniqueLevels.includes(level)),
        ...uniqueLevels.filter(
            (level) => !CANONICAL_REASONING_ORDER.includes(level) && level !== "default",
        ),
        ...(uniqueLevels.includes("default") ? ["default"] : []),
    ];
    const concreteDefault = defaultLevel && defaultLevel !== "default" ? defaultLevel : "";
    const hasConcreteDefault = !!concreteDefault && orderedLevels.includes(concreteDefault);
    const defaultOption: ReasoningMenuOption = {
        value: "default",
        label: hasConcreteDefault ? `${concreteDefault} (default)` : "default",
    };
    const options: ReasoningMenuOption[] = [];

    for (const level of orderedLevels) {
        if (level === "default") {
            if (!hasConcreteDefault) {
                options.push(defaultOption);
            }
        } else if (hasConcreteDefault && level === concreteDefault) {
            options.push(defaultOption);
        } else {
            options.push({ value: level, label: level });
        }
    }

    return options;
}
