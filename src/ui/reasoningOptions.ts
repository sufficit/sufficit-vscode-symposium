export interface ReasoningMenuOption {
    value: string;
    label: string;
}

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
    const concreteDefault = defaultLevel && defaultLevel !== "default" ? defaultLevel : "";
    const hasConcreteDefault = !!concreteDefault && uniqueLevels.includes(concreteDefault);
    const defaultOption: ReasoningMenuOption = {
        value: "default",
        label: hasConcreteDefault ? `${concreteDefault} (default)` : "default",
    };
    const options: ReasoningMenuOption[] = [];

    for (const level of uniqueLevels) {
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
