// Ground pass: draws the continuous grass/dirt terrain across the whole plane.

import groundShader from "../ground.wgsl?raw";
import { generatePatchMap } from "../patches";
import { createSplatTexture } from "../textures";
import { loadTex } from "./assets";
import { PRELUDE, sceneLightEntries, type SceneLight } from "./shaderCommon";

const SPLAT_RES = 1024;

export class GroundPass {
  private pipeline!: GPURenderPipeline;
  private bindGroup!: GPUBindGroup;

  static async create(
    device: GPUDevice,
    format: GPUTextureFormat,
    uniformBuf: GPUBuffer,
    worldSize: number,
    light: SceneLight,
  ): Promise<GroundPass> {
    const p = new GroundPass();

    const [grassCol, grassNrm, dirtCol, dirtNrm] = await Promise.all([
      loadTex(device, "grass_col", true),
      loadTex(device, "grass_nrm", false),
      loadTex(device, "dirt_col", true),
      loadTex(device, "dirt_nrm", false),
    ]);

    const patch = generatePatchMap(SPLAT_RES, worldSize);
    const splatTex = createSplatTexture(device, patch.data, patch.res);

    const sampRepeat = device.createSampler({
      addressModeU: "repeat", addressModeV: "repeat",
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
      maxAnisotropy: 16,
    });
    // Mirror past the splat's [0,1] range so the border margin continues the
    // grass/dirt patchwork instead of smearing the edge texels into streaks.
    const sampClamp = device.createSampler({
      addressModeU: "mirror-repeat", addressModeV: "mirror-repeat",
      magFilter: "linear", minFilter: "linear",
    });

    const module = device.createShaderModule({ code: PRELUDE + groundShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });

    p.bindGroup = device.createBindGroup({
      layout: p.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: sampRepeat },
        { binding: 2, resource: sampClamp },
        { binding: 3, resource: grassCol.createView() },
        { binding: 4, resource: grassNrm.createView() },
        { binding: 5, resource: dirtCol.createView() },
        { binding: 6, resource: dirtNrm.createView() },
        { binding: 7, resource: splatTex.createView() },
        ...sceneLightEntries(light),
      ],
    });
    return p;
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6);
  }
}
