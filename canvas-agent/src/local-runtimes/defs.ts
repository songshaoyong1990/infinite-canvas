import { getAgentCapabilities } from "./capabilities.js";
import type { RuntimeAgentDef, RuntimeModelOption } from "./types.js";

export const DEFAULT_MODEL_OPTION: RuntimeModelOption = { id: "default", label: "Default" };

function parseCodexDebugModels(stdout: string): RuntimeModelOption[] | null {
    try {
        const parsed = JSON.parse(stdout) as { models?: Array<{ slug?: string; id?: string; display_name?: string; name?: string; visibility?: string }> };
        if (!Array.isArray(parsed.models)) return null;
        const out = [DEFAULT_MODEL_OPTION];
        const seen = new Set([DEFAULT_MODEL_OPTION.id]);
        for (const entry of parsed.models) {
            if (entry.visibility === "hidden") continue;
            const id = (entry.slug || entry.id || "").trim();
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({ id, label: (entry.display_name || entry.name || id).trim() });
        }
        return out.length > 1 ? out : null;
    } catch {
        return null;
    }
}

function parseCursorAgentModels(stdout: string): RuntimeModelOption[] | null {
    const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    if (!lines.length || /no models available/i.test(stdout)) return null;
    const out = [DEFAULT_MODEL_OPTION];
    const seen = new Set([DEFAULT_MODEL_OPTION.id]);
    for (const line of lines) {
        if (/^(available models|models)$/i.test(line)) continue;
        const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._/:@-]*)(?:\s+-\s+(.+))?$/);
        if (!match) continue;
        const id = match[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, label: match[2]?.trim() || id });
    }
    return out.length > 1 ? out : null;
}

function codexNeedsDangerSandbox() {
    if (process.env.OD_CODEX_SANDBOX?.trim() === "danger-full-access") return true;
    if (process.platform === "win32") return true;
    return Boolean(process.env.WSL_DISTRO_NAME?.trim());
}

export const CODEX_RUNTIME_DEF: RuntimeAgentDef = {
    id: "codex",
    name: "Codex CLI",
    bin: "codex",
    binEnvKey: "CODEX_BIN",
    versionArgs: ["--version"],
    listModels: { args: ["debug", "models"], timeoutMs: 5000, parse: parseCodexDebugModels },
    authProbe: { args: ["login", "status"], timeoutMs: 5000 },
    fallbackModels: [DEFAULT_MODEL_OPTION, { id: "gpt-5.4", label: "gpt-5.4" }, { id: "o4-mini", label: "o4-mini" }],
    promptViaStdin: true,
    eventParser: "codex",
    buildArgs: ({ model, cwd }) => {
        const args = codexNeedsDangerSandbox()
            ? ["exec", "--json", "--skip-git-repo-check", "--sandbox", "danger-full-access"]
            : ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"];
        if (cwd) args.push("-C", cwd);
        if (model && model !== "default") args.push("--model", model);
        return args;
    },
};

export const CURSOR_AGENT_RUNTIME_DEF: RuntimeAgentDef = {
    id: "cursor-agent",
    name: "Cursor Agent",
    bin: "cursor-agent",
    binEnvKey: "CURSOR_AGENT_BIN",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    capabilityFlags: { "--trust": "trust" },
    listModels: {
        args: ["models"],
        timeoutMs: 5000,
        parse: (stdout) => (/no models available/i.test(stdout) ? null : parseCursorAgentModels(stdout)),
    },
    authProbe: { args: ["status"], timeoutMs: 5000 },
    fallbackModels: [DEFAULT_MODEL_OPTION, { id: "auto", label: "auto" }, { id: "sonnet-4", label: "sonnet-4" }],
    promptViaStdin: true,
    eventParser: "cursor-agent",
    buildArgs: ({ model, cwd }) => {
        const caps = getAgentCapabilities("cursor-agent");
        const args = ["--print", "--output-format", "stream-json", "--stream-partial-output", "--force"];
        if (caps.trust) args.push("--trust");
        if (cwd) args.push("--workspace", cwd);
        if (model && model !== "default") args.push("--model", model);
        return args;
    },
};

export const CLAUDE_RUNTIME_DEF: RuntimeAgentDef = {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    binEnvKey: "CLAUDE_BIN",
    versionArgs: ["--version"],
    fallbackModels: [DEFAULT_MODEL_OPTION],
    promptViaStdin: false,
    eventParser: "claude",
    buildArgs: () => ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--allowedTools", "mcp__infinite-canvas__*"],
};

export const LOCAL_RUNTIME_DEFS = [CODEX_RUNTIME_DEF, CURSOR_AGENT_RUNTIME_DEF, CLAUDE_RUNTIME_DEF];

export function getLocalRuntimeDef(id: string) {
    return LOCAL_RUNTIME_DEFS.find((def) => def.id === id) || null;
}
