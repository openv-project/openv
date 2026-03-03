/**
 * A system component represents a group of functions that the operating system exposes to the
 * user program at the lowest level of the webos (the syscalls). To allow webos's to evolve
 * over time, syscalls are grouped into namespaced, versioned system components
 *
 * @template Q The single qualified (versioned) namespace this object represents
 * @template A Accepted alias keys which map to Q (defaults to Q)
 */
export interface SystemComponent<Q extends string, A extends string = Q> {
    /**
     * Check if the unqualified namespace string `A` is supported by this syscall object.
     * If called with an accepted alias `A`, returns the qualified namespace `Q`.
     */
    supports(ns: A): Promise<Q>;
    /**
     * Check if the qualified namespace string `Q` is supported by this syscall object. 
     * The returned namespace should be the same as the input if a qualified namespace
     * is being passed.
     */
    supports(ns: Q): Promise<Q>;
    /**
     * Check if the given namespace string is supported by this syscall object.
     * It is unknown at compile time whether this is supported, so it is important
     * to call this.
     */
    supports(ns: string): Promise<string |null>;
}