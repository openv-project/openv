export async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;

  if (typeof crypto !== "undefined" && crypto.subtle) {
    const digestInput = new Uint8Array(bytes).buffer;
    const hashBuffer = await crypto.subtle.digest("SHA-256", digestInput);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  throw new Error("No WebCrypto implementation available");
}

export async function sha256File(getData: () => Promise<Uint8Array>): Promise<string> {
  const data = await getData();
  return sha256(data);
}
