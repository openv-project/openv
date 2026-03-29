import UpkApi from "@openv-project/libupk";
import { OpEnv } from "@openv-project/openv-api";
import { ClientOpEnv, createPostMessageTransport } from "@openv-project/openv-core";

const BOOTSTRAP_KEY = "/system/party/openv/bootstrap" as const;
const BOOTSTRAP_PACKAGE_LIST_PATH = "/packages/bootstrap-packages.json" as const;

type BootstrapPackageEntry = {
    path: string;
    label: string;
    defaultSelected: boolean;
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

function renderInstallerScreen(
    packages: BootstrapPackageEntry[],
    onInstall: (selectedPackagePaths: string[]) => Promise<void>,
): void {
    const safePackages = Array.isArray(packages) ? packages : [];
    const packageRows = safePackages
        .map((pkg, index) => {
            const id = `pkg-${index}`;
            const checked = pkg.defaultSelected ? " checked" : "";
            return `<label><input id="${id}" type="checkbox" data-path="${pkg.path}"${checked} /> ${pkg.label} (${pkg.path})</label>`;
        })
        .join("<br />");

    document.body.innerHTML = `
        <main>
            <h1>openv installer</h1>
            <p>Select packages to install, then press install.</p>
            <p id="status"></p>
            <p>Progress: <span id="progress">0/0 (0%)</span></p>
            <div>
                ${packageRows || "<em>No packages available.</em>"}
            </div>
            <p>
                <button id="select-all-btn" type="button">Select All</button>
                <button id="deselect-all-btn" type="button">Deselect All</button>
            </p>
            <p><button id="install-btn">Install Selected</button></p>
            <p><textarea id="install-log" rows="16" cols="100" readonly></textarea></p>
            <div id="post-install-actions"></div>
        </main>
    `;

    const installBtn = document.getElementById("install-btn") as HTMLButtonElement;
    const selectAllBtn = document.getElementById("select-all-btn") as HTMLButtonElement | null;
    const deselectAllBtn = document.getElementById("deselect-all-btn") as HTMLButtonElement | null;
    const packageInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-path]'));

    setProgress(0, 0);

    if (selectAllBtn) {
        selectAllBtn.onclick = () => {
            for (const input of packageInputs) input.checked = true;
        };
    }

    if (deselectAllBtn) {
        deselectAllBtn.onclick = () => {
            for (const input of packageInputs) input.checked = false;
        };
    }

    installBtn.onclick = () => {
        const selected = packageInputs.filter((input) => input.checked).map((input) => input.dataset.path!).filter(Boolean);
        void onInstall(selected);
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

async function installSelected(openv: OpEnv<any>, selectedPackagePaths: string[]): Promise<void> {
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

    const packageQueue = selectedPackagePaths.slice();
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

    let bootstrapPackages: BootstrapPackageEntry[] = [];
    try {
        const pkgListRes = await fetch(BOOTSTRAP_PACKAGE_LIST_PATH);
        if (!pkgListRes.ok) {
            throw new Error(`Failed to fetch package list (${pkgListRes.status})`);
        }
        const decoded = await pkgListRes.json() as unknown;
        if (!Array.isArray(decoded)) {
            throw new Error("Invalid bootstrap package list payload.");
        }
        bootstrapPackages = decoded
            .filter((entry): entry is BootstrapPackageEntry =>
                !!entry &&
                typeof entry === "object" &&
                typeof (entry as any).path === "string" &&
                typeof (entry as any).label === "string" &&
                typeof (entry as any).defaultSelected === "boolean")
            .map((entry) => ({
                path: entry.path,
                label: entry.label,
                defaultSelected: entry.defaultSelected,
            }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog(`Failed to load bootstrap package list: ${message}`);
        renderStatus(`Failed to load bootstrap package list: ${message}`, true);
        throw error;
    }

    const startInstall = async (selectedPackagePaths: string[]) => {
        try {
            renderStatus("Starting installation...");
            const postInstallActions = document.getElementById("post-install-actions");
            if (postInstallActions) postInstallActions.innerHTML = "";
            await installSelected(openv, selectedPackagePaths);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            appendLog(`Install failed: ${message}`);
            renderStatus(`Install failed: ${message}`, true);
        }
    };

    if (!completed) {
        renderInstallerScreen(bootstrapPackages, startInstall);
        return;
    }

    renderWarningPrompt(() => {
        renderInstallerScreen(bootstrapPackages, startInstall);
    });
}

await main();
