// Fresnel rim lighting for refractive-looking glass (screen cover, UV-C chamber).
export const FRESNEL_VERT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mvPosition.xyz);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

export const FRESNEL_FRAG = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec3 uColor;
uniform float uIntensity;
uniform float uPulse;
uniform float uPower;
uniform float uBase;
varying vec3 vN;
varying vec3 vV;
void main() {
  #include <clipping_planes_fragment>
  float c = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  float rim = pow(1.0 - c, uPower);
  float a = (uBase + rim) * uIntensity * (0.6 + 0.4 * uPulse);
  gl_FragColor = vec4(uColor * (0.5 + rim * 1.8), clamp(a, 0.0, 1.0));
}
`;
