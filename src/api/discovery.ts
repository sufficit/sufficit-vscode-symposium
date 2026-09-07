import { AHP_SUPPORTED_PROTOCOL_VERSIONS } from "../ahp/wireProtocol";
import { SYMPOSIUM_FEATURE_VERSIONS } from "../features";

export const SYMPOSIUM_DISCOVERY_PATH = "/.well-known/symposium.json";
export const SYMPOSIUM_OPENAPI_PATH = "/openapi.json";
export const AHP_WEBSOCKET_PATH = "/ahp";

const AHP_METHODS = [
    "initialize",
    "ping",
    "reconnect",
    "subscribe",
    "unsubscribe",
    "listSessions",
    "createSession",
    "disposeSession",
    "dispatchAction",
] as const;

/** Machine-readable, transport-neutral contract for external Symposium clients. */
export function createSymposiumDiscovery(
    apiVersion: string,
    capabilities: readonly string[] = [],
): Record<string, unknown> {
    return {
        discoveryVersion: "1.0",
        service: { name: "Symposium", apiVersion },
        features: SYMPOSIUM_FEATURE_VERSIONS,
        protocols: {
            ahp: {
                transport: "websocket",
                endpoint: AHP_WEBSOCKET_PATH,
                subprotocols: ["ahp.v0.6"],
                versions: [...AHP_SUPPORTED_PROTOCOL_VERSIONS],
                methods: [...AHP_METHODS],
                root: "ahp-root://",
            },
            http: { transport: "http", openapi: SYMPOSIUM_OPENAPI_PATH },
        },
        capabilities: ["symposium.discovery.v1", ...new Set(capabilities)].sort(),
        authentication: {
            scheme: "bearer",
            headers: ["Authorization", "X-Symposium-Token"],
            queryCredentials: false,
        },
        refresh: "Fetch on each connection; capabilities may change.",
    };
}

/** OpenAPI document for the stable HTTP surface; AHP is described by its extension. */
export function createSymposiumOpenApi(apiVersion: string): Record<string, unknown> {
    const ok = { "200": { description: "OK" } };
    const publicGet = { get: { security: [], responses: ok } };
    const protectedGet = { get: { responses: ok } };
    return {
        openapi: "3.1.0",
        info: {
            title: "Symposium Bridge API",
            version: apiVersion,
            "x-symposium-feature-versions": SYMPOSIUM_FEATURE_VERSIONS,
        },
        paths: {
            [SYMPOSIUM_DISCOVERY_PATH]: publicGet,
            [SYMPOSIUM_OPENAPI_PATH]: publicGet,
            "/health": protectedGet,
            "/backends": protectedGet,
            [AHP_WEBSOCKET_PATH]: {
                get: {
                    responses: { "101": { description: "Upgrade" } },
                    "x-symposium-ahp": {
                        subprotocols: ["ahp.v0.6"],
                        protocolVersions: [...AHP_SUPPORTED_PROTOCOL_VERSIONS],
                        methods: [...AHP_METHODS],
                    },
                },
            },
        },
    };
}
