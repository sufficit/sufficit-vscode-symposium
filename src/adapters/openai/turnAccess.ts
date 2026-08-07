import { buildTurnTools } from "./turnTools";
import type { TurnRunnerDeps } from "./turnRunnerDeps";

export interface TurnAccess {
    loginToken: string | null;
    noExplicitAuth: boolean;
    finalTools: unknown[];
}

/** Resolves authentication, model discovery and the tool contract before a turn. */
export async function prepareTurnAccess(
    deps: TurnRunnerDeps,
    responses: boolean,
): Promise<TurnAccess | undefined> {
    const noExplicitAuth =
        !deps.cfg.apiKey &&
        !Object.keys(deps.cfg.headers).some((key) => key.toLowerCase() === "authorization");
    const loginToken = await deps.authToken();
    if (noExplicitAuth && !loginToken) {
        deps.emit({
            kind: "error",
            message:
                "Not authenticated: sign in to Sufficit (Accounts menu / avatar) to use the Sufficit AI backend. If you already signed in and the error persists, the token is not being stored in this environment: set symposium.openai.apiKey or an Authorization header.",
        });
        return undefined;
    }
    if (!deps.model()) await deps.discoverModels(loginToken).catch(() => undefined);
    if (!deps.model()) {
        deps.emit({
            kind: "error",
            message:
                "No model selected for Sufficit AI. Pick a model in the session selector or set symposium.openai.model / symposium.openai.models.",
        });
        return undefined;
    }
    return {
        loginToken,
        noExplicitAuth,
        finalTools: buildTurnTools(deps.hub.configured(), responses),
    };
}
