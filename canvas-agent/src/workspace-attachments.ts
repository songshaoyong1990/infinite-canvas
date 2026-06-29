import fs from "node:fs/promises";
import path from "node:path";

import type { AgentAttachment } from "../types.js";

function imageExt(type = "") {
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    return "jpg";
}

async function writeWorkspaceAttachment(workspacePath: string, item: AgentAttachment, index: number) {
    const [, meta = "", data = ""] = item.dataUrl?.match(/^data:([^;]+);base64,(.+)$/) || [];
    if (!data) throw new Error(`图片附件无效：${item.name || "未命名图片"}`);
    const file = path.join(workspacePath, `workflow-ref-${index + 1}.${imageExt(meta || item.type)}`);
    await fs.writeFile(file, Buffer.from(data, "base64"));
    return file;
}

export async function buildPromptWithWorkspaceAttachments(prompt: string, workspacePath: string, attachments: AgentAttachment[] = []) {
    const images = attachments.filter((item) => item.dataUrl?.startsWith("data:image/"));
    if (!images.length) return prompt;
    const files = await Promise.all(images.map((item, index) => writeWorkspaceAttachment(workspacePath, item, index)));
    const lines = files.map((file, index) => `${index + 1}. ${path.basename(file)}`);
    return `${prompt}\n\n参考图片已保存在工作区，可直接读取：\n${lines.join("\n")}`;
}
