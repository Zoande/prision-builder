// Buildable material registries. `col`/`nrm` are logical texture names resolved
// by assets.loadTex (compressed KTX where available, else raw). `swatch` colors
// the palette buttons in the build HUD.

export interface FloorMat {
  id: number;
  name: string;
  col: string;
  nrm: string;
  swatch: string;
}

export const FLOOR_MATS: FloorMat[] = [
  { id: 1, name: "Concrete", col: "floor2_col", nrm: "floor2_nrm", swatch: "#8c8f93" },
  { id: 2, name: "Worn Concrete", col: "concrete_col", nrm: "concrete_nrm", swatch: "#bdb9b1" },
  { id: 3, name: "Wood", col: "wood_col", nrm: "wood_nrm", swatch: "#b98a57" },
  { id: 4, name: "Metal", col: "galv_col", nrm: "galv_nrm", swatch: "#b7bbc0" },
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
