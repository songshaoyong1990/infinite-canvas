"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useSearchParams } from "next/navigation";
import { App, Button, Input, Segmented, Select, Tooltip } from "antd";
import copyToClipboard from "copy-to-clipboard";
import { Copy, FolderOpen, History, KeyRound, Link2, LoaderCircle, PlugZap, Plus, RefreshCw, RotateCcw, Terminal, Trash2 } from "lucide-react";
import { motion } from "motion/react";

import { discoverAgentConfig, getAgentSseEndpoint, getDefaultCanvasAgentUrl, isValidAgentEndpoint, preferAgentEndpoint, resolveAgentCredentials } from "@/lib/canvas-agent-url";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasAgentStore, type AgentAttachment, type AgentChatItem, type AgentEventLog, type AgentPanelTab, type AgentPendingToolCall, type AgentRuntimeOption, type AgentThreadSummary } from "../stores/use-canvas-agent-store";
import { summarizeCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops";
import { AgentChatComposer, AgentChatMessage, AgentPanelTabs, AgentPendingToolCard, AgentWorkingMessage, type CanvasAgentChatAttachment } from "./canvas-agent-chat-ui";

const PANEL_MOTION_SECONDS = 0.5;
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_PAYLOAD_BYTES = 28 * 1024 * 1024;
const DEFAULT_AGENT_URL = getDefaultCanvasAgentUrl();
const AGENT_CONNECT_STEPS = [
    { title: "安装 Codex 插件", text: "在 Codex app 安装 Infinite Canvas 插件后，首次使用插件会自动启动本地 Agent。" },
    { title: "打开画布连接", text: "回到这里点击连接，网页会自动读取本机 Agent 配置。" },
    { title: "手动启动备用", text: "如果自动发现失败，再运行下面命令。", command: "npx -y @basketikun/canvas-agent" },
];

type AgentEventPayload = {
    agent?: string;
    type?: string;
    source?: "chat" | "workflow";
    turnId?: string;
    thread_id?: string;
    item?: AgentEventItem;
    error?: { message?: string };
    message?: string;
    usage?: Record<string, unknown>;
};
type AgentEventItem = { id?: string; type?: string; text?: unknown; message?: unknown; server?: string; tool?: string; status?: string; arguments?: unknown; result?: unknown; error?: { message?: string } };

type AgentLogContext = { endpoint: string; connected: boolean; enabled: boolean; activity: string; waiting: boolean; sending: boolean; messages: number; pendingTool?: string };
type AgentWorkspace = { canvasId: string; workspacePath: string; activeThreadId?: string };
type AgentThreadsResponse = { ok?: boolean; workspace?: AgentWorkspace; data?: AgentThreadSummary[] };
type AgentThreadResponse = { ok?: boolean; workspace?: AgentWorkspace; thread?: AgentThreadSummary; messages?: AgentChatItem[] };
type AgentRuntimesResponse = { ok?: boolean; runtimes?: AgentRuntimeOption[] };

export function CanvasLocalAgentPanel({ snapshot, canUndoOps, collapsed, embedded, headless, autoConnect, onApplyOps, onUndoOps }: { snapshot: CanvasAgentSnapshot; canUndoOps: boolean; collapsed?: boolean; embedded?: boolean; headless?: boolean; autoConnect?: boolean; onApplyOps: (ops: CanvasAgentOp[]) => unknown; onUndoOps: () => CanvasAgentSnapshot | null }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const { message, modal } = App.useApp();
    const searchParams = useSearchParams();
    const { width, url, token, connected, enabled, prompt, attachments, sending, waiting, messages, eventLogs, threads, activeThreadId, workspacePath, loadingThreads, activeTab, confirmTools, activity, connectError, pendingTool, runtimes, loadingRuntimes, selectedRuntimeId, selectedModelId, setAgentState, addMessage: pushMessage, addEventLog: pushEventLog, clearEventLogs } = useCanvasAgentStore();
    const [resizing, setResizing] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const snapshotRef = useRef(snapshot);
    const confirmToolsRef = useRef(confirmTools);
    const pendingToolRef = useRef<AgentPendingToolCall | null>(null);
    const onApplyOpsRef = useRef(onApplyOps);
    const autoConnectRef = useRef(false);
    const connectedRef = useRef(false);
    const errorLoggedRef = useRef(false);
    const attachmentUrlsRef = useRef(new Set<string>());
    const clientIdRef = useRef(typeof crypto === "undefined" ? `${Date.now()}` : crypto.randomUUID());
    const headlessRef = useRef(headless);
    headlessRef.current = headless;
    const messageRef = useRef(message);
    messageRef.current = message;
    const loadRuntimesRef = useRef<() => Promise<void>>(async () => {});
    const loadThreadsRef = useRef<() => Promise<void>>(async () => {});
    const handleToolCallRef = useRef<(endpoint: string, token: string, payload: AgentPendingToolCall) => Promise<void>>(async () => {});
    const handleAgentEventRef = useRef<(payload: AgentEventPayload) => void>(() => {});
    const dismissedTurnRef = useRef(false);
    const activeStreamIdRef = useRef("");
    const endpoint = useMemo(() => url.trim().replace(/\/$/, ""), [url]);
    const urlAgentAutoConnect = searchParams.has("agentUrl") && searchParams.has("agentToken");
    const selectedRuntime = useMemo(() => runtimes.find((item) => item.id === selectedRuntimeId), [runtimes, selectedRuntimeId]);
    const runtimeOptions = useMemo(() => runtimes.filter((item) => item.available).map((item) => ({ value: item.id, label: item.name })), [runtimes]);
    const modelOptions = useMemo(() => (selectedRuntime?.models || [{ id: "default", label: "Default" }]).map((item) => ({ value: item.id, label: item.label })), [selectedRuntime]);
    const loadRuntimes = useCallback(async () => {
        const creds = await resolveAgentCredentials(endpoint || DEFAULT_AGENT_URL, token);
        if (creds.endpoint !== endpoint || creds.token !== token) {
            setAgentState({ url: creds.endpoint, token: creds.token });
            localStorage.setItem("canvas-agent-url", creds.endpoint);
            localStorage.setItem("canvas-agent-token", creds.token);
        }
        if (!creds.token) {
            pushEventLog({ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString(), title: "扫描本地运行时失败", text: "未发现本地 Agent，请先运行 npx -y @basketikun/canvas-agent" });
            return;
        }
        setAgentState({ loadingRuntimes: true });
        try {
            const data = await fetchAgentJson<AgentRuntimesResponse>(creds.endpoint, creds.token, "/agent/runtimes");
            const next = data.runtimes || [];
            setAgentState({ runtimes: next });
            const current = useCanvasAgentStore.getState().selectedRuntimeId;
            if (!next.some((item) => item.id === current && item.available)) {
                const fallback = next.find((item) => item.available)?.id || "codex-mcp";
                setAgentState({ selectedRuntimeId: fallback });
                localStorage.setItem("canvas-agent-runtime", fallback);
            }
            const state = useCanvasAgentStore.getState();
            if (!state.connected && !state.enabled) {
                errorLoggedRef.current = false;
                setAgentState({ enabled: true, activity: "连接中", connectError: "" });
            }
        } catch (error) {
            pushEventLog({ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString(), title: "扫描本地运行时失败", text: error instanceof Error ? error.message : "扫描失败", raw: error });
        } finally {
            setAgentState({ loadingRuntimes: false });
        }
    }, [endpoint, pushEventLog, setAgentState, token]);

    const loadThreads = useCallback(async () => {
        const projectId = snapshotRef.current.projectId;
        if ((!connectedRef.current && !useCanvasAgentStore.getState().connected) || !projectId) return;
        if (useCanvasAgentStore.getState().selectedRuntimeId !== "codex-mcp") return;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadsResponse>(endpoint, token, `/agent/codex/threads?canvasId=${encodeURIComponent(projectId)}`);
            const current = useCanvasAgentStore.getState();
            setAgentState({
                threads: data.data || [],
                workspacePath: data.workspace?.workspacePath || current.workspacePath,
                activeThreadId: data.workspace?.activeThreadId || current.activeThreadId,
            });
            const nextThreadId = data.workspace?.activeThreadId || current.activeThreadId;
            if (nextThreadId && !current.messages.length) {
                const thread = await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/codex/threads/${encodeURIComponent(nextThreadId)}?canvasId=${encodeURIComponent(projectId)}`);
                setAgentState({ messages: normalizeHistoryMessages(thread.messages || []) });
            }
        } catch (error) {
            addEventLog("读取历史失败", error);
        } finally {
            setAgentState({ loadingThreads: false });
        }
    }, [endpoint, setAgentState, token]);

    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);
    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);
    useEffect(() => {
        pendingToolRef.current = pendingTool;
    }, [pendingTool]);
    useEffect(() => {
        onApplyOpsRef.current = onApplyOps;
    }, [onApplyOps]);
    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }, [messages, pendingTool, waiting]);
    useEffect(() => () => attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

    useEffect(() => {
        if (process.env.NODE_ENV !== "development") return;
        const preferred = getDefaultCanvasAgentUrl();
        const saved = localStorage.getItem("canvas-agent-url")?.trim();
        if (!saved || saved === "http://127.0.0.1:17371" || saved === "http://localhost:17371") {
            if (url !== preferred) setAgentState({ url: preferred });
            localStorage.setItem("canvas-agent-url", preferred);
        }
    }, [setAgentState, url]);

    useEffect(() => {
        if (connected || enabled) return;
        let cancelled = false;
        void (async () => {
            const creds = await resolveAgentCredentials(endpoint || DEFAULT_AGENT_URL, token);
            if (cancelled) return;
            if (!creds.token) return;
            localStorage.setItem("canvas-agent-url", creds.endpoint);
            localStorage.setItem("canvas-agent-token", creds.token);
            if (!cancelled && !useCanvasAgentStore.getState().connected && !useCanvasAgentStore.getState().enabled) {
                errorLoggedRef.current = false;
                setAgentState({ url: creds.endpoint, token: creds.token, enabled: true, activity: "连接中", connectError: "" });
            }
            void loadRuntimes();
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在面板初次挂载时自动发现并连接
    }, []);

    useEffect(() => {
        if (connected) void loadThreads();
    }, [connected, loadThreads, snapshot.projectId]);

    useEffect(() => {
        if (!connected) return;
        const timer = setTimeout(() => void postState(endpoint, token, clientIdRef.current, snapshot), 300);
        return () => clearTimeout(timer);
    }, [connected, endpoint, snapshot, token]);

    const sendPrompt = async () => {
        const text = prompt.trim();
        const files = attachments;
        const requestPrompt = promptWithAttachments(text, files);
        if (!connected || !requestPrompt || sending || waiting) return;
        if (attachmentPayloadBytes(files) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
            addMessage({ role: "error", title: "图片过大", text: "图片附件超过 30MB，请删减后再发送。" });
            return;
        }
        dismissedTurnRef.current = false;
        activeStreamIdRef.current = "";
        setAgentState({ activity: "发送中", sending: true, waiting: true });
        addMessage({ role: "user", text: text || "发送了图片", attachments: files });
        addEventLog("用户发送", { text, attachments: files.map(({ name, type, size }) => ({ name, type, size })) });
        try {
            const runtimeId = useCanvasAgentStore.getState().selectedRuntimeId;
            const model = useCanvasAgentStore.getState().selectedModelId;
            const body = {
                prompt: requestPrompt,
                canvasId: snapshotRef.current.projectId,
                threadId: useCanvasAgentStore.getState().activeThreadId || undefined,
                attachments: files.map(({ name, type, dataUrl }) => ({ name, type, dataUrl })),
                agentId: runtimeId,
                model: model !== "default" ? model : undefined,
            };
            const path = runtimeId === "codex-mcp" ? "/agent/codex/turn" : "/agent/local/turn";
            const res = await fetch(`${endpoint}${path}?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
            const data = (await res.json().catch(() => ({}))) as { threadId?: string; error?: string; msg?: string };
            if (!res.ok) throw new Error(data.error || data.msg || "本地 Agent 拒绝了请求");
            if (data.threadId) setAgentState({ activeThreadId: data.threadId });
            addEventLog("本地 Agent 已接收", { status: res.status });
            files.forEach((item) => {
                URL.revokeObjectURL(item.url);
                attachmentUrlsRef.current.delete(item.url);
            });
            setAgentState({ prompt: "", attachments: [] });
        } catch (error) {
            setAgentState({ activity: "发送失败", waiting: false });
            addMessage({ role: "error", title: "发送失败", text: error instanceof Error ? error.message : "发送失败" });
            addEventLog("发送失败", error);
        } finally {
            setAgentState({ sending: false });
        }
    };

    const stopPrompt = async () => {
        if (!connected || (!sending && !waiting)) return;
        if (pendingTool) {
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: pendingTool.requestId, error: "用户停止了当前回复" });
            pendingToolRef.current = null;
            setAgentState({ pendingTool: null });
        }
        dismissedTurnRef.current = true;
        const streamId = activeStreamIdRef.current;
        activeStreamIdRef.current = "";
        try {
            await fetchAgentJson<{ cancelled?: boolean }>(endpoint, token, "/agent/cancel", { method: "POST" });
            setAgentState({
                activity: "已停止",
                waiting: false,
                sending: false,
                messages: streamId ? useCanvasAgentStore.getState().messages.filter((item) => item.streamId !== streamId) : useCanvasAgentStore.getState().messages,
            });
            addMessage({ role: "system", text: "已停止当前回复" });
            addEventLog("用户停止", { endpoint });
        } catch (error) {
            setAgentState({ activity: "停止失败", waiting: false, sending: false });
            addMessage({ role: "error", title: "停止失败", text: error instanceof Error ? error.message : "停止失败" });
        }
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
        const prev = useCanvasAgentStore.getState().attachments;
        try {
            const next = await Promise.all(images.slice(0, Math.max(0, MAX_ATTACHMENTS - prev.length)).map(async (file) => {
                const dataUrl = await readDataUrl(file);
                const url = URL.createObjectURL(file);
                attachmentUrlsRef.current.add(url);
                return { id: createId(), name: file.name, type: file.type, size: file.size, url, dataUrl };
            }));
            const merged = [...prev, ...next];
            if (attachmentPayloadBytes(merged) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                addMessage({ role: "error", title: "图片过大", text: "图片附件最多约 30MB。" });
                return;
            }
            if (next.length) setAgentState({ attachments: merged });
        } catch (error) {
            addMessage({ role: "error", title: "图片读取失败", text: error instanceof Error ? error.message : "图片读取失败" });
        }
    };

    const removeAttachment = (id: string) => {
        const removed = attachments.find((item) => item.id === id);
        if (removed) {
            URL.revokeObjectURL(removed.url);
            attachmentUrlsRef.current.delete(removed.url);
        }
        setAgentState({ attachments: attachments.filter((item) => item.id !== id) });
    };

    const handleToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (useCanvasAgentStore.getState().workflowTurnCount > 0) {
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: "工作流生成进行中，已忽略画布工具调用" });
            return;
        }
        if (confirmToolsRef.current && payload.name === "canvas_apply_ops") {
            if (pendingToolRef.current) {
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: "仍有待确认的画布工具调用" });
                return;
            }
            pendingToolRef.current = payload;
            setAgentState({ pendingTool: payload, activity: "等待确认", waiting: false });
            addEventLog("等待确认", payload, payload);
            return;
        }
        await runToolCall(endpoint, token, payload);
    };

    const runToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        try {
            const input: { ops?: CanvasAgentOp[] } = payload.input || {};
            setAgentState({ activity: payload.name === "canvas_apply_ops" ? "执行画布操作" : "读取画布", waiting: true });
            addEventLog(toolName(payload.name), payload, payload);
            const result = payload.name === "canvas_apply_ops" ? onApplyOpsRef.current(input.ops || []) : snapshotRef.current;
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
            if (payload.name === "canvas_apply_ops") void postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            setAgentState({ activity: "工具完成", waiting: true });
            addEventLog(`${toolName(payload.name)}完成`, result, result);
            addMessage({ role: "tool", title: `${toolName(payload.name)}完成`, text: payload.name === "canvas_apply_ops" ? summarizeCanvasAgentOps(input.ops || []) || "画布操作" : "已完成", detail: { requestId: payload.requestId, name: payload.name, input, result } });
        } catch (error) {
            const message = error instanceof Error ? error.message : "画布操作失败";
            setAgentState({ activity: "工具失败", waiting: false });
            addMessage({ role: "tool", title: "工具失败", text: message, detail: payload });
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
        }
    };

    const rejectPendingTool = async () => {
        if (!pendingTool) return;
        await postToolResult(endpoint, token, clientIdRef.current, { requestId: pendingTool.requestId, error: "用户取消了画布工具调用" });
        setAgentState({ activity: "已取消", waiting: false });
        addMessage({ role: "tool", title: "拒绝执行", text: toolName(pendingTool.name), detail: { requestId: pendingTool.requestId, name: pendingTool.name, input: pendingTool.input } });
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
    };

    const approvePendingTool = async () => {
        if (!pendingTool) return;
        const tool = pendingTool;
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
        await runToolCall(endpoint, token, tool);
    };

    const undoLastTool = () => {
        const restored = onUndoOps();
        if (!restored) return;
        setAgentState({ activity: "已撤销" });
        addMessage({ role: "tool", title: "已撤销", text: "上一次工具操作", detail: restored });
        if (connected) void postState(endpoint, token, clientIdRef.current, restored);
    };

    const toggleAgentConnection = async () => {
        if (enabled) {
            clearAgentSession({ enabled: false, connected: false, activity: "离线", connectError: "" });
            return;
        }
        const urlToken = searchParams.get("agentToken") || "";
        const urlEndpoint = searchParams.get("agentUrl") || "";
        const discovered = urlToken ? null : await discoverAgentConfig(endpoint || DEFAULT_AGENT_URL);
        const nextEndpoint = preferAgentEndpoint(urlEndpoint || endpoint || DEFAULT_AGENT_URL, discovered?.url);
        const nextToken = (urlToken || discovered?.token || token.trim()).trim();
        if (!nextEndpoint) {
            const text = "请填写本地 Agent 地址";
            setAgentState({ connectError: text });
            if (!headless) message.warning(text);
            return;
        }
        if (!nextToken) {
            const text = "没有发现本地 Agent，请先在 Codex 使用插件或手动启动 Canvas Agent";
            setAgentState({ connectError: text });
            if (!headless) message.warning(text);
            return;
        }
        if (!isValidAgentEndpoint(nextEndpoint)) {
            const text = "本地 Agent 地址格式不正确";
            setAgentState({ connectError: text });
            if (!headless) message.warning(text);
            return;
        }
        errorLoggedRef.current = false;
        const creds = await resolveAgentCredentials(nextEndpoint, nextToken);
        localStorage.setItem("canvas-agent-url", creds.endpoint);
        localStorage.setItem("canvas-agent-token", creds.token);
        setAgentState({ url: creds.endpoint, token: creds.token, enabled: true, connected: false, activity: "连接中", connectError: "" });
    };

    useEffect(() => {
        if (urlAgentAutoConnect && confirmTools) setAgentState({ confirmTools: false });
    }, [confirmTools, setAgentState, urlAgentAutoConnect]);

    useEffect(() => {
        if (!autoConnect || autoConnectRef.current || enabled || connected) return;
        autoConnectRef.current = true;
        void toggleAgentConnection();
    }, [autoConnect, connected, enabled]);

    function clearAgentSession(patch: Parameters<typeof setAgentState>[0] = {}) {
        setAgentState({
            messages: [],
            threads: [],
            activeThreadId: "",
            workspacePath: "",
            loadingThreads: false,
            waiting: false,
            sending: false,
            pendingTool: null,
            ...patch,
        });
        pendingToolRef.current = null;
    }

    const startNewThread = async () => {
        const projectId = snapshotRef.current.projectId;
        if (!connected || !projectId) return;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadResponse>(endpoint, token, "/agent/codex/threads/new", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ canvasId: projectId }) });
            setAgentState({ activeThreadId: data.thread?.id || data.workspace?.activeThreadId || "", messages: [], activeTab: "chat", activity: "新对话" });
            await loadThreads();
        } catch (error) {
            addEventLog("新建对话失败", error);
            message.error(error instanceof Error ? error.message : "新建对话失败");
        } finally {
            setAgentState({ loadingThreads: false });
        }
    };

    const resumeThread = async (threadId: string) => {
        const projectId = snapshotRef.current.projectId;
        if (!connected || !projectId || !threadId) return;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/codex/threads/${encodeURIComponent(threadId)}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ canvasId: projectId }) });
            setAgentState({ activeThreadId: data.thread?.id || threadId, messages: normalizeHistoryMessages(data.messages || []), activeTab: "chat", activity: "已恢复会话" });
            await loadThreads();
        } catch (error) {
            addEventLog("恢复对话失败", error);
            message.error(error instanceof Error ? error.message : "恢复对话失败");
        } finally {
            setAgentState({ loadingThreads: false });
        }
    };

    const deleteThread = async (threadId: string) => {
        const projectId = snapshotRef.current.projectId;
        if (!connected || !projectId || !threadId) return;
        setAgentState({ loadingThreads: true });
        try {
            await fetchAgentJson(endpoint, token, `/agent/codex/threads/${encodeURIComponent(threadId)}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ canvasId: projectId }) });
            const current = useCanvasAgentStore.getState();
            setAgentState({
                threads: current.threads.filter((thread) => thread.id !== threadId),
                activeThreadId: current.activeThreadId === threadId ? "" : current.activeThreadId,
                messages: current.activeThreadId === threadId ? [] : current.messages,
            });
            message.success("记录已删除");
        } catch (error) {
            addEventLog("删除对话失败", error);
            message.error(error instanceof Error ? error.message : "删除对话失败");
        } finally {
            setAgentState({ loadingThreads: false });
        }
    };

    const confirmDeleteThread = (thread: AgentThreadSummary) => {
        const label = thread.name || thread.preview || "未命名对话";
        modal.confirm({
            title: "删除对话记录",
            content: `确定删除「${label.length > 48 ? `${label.slice(0, 48)}...` : label}」吗？`,
            okText: "删除",
            okType: "danger",
            cancelText: "取消",
            onOk: () => deleteThread(thread.id),
        });
    };

    const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = clamp(startWidth + startX - moveEvent.clientX, 360, 760);
            setAgentState({ width: nextWidth });
        };
        const onUp = () => {
            localStorage.setItem("canvas-agent-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    const addMessage = (item: Omit<AgentChatItem, "id">) => {
        const text = normalizeText(item.text);
        if (!text && !item.attachments?.length) return;
        const next = { ...item, id: `${Date.now()}-${Math.random()}`, text };
        const currentMessages = useCanvasAgentStore.getState().messages;
        if (next.streamId) {
            const index = currentMessages.findIndex((message) => message.streamId === next.streamId);
            if (index >= 0) {
                setAgentState({ messages: currentMessages.map((message, i) => i === index ? { ...message, ...next, id: message.id, text: next.text || message.text } : message) });
                return;
            }
        }
        const last = currentMessages.at(-1);
        if (last?.role === "assistant" && next.role === "assistant" && last.title === next.title) {
            const merged = mergeAgentText(last.text, next.text);
            if (merged === last.text) return;
            setAgentState({ messages: [...useCanvasAgentStore.getState().messages.slice(0, -1), { ...last, text: merged, meta: next.meta || last.meta }] });
            return;
        }
        pushMessage(next);
    };

    const addEventLog = (title: string, text: unknown, raw?: unknown) => {
        pushEventLog({ id: `${Date.now()}-${Math.random()}`, time: new Date().toLocaleTimeString(), title, text: normalizeText(text) || title, raw });
    };

    const handleAgentEvent = (event: AgentEventPayload) => {
        if (event.source === "workflow") return;
        if (dismissedTurnRef.current) return;
        if (event.item?.id) activeStreamIdRef.current = event.item.id;
        if (shouldLogAgentEvent(event)) addEventLog(eventTitle(event), event, event);
        if (event.type === "thread.started" && event.thread_id) setAgentState({ activeThreadId: event.thread_id });
        const nextActivity = activityText(event);
        if (nextActivity) setAgentState({ activity: nextActivity });
        if (event.type === "turn.started") setAgentState({ waiting: true });
        if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "error") {
            activeStreamIdRef.current = "";
            setAgentState({ waiting: false, sending: false });
        }
        const item = formatAgentEvent(event, runtimes);
        if (item) {
            if (item.role === "error") setAgentState({ waiting: false, sending: false });
            addMessage(item);
        }
    };

    loadRuntimesRef.current = loadRuntimes;
    loadThreadsRef.current = loadThreads;
    handleToolCallRef.current = handleToolCall;
    handleAgentEventRef.current = handleAgentEvent;

    useEffect(() => {
        if (!enabled || !token.trim()) return;
        let cancelled = false;
        let source: EventSource | null = null;
        let failTimer: ReturnType<typeof setTimeout> | undefined;
        void (async () => {
            const creds = await resolveAgentCredentials(endpoint, token);
            if (cancelled) return;
            if (creds.endpoint !== endpoint || creds.token !== token) {
                setAgentState({ url: creds.endpoint, token: creds.token });
                return;
            }
            const sseBase = getAgentSseEndpoint(creds.endpoint);
            const clientId = clientIdRef.current;
            localStorage.setItem("canvas-agent-url", creds.endpoint);
            localStorage.setItem("canvas-agent-token", creds.token);
            source = new EventSource(`${sseBase}/events?token=${encodeURIComponent(creds.token)}&clientId=${encodeURIComponent(clientId)}`);
            failTimer = setTimeout(() => {
                if (cancelled || connectedRef.current) return;
                source?.close();
                errorLoggedRef.current = true;
                clearAgentSession({ activity: "连接失败", connected: false, connectError: "连接超时，请确认 canvas-agent 已启动", enabled: false });
                if (!headlessRef.current) messageRef.current.error("连接超时，请确认 canvas-agent 已启动");
            }, 12000);
            source.addEventListener("hello", () => {
                if (failTimer) clearTimeout(failTimer);
                errorLoggedRef.current = false;
                connectedRef.current = true;
                setAgentState({ connected: true, activity: "已连接", connectError: "", messages: useCanvasAgentStore.getState().messages.filter((item) => !isConnectionErrorMessage(item)) });
                if (!headlessRef.current) messageRef.current.success("本地 Agent 已连接");
                void postState(creds.endpoint, creds.token, clientId, snapshotRef.current);
                void loadRuntimesRef.current();
            });
            source.addEventListener("tool_call", (event) => {
                const data = parseEventData<AgentPendingToolCall>(event);
                if (data) void handleToolCallRef.current(creds.endpoint, creds.token, data);
            });
            source.addEventListener("agent_event", (event) => {
                const data = parseEventData<AgentEventPayload>(event);
                if (data) handleAgentEventRef.current(data);
            });
            source.addEventListener("agent_log", (event) => {
                if (useCanvasAgentStore.getState().workflowTurnCount > 0) return;
                const text = parseEventData<{ text?: unknown }>(event)?.text;
                addEventLog("日志", text, text);
            });
            source.addEventListener("agent_error", (event) => {
                const data = parseEventData<{ message?: unknown; source?: string }>(event);
                if (data?.source === "workflow" || dismissedTurnRef.current) return;
                const errText = data?.message;
                setAgentState({ activity: "出错", waiting: false });
                addMessage({ role: "error", title: "错误", text: normalizeText(errText) });
                addEventLog("错误", errText, errText);
            });
            source.addEventListener("agent_done", (event) => {
                const data = parseEventData<{ cancelled?: boolean; source?: string }>(event);
                if (data?.source === "workflow") return;
                if (dismissedTurnRef.current) return;
                setAgentState({ activity: data?.cancelled ? "已停止" : "完成", waiting: false, sending: false });
                void loadThreadsRef.current();
            });
            source.onerror = () => {
                if (!connectedRef.current) return;
                if (failTimer) clearTimeout(failTimer);
                const text = "本地 Agent 连接失败或已断开";
                if (!errorLoggedRef.current) {
                    addEventLog("连接断开", { endpoint: creds.endpoint, error: text });
                    if (!headlessRef.current) messageRef.current.error(text);
                }
                errorLoggedRef.current = true;
                connectedRef.current = false;
                clearAgentSession({ activity: "连接断开", connected: false, connectError: text, enabled: false });
                source?.close();
            };
        })();
        return () => {
            cancelled = true;
            if (failTimer) clearTimeout(failTimer);
            source?.close();
            connectedRef.current = false;
            setAgentState({ connected: false });
        };
    }, [enabled, endpoint, token]);

    const content = (
        <>
            <AgentPanelTabs
                value={activeTab}
                theme={theme}
                items={[
                    { value: "setup", label: "连接", icon: <PlugZap className="size-3.5" /> },
                    { value: "chat", label: "对话" },
                    { value: "history", label: "历史", icon: <History className="size-3.5" />, count: threads.length },
                    { value: "log", label: "日志", icon: <Terminal className="size-3.5" />, count: eventLogs.length },
                ]}
                onChange={(activeTab) => {
                    setAgentState({ activeTab });
                    if (activeTab === "history") void loadThreads();
                }}
                right={
                    <>
                        <Button size="small" type="text" disabled={!canUndoOps} icon={<RotateCcw className="size-3.5" />} onClick={undoLastTool}>
                            撤销
                        </Button>
                    </>
                }
            />

            {activeTab === "setup" ? (
                <AgentConnectView
                    theme={theme}
                    url={url}
                    token={token}
                    enabled={enabled}
                    connected={connected}
                    activity={activity}
                    connectError={connectError}
                    runtimes={runtimes}
                    loadingRuntimes={loadingRuntimes}
                    selectedRuntimeId={selectedRuntimeId}
                    onUrlChange={(url) => setAgentState({ url, connectError: "" })}
                    onTokenChange={(token) => setAgentState({ token, connectError: "" })}
                    onToggleEnabled={toggleAgentConnection}
                    onRescanRuntimes={() => void loadRuntimes()}
                    onRuntimeChange={(selectedRuntimeId) => {
                        setAgentState({ selectedRuntimeId, selectedModelId: "default" });
                        localStorage.setItem("canvas-agent-runtime", selectedRuntimeId);
                        localStorage.setItem("canvas-agent-model", "default");
                    }}
                />
            ) : activeTab === "history" ? (
                <AgentHistoryView
                    theme={theme}
                    threads={threads}
                    activeThreadId={activeThreadId}
                    workspacePath={workspacePath}
                    loading={loadingThreads}
                    connected={connected}
                    onRefresh={() => void loadThreads()}
                    onNewThread={() => void startNewThread()}
                    onResumeThread={(threadId) => void resumeThread(threadId)}
                    onDeleteThread={confirmDeleteThread}
                />
            ) : activeTab === "log" ? (
                <AgentLogView
                    logs={eventLogs}
                    theme={theme}
                    context={{ endpoint, connected, enabled, activity, waiting, sending, messages: messages.length, pendingTool: pendingTool?.name }}
                    onClear={clearEventLogs}
                    onCopied={(text) => message.success(text)}
                    onCopyBlocked={(text) => message.warning(text)}
                />
            ) : (
                <>
                    <div ref={listRef} className="thin-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                        {messages.map((item) => (
                            <AgentChatMessage key={item.id} item={agentMessageToChatMessage(item)} theme={theme} user={user} />
                        ))}
                        {pendingTool ? <AgentPendingToolCard summary={summarizeCanvasAgentOps(pendingTool.input?.ops || []) || toolName(pendingTool.name)} detail={{ requestId: pendingTool.requestId, name: pendingTool.name, input: pendingTool.input }} theme={theme} onReject={rejectPendingTool} onApprove={approvePendingTool} /> : null}
                        {waiting && !pendingTool ? <AgentWorkingMessage theme={theme} /> : null}
                    </div>
                    <AgentChatComposer
                        prompt={prompt}
                        attachments={attachments.map(agentAttachmentToChatAttachment)}
                        disabled={!connected}
                        sending={sending || waiting}
                        placeholder={connected ? (selectedRuntime?.supportsMcp ? "询问 Agent，或让它操作画布" : "询问本地 Agent") : enabled ? "正在连接本地 Agent…" : "请先在「连接」页启动 Canvas Agent 并点击连接"}
                        theme={theme}
                        onPromptChange={(prompt) => setAgentState({ prompt })}
                        onSubmit={sendPrompt}
                        onStop={() => void stopPrompt()}
                        onAddFiles={addAttachments}
                        onRemoveAttachment={removeAttachment}
                        left={
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <Select
                                    size="small"
                                    className="min-w-[148px]"
                                    value={selectedRuntimeId}
                                    options={runtimeOptions}
                                    disabled={!connected || !runtimeOptions.length}
                                    onChange={(value) => {
                                        setAgentState({ selectedRuntimeId: value, selectedModelId: "default" });
                                        localStorage.setItem("canvas-agent-runtime", value);
                                        localStorage.setItem("canvas-agent-model", "default");
                                    }}
                                />
                                {modelOptions.length > 1 ? (
                                    <Select
                                        size="small"
                                        className="min-w-[120px]"
                                        value={selectedModelId}
                                        options={modelOptions}
                                        disabled={!connected}
                                        onChange={(value) => {
                                            setAgentState({ selectedModelId: value });
                                            localStorage.setItem("canvas-agent-model", value);
                                        }}
                                    />
                                ) : null}
                                {attachments.length ? <span className="text-[11px]" style={{ color: theme.node.muted }}>{formatBytes(attachmentPayloadBytes(attachments))} / 30MB</span> : null}
                            </div>
                        }
                    />
                </>
            )}
        </>
    );

    if (headless) return null;
    if (embedded) return content;

    return (
        <motion.div
            className="relative z-[70] flex h-full shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: collapsed ? 0 : width + 1, opacity: collapsed ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: collapsed ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex h-full shrink-0 flex-col border-l"
                initial={{ x: 48 }}
                animate={{ x: collapsed ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <div className="absolute left-0 top-0 h-full w-1 cursor-col-resize transition hover:bg-current/20" onPointerDown={startResize} />
                {content}
            </motion.aside>
        </motion.div>
    );
}

function AgentLogView({ logs, theme, context, onClear, onCopied, onCopyBlocked }: { logs: AgentEventLog[]; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; context: AgentLogContext; onClear: () => void; onCopied: (text: string) => void; onCopyBlocked: (text: string) => void }) {
    const [mode, setMode] = useState<"text" | "json">("text");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const content = mode === "text" ? formatLogText(logs, context) : formatLogJson(logs, context);
    const lastError = [...logs].reverse().find((item) => /错误|失败|error/i.test(`${item.title}\n${item.text}`));
    const copy = async (value = content, tip = "日志已复制") => {
        if (await copyToClipboard(value)) {
            onCopied(tip);
            return;
        }
        textareaRef.current?.focus();
        textareaRef.current?.select();
        onCopyBlocked("已选中日志，请手动复制");
    };
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="flex min-h-full flex-col gap-3">
                <div>
                    <div className="text-base font-semibold leading-6">运行日志</div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <Segmented size="small" value={mode} onChange={(value) => setMode(value as "text" | "json")} options={[{ label: "排查日志", value: "text" }, { label: "原始 JSON", value: "json" }]} />
                    <div className="flex items-center gap-2">
                        <span className="text-xs" style={{ color: theme.node.muted }}>{logs.length} 条</span>
                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void copy()}>复制</Button>
                        <Button size="small" disabled={!lastError} onClick={() => lastError && void copy(formatLogText([lastError], context), "最近错误已复制")}>最近错误</Button>
                        <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} disabled={!logs.length} onClick={onClear}>清空</Button>
                    </div>
                </div>
                <textarea
                    ref={textareaRef}
                    readOnly
                    value={content}
                    className="thin-scrollbar min-h-[360px] flex-1 resize-none rounded-lg border bg-transparent p-3 font-mono text-xs leading-5 outline-none"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    onFocus={(event) => event.currentTarget.select()}
                />
            </div>
        </div>
    );
}

function AgentConnectView({ theme, url, token, enabled, connected, activity, connectError, runtimes, loadingRuntimes, selectedRuntimeId, onUrlChange, onTokenChange, onToggleEnabled, onRescanRuntimes, onRuntimeChange }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; url: string; token: string; enabled: boolean; connected: boolean; activity: string; connectError: string; runtimes: AgentRuntimeOption[]; loadingRuntimes: boolean; selectedRuntimeId: string; onUrlChange: (value: string) => void; onTokenChange: (value: string) => void; onToggleEnabled: () => void; onRescanRuntimes: () => void; onRuntimeChange: (value: string) => void }) {
    const { message } = App.useApp();
    const statusText = connectError ? "连接失败" : connected ? activity : enabled ? "连接中" : "未连接";
    const statusColor = connectError ? "#dc2626" : connected ? "#16a34a" : enabled ? "#d97706" : theme.node.muted;
    const copyCommand = (command: string) => {
        copyToClipboard(command);
        message.success("命令已复制");
    };
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
                <div>
                    <div className="text-base font-semibold leading-6">连接本地 Agent</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                        安装 Codex 插件后，画布会优先自动连接本机 Agent。
                    </div>
                </div>
                <div className="space-y-2">
                    {AGENT_CONNECT_STEPS.map((step) => {
                        const command = "command" in step ? step.command : "";
                        return (
                            <div key={step.title} className="rounded-lg px-3 py-2.5">
                                <div className="text-sm font-medium leading-5">{step.title}</div>
                                <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>{step.text}</div>
                                {command ? (
                                    <div className="mt-2 flex items-center gap-2 rounded-md border bg-transparent px-2 py-1.5" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                                        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] leading-5">{command}</code>
                                        <Tooltip title="复制命令">
                                            <Button size="small" type="text" className="!h-6 !w-6 !min-w-6" icon={<Copy className="size-3.5" />} onClick={() => copyCommand(command)} />
                                        </Tooltip>
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="shrink-0 text-sm font-medium leading-5">网页连接</span>
                                <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4" style={{ borderColor: connected || enabled || connectError ? statusColor : theme.node.stroke, color: statusColor }}>
                                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: statusColor }} />
                                    <span className="truncate">{statusText}</span>
                                </span>
                            </div>
                            <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                默认自动读取 Local URL 和 Connect token，失败时再手动填写。
                            </div>
                        </div>
                        <Button className="!h-8 !px-3" type={enabled ? "default" : "primary"} icon={<PlugZap className="size-4" />} onClick={onToggleEnabled}>
                            {enabled ? "断开" : "连接"}
                        </Button>
                    </div>
                    <div className="mt-3 grid gap-2.5">
                        <label className="grid gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                <Link2 className="size-3.5" />
                                本地地址
                                <span className="font-normal opacity-70">Local URL</span>
                            </span>
                            <Input size="large" prefix={<Link2 className="mr-1 size-4" style={{ color: theme.node.faint }} />} value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder={`例如 ${DEFAULT_AGENT_URL}`} />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                <KeyRound className="size-3.5" />
                                连接 Token
                                <span className="font-normal opacity-70">Connect token</span>
                            </span>
                            <Input.Password size="large" prefix={<KeyRound className="mr-1 size-4" style={{ color: theme.node.faint }} />} value={token} onChange={(event) => onTokenChange(event.target.value)} placeholder="自动发现，或手动填入 Connect token" />
                        </label>
                        {connectError ? (
                            <div className="rounded-md border px-2.5 py-2 text-xs leading-5" style={{ borderColor: "rgba(220,38,38,.35)", color: "#dc2626" }}>
                                {connectError}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex items-center justify-between gap-2">
                        <div>
                            <div className="text-sm font-medium leading-5">本地运行时</div>
                            <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                扫描 PATH 中的 Codex CLI、Cursor Agent、Claude Code；默认保留 Codex 画布 MCP 模式。
                            </div>
                        </div>
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loadingRuntimes} onClick={onRescanRuntimes}>
                            重新扫描
                        </Button>
                    </div>
                    <div className="mt-3 space-y-2">
                        {runtimes.length ? (
                            runtimes.map((runtime) => (
                                <div key={runtime.id} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2" style={{ borderColor: runtime.id === selectedRuntimeId ? theme.node.activeStroke : theme.node.stroke }}>
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium">{runtime.name}</div>
                                        <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                            {runtime.available ? [runtime.path, runtime.version].filter(Boolean).join(" · ") || "可用" : "未检测到"}
                                            {runtime.authStatus === "missing" ? ` · ${runtime.authMessage || "未登录"}` : ""}
                                            {runtime.supportsMcp ? " · 支持画布 MCP" : ""}
                                        </div>
                                    </div>
                                    <Button size="small" type={runtime.id === selectedRuntimeId ? "primary" : "default"} disabled={!runtime.available} onClick={() => onRuntimeChange(runtime.id)}>
                                        {runtime.id === selectedRuntimeId ? "当前" : "使用"}
                                    </Button>
                                </div>
                            ))
                        ) : (
                            <div className="text-xs leading-5" style={{ color: theme.node.muted }}>需先启动 Canvas Agent，再点击重新扫描检测本机 CLI。</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function AgentHistoryView({ theme, threads, activeThreadId, workspacePath, loading, connected, onRefresh, onNewThread, onResumeThread, onDeleteThread }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; threads: AgentThreadSummary[]; activeThreadId: string; workspacePath: string; loading: boolean; connected: boolean; onRefresh: () => void; onNewThread: () => void; onResumeThread: (threadId: string) => void; onDeleteThread: (thread: AgentThreadSummary) => void }) {
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
            <div className="space-y-3">
                <div className="flex min-w-0 items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                    <FolderOpen className="size-3.5 shrink-0" />
                    <span className="shrink-0">工作空间</span>
                    <span className="min-w-0 truncate" title={workspacePath}>{workspacePath || "默认画布目录"}</span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm" style={{ color: theme.node.muted }}>
                        {threads.length ? `${threads.length} 条历史` : connected ? "暂无历史" : "未连接"}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button size="small" icon={<RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />} disabled={!connected || loading} onClick={onRefresh}>
                            刷新
                        </Button>
                        <Button size="small" type="primary" icon={<Plus className="size-3.5" />} disabled={!connected || loading} onClick={onNewThread}>
                            新对话
                        </Button>
                    </div>
                </div>
                <div className="space-y-2">
                    {threads.map((thread) => {
                        const active = thread.id === activeThreadId;
                        return (
                            <div key={thread.id} className="rounded-lg border px-2.5 py-1.5 transition" style={{ borderColor: active ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}>
                                <div className="flex items-center gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {active ? <span className="shrink-0 text-[10px] font-medium" style={{ color: theme.node.text }}>当前</span> : null}
                                            <div className="truncate text-sm font-medium leading-5">{thread.name || thread.preview || "未命名对话"}</div>
                                        </div>
                                        <div className="truncate text-[11px] leading-4 opacity-65">{thread.preview || thread.id}</div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        <span className="text-[10px] opacity-55">{formatThreadTime(thread.updatedAt || thread.createdAt)}</span>
                                        <Button size="small" className="!h-6 !px-2" disabled={loading} onClick={() => onResumeThread(thread.id)}>
                                            进入
                                        </Button>
                                        <Tooltip title="删除记录">
                                            <Button size="small" danger type="text" className="!h-6 !w-6 !min-w-6" disabled={loading} icon={<Trash2 className="size-3.5" />} onClick={() => onDeleteThread(thread)} />
                                        </Tooltip>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    {!threads.length ? (
                        <div className="px-3 py-8 text-center text-sm" style={{ color: theme.node.muted }}>
                            {connected ? "当前工作空间还没有对话记录" : "连接本地 Agent 后显示历史记录"}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

async function postState(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot) {
    try {
        await fetch(`${endpoint}/canvas/state?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(snapshot) });
    } catch {}
}

async function postToolResult(endpoint: string, token: string, clientId: string, body: { requestId: string; result?: unknown; error?: string }) {
    await fetch(`${endpoint}/canvas/result?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function agentMessageToChatMessage(item: AgentChatItem) {
    return { ...item, attachments: item.attachments?.map(agentAttachmentToChatAttachment) };
}

function agentAttachmentToChatAttachment(item: AgentAttachment): CanvasAgentChatAttachment {
    return { id: item.id, name: item.name, url: item.dataUrl || item.url };
}

function formatAgentEvent(event: AgentEventPayload, runtimes: AgentRuntimeOption[]): Omit<AgentChatItem, "id"> | null {
    const item = event.item;
    const title = runtimeTitle(event.agent, runtimes);
    if (event.type === "item.completed" && item?.type === "error") return { role: "error", title: "错误", text: normalizeText(item.message), detail: item };
    if ((event.type === "item.updated" || event.type === "item.completed") && item?.type === "agent_message") return { role: "assistant", title, text: stringText(item.text), meta: usageText(event), streamId: item.id };
    if (event.type === "item.completed" && isMcpToolItem(item) && isReadTool(String(item?.tool || ""))) return { role: "tool", title: `${toolName(String(item?.tool || ""))}完成`, text: item?.error?.message || toolSummary(item), detail: toolDetail(item) };
    const text = eventText(event);
    if (text) return { role: "assistant", title, text, meta: usageText(event) };
    return null;
}

function runtimeTitle(agent: string | undefined, runtimes: AgentRuntimeOption[]) {
    if (!agent) return "Codex";
    return runtimes.find((item) => item.id === agent)?.name || agent;
}

function parseEventData<T>(event: Event) {
    try {
        return JSON.parse((event as MessageEvent).data) as T;
    } catch {
        return null;
    }
}

function formatLogText(logs: AgentEventLog[], context: AgentLogContext) {
    const head = [
        "Infinite Canvas Agent 诊断日志",
        `Canvas Agent: ${context.endpoint}`,
        `连接: ${context.connected ? "在线" : context.enabled ? "连接中" : "未启用"}`,
        `状态: ${context.activity}`,
        `waiting: ${context.waiting}`,
        `sending: ${context.sending}`,
        `messages: ${context.messages}`,
        `pendingTool: ${context.pendingTool ? toolName(context.pendingTool) : "none"}`,
        `logs: ${logs.length}`,
    ].join("\n");
    const body = logs.map((item, index) => {
        const detail = item.raw == null ? item.text : JSON.stringify(item.raw, null, 2);
        return [`#${index + 1} ${item.time} ${item.title}`, detail].filter(Boolean).join("\n");
    }).join("\n\n---\n\n");
    return [head, body || "暂无事件日志"].join("\n\n");
}

function formatLogJson(logs: AgentEventLog[], context: AgentLogContext) {
    return JSON.stringify({ context, logs: logs.map(({ time, title, text, raw }) => ({ time, title, text, raw })) }, null, 2);
}

function eventText(event: AgentEventPayload) {
    return event.type === "item.completed" && event.item?.type === "agent_message" ? stringText(event.item.text) : "";
}

function usageText(event: AgentEventPayload) {
    const usage = event.usage;
    if (!usage || typeof usage !== "object") return undefined;
    const total = numberField(usage, "total_tokens");
    const input = numberField(usage, "input_tokens");
    const output = numberField(usage, "output_tokens");
    if (total) return `${total} tok`;
    if (input || output) return `${input || 0}/${output || 0} tok`;
    return undefined;
}

function activityText(event: AgentEventPayload) {
    const name = event.type || "";
    if (name === "thread.started") return "已创建会话";
    if (name === "turn.started") return "思考中";
    if (name === "turn.completed") return "完成";
    if (name === "turn.failed" || name === "error") return "出错";
    if (name === "item.started") return isMcpToolItem(event.item) ? `调用${toolName(String(event.item?.tool || ""))}` : "执行步骤";
    if (name === "item.completed") return isMcpToolItem(event.item) ? "工具完成" : "更新消息";
    return "";
}

function eventTitle(event: AgentEventPayload) {
    const item = event.item;
    if (event.type === "thread.started") return "已创建 Codex 会话";
    if (event.type === "turn.started") return "开始处理";
    if (event.type === "turn.completed") return "本轮完成";
    if (event.type === "stream.summary") return "流式摘要";
    if (event.type === "turn.failed" || event.type === "error") return "本轮失败";
    if (event.type === "item.started" && isMcpToolItem(item)) return `调用工具：${toolName(String(item?.tool || ""))}`;
    if (event.type === "item.completed" && isMcpToolItem(item)) return `工具完成：${toolName(String(item?.tool || ""))}`;
    if (event.type === "item.completed" && item?.type === "agent_message") return "Codex 回复";
    return event.type || "Codex 事件";
}

function shouldLogAgentEvent(event: AgentEventPayload) {
    const itemType = event.item?.type || "";
    return !["item.updated"].includes(event.type || "") && !["reasoning"].includes(itemType) && !(event.type === "item.started" && itemType === "agent_message");
}

function isConnectionErrorMessage(item: AgentChatItem) {
    return item.role === "error" && /连接失败|无法连接本地 Agent|本地 Agent 连接失败/.test(item.text);
}

function toolName(name: string) {
    if (name === "canvas_apply_ops") return "画布操作";
    if (name === "canvas_get_state") return "读取画布";
    if (name === "canvas_get_selection") return "读取选区";
    if (name === "canvas_export_snapshot") return "导出快照";
    if (name === "canvas_create_node") return "创建节点";
    if (name === "canvas_create_text_node") return "创建文本";
    if (name === "canvas_create_text_nodes") return "批量创建文本";
    if (name === "canvas_create_config_node") return "创建生成配置";
    if (name === "canvas_create_image_prompt_flow") return "创建生图流程";
    if (name === "canvas_create_generation_flow") return "创建生成流程";
    if (name === "canvas_generate_text") return "生成文本";
    if (name === "canvas_generate_image") return "生成图片";
    if (name === "canvas_generate_video") return "生成视频";
    if (name === "canvas_generate_audio") return "生成音频";
    if (name === "canvas_update_node") return "更新节点";
    if (name === "canvas_update_node_text") return "更新文本";
    if (name === "canvas_move_nodes") return "移动节点";
    if (name === "canvas_resize_node") return "调整节点尺寸";
    if (name === "canvas_delete_nodes") return "删除节点";
    if (name === "canvas_connect_nodes") return "连接节点";
    if (name === "canvas_select_nodes") return "选择节点";
    if (name === "canvas_set_viewport") return "调整视口";
    if (name === "canvas_run_generation") return "触发生成";
    return name;
}

function isReadTool(name: string) {
    return name === "canvas_get_state" || name === "canvas_get_selection" || name === "canvas_export_snapshot";
}

function isMcpToolItem(item?: AgentEventItem) {
    return item?.type === "mcp_tool_call";
}

function toolDetail(item?: AgentEventItem) {
    return { server: item?.server, tool: item?.tool, status: item?.status, arguments: item?.arguments, result: parseToolResult(item?.result), error: item?.error };
}

function toolSummary(item?: AgentEventItem) {
    const result = parseToolResult(item?.result);
    const nodeField = objectField(result, "nodes");
    const connectionField = objectField(result, "connections");
    const nodes = Array.isArray(nodeField) ? nodeField : [];
    const connections = Array.isArray(connectionField) ? connectionField : [];
    if (Array.isArray(nodeField) || Array.isArray(connectionField)) return `读取到 ${nodes.length} 个节点，${connections.length} 条连线`;
    return "工具调用完成";
}

function parseToolResult(result: unknown) {
    const content = objectField(result, "content");
    const text = Array.isArray(content) ? content.map((item) => objectField(item, "text")).filter((item): item is string => typeof item === "string").join("\n") : "";
    try {
        return text ? JSON.parse(text) : result;
    } catch {
        return text || result;
    }
}

function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return JSON.stringify(value, null, 2);
}

function stringText(value: unknown) {
    return typeof value === "string" ? value : "";
}

function objectField(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function numberField(value: unknown, key: string) {
    const field = objectField(value, key);
    return typeof field === "number" ? field : 0;
}

function mergeAgentText(prev: string, next: string) {
    if (!next || prev === next || prev.endsWith(next)) return prev;
    if (next.startsWith(prev)) return next;
    for (let size = Math.min(prev.length, next.length); size > 0; size--) {
        if (prev.endsWith(next.slice(0, size))) return `${prev}${next.slice(size)}`;
    }
    const half = Math.floor(prev.length / 2);
    if (prev.length > 12 && next.length > 12 && prev.slice(half) === next.slice(0, prev.length - half)) return prev;
    return `${prev}${next}`;
}

function promptWithAttachments(text: string, attachments: AgentAttachment[]) {
    if (!attachments.length) return text;
    const names = attachments.map((item) => item.name).join("、");
    return [text, `用户上传了 ${attachments.length} 张图片附件：${names}。`].filter(Boolean).join("\n\n");
}

function attachmentPayloadBytes(attachments: AgentAttachment[]) {
    return attachments.reduce((total, item) => total + item.dataUrl.length, 0);
}

function formatBytes(bytes: number) {
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`;
}

async function fetchAgentJson<T>(endpoint: string, token: string, path: string, init?: RequestInit) {
    const url = `${endpoint}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; msg?: string };
    if (!res.ok) throw new Error(data.error || data.msg || "本地 Agent 请求失败");
    return data;
}

function normalizeHistoryMessages(messages: AgentChatItem[]) {
    return messages
        .map((item, index) => ({
            ...item,
            id: item.id || `history-${index}`,
            text: normalizeText(item.text),
        }))
        .filter((item) => item.text);
}

function formatThreadTime(value?: number) {
    if (!value) return "";
    return new Date(value * 1000).toLocaleString();
}

function createId() {
    return typeof crypto === "undefined" ? `${Date.now()}-${Math.random()}` : crypto.randomUUID();
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function readDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
        reader.readAsDataURL(file);
    });
}
