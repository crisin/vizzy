// FloraScene — the garden. Owns K plant slots on a loose circle, feeds each
// one its own frequency band group (bass plants left of the spectrum, treble
// plants right), runs the lifecycle and the slow orbit camera.

import * as THREE from "three";
import { params } from "../params";
import { Plant, SpeciesName } from "./growth";
import { groundMaterial } from "./shaders";
import { mulberry32, range } from "./rng";

// mirrors the Scene3D contract in scenes3d.ts (not exported there)
interface AudioFrameLike {
  disp: Float32Array;
  wave: Float32Array;
  rms: number;
  beat: number;
  dt: number;
  t: number;
  cameraAuto: boolean;
}

const BG = 0x07070c;
const SPECIES_CYCLE: SpeciesName[] = ["bloom", "grass", "cactus", "bloom"];

export class FloraScene {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  cameraTarget = new THREE.Vector3(0, 1.1, 0);

  private plants: Plant[] = [];
  private ground: THREE.Mesh;
  private groundMat: THREE.ShaderMaterial;
  private prevBeat = 0;
  private plantedSeed = -1;
  private plantedCount = -1;
  private plantedDichte = -1;
  private respawnCursor = 0;
  private canopySmooth = 1.2;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 100);
    this.camera.position.set(0, 2.4, 7);
    this.camera.lookAt(this.cameraTarget);

    this.scene.fog = new THREE.Fog(BG, 9, 22);
    this.scene.background = new THREE.Color(BG);

    this.groundMat = groundMaterial();
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(14, 48), this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);
  }

  /** Tear down and rebuild all slots — seed/count/density changed. */
  private replant(now: number) {
    for (const p of this.plants) {
      this.scene.remove(p.group);
      p.dispose();
    }
    this.plants = [];

    // base values, NOT modulated ones: a routing assignment on these params
    // must never tear the garden down every frame
    const seed = Math.round(params.getBase("flora", "seed"));
    const count = Math.round(params.getBase("flora", "pflanzen"));
    const dichte = params.getBase("flora", "dichte");
    this.plantedSeed = seed;
    this.plantedCount = count;
    this.plantedDichte = dichte;

    const rng = mulberry32(seed * 7919 + 17);
    const settings = this.settings();
    for (let i = 0; i < count; i++) {
      // loose ring, hero plant near the middle
      const a = (i / count) * Math.PI * 2 + rng() * 0.5;
      const r = i === 0 ? range(rng, 0, 0.5) : range(rng, 1.4, 2.8);
      const origin = new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
      const plant = new Plant(origin, dichte);
      const species =
        i === 0 ? "bloom" : SPECIES_CYCLE[i % SPECIES_CYCLE.length];
      plant.plant(species, seed + i * 101, now, settings);
      // staggered head start: the garden is alive from the first frame,
      // only the hero plant grows from zero before your eyes
      if (i > 0) plant.prewarm(6 + rng() * 26, now, settings);
      this.scene.add(plant.group);
      this.plants.push(plant);
    }
  }

  private settings() {
    return {
      wuchs: params.get("flora", "wuchs"),
      zweig: params.get("flora", "zweig"),
      winkel: (params.get("flora", "winkel") * Math.PI) / 180,
      blueten: params.get("flora", "blueten"),
      zyklus: params.get("flora", "zyklus"),
      hue: params.get("flora", "farbton"),
      drift: params.get("flora", "farbdrift"),
    };
  }

  update(frame: AudioFrameLike) {
    const now = frame.t;

    // watch the replant-triggering params (base values — see replant())
    if (
      Math.round(params.getBase("flora", "seed")) !== this.plantedSeed ||
      Math.round(params.getBase("flora", "pflanzen")) !== this.plantedCount ||
      params.getBase("flora", "dichte") !== this.plantedDichte
    ) {
      this.replant(now);
    }

    const settings = this.settings();
    const wind = params.get("flora", "wind");
    const beatEdge = frame.beat > 0.6 && this.prevBeat <= 0.6;
    this.prevBeat = frame.beat;

    const K = this.plants.length;
    for (let i = 0; i < K; i++) {
      const plant = this.plants[i];
      // this plant's slice of the spectrum
      const lo = Math.floor((i * frame.disp.length) / K);
      const hi = Math.max(lo + 1, Math.floor(((i + 1) * frame.disp.length) / K));
      let e = 0;
      for (let b = lo; b < hi; b++) e += frame.disp[b];
      e /= hi - lo;

      plant.update(now, frame.dt, e, beatEdge, frame.beat, wind, settings);

      // composted? plant something new in the same spot
      if (plant.dead) {
        const species =
          SPECIES_CYCLE[(i + this.respawnCursor++) % SPECIES_CYCLE.length];
        plant.plant(
          species,
          this.plantedSeed + i * 101 + this.respawnCursor * 4441,
          now,
          settings,
        );
      }
    }

    // the camera rides the canopy: pull back and look up as things get big
    let canopy = 0;
    for (const p of this.plants) canopy = Math.max(canopy, p.topY);
    this.canopySmooth += (canopy - this.canopySmooth) * Math.min(1, frame.dt);
    if (frame.cameraAuto) {
      const a = now * 0.07;
      const dist = 6 + this.canopySmooth * 1.1;
      this.cameraTarget.set(0, 0.8 + this.canopySmooth * 0.4, 0);
      this.camera.position.set(
        Math.sin(a) * dist,
        1.8 +
          this.canopySmooth * 0.55 +
          Math.sin(now * 0.11) * 0.5 +
          frame.rms * 0.8,
        Math.cos(a) * dist,
      );
      this.camera.lookAt(this.cameraTarget);
    }
  }

  dispose() {
    for (const p of this.plants) {
      this.scene.remove(p.group);
      p.dispose();
    }
    this.plants = [];
    this.ground.geometry.dispose();
    this.groundMat.dispose();
  }
}
