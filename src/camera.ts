// Orbit camera for a flat ground plane on XZ (y = 0). The look-at TARGET is
// clamped to the world bounds so the camera can never leave the plane.
//   left-drag         orbit (only when no build tool is active)
//   middle-drag       orbit (always)
//   right-drag / WASD  pan
//   wheel              zoom
// When a build tool is active (buildMode), left-drag is reserved for placing.

import {
  clamp, lookAt, multiply, perspective, vadd, vscale, type Mat4, type Vec3,
} from "./math";

export class Camera {
  // Point on the ground the camera looks at (x, 0, z).
  target: Vec3 = [150, 0, 150];
  // Horizontal orbit angle (radians) and zoom distance.
  yaw = Math.PI * 0.25;
  pitch = (58 * Math.PI) / 180; // angle above the ground plane
  distance = 80;

  readonly minDistance = 12;
  readonly maxDistance = 1800;
  // Tilt limits: near the horizon up to nearly straight down (avoids gimbal flip).
  readonly minPitch = (6 * Math.PI) / 180;
  readonly maxPitch = (86 * Math.PI) / 180;

  // Set by the editor: when true, the left button builds instead of orbiting.
  buildMode = false;

  // Keys currently held (lowercased / arrow names).
  private keys = new Set<string>();
  private dragging = false;
  private dragButton = 0; // 0 = left, 1 = middle, 2 = right
  private lastX = 0;
  private lastY = 0;

  constructor(
    private worldSize: number,
    canvas: HTMLCanvasElement,
    // How far past the world edge the camera EYE may go (0 = unconstrained).
    private eyeMargin = 0,
  ) {
    addEventListener("keydown", (e) => {
      this.keys.add(this.norm(e.key));
      if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(this.norm(e.key)))
        e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(this.norm(e.key)));
    addEventListener("blur", () => this.keys.clear());

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.dragButton = e.button;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointerup", (e) => {
      this.dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      // Middle, or left when not building: orbit. Right (or shift): pan.
      const orbit =
        this.dragButton === 1 || (this.dragButton === 0 && !this.buildMode && !e.shiftKey);
      if (orbit) {
        this.yaw -= dx * 0.005;
        this.pitch = clamp(this.pitch - dy * 0.005, this.minPitch, this.maxPitch);
      } else if (this.dragButton === 2 || e.shiftKey) {
        const speed = this.distance * 0.0016;
        this.panBy(-dx * speed, -dy * speed);
      }
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const f = Math.exp(e.deltaY * 0.0012);
        this.distance = clamp(this.distance * f, this.minDistance, this.maxDistance);
      },
      { passive: false },
    );
  }

  private norm(k: string): string {
    return k.length === 1 ? k.toLowerCase() : k.toLowerCase();
  }

  // Move the target in the camera's ground-projected right/forward directions.
  private panBy(right: number, forward: number) {
    const f = this.forwardOnGround();
    const r: Vec3 = [Math.cos(this.yaw), 0, Math.sin(this.yaw)];
    this.target = vadd(this.target, vadd(vscale(r, right), vscale(f, forward)));
    this.clampTarget();
  }

  private forwardOnGround(): Vec3 {
    // Direction the camera faces, flattened onto the ground.
    return [Math.sin(this.yaw), 0, -Math.cos(this.yaw)];
  }

  private clampTarget() {
    this.target[0] = clamp(this.target[0], 0, this.worldSize);
    this.target[2] = clamp(this.target[2], 0, this.worldSize);
    this.target[1] = 0;
  }

  update(dt: number) {
    // Keyboard pan, framerate independent, faster when zoomed out.
    const speed = (this.distance * 0.9 + 10) * dt;
    let r = 0, f = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) f += speed;
    if (this.keys.has("s") || this.keys.has("arrowdown")) f -= speed;
    if (this.keys.has("a") || this.keys.has("arrowleft")) r -= speed;
    if (this.keys.has("d") || this.keys.has("arrowright")) r += speed;
    if (this.keys.has("q")) this.yaw -= dt * 1.2;
    if (this.keys.has("e")) this.yaw += dt * 1.2;
    if (r || f) this.panBy(r, f);
    this.constrainEye();
  }

  // Keep the eye itself inside the world + margin: orbiting or zooming at the
  // map edge drags the target back in instead of swinging the camera out over
  // the void.
  private constrainEye() {
    if (this.eyeMargin <= 0) return;
    const e = this.eye();
    const lo = -this.eyeMargin, hi = this.worldSize + this.eyeMargin;
    let dx = 0, dz = 0;
    if (e[0] < lo) dx = lo - e[0]; else if (e[0] > hi) dx = hi - e[0];
    if (e[2] < lo) dz = lo - e[2]; else if (e[2] > hi) dz = hi - e[2];
    if (dx !== 0 || dz !== 0) {
      this.target = vadd(this.target, [dx, 0, dz]);
      this.clampTarget();
    }
  }

  eye(): Vec3 {
    const horiz = Math.cos(this.pitch) * this.distance;
    const vert = Math.sin(this.pitch) * this.distance;
    return [
      this.target[0] - Math.sin(this.yaw) * horiz,
      this.target[1] + vert,
      this.target[2] + Math.cos(this.yaw) * horiz,
    ];
  }

  viewProj(aspect: number): Mat4 {
    const eye = this.eye();
    const up: Vec3 = [0, 1, 0];
    const view = lookAt(eye, this.target, up);
    // Near/far scale with zoom so precision stays good across the range.
    const proj = perspective((50 * Math.PI) / 180, aspect, 0.5, this.distance * 4 + 600);
    return multiply(proj, view);
  }
}
