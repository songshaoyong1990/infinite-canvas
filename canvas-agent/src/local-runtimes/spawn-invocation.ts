import path from "node:path";

export type CommandInvocation = {
    command: string;
    args: string[];
    windowsVerbatimArguments?: boolean;
};

function quoteWindowsArg(value: string) {
    if (!/[\s"]/u.test(value)) return value;
    return `"${value.replace(/"/g, '""')}"`;
}

export function createCommandInvocation({ command, args, env = process.env }: { command: string; args: string[]; env?: NodeJS.ProcessEnv }): CommandInvocation {
    if (process.platform === "win32" && /\.(bat|cmd)$/i.test(command)) {
        const comspec = env.ComSpec || process.env.ComSpec || "cmd.exe";
        const inner = [command, ...args].map(quoteWindowsArg).join(" ");
        return {
            command: comspec,
            args: ["/d", "/s", "/c", inner],
            windowsVerbatimArguments: true,
        };
    }
    const ext = path.extname(command).toLowerCase();
    if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
        return { command: process.execPath, args: [command, ...args] };
    }
    return { command, args };
}
