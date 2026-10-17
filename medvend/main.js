// MedVend Autonomous Health Kiosk — HyperFrames master timeline.
//
// One paused GSAP timeline (window.__timelines.main) drives the DOM and SVG layers.
// The Three.js layer and every procedural DOM readout are pure functions of time,
// rendered from the runtime's `hf-seek` event (or window.seekToFrame), so any frame
// can be reproduced in isolation by the headless renderer.

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { NOISE_VERT, NOISE_FRAG } from "./shaders/noiseField.js";
import { FRESNEL_VERT, FRESNEL_FRAG } from "./shaders/fresnelGlass.js";
import { GLOW_VERT, GLOW_FRAG } from "./shaders/softGlow.js";
import { RAYS_FRAG } from "./shaders/godRays.js";
import { AURA_FRAG } from "./shaders/neonAura.js";

const W = 3840;
const H = 2160;
const FPS = 60;
const TOTAL_FRAMES = 3600;

const { gsap, CustomEase } = window;
gsap.registerPlugin(CustomEase);
window.THREE = THREE;

const COL = {
  void: 0x06080c,
  cyan: 0x00f3ff,
  emerald: 0x00ff87,
  violet: 0x8a2be2,
  violetLamp: 0xc28cff,
};

// ---------------------------------------------------------------------------
// Math helpers (deterministic)
// ---------------------------------------------------------------------------
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const lin = (k) => k;
const ioc = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const smooth = (k) => k * k * (3 - 2 * k);
const frac = (v) => v - Math.floor(v);
const gauss = (x, mu, s) => Math.exp(-((x - mu) * (x - mu)) / (2 * s * s));

function hash2(i, j) {
  let h = Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const $ = (sel) => document.querySelector(sel);
const setText = (el, s) => {
  if (el.__t !== s) {
    el.textContent = s;
    el.__t = s;
  }
};
const setHTML = (el, s) => {
  if (el.__h !== s) {
    el.innerHTML = s;
    el.__h = s;
  }
};

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
const canvas = document.getElementById("webgl-canvas");
const EXP = window.__EXP || {};
const VARS = (window.__hyperframes && window.__hyperframes.getVariables && window.__hyperframes.getVariables()) || {};
// Internal WebGL resolution relative to the 3840x2160 frame (1 = native 4K). The DOM/SVG layers are always native.
const RENDER_SCALE = EXP.rs || Number(VARS.webglScale) || 0.75;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: EXP.aa !== undefined ? EXP.aa : true,
  alpha: false,
  preserveDrawingBuffer: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(1);
renderer.setSize(W * RENDER_SCALE, H * RENDER_SCALE, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.localClippingEnabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 200);

const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envTex;

// Background: volumetric noise field rendered at low resolution, used as scene.background.
const bgRT = new THREE.WebGLRenderTarget(960, 540, { depthBuffer: false });
const bgMat = new THREE.ShaderMaterial({
  vertexShader: NOISE_VERT,
  fragmentShader: NOISE_FRAG,
  uniforms: {
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(W, H) },
    uAtrium: { value: 0 },
    uEnergy: { value: 1 },
    uFlash: { value: 0 },
  },
  depthTest: false,
  depthWrite: false,
});
const bgScene = new THREE.Scene();
const bgCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat));
scene.background = bgRT.texture;

// Lights
const hemi = new THREE.HemisphereLight(0x5f86b0, 0x07090d, 0.7);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xe6f4ff, 2.2);
key.position.set(-4, 6, 6);
scene.add(key);
const rim = new THREE.DirectionalLight(COL.cyan, 2.4);
rim.position.set(5, 3, -5);
scene.add(rim);
const rim2 = new THREE.DirectionalLight(COL.violet, 1.6);
rim2.position.set(-5, 2, -4);
scene.add(rim2);
const sun = new THREE.DirectionalLight(0xffdcae, 0);
sun.position.set(-8, 12, 7);
scene.add(sun);
const sunFill = new THREE.HemisphereLight(0xfff3e0, 0xb8a284, 0);
scene.add(sunFill);

// Clipping planes for the laser-scan reveal (solid below the beam, wireframe above).
const revealPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), -0.1);
const edgePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.1);

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
const phys = (o) => new THREE.MeshPhysicalMaterial(o);
const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, toneMapped: false, ...extra });

const M = {
  chassis: phys({ color: 0x151b25, metalness: 0.85, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.16 }),
  shell: phys({ color: 0x151b25, metalness: 0.85, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.16 }),
  front: phys({ color: 0x0a0e14, metalness: 0.7, roughness: 0.24, clearcoat: 1, clearcoatRoughness: 0.06 }),
  bezel: phys({ color: 0x020305, metalness: 0.2, roughness: 0.06, clearcoat: 1 }),
  trim: phys({ color: 0x9aa7b9, metalness: 1, roughness: 0.22 }),
  frame: phys({ color: 0x3a4554, metalness: 0.9, roughness: 0.34 }),
  drawer: new THREE.MeshStandardMaterial({ color: 0xcdd8e4, roughness: 0.34, metalness: 0.25 }),
  pcb: new THREE.MeshStandardMaterial({ color: 0x0b2219, roughness: 0.55, metalness: 0.35 }),
  chip: new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.35, metalness: 0.6 }),
  armWhite: phys({ color: 0xe9eef5, metalness: 0.12, roughness: 0.3, clearcoat: 0.9 }),
  armJoint: phys({ color: 0x1b222c, metalness: 0.9, roughness: 0.24 }),
  hole: basic(0x000000),
  cyan: basic(COL.cyan),
  cyanFront: basic(COL.cyan, { transparent: true }),
  cyanShell: basic(COL.cyan, { transparent: true }),
  emerald: basic(COL.emerald),
  violetLamp: basic(COL.violetLamp),
};
const BIN_COLORS = [0xff5a64, 0x3fa9ff, 0xf4f7fb, 0x19d68a, 0xffc34d, 0x8f7bff];
const binMats = BIN_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.05 }));

function glowMat(color, intensity, shape = 1, sharp = 2) {
  return new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
      uShape: { value: shape },
      uSharp: { value: sharp },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
}

function fresnelMat(color, intensity, power, base) {
  return new THREE.ShaderMaterial({
    vertexShader: FRESNEL_VERT,
    fragmentShader: FRESNEL_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
      uPulse: { value: 1 },
      uPower: { value: power },
      uBase: { value: base },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    clipping: true,
    toneMapped: false,
  });
}

function setFade(mat, o) {
  mat.opacity = o;
  const tr = o < 0.999;
  if (mat.transparent !== tr) {
    mat.transparent = tr;
    mat.depthWrite = !tr;
    mat.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const rbox = (w, h, d, r = 0.02, s = 2) => new RoundedBoxGeometry(w, h, d, s, r);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
function mk(geo, mat, x, y, z, parent) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function glowCard(w, h, mat, x, y, z, parent) {
  return mk(new THREE.PlaneGeometry(w, h), mat, x, y, z, parent);
}

// Screen geometry (front face of the touch display)
const SCREEN = { w: 0.6, h: 0.96, y: 1.36, z: 0.3625 };

// ---------------------------------------------------------------------------
// Screen texture: the kiosk attract screen, matching the DOM replica
// ---------------------------------------------------------------------------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeScreenTexture() {
  const c = document.createElement("canvas");
  c.width = 1250;
  c.height = 2000;
  const g = c.getContext("2d");
  g.fillStyle = "#0b1324";
  g.fillRect(0, 0, 1250, 2000);
  const blob = (x, y, r, col) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, col);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(190, 470, 520, "rgba(14,165,233,0.42)");
  blob(1080, 1620, 480, "rgba(16,185,129,0.30)");
  // tile
  g.save();
  g.shadowColor = "rgba(14,165,233,0.55)";
  g.shadowBlur = 80;
  g.fillStyle = "rgba(14,165,233,0.18)";
  roundRect(g, 502, 622, 246, 246, 66);
  g.fill();
  g.restore();
  const tg = g.createLinearGradient(520, 640, 730, 850);
  tg.addColorStop(0, "#0a3d62");
  tg.addColorStop(1, "#0ea5e9");
  g.fillStyle = tg;
  roundRect(g, 520, 640, 210, 210, 52);
  g.fill();
  g.strokeStyle = "#fff";
  g.lineCap = "round";
  g.lineWidth = 10;
  g.beginPath();
  g.moveTo(625, 700);
  g.lineTo(625, 790);
  g.moveTo(580, 745);
  g.lineTo(670, 745);
  g.stroke();
  // title
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.font = '800 84px "Inter"';
  const a = "MedVend ";
  const b = "Health Kiosk";
  const wa = g.measureText(a).width;
  const wb = g.measureText(b).width;
  const x0 = 625 - (wa + wb) / 2;
  g.fillStyle = "#f1f5f9";
  g.fillText(a, x0, 1001);
  g.fillStyle = "#22bdeb";
  g.fillText(b, x0 + wa, 1001);
  g.textAlign = "center";
  g.font = '400 36px "Inter"';
  g.fillStyle = "#94a3b8";
  g.fillText("Vitals check, AI triage and over-the-counter care —", 625, 1090);
  g.fillText("available around the clock.", 625, 1142);
  // CTA
  g.save();
  g.shadowColor = "rgba(14,165,233,0.8)";
  g.shadowBlur = 60;
  g.shadowOffsetY = 20;
  const cg = g.createLinearGradient(125, 1240, 1125, 1364);
  cg.addColorStop(0, "#0369a1");
  cg.addColorStop(0.5, "#0284c7");
  cg.addColorStop(1, "#0ea5e9");
  g.fillStyle = cg;
  roundRect(g, 125, 1240, 1000, 124, 62);
  g.fill();
  g.restore();
  g.font = '800 36px "Inter"';
  g.fillStyle = "#ffffff";
  g.fillText("TOUCH TO BEGIN HEALTH CHECK", 625, 1315);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function radialTexture(inner, outer, size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const rg = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  rg.addColorStop(0, inner);
  rg.addColorStop(1, outer);
  g.fillStyle = rg;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// Kiosk model (procedural): shell, front panel, four internal modules
// ---------------------------------------------------------------------------
function buildKiosk(screenTex, hero) {
  const root = new THREE.Group();
  const P = {};
  const anim = {};

  // --- base plinth
  P.base = new THREE.Group();
  root.add(P.base);
  mk(rbox(1.12, 0.1, 0.82, 0.025), M.chassis, 0, 0.05, 0, P.base);
  mk(box(1.125, 0.012, 0.825), M.cyan, 0, 0.096, 0, P.base);

  // --- shell
  P.back = new THREE.Group();
  root.add(P.back);
  mk(rbox(0.9, 2.1, 0.05, 0.02), M.shell, 0, 1.15, -0.335, P.back);
  P.left = new THREE.Group();
  root.add(P.left);
  mk(rbox(0.06, 2.1, 0.72, 0.025), M.shell, -0.48, 1.15, 0, P.left);
  mk(box(0.014, 1.9, 0.01), M.cyanShell, -0.5, 1.15, 0.358, P.left);
  P.right = new THREE.Group();
  root.add(P.right);
  mk(rbox(0.06, 2.1, 0.72, 0.025), M.shell, 0.48, 1.15, 0, P.right);
  mk(box(0.014, 1.9, 0.01), M.cyanShell, 0.5, 1.15, 0.358, P.right);

  P.crown = new THREE.Group();
  root.add(P.crown);
  mk(rbox(1.04, 0.14, 0.74, 0.03), M.shell, 0, 2.27, 0, P.crown);
  mk(box(0.34, 0.018, 0.006), M.cyanShell, -0.27, 2.27, 0.371, P.crown);
  mk(box(0.34, 0.018, 0.006), M.cyanShell, 0.27, 2.27, 0.371, P.crown);
  mk(box(0.07, 0.016, 0.006), M.cyanShell, 0, 2.27, 0.372, P.crown);
  mk(box(0.016, 0.07, 0.006), M.cyanShell, 0, 2.27, 0.372, P.crown);

  // --- front panel with display, sensor, NFC, dispense tray
  P.front = new THREE.Group();
  root.add(P.front);
  mk(rbox(0.9, 2.08, 0.04, 0.015), M.front, 0, 1.15, 0.33, P.front);
  mk(rbox(0.68, 1.04, 0.012, 0.005), M.bezel, 0, SCREEN.y, 0.355, P.front);
  anim.screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false, transparent: true });
  mk(new THREE.PlaneGeometry(SCREEN.w, SCREEN.h), anim.screenMat, 0, SCREEN.y, SCREEN.z, P.front);
  anim.screenGlass = fresnelMat(0x9feaff, 0.35, 3.0, 0.02);
  mk(new THREE.PlaneGeometry(0.64, 1.0), anim.screenGlass, 0, SCREEN.y, 0.366, P.front);
  const sensor = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.005, 12, 48), M.cyanFront);
  sensor.position.set(-0.12, 0.76, 0.352);
  P.front.add(sensor);
  mk(new THREE.CircleGeometry(0.04, 40), M.bezel, -0.12, 0.76, 0.351, P.front);
  mk(rbox(0.16, 0.09, 0.008, 0.003), M.bezel, 0.14, 0.76, 0.352, P.front);
  mk(box(0.1, 0.006, 0.004), M.emerald, 0.14, 0.76, 0.357, P.front);
  mk(box(0.5, 0.2, 0.02), M.hole, 0, 0.38, 0.343, P.front);
  mk(box(0.52, 0.015, 0.03), M.trim, 0, 0.275, 0.355, P.front);
  mk(box(0.46, 0.008, 0.004), M.cyanFront, 0, 0.49, 0.354, P.front);
  mk(box(0.007, 1.9, 0.01), M.cyanFront, -0.425, 1.15, 0.352, P.front);
  mk(box(0.007, 1.9, 0.01), M.cyanFront, 0.425, 1.15, 0.352, P.front);

  // glow cards (cheap volumetric bloom)
  anim.glows = [];
  const gStrip = glowMat(COL.cyan, 0.3, 1, 2.6);
  anim.glows.push(gStrip);
  glowCard(0.1, 2.0, gStrip, -0.425, 1.15, 0.362, P.front);
  glowCard(0.1, 2.0, gStrip, 0.425, 1.15, 0.362, P.front);
  const gTray = glowMat(COL.cyan, 0.7, 1, 2.0);
  anim.glows.push(gTray);
  glowCard(0.62, 0.12, gTray, 0, 0.49, 0.358, P.front);
  const gSensor = glowMat(COL.cyan, 0.8, 0, 2.0);
  anim.glows.push(gSensor);
  glowCard(0.22, 0.22, gSensor, -0.12, 0.76, 0.356, P.front);
  const gScreen = glowMat(0x38bdf8, 0.22, 1, 3.0);
  anim.glows.push(gScreen);
  glowCard(0.86, 1.22, gScreen, 0, SCREEN.y, 0.3605, P.front);
  const gCrown = glowMat(COL.cyan, 0.6, 1, 2.0);
  anim.glows.push(gCrown);
  glowCard(0.95, 0.14, gCrown, 0, 2.27, 0.376, P.crown);
  const gBase = glowMat(COL.cyan, 0.5, 1, 2.0);
  anim.glows.push(gBase);
  glowCard(1.3, 0.12, gBase, 0, 0.096, 0.42, P.base);

  // --- internal module 1: thermal vault
  const thermal = new THREE.Group();
  thermal.position.y = 0.14;
  root.add(thermal);
  mk(box(0.82, 0.015, 0.54), M.frame, 0, 0.0, 0, thermal);
  mk(box(0.82, 0.015, 0.54), M.frame, 0, 0.47, 0, thermal);
  for (const sx of [-0.4, 0.4]) for (const sz of [-0.26, 0.26]) mk(box(0.02, 0.47, 0.02), M.frame, sx, 0.235, sz, thermal);
  const ledGeo = box(0.05, 0.01, 0.004);
  for (let cx = 0; cx < 4; cx++) {
    for (let ry = 0; ry < 2; ry++) {
      const x = -0.3 + cx * 0.2;
      const y = 0.125 + ry * 0.22;
      mk(rbox(0.18, 0.2, 0.46, 0.012), M.drawer, x, y, 0, thermal);
      mk(ledGeo, M.emerald, x, y + 0.07, 0.232, thermal);
    }
  }
  const gFrost = glowMat(0x9fe8ff, 0.18, 1, 1.5);
  anim.glows.push(gFrost);
  glowCard(0.9, 0.55, gFrost, 0, 0.24, 0.3, thermal);

  // --- internal module 2: robotic carousel + 6-DOF arm
  const carousel = new THREE.Group();
  carousel.position.y = 0.66;
  root.add(carousel);
  mk(box(0.82, 0.015, 0.54), M.frame, 0, 0.0, 0, carousel);
  mk(new THREE.CylinderGeometry(0.02, 0.02, 0.56, 16), M.trim, -0.08, 0.28, -0.02, carousel);
  anim.tiers = [];
  const rng = mulberry32(42);
  for (let k = 0; k < 3; k++) {
    const tier = new THREE.Group();
    tier.position.set(-0.08, 0.1 + k * 0.17, -0.02);
    carousel.add(tier);
    mk(new THREE.CylinderGeometry(0.22, 0.22, 0.012, 48), M.trim, 0, 0, 0, tier);
    const led = new THREE.Mesh(new THREE.TorusGeometry(0.222, 0.004, 8, 64), M.cyan);
    led.rotation.x = Math.PI / 2;
    tier.add(led);
    for (let b = 0; b < 10; b++) {
      const a = (b / 10) * Math.PI * 2;
      const bin = mk(rbox(0.065, 0.085, 0.065, 0.008), binMats[Math.floor(rng() * binMats.length)], Math.cos(a) * 0.165, 0.05, Math.sin(a) * 0.165, tier);
      bin.rotation.y = -a;
    }
    anim.tiers.push(tier);
  }
  // 6-DOF arm
  const arm = {};
  arm.base = new THREE.Group();
  arm.base.position.set(0.27, 0.015, 0.17);
  carousel.add(arm.base);
  mk(new THREE.CylinderGeometry(0.055, 0.06, 0.03, 32), M.armJoint, 0, 0.015, 0, arm.base);
  arm.yaw = new THREE.Group();
  arm.yaw.position.y = 0.03;
  arm.base.add(arm.yaw);
  mk(new THREE.CylinderGeometry(0.04, 0.045, 0.06, 32), M.armWhite, 0, 0.03, 0, arm.yaw);
  arm.shoulder = new THREE.Group();
  arm.shoulder.position.y = 0.07;
  arm.yaw.add(arm.shoulder);
  mk(new THREE.SphereGeometry(0.03, 20, 12), M.armJoint, 0, 0, 0, arm.shoulder);
  mk(rbox(0.04, 0.22, 0.04, 0.012), M.armWhite, 0, 0.11, 0, arm.shoulder);
  arm.elbow = new THREE.Group();
  arm.elbow.position.y = 0.22;
  arm.shoulder.add(arm.elbow);
  mk(new THREE.SphereGeometry(0.026, 20, 12), M.armJoint, 0, 0, 0, arm.elbow);
  mk(rbox(0.032, 0.18, 0.032, 0.01), M.armWhite, 0, 0.09, 0, arm.elbow);
  arm.wrist = new THREE.Group();
  arm.wrist.position.y = 0.18;
  arm.elbow.add(arm.wrist);
  mk(new THREE.SphereGeometry(0.02, 16, 10), M.armJoint, 0, 0, 0, arm.wrist);
  arm.roll = new THREE.Group();
  arm.wrist.add(arm.roll);
  mk(box(0.06, 0.02, 0.03), M.armJoint, 0, 0.02, 0, arm.roll);
  arm.fingerL = mk(box(0.008, 0.045, 0.022), M.trim, -0.02, 0.05, 0, arm.roll);
  arm.fingerR = mk(box(0.008, 0.045, 0.022), M.trim, 0.02, 0.05, 0, arm.roll);
  mk(box(0.012, 0.006, 0.006), M.cyan, 0, 0.032, 0.016, arm.roll);
  anim.arm = arm;

  // --- internal module 3: UV-C sterilization chamber
  const uvc = new THREE.Group();
  uvc.position.y = 1.28;
  root.add(uvc);
  mk(box(0.82, 0.015, 0.54), M.frame, 0, 0.0, 0, uvc);
  mk(box(0.82, 0.015, 0.54), M.frame, 0, 0.3, 0, uvc);
  for (const ly of [0.06, 0.24]) {
    for (const lz of [-0.13, 0.13]) {
      const lamp = mk(new THREE.CylinderGeometry(0.008, 0.008, 0.56, 12), M.violetLamp, 0, ly, lz, uvc);
      lamp.rotation.z = Math.PI / 2;
    }
  }
  mk(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 24), M.armWhite, 0.05, 0.06, 0, uvc);
  mk(new THREE.CylinderGeometry(0.037, 0.037, 0.025, 24), binMats[1], 0.05, 0.115, 0, uvc);
  anim.uvGlass = fresnelMat(COL.violet, 0.9, 2.2, 0.06);
  mk(rbox(0.66, 0.27, 0.46, 0.03), anim.uvGlass, 0, 0.15, 0, uvc);
  anim.uvGlow = glowMat(COL.violet, 0.9, 1, 1.4);
  glowCard(1.1, 0.6, anim.uvGlow, 0, 0.15, 0.25, uvc);
  anim.uvLight = new THREE.PointLight(0xb070ff, 0, 2.2, 1.5);
  anim.uvLight.position.set(0, 0.15, 0.1);
  uvc.add(anim.uvLight);

  // --- internal module 4: edge compute
  const compute = new THREE.Group();
  compute.position.y = 1.62;
  root.add(compute);
  mk(box(0.8, 0.012, 0.5), M.pcb, 0, 0.02, 0, compute);
  mk(box(0.62, 0.32, 0.012), M.pcb, 0, 0.2, -0.22, compute);
  for (let i = 0; i < 6; i++) mk(box(0.07, 0.012, 0.07), M.chip, -0.3 + i * 0.12, 0.032, 0.16, compute);
  mk(box(0.16, 0.05, 0.16), M.chip, -0.18, 0.05, -0.02, compute);
  for (let f = 0; f < 7; f++) mk(box(0.16, 0.06, 0.006), M.trim, 0.18, 0.06, -0.08 + f * 0.022, compute);
  anim.fans = [];
  for (const fx of [-0.22, 0.22]) {
    const fan = new THREE.Group();
    fan.position.set(fx, 0.3, -0.205);
    compute.add(fan);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.008, 8, 40), M.armJoint);
    fan.add(ring);
    for (let b = 0; b < 7; b++) {
      const blade = mk(box(0.065, 0.02, 0.004), M.frame, 0, 0, 0.004, fan);
      blade.position.set(Math.cos((b / 7) * Math.PI * 2) * 0.038, Math.sin((b / 7) * Math.PI * 2) * 0.038, 0.004);
      blade.rotation.z = (b / 7) * Math.PI * 2;
    }
    anim.fans.push(fan);
  }
  for (let i = 0; i < 8; i++) mk(box(0.012, 0.012, 0.006), i % 3 === 0 ? M.emerald : M.cyan, -0.21 + i * 0.06, 0.08, -0.212, compute);

  P.modules = [thermal, carousel, uvc, compute];
  P.moduleBase = P.modules.map((m) => m.position.y);

  // laser-scan wireframe overlay on the outer chassis (hero only)
  if (hero) {
    anim.edgeMat = new THREE.LineBasicMaterial({
      color: COL.cyan,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      clippingPlanes: [edgePlane],
    });
    for (const g of [P.base, P.back, P.left, P.right, P.crown, P.front]) {
      g.children.slice().forEach((m) => {
        if (!m.isMesh || m.material.isShaderMaterial) return;
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 40), anim.edgeMat);
        m.add(e);
      });
    }
  }

  return { root, P, anim };
}

// ---------------------------------------------------------------------------
// Scene assembly
// ---------------------------------------------------------------------------
let hero;
let clones = [];
const atrium = new THREE.Group();
const ringsGroup = new THREE.Group();
const rings = [];
let scanBeam;
let scanFrame;
let auraMat;
let darkFloor;
let contact;
let raysMats = [];
let dust;
let floorMatA;

function makeArcMesh(r0, r1, a0, al, mat, segs = 64) {
  return new THREE.Mesh(new THREE.RingGeometry(r0, r1, segs, 1, a0, al), mat);
}

function makeTicks(R, n, len, wid, mat) {
  const pos = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const tx = -sa * wid * 0.5;
    const ty = ca * wid * 0.5;
    const l = i % 6 === 0 ? len * 1.8 : len;
    const x0 = ca * R;
    const y0 = sa * R;
    const x1 = ca * (R - l);
    const y1 = sa * (R - l);
    pos.push(x0 - tx, y0 - ty, 0, x0 + tx, y0 + ty, 0, x1 + tx, y1 + ty, 0);
    pos.push(x0 - tx, y0 - ty, 0, x1 + tx, y1 + ty, 0, x1 - tx, y1 - ty, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Mesh(g, mat);
}

function buildScene(screenTex) {
  hero = buildKiosk(screenTex, true);
  scene.add(hero.root);
  hero.root.traverse((o) => {
    if (o.isMesh && o.material && !o.material.isShaderMaterial) {
      o.material.clippingPlanes = [revealPlane];
    }
    if (o.isMesh && o.material && o.material.isShaderMaterial && o.material.clipping) {
      o.material.clippingPlanes = [revealPlane];
    }
  });

  // floor in the void: obsidian with a radial fade into the noise field
  const fadeTex = radialTexture("#ffffff", "#000000");
  darkFloor = new THREE.Mesh(
    new THREE.CircleGeometry(7, 96),
    new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.6, metalness: 0.15, transparent: true, alphaMap: fadeTex, envMapIntensity: 0.25, depthWrite: false }),
  );
  darkFloor.rotation.x = -Math.PI / 2;
  scene.add(darkFloor);

  contact = new THREE.Mesh(
    new THREE.PlaneGeometry(2.0, 1.7),
    new THREE.MeshBasicMaterial({ map: radialTexture("rgba(0,0,0,0.85)", "rgba(0,0,0,0)"), transparent: true, depthWrite: false }),
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.002;
  scene.add(contact);

  auraMat = new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: AURA_FRAG,
    uniforms: {
      uColorA: { value: new THREE.Color(COL.cyan) },
      uColorB: { value: new THREE.Color(COL.violet) },
      uIntensity: { value: 0 },
      uTime: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const aura = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), auraMat);
  aura.rotation.x = -Math.PI / 2;
  aura.position.y = 0.004;
  scene.add(aura);

  // laser scan beam + cutting frame
  scanBeam = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.16), glowMat(COL.cyan, 1.4, 1, 6.0));
  scanBeam.position.z = 0.42;
  scene.add(scanBeam);
  scanFrame = new THREE.Group();
  const fm = basic(COL.cyan, { transparent: true });
  mk(box(1.2, 0.008, 0.008), fm, 0, 0, 0.43, scanFrame);
  mk(box(1.2, 0.008, 0.008), fm, 0, 0, -0.43, scanFrame);
  mk(box(0.008, 0.008, 0.86), fm, 0.6, 0, 0, scanFrame);
  mk(box(0.008, 0.008, 0.86), fm, -0.6, 0, 0, scanFrame);
  scanFrame.userData.mat = fm;
  scene.add(scanFrame);

  // HUD telemetry rings
  const ringDefs = [
    { R: 0.95, y: 0.55, tilt: 0.1, speed: 0.35, color: COL.cyan },
    { R: 1.2, y: 1.25, tilt: -0.14, speed: -0.25, color: COL.emerald },
    { R: 1.42, y: 1.95, tilt: 0.18, speed: 0.18, color: COL.cyan },
  ];
  ringDefs.forEach((d, i) => {
    const holder = new THREE.Group();
    holder.position.y = d.y;
    holder.rotation.x = -Math.PI / 2 + d.tilt;
    const spin = new THREE.Group();
    holder.add(spin);
    const mat = basic(d.color, { transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    spin.add(makeArcMesh(d.R - 0.004, d.R + 0.004, 0, Math.PI * 2, mat, 160));
    for (let j = 0; j < 5; j++) spin.add(makeArcMesh(d.R + 0.03, d.R + 0.05, j * 1.26 + i, 0.6 + 0.1 * j, mat, 24));
    spin.add(makeTicks(d.R - 0.02, 96, 0.035, 0.005, mat));
    ringsGroup.add(holder);
    rings.push({ holder, spin, mat, def: d });
  });
  scene.add(ringsGroup);

  // ---------------- atrium -----------------
  scene.add(atrium);
  floorMatA = new THREE.MeshStandardMaterial({ color: 0xb9ad9a, roughness: 0.18, metalness: 0.0, transparent: true, envMapIntensity: 0.8 });
  const floorA = new THREE.Mesh(new THREE.PlaneGeometry(70, 40), floorMatA);
  floorA.rotation.x = -Math.PI / 2;
  floorA.position.y = -0.001;
  atrium.add(floorA);
  const plaster = new THREE.MeshStandardMaterial({ color: 0xd9d0c2, roughness: 0.75, transparent: true });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xc9bca8, roughness: 0.9, transparent: true });
  const winMat = basic(0xffe7b8, { transparent: true });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(70, 16), wallMat);
  wall.position.set(0, 8, -9);
  atrium.add(wall);
  for (let i = -4; i <= 4; i++) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.42, 12, 32), plaster);
    col.position.set(i * 5.2, 6, -6.2);
    atrium.add(col);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 9), winMat);
    win.position.set(i * 5.2 + 2.6, 6.2, -8.95);
    atrium.add(win);
  }
  const balcony = new THREE.Mesh(new THREE.BoxGeometry(70, 0.5, 2.5), plaster);
  balcony.position.set(0, 6.0, -7.3);
  atrium.add(balcony);
  // planters
  const potMat = new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.4, metalness: 0.4, transparent: true });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f8a4a, roughness: 0.7, transparent: true, flatShading: true });
  for (const px of [-9.6, -4.8, 4.8, 9.6]) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.38, 0.8, 24), potMat);
    pot.position.set(px, 0.4, -3.6);
    atrium.add(pot);
    const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 1), leafMat);
    leaf.position.set(px, 1.35, -3.6);
    leaf.scale.set(1, 1.25, 1);
    atrium.add(leaf);
  }
  // skylight god rays
  for (let i = 0; i < 6; i++) {
    const m = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT,
      fragmentShader: RAYS_FRAG,
      uniforms: { uColor: { value: new THREE.Color(0xfff0d0) }, uIntensity: { value: 0 }, uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    raysMats.push(m);
    const ray = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 16), m);
    ray.position.set(-11 + i * 4.6, 7, -2.5 + (i % 2) * 1.5);
    ray.rotation.z = -0.42;
    atrium.add(ray);
  }
  // dust motes in the light
  const rng = mulberry32(7);
  const dp = [];
  for (let i = 0; i < 700; i++) dp.push((rng() - 0.5) * 26, rng() * 7, (rng() - 0.5) * 9 - 1);
  const dg = new THREE.BufferGeometry();
  dg.setAttribute("position", new THREE.Float32BufferAttribute(dp, 3));
  dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xfff2d6, size: 0.035, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  dust.userData.base = dp.slice();
  atrium.add(dust);
  // fleet of kiosks
  const shadowTex = radialTexture("rgba(60,40,20,0.55)", "rgba(0,0,0,0)");
  const fleetX = [-7.2, -3.6, 3.6, 7.2];
  fleetX.forEach((x, i) => {
    const k = hero.root.clone(true);
    k.traverse((o) => {
      if (o.isLineSegments) o.visible = false;
    });
    k.position.set(x, 0, -0.4 - (i % 2) * 0.9);
    k.rotation.y = x < 0 ? 0.18 : -0.18;
    atrium.add(k);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.9), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    sh.rotation.x = -Math.PI / 2;
    sh.position.set(x, 0.003, k.position.z);
    atrium.add(sh);
    clones.push({ k, sh, i });
  });
  atrium.userData.fadeMats = [floorMatA, plaster, wallMat, winMat, potMat, leafMat];
}

// ---------------------------------------------------------------------------
// Camera rig — keyframes plus an orbit segment for the exploded view
// ---------------------------------------------------------------------------
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const ORBIT = { t0: 31.8, t1: 44.2, a0: 0.62, a1: -0.42, r: 9.0, h: 2.7, target: V(0, 1.7, 0) };
function orbitPose(t) {
  const u = smooth(seg(t, ORBIT.t0, ORBIT.t1));
  const a = lerp(ORBIT.a0, ORBIT.a1, u);
  return { p: V(Math.sin(a) * ORBIT.r, ORBIT.h, Math.cos(a) * ORBIT.r), q: ORBIT.target.clone() };
}
const SCREEN_CAM = { p: V(0, SCREEN.y, SCREEN.z + 1.93), q: V(0, SCREEN.y, SCREEN.z) };
const CAM_KEYS = [
  { t: 0, p: V(0, 1.17, 9.4), q: V(0, 1.17, 0) },
  { t: 5, p: V(0, 1.17, 8.8), q: V(0, 1.17, 0), ease: lin },
  { t: 9.8, p: V(0, 1.17, 8.0), q: V(0, 1.17, 0), ease: lin },
  { t: 14.6, p: V(-3.0, 1.8, 6.4), q: V(-1.1, 1.15, 0), ease: ioc },
  { t: 15.2, p: V(-3.05, 1.82, 6.3), q: V(-1.1, 1.15, 0), ease: lin },
  { t: 17.6, p: SCREEN_CAM.p, q: SCREEN_CAM.q, ease: ioc },
  { t: 29.0, p: SCREEN_CAM.p, q: SCREEN_CAM.q, ease: lin },
  { t: ORBIT.t0, ...orbitPose(ORBIT.t0), ease: ioc },
  { t: ORBIT.t1, ...orbitPose(ORBIT.t1), ease: lin, orbit: true },
  { t: 48.0, p: V(0, 2.7, 15.5), q: V(0, 1.5, 0), ease: ioc },
  { t: 51.4, p: V(3.4, 2.1, 12.6), q: V(1.0, 1.3, 0), ease: ioc },
  { t: 54.4, p: V(1.5, 1.24, 7.3), q: V(1.5, 1.1, 0), ease: ioc },
  { t: 60.0, p: V(1.4, 1.22, 6.75), q: V(1.4, 1.1, 0), ease: lin },
];
const _cp = new THREE.Vector3();
const _cq = new THREE.Vector3();
function camAt(t) {
  if (t >= ORBIT.t0 && t <= ORBIT.t1) return orbitPose(t);
  let i = 0;
  while (i < CAM_KEYS.length - 1 && t >= CAM_KEYS[i + 1].t) i++;
  const A = CAM_KEYS[i];
  const B = CAM_KEYS[Math.min(i + 1, CAM_KEYS.length - 1)];
  if (A === B) return { p: A.p.clone(), q: A.q.clone() };
  const k = (B.ease || ioc)(seg(t, A.t, B.t));
  return { p: _cp.copy(A.p).lerp(B.p, k).clone(), q: _cq.copy(A.q).lerp(B.q, k).clone() };
}

// ---------------------------------------------------------------------------
// Projection helpers for DOM/SVG anchoring
// ---------------------------------------------------------------------------
const _v = new THREE.Vector3();
function project(v3) {
  _v.copy(v3).project(camera);
  return { x: (_v.x + 1) * 0.5 * W, y: (1 - _v.y) * 0.5 * H, z: _v.z };
}
function worldOf(obj, x, y, z) {
  return obj.localToWorld(new THREE.Vector3(x, y, z));
}

// ---------------------------------------------------------------------------
// Heartbeat model (72 BPM) shared by the pulse ring, ECG strip and visualizer
// ---------------------------------------------------------------------------
const BEAT0 = 20.0;
const BEAT = 60 / 72;
const BEAT_END = 29.2;
function lastBeat(t) {
  if (t < BEAT0) return null;
  const n = Math.floor((t - BEAT0) / BEAT);
  return { n, tb: BEAT0 + n * BEAT };
}
function heartEnv(t) {
  if (t < BEAT0 || t > BEAT_END) return 0;
  const age = t - lastBeat(t).tb;
  const lub = Math.exp(-age * 9);
  const dub = age > 0.18 ? 0.55 * Math.exp(-(age - 0.18) * 11) : 0;
  return Math.min(1, lub + dub);
}
function ecgAt(ts) {
  if (ts < BEAT0) return 0;
  const ph = frac((ts - BEAT0) / BEAT);
  return (
    gauss(ph, 0.1, 0.025) * 0.12 -
    gauss(ph, 0.2, 0.01) * 0.15 +
    gauss(ph, 0.23, 0.012) * 1.0 -
    gauss(ph, 0.26, 0.012) * 0.28 +
    gauss(ph, 0.46, 0.045) * 0.26
  );
}

// ---------------------------------------------------------------------------
// Three.js frame update — pure function of t
// ---------------------------------------------------------------------------
const ARM_POSES = [
  { yaw: 0.0, sh: -0.35, el: 1.15, wp: 0.65, wr: 0.0, g: 1 },
  { yaw: -1.25, sh: -0.95, el: 1.45, wp: 0.9, wr: 0.8, g: 1 },
  { yaw: -1.25, sh: -1.0, el: 1.55, wp: 0.95, wr: 0.8, g: 0 },
  { yaw: -0.55, sh: -0.4, el: 1.0, wp: 0.5, wr: 0.2, g: 0 },
  { yaw: 0.95, sh: -0.75, el: 1.35, wp: 0.9, wr: -0.6, g: 0 },
  { yaw: 0.95, sh: -0.75, el: 1.35, wp: 0.9, wr: -0.6, g: 1 },
];
function poseArm(arm, t) {
  const P = 1.6;
  const u = (frac(t / P) * ARM_POSES.length) % ARM_POSES.length;
  const i = Math.floor(u);
  const k = ioc(u - i);
  const A = ARM_POSES[i];
  const B = ARM_POSES[(i + 1) % ARM_POSES.length];
  arm.yaw.rotation.y = lerp(A.yaw, B.yaw, k);
  arm.shoulder.rotation.x = lerp(A.sh, B.sh, k);
  arm.elbow.rotation.x = lerp(A.el, B.el, k);
  arm.wrist.rotation.x = lerp(A.wp, B.wp, k);
  arm.roll.rotation.y = lerp(A.wr, B.wr, k);
  const open = lerp(A.g, B.g, k);
  arm.fingerL.position.x = -0.012 - 0.012 * open;
  arm.fingerR.position.x = 0.012 + 0.012 * open;
}

function animateMechanics(k, t) {
  k.anim.tiers.forEach((tier, i) => {
    const rate = [1.6, 1.15, 2.1][i];
    const dir = i % 2 ? -1 : 1;
    const u = t * rate;
    tier.rotation.y = dir * (Math.floor(u) + ioc(clamp01(frac(u) * 1.8))) * ((Math.PI * 2) / 10);
  });
  poseArm(k.anim.arm, t);
  k.anim.fans.forEach((f, i) => (f.rotation.z = t * (18 + i * 3)));
}

function applyExplode(k, e) {
  const P = k.P;
  P.left.position.x = -0.75 * e;
  P.left.rotation.y = -0.22 * e;
  P.right.position.x = 0.75 * e;
  P.right.rotation.y = 0.22 * e;
  P.back.position.z = -0.7 * e;
  P.crown.position.y = 1.5 * e;
  P.front.position.z = 1.35 * e;
  P.front.position.y = 0.08 * e;
  const lift = [0, 0.32, 0.66, 1.02];
  P.modules.forEach((m, i) => (m.position.y = P.moduleBase[i] + lift[i] * e));
}

function updateThree(t) {
  const c = camAt(t);
  camera.position.copy(c.p);
  camera.lookAt(c.q);
  camera.updateMatrixWorld();

  // --- scene 01 laser-scan reveal
  const rv = seg(t, 5.2, 8.8);
  const scanY = t < 5.2 ? -0.1 : t > 8.9 ? 100 : lerp(-0.05, 2.42, ioc(rv));
  revealPlane.constant = scanY;
  edgePlane.constant = -scanY;
  const scanOn = t > 5.15 && t < 8.9;
  scanBeam.visible = scanOn;
  scanFrame.visible = scanOn;
  if (scanOn) {
    scanBeam.position.y = scanY;
    scanFrame.position.y = scanY;
    scanFrame.userData.mat.opacity = 0.9;
  }
  hero.anim.edgeMat.opacity = 0.75 * seg(t, 5.0, 5.6) * (1 - seg(t, 8.6, 9.4));

  // --- explode / atrium factors
  const e = ioc(seg(t, 31.0, 35.0)) * (1 - ioc(seg(t, 42.6, 45.2)));
  const a = ioc(seg(t, 44.6, 46.8)) * (1 - ioc(seg(t, 51.0, 53.2)));
  applyExplode(hero, e);
  animateMechanics(hero, t);

  // shell + front fade during explode
  setFade(M.shell, lerp(1, 0.2, e));
  setFade(M.front, lerp(1, 0.12, e));
  setFade(M.bezel, lerp(1, 0.12, e));
  M.cyanShell.opacity = lerp(1, 0.35, e);
  M.cyanFront.opacity = lerp(1, 0.2, e);
  hero.anim.screenMat.opacity = lerp(1, 0.12, e);
  hero.anim.screenGlass.uniforms.uIntensity.value = 0.35 * (1 - e);

  // glows appear once the scan has passed, dim in the exploded view
  const glowK = seg(t, 8.2, 9.4) * (1 - 0.6 * e);
  hero.anim.glows.forEach((g) => {
    if (g.userData.base === undefined) g.userData.base = g.uniforms.uIntensity.value;
    g.uniforms.uIntensity.value = g.userData.base * glowK;
  });

  // UV-C chamber pulse
  const pulse = 0.5 + 0.5 * Math.sin(t * 6.2);
  hero.anim.uvGlass.uniforms.uPulse.value = pulse;
  hero.anim.uvGlass.uniforms.uIntensity.value = 0.35 + 0.75 * e;
  hero.anim.uvGlow.uniforms.uIntensity.value = (0.25 + 0.9 * e) * (0.6 + 0.4 * pulse) * seg(t, 8.2, 9.4);
  hero.anim.uvLight.intensity = 1.5 * e * (0.5 + 0.5 * pulse);

  // --- HUD rings (scene 01)
  const ringK = seg(t, 9.9, 11.0) * (1 - seg(t, 14.5, 15.3));
  ringsGroup.visible = ringK > 0.001;
  rings.forEach((r, i) => {
    r.mat.opacity = ringK * (i === 1 ? 0.85 : 0.75);
    r.spin.rotation.z = t * r.def.speed + i;
    r.holder.rotation.x = -Math.PI / 2 + r.def.tilt + Math.sin(t * 0.6 + i) * 0.05;
    r.holder.rotation.z = Math.sin(t * 0.45 + i * 2) * 0.06;
    const s = lerp(0.85, 1, ioc(seg(t, 9.9 + i * 0.2, 11.2 + i * 0.2)));
    r.holder.scale.setScalar(s);
  });

  // --- aura from the base
  let auraI = 0.55 * seg(t, 8.4, 9.6);
  auraI = lerp(auraI, 0.35, seg(t, 31, 33));
  auraI = lerp(auraI, 0.15, a);
  auraI = lerp(auraI, 1.6, seg(t, 52.4, 54.6));
  auraMat.uniforms.uIntensity.value = auraI * (0.85 + 0.15 * Math.sin(t * 3.1));
  auraMat.uniforms.uTime.value = t;

  // --- atrium
  atrium.visible = a > 0.001;
  darkFloor.material.opacity = 1 - a;
  contact.material.opacity = 0.9 * seg(t, 5.2, 6.4);
  if (atrium.visible) {
    atrium.userData.fadeMats.forEach((m) => {
      m.opacity = a;
      m.depthWrite = a > 0.98;
    });
    raysMats.forEach((m) => {
      m.uniforms.uIntensity.value = 0.32 * a;
      m.uniforms.uTime.value = t;
    });
    dust.material.opacity = 0.7 * a;
    const pos = dust.geometry.attributes.position;
    const base = dust.userData.base;
    for (let i = 0; i < pos.count; i++) {
      pos.array[i * 3] = base[i * 3] + Math.sin(t * 0.3 + i) * 0.15;
      pos.array[i * 3 + 1] = base[i * 3 + 1] + frac(t * 0.02 + i * 0.13) * 0.6;
    }
    pos.needsUpdate = true;
    clones.forEach(({ k, sh, i }) => {
      const up = ioc(seg(t, 45.0 + i * 0.25, 46.6 + i * 0.25)) * (1 - ioc(seg(t, 50.8 + i * 0.12, 52.2 + i * 0.12)));
      k.scale.set(1, Math.max(0.001, up), 1);
      k.visible = up > 0.002;
      sh.material.opacity = up;
    });
  }
  sun.intensity = 1.9 * a;
  sunFill.intensity = 0.7 * a;
  hemi.intensity = 0.7 * (1 - a);
  rim.intensity = 2.4 * (1 - 0.7 * a);
  rim2.intensity = 1.6 * (1 - 0.8 * a);
  scene.environmentIntensity = 0.8 + 0.3 * a;
  renderer.toneMappingExposure = 1.0 - 0.12 * a;

  // --- background noise field
  bgMat.uniforms.uTime.value = t;
  bgMat.uniforms.uAtrium.value = a;
  let energy = 1.0;
  energy = lerp(energy, 0.6, seg(t, 16, 18) * (1 - seg(t, 29, 31)));
  bgMat.uniforms.uEnergy.value = energy;
  const flash = (x) => Math.max(0, 1 - Math.abs(t - x) / 0.25);
  bgMat.uniforms.uFlash.value = flash(15.0) + flash(30.0) + flash(45.0);

  if (EXP.nogl) return;
  renderer.setRenderTarget(bgRT);
  renderer.render(bgScene, bgCam);
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Procedural DOM / SVG readouts — pure functions of t
// ---------------------------------------------------------------------------
const els = {};
const SCRAMBLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&@$/<>[]{}=+*";
const TITLE_LINES = ["THE FUTURE OF", "AUTONOMOUS TRIAGE", "& DISPENSING"];
const BOOT = [
  ["MEDVEND OS 4.2.0 // COLD BOOT", ""],
  ["MOUNTING BIOMETRIC ARRAY ......", "OK"],
  ["CALIBRATING 6-DOF PICKER ......", "OK"],
  ["UV-C EMITTERS 254nm ...........", "OK"],
  ["THERMAL VAULT 4.0°C ...........", "OK"],
  ["FHIR R4 GATEWAY ...............", "LINKED"],
];
const URL_TEXT = "https://atectonicc-ui.github.io/medvend-health-kiosk/";
const RADAR = { cx: 286, cy: 300, R: 165, labels: ["UPTIME", "ACCURACY", "SPEED", "STERILITY", "THERMAL", "SECURITY"], vals: [0.99, 0.95, 0.9, 0.97, 0.92, 0.96] };

function escapeHTML(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cacheEls() {
  [
    "bootlog", "title-scramble", "tl-temp", "tl-ready", "tl-enc", "tl-link", "tl-temp-v", "tl-ready-v", "tl-enc-v",
    "bp-xf", "bp-clip-rect", "kiosk-ui", "pulse-a", "pulse-b", "pulse-c", "bio-core-glow", "bio-status",
    "v-hr", "v-spo2", "v-temp", "v-bp", "viz-bpm-v", "tri-scan", "conf-val", "hex", "pipe-dot",
    "mv-uptime", "mv-thru", "mv-vault", "thru-v", "radar-poly", "radar-dots", "tmatrix",
    "co-picker", "co-compute", "co-uvc", "co-thermal", "ld-picker", "ld-compute", "ld-uvc", "ld-thermal",
    "lk-url-text", "lk-caret", "hud-tc", "hud-f",
  ].forEach((id) => (els[id] = document.getElementById(id)));
  els.ecg = document.getElementById("ecg-canvas").getContext("2d");
  els.viz = document.getElementById("viz-canvas").getContext("2d");
  els.nfcw = [...document.querySelectorAll(".nfcw")];
  els.nfcs = [...document.querySelectorAll(".nfcs")];
  els.tcells = [...els.tmatrix.children];
}

function scrambleLines(t) {
  if (t < 10.95) return "";
  let idx = 0;
  const out = [];
  const tick = Math.floor(t * 24);
  for (const line of TITLE_LINES) {
    let html = "";
    for (const ch of line) {
      const i = idx++;
      const appear = 11.0 + i * 0.022;
      const resolve = 11.6 + i * 0.038 + hash2(i, 99) * 0.4;
      if (t < appear) continue;
      if (ch === " ") {
        html += " ";
      } else if (t >= resolve) {
        html += escapeHTML(ch);
      } else {
        const r = SCRAMBLE[Math.floor(hash2(i, tick) * SCRAMBLE.length)];
        html += `<span class="sc">${escapeHTML(r)}</span>`;
      }
    }
    out.push(`<div>${html || "&nbsp;"}</div>`);
  }
  return out.join("");
}

function placeLabel(el, anchor, dx, dy, alignRight) {
  const p = project(anchor);
  const w = el.offsetWidth;
  let x = alignRight ? p.x - dx - w : p.x + dx;
  x = Math.max(140, Math.min(W - 140 - w, x));
  el.style.left = `${x.toFixed(1)}px`;
  el.style.top = `${(p.y + dy).toFixed(1)}px`;
}

function screenRect() {
  const a = project(worldOf(hero.P.front, -SCREEN.w / 2, SCREEN.y + SCREEN.h / 2, SCREEN.z));
  const b = project(worldOf(hero.P.front, SCREEN.w / 2, SCREEN.y - SCREEN.h / 2, SCREEN.z));
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function drawECG(ctx, t) {
  const w = 1134;
  const h = 226;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(148,163,184,0.12)";
  ctx.lineWidth = 2;
  for (let x = 0; x < w; x += 54) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 45) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  const pts = [];
  for (let x = 0; x <= w; x += 3) {
    const ts = t - ((w - x) / w) * 2.6;
    pts.push([x, h * 0.62 - ecgAt(ts) * h * 0.5]);
  }
  for (const [lw, col] of [
    [10, "rgba(0,243,255,0.18)"],
    [4, "#00F3FF"],
  ]) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = col;
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  const [hx, hy] = pts[pts.length - 1];
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(hx - 4, hy, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '600 26px "JetBrains Mono"';
  ctx.fillStyle = "#67e8f9";
  ctx.fillText("ECG · LEAD II · 25 mm/s", 24, 38);
}

function drawViz(ctx, t) {
  const w = 900;
  const h = 400;
  ctx.clearRect(0, 0, w, h);
  const env = heartEnv(t);
  const n = 48;
  const bw = w / n;
  for (let i = 0; i < n; i++) {
    const shape = 0.25 + 0.75 * Math.pow(Math.sin((i / (n - 1)) * Math.PI), 1.4) * (0.55 + 0.45 * hash2(i, 3));
    const idle = 0.06 + 0.04 * Math.sin(t * 7 + i * 0.9);
    const amp = (idle + env * shape * (0.75 + 0.25 * Math.sin(t * 23 + i * 1.7))) * 150;
    const x = i * bw + bw * 0.2;
    const g = ctx.createLinearGradient(0, h / 2 - amp, 0, h / 2 + amp);
    g.addColorStop(0, "#00F3FF");
    g.addColorStop(0.5, "#00FF87");
    g.addColorStop(1, "#00F3FF");
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x, h / 2 - amp, bw * 0.6, amp * 2);
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  for (let x = 0; x <= w; x += 4) {
    const u = x / w;
    const y = h / 2 + Math.sin(u * 30 + t * 9) * Math.sin(u * Math.PI) * (12 + env * 70) * Math.sin(u * 7 - t * 3);
    x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

function fmt(n, d) {
  return n.toFixed(d);
}

function updateDom(t) {
  const f = Math.round(t * FPS);
  setText(els["hud-f"], String(Math.min(f, TOTAL_FRAMES)).padStart(4, "0"));
  const ss = Math.floor(t);
  setText(els["hud-tc"], `00:${String(ss).padStart(2, "0")}.${String(Math.floor((t - ss) * 100)).padStart(2, "0")}`);

  // ---------- scene 01 ----------
  if (t < 15.5) {
    // boot log typing
    let html = "";
    BOOT.forEach(([txt, ok], i) => {
      const t0 = 0.45 + i * 0.6;
      const n = Math.floor(seg(t, t0, t0 + 0.42) * txt.length);
      if (n <= 0) return;
      html += "&gt; " + escapeHTML(txt.slice(0, n));
      if (ok && t > t0 + 0.5) html += ` <span class="ok">${ok}</span>`;
      html += "\n";
    });
    if (t > 4.3) html += `<span class="ok">&gt; ALL SYSTEMS NOMINAL_</span>`;
    setHTML(els.bootlog, html);

    // blueprint locked to the 3D front face
    if (t < 10) {
      const p0 = project(V(0, 0, 0.35));
      const p1 = project(V(0, 2.34, 0.35));
      const s = (p0.y - p1.y) / 2340;
      els["bp-xf"].setAttribute("transform", `translate(${fmt(p0.x, 2)} ${fmt(p0.y, 2)}) scale(${fmt(s, 5)})`);
      // clip the blueprint to the region above the laser scan line
      const scanY = t < 5.2 ? -0.1 : lerp(-0.05, 2.42, ioc(seg(t, 5.2, 8.8)));
      // clip rect lives in blueprint mm space (y up is negative); keep floor dimensions until the scan starts
      const yCut = scanY <= 0 ? 600 : -scanY * 1000;
      els["bp-clip-rect"].setAttribute("y", "-4000");
      els["bp-clip-rect"].setAttribute("height", fmt(Math.max(0, 4000 + yCut), 1));
    }

    // telemetry ring labels + counters
    if (t > 9.8) {
      const top = rings[2];
      const mid = rings[1];
      const low = rings[0];
      placeLabel(els["tl-temp"], worldOf(top.holder, top.def.R * 0.96, 0, 0), 36, -34, false);
      placeLabel(els["tl-ready"], worldOf(mid.holder, mid.def.R * 0.96, 0, 0), 36, -34, false);
      placeLabel(els["tl-enc"], worldOf(low.holder, low.def.R * 0.96, 0, 0), 36, -34, false);
      placeLabel(els["tl-link"], worldOf(low.holder, 0, -low.def.R, 0), 0, 40, false);
      const temp = lerp(21.0, 36.5, ioc(seg(t, 10.6, 12.6)));
      setText(els["tl-temp-v"], `${fmt(temp, 1)}°C`);
      const ready = t < 11.4 ? (Math.floor(t * 6) % 2 ? "SYSTEM_BOOT" : "SYSTEM_BOOT_") : "SYSTEM_READY";
      setText(els["tl-ready-v"], ready);
      const encN = Math.floor(seg(t, 11.0, 11.8) * 7);
      let enc = "AES-256".slice(0, encN);
      for (let i = encN; i < 7; i++) enc += SCRAMBLE[Math.floor(hash2(i + 40, Math.floor(t * 24)) * 36)];
      setText(els["tl-enc-v"], enc);
    }

    setHTML(els["title-scramble"], scrambleLines(t));
  }

  // ---------- scene 02 ----------
  if (t >= 15 && t < 31) {
    // panel tracks the 3D screen during the dolly in and the pull-out
    let r;
    if ((t >= 16.3 && t < 17.6) || (t >= 29.0 && t < 30.8)) r = screenRect();
    else r = els.__fixedRect;
    const sc = r.h / 2000;
    const ku = els["kiosk-ui"];
    ku.style.left = `${fmt(r.x, 2)}px`;
    ku.style.top = `${fmt(r.y, 2)}px`;
    ku.style.transform = `scale(${fmt(sc, 5)})`;

    // heartbeat-driven sensor
    const beat = lastBeat(t);
    const pulses = [els["pulse-a"], els["pulse-b"], els["pulse-c"]];
    pulses.forEach((p, k) => {
      let o = 0;
      let s = 1;
      if (beat && t < BEAT_END && beat.n - k >= 0) {
        const age = t - (beat.tb - k * BEAT);
        s = 1 + age * 0.32;
        o = Math.max(0, 1 - age / (BEAT * 2.6)) * 0.9;
      }
      p.style.transform = `scale(${fmt(s, 4)})`;
      p.style.opacity = fmt(o, 3);
    });
    const env = heartEnv(t);
    els["bio-core-glow"].style.opacity = fmt(t >= BEAT0 ? 0.3 + 0.7 * env : 0, 3);
    setText(els["bio-status"], t < 19.95 ? "PLACE FINGER ON SENSOR" : t < 21.9 ? "SCANNING · HOLD STILL" : "VITALS CAPTURED ✓");

    const hr = t < 20 ? "--" : t < 21.4 ? String(Math.round(lerp(58, 72, ioc(seg(t, 20, 21.4))))) : String(72 + Math.round(Math.sin(t * 0.9) * 0.6));
    setText(els["v-hr"], hr);
    setText(els["viz-bpm-v"], hr);
    setText(els["v-spo2"], t < 20.3 ? "--" : String(Math.round(lerp(90, 98, ioc(seg(t, 20.3, 21.6))))));
    setText(els["v-temp"], t < 20.5 ? "--.-" : fmt(lerp(35.0, 36.6, ioc(seg(t, 20.5, 21.8))), 1));
    setText(els["v-bp"], t < 20.7 ? "---/--" : `${Math.round(lerp(90, 118, ioc(seg(t, 20.7, 22.0))))}/${Math.round(lerp(60, 76, ioc(seg(t, 20.7, 22.0))))}`);
    if (t > 18.8 && t < 22.9) drawECG(els.ecg, t);
    if (t > 19.8 && t < 29.6) drawViz(els.viz, t);

    // encryption hex stream + pipeline packet
    if (t > 19.4 && t < 29.6) {
      const tick = Math.floor(t * 12);
      const rows = [];
      for (let r2 = 0; r2 < 6; r2++) {
        let row = "";
        for (let c2 = 0; c2 < 24; c2++) {
          row += "0123456789abcdef"[Math.floor(hash2(tick + r2, c2 * 7 + 1) * 16)];
          if (c2 % 4 === 3 && c2 < 23) row += " ";
        }
        rows.push(row);
      }
      setText(els.hex, rows.join("\n"));
      els["pipe-dot"].style.left = `${fmt(40 + 808 * frac((t - 19.6) / 1.6), 1)}px`;
    }

    // triage readouts
    const pc = Math.round(1284 * ioc(seg(t, 24.0, 25.1)));
    setText(els["tri-scan"], t < 25.2 ? `Cross-checking ${pc.toLocaleString("en-US")} clinical protocols…` : "Analysis complete · 1,284 protocols · 0 red flags");
    setText(els["conf-val"], `${fmt(97.3 * ioc(seg(t, 25.3, 26.0)), 1)}%`);

    // NFC waves
    const authorized = t >= 27.0;
    [els.nfcw, els.nfcs].forEach((set) =>
      set.forEach((w, k) => {
        const o = authorized ? 1 : 0.25 + 0.75 * Math.max(0, Math.sin((t * 2.4 - k * 0.33) * Math.PI));
        w.style.opacity = fmt(o, 3);
        w.style.stroke = authorized ? "#00FF87" : "";
      }),
    );
  }

  // ---------- scene 03 ----------
  if (t >= 30 && t < 45.6) {
    setText(els["mv-uptime"], `${fmt(99.99 * ioc(seg(t, 32.4, 34.6)), 2)}%`);
    setText(els["mv-thru"], `${Math.round(45 * ioc(seg(t, 32.8, 34.8)))}s`);
    setText(els["mv-vault"], `${fmt(4.0 * ioc(seg(t, 33.0, 35.0)), 1)}°`);
    setText(els["thru-v"], String(Math.round(64 * ioc(seg(t, 33.0, 35.0)))));

    // radar morph
    const k = ioc(seg(t, 33.4, 35.4));
    const pts = [];
    let dots = "";
    RADAR.vals.forEach((v, i) => {
      const r = lerp(0.06, v, k) + 0.012 * Math.sin(t * 2.2 + i * 1.3) * k;
      const ang = -Math.PI / 2 + (i / 6) * Math.PI * 2;
      const x = RADAR.cx + Math.cos(ang) * RADAR.R * r;
      const y = RADAR.cy + Math.sin(ang) * RADAR.R * r;
      pts.push(`${fmt(x, 1)},${fmt(y, 1)}`);
      dots += `<circle cx="${fmt(x, 1)}" cy="${fmt(y, 1)}" r="9"/>`;
    });
    els["radar-poly"].setAttribute("points", pts.join(" "));
    setHTML(els["radar-dots"], dots);

    // thermal matrix telemetry
    const base = [4.0, 4.1, 3.9, 4.2, 4.0, 3.8, 4.1, 4.0];
    els.tcells.forEach((cell, i) => {
      const v = base[i] + 0.1 * Math.round(Math.sin(t * 0.9 + i * 1.7) * 1.4);
      setText(cell, `${fmt(v, 1)}°`);
    });

    // callouts anchored to the exploded hardware
    const mods = hero.P.modules;
    const anchors = {
      picker: hero.anim.arm.wrist.getWorldPosition(new THREE.Vector3()),
      compute: worldOf(mods[3], 0.3, 0.12, 0.15),
      uvc: worldOf(mods[2], -0.31, 0.15, 0.2),
      thermal: worldOf(mods[0], -0.36, 0.3, 0.24),
    };
    const layout = { picker: [2500, false], compute: [2500, false], uvc: [1340, true], thermal: [1340, true] };
    for (const name of Object.keys(anchors)) {
      const p = project(anchors[name]);
      const box = els[`co-${name}`];
      const [edge, left] = layout[name];
      const bw = box.offsetWidth;
      const bh = box.offsetHeight;
      const x = left ? edge - bw : edge;
      const y = Math.max(240, Math.min(H - 260 - bh, p.y - bh / 2));
      box.style.left = `${fmt(x, 1)}px`;
      box.style.top = `${fmt(y, 1)}px`;
      const g = els[`ld-${name}`];
      const ln = g.children[0];
      const ci = g.children[1];
      ln.setAttribute("x1", fmt(p.x, 1));
      ln.setAttribute("y1", fmt(p.y, 1));
      ln.setAttribute("x2", fmt(left ? edge : edge, 1));
      ln.setAttribute("y2", fmt(y + Math.min(bh / 2, 46), 1));
      ci.setAttribute("cx", fmt(p.x, 1));
      ci.setAttribute("cy", fmt(p.y, 1));
    }
  }

  // ---------- scene 04 ----------
  if (t >= 54) {
    const n = Math.floor(seg(t, 56.1, 57.5) * URL_TEXT.length);
    setText(els["lk-url-text"], URL_TEXT.slice(0, n));
    const typing = t >= 56.1 && t < 57.5;
    els["lk-caret"].style.opacity = typing ? "1" : Math.floor(t * 2.5) % 2 ? "0.15" : "1";
  }
}

// ---------------------------------------------------------------------------
// Static SVG chart geometry
// ---------------------------------------------------------------------------
function buildCharts() {
  // spline (catmull-rom → cubic bezier)
  const data = [18, 14, 12, 15, 22, 38, 52, 61, 58, 55, 63, 64, 57, 54, 59, 62, 60, 52, 44, 39, 33, 28, 23, 20];
  const data2 = [10, 9, 9, 10, 14, 22, 30, 36, 35, 33, 38, 40, 35, 33, 36, 39, 37, 32, 27, 24, 20, 17, 14, 12];
  const toPts = (arr) => arr.map((v, i) => [40 + (i / (arr.length - 1)) * 532, 370 - ((v - 10) / 70) * 330]);
  const pathOf = (p) => {
    let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[Math.max(0, i - 1)];
      const p1 = p[i];
      const p2 = p[i + 1];
      const p3 = p[Math.min(p.length - 1, i + 2)];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  };
  const p1 = toPts(data);
  const d1 = pathOf(p1);
  document.getElementById("spl-line").setAttribute("d", d1);
  document.getElementById("spl-area").setAttribute("d", `${d1} L572 370 L40 370 Z`);
  document.getElementById("spl-line2").setAttribute("d", pathOf(toPts(data2)));

  // radar grid
  const grid = document.getElementById("radar-grid");
  const lbls = document.getElementById("radar-lbls");
  let gh = "";
  for (const lvl of [0.25, 0.5, 0.75, 1]) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
      pts.push(`${(RADAR.cx + Math.cos(a) * RADAR.R * lvl).toFixed(1)},${(RADAR.cy + Math.sin(a) * RADAR.R * lvl).toFixed(1)}`);
    }
    gh += `<polygon points="${pts.join(" ")}"/>`;
  }
  let lh = "";
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
    gh += `<line x1="${RADAR.cx}" y1="${RADAR.cy}" x2="${(RADAR.cx + Math.cos(a) * RADAR.R).toFixed(1)}" y2="${(RADAR.cy + Math.sin(a) * RADAR.R).toFixed(1)}"/>`;
    const lx = RADAR.cx + Math.cos(a) * (RADAR.R + 46);
    const ly = RADAR.cy + Math.sin(a) * (RADAR.R + 46) + 8;
    const anchor = Math.abs(Math.cos(a)) < 0.2 ? "middle" : Math.cos(a) > 0 ? "start" : "end";
    lh += `<text class="chart-lbl" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" font-size="22">${RADAR.labels[i]} ${Math.round(RADAR.vals[i] * 100)}</text>`;
  }
  grid.innerHTML = gh;
  lbls.innerHTML = lh;

  // lockup title split into characters
  const title = document.getElementById("lk-title");
  title.innerHTML = [..."MedVend Health Kiosk"].map((ch) => (ch === " " ? '<span class="sp"> </span>' : `<span>${ch}</span>`)).join("");
}

// ---------------------------------------------------------------------------
// GSAP master timeline (DOM + SVG layers)
// ---------------------------------------------------------------------------
function buildTimeline() {
  CustomEase.create("hfBezier", "M0,0 C0.77,0 0.175,1 1,1");
  const tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out" } });
  const fadeIn = (sel, at, dur = 0.5, from = {}) => tl.fromTo(sel, { opacity: 0, ...from }, { opacity: 1, x: 0, y: 0, duration: dur }, at);
  const fadeOut = (sel, at, dur = 0.45) => tl.to(sel, { opacity: 0, duration: dur, ease: "power2.in" }, at);
  const laser = (at) => tl.fromTo("#laser", { y: -20, opacity: 1 }, { y: 2180, duration: 0.6, ease: "power2.inOut" }, at).set("#laser", { opacity: 0 }, at + 0.6);

  // HUD scene labels
  fadeIn("#sc1", 0.2, 0.6);
  fadeOut("#sc1", 14.8, 0.3);
  fadeIn("#sc2", 15.2, 0.5);
  fadeOut("#sc2", 29.8, 0.3);
  fadeIn("#sc3", 30.2, 0.5);
  fadeOut("#sc3", 44.7, 0.3);
  fadeIn("#sc4", 45.2, 0.5);

  // ---------------- scene 01 ----------------
  tl.fromTo("#bp-gridrect", { opacity: 0 }, { opacity: 1, duration: 0.8 }, 0.1);
  tl.fromTo("#bp-cross", { opacity: 0 }, { opacity: 1, duration: 0.6 }, 0.3);
  tl.fromTo("#bp-lines .draw", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1.6, ease: "hfBezier", stagger: 0.16 }, 0.4);
  tl.fromTo("#bp-hidden", { opacity: 0 }, { opacity: 1, duration: 0.8 }, 2.6);
  tl.fromTo("#bp-dims", { opacity: 0 }, { opacity: 1, duration: 0.6 }, 3.0);
  tl.fromTo("#bp-text", { opacity: 0 }, { opacity: 1, duration: 0.6 }, 3.4);
  tl.to(["#bp-text", "#bp-dims", "#bp-cross"], { opacity: 0, duration: 0.6, ease: "power2.in" }, 5.0);
  tl.to("#bp-hidden", { opacity: 0, duration: 0.6 }, 5.4);
  tl.to("#bp-gridrect", { opacity: 0.25, duration: 1.0 }, 5.0);
  tl.to("#bp-lines", { opacity: 0, duration: 0.8, ease: "power2.in" }, 8.4);
  tl.to("#bp-gridrect", { opacity: 0, duration: 1.0 }, 9.0);
  fadeOut("#bootlog", 9.4, 0.6);

  ["#tl-temp", "#tl-ready", "#tl-enc", "#tl-link"].forEach((s, i) => {
    tl.fromTo(s, { opacity: 0 }, { opacity: 1, duration: 0.4 }, 10.6 + i * 0.3);
    fadeOut(s, 14.5 + i * 0.05, 0.4);
  });
  fadeIn("#title-eyebrow", 10.7, 0.6, { y: 30 });
  tl.fromTo("#title-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.9, ease: "expo.out" }, 13.3);
  fadeIn("#title-sub", 13.5, 0.7, { y: 30 });
  fadeOut("#title-block", 14.6, 0.5);
  laser(14.9);

  // ---------------- scene 02 ----------------
  const cursor = "#glass-cursor";
  const ripple = "#cursor-ripple";
  const clickAt = (at, x, y) => {
    tl.fromTo(ripple, { x, y, scale: 0.3, opacity: 0.95 }, { scale: 1.5, opacity: 0, duration: 0.55, ease: "power2.out" }, at);
    tl.to(cursor, { scale: 0.82, duration: 0.08, ease: "power2.out" }, at);
    tl.to(cursor, { scale: 1, duration: 0.25, ease: "back.out(3)" }, at + 0.08);
  };
  const moveTo = (at, x, y, dur = 0.5) => tl.to(cursor, { x, y, duration: dur, ease: "power2.inOut" }, at);

  tl.fromTo("#kiosk-ui", { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "none" }, 16.9);
  tl.fromTo(cursor, { x: 960, y: 1760, opacity: 0, scale: 1 }, { opacity: 1, duration: 0.25 }, 17.9);
  moveTo(18.0, 625, 1302, 0.55);
  clickAt(18.6, 625, 1302);
  tl.to("#st-attract", { opacity: 0, duration: 0.35, ease: "power2.in" }, 18.8);
  fadeIn("#st-vitals", 18.95, 0.45, { y: 40 });
  tl.fromTo("#ku-steps-fill", { scaleX: 0.02 }, { scaleX: 0.18, duration: 0.6 }, 19.0);
  moveTo(19.3, 625, 580, 0.55);
  tl.to(cursor, { scale: 0.86, duration: 0.15 }, 19.9);
  tl.to(cursor, { scale: 1, duration: 0.25, ease: "back.out(3)" }, 21.7);
  tl.fromTo("#vitals-done", { opacity: 0.3 }, { opacity: 1, duration: 0.4 }, 21.9);
  moveTo(21.95, 625, 1610, 0.5);
  clickAt(22.5, 625, 1610);
  tl.to("#ku-steps-fill", { scaleX: 0.5, duration: 0.6 }, 22.6);
  tl.to("#st-vitals", { opacity: 0, duration: 0.3, ease: "power2.in" }, 22.65);
  fadeIn("#st-triage", 22.85, 0.4, { y: 40 });
  moveTo(22.95, 191, 535, 0.35);
  clickAt(23.3, 191, 535);
  tl.fromTo("#chip-1", { opacity: 0 }, { opacity: 1, duration: 0.15 }, 23.32);
  moveTo(23.4, 480, 535, 0.28);
  clickAt(23.7, 480, 535);
  tl.fromTo("#chip-2", { opacity: 0 }, { opacity: 1, duration: 0.15 }, 23.72);
  moveTo(23.85, 1010, 940, 0.45);
  tl.fromTo("#tri-bar-fill", { scaleX: 0 }, { scaleX: 1, duration: 1.15, ease: "power1.inOut" }, 24.0);
  fadeIn("#tri-result", 25.2, 0.45, { y: 30 });
  tl.fromTo("#conf-arc", { strokeDashoffset: 1 }, { strokeDashoffset: 0.027, duration: 0.7, ease: "power2.out" }, 25.3);
  fadeIn("#tri-go", 25.5, 0.35, { y: 20 });
  moveTo(25.4, 625, 1610, 0.45);
  clickAt(25.9, 625, 1610);
  tl.to("#ku-steps-fill", { scaleX: 0.82, duration: 0.6 }, 26.0);
  tl.to("#st-triage", { opacity: 0, duration: 0.25, ease: "power2.in" }, 26.0);
  tl.fromTo("#st-dispense", { opacity: 0 }, { opacity: 1, duration: 0.3 }, 26.15);
  tl.fromTo(["#dsp-product", "#dsp-pay", "#dsp-steps"], { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.08 }, 26.15);
  tl.to("#items-0", { opacity: 0, duration: 0.2 }, 26.3);
  tl.to("#items-1", { opacity: 1, duration: 0.2 }, 26.3);
  tl.to("#total-0", { opacity: 0, duration: 0.2 }, 26.3);
  tl.to("#total-1", { opacity: 1, duration: 0.2 }, 26.3);
  moveTo(26.25, 625, 1010, 0.4);
  clickAt(26.7, 625, 1010);
  tl.to("#pay-wait", { opacity: 0, duration: 0.2 }, 26.95);
  tl.fromTo("#pay-ok", { opacity: 0 }, { opacity: 1, duration: 0.25 }, 27.0);
  tl.fromTo("#ku-pay-on", { opacity: 0 }, { opacity: 1, duration: 0.3 }, 27.0);
  tl.to(cursor, { opacity: 0, duration: 0.3 }, 27.2);
  ["#ds1", "#ds2", "#ds3", "#ds4"].forEach((s, i) => tl.fromTo(s, { "--done": 0 }, { "--done": 1, duration: 0.2 }, 27.05 + i * 0.35));
  tl.fromTo("#dsp-bar-fill", { scaleX: 0 }, { scaleX: 1, duration: 1.3, ease: "none" }, 27.0);
  tl.to("#ku-steps-fill", { scaleX: 1, duration: 0.5 }, 28.1);
  fadeIn("#dsp-collect", 28.25, 0.3, { y: 16 });
  tl.to("#st-attract", { opacity: 1, duration: 0.3, ease: "none" }, 28.75);
  tl.to("#kiosk-ui", { opacity: 0, duration: 0.6, ease: "power1.in" }, 29.6);

  // glass cards + connectors
  const card = (sel, cn, at, dx) => {
    tl.fromTo(cn, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.45, ease: "power2.out" }, at - 0.2);
    tl.fromTo(sel, { opacity: 0, x: dx }, { opacity: 1, x: 0, duration: 0.6, ease: "expo.out" }, at);
  };
  card("#card-enc", "#cn-enc", 19.6, -80);
  card("#card-viz", "#cn-viz", 20.0, -80);
  card("#card-fhir", "#cn-fhir", 21.0, 80);
  card("#card-pay", "#cn-pay", 26.3, 80);
  [["#fr1", 21.3], ["#fr2", 21.7], ["#fr3", 21.95], ["#fr4", 25.6], ["#fr5", 28.0]].forEach(([s, at]) => fadeIn(s, at, 0.35, { x: 30 }));
  ["#pr1", "#pr2", "#pr3", "#pr4"].forEach((s, i) => fadeIn(s, 27.05 + i * 0.12, 0.3, { x: 30 }));
  tl.to("#pay-state-wait", { opacity: 0, duration: 0.2 }, 26.95);
  tl.fromTo("#pay-state-ok", { opacity: 0 }, { opacity: 1, duration: 0.25 }, 27.0);
  tl.to(["#card-enc", "#card-viz", "#card-fhir", "#card-pay", "#connectors"], { opacity: 0, duration: 0.5, ease: "power2.in" }, 28.9);
  laser(29.7);

  // ---------------- scene 03 ----------------
  fadeIn("#s3-left", 31.6, 0.7, { x: -80 });
  fadeIn("#s3-right-a", 31.8, 0.7, { x: 80 });
  fadeIn("#s3-right-b", 32.0, 0.7, { x: 80 });
  tl.fromTo("#m-uptime", { strokeDashoffset: 1 }, { strokeDashoffset: 0.0001, duration: 2.2, ease: "hfBezier" }, 32.4);
  tl.fromTo("#m-thru", { strokeDashoffset: 1 }, { strokeDashoffset: 0.25, duration: 2.0, ease: "hfBezier" }, 32.8);
  tl.fromTo("#m-vault", { strokeDashoffset: 1 }, { strokeDashoffset: 0.5, duration: 2.0, ease: "hfBezier" }, 33.0);
  tl.fromTo("#spl-line", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 2.0, ease: "power2.inOut" }, 33.0);
  tl.fromTo("#spl-line2", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 2.0, ease: "power2.inOut" }, 33.3);
  tl.fromTo("#spl-area", { opacity: 0 }, { opacity: 1, duration: 0.8 }, 34.4);
  [["picker", 34.6], ["uvc", 34.85], ["compute", 35.1], ["thermal", 35.35]].forEach(([n, at]) => {
    tl.fromTo(`#ld-${n}`, { opacity: 0 }, { opacity: 1, duration: 0.4 }, at);
    fadeIn(`#co-${n}`, at + 0.1, 0.45);
  });
  tl.to(["#s3-left", "#s3-right-a", "#s3-right-b", ".callout", "#leaders g"], { opacity: 0, duration: 0.6, ease: "power2.in" }, 43.3);
  laser(44.75);

  // ---------------- scene 04 ----------------
  fadeIn("#s4-cap", 46.9, 0.8, { y: 50 });
  fadeOut("#s4-cap", 50.8, 0.5);
  tl.fromTo("#lockup", { opacity: 0, y: 80, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 1.1, ease: "expo.out" }, 54.3);
  tl.fromTo("#lk-sheen", { x: -900, skewX: -18 }, { x: 2600, skewX: -18, duration: 1.6, ease: "power2.inOut" }, 55.0);
  tl.fromTo("#lk-title span", { opacity: 0, y: 70 }, { opacity: 1, y: 0, duration: 0.7, stagger: 0.035, ease: "expo.out" }, 54.8);
  fadeIn("#lk-sub", 55.6, 0.7, { y: 30 });
  fadeIn("#lk-url", 55.9, 0.4, { y: 20 });
  tl.fromTo("#lk-url-glow", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "expo.out" }, 57.5);
  tl.fromTo("#lk-sheen", { x: -900 }, { x: 2600, duration: 1.6, ease: "power2.inOut", immediateRender: false }, 58.0);
  return tl;
}

// ---------------------------------------------------------------------------
// Frame driver
// ---------------------------------------------------------------------------
let ready = false;
let pendingT = 0;
let lastT = -1;
function renderFrame(t) {
  if (!ready) {
    pendingT = t;
    return;
  }
  if (t === lastT) return;
  lastT = t;
  updateThree(t);
  updateDom(t);
}
window.addEventListener("hf-seek", (ev) => renderFrame(Number(ev.detail.time) || 0));

export async function buildComposition() {
  await Promise.all([
    document.fonts.load('800 84px "Inter"'),
    document.fonts.load('300 40px "Inter"'),
    document.fonts.load('400 30px "JetBrains Mono"'),
    document.fonts.load('500 30px "JetBrains Mono"'),
  ]);
  await document.fonts.ready;

  buildScene(makeScreenTexture());
  buildCharts();
  cacheEls();

  // precompile every program by rendering representative moments once
  ready = true;
  for (const t of [6.5, 12, 20, 34, 47.5, 56]) {
    lastT = -1;
    updateThree(t);
  }
  camera.position.copy(SCREEN_CAM.p);
  camera.lookAt(SCREEN_CAM.q);
  camera.updateMatrixWorld();
  els.__fixedRect = screenRect();
  const tl = buildTimeline();
  window.seekToFrame = (frame) => {
    const t = Math.max(0, Math.min(TOTAL_FRAMES - 1, frame)) / FPS;
    tl.seek(t, false);
    renderFrame(t);
  };
  lastT = -1;
  renderFrame(window.__hfThreeTime || pendingT || 0);
  // GSAP timelines are thenables; wrap so awaiting the build does not wait for playback.
  return { tl };
}
