// Volumetric noise field with ambient chromatic dispersion.
// Rendered into a low-res target and used as the scene background.
export const NOISE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const NOISE_FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec2 uRes;
uniform float uAtrium;   // 0 = obsidian void, 1 = sunlit atrium
uniform float uEnergy;   // overall field brightness
uniform float uFlash;    // transition flash
varying vec2 vUv;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i + vec3(0.0, 0.0, 0.0)), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}

// Integrate three depth slices of warped fbm: a cheap volumetric read.
float field(vec2 uv, float t) {
  float acc = 0.0;
  for (int k = 0; k < 3; k++) {
    float z = float(k) * 0.7;
    vec3 p = vec3(uv * (1.25 + z * 0.35), t * 0.045 + z * 1.9);
    float warp = vnoise(p * 0.8 + vec3(0.0, t * 0.03, 0.0));
    float d = fbm(p + vec3(warp * 1.6, warp * 0.9, 0.0));
    acc += pow(smoothstep(0.5, 0.95, d), 1.6) * (1.0 - z * 0.28);
  }
  return acc * 0.42;
}

void main() {
  vec2 uv = vUv - 0.5;
  uv.x *= uRes.x / uRes.y;
  float t = uTime;

  // Chromatic dispersion: sample the field at radially offset positions per channel.
  vec2 disp = uv * 0.035;
  float fr = field(uv + disp, t);
  float fg = field(uv, t);
  float fb = field(uv - disp, t);

  vec3 voidCol = vec3(0.0235, 0.0314, 0.047);          // #06080C
  vec3 cyan = vec3(0.0, 0.953, 1.0);                    // #00F3FF
  vec3 violet = vec3(0.541, 0.169, 0.886);              // #8A2BE2
  vec3 col = voidCol;
  col += cyan * fg * 0.16 * uEnergy;
  col += violet * (fr * 0.6 + fb * 0.4) * 0.12 * uEnergy;
  col += vec3(fr, fg, fb) * 0.015 * uEnergy;

  float vig = smoothstep(1.25, 0.2, length(uv));
  col *= mix(0.25, 1.0, vig);

  // Sunlit atrium: warm skylight gradient with soft haze.
  vec3 sky = mix(vec3(0.52, 0.45, 0.36), vec3(0.86, 0.78, 0.64), smoothstep(-0.5, 0.5, uv.y));
  sky += vec3(1.0, 0.92, 0.75) * fg * 0.08;
  col = mix(col, sky, uAtrium);

  col += cyan * uFlash * 0.25;
  gl_FragColor = vec4(col, 1.0);
}
`;
