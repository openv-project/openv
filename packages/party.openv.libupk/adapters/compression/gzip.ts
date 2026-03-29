import type { CompressionAdapter } from "../../types/adapters.js";
import { gunzipSync, gzipSync } from "fflate";

export class GzipAdapter implements CompressionAdapter {
  readonly name = "gzip";

  supports(data: Uint8Array): boolean {
    return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
  }

  async decompress(data: Uint8Array): Promise<Uint8Array> {
    try {
      return gunzipSync(data);
    } catch (error) {
      throw new Error(`Failed to decompress gzip data: ${error}`);
    }
  }

  async compress(data: Uint8Array): Promise<Uint8Array> {
    try {
      return gzipSync(data);
    } catch (error) {
      throw new Error(`Failed to compress with gzip: ${error}`);
    }
  }
}
