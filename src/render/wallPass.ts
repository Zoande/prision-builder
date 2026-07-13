// Wall pass: instanced chamfered cubes, grouped by material.

import wallShader from "../wall.wgsl?raw";
import { loadTex } from "./assets";
import { WALL_MATS } from "./materials";
import { PRELUDE, sceneLightEntries, WALL_CAP, WALL_H, type SceneLight } from "./shaderCommon";

const CAP = WALL_CAP;

type V = { p: [number, number, number]; s: [number, number, number, number] };

function buildWallMesh(): Float32Array {
  const H = WALL_H;
  const ys = H - CAP;
  const BA: V = { p: [0, 0, 0], s: [0, 0, 0, 0] };
  const BB: V = { p: [1, 0, 0], s: [0, 0, 0, 0] };
  const BC: V = { p: [1, 0, 1], s: [0, 0, 0, 0] };
  const BD: V = { p: [0, 0, 1], s: [0, 0, 0, 0] };
  const SA: V = { p: [0, ys, 0], s: [0, 0, 0, 0] };
  const SB: V = { p: [1, ys, 0], s: [0, 0, 0, 0] };
  const SC: V = { p: [1, ys, 1], s: [0, 0, 0, 0] };
  const SD: V = { p: [0, ys, 1], s: [0, 0, 0, 0] };
  const TA: V = { p: [0, H, 0], s: [1, 0, 0, 1] };
  const TB: V = { p: [1, H, 0], s: [1, 0, 1, 0] };
  const TC: V = { p: [1, H, 1], s: [0, 1, 1, 0] };
  const TD: V = { p: [0, H, 1], s: [0, 1, 0, 1] };

  const quads: [V, V, V, V][] = [
    [TA, TB, TC, TD],
    [BA, BB, SB, SA], [BB, BC, SC, SB], [BC, BD, SD, SC], [BD, BA, SA, SD],
    [SA, SB, TB, TA], [SB, SC, TC, TB], [SC, SD, TD, TC], [SD, SA, TA, TD],
  ];
  const out: number[] = [];
  const push = (v: V) => out.push(v.p[0], v.p[1], v.p[2], v.s[0], v.s[1], v.s[2], v.s[3]);
  for (const [a, b, c, d] of quads) { push(a); push(b); push(c); push(a); push(c); push(d); }
  return new Float32Array(out);
}

interface MatSlot { id: number; bind: GPUBindGroup; buf: GPUBuffer | null; count: number; }

export class WallPass {
  private pipeline!: GPURenderPipeline;
  private meshBuf!: GPUBuffer;
  private meshVerts = 0;
  private mats: MatSlot[] = [];

  static async create(
    device: GPUDevice,
    format: GPUTextureFormat,
    uniformBuf: GPUBuffer,
    light: SceneLight,
  ): Promise<WallPass> {
    const p = new WallPass();

    const sampRepeat = device.createSampler({
      addressModeU: "repeat", addressModeV: "repeat",
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 16,
    });

    const mesh = buildWallMesh();
    p.meshVerts = mesh.length / 7;
    p.meshBuf = device.createBuffer({ size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(p.meshBuf, 0, mesh as BufferSource);

    const module = device.createShaderModule({ code: PRELUDE + wallShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [
          {
            arrayStride: 28, stepMode: "vertex",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x4" },
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

    for (const m of WALL_MATS) {
      const [col, nrm] = await Promise.all([
        loadTex(device, m.col, true),
        loadTex(device, m.nrm, false),
      ]);
      const bind = device.createBindGroup({
        layout: p.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: sampRepeat },
          { binding: 2, resource: col.createView() },
          { binding: 3, resource: nrm.createView() },
          ...sceneLightEntries(light),
        ],
      });
      p.mats.push({ id: m.id, bind, buf: null, count: 0 });
    }
    return p;
  }

  setInstances(device: GPUDevice, byMat: Map<number, Float32Array>) {
    for (const slot of this.mats) {
      const data = byMat.get(slot.id);
      slot.buf?.destroy();
      if (!data || data.length === 0) { slot.buf = null; slot.count = 0; continue; }
      slot.buf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(slot.buf, 0, data as BufferSource);
      slot.count = data.length / 6;
    }
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(0, this.meshBuf);
    for (const slot of this.mats) {
      if (!slot.buf) continue;
      pass.setBindGroup(0, slot.bind);
      pass.setVertexBuffer(1, slot.buf);
      pass.draw(this.meshVerts, slot.count);
    }
  }
}
