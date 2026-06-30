import { create } from "zustand";

import { getDefaultCanvasAgentUrl } from "@/lib/canvas-agent-url";
import type { CanvasAgentOp } from "../utils/canvas-agent-ops";

export type AgentChatRole = "user" | "assistant" | "system" | "tool" | "error";
export type AgentAttachment = { id: string; name: string; type: string; size: number; url: string; dataUrl: string };
export type AgentChatItem = { id: string; role: AgentChatRole; title?: string; text: string; meta?: string; detail?: unknown; attachments?: AgentAttachment[]; streamId?: string };
export type AgentEventLog = { id: string; time: string; title: string; text: string; raw?: unknown };
export type AgentPendingToolCall = { requestId: string; name: string; input?: { ops?: CanvasAgentOp[] } };
export type AgentThreadSummary = { id: string; preview: string; name?: string | null; cwd?: string; status?: string; source?: unknown; createdAt?: number; updatedAt?: number };
export type AgentRuntimeOption = { id: string; name: string; available: boolean; path?: string; version?: string | null; models: Array<{ id: string; label: string }>; authStatus?: "ok" | "missing" | "unknown"; authMessage?: string; supportsMcp?: boolean; supportsThreads?: boolean };
export type AgentPanelTab = "chat" | "setup" | "history" | "log";

type CanvasAgentStore = {
    width: number;
    url: string;
    token: string;
    connected: boolean;
    enabled: boolean;
    prompt: string;
    attachments: AgentAttachment[];
    sending: boolean;
    waiting: boolean;
    messages: AgentChatItem[];
    eventLogs: AgentEventLog[];
    threads: AgentThreadSummary[];
    activeThreadId: string;
    workspacePath: string;
    loadingThreads: boolean;
    activeTab: AgentPanelTab;
    confirmTools: boolean;
    activity: string;
    connectError: string;
    pendingTool: AgentPendingToolCall | null;
    runtimes: AgentRuntimeOption[];
    loadingRuntimes: boolean;
    selectedRuntimeId: string;
    selectedModelId: string;
    workflowTurnCount: number;
    setAgentState: (patch: Partial<Omit<CanvasAgentStore, "setAgentState" | "addMessage" | "addEventLog" | "clearEventLogs">>) => void;
    addMessage: (item: AgentChatItem) => void;
    addEventLog: (item: AgentEventLog) => void;
    clearEventLogs: () => void;
};

export const useCanvasAgentStore = create<CanvasAgentStore>((set) => ({
    width: typeof window === "undefined" ? 440 : Number(localStorage.getItem("canvas-agent-panel-width")) || 440,
    url: typeof window === "undefined" ? getDefaultCanvasAgentUrl() : localStorage.getItem("canvas-agent-url") || getDefaultCanvasAgentUrl(),
    token: typeof window === "undefined" ? "" : localStorage.getItem("canvas-agent-token") || "",
    connected: false,
    enabled: false,
    prompt: "",
    attachments: [],
    sending: false,
    waiting: false,
    messages: [],
    eventLogs: [],
    threads: [],
    activeThreadId: "",
    workspacePath: "",
    loadingThreads: false,
    activeTab: "setup",
    confirmTools: true,
    activity: "就绪",
    connectError: "",
    pendingTool: null,
    runtimes: [],
    loadingRuntimes: false,
    selectedRuntimeId: typeof window === "undefined" ? "codex-mcp" : localStorage.getItem("canvas-agent-runtime") || "codex-mcp",
    selectedModelId: typeof window === "undefined" ? "default" : localStorage.getItem("canvas-agent-model") || "default",
    workflowTurnCount: 0,
    setAgentState: (patch) => set(patch),
    addMessage: (item) => set((state) => ({ messages: [...state.messages.slice(-120), item] })),
    addEventLog: (item) => set((state) => ({ eventLogs: [...state.eventLogs.slice(-160), item] })),
    clearEventLogs: () => set({ eventLogs: [] }),
}));
