import type { AgentRuntimeOption } from "@/app/(user)/canvas/stores/use-canvas-agent-store";

export const LOCAL_AGENT_MODEL_PREFIX = "local:";

export function encodeLocalAgentModel(agentId: string, modelId = "default") {
    const model = modelId.trim() || "default";
    return model === "default" ? `${LOCAL_AGENT_MODEL_PREFIX}${agentId}` : `${LOCAL_AGENT_MODEL_PREFIX}${agentId}:${model}`;
}

export function decodeLocalAgentModel(value: string) {
    if (!isLocalAgentModel(value)) return null;
    const rest = value.slice(LOCAL_AGENT_MODEL_PREFIX.length);
    const split = rest.indexOf(":");
    if (split === -1) return { agentId: rest, modelId: "default" };
    return { agentId: rest.slice(0, split), modelId: rest.slice(split + 1) || "default" };
}

export function isLocalAgentModel(value: string | undefined) {
    return Boolean(value?.startsWith(LOCAL_AGENT_MODEL_PREFIX));
}

export function localAgentEventId(agentId: string) {
    return agentId === "codex-mcp" ? "codex" : agentId;
}

export function buildLocalAgentModelOptions(runtimes: AgentRuntimeOption[]) {
    return runtimes
        .filter((runtime) => runtime.available)
        .flatMap((runtime) =>
            (runtime.models?.length ? runtime.models : [{ id: "default", label: "Default" }]).map((model) => ({
                value: encodeLocalAgentModel(runtime.id, model.id),
                label: `${runtime.name}${model.id === "default" ? "" : ` · ${model.label}`}`,
            })),
        );
}

export function localAgentModelLabel(value: string, runtimes: AgentRuntimeOption[]) {
    const decoded = decodeLocalAgentModel(value);
    if (!decoded) return value;
    const runtime = runtimes.find((item) => item.id === decoded.agentId);
    const model = runtime?.models?.find((item) => item.id === decoded.modelId);
    if (!runtime) return value;
    if (!model || model.id === "default") return `${runtime.name}（本地）`;
    return `${runtime.name} · ${model.label}（本地）`;
}
