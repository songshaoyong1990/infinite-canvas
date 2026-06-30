import { getAgentSseEndpoint, getDefaultCanvasAgentUrl, resolveAgentCredentials } from "@/lib/canvas-agent-url";
import { decodeLocalAgentModel, localAgentEventId } from "@/lib/local-agent-model";
import { useCanvasAgentStore, type AgentRuntimeOption } from "@/app/(user)/canvas/stores/use-canvas-agent-store";
import type { AiTextMessage } from "@/services/api/image";
import { requestImageQuestion } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";
import type { NodeGenerationContext } from "@/app/(user)/canvas/components/canvas-node-generation";

type AgentAttachmentInput = { name: string; type: string; dataUrl: string };

type AgentEventPayload = {
    agent?: string;
    type?: string;
    source?: "chat" | "workflow";
    turnId?: string;
    item?: { id?: string; type?: string; text?: unknown };
    message?: string;
};

type LocalAgentTextOptions = {
    agentId: string;
    modelId?: string;
    prompt: string;
    canvasId?: string;
    attachments?: AgentAttachmentInput[];
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
};

export async function fetchAgentJson<T>(endpoint: string, token: string, path: string, init?: RequestInit) {
    const url = `${endpoint}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; msg?: string };
    if (!res.ok) throw new Error(data.error || data.msg || "本地 Agent 请求失败");
    return data;
}

export async function resolveCanvasAgentCredentials() {
    const state = useCanvasAgentStore.getState();
    return resolveAgentCredentials(state.url || getDefaultCanvasAgentUrl(), state.token);
}

export async function loadAgentRuntimes() {
    const creds = await resolveCanvasAgentCredentials();
    if (!creds.token) return [] as AgentRuntimeOption[];
    const state = useCanvasAgentStore.getState();
    if (creds.endpoint !== state.url || creds.token !== state.token) {
        useCanvasAgentStore.getState().setAgentState({ url: creds.endpoint, token: creds.token });
        localStorage.setItem("canvas-agent-url", creds.endpoint);
        localStorage.setItem("canvas-agent-token", creds.token);
    }
    useCanvasAgentStore.getState().setAgentState({ loadingRuntimes: true });
    try {
        const data = await fetchAgentJson<{ runtimes?: AgentRuntimeOption[] }>(creds.endpoint, creds.token, "/agent/runtimes");
        const runtimes = data.runtimes || [];
        useCanvasAgentStore.getState().setAgentState({ runtimes });
        return runtimes;
    } finally {
        useCanvasAgentStore.getState().setAgentState({ loadingRuntimes: false });
    }
}

export async function cancelLocalAgentTurn() {
    try {
        const creds = await resolveCanvasAgentCredentials();
        if (!creds.token) return;
        await fetchAgentJson(creds.endpoint, creds.token, "/agent/cancel", { method: "POST" });
    } catch {
        // ignore cancel failures
    }
}

type WorkflowTextAnswerOptions = {
    config: AiConfig;
    model: string;
    messages: AiTextMessage[];
    generationContext: NodeGenerationContext;
    canvasId?: string;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
};

export async function requestWorkflowTextAnswer(options: WorkflowTextAnswerOptions) {
    const local = decodeLocalAgentModel(options.model);
    if (local) {
        return requestLocalAgentText({
            agentId: local.agentId,
            modelId: local.modelId,
            prompt: options.generationContext.prompt,
            canvasId: options.canvasId,
            attachments: options.generationContext.referenceImages.map((image) => ({ name: image.name, type: image.type, dataUrl: image.dataUrl })),
            signal: options.signal,
            onDelta: options.onDelta,
        });
    }
    return requestImageQuestion(options.config, options.messages, options.onDelta || (() => undefined), { signal: options.signal });
}

export async function requestLocalAgentText(options: LocalAgentTextOptions) {
    const creds = await resolveCanvasAgentCredentials();
    if (!creds.token) throw new Error("未发现本地 Canvas Agent，请先运行 npm run dev 或手动启动 canvas-agent");
    const eventAgentId = localAgentEventId(options.agentId);
    const path = options.agentId === "codex-mcp" ? "/agent/codex/turn" : "/agent/local/turn";
    const turnId = typeof crypto === "undefined" ? `${Date.now()}-${Math.random()}` : crypto.randomUUID();
    const body = {
        prompt: options.prompt,
        canvasId: options.canvasId,
        attachments: options.attachments,
        agentId: options.agentId,
        model: options.modelId && options.modelId !== "default" ? options.modelId : undefined,
        source: "workflow",
        turnId,
    };

    const bumpWorkflowTurn = (delta: number) => {
        const current = useCanvasAgentStore.getState().workflowTurnCount;
        useCanvasAgentStore.getState().setAgentState({ workflowTurnCount: Math.max(0, current + delta) });
    };
    bumpWorkflowTurn(1);

    return await new Promise<string>((resolve, reject) => {
        let text = "";
        let finished = false;
        let turnStarted = false;
        const clientId = typeof crypto === "undefined" ? `${Date.now()}` : crypto.randomUUID();
        const sseBase = getAgentSseEndpoint(creds.endpoint);
        const source = new EventSource(`${sseBase}/events?token=${encodeURIComponent(creds.token)}&clientId=${encodeURIComponent(clientId)}`);

        const cleanup = () => {
            source.close();
            options.signal?.removeEventListener("abort", onAbort);
        };

        const finish = (result: string) => {
            if (finished) return;
            finished = true;
            bumpWorkflowTurn(-1);
            cleanup();
            resolve(result);
        };

        const fail = (error: Error) => {
            if (finished) return;
            finished = true;
            bumpWorkflowTurn(-1);
            cleanup();
            reject(error);
        };

        const onAbort = () => {
            void cancelLocalAgentTurn();
            fail(new Error("请求已取消"));
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });

        source.addEventListener("hello", () => {
            void fetchAgentJson(creds.endpoint, creds.token, path, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }).catch((error) => fail(error instanceof Error ? error : new Error("启动本地 Agent 失败")));
        });

        source.addEventListener("agent_event", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (!data || data.turnId !== turnId || data.agent !== eventAgentId) return;
            if (data.type === "turn.started") turnStarted = true;
            if ((data.type === "item.updated" || data.type === "item.completed") && data.item?.type === "agent_message") {
                turnStarted = true;
                text = stringText(data.item.text) || text;
                options.onDelta?.(text);
            }
            if (data.type === "turn.completed") finish(text);
            if (data.type === "turn.failed") fail(new Error("本地 Agent 生成失败"));
        });

        source.addEventListener("agent_error", (event) => {
            const data = parseEventData<{ message?: unknown; turnId?: string }>(event);
            if (data?.turnId !== turnId) return;
            fail(new Error(stringText(data?.message) || "本地 Agent 出错"));
        });

        source.addEventListener("agent_done", (event) => {
            const data = parseEventData<{ cancelled?: boolean; code?: number; turnId?: string }>(event);
            if (data?.turnId !== turnId) return;
            if (data?.cancelled) fail(new Error("请求已取消"));
            if (turnStarted && !finished && (data?.code === 0 || data?.code === undefined)) finish(text);
        });

        source.onerror = () => {
            if (!finished && !turnStarted) fail(new Error("本地 Agent 连接失败，请确认 canvas-agent 已启动"));
        };
    });
}

function parseEventData<T>(event: Event) {
    try {
        return JSON.parse((event as MessageEvent).data) as T;
    } catch {
        return null;
    }
}

function stringText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}
