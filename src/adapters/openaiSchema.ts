const OPENAI_UNSUPPORTED_SCHEMA_KEYS = new Set([
    "$schema",
    "$id",
    "$defs",
    "definitions",
    "propertyNames",
    "patternProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "dependentRequired",
    "dependentSchemas",
    "dependencies",
    "contains",
    "minContains",
    "maxContains",
    "if",
    "then",
    "else",
    "not",
]);

/**
 * VS Code LM tools may expose full JSON Schema drafts. OpenAI-compatible
 * function tools accept a narrower subset and reject keywords such as
 * `propertyNames`, so strip unsupported schema metadata recursively.
 */
export function sanitizeToolParametersForOpenAI(schema: unknown): Record<string, unknown> {
    const sanitized = sanitizeSchemaValue(schema);
    if (!isPlainObject(sanitized)) {
        return { type: "object", properties: {} };
    }
    return sanitized;
}

function sanitizeSchemaValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sanitizeSchemaValue);
    }

    if (!isPlainObject(value)) {
        return value;
    }

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (OPENAI_UNSUPPORTED_SCHEMA_KEYS.has(key)) {
            continue;
        }
        output[key] = sanitizeSchemaValue(child);
    }
    return output;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
