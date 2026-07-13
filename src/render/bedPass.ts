// Bed pass: a 1x2 prison cot — galvanized steel frame with barred head/foot
// boards, a fabric mattress + pillow, and a tinted wool blanket draped over
// the foot end. Drawn as tinted parts by bed.wgsl (instanced, orient-swappable,
// derivative-lit).

import bedShader from "../bed.wgsl?raw";
import { loadTex } from "./assets";
import { PRELUDE, sceneLightEntries, type SceneLight } from "./shaderCommon";

// Box without a bottom face (never seen), as position-only triangles.
function box(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
): number[] {
  const q = (a: number[], b: number[], c: number[], d: number[]) =>
    [...a, ...b, ...c, ...a, ...c, ...d];
  return [
    ...q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    ...q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]),
    ...q([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]),
    ...q([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]),
    ...q([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]),
  ];
}

// Authored along +X over two tiles (x in [0,2]), head at x=0; orient=1 swaps to +Z.
function frameMesh(): Float32Array {
  const out: number[] = [
    // legs
    ...box(0.08, 0.15, 0.0, 0.34, 0.10, 0.17), ...box(0.08, 0.15, 0.0, 0.34, 0.83, 0.90),
    ...box(1.85, 1.92, 0.0, 0.34, 0.10, 0.17), ...box(1.85, 1.92, 0.0, 0.34, 0.83, 0.90),
    // side rails + deck plate under the mattress
    ...box(0.08, 1.92, 0.26, 0.34, 0.10, 0.16), ...box(0.08, 1.92, 0.26, 0.34, 0.84, 0.90),
    ...box(0.10, 1.90, 0.33, 0.36, 0.11, 0.89),
    // headboard: posts, top tube, bars
    ...box(0.08, 0.15, 0.34, 1.02, 0.10, 0.17), ...box(0.08, 0.15, 0.34, 1.02, 0.83, 0.90),
    ...box(0.085, 0.145, 0.94, 1.02, 0.10, 0.90),
    // footboard: posts, top tube, bars
    ...box(1.85, 1.92, 0.34, 0.78, 0.10, 0.17), ...box(1.85, 1.92, 0.34, 0.78, 0.83, 0.90),
    ...box(1.855, 1.915, 0.70, 0.78, 0.10, 0.90),
  ];
  for (const zc of [0.30, 0.48, 0.66]) {
    out.push(...box(0.095, 0.135, 0.36, 0.94, zc, zc + 0.035)); // head bars
    out.push(...box(1.865, 1.905, 0.36, 0.70, zc, zc + 0.035)); // foot bars
  }
  return new Float32Array(out);
}

const softMesh = () =>
  new Float32Array([
    ...box(0.13, 1.87, 0.36, 0.55, 0.12, 0.88), // mattress
    ...box(0.20, 0.58, 0.55, 0.66, 0.20, 0.80), // pillow at the head
  ]);

// Slightly wider than the mattress so its sides hang like draped cloth.
const blanketMesh = () =>
  new Float32Array(box(0.68, 1.895, 0.32, 0.585, 0.095, 0.905));

interface Part { buf: GPUBuffer; verts: number; bind: GPUBindGroup; }

export class BedPass {
  private pipeline!: GPURenderPipeline;
  private parts: Part[] = [];
  private instanceBuf: GPUBuffer | null = null;
  private count = 0;

  static async create(
    device: GPUDevice, format: GPUTextureFormat, uniformBuf: GPUBuffer,
    light: SceneLight,
  ): Promise<BedPass> {
    const p = new BedPass();
    const [steel, fabric] = await Promise.all([
      loadTex(device, "galv_col", true),
      loadTex(device, "fabric_col", true),
    ]);
    const samp = device.createSampler({
      addressModeU: "repeat", addressModeV: "repeat",
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 16,
    });

    const module = device.createShaderModule({ code: PRELUDE + bedShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [
          { arrayStride: 12, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
          {
            arrayStride: 12, stepMode: "instance",
            attributes: [
              { shaderLocation: 2, offset: 0, format: "float32x2" },
              { shaderLocation: 3, offset: 8, format: "float32" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });

    const mkPart = (mesh: Float32Array, tex: GPUTexture, tint: [number, number, number]): Part => {
      const buf = device.createBuffer({ size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, mesh as BufferSource);
      const tintBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(tintBuf, 0, new Float32Array([...tint, 1]) as BufferSource);
      const bind = device.createBindGroup({
        layout: p.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: samp },
          { binding: 2, resource: tex.createView() },
          { binding: 3, resource: { buffer: tintBuf } },
          ...sceneLightEntries(light),
        ],
      });
      return { buf, verts: mesh.length / 3, bind };
    };
    p.parts = [
      mkPart(frameMesh(), steel, [0.62, 0.64, 0.68]),   // darker steel than the fence
      mkPart(softMesh(), fabric, [0.97, 0.96, 0.92]),   // mattress + pillow
      mkPart(blanketMesh(), fabric, [0.36, 0.43, 0.56]), // issue wool blanket
    ];
    return p;
  }

  setInstances(device: GPUDevice, data: Float32Array) {
    this.count = data.length / 3;
    this.instanceBuf?.destroy();
    if (this.count === 0) { this.instanceBuf = null; return; }
    this.instanceBuf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.instanceBuf, 0, data as BufferSource);
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.instanceBuf) return;
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(1, this.instanceBuf);
    for (const part of this.parts) {
      pass.setBindGroup(0, part.bind);
      pass.setVertexBuffer(0, part.buf);
      pass.draw(part.verts, this.count);
    }
  }
}
