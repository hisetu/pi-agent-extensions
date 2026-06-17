import { hostname } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function hostnameFooter(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
        if (!ctx.hasUI) return;

        ctx.ui.setStatus("hostname", ctx.ui.theme.fg("dim", `🖥 ${hostname()}`));
    });
}
