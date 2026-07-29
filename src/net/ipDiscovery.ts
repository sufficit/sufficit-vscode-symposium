/**
 * Discovers valid network addresses for the Symposium bridge.
 */

import * as os from "node:os";
import { discoverUpnpGateway, getExternalIp, parseDeviceDescription } from "./upnp";

export interface DiscoveredIp {
    label: string;
    address: string;
    public: boolean;
    source: "upnp" | "lan" | "tailscale" | "ipv6";
}

function getLanAddresses(): { ipv4: string[]; ipv6: string[] } {
    const ipv4: string[] = [];
    const ipv6: string[] = [];
    const interfaces = os.networkInterfaces();
    for (const [, addrs] of Object.entries(interfaces)) {
        if (!addrs) { continue; }
        for (const addr of addrs) {
            if (addr.internal) { continue; }
            if (addr.family === "IPv4" && !addr.address.startsWith("169.254") && !addr.address.startsWith("100.")) {
                ipv4.push(addr.address);
            } else if (addr.family === "IPv6" && !addr.address.startsWith("fe80")) {
                ipv6.push(addr.address);
            }
        }
    }
    return { ipv4, ipv6 };
}

export async function discoverAddresses(
    _bridgePort: number,
    tailscaleHostname?: string,
    log?: (msg: string) => void,
): Promise<DiscoveredIp[]> {
    const results: DiscoveredIp[] = [];
    try {
        log?.("[network] discovering UPnP gateway...");
        const device = await discoverUpnpGateway(3000);
        if (device) {
            const parsed = await parseDeviceDescription(device.descriptionUrl);
            if (parsed) {
                const extIp = await getExternalIp(parsed.controlUrl, parsed.serviceType);
                if (extIp) { results.push({ label: "Public (UPnP)", address: extIp, public: true, source: "upnp" }); }
            }
        }
    } catch { /* best-effort */ }
    const { ipv4, ipv6 } = getLanAddresses();
    for (const ip of ipv4) { results.push({ label: "LAN", address: ip, public: false, source: "lan" }); }
    if (tailscaleHostname) { results.push({ label: "Tailscale", address: tailscaleHostname, public: true, source: "tailscale" }); }
    for (const ip of ipv6) { results.push({ label: "IPv6", address: ip, public: true, source: "ipv6" }); }
    return results;
}

export function buildUrl(ip: DiscoveredIp, port: number): string {
    const isIpv6 = ip.address.includes(":");
    const host = isIpv6 ? `[${ip.address}]` : ip.address;
    return `http://${host}:${port}`;
}
