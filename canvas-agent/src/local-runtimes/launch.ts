import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveAgentBinary } from "./executables.js";
import type { RuntimeAgentDef } from "./types.js";

export function resolveCodexLaunchPath(selectedPath: string) {
    const native = tryResolveCodexNativeBinary(selectedPath);
    return { launchPath: native.path ?? selectedPath, childPathPrepend: native.childPathPrepend };
}

export function resolveLaunchPath(def: RuntimeAgentDef) {
    const selectedPath = resolveAgentBinary(def);
    if (!selectedPath) return null;
    if (def.id !== "codex") return { selectedPath, launchPath: selectedPath, childPathPrepend: [] as string[] };
    const codex = resolveCodexLaunchPath(selectedPath);
    return { selectedPath, ...codex };
}

function tryResolveCodexNativeBinary(wrapperPath: string) {
    const suffix = `${process.platform}-${process.arch}`;
    const triple = codexTargetTriple();
    for (const root of codexSearchRoots(wrapperPath)) {
        const scoped = path.join(root, "node_modules", "@openai");
        const packageDirs = [path.join(scoped, `codex-${suffix}`)];
        try {
            for (const entry of readdirSync(scoped, { withFileTypes: true })) {
                if (entry.isDirectory() && entry.name.startsWith("codex-")) packageDirs.push(path.join(scoped, entry.name));
            }
        } catch {}
        for (const dir of packageDirs) {
            const vendorPathDir = path.join(dir, "vendor", triple, "path");
            const candidates = [
                path.join(dir, "vendor", triple, "codex", process.platform === "win32" ? "codex.exe" : "codex"),
                path.join(dir, "vendor", triple, "codex", "codex"),
                path.join(dir, "codex", process.platform === "win32" ? "codex.exe" : "codex"),
                path.join(dir, "bin", process.platform === "win32" ? "codex.exe" : "codex"),
                path.join(dir, "codex.exe"),
                path.join(dir, "bin", "codex.exe"),
            ];
            for (const candidate of candidates) {
                if (isExecutableFile(candidate)) return { path: candidate, childPathPrepend: [vendorPathDir] };
            }
        }
    }
    return { path: null as string | null, childPathPrepend: [] as string[] };
}

function codexSearchRoots(wrapperPath: string) {
    const roots = new Set<string>();
    for (const seed of [wrapperPath, safeRealpath(wrapperPath)]) {
        if (!seed) continue;
        let current = path.dirname(seed);
        while (current !== path.dirname(current)) {
            roots.add(current);
            current = path.dirname(current);
        }
    }
    return [...roots];
}

function codexTargetTriple() {
    if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
    if (process.platform === "win32" && process.arch === "arm64") return "aarch64-pc-windows-msvc";
    if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
    if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
    if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-musl";
    return `${process.platform}-${process.arch}`;
}

function safeRealpath(filePath: string) {
    try {
        return realpathSync(filePath);
    } catch {
        return null;
    }
}

function isExecutableFile(filePath: string) {
    try {
        if (!statSync(filePath).isFile()) return false;
        if (process.platform !== "win32") accessSync(filePath, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function prependLaunchPath(env: NodeJS.ProcessEnv, dirs: string[]) {
    const nodeBinDir = path.dirname(process.execPath);
    const toPrepend = [...(nodeBinDir ? [nodeBinDir] : []), ...dirs];
    if (!toPrepend.length) return env;
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
    const existing = typeof env[pathKey] === "string" ? (env[pathKey] as string) : "";
    const normalize = (entry: string) => (process.platform === "win32" ? entry.replace(/[/\\]+$/, "").toLowerCase() : entry.replace(/[/\\]+$/, ""));
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const entry of [...toPrepend, ...existing.split(path.delimiter).filter(Boolean)]) {
        const key = normalize(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(entry);
    }
    return { ...env, [pathKey]: merged.join(path.delimiter) };
}
