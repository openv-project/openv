import sw from "./sw.ts?importChunkUrl";
import { ClientOpEnv, createPostMessageTransport } from "@openv-project/openv-core";

const CHANNEL = "openv-sw-channel";

if (!('serviceWorker' in navigator)) {
    document.body.innerHTML = "Service workers are not supported in this browser.";
    throw new Error("Service workers not supported.");
}

const registrations = await navigator.serviceWorker.getRegistrations();
for (const registration of registrations) {
    await registration.unregister();
}

await navigator.serviceWorker.register(sw, { type: "module" });

async function waitForController(): Promise<ServiceWorker> {
    if (navigator.serviceWorker.controller) {
        return navigator.serviceWorker.controller;
    }
    return new Promise((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (navigator.serviceWorker.controller) {
                resolve(navigator.serviceWorker.controller);
            }
        }, { once: true });
    });
}

const controller = await waitForController();

const localEndpoint = {
    postMessage(_msg: any) { },
    addEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
        navigator.serviceWorker.addEventListener("message", handler);
    },
    removeEventListener(_type: "message", handler: (ev: MessageEvent) => void) {
        navigator.serviceWorker.removeEventListener("message", handler);
    },
};

const remoteEndpoint = {
    postMessage(msg: any) {
        controller.postMessage(msg);
    },
};

const transport = createPostMessageTransport(localEndpoint, remoteEndpoint, CHANNEL);
const openv = new ClientOpEnv(transport);
globalThis.openv = openv

// registry-editor.ts

async function buildTree(key: string): Promise<HTMLElement> {
    const norm = key === "/" ? "/" : key;
    const label = norm === "/" ? "/" : norm.slice(norm.lastIndexOf("/") + 1);

    const details = document.createElement("details");
    details.open = true;

    const summary = document.createElement("summary");
    summary.textContent = label;
    details.appendChild(summary);

    // Entries table
    const entries = await openv.system["party.openv.registry.read.listEntries"](norm);
    const defaultVal = await openv.system["party.openv.registry.read.readDefault"](norm);

    const allEntries: [string, string][] = [];
    if (defaultVal !== null) allEntries.push(["(Default)", String(defaultVal)]);
    if (entries) {
        for (const e of entries) {
            const val = await openv.system["party.openv.registry.read.readEntry"](norm, e);
            allEntries.push([e, String(val ?? "")]);
        }
    }

    if (allEntries.length > 0) {
        const table = document.createElement("table");
        table.style.cssText = "width:100%;border-collapse:collapse;margin:4px 0";

        const thead = table.createTHead();
        const hr = thead.insertRow();
        for (const h of ["Name", "Value", ""]) {
            const th = document.createElement("th");
            th.textContent = h;
            th.style.cssText = "text-align:left;border-bottom:1px solid;padding:2px 6px;font-weight:bold";
            hr.appendChild(th);
        }

        const tbody = table.createTBody();

        const addRow = (name: string, value: string) => {
            const isDefault = name === "(Default)";
            const realName = isDefault ? "" : name;
            const tr = tbody.insertRow();

            const nameTd = tr.insertCell();
            nameTd.textContent = name;
            nameTd.style.cssText = "padding:2px 6px;white-space:nowrap";

            const valTd = tr.insertCell();
            valTd.style.cssText = "padding:2px 6px;width:100%";

            const span = document.createElement("span");
            span.textContent = value;
            span.style.cssText = "cursor:pointer";

            const input = document.createElement("input");
            input.type = "text";
            input.value = value;
            input.style.cssText = "width:100%;box-sizing:border-box;display:none";

            span.onclick = () => {
                span.style.display = "none";
                input.style.display = "";
                input.focus();
                input.select();
            };

            const commit = async () => {
                const newVal = input.value;
                if (newVal !== span.textContent) {
                    await openv.system["party.openv.registry.write.writeEntry"](norm, realName, newVal);
                    span.textContent = newVal;
                }
                input.style.display = "none";
                span.style.display = "";
            };

            input.onblur = commit;
            input.onkeydown = (e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                    input.value = span.textContent!;
                    input.style.display = "none";
                    span.style.display = "";
                }
            };

            valTd.appendChild(span);
            valTd.appendChild(input);

            // Watch for live updates
            openv.system["party.openv.registry.read.watchEntry"](norm, realName).then(({ changes }) => {
                (async () => {
                    for await (const newValue of changes as AsyncIterable<string | null>) {
                        if (document.contains(tr)) {
                            span.textContent = newValue ?? "";
                            if (input.style.display === "") input.value = newValue ?? "";
                        }
                    }
                })();
            });

            const actionTd = tr.insertCell();
            actionTd.style.cssText = "padding:2px 6px;white-space:nowrap";

            if (!isDefault) {
                const del = document.createElement("button");
                del.textContent = "delete";
                del.onclick = async () => {
                    await openv.system["party.openv.registry.write.deleteEntry"](norm, realName);
                    tbody.removeChild(tr);
                };
                actionTd.appendChild(del);
            }
        };

        for (const [n, v] of allEntries) addRow(n, v);

        // Add new entry row
        const addTr = tbody.insertRow();
        const addTd = addTr.insertCell();
        addTd.colSpan = 3;
        addTd.style.cssText = "padding:2px 6px";

        const newName = document.createElement("input");
        newName.placeholder = "name";
        newName.style.cssText = "width:30%;margin-right:4px";

        const newVal = document.createElement("input");
        newVal.placeholder = "value";
        newVal.style.cssText = "width:40%;margin-right:4px";

        const addBtn = document.createElement("button");
        addBtn.textContent = "add entry";
        addBtn.onclick = async () => {
            const n = newName.value.trim();
            const v = newVal.value;
            if (!n) return;
            await openv.system["party.openv.registry.write.writeEntry"](norm, n, v);
            addRow(n, v);
            tbody.insertBefore(tbody.rows[tbody.rows.length - 2], addTr); // move new row before add row
            newName.value = "";
            newVal.value = "";
        };

        addTd.appendChild(newName);
        addTd.appendChild(newVal);
        addTd.appendChild(addBtn);

        details.appendChild(table);
    }

    // Subkeys
    const subkeys = await openv.system["party.openv.registry.read.listSubkeys"](norm);
    if (subkeys) {
        const childDiv = document.createElement("div");
        childDiv.style.cssText = "margin-left:1.5em";
        for (const sub of subkeys) {
            const childKey = norm === "/" ? `/${sub}` : `${norm}/${sub}`;
            const childEl = await buildTree(childKey);
            childDiv.appendChild(childEl);
        }
        details.appendChild(childDiv);
    }

    // Add subkey
    const addKeyDiv = document.createElement("div");
    addKeyDiv.style.cssText = "margin-left:1.5em;margin-top:2px";
    const newKeyInput = document.createElement("input");
    newKeyInput.placeholder = "new subkey name";
    newKeyInput.style.cssText = "margin-right:4px";
    const addKeyBtn = document.createElement("button");
    addKeyBtn.textContent = "add key";
    addKeyBtn.onclick = async () => {
        const n = newKeyInput.value.trim();
        if (!n) return;
        const newKey = norm === "/" ? `/${n}` : `${norm}/${n}`;
        await openv.system["party.openv.registry.write.createKey"](newKey);
        const childDiv = details.querySelector(":scope > div") ?? (() => {
            const d = document.createElement("div");
            d.style.cssText = "margin-left:1.5em";
            details.insertBefore(d, addKeyDiv);
            return d;
        })();
        const childEl = await buildTree(newKey);
        (childDiv as HTMLElement).appendChild(childEl);
        newKeyInput.value = "";
    };
    addKeyDiv.appendChild(newKeyInput);
    addKeyDiv.appendChild(addKeyBtn);
    details.appendChild(addKeyDiv);

    return details;
}

// Seed
await openv.system["party.openv.registry.write.createKey"]("/System");
await openv.system["party.openv.registry.write.createKey"]("/System/Test");
await openv.system["party.openv.registry.write.createKey"]("/System/Test/Nested");
await openv.system["party.openv.registry.write.writeEntry"]("/System", "Version", "0.1.0");
await openv.system["party.openv.registry.write.writeEntry"]("/System/Test", "Message", "Hello from the registry!");
await openv.system["party.openv.registry.write.writeEntry"]("/System/Test", "Author", "openv");
await openv.system["party.openv.registry.write.writeEntry"]("/System/Test/Nested", "Deep", "value");

// Render
document.body.style.cssText = "font-family:monospace;padding:1rem";
const tree = await buildTree("/");
document.body.appendChild(tree);