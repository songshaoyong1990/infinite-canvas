import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseChangelog } from "@/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

export default function nextConfig(phase: string): NextConfig {
    const isDev = phase === PHASE_DEVELOPMENT_SERVER;
    const releases = parseChangelog(localChangelog);

    return {
        output: "standalone",
        allowedDevOrigins: isDev ? ["*.*.*.*"] : [],
        typescript: {
            ignoreBuildErrors: true,
        },
        env: {
            NEXT_PUBLIC_APP_VERSION: localVersion,
            NEXT_PUBLIC_APP_RELEASES: JSON.stringify(releases),
            NEXT_PUBLIC_CANVAS_AGENT_URL: isDev ? "/canvas-agent" : "",
            NEXT_PUBLIC_CANVAS_AGENT_SSE_ORIGIN: isDev ? process.env.CANVAS_AGENT_ORIGIN || "http://127.0.0.1:17371" : "",
        },
        ...(isDev
            ? {
                  async rewrites() {
                      const agentOrigin = process.env.CANVAS_AGENT_ORIGIN || "http://127.0.0.1:17371";
                      return [{ source: "/canvas-agent/:path*", destination: `${agentOrigin}/:path*` }];
                  },
              }
            : {}),
    };
}
