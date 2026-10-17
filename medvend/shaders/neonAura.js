// Neon aura that emanates from the kiosk base.
export const AURA_FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uIntensity;
uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float ring = exp(-pow((r - 0.44) / 0.09, 2.0));
  float halo = exp(-pow((r - 0.44) / 0.30, 2.0)) * 0.45;
  float fill = exp(-pow(r / 0.42, 2.0)) * 0.35;
  float ang = atan(p.y, p.x);
  float ripple = 0.8 + 0.2 * sin(ang * 6.0 + uTime * 1.7);
  vec3 col = mix(uColorA, uColorB, smoothstep(0.35, 0.9, r));
  float a = (ring * ripple + halo + fill) * uIntensity * (1.0 - smoothstep(0.8, 1.0, r));
  gl_FragColor = vec4(col, a);
}
`;
