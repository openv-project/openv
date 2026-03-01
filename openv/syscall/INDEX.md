# Syscall Namespace

Many WebOS's may implement different sorts of operations for the operating system. The namespaced syscall pattern allows for room for both standard and custom syscalls, as well as disabling certain syscalls for security reasons. The syscall namespace is a string that is used to identify the type of syscall being made.
A syscall object is any object that implements one or more syscall namespace, which can be checked for support using the `supports(namespace)` method. This method should be implemented by the operating system, returning the string of the fully qualified namespace if the syscall is supported, or `null` if it is not supported. This method should include support for both basic and qualified namespaces.

## Namespaces

Namespaces themselves are technically arbitrary strings of `[a-zA-Z0-9_-\.]+`, but we recommend using a reverse domain name notation for maximum compatibility. For example, `com.myawesomewebos.cloud` would be a good idea if you want to provide some sort of cloud functionality at the lowest level of the operating system.

## Quirks

Standard syscalls are not exactly the most convenient thing for implementors, as sometimes a syscall cannot be implemented completely as specified, or may have some sort of undefined behavior that is handled differently from one implementation to another. In these cases, the operating system should define a "quirk" namespace like `com.myawesomewebos.quirks.filesystem.read` that may or may not contain any additional calls itself. This allows applications that are aware of the quirk to check `supports("com.myawesomewebos.quirks.filesystem.read")` and adjust the behavior of the application accordingly, while applications that are not aware of the quirk can simply ignore it and hope for the best. Of course, quirks should be avoided if possible, but whether the quirk is truly critical or not can only be determined by the implementor of the operating system and its applications.

## Qualified Namespaces

Qualified namespaces are a composite of the basic namespace (i.e. `party.openv.filesystem.read`) and the version (i.e. `/0.1.0`). The qualified namespace is the full string that is used to identify the specifics of the interface. A full qualified namespace would look like `party.openv.filesystem.read/0.1.0`. The version should always be included if a qualified namespace is being called for.