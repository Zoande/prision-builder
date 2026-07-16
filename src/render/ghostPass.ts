import ghostShader from "../ghost.wgsl?raw";
import type { GhostTarget } from "../sim/construction.ts";
import { OBJ_DEFS, Obj, defOf } from "../sim/world.ts";
import { furnitureMeshRegistry } from "./furniturePass.ts";
import { PRELUDE } from "./shaderCommon.ts";

interface Slot { kind: number; vertex: GPUBuffer; vertices: number; instances: GPUBuffer | null; count: number }

const FLOOR_GHOST = -1, WALL_GHOST = -2, FENCE_GHOST = -3, FIXTURE_GHOST = -4;

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Float32Array {
  const out: number[] = [];
  const v = (x: number, y: number, z: number) => out.push(x, y, z, 0);
  const q = (a: number[], b: number[], c: number[], d: number[]) => {
    for (const p of [a, b, c, a, c, d]) v(p[0], p[1], p[2]);
  };
  q([x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]); q([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]);
  q([x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0]); q([x1,y0,z1],[x0,y0,z1],[x0,y1,z1],[x1,y1,z1]);
  q([x0,y0,z1],[x0,y0,z0],[x0,y1,z0],[x0,y1,z1]); q([x1,y0,z0],[x1,y0,z1],[x1,y1,z1],[x1,y1,z0]);
  return new Float32Array(out);
}

export class GhostPass {
  private pipeline!: GPURenderPipeline;
  private bind!: GPUBindGroup;
  private slots: Slot[] = [];

  static create(device: GPUDevice, format: GPUTextureFormat, uniform: GPUBuffer): GhostPass {
    const pass = new GhostPass();
    const module = device.createShaderModule({ code: PRELUDE + ghostShader });
    pass.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs", buffers: [
        { arrayStride: 16, stepMode: "vertex", attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32" },
        ] },
        { arrayStride: 16, stepMode: "instance", attributes: [
          { shaderLocation: 2, offset: 0, format: "float32x2" }, { shaderLocation: 3, offset: 8, format: "float32" },
          { shaderLocation: 4, offset: 12, format: "float32" },
        ] },
      ] },
      fragment: { module, entryPoint: "fs", targets: [{ format, blend: {
        color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      } }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
    });
    pass.bind = device.createBindGroup({ layout: pass.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    const meshes = furnitureMeshRegistry();
    for (const def of OBJ_DEFS) if (def.place === "piece" && !meshes.has(def.kind)) {
      meshes.set(def.kind, box(0.08, Math.max(0.92, def.w - 0.08), 0.03, 0.62, 0.08, Math.max(0.92, def.d - 0.08)));
    }
    meshes.set(FLOOR_GHOST, box(0.03, 0.97, 0.04, 0.08, 0.03, 0.97));
    meshes.set(WALL_GHOST, box(0.04, 0.96, 0, 2.65, 0.36, 0.64));
    meshes.set(FENCE_GHOST, box(0.04, 0.96, 0, 2.35, 0.45, 0.55));
    meshes.set(FIXTURE_GHOST, box(0.18, 0.82, 0, 2.25, 0.38, 0.62));
    for (const [kind, mesh] of meshes) {
      const vertex = device.createBuffer({ size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(vertex, 0, mesh as BufferSource);
      pass.slots.push({ kind, vertex, vertices: mesh.length / 4, instances: null, count: 0 });
    }
    return pass;
  }

  set(device: GPUDevice, ghosts: readonly GhostTarget[]): void {
    const buckets = new Map<number, number[]>();
    for (const ghost of ghosts) {
      const kind = this.meshKind(ghost);
      let bucket = buckets.get(kind); if (!bucket) buckets.set(kind, bucket = []);
      bucket.push(ghost.x, ghost.z, ghost.orient, ghost.operation === "demolish" || !ghost.valid ? 1 : 0);
    }
    for (const slot of this.slots) {
      const values = buckets.get(slot.kind);
      slot.count = 0;
      if (!values?.length) continue;
      const data = new Float32Array(values);
      if (!slot.instances || slot.instances.size < data.byteLength) {
        slot.instances?.destroy();
        slot.instances = device.createBuffer({
          size: Math.max(256, data.byteLength * 2), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
      }
      device.queue.writeBuffer(slot.instances, 0, data as BufferSource);
      slot.count = values.length / 4;
    }
  }

  draw(render: GPURenderPassEncoder): void {
    render.setPipeline(this.pipeline); render.setBindGroup(0, this.bind);
    for (const slot of this.slots) if (slot.instances && slot.count > 0) {
      render.setVertexBuffer(0, slot.vertex); render.setVertexBuffer(1, slot.instances);
      render.draw(slot.vertices, slot.count);
    }
  }

  private meshKind(ghost: GhostTarget): number {
    if (ghost.cat === "floor") return FLOOR_GHOST;
    if (ghost.cat === "wall") return WALL_GHOST;
    if (ghost.cat === "fence") return FENCE_GHOST;
    if (ghost.cat === "piece" && defOf(ghost.mat)) return ghost.mat;
    if (ghost.cat === "fencedoor" || ghost.cat === "fencejaildoor") return ghost.cat === "fencedoor" ? Obj.FenceDoor : Obj.FenceJailDoor;
    return FIXTURE_GHOST;
  }
}
