// Buildable material registries. `col`/`nrm` are logical texture names resolved
// by assets.loadTex (compressed KTX where available, else raw). `swatch` colors
// the palette buttons in the build HUD.

export interface FloorMat {
  id: number;
  name: string;
  col: string;
  nrm: string;
  swatch: string;
  buildable?: boolean;
}

export const FLOOR_MATS: FloorMat[] = [
  { id: 1, name: "Concrete", col: "floor2_col", nrm: "floor2_nrm", swatch: "#8c8f93" },
  { id: 2, name: "Worn Concrete", col: "concrete_col", nrm: "concrete_nrm", swatch: "#bdb9b1" },
  { id: 3, name: "Wood", col: "wood_col", nrm: "wood_nrm", swatch: "#b98a57" },
  { id: 4, name: "Metal", col: "galv_col", nrm: "galv_nrm", swatch: "#b7bbc0" },
  // Infrastructure-only. They are intentionally absent from Editor's floor
  // catalog (the editor filters these by `buildable`).
  { id: 5, name: "Road Black", col: "black_col", nrm: "black_nrm", swatch: "#17191b", buildable: false },
  { id: 6, name: "Road White", col: "white_col", nrm: "floor2_nrm", swatch: "#f4f4ef", buildable: false },
];

export interface WallMat {
  id: number;
  name: string;
  col: string;
  nrm: string;
  swatch: string;
}

export const WALL_MATS: WallMat[] = [
  { id: 1, name: "Rammed Earth", col: "wall_col", nrm: "wall_nrm", swatch: "#cdbda6" },
  { id: 2, name: "Corroded Metal", col: "corroded_col", nrm: "corroded_nrm", swatch: "#8a7b6b" },
  { id: 3, name: "Galvanized", col: "galv_col", nrm: "galv_nrm", swatch: "#b7bbc0" },
];

// Fence uses one of the new metals.
export const FENCE_MAT = { id: 1, col: "galv_col" };

export function floorMat(id: number): FloorMat | undefined {
  return FLOOR_MATS.find((m) => m.id === id);
}
export function wallMat(id: number): WallMat | undefined {
  return WALL_MATS.find((m) => m.id === id);
}
