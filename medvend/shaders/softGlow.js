// Additive soft-glow card used as a cheap stand-in for volumetric bloom.
// uShape: 0 = radial falloff, 1 = rectangular falloff. uSharp tightens the core.
export const GLOW_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uShape;
uniform float uSharp;
varying vec2 vUv;
void main() {
  vec2 p = abs(vUv - 0.5) * 2.0;
  float radial = 1.0 - smoothstep(0.0, 1.0, length(p));
  float rect = (1.0 - smoothstep(0.0, 1.0, p.x)) * (1.0 - smoothstep(0.0, 1.0, p.y));
  float a = mix(radial, rect, uShape);
  a = pow(max(a, 0.0), uSharp);
  gl_FragColor = vec4(uColor * uIntensity, a);
}
`;
