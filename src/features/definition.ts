/** Stable namespace used to identify a Symposium feature across installations. */
export type FeatureNamespace = `symposium.${string}`;

/** Independent semantic version owned by a feature namespace. */
export type FeatureVersion = `${number}.${number}.${number}`;

export interface SymposiumFeatureDefinition<
    TNamespace extends FeatureNamespace = FeatureNamespace,
    TVersion extends FeatureVersion = FeatureVersion,
> {
    readonly namespace: TNamespace;
    readonly version: TVersion;
    readonly description: string;
}

export type FeatureVersionMap = Readonly<Partial<Record<FeatureNamespace, FeatureVersion>>>;

const FEATURE_NAMESPACE_PATTERN = /^symposium\.[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)*$/;
const FEATURE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Defines and validates feature metadata at the namespace boundary. */
export function defineFeature<
    const TNamespace extends FeatureNamespace,
    const TVersion extends FeatureVersion,
>(
    definition: SymposiumFeatureDefinition<TNamespace, TVersion>,
): Readonly<SymposiumFeatureDefinition<TNamespace, TVersion>> {
    if (!FEATURE_NAMESPACE_PATTERN.test(definition.namespace)) {
        throw new Error(`Invalid Symposium feature namespace: ${definition.namespace}`);
    }
    if (!FEATURE_VERSION_PATTERN.test(definition.version)) {
        throw new Error(`Invalid Symposium feature version: ${definition.version}`);
    }
    if (!definition.description.trim()) {
        throw new Error(`Missing description for Symposium feature: ${definition.namespace}`);
    }
    return Object.freeze({ ...definition });
}

function parseFeatureVersion(version: FeatureVersion): readonly [number, number, number] {
    const match = FEATURE_VERSION_PATTERN.exec(version);
    if (!match) {
        throw new Error(`Invalid Symposium feature version: ${version}`);
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compares semantic feature versions, returning a negative, zero, or positive value. */
export function compareFeatureVersions(left: FeatureVersion, right: FeatureVersion): number {
    const leftParts = parseFeatureVersion(left);
    const rightParts = parseFeatureVersion(right);
    for (let index = 0; index < leftParts.length; index += 1) {
        const difference = leftParts[index] - rightParts[index];
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

/**
 * Checks whether an installed feature can satisfy a requested minimum version.
 * Pre-1.0 features additionally require the same minor version.
 */
export function isFeatureVersionCompatible(
    installed: FeatureVersion,
    minimum: FeatureVersion,
): boolean {
    const [installedMajor, installedMinor] = parseFeatureVersion(installed);
    const [minimumMajor, minimumMinor] = parseFeatureVersion(minimum);
    if (installedMajor !== minimumMajor) {
        return false;
    }
    if (minimumMajor === 0 && installedMinor !== minimumMinor) {
        return false;
    }
    return compareFeatureVersions(installed, minimum) >= 0;
}

export function supportsFeatureVersion(
    versions: FeatureVersionMap,
    namespace: FeatureNamespace,
    minimum: FeatureVersion,
): boolean {
    const installed = versions[namespace];
    return installed !== undefined && isFeatureVersionCompatible(installed, minimum);
}
