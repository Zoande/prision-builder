// Floor pass: instanced quads, grouped by material (one bind group + instance
// buffer per floor material, drawn in turn).

import floorShader from "../floor.wgsl?raw";
import { loadTex } from "./assets";
import { FLOOR_MATS } from "./materials";
import { PRELUDE, sceneLightEntries, type SceneLight } from "./shaderCommon";

interface MatSlot {
  id: number;
  bind: GPUBindGroup;
  buf: GPUBuffer | null;
  count: number;
}

export class FloorPass {
  private pipeline!: GPURenderPipeline;
  private mats: MatSlot[] = [];

  static async create(
    device: GPUDevice,
    format: GPUTextureFormat,
    uniformBuf: GPUBuffer,
    light: SceneLight,
  ): Promise<FloorPass> {
    const p = new FloorPass();

    const sampRepeat = device.createSampler({
      addressModeU: "repeat", addressModeV: "repeat",
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
      maxAnisotropy: 16,
    });

    const module = device.createShaderModule({ code: PRELUDE + floorShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [{
          arrayStride: 8, stepMode: "instance",
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        }],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });

    for (const m of FLOOR_MATS) {
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
      slot.buf = device.createBuffer({
        size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(slot.buf, 0, data as BufferSource);
      slot.count = data.length / 2;
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
