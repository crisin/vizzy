// Append-only instanced pools. Capacity is allocated once per plant slot;
// spawning writes one matrix + a few attribute floats and bumps `count`.
// Recycling a slot is `reset()` — counters back to zero, no compaction,
// no reallocation, fixed memory for the whole garden lifetime.

import * as THREE from "three";

export interface SpawnData {
  birth: number;
  sway?: number;
  rad0?: number;
  rad1?: number;
  phase?: number;
  scale?: number;
  /** petals: bloom trigger timestamp, 0 = still closed */
  open?: number;
}

export class InstancedPool {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
  private used = 0;
  private aBirth: THREE.InstancedBufferAttribute;
  private aSway: THREE.InstancedBufferAttribute;
  private aRad: THREE.InstancedBufferAttribute;
  private aPhase: THREE.InstancedBufferAttribute;
  private aScale: THREE.InstancedBufferAttribute;
  private aOpen: THREE.InstancedBufferAttribute;
  private dirty = false;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.ShaderMaterial,
    capacity: number,
  ) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // grows at runtime; skip stale bounds
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const make = (items: number) => {
      const attr = new THREE.InstancedBufferAttribute(
        new Float32Array(capacity * items),
        items,
      );
      attr.setUsage(THREE.DynamicDrawUsage);
      return attr;
    };
    this.aBirth = make(1);
    this.aSway = make(1);
    this.aRad = make(2);
    this.aPhase = make(1);
    this.aScale = make(1);
    this.aOpen = make(1);
    geometry.setAttribute("aBirth", this.aBirth);
    geometry.setAttribute("aSway", this.aSway);
    geometry.setAttribute("aRad", this.aRad);
    geometry.setAttribute("aPhase", this.aPhase);
    geometry.setAttribute("aScale", this.aScale);
    geometry.setAttribute("aOpen", this.aOpen);
  }

  get count(): number {
    return this.used;
  }

  get full(): boolean {
    return this.used >= this.capacity;
  }

  /** Occupancy 0..1 — the lifecycle uses this to decide when to bloom. */
  get fill(): number {
    return this.used / this.capacity;
  }

  /** Returns the instance index, or -1 when the pool is exhausted. */
  spawn(matrix: THREE.Matrix4, data: SpawnData): number {
    if (this.used >= this.capacity) return -1;
    const i = this.used++;
    this.mesh.setMatrixAt(i, matrix);
    this.aBirth.setX(i, data.birth);
    this.aSway.setX(i, data.sway ?? 0);
    this.aRad.setXY(i, data.rad0 ?? 1, data.rad1 ?? 1);
    this.aPhase.setX(i, data.phase ?? 0);
    this.aScale.setX(i, data.scale ?? 1);
    this.aOpen.setX(i, data.open ?? 0);
    this.dirty = true;
    return i;
  }

  /** Petals: flip a closed bud to "open at timestamp t". */
  setOpen(index: number, t: number) {
    this.aOpen.setX(index, t);
    this.dirty = true;
  }

  /** Push this frame's spawns to the GPU (no-op when nothing changed). */
  commit() {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aBirth.needsUpdate = true;
    this.aSway.needsUpdate = true;
    this.aRad.needsUpdate = true;
    this.aPhase.needsUpdate = true;
    this.aScale.needsUpdate = true;
    this.aOpen.needsUpdate = true;
    this.mesh.count = this.used;
  }

  reset() {
    this.used = 0;
    this.mesh.count = 0;
    this.dirty = false;
  }

  dispose() {
    // geometry is pool-owned (cloned per pool so attribute sets don't clash)
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

// ------------------------------------------------------- base geometries ---
// Authored once, cloned per pool (each pool needs its own attribute set).

/** Unit stem segment: open cylinder, base at y=0, unit radius (the shader
 *  applies per-instance taper), length 1 scaled via instance matrix. */
export function segmentGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  g.translate(0, 0.5, 0);
  return g;
}

/** Unit leaf/petal plane: base at y=0, 1 wide, 1 long, a few length
 *  divisions so the vertex-shader curl actually bends it. */
export function bladeGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 1, 6);
  g.translate(0, 0.5, 0);
  return g;
}

/** Thin spine cone, base at y=0, pointing +y. */
export function spineGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.006, 0.028, 1, 4, 1);
  g.translate(0, 0.5, 0);
  return g;
}
