import UpkApi from "@openv-project/libupk";
import { OpEnv } from "@openv-project/openv-api";
import { ClientOpEnv, createPostMessageTransport } from "@openv-project/openv-core";

const BOOTSTRAP_KEY = "/system/party/openv/bootstrap" as const;
const BASE_PACKAGE_PATH = "/packages/openv-core.tar.gz" as const;
const UPK_PACKAGE_PATH = "/packages/party.openv.libupk.tar.gz" as const;
const FRONTEND_PACKAGE_PATH = "/packages/openv-webos.tar.gz" as const;
const FFLATE_PACKAGE_PATH = "/packages/fflate.tar.gz" as const;
const NANOTAR_PACKAGE_PATH = "/packages/nanotar.tar.gz" as const;

type InstallerSelection = {
    installBase: boolean;
    installUpk: boolean;
    installFrontend: boolean;
    installFflate: boolean;
    installNanotar: boolean;
};

function renderStatus(message: string, isError = false): void {
    const el = document.getElementById("status");
    if (!el) return;
    el.textContent = isError ? `ERROR: ${message}` : message;
}

function appendLog(line: string): void {
    const el = document.getElementById("install-log") as HTMLTextAreaElement | null;
    if (!el) return;
    el.value += `[${new Date().toISOString()}] ${line}\n`;
    el.scrollTop = el.scrollHeight;
}

function setProgress(done: number, total: number): void {
    const el = document.getElementById("progress");
    if (!el) return;
    const pct = total <= 0 ? 0 : Math.round((done / total) * 100);
    el.textContent = `${done}/${total} (${pct}%)`;
}

function showReloadPrompt(): void {
    const container = document.getElementById("post-install-actions");
    if (!container) return;
    container.innerHTML = `<button id="reload-btn">Reload Page</button>`;
    const reloadBtn = document.getElementById("reload-btn") as HTMLButtonElement | null;
    if (reloadBtn) {
        reloadBtn.onclick = () => {
            location.reload();
        };
    }
}

function renderInstallerScreen(onInstall: (selection: InstallerSelection) => Promise<void>): void {
    document.body.innerHTML = `
        <main>
            <h1>openv installer</h1>
            <p>Select packages to install, then press install.</p>
            <p id="status"></p>
            <p>Progress: <span id="progress">0/0 (0%)</span></p>
            <div>
                <label><input id="pkg-base" type="checkbox" checked /> Base system (${BASE_PACKAGE_PATH})</label><br />
                <label><input id="pkg-upk" type="checkbox" checked /> UPK API (${UPK_PACKAGE_PATH})</label><br />
                <label><input id="pkg-frontend" type="checkbox" checked /> Frontend (${FRONTEND_PACKAGE_PATH})</label><br />
                <label><input id="pkg-fflate" type="checkbox" checked /> fflate (${FFLATE_PACKAGE_PATH})</label><br />
                <label><input id="pkg-nanotar" type="checkbox" checked /> nanotar (${NANOTAR_PACKAGE_PATH})</label>
            </div>
            <p><button id="install-btn">Install Selected</button></p>
            <p><textarea id="install-log" rows="16" cols="100" readonly></textarea></p>
            <div id="post-install-actions"></div>
        </main>
    `;

    const installBtn = document.getElementById("install-btn") as HTMLButtonElement;
    const base = document.getElementById("pkg-base") as HTMLInputElement;
    const upk = document.getElementById("pkg-upk") as HTMLInputElement;
    const frontend = document.getElementById("pkg-frontend") as HTMLInputElement;
    const fflate = document.getElementById("pkg-fflate") as HTMLInputElement;
    const nanotar = document.getElementById("pkg-nanotar") as HTMLInputElement;

    setProgress(0, 0);

    installBtn.onclick = () => {
        void onInstall({
            installBase: base.checked,
            installUpk: upk.checked,
            installFrontend: frontend.checked,
            installFflate: fflate.checked,
            installNanotar: nanotar.checked,
        });
    };
}

function renderWarningPrompt(onGoInstaller: () => void): void {
    document.body.innerHTML = `
        <main>
            <h1>bootstrap recovery</h1>
            <p>
                The bootstrap page is still being served even though the system reports bootstrap as complete.
                This may indicate a broken userspace route or incomplete install.
            </p>
            <p id="status"></p>
            <p>
                <button id="install-btn">Open Installer</button>
                <button id="reload-btn">Reload Page</button>
            </p>
        </main>
    `;

    const installBtn = document.getElementById("install-btn") as HTMLButtonElement;
    const reloadBtn = document.getElementById("reload-btn") as HTMLButtonElement;

    installBtn.onclick = () => {
        onGoInstaller();
    };

    reloadBtn.onclick = () => {
        location.reload();
    };
}

async function ensureServiceWorkerReady(): Promise<void> {
    if (!("serviceWorker" in navigator)) {
        document.body.textContent = "Service workers are not supported.";
        throw new Error("Service workers not supported.");
    }

    if (navigator.serviceWorker.controller) {
        return;
    }

    const swUrl = new URL("/sw.js", location.origin);
    swUrl.searchParams.set("root", "opfs");
    const registration = await navigator.serviceWorker.register(swUrl.toString(), { type: "module" });

    if (registration.installing) {
        await new Promise<void>((resolve) => {
            const installing = registration.installing!;
            installing.addEventListener("statechange", () => {
                if (installing.state === "activated") resolve();
            });
        });
        location.reload();
        throw new Error("reloading after SW install");
    }

    await navigator.serviceWorker.ready;

    if (!navigator.serviceWorker.controller) {
        location.reload();
        throw new Error("reloading to get under SW control");
    }
}

async function connectClientOpenv(channel = "openv-sw-channel"): Promise<any> {
    const controller = navigator.serviceWorker.controller!;

    const localEndpoint = {
        postMessage(_msg: unknown) { },
        addEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
            navigator.serviceWorker.addEventListener("message", handler);
        },
        removeEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
            navigator.serviceWorker.removeEventListener("message", handler);
        },
    };

    const remoteEndpoint = {
        postMessage(msg: unknown) {
            controller.postMessage(msg);
        },
    };

    const transport = createPostMessageTransport(localEndpoint, remoteEndpoint, channel);
    const openv = new ClientOpEnv<any>(transport);
    await openv.enumerateRemote();
    return openv as any;
}

async function ensureDir(system: any, path: string): Promise<void> {
    if (path === "/" || path === "") return;

    const parts = path.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
        current += `/${part}`;
        try {
            const stat = await system["party.openv.filesystem.read.stat"](current);
            if (stat.type !== "DIRECTORY") {
                throw new Error(`Path exists but is not directory: ${current}`);
            }
        } catch {
            await system["party.openv.filesystem.write.mkdir"](current, 0o755);
        }
    }
}

async function installSelected(openv: OpEnv<any>, selection: InstallerSelection): Promise<void> {
    const system = openv.system;
    appendLog("Preparing installation.");
    await ensureDir(system, "/var/lib/upk");

    let upk = openv.getAPI<UpkApi>("party.openv.libupk");
    if (!upk) {
        upk = new UpkApi();
        await openv.installAPI(upk);
        appendLog("UPK API installed into client runtime.");
    }

    upk.configure({
        rootPath: "/",
        dbPath: "/var/lib/upk/packages.db",
        inMemoryDb: false,
    });

    const packageQueue: string[] = [];
    if (selection.installBase) packageQueue.push(BASE_PACKAGE_PATH);
    if (selection.installUpk) packageQueue.push(UPK_PACKAGE_PATH);
    if (selection.installFrontend) packageQueue.push(FRONTEND_PACKAGE_PATH);
    if (selection.installFflate) packageQueue.push(FFLATE_PACKAGE_PATH);
    if (selection.installNanotar) packageQueue.push(NANOTAR_PACKAGE_PATH);
    if (packageQueue.length === 0) {
        throw new Error("No package selected.");
    }

    setProgress(0, packageQueue.length);
    appendLog(`Selected ${packageQueue.length} package(s): ${packageQueue.join(", ")}`);

    const installedPackages: string[] = [];
    let totalFiles = 0;
    let completedPackages = 0;

    for (const packagePath of packageQueue) {
        renderStatus(`Fetching ${packagePath}...`);
        appendLog(`Fetching ${packagePath}`);

        const packageRes = await fetch(packagePath);
        if (!packageRes.ok) {
            throw new Error(`Failed to fetch ${packagePath}: ${packageRes.status}`);
        }

        appendLog(`Fetched ${packagePath} (${packageRes.status})`);
        renderStatus(`Installing ${packagePath}...`);
        appendLog(`Installing ${packagePath}`);

        const packageData = new Uint8Array(await packageRes.arrayBuffer());
        const result = await upk.install(packageData, { overwrite: true });
        if (result.status === "failed") {
            throw new Error(result.message ?? `UPK install failed for ${packagePath}`);
        }

        installedPackages.push(result.packageName);
        totalFiles += result.filesInstalled;
        completedPackages += 1;

        setProgress(completedPackages, packageQueue.length);
        appendLog(`Installed ${result.packageName}: ${result.filesInstalled} file(s)`);
    }

    await system["party.openv.registry.write.createKey"](BOOTSTRAP_KEY).catch(() => { });
    await system["party.openv.registry.write.writeEntry"](BOOTSTRAP_KEY, "completed", true);
    await system["party.openv.registry.write.writeEntry"](BOOTSTRAP_KEY, "lastInstallAt", Date.now());
    await system["party.openv.registry.write.writeEntry"](BOOTSTRAP_KEY, "installStatus", "installed");
    await system["party.openv.registry.write.writeEntry"](BOOTSTRAP_KEY, "installedPackages", JSON.stringify(installedPackages));
    await system["party.openv.registry.write.writeEntry"](BOOTSTRAP_KEY, "installedFiles", totalFiles);

    appendLog(`Install complete. Total files: ${totalFiles}`);
    renderStatus(`Installed ${installedPackages.join(", ")} (${totalFiles} files). Click reload to continue.`);
    showReloadPrompt();
}

async function main(): Promise<void> {
    await ensureServiceWorkerReady();
    const openv = await connectClientOpenv();
    const system = openv.system;

    await system["party.openv.registry.write.createKey"](BOOTSTRAP_KEY).catch(() => { });

    const completedRaw = await system["party.openv.registry.read.readEntry"](BOOTSTRAP_KEY, "completed");
    const completed = completedRaw === true;

    const startInstall = async (selection: InstallerSelection) => {
        try {
            renderStatus("Starting installation...");
            const postInstallActions = document.getElementById("post-install-actions");
            if (postInstallActions) postInstallActions.innerHTML = "";
            await installSelected(openv, selection);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            appendLog(`Install failed: ${message}`);
            renderStatus(`Install failed: ${message}`, true);
        }
    };

    if (!completed) {
        renderInstallerScreen(startInstall);
        return;
    }

    renderWarningPrompt(() => {
        renderInstallerScreen(startInstall);
    });
}

await main();
