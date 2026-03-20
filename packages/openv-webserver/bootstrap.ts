if (!("serviceWorker" in navigator)) {
    document.body.textContent = "Service workers are not supported.";
    throw new Error("Service workers not supported.");
}

const registration = await navigator.serviceWorker.register("/sw.js", { type: "module" });

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