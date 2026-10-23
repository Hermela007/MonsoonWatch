import * as THREE from 'three';

const DROPS = 14000;

const vertexShader = /* glsl */ `
attribute vec4 aSeed;
attribute float aEnd;
uniform vec3 uCentre;
uniform float uSize;
uniform float uTime;
uniform float uIntensity;
varying float vAlpha;

void main() {
  float height = uSize * 0.3;
  float len = height * 0.025;
  float y = mod(aSeed.y * height - uTime * height * 0.8 * (0.8 + 0.4 * aSeed.w), height);
  vec3 p = vec3(uCentre.x + (aSeed.x - 0.5) * uSize, y, uCentre.z + (aSeed.z - 0.5) * uSize);
  p += aEnd * vec3(len * 0.3, len, len * 0.15);
  float edge = 1.0 - smoothstep(0.35, 0.5, max(abs(aSeed.x - 0.5), abs(aSeed.z - 0.5)));
  vAlpha = step(aSeed.w, uIntensity) * (1.0 - aEnd) * smoothstep(0.0, height * 0.1, y) * edge;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor * vAlpha * 0.28, 1.0);
}
`;

/** Rain streaks around the camera target; density follows replay rain intensity. */
export function createRain() {
  const seeds = new Float32Array(DROPS * 2 * 4);
  const ends = new Float32Array(DROPS * 2);
  for (let d = 0; d < DROPS; d++) {
    const s = [Math.random(), Math.random(), Math.random(), Math.random()];
    for (let e = 0; e < 2; e++) {
      seeds.set(s, (d * 2 + e) * 4);
      ends[d * 2 + e] = e;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DROPS * 2 * 3), 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uCentre: { value: new THREE.Vector3() },
      uSize: { value: 40 },
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uColor: { value: new THREE.Color(0x9fd8ff) },
    },
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;

  return {
    object: lines,
    update(target: THREE.Vector3, cameraDistance: number, intensity: number, timeS: number) {
      const u = material.uniforms;
      u.uCentre.value.copy(target);
      u.uSize.value = THREE.MathUtils.clamp(cameraDistance * 1.1, 8, 140);
      u.uIntensity.value = intensity;
      u.uTime.value = timeS;
      lines.visible = intensity > 0.01;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
