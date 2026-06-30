import { spawn, type ChildProcess } from "node:child_process";

import { getLocalRuntimeDef } from "./defs.js";
import { createJsonEventStreamHandler } from "./json-event-stream.js";
import { prependLaunchPath, resolveLaunchPath } from "./launch.js";
import { createCommandInvocation } from "./spawn-invocation.js";
import { consumeCancel, isTurnCancelled, trackLocalChild } from "../active-turn.js";
import { beginWorkflowTurn, endWorkflowTurn } from "../workflow-turn.js";
import type { DetectedRuntime } from "./types.js";
import type { AgentEmit } from "../types.js";

type LocalTurnOptions = {
    agentId: string;
    prompt: string;
    cwd?: string;
    model?: string;
    workflow?: boolean;
    workflowTurnId?: string;
};

class StreamBridge {
    private streamId = `local-${Date.now()}`;
    private text = "";
    private started = false;
    private done = false;

    constructor(private emit: AgentEmit, private agent: string) {}

    cancel() {
        this.done = true;
    }

    handle(event: Record<string, unknown>) {
        if (this.done || isTurnCancelled()) return;
        if (event.type === "status" && (event.label === "thinking" || event.label === "initializing")) {
            if (!this.started) {
                this.started = true;
                this.emit("agent_event", { agent: this.agent, type: "turn.started" });
            }
            return;
        }
        if (event.type === "text_delta" && typeof event.delta === "string") {
            if (!this.started) {
                this.started = true;
                this.emit("agent_event", { agent: this.agent, type: "turn.started" });
            }
            this.text += event.delta;
            this.emit("agent_event", {
                agent: this.agent,
                type: "item.updated",
                item: { id: this.streamId, type: "agent_message", text: this.text },
            });
            return;
        }
        if (event.type === "usage") {
            this.finish(event.usage);
            return;
        }
        if (event.type === "error") {
            this.done = true;
            this.emit("agent_error", { message: String(event.message || "Agent error") });
            this.emit("agent_event", { agent: this.agent, type: "turn.failed" });
            this.emit("agent_done", { agent: this.agent, code: 1 });
        }
    }

    finish(usage?: unknown) {
        if (this.done) return;
        this.done = true;
        if (this.text) {
            this.emit("agent_event", {
                agent: this.agent,
                type: "item.completed",
                item: { id: this.streamId, type: "agent_message", text: this.text },
            });
        }
        this.emit("agent_event", { agent: this.agent, type: "turn.completed", usage: usage || null });
        this.emit("agent_done", { agent: this.agent, usage: usage || null });
    }
}

function pipeClaudeJson(child: ChildProcess, emit: AgentEmit, agent: string) {
    let out = "";
    child.stdout?.on("data", (chunk) => {
        if (isTurnCancelled()) return;
        out += chunk.toString();
        const lines = out.split(/\r?\n/);
        out = lines.pop() || "";
        lines.filter(Boolean).forEach((line) => {
            try {
                emit("agent_event", { agent, ...JSON.parse(line) });
            } catch {
                emit("agent_log", { text: line });
            }
        });
    });
    child.stderr?.on("data", (chunk) => emit("agent_log", { text: chunk.toString() }));
    child.on("error", (error) => emit("agent_error", { message: error.message }));
    child.on("close", (code) => {
        if (consumeCancel()) {
            emit("agent_event", { agent, type: "turn.failed", cancelled: true });
            emit("agent_done", { agent, cancelled: true });
            return;
        }
        emit("agent_done", { agent, code });
    });
}

export function runLocalRuntimeTurn(options: LocalTurnOptions, emit: AgentEmit) {
    const def = getLocalRuntimeDef(options.agentId);
    if (!def) {
        emit("agent_error", { message: `未知本地运行时：${options.agentId}` });
        emit("agent_done", { agent: options.agentId, code: 1 });
        return;
    }
    if (options.workflowTurnId) beginWorkflowTurn(options.workflowTurnId);
    const finishWorkflow = () => {
        if (options.workflowTurnId) endWorkflowTurn(options.workflowTurnId);
    };
    const launch = resolveLaunchPath(def);
    if (!launch?.launchPath) {
        finishWorkflow();
        emit("agent_error", { message: `${def.name} 未安装或不在 PATH 中` });
        emit("agent_done", { agent: options.agentId, code: 1 });
        return;
    }

    const env = prependLaunchPath({ ...process.env }, launch.childPathPrepend);
    const args =
        def.id === "claude"
            ? [...def.buildArgs({ model: options.model, cwd: options.cwd, workflow: options.workflow }), options.prompt]
            : def.buildArgs({ model: options.model, cwd: options.cwd, trust: true, workflow: options.workflow });
    const cwd = options.cwd || process.cwd();
    const invocation = createCommandInvocation({ command: launch.launchPath, args, env });
    let child: ChildProcess;
    try {
        child = spawn(invocation.command, invocation.args, {
            cwd,
            env,
            stdio: [def.promptViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });
    } catch (error) {
        finishWorkflow();
        const message = error instanceof Error ? error.message : "启动本地 CLI 失败";
        emit("agent_error", { message });
        emit("agent_done", { agent: options.agentId, code: 1 });
        return;
    }
    trackLocalChild(child);

    if (def.id === "claude") {
        pipeClaudeJson(child, emit, def.id);
        child.on("close", () => finishWorkflow());
        return;
    }

    const bridge = new StreamBridge(emit, def.id);
    const handler = createJsonEventStreamHandler(def.eventParser, (event) => bridge.handle(event));
    child.stdout?.on("data", (chunk) => {
        if (isTurnCancelled()) return;
        handler.feed(chunk.toString());
    });
    child.stderr?.on("data", (chunk) => emit("agent_log", { text: chunk.toString() }));
    child.on("error", (error) => {
        finishWorkflow();
        emit("agent_error", { message: error.message });
        emit("agent_done", { agent: def.id, code: 1 });
    });
    child.on("close", (code) => {
        finishWorkflow();
        if (consumeCancel()) {
            bridge.cancel();
            emit("agent_event", { agent: def.id, type: "turn.failed", cancelled: true });
            emit("agent_done", { agent: def.id, cancelled: true });
            return;
        }
        handler.flush();
        if (code && code !== 0) {
            emit("agent_error", { message: `${def.name} 退出码 ${code}` });
            emit("agent_event", { agent: def.id, type: "turn.failed" });
            emit("agent_done", { agent: def.id, code });
            return;
        }
        bridge.finish();
    });

    if (def.promptViaStdin && child.stdin) {
        child.stdin.write(options.prompt);
        child.stdin.end();
    }
}

export type { DetectedRuntime };
