// Volumetric skylight shafts for the smart-hospital atrium.
export const RAYS_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec2 vUv;
void main() {
  float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
  float body = pow(max(across, 0.0), 1.6);
  float along = smoothstep(0.0, 0.35, vUv.y) * mix(0.35, 1.0, vUv.y);
  float streak = 0.75 + 0.25 * sin(vUv.x * 37.0 + uTime * 0.4) * sin(vUv.x * 11.0 - uTime * 0.25);
  float a = body * along * streak * uIntensity;
  gl_FragColor = vec4(uColor, a);
}
`;
