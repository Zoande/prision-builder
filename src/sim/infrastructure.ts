import { Obj, RoomType, World } from "./world.ts";

export const ROAD_X0 = 372;
export const ROAD_X1 = 377;
export const ROAD_BLACK = 5;
export const ROAD_WHITE = 6;

export class InfrastructureSystem {
  readonly world: World;
  constructor(world: World) { this.world = world; }

  installNewGame(): void {
    this.installRoad();
    this.installStarterDeliveryYard();
  }

  installRoad(): void {
    for (let z = 0; z < this.world.size; z++) {
      for (let x = ROAD_X0; x <= ROAD_X1; x++) {
        const marking = x === ROAD_X0 || x === ROAD_X1 || x === 375;
        this.world.setInfrastructureFloor(x, z, marking ? ROAD_WHITE : ROAD_BLACK);
      }
    }
  }

  private installStarterDeliveryYard(): void {
    // Six-by-six clear yard with a fence one tile outside it. The road-facing
    // gate is on the east boundary and the pallet is inside the yard.
    for (let x = 363; x <= 370; x++) {
      this.world.setFence(x, 371, 1);
      this.world.setFence(x, 378, 1);
    }
    for (let z = 372; z <= 377; z++) {
      this.world.setFence(363, z, 1);
      this.world.setFence(370, z, 1);
    }
    this.world.setFenceGate(370, 375, false);
    this.world.placePiece(367, 374, Obj.LoadingPallet, 0);
    this.world.recomputeRoofs();
    this.world.recomputeRooms();
    const id = this.world.startRoomPaint(364, 372, RoomType.Delivery);
    if (id > 0) {
      for (let z = 372; z <= 377; z++) for (let x = 364; x <= 369; x++) {
        this.world.paintRoomInto(x, z, id);
      }
      this.world.endRoomPaint(id);
    }
  }

  isRoad(x: number, z: number): boolean {
    return this.world.inBounds(x, z) && x >= ROAD_X0 && x <= ROAD_X1;
  }

  saveData() { return { roadX0: ROAD_X0, roadX1: ROAD_X1 }; }
  loadData(_data: unknown): void { this.installRoad(); }
}
