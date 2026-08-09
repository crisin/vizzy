// Flora materials — the whole trick of the scene lives here:
//
// Geometry is spawned ONCE per element (segment/leaf/petal/spine) into
// instanced pools; every animation — growing, opening, swaying, withering —
// runs in the vertex shader off a per-instance `aBirth` timestamp and a
// handful of per-plant uniforms. Growth costs zero geometry work per frame.
//
// Sway is a world-space displacement field keyed on world height and a
// per-plant phase, so stacked segments shear identically at their shared
// joint and the plant bends as one piece instead of cracking apart.

import * as THREE from "three";

/** Per-plant state shared by all four pool materials of one slot. The same
 *  uniform objects are referenced by every material, so one write per frame
 *  updates segments, leaves, petals and spines together. */
export interface PlantUniforms {
  uTime: { value: number };
  uWind: { value: number };
  uBeat: { value: number };
  /** this plant's own band-group energy 0..1 */
  uEnergy: { value: number };
  uWither: { value: number };
  uSwayPhase: { value: number };
  uColA: { value: THREE.Color };
  uColB: { value: THREE.Color };
  uColLeaf: { value: THREE.Color };
}

export function makePlantUniforms(): PlantUniforms {
  return {
    uTime: { value: 0 },
    uWind: { value: 0.6 },
    uBeat: { value: 0 },
    uEnergy: { value: 0 },
    uWither: { value: 0 },
    uSwayPhase: { value: 0 },
    uColA: { value: new THREE.Color(1.0, 0.45, 0.12) },
    uColB: { value: new THREE.Color(1.0, 0.75, 0.8) },
    uColLeaf: { value: new THREE.Color(0.2, 0.55, 0.25) },
  };
}

// ---------------------------------------------------------------- chunks ---

const SWAY = /* glsl */ `
  // world-space sway field: continuous over height -> no joint cracks
  float swayAngle(float phase) {
    return uWind * (0.6 * sin(uTime * 1.35 + phase)
                  + 0.25 * sin(uTime * 2.72 + phase * 1.7)
                  + 0.1 * sin(uTime * 5.1 + phase * 0.6))
         + uBeat * 0.30;
  }
  vec4 applySway(vec4 wp, float heightFactor, float phase) {
    float a = swayAngle(phase) * heightFactor;
    wp.x += a * wp.y * 0.22;
    wp.z += a * wp.y * 0.09;
    // withering: droop down and sideways, strongest at the top
    float d = uWither * heightFactor;
    wp.x += d * wp.y * 0.3;
    wp.y -= d * wp.y * 0.45;
    return wp;
  }
`;

const LIGHT = /* glsl */ `
  // cheap stylized lighting: wrap diffuse + sky ambient + rim
  vec3 shade(vec3 base, vec3 n, vec3 viewDir) {
    vec3 l = normalize(vec3(0.5, 0.8, 0.35));
    float diff = clamp(dot(n, l) * 0.5 + 0.5, 0.0, 1.0);
    float sky = n.y * 0.25 + 0.75;
    float rim = pow(1.0 - abs(dot(n, viewDir)), 2.5) * 0.4;
    return base * (0.55 + 0.75 * diff) * sky + base * rim;
  }
  vec3 witherTint(vec3 c) {
    vec3 dry = vec3(0.45, 0.32, 0.18) * (c.r + c.g + c.b) * 0.55;
    return mix(c, dry, clamp(uWither, 0.0, 1.0));
  }
`;

const PLANT_UNIFORMS = /* glsl */ `
  uniform float uTime;
  uniform float uWind;
  uniform float uBeat;
  uniform float uEnergy;
  uniform float uWither;
  uniform float uSwayPhase;
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColLeaf;
`;

// -------------------------------------------------------------- segments ---

const SEGMENT_VERT = /* glsl */ `
  attribute float aBirth;
  attribute float aSway;
  attribute vec2 aRad;   // base/tip radius of this segment
  ${PLANT_UNIFORMS}
  uniform float uGrowDur;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  ${SWAY}
  void main() {
    float t = max(uTime - aBirth, 0.0);
    float reveal = smoothstep(0.0, 1.0, t / uGrowDur);
    // stems keep thickening long after they appeared — like the cactus
    // timelapse where old growth visibly bulks up
    float thick = 0.55 + 0.45 * min(t / 22.0, 1.0);
    vec3 p = position; // unit cylinder, base at y=0, radius 1
    p.xz *= mix(aRad.x, aRad.y, uv.y) * thick;
    p.y *= reveal;
    vec4 wp = instanceMatrix * vec4(p, 1.0);
    wp = applySway(wp, aSway, uSwayPhase);
    vNormal = normalize(mat3(instanceMatrix) * normal);
    vY = uv.y;
    vec4 mv = modelViewMatrix * wp;
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const SEGMENT_FRAG = /* glsl */ `
  precision highp float;
  ${PLANT_UNIFORMS}
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  ${LIGHT}
  void main() {
    vec3 base = uColLeaf * mix(0.55, 0.95, vY); // darker toward the ground
    base = mix(base, base * vec3(0.85, 0.7, 0.55), 0.35); // woody tint
    base = witherTint(base);
    gl_FragColor = vec4(shade(base, normalize(vNormal), vView), 1.0);
  }
`;

// ---------------------------------------------------------------- leaves ---

const LEAF_VERT = /* glsl */ `
  attribute float aBirth;
  attribute float aSway;
  attribute float aPhase;
  attribute float aScale;
  ${PLANT_UNIFORMS}
  uniform float uGrowDur;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vFlutter;
  ${SWAY}
  void main() {
    float t = max(uTime - aBirth, 0.0);
    float reveal = smoothstep(0.0, 1.0, t / uGrowDur);
    vUv = uv;
    // unit plane: x -1..1 across, y 0..1 along the leaf
    vec3 p = position;
    p *= reveal * aScale;
    // curl along length + a little flutter at the tip
    float curl = 0.55 + 0.3 * sin(aPhase * 7.0);
    p.z += curl * p.y * p.y;
    float flutter = sin(uTime * 3.1 + aPhase * 9.0) * 0.12 * uv.y * uWind;
    p.z += flutter;
    vFlutter = flutter;
    vec4 wp = instanceMatrix * vec4(p, 1.0);
    wp = applySway(wp, aSway, uSwayPhase + aPhase * 0.3);
    vNormal = normalize(mat3(instanceMatrix) * normal);
    vec4 mv = modelViewMatrix * wp;
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const LEAF_FRAG = /* glsl */ `
  precision highp float;
  ${PLANT_UNIFORMS}
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vFlutter;
  ${LIGHT}
  void main() {
    float ux = vUv.x * 2.0 - 1.0; // center: plane uvs run 0..1
    // leaf silhouette: width profile over length, cut by discard
    float w = pow(sin(clamp(vUv.y, 0.0, 1.0) * 3.14159), 0.65) * 0.9;
    if (abs(ux) > w) discard;
    vec3 base = uColLeaf * mix(0.75, 1.1, vUv.y);
    // central vein + side veins
    float vein = smoothstep(0.035, 0.0, abs(ux))
               + 0.5 * smoothstep(0.9, 1.0,
                   sin(abs(ux) * 26.0 - vUv.y * 8.0));
    base *= 1.0 - vein * 0.22;
    // this leaf's frequency band makes it glow
    base += uColLeaf * uEnergy * (0.35 + 0.25 * sin(vFlutter * 40.0));
    base = witherTint(base);
    vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    gl_FragColor = vec4(shade(base, n, vView), 1.0);
  }
`;

// ---------------------------------------------------------------- petals ---
//
// The tulip look from the reference: orange heart fading to pink-white
// rims, fine red veins running lengthwise, petals hinging open around
// their base. aOpen is the timestamp when this flower was told to bloom
// (0 = still a closed bud) — set once on the CPU when the bud triggers.

const PETAL_VERT = /* glsl */ `
  attribute float aBirth;
  attribute float aSway;
  attribute float aPhase;
  attribute float aScale;
  attribute float aOpen;
  ${PLANT_UNIFORMS}
  uniform float uGrowDur;
  uniform float uOpenDur;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vOpen;
  varying float vPhase;
  ${SWAY}
  void main() {
    float t = max(uTime - aBirth, 0.0);
    float reveal = smoothstep(0.0, 1.0, t / uGrowDur);
    vPhase = aPhase;
    float open = aOpen <= 0.0 ? 0.0
      : smoothstep(0.0, 1.0, (uTime - aOpen) / uOpenDur);
    // ease-out with a tiny overshoot so the bloom feels alive
    open = open * (1.0 + 0.12 * sin(open * 3.14159));
    vOpen = open;
    vUv = uv;
    vec3 p = position * reveal * aScale;
    // cup the petal: curve across and along
    p.z += (0.35 * p.x * p.x + 0.5 * p.y * p.y) * (1.0 - open * 0.55);
    // hinge around the base: closed bud (~0.12 rad) to open (~1.25 rad)
    float ang = mix(0.12, 1.25, open) + uBeat * 0.06 * sin(aPhase * 5.0);
    float c = cos(ang), s = sin(ang);
    p = vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
    vec4 wp = instanceMatrix * vec4(p, 1.0);
    wp = applySway(wp, aSway, uSwayPhase + aPhase * 0.15);
    vNormal = normalize(mat3(instanceMatrix) *
      normalize(vec3(0.0, s, -c) + normal * 0.001));
    vec4 mv = modelViewMatrix * wp;
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const PETAL_FRAG = /* glsl */ `
  precision highp float;
  ${PLANT_UNIFORMS}
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vOpen;
  varying float vPhase;
  ${LIGHT}
  void main() {
    float ux = vUv.x * 2.0 - 1.0; // center: plane uvs run 0..1
    // pointed-oval silhouette
    float w = pow(sin(clamp(vUv.y, 0.0, 1.0) * 3.14159), 0.5) * 0.95;
    if (abs(ux) > w) discard;
    // orange heart -> pale pink rim (the reference tulip gradient)
    vec3 base = mix(uColA, uColB, smoothstep(0.08, 0.85, vUv.y));
    // lengthwise veins, denser toward the rim, wavering per petal
    float vein = smoothstep(0.86, 1.0,
      sin(ux * 42.0 + sin(vUv.y * 9.0 + vPhase * 6.0) * 0.8));
    base = mix(base, base * vec3(0.82, 0.45, 0.5), vein * vUv.y * 0.8);
    // fake backlight translucency: petals glow when lit from behind
    vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 l = normalize(vec3(0.5, 0.8, 0.35));
    float back = clamp(dot(-n, l), 0.0, 1.0);
    base += uColB * pow(back, 2.0) * 0.4;
    base += uColA * uBeat * 0.15; // beat shimmer in the heart
    base = witherTint(base);
    gl_FragColor = vec4(shade(base, n, vView), 1.0);
  }
`;

// ---------------------------------------------------------------- spines ---
//
// Cactus spines: thin cones bursting out of areoles with an elastic
// overshoot — the "DAY 70" reference frame in motion.

const SPINE_VERT = /* glsl */ `
  attribute float aBirth;
  attribute float aPhase;
  attribute float aScale;
  ${PLANT_UNIFORMS}
  uniform float uGrowDur;
  varying float vTip;
  varying float vAge;
  void main() {
    float t = max(uTime - aBirth, 0.0);
    float r = clamp(t / uGrowDur, 0.0, 1.0);
    // elastic pop: overshoot mid-growth, settle at 1
    float reveal = r + 0.3 * sin(r * 3.14159) * (1.0 - r);
    vTip = uv.y;
    vAge = min(t / 30.0, 1.0);
    vec3 p = position * aScale;
    p.y *= reveal;
    // spines quiver on the beat
    p.x += sin(aPhase * 13.0 + uTime * 6.0) * uBeat * 0.012 * uv.y;
    vec4 wp = instanceMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * wp;
  }
`;

const SPINE_FRAG = /* glsl */ `
  precision highp float;
  ${PLANT_UNIFORMS}
  varying float vTip;
  varying float vAge;
  void main() {
    // fresh spines are pale straw, aging toward amber (reference: DAY 160)
    vec3 young = vec3(0.92, 0.88, 0.78);
    vec3 old = vec3(0.78, 0.64, 0.42);
    vec3 c = mix(young, old, vAge) * mix(1.0, 0.75, vTip);
    c += vec3(0.3, 0.25, 0.1) * uEnergy * vTip;
    gl_FragColor = vec4(c, 1.0);
  }
`;

// ----------------------------------------------------------- cactus body ---

const BODY_VERT = /* glsl */ `
  ${PLANT_UNIFORMS}
  uniform float uBodyScale;
  uniform float uRibs;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vRib;
  void main() {
    vec3 p = position;
    float ang = atan(p.x, p.z);
    float rib = sin(ang * uRibs);
    vRib = rib;
    p += normal * rib * 0.05;
    p *= uBodyScale * (1.0 + uBeat * 0.02);
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const BODY_FRAG = /* glsl */ `
  precision highp float;
  ${PLANT_UNIFORMS}
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vRib;
  ${LIGHT}
  void main() {
    vec3 base = uColLeaf * mix(0.8, 1.15, vRib * 0.5 + 0.5);
    base += uColLeaf * uEnergy * 0.3;
    base = witherTint(base);
    gl_FragColor = vec4(shade(base, normalize(vNormal), vView), 1.0);
  }
`;

// -------------------------------------------------------------- factories ---

function material(
  vert: string,
  frag: string,
  uniforms: Record<string, { value: unknown }>,
  doubleSided = false,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

export function segmentMaterial(u: PlantUniforms): THREE.ShaderMaterial {
  return material(SEGMENT_VERT, SEGMENT_FRAG, { ...u, uGrowDur: { value: 1.4 } });
}

export function leafMaterial(u: PlantUniforms): THREE.ShaderMaterial {
  return material(LEAF_VERT, LEAF_FRAG, { ...u, uGrowDur: { value: 2.2 } }, true);
}

export function petalMaterial(u: PlantUniforms): THREE.ShaderMaterial {
  return material(
    PETAL_VERT,
    PETAL_FRAG,
    { ...u, uGrowDur: { value: 2.5 }, uOpenDur: { value: 6.0 } },
    true,
  );
}

export function spineMaterial(u: PlantUniforms): THREE.ShaderMaterial {
  return material(SPINE_VERT, SPINE_FRAG, { ...u, uGrowDur: { value: 1.1 } });
}

export function bodyMaterial(u: PlantUniforms): THREE.ShaderMaterial {
  return material(BODY_VERT, BODY_FRAG, {
    ...u,
    uBodyScale: { value: 0.01 },
    uRibs: { value: 9 },
  });
}

// ---------------------------------------------------------------- ground ---

const GROUND_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GROUND_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec3 uColor;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    vec3 c = uColor * mix(1.4, 0.4, smoothstep(0.0, 1.0, d));
    gl_FragColor = vec4(c, 1.0);
  }
`;

export function groundMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: GROUND_VERT,
    fragmentShader: GROUND_FRAG,
    uniforms: { uColor: { value: new THREE.Color(0x231c2c) } },
  });
}
