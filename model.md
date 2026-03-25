# OpEnv Model

For the purpose of this documentation, the web environment is going to be used as an example. Additionally, while OpEnv has no actual forced set of components, and is primarily an open interface, we will define an "OpEnv System" as a full implementation of OpEnv (openv-core) that includes all or most component interfaces that are specified in the openv-api package. This includes filesystem, processes, registry, and more.

## Kernel?

OpEnv is not a traditional operating system nor a traditional Web OS. An OpEnv System's kernel is essentially the set of core components that are non local to processes. The architecture of the web implementation of OpEnv contains a "split" kernel between the service worker and a client browser tab. The service worker privately registers the core system components and exposes these unrestricted to the client browser tab. The browser tab then handles the initialization of a userspace, including the registration of process handling and providing the frontend interface for userspace applications. This tab has the freedom to expose an interface for a configurable frontend, such as a compositor running in userspace, or just a console or single-appliance interface.

## Userspace

The userspace of an OpEnv System is not truely specified beyond the userspace / ProcessLocal components in the openv-api package. The userspace of the web implementation of OpEnv is granted access to the DOM of the browser tab by the final stage of the kernel, so userspace applications can interact with the DOM over a filesystem socket (implementing Shopify/remote-dom over JSON).