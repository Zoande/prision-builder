// Roof pass: instanced quads over each building-footprint tile, at the wall
// top, textured to match the wall material the roof rises from (one slot per
// wall material). Alpha-blended; opacity is driven by the shared roofAlpha
// uniform.

import roofShader from "../roof.wgsl?raw";
import { loadTex } from "./assets";
import { WALL_MATS } from "./materials";
import { PRELUDE, sceneLightEntries, type SceneLight } from "./shaderCommon";

interface MatSlot { id: number; bind: GPUBindGroup; buf: GPUBuffer | null; count: number; }

export class RoofPass {
  private pipeline!: GPURenderPipeline;
  private mats: MatSlot[] = [];

  static async create(
    device: GPUDevice,
    format: GPUTextureFormat,
    uniformBuf: GPUBuffer,
    light: SceneLight,
  ): Promise<RoofPass> {
    const p = new RoofPass();

    const sampRepeat = device.createSampler({
      addressModeU: "repeat", addressModeV: "repeat",
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
      maxAnisotropy: 16,
    });

    const module = device.createShaderModule({ code: PRELUDE + roofShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 24, // tile x,z + exposure N,S,E,W
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" },
              { shaderLocation: 1, offset: 8, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      // Topmost translucent layer: test against the scene but don't write depth.
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" },
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

  /** Upload roof instances per wall material (6 floats each: x, z, expose N,S,E,W). */
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
    for (const slot of this.mats) {
      if (!slot.buf) continue;
      pass.setBindGroup(0, slot.bind);
      pass.setVertexBuffer(0, slot.buf);
      pass.draw(6, slot.count);
    }
  }
}
