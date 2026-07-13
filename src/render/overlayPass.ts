// Debug overlay pass: translucent tile quads showing the selected agent's
// known map (see overlay.wgsl). Fed by Agents.knownOverlay(); empty = hidden.

import overlayShader from "../overlay.wgsl?raw";
import { PRELUDE } from "./shaderCommon";

export class OverlayPass {
  private pipeline!: GPURenderPipeline;
  private bind!: GPUBindGroup;
  private buf: GPUBuffer | null = null;
  private count = 0;

  static create(
    device: GPUDevice, format: GPUTextureFormat, uniformBuf: GPUBuffer,
  ): OverlayPass {
    const p = new OverlayPass();
    const module = device.createShaderModule({ code: PRELUDE + overlayShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [{
          arrayStride: 12, stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32" },
          ],
        }],
      },
      fragment: {
        module, entryPoint: "fs",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less" },
    });
    p.bind = device.createBindGroup({
      layout: p.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
    });
    return p;
  }

  set(device: GPUDevice, data: Float32Array) {
    this.count = data.length / 3;
    if (this.count === 0) return;
    if (!this.buf || this.buf.size < data.byteLength) {
      this.buf?.destroy();
      this.buf = device.createBuffer({
        size: Math.max(4096, data.byteLength * 2),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(this.buf, 0, data as BufferSource);
  }

  clear() { this.count = 0; }

  draw(pass: GPURenderPassEncoder) {
    if (!this.buf || this.count === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.setVertexBuffer(0, this.buf);
    pass.draw(6, this.count);
  }
}
