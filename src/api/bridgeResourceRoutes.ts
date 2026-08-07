import type * as http from "http";
import type { ResourceKind } from "../config/root";
import type { SymposiumApi } from "./symposiumApi";
import { readBridgeBody, writeBridgeJson, type BridgeRoute } from "./bridgeRoutes";

export async function handleBridgeResourceRoutes(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    route: BridgeRoute,
    api: SymposiumApi,
): Promise<boolean> {
    if (route.parts[0] !== "resources") return false;
    if (route.method === "GET" && route.parts.length === 1) {
        writeBridgeJson(response, 200, api.resources.scan());
        return true;
    }
    if (route.method === "POST") {
        if (route.parts[1] === "seed") {
            writeBridgeJson(response, 200, { created: api.resources.seed() });
            return true;
        }
        const body = await readBridgeBody(request);
        if (typeof body.kind !== "string" || typeof body.name !== "string") {
            writeBridgeJson(response, 400, { error: "kind and name are required strings" });
            return true;
        }
        const createdPath = api.resources.create(
            body.kind as ResourceKind,
            body.name,
            typeof body.description === "string" ? body.description : undefined,
        );
        writeBridgeJson(response, 200, { path: createdPath });
        return true;
    }
    if (route.method === "DELETE" && route.parts.length === 3) {
        const name = decodeURIComponent(route.parts[2]);
        if (!name) writeBridgeJson(response, 400, { error: "invalid resource name" });
        else {
            api.resources.remove(route.parts[1] as ResourceKind, name);
            writeBridgeJson(response, 200, { ok: true });
        }
        return true;
    }
    return false;
}
