// People pass: instanced box-doll prisoners, guards and cooks. Meshes share
// one doll recipe (prisoner: hair; guard: cap with brim; cook: chef hat),
// with part ids offset by 8 per kind so one shader palette serves all.
// Everyone's mesh includes a hip baton that the shader hides unless the
// instance's baton flag is set.

import personShader from "../person.wgsl?raw";
import { PRELUDE, sceneLightEntries, type SceneLight } from "./shaderCommon";

// Box tagged with `part` on every vertex (pos3 + part1), no bottom face.
function box(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, part: number,
): number[] {
  const out: number[] = [];
  const v = (x: number, y: number, z: number) => out.push(x, y, z, part);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    for (const p of [a, b, c, a, c, d]) v(p[0], p[1], p[2]);
  };
  quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]); // top
  quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]);
  quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]);
  quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
  return out;
}

// A ~1.75-unit person standing at the tile centre, facing +X. Parts (+kind
// offset): 0 skin, 1 headwear, 2 torso, 3 arms, 4 legs, 5 shoes, 6 baton.
function doll(o: number, hat: "hair" | "cap" | "chef"): Float32Array {
  const out: number[] = [
    ...box(0.42, 0.62, 0.00, 0.10, 0.505, 0.575, o + 5), // left shoe (toe +X)
    ...box(0.42, 0.62, 0.00, 0.10, 0.425, 0.495, o + 5), // right shoe
    ...box(0.44, 0.56, 0.10, 0.85, 0.505, 0.585, o + 4), // left leg
    ...box(0.44, 0.56, 0.10, 0.85, 0.415, 0.495, o + 4), // right leg
    ...box(0.42, 0.58, 0.85, 1.42, 0.38, 0.62, o + 2),   // torso
    ...box(0.44, 0.56, 0.85, 1.40, 0.63, 0.71, o + 3),   // left arm
    ...box(0.44, 0.56, 0.85, 1.40, 0.29, 0.37, o + 3),   // right arm
    ...box(0.43, 0.57, 1.46, 1.70, 0.43, 0.57, o + 0),   // head
    ...box(0.47, 0.53, 0.50, 0.88, 0.615, 0.675, o + 6), // hip baton (shader-gated)
    ...box(0.62, 0.86, 1.32, 1.36, 0.34, 0.66, o + 7),   // meal tray (shader-gated)
  ];
  if (hat === "cap") {
    out.push(
      ...box(0.41, 0.59, 1.68, 1.77, 0.41, 0.59, o + 1), // cap crown
      ...box(0.57, 0.70, 1.68, 1.71, 0.44, 0.56, o + 1), // brim, forward
    );
  } else if (hat === "chef") {
    out.push(...box(0.42, 0.58, 1.68, 1.92, 0.42, 0.58, o + 1)); // toque
  } else {
    out.push(...box(0.42, 0.58, 1.68, 1.75, 0.42, 0.58, o + 1)); // hair
  }
  return new Float32Array(out);
}

interface Slot { buf: GPUBuffer; verts: number; inst: GPUBuffer | null; count: number; }

export class PeoplePass {
  private pipeline!: GPURenderPipeline;
  private bind!: GPUBindGroup;
  private slots: Slot[] = [];

  static create(
    device: GPUDevice, format: GPUTextureFormat, uniformBuf: GPUBuffer, light: SceneLight,
  ): PeoplePass {
    const p = new PeoplePass();
    const module = device.createShaderModule({ code: PRELUDE + personShader });
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
            arrayStride: 32, stepMode: "instance",
            attributes: [
              { shaderLocation: 2, offset: 0, format: "float32x2" },  // pos
              { shaderLocation: 3, offset: 8, format: "float32" },    // heading
              { shaderLocation: 4, offset: 12, format: "float32" },   // baton
              { shaderLocation: 5, offset: 16, format: "float32" },   // pose
              { shaderLocation: 6, offset: 20, format: "float32" },   // phase
              { shaderLocation: 7, offset: 24, format: "float32" },   // amp
              { shaderLocation: 8, offset: 28, format: "float32" },   // cuffed
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
        ...sceneLightEntries(light),
      ],
    });

    for (const mesh of [doll(0, "hair"), doll(8, "cap"), doll(16, "chef"), doll(24, "cap")]) {
      const buf = device.createBuffer({ size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, mesh as BufferSource);
      p.slots.push({ buf, verts: mesh.length / 4, inst: null, count: 0 });
    }
    return p;
  }

  /** Per-frame agent upload; buffers grow but are reused between frames. */
  update(
    device: GPUDevice,
    data: { prisoners: Float32Array; guards: Float32Array; cooks: Float32Array; workmen: Float32Array },
  ) {
    const arrays = [data.prisoners, data.guards, data.cooks, data.workmen];
    for (let i = 0; i < arrays.length; i++) {
      const slot = this.slots[i];
      slot.count = arrays[i].length / 8;
      if (slot.count === 0) continue;
      if (!slot.inst || slot.inst.size < arrays[i].byteLength) {
        slot.inst?.destroy();
        slot.inst = device.createBuffer({
          size: Math.max(1024, arrays[i].byteLength * 2),
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }
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
