// Texture loading with mipmap generation. Mips + anisotropic sampling keep the
// tiled ground crisp and shimmer-free as it recedes toward the horizon.

let blitPipelineCache: Map<GPUTextureFormat, GPURenderPipeline> | null = null;
let blitSampler: GPUSampler | null = null;

const BLIT_WGSL = /* wgsl */ `
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) uv : vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
  var o : VSOut;
  o.pos = vec4(p[i], 0.0, 1.0);
  o.uv = (p[i] * vec2(0.5, -0.5)) + vec2(0.5, 0.5);
  return o;
}
@group(0) @binding(0) var s : sampler;
@group(0) @binding(1) var t : texture_2d<f32>;
@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> { return textureSample(t, s, in.uv); }
`;

function getBlitPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  if (!blitPipelineCache) blitPipelineCache = new Map();
  let p = blitPipelineCache.get(format);
  if (!p) {
    const module = device.createShaderModule({ code: BLIT_WGSL });
    p = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    blitPipelineCache.set(format, p);
  }
  if (!blitSampler) blitSampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  return p;
}

function mipCount(w: number, h: number): number {
  return 1 + Math.floor(Math.log2(Math.max(w, h)));
}

export async function loadTexture(
  device: GPUDevice,
  url: string,
  format: GPUTextureFormat,
  maxSize = 0, // downscale so the longest side is <= maxSize (0 = keep original)
): Promise<GPUTexture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  let bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none" });
  if (maxSize && Math.max(bitmap.width, bitmap.height) > maxSize) {
    const s = maxSize / Math.max(bitmap.width, bitmap.height);
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: Math.round(bitmap.width * s),
      resizeHeight: Math.round(bitmap.height * s),
      resizeQuality: "high",
    });
    bitmap.close();
    bitmap = resized;
  }

  const levels = mipCount(bitmap.width, bitmap.height);
  const texture = device.createTexture({
    size: [bitmap.width, bitmap.height, 1],
    format,
    mipLevelCount: levels,
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: bitmap, flipY: false },
    { texture, mipLevel: 0 },
    [bitmap.width, bitmap.height],
  );

  // Generate each mip by downsampling the previous level.
  const pipeline = getBlitPipeline(device, format);
  const encoder = device.createCommandEncoder();
  for (let lvl = 1; lvl < levels; lvl++) {
    const srcView = texture.createView({ baseMipLevel: lvl - 1, mipLevelCount: 1 });
    const dstView = texture.createView({ baseMipLevel: lvl, mipLevelCount: 1 });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: blitSampler! },
        { binding: 1, resource: srcView },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: dstView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
  bitmap.close();
  return texture;
}

// Single-channel R8 splat map from raw bytes (no mips needed; sampled smoothly).
export function createSplatTexture(device: GPUDevice, data: Uint8Array, res: number): GPUTexture {
  const texture = device.createTexture({
    size: [res, res, 1],
    format: "r8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    data as BufferSource,
    { bytesPerRow: res, rowsPerImage: res },
    [res, res, 1],
  );
  return texture;
}
