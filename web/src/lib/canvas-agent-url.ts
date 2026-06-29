export function getAgentSseEndpoint(logicalEndpoint: string) {
    const sseOrigin = process.env.NEXT_PUBLIC_CANVAS_AGENT_SSE_ORIGIN?.trim();
    const endpoint = normalizeAgentEndpoint(logicalEndpoint);
    if (sseOrigin && endpoint.startsWith("/")) return normalizeAgentEndpoint(sseOrigin);
    return endpoint;
}

export function getDefaultCanvasAgentUrl() {
    const configured = process.env.NEXT_PUBLIC_CANVAS_AGENT_URL?.trim();
    if (configured) return configured;
    return "http://127.0.0.1:17371";
}

export function normalizeAgentEndpoint(value: string) {
    return value.trim().replace(/\/$/, "");
}

export function isValidAgentEndpoint(value: string) {
    const endpoint = normalizeAgentEndpoint(value);
    if (!endpoint) return false;
    if (endpoint.startsWith("/")) return true;
    try {
        const parsed = new URL(endpoint);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

export function preferAgentEndpoint(current: string, discoveredUrl?: string) {
    const preferred = getDefaultCanvasAgentUrl();
    const endpoint = normalizeAgentEndpoint(current || preferred);
    if (preferred.startsWith("/")) return endpoint.startsWith("/") ? endpoint : normalizeAgentEndpoint(preferred);
    return normalizeAgentEndpoint(discoveredUrl || endpoint || preferred);
}

type AgentConfigResponse = { ok?: boolean; url?: string; token?: string };

export async function discoverAgentConfig(endpoint: string) {
    try {
        const res = await fetch(`${normalizeAgentEndpoint(endpoint)}/config`);
        if (!res.ok) return null;
        const data = (await res.json()) as AgentConfigResponse;
        return data.ok ? data : null;
    } catch {
        return null;
    }
}

export async function resolveAgentCredentials(endpoint: string, token: string) {
    const base = normalizeAgentEndpoint(endpoint || getDefaultCanvasAgentUrl());
    const discovered = await discoverAgentConfig(base);
    return {
        endpoint: preferAgentEndpoint(base, discovered?.url),
        token: (discovered?.token || token.trim()).trim(),
    };
}
