import { spawn } from "node:child_process";
import * as os from "node:os";
import { HubClient } from "../sync/hubClient";

/**
 * Auth-triggered join of the Sufficit tailnet (self-hosted Headscale) for Symposium's
 * remote-bridge feature. The bridge has no fixed host — whichever machine last ran this
 * becomes the one `GET /api/symposium/remote-url` resolves to (see hubClient.ts). A node,
 * once joined, persists locally (headscale's node.expiry is unset — see
 * castrum-headscale/config.yaml) so this only calls out for a NEW preauthkey on a
 * machine's first-ever join; every later login just confirms the existing join is healthy.
 */

function runTailscale(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        try {
            const child = spawn("tailscale", args, { stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (d) => { stdout += String(d); });
            child.stderr.on("data", (d) => { stderr += String(d); });
            child.on("error", () => resolve({ code: null, stdout, stderr }));
            child.on("exit", (code) => resolve({ code, stdout, stderr }));
        } catch {
            resolve({ code: null, stdout: "", stderr: "" });
        }
    });
}

interface TailscaleStatus {
    BackendState?: string;
    Self?: { HostName?: string; Tags?: string[] };
}

// This machine's own tailnet hostname, once known — read by bridge.ts's policy() to
// auto-permit its own MagicDNS name in symposium.bridge.allowedHosts without requiring the
// user to hand-copy it into settings.json.
let joinedHostname: string | undefined;

/** This machine's tailnet hostname if ensureTailnetJoined has confirmed/established it. */
export function getJoinedHostname(): string | undefined {
    return joinedHostname;
}

/** Reads Tailscale daemon status directly (exported for configPanel VPN check). */
export async function checkTailscaleStatus(): Promise<TailscaleStatus | null> {
    const { code, stdout } = await runTailscale(["status", "--json"]);
    if (code !== 0 || !stdout.trim()) {
        return null;
    }
    try {
        return JSON.parse(stdout) as TailscaleStatus;
    } catch {
        return null;
    }
}

// DNS-safe device label: lowercase, alnum + hyphen only, collapsed, capped — the backend's
// hostnamePrefix is already unique per user, this only needs to disambiguate that user's
// own machines from each other.
function deviceLabel(): string {
    const raw = os.hostname().toLowerCase();
    const cleaned = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return (cleaned || "device").slice(0, 24);
}

/**
 * Ensures this machine is joined to the Sufficit tailnet under tag:symposium-host, if not
 * already. Best-effort throughout — a missing `tailscale` CLI, an unconfigured hub, or a
 * network hiccup all degrade to "remote access unavailable this session" rather than an
 * error surfaced to the user (login must never fail because of this).
 */
export async function ensureTailnetJoined(hub: HubClient, log: (msg: string) => void): Promise<void> {
    const status = await checkTailscaleStatus();
    if (status === null) {
        log("[tailnet] `tailscale` CLI not found or not responding — remote access needs it installed separately.");
        return;
    }
    if (status.BackendState === "Running" && status.Self?.HostName) {
        // A machine that joined the tailnet (even manually, without the tag)
        // should still show as connected so the VPN status is accurate.
        const remote = await hub.resolveSymposiumRemoteUrl();
        joinedHostname = remote?.hostname ?? status.Self.HostName;
        log("[tailnet] already connected as " + joinedHostname);
        return;
    }

    const join = await hub.joinSymposiumTailnet();
    if (!join?.ok || !join.tailnetJoinKey || !join.tailnetLoginServer || !join.hostnamePrefix) {
        log("[tailnet] could not mint a join key (hub unreachable or not logged in) — remote access unavailable this session.");
        return;
    }

    const nodeName = join.hostnamePrefix + deviceLabel();
    const { code, stderr } = await runTailscale([
        "up",
        `--login-server=${join.tailnetLoginServer}`,
        `--authkey=${join.tailnetJoinKey}`,
        `--hostname=${nodeName}`,
        "--advertise-tags=tag:symposium-host",
        "--accept-dns=true",
    ]);
    if (code !== 0) {
        log(`[tailnet] join failed (exit ${code}): ${stderr.trim().slice(0, 300)}`);
        return;
    }
    joinedHostname = join.magicDnsBaseDomain ? `${nodeName}.${join.magicDnsBaseDomain}` : nodeName;
    log(`[tailnet] joined as ${joinedHostname}`);
}
