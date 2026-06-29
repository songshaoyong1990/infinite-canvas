import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter } from "node:path";
import path from "node:path";
import { homedir } from "node:os";

const BIN_ENV_KEYS: Record<string, string> = {
    codex: "CODEX_BIN",
    "cursor-agent": "CURSOR_AGENT_BIN",
    claude: "CLAUDE_BIN",
};

function toolchainDirs() {
    const home = homedir();
    const dirs = [
        path.join(home, ".local", "bin"),
        path.join(home, ".bun", "bin"),
        path.join(home, ".cargo", "bin"),
        path.join(home, "AppData", "Local", "Programs", "cursor", "resources", "app", "bin"),
        path.join(home, ".cursor", "bin"),
    ];
    if (process.platform === "win32") {
        dirs.push(path.join(home, "AppData", "Roaming", "npm"));
        dirs.push(path.join(home, "scoop", "shims"));
        const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
        dirs.push(path.join(localAppData, "cursor-agent"));
    }
    return dirs;
}

function pathDirs() {
    const seen = new Set<string>();
    return [...(process.env.PATH || "").split(delimiter), ...toolchainDirs()].filter((dir) => {
        if (!dir || seen.has(dir)) return false;
        seen.add(dir);
        return true;
    });
}

export function resolveOnPath(bin: string): string | null {
    const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
    for (const dir of pathDirs()) {
        for (const ext of exts) {
            const full = path.join(dir, bin + ext);
            if (existsSync(full)) return full;
        }
    }
    return null;
}

function executableFile(raw: string | undefined): string | null {
    if (!raw?.trim()) return null;
    const expanded = raw.trim().replace(/^~(?=$|[\\/])/, homedir()).replace(/^~([\\/])/, `${homedir()}$1`);
    if (!path.isAbsolute(expanded)) return null;
    try {
        if (!statSync(expanded).isFile()) return null;
        if (process.platform !== "win32") accessSync(expanded, constants.X_OK);
        return expanded;
    } catch {
        return null;
    }
}

export function resolveAgentBinary(def: { id: string; bin: string; binEnvKey?: string }) {
    const envKey = def.binEnvKey || BIN_ENV_KEYS[def.id];
    const configured = envKey ? executableFile(process.env[envKey]) : null;
    if (configured) return configured;
    return resolveOnPath(def.bin);
}
