// Fence pass: instanced tall chain-link prison fence — steel posts, rails, a
// procedural chain-link panel (cut out in the shader) and barbed wire on top.
// Rails/panels connect toward neighbouring fence tiles via the ext/conn flags.

import fenceShader from "../fence.wgsl?raw";
import { loadTex } from "./assets";
import { FENCE_MAT } from "./materials";
import { FENCE_H, PRELUDE, sceneLightEntries, type SceneLight } from "./shaderCommon";

type Ext = [number, number, number, number];

// Axis-aligned box tagged with `ext` + `part` on every vertex (pos3 + ext4 + part1).
// part: 0 = solid steel, 1 = chain-link mesh (fragment shader cuts the diamonds).
function box(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  e: Ext, part = 0,
): number[] {
  const out: number[] = [];
  const v = (x: number, y: number, z: number) =>
    out.push(x, y, z, e[0], e[1], e[2], e[3], part);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    for (const p of [a, b, c, a, c, d]) v(p[0], p[1], p[2]);
  };
  quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]); // top
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // bottom
  quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]); // -z
  quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]); // +z
  quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]); // -x
  quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]); // +x
  return out;
}

function buildFenceMesh(): Float32Array {
  const H = FENCE_H; // top of the chain-link fabric
  const none: Ext = [0, 0, 0, 0];
  const E: Ext = [0, 0, 1, 0], W: Ext = [0, 0, 0, 1], N: Ext = [1, 0, 0, 0], S: Ext = [0, 1, 0, 0];

  const out: number[] = [
    ...box(0.43, 0.57, 0, H + 0.45, 0.43, 0.57, none), // post (carries the barbed wire)
    ...box(0.41, 0.59, H + 0.45, H + 0.51, 0.41, 0.59, none), // post cap
  ];

  // One half-run of rails + panel + barbed wire; mirrored/rotated to all 4 sides.
  // Authored along +X over [0.5, 1.0]; lo/hi are the run extent, band the thickness.
  const half = (u0: number, u1: number, e: Ext, alongX: boolean) => {
    // b(u0,u1, y0,y1, t0,t1): a box spanning the run direction and a thickness band.
    const b = (a0: number, a1: number, y0: number, y1: number, t0: number, t1: number, part = 0) =>
      alongX ? box(a0, a1, y0, y1, t0, t1, e, part) : box(t0, t1, y0, y1, a0, a1, e, part);
    out.push(
      ...b(u0, u1, H - 0.12, H - 0.02, 0.46, 0.54),      // top rail
      ...b(u0, u1, H * 0.5 - 0.04, H * 0.5 + 0.04, 0.47, 0.53), // mid rail
      ...b(u0, u1, 0.06, 0.14, 0.46, 0.54),              // bottom rail
      ...b(u0, u1, 0.10, H - 0.08, 0.492, 0.508, 1),     // chain-link panel
    );
    // Three barbed-wire strands above the fabric, with small barbs.
    for (const yc of [H + 0.10, H + 0.24, H + 0.38]) {
      out.push(...b(u0, u1, yc - 0.015, yc + 0.015, 0.487, 0.513));
      for (const px of [0.62, 0.79, 0.96]) {
        const p = u0 < 0.5 ? 1.0 - px : px; // mirror barb positions for the low half
        out.push(...b(p - 0.012, p + 0.012, yc - 0.045, yc + 0.045, 0.494, 0.506));
      }
    }
  };
  half(0.5, 1.0, E, true);
  half(0.0, 0.5, W, true);
  half(0.5, 1.0, S, false);
  half(0.0, 0.5, N, false);

  return new Float32Array(out);
}

export class FencePass {
  private pipeline!: GPURenderPipeline;
  private meshBuf!: GPUBuffer;
  private meshVerts = 0;
  private bind!: GPUBindGroup;
  private instanceBuf: GPUBuffer | null = null;
  private count = 0;

  static async create(
    device: GPUDevice, format: GPUTextureFormat, uniformBuf: GPUBuffer,
    light: SceneLight,
  ): Promise<FencePass> {
    const p = new FencePass();
    const col = await loadTex(device, FENCE_MAT.col, true);
    const samp = device.createSampler({
      addressModeU: "repeat", addressModeV: "repeat",
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 16,
    });

    const mesh = buildFenceMesh();
    p.meshVerts = mesh.length / 8;
    p.meshBuf = device.createBuffer({ size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(p.meshBuf, 0, mesh as BufferSource);

    const module = device.createShaderModule({ code: PRELUDE + fenceShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [
          {
            arrayStride: 32, stepMode: "vertex",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x4" },
              { shaderLocation: 4, offset: 28, format: "float32" },
            ],
          },
          {
            arrayStride: 24, stepMode: "instance",
            attributes: [
              { shaderLocation: 2, offset: 0, format: "float32x2" },
              { shaderLocation: 3, offset: 8, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });

    p.bind = device.createBindGroup({
      layout: p.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: samp },
        { binding: 2, resource: col.createView() },
        ...sceneLightEntries(light),
      ],
    });
    return p;
  }

  setInstances(device: GPUDevice, byMat: Map<number, Float32Array>) {
    // Single fence material for now: take whichever bucket is present.
    let data: Float32Array | undefined;
    for (const v of byMat.values()) data = v;
    this.instanceBuf?.destroy();
    this.count = data ? data.length / 6 : 0;
    if (!data || this.count === 0) { this.instanceBuf = null; return; }
    this.instanceBuf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.instanceBuf, 0, data as BufferSource);
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.instanceBuf) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.setVertexBuffer(0, this.meshBuf);
    pass.setVertexBuffer(1, this.instanceBuf);
    pass.draw(this.meshVerts, this.count);
  }
}
