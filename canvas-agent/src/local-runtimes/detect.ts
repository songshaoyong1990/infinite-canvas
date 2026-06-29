import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { setAgentCapabilities } from "./capabilities.js";
import { LOCAL_RUNTIME_DEFS } from "./defs.js";
import { resolveAgentBinary } from "./executables.js";
import { prependLaunchPath, resolveLaunchPath } from "./launch.js";
import { createCommandInvocation } from "./spawn-invocation.js";
import type { DetectedRuntime, RuntimeAgentDef } from "./types.js";

const execFileAsync = promisify(execFile);

async function execLaunch(launchPath: string, args: string[], env: NodeJS.ProcessEnv, options: { timeout?: number; maxBuffer?: number } = {}) {
    const invocation = createCommandInvocation({ command: launchPath, args, env });
    return execFileAsync(invocation.command, invocation.args, {
        env,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
}

const VIRTUAL_RUNTIMES: DetectedRuntime[] = [
    {
        id: "codex-mcp",
        name: "Codex（画布 MCP）",
        available: true,
        models: [{ id: "default", label: "Default" }],
        supportsMcp: true,
        supportsThreads: true,
    },
];

async function probeVersion(launchPath: string, def: RuntimeAgentDef, env: NodeJS.ProcessEnv) {
    try {
        const { stdout } = await execLaunch(launchPath, def.versionArgs, env, { timeout: 3000 });
        return String(stdout).trim().split("\n")[0] || null;
    } catch {
        return null;
    }
}

async function probeModels(launchPath: string, def: RuntimeAgentDef, env: NodeJS.ProcessEnv) {
    if (!def.listModels) return def.fallbackModels;
    try {
        const { stdout } = await execLaunch(launchPath, def.listModels.args, env, { timeout: def.listModels.timeoutMs ?? 5000, maxBuffer: 8 * 1024 * 1024 });
        return def.listModels.parse(String(stdout)) || def.fallbackModels;
    } catch {
        return def.fallbackModels;
    }
}

async function probeCapabilities(launchPath: string, def: RuntimeAgentDef, env: NodeJS.ProcessEnv) {
    if (!def.helpArgs || !def.capabilityFlags) return;
    try {
        const { stdout } = await execLaunch(launchPath, def.helpArgs, env, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
        const text = String(stdout);
        const caps: Record<string, boolean> = {};
        for (const [flag, key] of Object.entries(def.capabilityFlags)) {
            caps[key] = text.includes(flag);
        }
        setAgentCapabilities(def.id, caps);
    } catch {
        setAgentCapabilities(def.id, {});
    }
}

async function probeAuth(launchPath: string, def: RuntimeAgentDef, env: NodeJS.ProcessEnv) {
    if (!def.authProbe) return { status: "unknown" as const };
    try {
        const { stdout, stderr } = await execLaunch(launchPath, def.authProbe.args, env, { timeout: def.authProbe.timeoutMs ?? 5000 });
        const text = `${stdout}\n${stderr}`;
        if (/not authenticated|authentication required|not logged in|login/i.test(text)) {
            return { status: "missing" as const, message: text.trim().split("\n")[0] || "未登录" };
        }
        return { status: "ok" as const };
    } catch (error) {
        const text = String((error as { stderr?: string; stdout?: string }).stderr || (error as { stdout?: string }).stdout || "");
        if (/not authenticated|authentication required|not logged in|login/i.test(text)) {
            return { status: "missing" as const, message: text.trim().split("\n")[0] || "未登录" };
        }
        return { status: "unknown" as const };
    }
}

async function probeRuntime(def: RuntimeAgentDef): Promise<DetectedRuntime> {
    const launch = resolveLaunchPath(def);
    if (!launch?.launchPath) {
        return { id: def.id, name: def.name, available: false, models: def.fallbackModels, supportsMcp: def.id === "claude", supportsThreads: false };
    }
    const env = prependLaunchPath({ ...process.env }, launch.childPathPrepend);
    const [version, models, auth] = await Promise.all([
        probeVersion(launch.launchPath, def, env),
        probeModels(launch.launchPath, def, env),
        probeAuth(launch.launchPath, def, env),
    ]);
    await probeCapabilities(launch.launchPath, def, env);
    return {
        id: def.id,
        name: def.name,
        available: true,
        path: launch.selectedPath,
        version,
        models,
        authStatus: auth.status,
        ...(auth.message ? { authMessage: auth.message } : {}),
        supportsMcp: def.id === "claude",
        supportsThreads: false,
    };
}

export async function detectLocalRuntimes(): Promise<DetectedRuntime[]> {
    const scanned = await Promise.all(LOCAL_RUNTIME_DEFS.map((def) => probeRuntime(def)));
    const codexMcp = VIRTUAL_RUNTIMES[0];
    const codexCli = scanned.find((item) => item.id === "codex");
    if (codexCli?.available) codexMcp.available = true;
    return [codexMcp, ...scanned];
}

export function isLocalRuntimeAvailable(id: string, runtimes: DetectedRuntime[]) {
    return runtimes.some((item) => item.id === id && item.available);
}

export function resolveRuntimeBinary(id: string) {
    const def = LOCAL_RUNTIME_DEFS.find((item) => item.id === id);
    if (!def) return null;
    return resolveAgentBinary(def);
}
