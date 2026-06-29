const caps = new Map<string, Record<string, boolean>>();

export function setAgentCapabilities(agentId: string, value: Record<string, boolean>) {
    caps.set(agentId, value);
}

export function getAgentCapabilities(agentId: string) {
    return caps.get(agentId) || {};
}
