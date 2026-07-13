// Sky pass: one fullscreen triangle at the far plane, drawn after the opaque
// scene (depth-tested less-equal against the cleared 1.0, so it only fills
// pixels nothing else touched) and before the translucent roof.

import skyShader from "../sky.wgsl?raw";
import { PRELUDE } from "./shaderCommon";

export class SkyPass {
  private pipeline!: GPURenderPipeline;
  private bind!: GPUBindGroup;

  static create(
    device: GPUDevice, format: GPUTextureFormat, uniformBuf: GPUBuffer,
  ): SkyPass {
    const p = new SkyPass();
    const module = device.createShaderModule({ code: PRELUDE + skyShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
    });
    p.bind = device.createBindGroup({
      layout: p.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
    });
    return p;
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.draw(3);
  }
}
