"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { Cpu } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { loadAgentRuntimes } from "@/lib/canvas-agent-api";
import { buildLocalAgentModelOptions, isLocalAgentModel, localAgentModelLabel } from "@/lib/local-agent-model";
import { cn } from "@/lib/utils";
import { modelOptionLabel, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useCanvasAgentStore } from "../stores/use-canvas-agent-store";

type CanvasGenerationModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function CanvasGenerationModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder = "选择模型", onMissingConfig }: CanvasGenerationModelPickerProps) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const runtimes = useCanvasAgentStore((state) => state.runtimes);
    const loadingRuntimes = useCanvasAgentStore((state) => state.loadingRuntimes);
    const localOptions = useMemo(() => (capability === "text" ? buildLocalAgentModelOptions(runtimes) : []), [capability, runtimes]);
    const apiOptions = useMemo(() => Array.from(new Set(selectableModelsByCapability(config, capability).filter((model): model is string => Boolean(model)))), [capability, config]);
    const current = value || "";
    const options = useMemo(() => {
        const values = [...localOptions.map((item) => item.value), ...apiOptions];
        if (current && !values.includes(current)) values.unshift(current);
        return values;
    }, [apiOptions, current, localOptions]);

    useEffect(() => {
        if (capability !== "text") return;
        if (runtimes.length || loadingRuntimes) return;
        void loadAgentRuntimes();
    }, [capability, loadingRuntimes, runtimes.length]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    const currentLabel = current ? (isLocalAgentModel(current) ? localAgentModelLabel(current, runtimes) : modelOptionLabel(config, current)) : placeholder;

    return (
        <Select
            open={open}
            value={current}
            onOpenChange={(nextOpen) => {
                if (nextOpen && !options.length && !localOptions.length) onMissingConfig?.();
                if (nextOpen) {
                    void loadAgentRuntimes();
                    window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                }
                setOpen(nextOpen);
            }}
            onValueChange={onChange}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={currentLabel}
            >
                <ModelIcon model={current} local={isLocalAgentModel(current)} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{currentLabel}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {localOptions.length ? (
                    <>
                        <div className="px-2 py-1 text-[11px] opacity-60">本地 Agent</div>
                        {localOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value} textValue={option.label}>
                                <span className="flex min-w-0 items-center gap-2">
                                    <Cpu className="size-4 shrink-0 opacity-70" />
                                    <span className="truncate">{option.label}</span>
                                </span>
                            </SelectItem>
                        ))}
                        {apiOptions.length ? <div className="px-2 py-1 text-[11px] opacity-60">在线渠道</div> : null}
                    </>
                ) : null}
                {apiOptions.length ? (
                    apiOptions.map((model) => (
                        <SelectItem key={model} value={model} textValue={modelOptionLabel(config, model)}>
                            <span className="flex min-w-0 items-center gap-2">
                                <ModelIcon model={model} />
                                <span className="truncate">{modelOptionLabel(config, model)}</span>
                            </span>
                        </SelectItem>
                    ))
                ) : !localOptions.length ? (
                    <SelectItem value="__empty__" disabled>
                        {capability === "text" ? "请配置在线模型，或启动 canvas-agent 扫描本地 Agent" : "请先到配置里添加渠道和模型"}
                    </SelectItem>
                ) : null}
            </SelectContent>
        </Select>
    );
}

function ModelIcon({ model, local }: { model: string; local?: boolean }) {
    if (local) return <Cpu className="size-4 shrink-0 opacity-70" />;
    const icon = resolveModelIcon(model);
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm")) return "/icons/glm.svg";
    return "";
}
