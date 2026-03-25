/// <reference lib="webworker" />
import { coreRegistry } from "./init.ts";

declare const self: ServiceWorkerGlobalScope;

export const PEER_FILTER_KEY = "/system/party/openv/serviceWorker/peerFilter" as const;

const DEFAULT_ALLOWED_PAGE_PATHS = [
    "/",
    "/index.html",
    // intentionally not including raw fs path for the bridge root, accidental duplicate access from a different path can cause bugs
    // with custom implementations
] as const;

export let peerFilterEnabled = true;
export let peerAllowedPagePaths: string[] = [...DEFAULT_ALLOWED_PAGE_PATHS];

export const PEER_FILTER_DEFAULTS: [string, string, string | number | boolean][] = [
    [PEER_FILTER_KEY, "enabled", true],
    [PEER_FILTER_KEY, "allowedPagePaths", JSON.stringify(DEFAULT_ALLOWED_PAGE_PATHS)],
];

export async function applyPeerFilterConfig(): Promise<void> {
    const enabledVal = await coreRegistry["party.openv.registry.read.readEntry"](PEER_FILTER_KEY, "enabled");
    peerFilterEnabled = enabledVal !== false;

    const pathsRaw = await coreRegistry["party.openv.registry.read.readEntry"](PEER_FILTER_KEY, "allowedPagePaths");

    if (typeof pathsRaw !== "string") {
        peerAllowedPagePaths = [...DEFAULT_ALLOWED_PAGE_PATHS];
        return;
    }

    try {
        const parsed = JSON.parse(pathsRaw);
        if (!Array.isArray(parsed)) {
            peerAllowedPagePaths = [...DEFAULT_ALLOWED_PAGE_PATHS];
            return;
        }

        const normalized = parsed
            .filter((path): path is string => typeof path === "string")
            .map(normalizePath)
            .filter((path) => path.length > 0);

        peerAllowedPagePaths = normalized.length > 0
            ? Array.from(new Set(normalized))
            : [...DEFAULT_ALLOWED_PAGE_PATHS];
    } catch {
        peerAllowedPagePaths = [...DEFAULT_ALLOWED_PAGE_PATHS];
    }
}

export function isClientAllowedForPeer(client: Client): boolean {
    const clientUrl = safeUrl(client.url);
    if (!clientUrl) return false;

    if (clientUrl.origin !== self.location.origin) return false;
    if (!peerFilterEnabled) return true;

    const pathname = normalizePath(clientUrl.pathname);
    return peerAllowedPagePaths.includes(pathname);
}

function normalizePath(path: string): string {
    const trimmed = path.trim();
    if (trimmed.length === 0) return "/";
    const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
    if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.slice(0, -1);
    return collapsed;
}

function safeUrl(input: string): URL | null {
    try {
        return new URL(input);
    } catch {
        return null;
    }
}