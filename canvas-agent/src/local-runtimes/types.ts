export type RuntimeModelOption = { id: string; label: string };

export type RuntimeAgentDef = {
    id: string;
    name: string;
    bin: string;
    versionArgs: string[];
    helpArgs?: string[];
    capabilityFlags?: Record<string, string>;
    listModels?: { args: string[]; timeoutMs?: number; parse: (stdout: string) => RuntimeModelOption[] | null };
    authProbe?: { args: string[]; timeoutMs?: number };
    fallbackModels: RuntimeModelOption[];
    buildArgs: (options: { model?: string; cwd?: string; trust?: boolean; workflow?: boolean }) => string[];
    promptViaStdin: boolean;
    eventParser: string;
    binEnvKey?: string;
};

export type DetectedRuntime = {
    id: string;
    name: string;
    available: boolean;
    path?: string;
    version?: string | null;
    models: RuntimeModelOption[];
    authStatus?: "ok" | "missing" | "unknown";
    authMessage?: string;
    supportsMcp?: boolean;
    supportsThreads?: boolean;
};
