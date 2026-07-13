// Door pass: instanced wood leaf (fills the opening fully) + black handle.
// One mesh authored for an X-running wall; orient=1 rotates it (X/Z swap).

import doorShader from "../door.wgsl?raw";
import { loadTex } from "./assets";
import { DOOR_H, DOOR_T, DOOR_W, PRELUDE, sceneLightEntries, type SceneLight } from "./shaderCommon";

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

function leafMesh(): Float32Array {
  const hw = DOOR_W / 2, ht = DOOR_T / 2;
  return new Float32Array(box(0.5 - hw, 0.5 + hw, 0.0, DOOR_H, 0.5 - ht, 0.5 + ht));
}
function handleMesh(): Float32Array {
  return new Float32Array(box(0.74, 0.84, 1.0, 1.22, 0.41, 0.59));
}

// Jail door: steel frame with vertical bars filling the opening.
function jailMesh(): Float32Array {
  const out: number[] = [
    ...box(0.02, 0.10, 0.0, DOOR_H, 0.45, 0.55), // stiles
    ...box(0.90, 0.98, 0.0, DOOR_H, 0.45, 0.55),
    ...box(0.02, 0.98, DOOR_H - 0.12, DOOR_H, 0.45, 0.55), // rails
    ...box(0.02, 0.98, 1.42, 1.52, 0.45, 0.55),
    ...box(0.02, 0.98, 0.0, 0.10, 0.45, 0.55),
    ...box(0.72, 0.88, 1.20, 1.42, 0.44, 0.56), // lock box
  ];
  for (let n = 0; n < 6; n++) {
    const bx = 0.165 + n * 0.122;
    out.push(...box(bx, bx + 0.05, 0.10, DOOR_H - 0.12, 0.475, 0.525));
  }
  return new Float32Array(out);
}

export class DoorPass {
  private pipeline!: GPURenderPipeline;
  private woodBind!: GPUBindGroup;
  private blackBind!: GPUBindGroup;
  private steelBind!: GPUBindGroup;
  private leafBuf!: GPUBuffer;
  private leafVerts = 0;
  private handleBuf!: GPUBuffer;
  private handleVerts = 0;
  private jailBuf!: GPUBuffer;
  private jailVerts = 0;
  private instanceBuf: GPUBuffer | null = null;
  private count = 0;
  private jailInstanceBuf: GPUBuffer | null = null;
  private jailCount = 0;

  static async create(
    device: GPUDevice,
    format: GPUTextureFormat,
    uniformBuf: GPUBuffer,
    light: SceneLight,
  ): Promise<DoorPass> {
    const p = new DoorPass();

    const [wood, black, steel] = await Promise.all([
      loadTex(device, "wood_col", true),
      loadTex(device, "black_col", true),
      loadTex(device, "galv_col", true),
    ]);

    const sampRepeat = device.createSampler({
      addressModeU: "repeat", addressModeV: "repeat",
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 16,
    });

    const upload = (m: Float32Array): [GPUBuffer, number] => {
      const buf = device.createBuffer({ size: m.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, m as BufferSource);
      return [buf, m.length / 3];
    };
    [p.leafBuf, p.leafVerts] = upload(leafMesh());
    [p.handleBuf, p.handleVerts] = upload(handleMesh());
    [p.jailBuf, p.jailVerts] = upload(jailMesh());

    const module = device.createShaderModule({ code: PRELUDE + doorShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [
          { arrayStride: 12, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
          {
            arrayStride: 16, stepMode: "instance",
            attributes: [
              { shaderLocation: 2, offset: 0, format: "float32x2" },
              { shaderLocation: 3, offset: 8, format: "float32" },
              { shaderLocation: 4, offset: 12, format: "float32" }, // open (jail doors)
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });

    const mkBind = (view: GPUTextureView) =>
      device.createBindGroup({
        layout: p.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuf } },
          { binding: 1, resource: sampRepeat },
          { binding: 2, resource: view },
          ...sceneLightEntries(light),
        ],
      });
    p.woodBind = mkBind(wood.createView());
    p.blackBind = mkBind(black.createView());
    p.steelBind = mkBind(steel.createView());
    return p;
  }

  setInstances(device: GPUDevice, doors: Float32Array, jailDoors: Float32Array) {
    const upload = (data: Float32Array, old: GPUBuffer | null): [GPUBuffer | null, number] => {
      old?.destroy();
      if (data.length === 0) return [null, 0];
      const buf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, data as BufferSource);
      return [buf, data.length / 4];
    };
    [this.instanceBuf, this.count] = upload(doors, this.instanceBuf);
    [this.jailInstanceBuf, this.jailCount] = upload(jailDoors, this.jailInstanceBuf);
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.instanceBuf && !this.jailInstanceBuf) return;
    pass.setPipeline(this.pipeline);
    if (this.instanceBuf) {
      pass.setVertexBuffer(1, this.instanceBuf);
      pass.setBindGroup(0, this.woodBind);
      pass.setVertexBuffer(0, this.leafBuf);
      pass.draw(this.leafVerts, this.count);
      pass.setBindGroup(0, this.blackBind);
      pass.setVertexBuffer(0, this.handleBuf);
      pass.draw(this.handleVerts, this.count);
    }
    if (this.jailInstanceBuf) {
      pass.setVertexBuffer(1, this.jailInstanceBuf);
      pass.setBindGroup(0, this.steelBind);
      pass.setVertexBuffer(0, this.jailBuf);
      pass.draw(this.jailVerts, this.jailCount);
    }
  }
}
