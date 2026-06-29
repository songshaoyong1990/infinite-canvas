import type { AgentEmit } from "./types.js";

export type AgentTurnSource = "chat" | "workflow";

export type AgentTurnMeta = {
    source?: AgentTurnSource;
    turnId?: string;
};

export function readTurnMeta(body: Record<string, unknown> | null | undefined): AgentTurnMeta {
    const source = body?.source === "workflow" ? "workflow" : undefined;
    const turnId = typeof body?.turnId === "string" && body.turnId.trim() ? body.turnId.trim() : undefined;
    return { source, turnId };
}

export function createTurnEmit(emit: AgentEmit, meta: AgentTurnMeta): AgentEmit {
    if (!meta.source && !meta.turnId) return emit;
    return (type, payload) => {
        if (type !== "agent_event" && type !== "agent_error" && type !== "agent_done") {
            emit(type, payload);
            return;
        }
        const next =
            payload && typeof payload === "object"
                ? { ...(payload as Record<string, unknown>), ...(meta.source ? { source: meta.source } : {}), ...(meta.turnId ? { turnId: meta.turnId } : {}) }
                : payload;
        emit(type, next);
    };
}
