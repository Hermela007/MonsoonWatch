import * as THREE from 'three';
import { THEME } from '../theme';

/** Shared by every street material: the current water level and clock. */
export const waterUniforms = {
  uWaterStage: { value: -1 },
  uWaterGround: { value: null as THREE.Texture | null },
  uWaterHand: { value: null as THREE.Texture | null },
  uWaterSize: { value: 900 },
  uWaterTime: { value: 0 },
  uWaterTint: { value: THEME.floodLight },
  uWaterDeep: { value: THEME.flood },
};

const CAUSTIC = /* glsl */ `
float causticAt(vec2 uv, float t) {
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.0), 0.0, 1.0);
}
`;

const GRID = /* glsl */ `
  {
    vec2 g1 = vWPos.xz / 5.0;
    vec2 a1 = abs(fract(g1 - 0.5) - 0.5) / max(fwidth(g1), vec2(1e-4));
    float minor = 1.0 - min(min(a1.x, a1.y), 1.0);
    vec2 g2 = vWPos.xz / 50.0;
    vec2 a2 = abs(fract(g2 - 0.5) - 0.5) / max(fwidth(g2), vec2(1e-4));
    float major = 1.0 - min(min(a2.x, a2.y) / 1.3, 1.0);
    float fadeG = 1.0 - smoothstep(150.0, 600.0, length(cameraPosition - vWPos));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.72, 0.70, 0.66), (minor * 0.28 + major * 0.5) * fadeG);
  }
`;

/**
 * Patch a standard material so anything below the water level takes a clear-water tint that
 * deepens with depth, plus moving caustics. `grid` also draws the drafting grid (ground only).
 */
export function addUnderwater<T extends THREE.MeshStandardMaterial>(mat: T, grid = false): T {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, waterUniforms);
    shader.vertexShader = 'varying vec3 vWPos;\n' + shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vec4 wpos4 = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        wpos4 = instanceMatrix * wpos4;
      #endif
      vWPos = (modelMatrix * wpos4).xyz;`,
    );
    shader.fragmentShader =
      'varying vec3 vWPos;\nuniform float uWaterStage;\nuniform sampler2D uWaterGround;\nuniform sampler2D uWaterHand;\nuniform float uWaterSize;\nuniform float uWaterTime;\nuniform vec3 uWaterTint;\nuniform vec3 uWaterDeep;\n' +
      CAUSTIC +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        ${grid ? GRID : ''}
        {
          // Water surface here, from the same model as the water mesh (0 outside its square).
          vec2 wuv = vec2(vWPos.x / uWaterSize + 0.5, 0.5 - vWPos.z / uWaterSize);
          float inSq = step(0.0, wuv.x) * step(wuv.x, 1.0) * step(0.0, wuv.y) * step(wuv.y, 1.0);
          vec2 hs = texture2D(uWaterHand, wuv).rg;
          float wdepth = (uWaterStage * hs.g - hs.r) * inSq;
          float wd = wdepth > 0.0 ? texture2D(uWaterGround, wuv).r + wdepth - vWPos.y : -1.0;
          if (wd > 0.0) {
            float k = 1.0 - exp(-wd / 2.5);
            gl_FragColor.rgb = mix(gl_FragColor.rgb * mix(vec3(1.0), uWaterTint, 0.75), uWaterDeep * 0.9, k * 0.7);
            gl_FragColor.rgb += causticAt(vWPos.xz * 0.12, uWaterTime * 0.6) * 0.35 * exp(-wd / 3.0);
            // Thin dark waterline where surfaces meet the surface.
            gl_FragColor.rgb = mix(gl_FragColor.rgb, uWaterDeep * 0.7, (1.0 - smoothstep(0.0, 0.08, wd)) * 0.8);
          }
        }`,
      );
  };
  mat.customProgramCacheKey = () => (grid ? 'underwater-grid' : 'underwater');
  return mat;
}
