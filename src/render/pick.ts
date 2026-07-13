// Screen-space picking: turn a normalized device coordinate into the ground
// tile under the cursor by casting a ray from the camera through the y=0 plane.

import { invert, type Mat4, type Vec3 } from "../math";

function unproject(inv: Mat4, x: number, y: number, z: number): Vec3 {
  const ix = inv[0] * x + inv[4] * y + inv[8] * z + inv[12];
  const iy = inv[1] * x + inv[5] * y + inv[9] * z + inv[13];
  const iz = inv[2] * x + inv[6] * y + inv[10] * z + inv[14];
  const iw = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
  return [ix / iw, iy / iw, iz / iw];
}

/** NDC (x,y in [-1,1], y up) -> world (x,z) on the ground plane, or null. */
export function pickGround(
  viewProj: Mat4,
  eye: Vec3,
  ndcX: number,
  ndcY: number,
): [number, number] | null {
  const inv = invert(viewProj);
  const far = unproject(inv, ndcX, ndcY, 1);
  const dir: Vec3 = [far[0] - eye[0], far[1] - eye[1], far[2] - eye[2]];
  if (Math.abs(dir[1]) < 1e-6) return null;
  const t = -eye[1] / dir[1];
  if (t <= 0) return null;
  return [eye[0] + dir[0] * t, eye[2] + dir[2] * t];
}
