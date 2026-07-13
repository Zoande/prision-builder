// Minimal KTX1 reader for the raw BC7 files produced by scripts/compress-textures.mjs.
// We only ever emit single-layer, single-face, BC7 textures with a full mip chain,
// so this handles exactly that — no transcoder, just parse blocks and upload.

const KTX1_ID = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

// GL internal formats basisu emits for BC7.
const GL_BC7_UNORM = 0x8e8c; // COMPRESSED_RGBA_BPTC_UNORM
const GL_BC7_SRGB = 0x8e8d; // COMPRESSED_SRGB_ALPHA_BPTC_UNORM
const BC_BLOCK_BYTES = 16; // BC7: 4x4 texels per 16-byte block

interface KtxLevel {
  width: number;
  height: number;
  data: Uint8Array;
}

function parseKtx1(buf: ArrayBuffer): { width: number; height: number; levels: KtxLevel[] } {
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < 12; i++) {
    if (bytes[i] !== KTX1_ID[i]) throw new Error("not a KTX1 file");
  }
  const dv = new DataView(buf);
  const endian = dv.getUint32(12, true);
  const le = endian === 0x04030201;
  const u32 = (off: number) => dv.getUint32(off, le);

  const glInternalFormat = u32(28);
  if (glInternalFormat !== GL_BC7_UNORM && glInternalFormat !== GL_BC7_SRGB) {
    throw new Error(`unexpected KTX format 0x${glInternalFormat.toString(16)} (expected BC7)`);
  }
  const width = u32(36);
  const height = u32(40);
  const mipCount = Math.max(1, u32(56));
  const kvBytes = u32(60);

  let off = 64 + kvBytes;
  const levels: KtxLevel[] = [];
  for (let lvl = 0; lvl < mipCount; lvl++) {
    const imageSize = u32(off);
    off += 4;
    const w = Math.max(1, width >> lvl);
    const h = Math.max(1, height >> lvl);
    levels.push({ width: w, height: h, data: bytes.subarray(off, off + imageSize) });
    off += imageSize;
    off += 3 - ((imageSize + 3) % 4); // mip padding to 4 bytes
  }
  return { width, height, levels };
}

export async function loadKtxTexture(
  device: GPUDevice,
  url: string,
  srgb: boolean,
): Promise<GPUTexture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`);
  const { width, height, levels } = parseKtx1(await res.arrayBuffer());

  const format: GPUTextureFormat = srgb ? "bc7-rgba-unorm-srgb" : "bc7-rgba-unorm";
  const texture = device.createTexture({
    size: [width, height, 1],
    format,
    mipLevelCount: levels.length,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  for (let i = 0; i < levels.length; i++) {
    const { width: w, height: h, data } = levels[i];
    const blocksWide = Math.ceil(w / 4);
    const blocksHigh = Math.ceil(h / 4);
    // Copy size must be the physical (block-aligned) size: mips under 4px
    // still occupy a full 4x4 block.
    device.queue.writeTexture(
      { texture, mipLevel: i },
      data as BufferSource,
      { offset: 0, bytesPerRow: blocksWide * BC_BLOCK_BYTES, rowsPerImage: blocksHigh },
      { width: blocksWide * 4, height: blocksHigh * 4, depthOrArrayLayers: 1 },
    );
  }
  return texture;
}
