// Light fixture pass: instanced floor lamps, wall lights and ceiling lights.
// Simple box meshes with a per-vertex part flag (0 metal, 1 warm glass,
// 2 cool panel); the shader draws the glass emissive so fixtures read as lit.

import lightShader from "../light.wgsl?raw";
import { PRELUDE, ROOF_Y } from "./shaderCommon";

// Box tagged with `part` on every vertex (pos3 + part1), no bottom face.
function box(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, part = 0,
): number[] {
  const out: number[] = [];
  const v = (x: number, y: number, z: number) => out.push(x, y, z, part);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    for (const p of [a, b, c, a, c, d]) v(p[0], p[1], p[2]);
  };
  quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]); // top
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // bottom (glow shines down)
  quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]);
  quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]);
  quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
  return out;
}

// Floor lamp: base, pole, shade, warm bulb underneath.
const lampMesh = () => new Float32Array([
  ...box(0.38, 0.62, 0.00, 0.05, 0.38, 0.62),
  ...box(0.485, 0.515, 0.05, 1.45, 0.485, 0.515),
  ...box(0.36, 0.64, 1.46, 1.72, 0.36, 0.64),
  ...box(0.42, 0.58, 1.38, 1.47, 0.42, 0.58, 1),
]);

// Wall light, authored for orient 0 (mounted on the +X face of its wall
// tile, protruding into the neighbouring tile): bracket, hood, warm glass.
const wallLightMesh = () => new Float32Array([
  ...box(0.99, 1.06, 2.05, 2.16, 0.44, 0.56),
  ...box(1.04, 1.22, 2.12, 2.24, 0.40, 0.60),
  ...box(1.06, 1.20, 2.02, 2.12, 0.42, 0.58, 1),
]);

// Ceiling pendant: rod from the roof, hood, cool light panel.
const roofLightMesh = () => new Float32Array([
  ...box(0.49, 0.51, 2.56, ROOF_Y, 0.49, 0.51),
  ...box(0.30, 0.70, 2.44, 2.56, 0.30, 0.70),
  ...box(0.33, 0.67, 2.38, 2.45, 0.33, 0.67, 2),
]);

interface Slot { buf: GPUBuffer; verts: number; inst: GPUBuffer | null; count: number; }

export class LightsPass {
  private pipeline!: GPURenderPipeline;
  private bind!: GPUBindGroup;
  private slots: Slot[] = [];

  static create(
    device: GPUDevice, format: GPUTextureFormat, uniformBuf: GPUBuffer,
    lightView: GPUTextureView, lightSamp: GPUSampler,
  ): LightsPass {
    const p = new LightsPass();
    const module = device.createShaderModule({ code: PRELUDE + lightShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [
          {
            arrayStride: 16, stepMode: "vertex",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32" },
            ],
          },
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
    p.bind = device.createBindGroup({
      layout: p.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 10, resource: lightSamp },
        { binding: 11, resource: lightView },
      ],
    });

    for (const mesh of [lampMesh(), wallLightMesh(), roofLightMesh()]) {
      const buf = device.createBuffer({ size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, mesh as BufferSource);
      p.slots.push({ buf, verts: mesh.length / 4, inst: null, count: 0 });
    }
    return p;
  }

  setInstances(
    device: GPUDevice,
    data: { lamps: Float32Array; wallLights: Float32Array; roofLights: Float32Array },
  ) {
    const arrays = [data.lamps, data.wallLights, data.roofLights];
    for (let i = 0; i < 3; i++) {
      const slot = this.slots[i];
      slot.inst?.destroy();
      slot.count = arrays[i].length / 3;
      if (slot.count === 0) { slot.inst = null; continue; }
      slot.inst = device.createBuffer({ size: arrays[i].byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(slot.inst, 0, arrays[i] as BufferSource);
    }
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    for (const slot of this.slots) {
      if (!slot.inst) continue;
      pass.setVertexBuffer(0, slot.buf);
      pass.setVertexBuffer(1, slot.inst);
      pass.draw(slot.verts, slot.count);
    }
  }
}
