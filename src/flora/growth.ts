// The budding automaton — the L-system idea folded into per-species rules
// that run as a stream of growth events instead of a rewritten string.
// Every event spawns instances into the pools exactly once; the shaders own
// all animation from there.
//
// Species:
//   bloom  — flowering stem plant: branches, leaves, terminal buds whose
//            petals hinge open (the tulip reference)
//   grass  — a tuft of thin, tall, heavily swaying blades
//   cactus — a CHAIN of pads budding out of each other, offset less than
//            their radii so they visibly grow into one another, each pad
//            bursting phyllotaxis spine fans (the DAY-70 reference, unhinged)
//
// Every plant additionally rolls TRAITS at planting time — twist (spiral
// growth), curl (hooks and coils), gravity bias (climbers vs. creepers),
// knobble (bumpy stems) and size — so no two plants grow the same way and
// some get properly weird.
//
// Lifecycle per plant: growing → blooming → withering → replant. The garden
// never stops — memory stays fixed because a replant is just pool.reset().

import * as THREE from "three";
import {
  InstancedPool,
  bladeGeometry,
  padGeometry,
  segmentGeometry,
  spineGeometry,
} from "./pools";
import {
  PlantUniforms,
  leafMaterial,
  makePlantUniforms,
  padMaterial,
  petalMaterial,
  segmentMaterial,
  spineMaterial,
} from "./shaders";
import { GOLDEN_ANGLE, Rng, irange, jitter, mulberry32, range } from "./rng";

export type SpeciesName = "bloom" | "grass" | "cactus";

/** Per-frame knobs, read from the editor params by the scene. */
export interface FloraSettings {
  wuchs: number; // growth speed multiplier
  zweig: number; // branch eagerness 0..1
  winkel: number; // branch angle, radians
  blueten: number; // bloom eagerness 0..1
  zyklus: number; // lifecycle seconds
  hue: number; // base hue 0..1
  drift: number; // per-plant hue variation
}

/** The weirdness dice, rolled once per plant. */
interface Traits {
  /** spiral rotation around the stem's own axis per segment (rad) */
  twist: number;
  /** constant bend around a per-tip axis per segment — hooks and coils */
  curl: number;
  /** pull toward the light; negative = creeper that dives back down */
  bias: number;
  /** radius modulation along depth — knobbly, alien stems */
  knob: number;
  /** overall size multiplier */
  size: number;
}

interface Tip {
  pos: THREE.Vector3;
  quat: THREE.Quaternion; // local +Y is the growth direction
  curlAxis: THREE.Vector3; // per-tip bend axis for the curl trait
  depth: number;
  maxDepth: number;
  radius: number;
  height: number; // cumulative height — sway leverage
  lastGrow: number;
  done: boolean;
}

interface Pad {
  center: THREE.Vector3;
  r: number;
  birth: number;
}

interface Flower {
  petals: number[]; // instance indices in the petal pool
  open: boolean;
}

type Phase = "growing" | "blooming" | "withering";

// scratch objects — no per-frame allocations in the growth path
const M4 = new THREE.Matrix4();
const Q1 = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const SCALE1 = new THREE.Vector3(1, 1, 1);

const SEG_GROW_DUR = 1.4; // must match uGrowDur in the segment material

export class Plant {
  readonly group = new THREE.Group();
  readonly uniforms: PlantUniforms;
  species: SpeciesName = "bloom";
  phase: Phase = "growing";
  dead = false;
  /** highest point this plant has reached — the camera rides on this */
  topY = 0;

  private rng: Rng = mulberry32(1);
  private traits: Traits = { twist: 0, curl: 0, bias: 0.12, knob: 0, size: 1 };
  private segments: InstancedPool;
  private leaves: InstancedPool;
  private petals: InstancedPool;
  private spines: InstancedPool;
  private pads: InstancedPool;
  private padMat: THREE.ShaderMaterial;

  private tips: Tip[] = [];
  private padList: Pad[] = [];
  private flowers: Flower[] = [];
  private tipCursor = 0;
  private energy = 0;
  private bornAt = 0;
  private phaseAt = 0;
  private leafRoll = 0; // running golden-angle roll for leaf placement
  private segsSinceLeaf = 0;
  private bodyR = 0.6;
  private areoleCount = 0;
  private areoleSpawned = 0;
  private energySmooth = 0;

  constructor(origin: THREE.Vector3, budgetScale: number) {
    this.uniforms = makePlantUniforms();
    this.group.position.copy(origin);

    const cap = (n: number) => Math.max(24, Math.round(n * budgetScale));
    this.segments = new InstancedPool(
      segmentGeometry(),
      segmentMaterial(this.uniforms),
      cap(720),
    );
    this.leaves = new InstancedPool(
      bladeGeometry(),
      leafMaterial(this.uniforms),
      cap(140),
    );
    this.petals = new InstancedPool(
      bladeGeometry(),
      petalMaterial(this.uniforms),
      cap(96),
    );
    this.spines = new InstancedPool(
      spineGeometry(),
      spineMaterial(this.uniforms),
      cap(560),
    );
    this.padMat = padMaterial(this.uniforms);
    this.pads = new InstancedPool(padGeometry(), this.padMat, cap(42));
    this.group.add(
      this.segments.mesh,
      this.leaves.mesh,
      this.petals.mesh,
      this.spines.mesh,
      this.pads.mesh,
    );
  }

  /**
   * Fast-forward freshly planted growth by `seconds` — birth timestamps land
   * in the past, so the shaders render the head start as already grown.
   * Keeps a scene switch from opening on an empty stage.
   */
  prewarm(seconds: number, now: number, s: FloraSettings) {
    if (seconds <= 0) return;
    this.bornAt = now - seconds; // lifecycle reflects the head start
    // back-date the growth gates too, or the time gate blocks every
    // prewarm step and only ungated species (cactus) get a head start
    for (const tip of this.tips) tip.lastGrow = now - seconds - SEG_GROW_DUR;
    const stepDt = 0.4;
    for (let t = now - seconds; t < now; t += stepDt) {
      if (this.species === "cactus") {
        if (this.rng() < 0.18) this.spawnPad(t);
        if (this.rng() < 0.5) this.spawnAreole(t);
      } else {
        this.step(t, s);
        if (this.species === "bloom" && this.rng() < s.zweig * 0.12) {
          this.branch(t, s);
        }
      }
    }
    // a prewarmed bloom plant may already flower
    if (this.species === "bloom" && this.rng() < s.blueten) {
      this.openNextFlower(now - this.rng() * 8);
    }
    this.commitAll();
  }

  /** (Re-)seed this slot: reset pools, roll species traits and colors. */
  plant(species: SpeciesName, seed: number, now: number, s: FloraSettings) {
    this.rng = mulberry32(seed);
    this.species = species;
    this.phase = "growing";
    this.dead = false;
    this.bornAt = now;
    this.phaseAt = now;
    this.energy = 0;
    this.tips = [];
    this.padList = [];
    this.flowers = [];
    this.tipCursor = 0;
    this.topY = 0;
    this.leafRoll = this.rng() * Math.PI * 2;
    this.segsSinceLeaf = 0;
    this.segments.reset();
    this.leaves.reset();
    this.petals.reset();
    this.spines.reset();
    this.pads.reset();
    this.uniforms.uWither.value = 0;
    this.uniforms.uSwayPhase.value = this.rng() * Math.PI * 2;
    this.group.rotation.y = this.rng() * Math.PI * 2;

    // the weirdness dice — most plants are mild, some go fully alien
    const weird = this.rng(); // one plant in ~3 leans strange
    this.traits = {
      twist: (this.rng() - 0.5) * (weird > 0.66 ? 1.1 : 0.3),
      curl:
        weird > 0.66
          ? range(this.rng, 0.08, 0.34)
          : range(this.rng, 0, 0.05),
      bias:
        weird > 0.85
          ? range(this.rng, -0.09, 0.0) // creeper: dives back toward soil
          : range(this.rng, 0.04, 0.22),
      knob: weird > 0.55 ? range(this.rng, 0.15, 0.55) : 0,
      size: range(this.rng, 0.85, 1.6),
    };

    // colors: base hue drifts per plant; petals get heart + rim colors
    const h = (s.hue + (this.rng() * 2 - 1) * s.drift + 1) % 1;
    this.uniforms.uColA.value.setHSL((h + 0.94) % 1, 0.9, 0.52);
    this.uniforms.uColB.value.setHSL(h, 0.55, 0.82);
    this.uniforms.uColLeaf.value.setHSL(
      0.26 + (this.rng() - 0.5) * 0.07,
      0.5,
      0.33,
    );

    if (species === "cactus") {
      this.bodyR = range(this.rng, 0.32, 0.5) * this.traits.size;
      this.padMat.uniforms.uRibs.value = irange(this.rng, 7, 13);
      this.areoleCount = irange(this.rng, 26, 44);
      this.areoleSpawned = 0;
      this.uniforms.uColLeaf.value.setHSL(
        0.31 + (this.rng() - 0.5) * 0.05,
        0.5,
        0.3,
      );
      // seed pad, half-buried — everything else buds out of it
      this.addPad(V1.set(0, this.bodyR * 0.7, 0), this.bodyR, now);
      return;
    }

    const tipCount =
      species === "grass" ? irange(this.rng, 16, 28) : irange(this.rng, 1, 3);
    for (let i = 0; i < tipCount; i++) {
      const spread = species === "grass" ? 0.26 : 0.07;
      const tilt =
        species === "grass" ? range(this.rng, 0.1, 0.5) : range(this.rng, 0, 0.14);
      const yaw = this.rng() * Math.PI * 2;
      Q1.setFromAxisAngle(UP, yaw).multiply(
        Q2.setFromAxisAngle(X_AXIS, tilt),
      );
      this.tips.push({
        pos: new THREE.Vector3(
          Math.cos(yaw) * spread * this.rng(),
          0,
          Math.sin(yaw) * spread * this.rng(),
        ),
        quat: Q1.clone(),
        curlAxis: new THREE.Vector3(
          this.rng() - 0.5,
          (this.rng() - 0.5) * 0.3,
          this.rng() - 0.5,
        ).normalize(),
        depth: 0,
        maxDepth:
          species === "grass"
            ? irange(this.rng, 7, 14)
            : irange(this.rng, 12, 24),
        radius:
          (species === "grass" ? 0.02 : range(this.rng, 0.055, 0.08)) *
          this.traits.size,
        height: 0,
        lastGrow: now - SEG_GROW_DUR, // first segment may grow immediately
        done: false,
      });
    }
  }

  /**
   * @param energyIn this plant's band-group energy 0..1
   * @param beatEdge true exactly on beat onsets
   */
  update(
    now: number,
    dt: number,
    energyIn: number,
    beatEdge: boolean,
    beatEnv: number,
    wind: number,
    s: FloraSettings,
  ) {
    const u = this.uniforms;
    u.uTime.value = now;
    u.uWind.value = wind;
    u.uBeat.value = beatEnv;
    this.energySmooth += (energyIn - this.energySmooth) * Math.min(1, dt * 6);
    u.uEnergy.value = this.energySmooth;

    // ---- lifecycle ----------------------------------------------------
    const age = now - this.bornAt;
    if (this.phase === "growing") {
      const crowded =
        this.species === "cactus"
          ? this.pads.full && this.areoleSpawned >= this.areoleCount
          : this.segments.fill > 0.92 || this.tips.every((t) => t.done);
      if (crowded || age > s.zyklus * 0.55) {
        this.phase = "blooming";
        this.phaseAt = now;
      }
    } else if (this.phase === "blooming") {
      if (now - this.phaseAt > s.zyklus * 0.45) {
        this.phase = "withering";
        this.phaseAt = now;
      }
    } else {
      u.uWither.value = Math.min((now - this.phaseAt) / 7, 1);
      if (u.uWither.value >= 1) this.dead = true;
    }

    // ---- growth energy -------------------------------------------------
    // baseline keeps the garden alive through quiet passages; music makes
    // it race (this is where "die Pflanze wächst zur Musik" happens)
    if (this.phase === "growing") {
      this.energy += (0.1 + energyIn * 1.6) * s.wuchs * dt * 4;
      let steps = 0;
      while (this.energy >= 1 && steps < 6) {
        this.energy -= 1;
        this.step(now, s);
        steps++;
      }
    }

    // ---- beat events ----------------------------------------------------
    if (beatEdge) {
      if (this.species === "bloom" && this.phase === "growing") {
        // beat = a chance to fork somewhere
        if (this.rng() < s.zweig * 0.7) this.branch(now, s);
      }
      if (this.species === "cactus" && this.phase === "growing") {
        // beats bud new pads — the "growing into itself" moments
        if (this.rng() < 0.45) this.spawnPad(now);
        this.spawnAreole(now);
      }
      if (this.phase === "blooming" && this.rng() < 0.35 + s.blueten * 0.5) {
        this.openNextFlower(now);
      }
    }
    // blooming also proceeds without beats (slow songs still flower)
    if (this.phase === "blooming" && this.rng() < dt * (0.3 + s.blueten)) {
      this.openNextFlower(now);
    }

    this.commitAll();
  }

  private commitAll() {
    this.segments.commit();
    this.leaves.commit();
    this.petals.commit();
    this.spines.commit();
    this.pads.commit();
  }

  // ---- growth steps -----------------------------------------------------

  private step(now: number, s: FloraSettings) {
    if (this.species === "cactus") {
      // cactus growth = pads and spines, not stems
      if (this.rng() < 0.22) this.spawnPad(now);
      else if (this.rng() < 0.6) this.spawnAreole(now);
      return;
    }
    if (this.tips.length === 0) return;
    // round-robin over live tips; gate on the parent segment being grown
    for (let n = 0; n < this.tips.length; n++) {
      const tip = this.tips[this.tipCursor % this.tips.length];
      this.tipCursor++;
      if (tip.done) continue;
      if (now - tip.lastGrow < SEG_GROW_DUR * 0.7) continue;
      this.extend(tip, now, s);
      return;
    }
  }

  private extend(tip: Tip, now: number, s: FloraSettings) {
    if (this.segments.full) {
      tip.done = true;
      return;
    }
    const isGrass = this.species === "grass";
    const t = this.traits;
    const len =
      (isGrass ? jitter(this.rng, 0.18, 0.3) : jitter(this.rng, 0.26, 0.25)) *
      t.size;
    const lastSeg = tip.depth >= tip.maxDepth - 1;
    const taper = lastSeg ? 0.35 : 0.975;

    // --- direction: wobble + twist + curl + gravity bias ---------------
    V1.set(this.rng() - 0.5, 0, this.rng() - 0.5).normalize();
    Q1.setFromAxisAngle(V1, range(this.rng, 0, isGrass ? 0.22 : 0.13));
    tip.quat.multiply(Q1);
    // twist: spiral around the stem's own axis (phyllotactic drift)
    if (t.twist !== 0) {
      Q1.setFromAxisAngle(UP, t.twist);
      tip.quat.multiply(Q1);
    }
    // curl: constant bend around this tip's rolled axis — coils and hooks
    if (t.curl > 0) {
      Q1.setFromAxisAngle(tip.curlAxis, t.curl);
      tip.quat.premultiply(Q1);
    }
    // gravity bias: pull toward (or away from) the light
    V2.set(0, 1, 0).applyQuaternion(tip.quat);
    V3.copy(V2).addScaledVector(UP, isGrass ? 0.06 : t.bias).normalize();
    Q1.setFromUnitVectors(V2, V3);
    tip.quat.premultiply(Q1);

    // knobbly stems: radius pulses along depth
    const knobble = 1 + t.knob * Math.sin(tip.depth * 2.4);

    M4.compose(tip.pos, tip.quat, V1.set(1, len, 1));
    this.segments.spawn(M4, {
      birth: now,
      sway: Math.min(tip.height / (2.5 * t.size), 1) * (isGrass ? 1.6 : 1),
      rad0: tip.radius * knobble,
      rad1: tip.radius * taper * knobble,
    });

    // advance the tip to the segment's end
    V2.set(0, len, 0).applyQuaternion(tip.quat);
    tip.pos.add(V2);
    tip.height += len;
    this.topY = Math.max(this.topY, tip.pos.y);
    tip.radius *= lastSeg ? 0.9 : 0.968;
    tip.depth++;
    tip.lastGrow = now;

    // leaves along the stem (bloom only), phyllotaxis roll
    if (!isGrass) {
      this.segsSinceLeaf++;
      if (this.segsSinceLeaf >= 2 && tip.depth < tip.maxDepth - 2) {
        this.segsSinceLeaf = 0;
        this.spawnLeaf(tip, now);
      }
    }

    if (tip.depth >= tip.maxDepth) {
      tip.done = true;
      if (!isGrass) this.spawnFlower(tip, now, s);
    }
  }

  private spawnLeaf(tip: Tip, now: number) {
    if (this.leaves.full) return;
    this.leafRoll += GOLDEN_ANGLE;
    Q1.copy(tip.quat)
      .multiply(Q2.setFromAxisAngle(UP, this.leafRoll))
      .multiply(Q2.setFromAxisAngle(X_AXIS, range(this.rng, 0.9, 1.35)));
    M4.compose(tip.pos, Q1, SCALE1);
    this.leaves.spawn(M4, {
      birth: now,
      sway: Math.min(tip.height / (2.5 * this.traits.size), 1),
      phase: this.rng() * Math.PI * 2,
      scale: jitter(this.rng, 0.36, 0.3) * this.traits.size,
    });
  }

  private spawnFlower(tip: Tip, now: number, s: FloraSettings) {
    const count = irange(this.rng, 6, 9);
    const flower: Flower = { petals: [], open: false };
    for (let i = 0; i < count; i++) {
      if (this.petals.full) break;
      const yaw = (i / count) * Math.PI * 2 + this.rng() * 0.2;
      Q1.copy(tip.quat).multiply(Q2.setFromAxisAngle(UP, yaw));
      M4.compose(tip.pos, Q1, SCALE1);
      const idx = this.petals.spawn(M4, {
        birth: now,
        sway: Math.min(tip.height / (2.5 * this.traits.size), 1),
        phase: this.rng() * Math.PI * 2,
        scale: jitter(this.rng, 0.34, 0.25) * this.traits.size,
        open: 0, // closed bud until the lifecycle or a beat opens it
      });
      if (idx >= 0) flower.petals.push(idx);
    }
    if (flower.petals.length > 0) this.flowers.push(flower);
    // eager plants may open right away when Blütenfreude is high
    if (this.rng() < s.blueten * 0.25) this.openNextFlower(now);
  }

  private openNextFlower(now: number) {
    const flower = this.flowers.find((f) => !f.open);
    if (!flower) return;
    flower.open = true;
    for (const idx of flower.petals) this.petals.setOpen(idx, now);
  }

  private branch(now: number, s: FloraSettings) {
    if (this.tips.length >= 40) return;
    const live = this.tips.filter(
      (t) => !t.done && t.depth >= 2 && t.depth <= t.maxDepth - 3,
    );
    if (live.length === 0) return;
    const parent = live[irange(this.rng, 0, live.length - 1)];
    this.leafRoll += GOLDEN_ANGLE;
    const child: Tip = {
      pos: parent.pos.clone(),
      quat: parent.quat
        .clone()
        .multiply(Q2.setFromAxisAngle(UP, this.leafRoll))
        .multiply(Q2.setFromAxisAngle(X_AXIS, jitter(this.rng, s.winkel, 0.3))),
      curlAxis: new THREE.Vector3(
        this.rng() - 0.5,
        (this.rng() - 0.5) * 0.3,
        this.rng() - 0.5,
      ).normalize(),
      depth: parent.depth,
      maxDepth: Math.min(
        parent.maxDepth,
        parent.depth + irange(this.rng, 4, 9),
      ),
      radius: parent.radius * 0.7,
      height: parent.height,
      lastGrow: now - SEG_GROW_DUR,
      done: false,
    };
    this.tips.push(child);
  }

  // ---- cactus pads --------------------------------------------------------

  private addPad(center: THREE.Vector3, r: number, birth: number) {
    Q1.setFromAxisAngle(UP, this.rng() * Math.PI * 2);
    M4.compose(center, Q1, SCALE1);
    const idx = this.pads.spawn(M4, {
      birth,
      phase: this.rng() * Math.PI * 2,
      scale: r,
    });
    if (idx >= 0) {
      this.padList.push({ center: center.clone(), r, birth });
      this.topY = Math.max(this.topY, center.y + r);
    }
  }

  /** Bud a new pad out of an existing one — deliberately interpenetrating. */
  private spawnPad(now: number) {
    if (this.pads.full || this.padList.length === 0) return;
    const parent = this.padList[irange(this.rng, 0, this.padList.length - 1)];
    const r = Math.max(parent.r * jitter(this.rng, 0.78, 0.25), 0.08);
    // random direction, biased upward so chains climb — but sideways and
    // even downward buds happen, which is where it gets properly weird
    V1.set(
      this.rng() - 0.5,
      this.rng() * 0.9 + 0.15,
      this.rng() - 0.5,
    ).normalize();
    // offset LESS than r_parent + r_child: the pads visibly merge
    const dist = parent.r * 0.62 + r * 0.42;
    V2.copy(parent.center).addScaledVector(V1, dist);
    if (V2.y < r * 0.35) V2.y = r * 0.35; // stay out of the ground
    this.addPad(V2, r, now);
  }

  /** Next areole on the phyllotaxis spiral bursts a fan of spines. */
  private spawnAreole(now: number) {
    if (this.areoleSpawned >= this.areoleCount || this.spines.full) return;
    // only pads that have (mostly) inflated — spines on a growing pad float
    const grown = this.padList.filter((p) => now - p.birth > 2.4);
    if (grown.length === 0) return;
    const pad = grown[irange(this.rng, 0, grown.length - 1)];
    const k = this.areoleSpawned++;
    // golden-spiral point on the pad's sphere (upper ~70%)
    const y = 1 - (k % 13) / 9.3; // 1 .. -0.4, cycling per pad
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const a = k * GOLDEN_ANGLE;
    V1.set(Math.cos(a) * rr, y, Math.sin(a) * rr); // unit normal ≙ position
    const surface = V2.copy(pad.center).addScaledVector(V1, pad.r * 1.0);

    const n = irange(this.rng, 9, 14);
    for (let i = 0; i < n; i++) {
      if (this.spines.full) break;
      // fan: mostly along the normal, splayed outward
      V3.copy(V1)
        .addScaledVector(
          new THREE.Vector3(
            this.rng() - 0.5,
            this.rng() - 0.5,
            this.rng() - 0.5,
          ),
          0.85,
        )
        .normalize();
      Q1.setFromUnitVectors(UP, V3);
      M4.compose(surface, Q1, SCALE1);
      this.spines.spawn(M4, {
        birth: now + this.rng() * 0.35, // staggered pop within the burst
        phase: this.rng() * Math.PI * 2,
        scale: jitter(this.rng, pad.r * 0.6, 0.4),
      });
    }
  }

  dispose() {
    this.segments.dispose();
    this.leaves.dispose();
    this.petals.dispose();
    this.spines.dispose();
    this.pads.dispose();
  }
}
