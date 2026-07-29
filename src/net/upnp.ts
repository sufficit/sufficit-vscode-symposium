/**
 * UPnP-IGD client for automatic port forwarding.
 * Discovers the router via SSDP and calls AddPortMapping.
 */

import * as dgram from "node:dgram";

export interface UpnpDevice {
    descriptionUrl: string;
    usn: string;
}

export interface UpnpPortMapping {
    externalIp: string;
    externalPort: number;
    internalIp: string;
    internalPort: number;
    publicUrl: string;
}

const SSDP_ADDR = "239.255.255.250";
const SSDP_PORT = 1900;

export function discoverUpnpGateway(timeoutMs = 3000): Promise<UpnpDevice | null> {
    return new Promise((resolve) => {
        const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
        const searchTarget = "urn:schemas-upnp-org:device:InternetGatewayDevice:1";
        const message = Buffer.from(
            "M-SEARCH * HTTP/1.1\r\n" +
            "HOST: " + SSDP_ADDR + ":" + SSDP_PORT + "\r\n" +
            "MAN: \"ssdp:discover\"\r\n" +
            "MX: 2\r\n" +
            "ST: " + searchTarget + "\r\n\r\n"
        );
        let resolved = false;
        const done = (r: UpnpDevice | null) => { if (!resolved) { resolved = true; try { sock.close(); } catch { /**/ } resolve(r); } };
        sock.on("message", (msg) => {
            const text = msg.toString();
            const loc = text.match(/LOCATION:\s*(.+)/i);
            const usn = text.match(/USN:\s*(.+)/i);
            if (loc) { done({ descriptionUrl: loc[1].trim(), usn: usn ? usn[1].trim() : "" }); }
        });
        sock.on("error", () => done(null));
        sock.bind(() => { sock.setBroadcast(true); sock.send(message, SSDP_PORT, SSDP_ADDR); });
        setTimeout(() => done(null), timeoutMs);
    });
}

function soapEnvelope(action: string, service: string, body: string): string {
    return '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
        '<s:Body><u:' + action + ' xmlns:u="' + service + '">' + body + '</u:' + action + '></s:Body></s:Envelope>';
}

export interface ParsedDevice { controlUrl: string; serviceType: string; }

export async function parseDeviceDescription(descriptionUrl: string): Promise<ParsedDevice | null> {
    try {
        const res = await fetch(descriptionUrl);
        if (!res.ok) { return null; }
        const xml = await res.text();
        const services: Array<{ st: string; cu: string }> = [];
        const re = /<service>([\s\S]*?)<\/service>/gi;
        let m;
        while ((m = re.exec(xml)) !== null) {
            const block = m[1];
            const stM = block.match(/<serviceType>(.*?)<\/serviceType>/i);
            const cuM = block.match(/<controlURL>(.*?)<\/controlURL>/i);
            if (stM && cuM) { services.push({ st: stM[1].trim(), cu: cuM[1].trim() }); }
        }
        const wan = services.find(s => s.st.includes("WANIPConnection")) ?? services.find(s => s.st.includes("WANPPPConnection"));
        if (!wan) { return null; }
        let cu = wan.cu;
        if (!cu.startsWith("http")) {
            const base = new URL(descriptionUrl);
            cu = new URL(cu, base.protocol + "//" + base.host).href;
        }
        return { controlUrl: cu, serviceType: wan.st };
    } catch { return null; }
}

export async function getExternalIp(controlUrl: string, serviceType: string): Promise<string | null> {
    const body = soapEnvelope("GetExternalIPAddress", serviceType, "");
    try {
        const res = await fetch(controlUrl, { method: "POST", headers: { "content-type": "text/xml", soapaction: serviceType + "#GetExternalIPAddress" }, body });
        const xml = await res.text();
        const m = xml.match(/<NewExternalIPAddress>(.*?)<\/NewExternalIPAddress>/i);
        return m ? m[1].trim() : null;
    } catch { return null; }
}

export async function addPortMapping(device: UpnpDevice, internalIp: string, internalPort: number, externalPort?: number, description = "Symposium Remote Bridge"): Promise<UpnpPortMapping | null> {
    const parsed = await parseDeviceDescription(device.descriptionUrl);
    if (!parsed) { return null; }
    const extPort = externalPort ?? internalPort;
    const externalIp = await getExternalIp(parsed.controlUrl, parsed.serviceType);
    const body = soapEnvelope("AddPortMapping", parsed.serviceType,
        "<NewRemoteHost></NewRemoteHost>" +
        "<NewExternalPort>" + extPort + "</NewExternalPort>" +
        "<NewProtocol>TCP</NewProtocol>" +
        "<NewInternalPort>" + internalPort + "</NewInternalPort>" +
        "<NewInternalClient>" + internalIp + "</NewInternalClient>" +
        "<NewEnabled>1</NewEnabled>" +
        "<NewPortMappingDescription>" + description + "</NewPortMappingDescription>" +
        "<NewLeaseDuration>0</NewLeaseDuration>");
    try {
        const res = await fetch(parsed.controlUrl, { method: "POST", headers: { "content-type": "text/xml", soapaction: parsed.serviceType + "#AddPortMapping" }, body });
        if (!res.ok) { return null; }
        const text = await res.text();
        if (text.includes("faultCode") || text.includes("Fault")) { return null; }
        const ip = externalIp ?? "unknown";
        return { externalIp: ip, externalPort: extPort, internalIp, internalPort, publicUrl: "http://" + ip + ":" + extPort };
    } catch { return null; }
}

export async function removePortMapping(device: UpnpDevice, externalPort: number): Promise<boolean> {
    const parsed = await parseDeviceDescription(device.descriptionUrl);
    if (!parsed) { return false; }
    const body = soapEnvelope("DeletePortMapping", parsed.serviceType,
        "<NewRemoteHost></NewRemoteHost><NewExternalPort>" + externalPort + "</NewExternalPort><NewProtocol>TCP</NewProtocol>");
    try {
        const res = await fetch(parsed.controlUrl, { method: "POST", headers: { "content-type": "text/xml", soapaction: parsed.serviceType + "#DeletePortMapping" }, body });
        return res.ok;
    } catch { return false; }
}
