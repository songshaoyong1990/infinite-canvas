type JsonObject = Record<string, unknown>;
type StreamEvent = Record<string, unknown>;
type StreamEventHandler = (event: StreamEvent) => void;

type ParserState = {
    cursorTextSoFar: string;
    cursorTurnStart: number;
    codexToolUses: Set<string>;
    codexErrorEmitted: boolean;
    codexPreviousEventWasAgentMessage: boolean;
    codexLastAgentMessageEndedWithNewline: boolean;
};

function isRecord(value: unknown): value is JsonObject {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function extractErrorMessage(value: unknown, fallback: string): string {
    if (typeof value === "string") return value;
    if (isRecord(value)) {
        if (typeof value.message === "string" && value.message) return value.message;
        if (typeof value.error === "string" && value.error) return value.error;
    }
    return fallback;
}

function extractCursorText(message: unknown): string {
    const content = isRecord(message) ? message.content : undefined;
    const blocks = Array.isArray(content) ? content : [];
    return blocks
        .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
}

function emitCursorTextDelta(text: string, onEvent: StreamEventHandler, state: ParserState) {
    if (!text) return;
    state.cursorTextSoFar += text;
    onEvent({ type: "text_delta", delta: text });
}

function reconcileCursorTurnReplay(text: string, onEvent: StreamEventHandler, state: ParserState) {
    const emittedTurn = state.cursorTextSoFar.slice(state.cursorTurnStart);
    if (text && text !== emittedTurn && text.startsWith(emittedTurn)) {
        const suffix = text.slice(emittedTurn.length);
        if (suffix) onEvent({ type: "text_delta", delta: suffix });
        state.cursorTextSoFar += suffix;
    }
    state.cursorTurnStart = state.cursorTextSoFar.length;
}

function handleCursorEvent(obj: unknown, onEvent: StreamEventHandler, state: ParserState): boolean {
    if (!isRecord(obj)) return false;
    if (obj.type === "system" && obj.subtype === "init") {
        onEvent({ type: "status", label: "initializing" });
        return true;
    }
    if (obj.type === "assistant" && obj.message) {
        if (typeof obj.model_call_id === "string") {
            reconcileCursorTurnReplay(extractCursorText(obj.message), onEvent, state);
            return true;
        }
        const text = extractCursorText(obj.message);
        if (!text) return false;
        if (typeof obj.timestamp_ms === "number") {
            emitCursorTextDelta(text, onEvent, state);
            return true;
        }
        reconcileCursorTurnReplay(text, onEvent, state);
        return true;
    }
    if (obj.type === "result" && isRecord(obj.usage)) {
        onEvent({
            type: "usage",
            usage: {
                input_tokens: typeof obj.usage.inputTokens === "number" ? obj.usage.inputTokens : undefined,
                output_tokens: typeof obj.usage.outputTokens === "number" ? obj.usage.outputTokens : undefined,
            },
        });
        return true;
    }
    return false;
}

function handleCodexEvent(obj: unknown, onEvent: StreamEventHandler, state: ParserState): boolean {
    if (!isRecord(obj)) return false;
    if (obj.type === "error" || obj.type === "turn.failed") {
        if (!state.codexErrorEmitted) {
            state.codexErrorEmitted = true;
            onEvent({ type: "error", message: extractErrorMessage(obj.error ?? obj.message, "Codex turn failed") });
        }
        return true;
    }
    if (obj.type === "thread.started") {
        onEvent({ type: "status", label: "initializing" });
        return true;
    }
    if (obj.type === "turn.started") {
        state.codexPreviousEventWasAgentMessage = false;
        state.codexLastAgentMessageEndedWithNewline = false;
        onEvent({ type: "status", label: "thinking" });
        return true;
    }
    if (obj.type === "item.completed" && isRecord(obj.item) && obj.item.type === "agent_message" && typeof obj.item.text === "string") {
        const text = obj.item.text;
        const needsBoundary = state.codexPreviousEventWasAgentMessage && !state.codexLastAgentMessageEndedWithNewline && !text.startsWith("\n");
        onEvent({ type: "text_delta", delta: needsBoundary ? `\n${text}` : text });
        state.codexPreviousEventWasAgentMessage = true;
        state.codexLastAgentMessageEndedWithNewline = text.endsWith("\n");
        return true;
    }
    if (obj.type === "turn.completed" && isRecord(obj.usage)) {
        onEvent({
            type: "usage",
            usage: {
                input_tokens: typeof obj.usage.input_tokens === "number" ? obj.usage.input_tokens : undefined,
                output_tokens: typeof obj.usage.output_tokens === "number" ? obj.usage.output_tokens : undefined,
            },
        });
        return true;
    }
    return false;
}

export function createJsonEventStreamHandler(kind: string, onEvent: StreamEventHandler) {
    let buffer = "";
    const state: ParserState = {
        cursorTextSoFar: "",
        cursorTurnStart: 0,
        codexToolUses: new Set<string>(),
        codexErrorEmitted: false,
        codexPreviousEventWasAgentMessage: false,
        codexLastAgentMessageEndedWithNewline: false,
    };

    function handleLine(line: string) {
        let obj: unknown;
        try {
            obj = JSON.parse(line);
        } catch {
            onEvent({ type: "raw", line });
            return;
        }
        if (kind === "cursor-agent" && handleCursorEvent(obj, onEvent, state)) return;
        if (kind === "codex" && handleCodexEvent(obj, onEvent, state)) return;
        onEvent({ type: "raw", line });
    }

    return {
        feed(chunk: string) {
            buffer += chunk;
            let nl = buffer.indexOf("\n");
            while (nl !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line) handleLine(line);
                nl = buffer.indexOf("\n");
            }
        },
        flush() {
            const rem = buffer.trim();
            buffer = "";
            if (rem) handleLine(rem);
        },
    };
}
