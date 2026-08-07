import { JsonSessionRepository } from "./jsonRepository";
import { InMemorySessionRepository } from "./memoryRepository";
import { SessionRepository } from "./repository";

export interface SessionRepositoryFactoryOptions {
    storageDir: string;
    log?: (message: string) => void;
    disableSqlite?: boolean;
    repositoryFactories?: readonly (() => SessionRepository)[];
}

export function createSessionRepository(
    options: SessionRepositoryFactoryOptions,
): SessionRepository {
    const log = options.log ?? (() => undefined);
    const factories = options.repositoryFactories ?? defaultFactories(options);

    for (const create of factories) {
        try {
            const repository = create();
            if (repository.kind === "sqlite" && repository.importLegacy) {
                const seed = readJsonSeed(options.storageDir, log);
                const imported = repository.importLegacy(seed);
                if (imported > 0) {
                    log(`[sessions] migrated ${imported} rows from JSON to SQLite`);
                }
            }
            log(`[sessions] repository=${repository.kind}`);
            return repository;
        } catch (error) {
            log(
                `[sessions] repository unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    log("[sessions] repository=memory");
    return new InMemorySessionRepository();
}

function defaultFactories(options: SessionRepositoryFactoryOptions): (() => SessionRepository)[] {
    const factories: (() => SessionRepository)[] = [];
    // SQLite backend not included in this build — memory + JSON only.
    factories.push(() => new JsonSessionRepository(options.storageDir));
    factories.push(() => new InMemorySessionRepository());
    return factories;
}

function readJsonSeed(
    storageDir: string,
    log: (message: string) => void,
): ReturnType<JsonSessionRepository["list"]> {
    try {
        const json = new JsonSessionRepository(storageDir);
        try {
            return json.list();
        } finally {
            json.dispose();
        }
    } catch (error) {
        log(
            `[sessions] JSON migration skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
    }
}
