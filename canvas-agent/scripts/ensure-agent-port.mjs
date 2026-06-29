import { execSync } from "node:child_process";

const port = Number(process.env.PORT) || 17371;

function killPortWindows(targetPort) {
    try {
        const out = execSync(`netstat -ano | findstr :${targetPort}`, { encoding: "utf8" });
        const pids = new Set();
        for (const line of out.split("\n")) {
            if (!/LISTENING/i.test(line)) continue;
            const pid = line.trim().split(/\s+/).at(-1);
            if (pid && pid !== "0") pids.add(pid);
        }
        for (const pid of pids) {
            try {
                execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
            } catch {}
        }
    } catch {}
}

function killPortUnix(targetPort) {
    try {
        execSync(`lsof -ti tcp:${targetPort} | xargs -r kill -9`, { stdio: "ignore", shell: true });
    } catch {}
}

if (process.platform === "win32") killPortWindows(port);
else killPortUnix(port);
