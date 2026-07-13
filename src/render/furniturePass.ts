// Furniture pass: instanced flat-colored props — toilet, shower, drain,
// fence gates (open/guard-only), table, benches, cooker. Box meshes with a
// per-vertex palette index (see furniture.wgsl); one pipeline, one draw per
// furniture kind.

import furnitureShader from "../furniture.wgsl?raw";
import { FOOD_KIND, HOLE_ENTRY_KIND, HOLE_SURF_KIND, TRAY_STACK_KIND } from "../sim/agents";
import { Obj } from "../sim/world";
import { FENCE_H, PRELUDE, sceneLightEntries, type SceneLight } from "./shaderCommon";

// Palette indices (mirror furniture.wgsl).
const CERAMIC = 0, CERAMIC_DK = 1, STEEL = 2, DARK = 3, BLACK = 4;
const ORANGE = 5, RED = 6, TABLE = 7, SEAT = 8, CHROME = 9, LINK = 10, STOVE = 11;
const FOOD_A = 12, FOOD_B = 13;

// Box tagged with a palette index on every vertex (pos3 + part1), no bottom.
function box(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, part: number,
): number[] {
  const out: number[] = [];
  const v = (x: number, y: number, z: number) => out.push(x, y, z, part);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    for (const p of [a, b, c, a, c, d]) v(p[0], p[1], p[2]);
  };
  quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]); // top
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // bottom
  quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]);
  quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]);
  quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
  return out;
}

// Toilet, facing +X: tank at the back, bowl, seat, flush button.
const toiletMesh = () => new Float32Array([
  ...box(0.30, 0.55, 0.00, 0.15, 0.42, 0.58, CERAMIC_DK),
  ...box(0.28, 0.62, 0.15, 0.38, 0.36, 0.64, CERAMIC),
  ...box(0.26, 0.64, 0.38, 0.44, 0.34, 0.66, SEAT),
  ...box(0.12, 0.26, 0.15, 0.78, 0.34, 0.66, CERAMIC),
  ...box(0.16, 0.22, 0.78, 0.82, 0.45, 0.55, CHROME),
]);

// Shower: pipe up the back of the tile, arm forward (+X), head angled down.
const showerMesh = () => new Float32Array([
  ...box(0.10, 0.16, 0.00, 2.10, 0.47, 0.53, CHROME),
  ...box(0.10, 0.42, 2.10, 2.16, 0.47, 0.53, CHROME),
  ...box(0.30, 0.48, 2.02, 2.10, 0.41, 0.59, STEEL),
  ...box(0.31, 0.47, 2.00, 2.03, 0.42, 0.58, DARK),
]);

// Floor drain: recessed plate with grate strips.
const drainMesh = () => {
  const out = [...box(0.30, 0.70, 0.030, 0.055, 0.30, 0.70, DARK)];
  for (const z of [0.36, 0.48, 0.60]) out.push(...box(0.34, 0.66, 0.055, 0.058, z, z + 0.04, BLACK));
  return new Float32Array(out);
};

// Fence gate (accent = ORANGE for open, RED for guard-only): full-height
// jambs with a chain-link leaf, transom above, and two accent stripes.
function fenceGateMesh(accent: number): Float32Array {
  const H = FENCE_H;
  return new Float32Array([
    ...box(0.03, 0.10, 0, H - 0.05, 0.45, 0.55, STEEL), // jambs
    ...box(0.90, 0.97, 0, H - 0.05, 0.45, 0.55, STEEL),
    ...box(0.03, 0.97, H - 0.13, H - 0.05, 0.45, 0.55, STEEL), // top rail
    ...box(0.08, 0.92, 1.96, 2.04, 0.46, 0.54, STEEL), // gate header
    ...box(0.10, 0.90, 0.06, 0.13, 0.46, 0.54, STEEL), // gate bottom rail
    ...box(0.10, 0.90, 0.13, 1.96, 0.492, 0.508, LINK), // gate leaf mesh
    ...box(0.10, 0.90, 2.04, H - 0.13, 0.492, 0.508, LINK), // transom mesh
    ...box(0.12, 0.88, 1.02, 1.16, 0.44, 0.56, accent), // stripes
    ...box(0.12, 0.88, 0.44, 0.58, 0.44, 0.56, accent),
    ...box(0.80, 0.90, 0.95, 1.25, 0.43, 0.57, DARK), // latch box
  ]);
}

// Canteen table: white top on steel legs.
const tableMesh = () => new Float32Array([
  ...box(0.08, 0.92, 0.72, 0.78, 0.08, 0.92, TABLE),
  ...box(0.10, 0.16, 0.00, 0.72, 0.10, 0.16, STEEL),
  ...box(0.84, 0.90, 0.00, 0.72, 0.10, 0.16, STEEL),
  ...box(0.10, 0.16, 0.00, 0.72, 0.84, 0.90, STEEL),
  ...box(0.84, 0.90, 0.00, 0.72, 0.84, 0.90, STEEL),
]);

// Bench spanning `len` tiles along +X: seat plank + slab legs.
function benchMesh(len: number): Float32Array {
  const out = [
    ...box(0.10, len - 0.10, 0.42, 0.50, 0.30, 0.70, SEAT),
    ...box(0.16, 0.24, 0.00, 0.42, 0.32, 0.68, STEEL),
    ...box(len - 0.24, len - 0.16, 0.00, 0.42, 0.32, 0.68, STEEL),
  ];
  if (len >= 4) out.push(...box(len / 2 - 0.04, len / 2 + 0.04, 0.00, 0.42, 0.32, 0.68, STEEL));
  return new Float32Array(out);
}

// Cut fence: the tile keeps its centre post and rails, but the chain-link
// panel is torn open in the middle with curled edges. Authored along X.
function cutFenceMesh(): Float32Array {
  const H = FENCE_H;
  return new Float32Array([
    ...box(0.43, 0.57, 0, H + 0.45, 0.43, 0.57, STEEL), // post
    ...box(0.0, 1.0, H - 0.12, H - 0.02, 0.46, 0.54, STEEL), // top rail
    ...box(0.0, 1.0, 0.06, 0.14, 0.46, 0.54, STEEL), // bottom rail
    ...box(0.0, 1.0, 1.7, H - 0.08, 0.492, 0.508, LINK), // intact upper panel
    ...box(0.0, 0.16, 0.10, 1.7, 0.492, 0.508, LINK), // side scraps
    ...box(0.84, 1.0, 0.10, 1.7, 0.492, 0.508, LINK),
    ...box(0.14, 0.24, 0.14, 1.55, 0.46, 0.56, DARK), // curled edges
    ...box(0.76, 0.86, 0.14, 1.55, 0.44, 0.54, DARK),
  ]);
}

// Tunnel entry: the hole beside a displaced toilet, plus a dirt spill.
const holeEntryMesh = () => new Float32Array([
  ...box(0.52, 0.96, 0.012, 0.04, 0.24, 0.76, BLACK),
  ...box(0.44, 1.0, 0.04, 0.10, 0.16, 0.84, 12 /* dirt */),
  ...box(0.52, 0.96, 0.10, 0.115, 0.24, 0.76, BLACK),
]);

// Surfacing hole: a dark pit with a dirt ring.
const holeSurfMesh = () => new Float32Array([
  ...box(0.14, 0.86, 0.04, 0.11, 0.10, 0.90, 12 /* dirt */),
  ...box(0.22, 0.78, 0.11, 0.125, 0.18, 0.82, BLACK),
  ...box(0.22, 0.78, 0.012, 0.05, 0.18, 0.82, BLACK),
]);

// Serving table: a counter with a tray rail; trays stack on top when stocked.
const servingTableMesh = () => new Float32Array([
  ...box(0.06, 0.94, 0.00, 0.86, 0.20, 0.80, STEEL),
  ...box(0.00, 1.00, 0.86, 0.94, 0.12, 0.88, TABLE),
  ...box(0.02, 0.98, 0.70, 0.74, 0.06, 0.12, CHROME), // tray rail (front, +Z... -Z side)
]);

// Stack of trays shown while a serving table has stock.
const trayStackMesh = () => new Float32Array([
  ...box(0.28, 0.72, 0.94, 0.975, 0.30, 0.70, DARK),
  ...box(0.32, 0.68, 0.975, 1.005, 0.34, 0.66, DARK),
  ...box(0.38, 0.58, 1.005, 1.05, 0.40, 0.60, FOOD_A),
]);

// Meal tray sitting on a table top (top at y 0.78).
const foodMesh = () => new Float32Array([
  ...box(0.32, 0.68, 0.785, 0.815, 0.36, 0.64, DARK),
  ...box(0.37, 0.52, 0.815, 0.87, 0.42, 0.58, FOOD_A),
  ...box(0.55, 0.64, 0.815, 0.85, 0.44, 0.56, FOOD_B),
]);

// Cooker: steel body, dark hob with four burners, front handle (+X).
const cookerMesh = () => {
  const out = [
    ...box(0.10, 0.90, 0.00, 0.82, 0.10, 0.90, STEEL),
    ...box(0.08, 0.92, 0.82, 0.88, 0.08, 0.92, STOVE),
    ...box(0.90, 0.96, 0.50, 0.56, 0.18, 0.82, CHROME),
  ];
  for (const [cx, cz] of [[0.32, 0.32], [0.32, 0.68], [0.68, 0.32], [0.68, 0.68]]) {
    out.push(...box(cx - 0.11, cx + 0.11, 0.88, 0.905, cz - 0.11, cz + 0.11, BLACK));
  }
  return new Float32Array(out);
};

interface Slot { kind: number; buf: GPUBuffer; verts: number; inst: GPUBuffer | null; count: number; }

export class FurniturePass {
  private pipeline!: GPURenderPipeline;
  private bind!: GPUBindGroup;
  private slots: Slot[] = [];

  static create(
    device: GPUDevice, format: GPUTextureFormat, uniformBuf: GPUBuffer, light: SceneLight,
  ): FurniturePass {
    const p = new FurniturePass();
    const module = device.createShaderModule({ code: PRELUDE + furnitureShader });
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
        ...sceneLightEntries(light),
      ],
    });

    const meshes: [number, Float32Array][] = [
      [Obj.Toilet, toiletMesh()],
      [Obj.Shower, showerMesh()],
      [Obj.Drain, drainMesh()],
      [Obj.FenceDoor, fenceGateMesh(ORANGE)],
      [Obj.FenceJailDoor, fenceGateMesh(RED)],
      [Obj.Table, tableMesh()],
      [Obj.Bench2, benchMesh(2)],
      [Obj.Bench4, benchMesh(4)],
      [Obj.Cooker, cookerMesh()],
      [Obj.CutFence, cutFenceMesh()],
      [Obj.ServingTable, servingTableMesh()],
      [FOOD_KIND, foodMesh()],
      [TRAY_STACK_KIND, trayStackMesh()],
      [HOLE_ENTRY_KIND, holeEntryMesh()],
      [HOLE_SURF_KIND, holeSurfMesh()],
    ];
    for (const [kind, mesh] of meshes) {
      const buf = device.createBuffer({ size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, mesh as BufferSource);
      p.slots.push({ kind, buf, verts: mesh.length / 4, inst: null, count: 0 });
    }
    return p;
  }

  setInstances(device: GPUDevice, byKind: Map<number, Float32Array>) {
    for (const slot of this.slots) {
      const data = byKind.get(slot.kind);
      slot.inst?.destroy();
      if (!data || data.length === 0) { slot.inst = null; slot.count = 0; continue; }
      slot.inst = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(slot.inst, 0, data as BufferSource);
      slot.count = data.length / 3;
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
