import { spawn, type ChildProcess } from "node:child_process";

let localChild: ChildProcess | null = null;
let claudeChild: ChildProcess | null = null;
let codexCancel: (() => void) | null = null;
let cancelling = false;

function detachChild(child: ChildProcess | null, current: ChildProcess | null) {
    if (child && current === child) return null;
    return current;
}

function killChild(child: ChildProcess | null) {
    if (!child || child.killed) return;
    const pid = child.pid;
    if (process.platform === "win32" && pid) {
        try {
            spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } catch {}
        return;
    }
    try {
        child.kill("SIGKILL");
    } catch {}
}

export function isTurnCancelled() {
    return cancelling;
}

export function trackLocalChild(child: ChildProcess) {
    killChild(localChild);
    localChild = child;
    child.once("close", () => {
        localChild = detachChild(child, localChild);
    });
}

export function trackClaudeChild(child: ChildProcess) {
    killChild(claudeChild);
    claudeChild = child;
    child.once("close", () => {
        claudeChild = detachChild(child, claudeChild);
    });
}

export function trackCodexCancel(cancel: () => void) {
    codexCancel = cancel;
}

export function clearCodexCancel() {
    codexCancel = null;
}

export function isAgentTurnActive() {
    return Boolean(localChild || claudeChild || codexCancel);
}

export function consumeCancel() {
    const value = cancelling;
    cancelling = false;
    return value;
}

export function cancelActiveAgentTurn() {
    if (!isAgentTurnActive()) return false;
    let cancelled = false;
    if (localChild) {
        cancelling = true;
        killChild(localChild);
        localChild = null;
        cancelled = true;
    }
    if (claudeChild) {
        cancelling = true;
        killChild(claudeChild);
        claudeChild = null;
        cancelled = true;
    }
    if (codexCancel) {
        const cancel = codexCancel;
        codexCancel = null;
        cancel();
        cancelled = true;
    }
    return cancelled;
}
