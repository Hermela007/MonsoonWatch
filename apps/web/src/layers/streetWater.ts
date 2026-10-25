import * as THREE from 'three';
import { THEME } from '../theme';
import type { House } from '../data/buildings';

type WaterHouse = House & { heightM?: number };

const SIZE_M = 900;
const SEGMENTS = 220; // ~4 m vertex spacing: enough for the shortest wave below

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
`;

// Small advected disturbances: river current, not open-ocean waves. Depth remains model-driven.
const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uStage;
uniform sampler2D uGround;
uniform sampler2D uHand;
uniform sampler2D uFlow;
uniform float uSize;
uniform vec3 uOrigin;
varying vec3 vWorld;
varying float vDepth;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec2 uv = vec2((world.x - uOrigin.x) / uSize + 0.5, 0.5 - (world.z - uOrigin.z) / uSize);
  vec2 hs = texture2D(uHand, uv).rg;
  vDepth = uStage * hs.g - hs.r;
  vec2 flow = texture2D(uFlow, uv).rg;
  float wet = smoothstep(0.0, 0.45, vDepth);
  vec2 p = world.xz;
  float chop = sin(p.x * 1.1 + p.y * .6 - uTime * 2.1) * .035
    + sin(p.x * .8 - p.y * 1.7 + uTime * 1.8) * .018;
  world.y = texture2D(uGround, uv).r + max(vDepth, 0.0) + chop * wet + (vDepth > 0.0 ? .015 : -.1);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSky;
uniform vec3 uFoam;
uniform vec3 uSunDir;
uniform sampler2D uWallFoam;
uniform sampler2D uFlow;
uniform sampler2D uHand;
uniform float uStage;
uniform float uSize;
uniform vec3 uOrigin;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vWorld;
varying float vDepth;
${NOISE}
float advectedNoise(vec2 p, vec2 flow, float phase, vec2 scale) {
  vec2 q = p - flow * phase * 7.0;
  return noise(q * scale);
}
float surface(vec2 p, vec2 flow) {
  // Crossfade two short advection phases. Long-running offsets or a spatially rotating
  // coordinate basis fold into fingerprint-like patterns, so neither is used here.
  float a = fract(uTime * .17), b = fract(uTime * .17 + .5);
  float blend = abs(a-.5)*2.0;
  float first = advectedNoise(p,flow,a,vec2(.55,1.1));
  float second = advectedNoise(p,flow,b,vec2(.55,1.1));
  return mix(first,second,blend);
}
void main() {
  vec2 uv = vec2((vWorld.x - uOrigin.x) / uSize + .5, .5 - (vWorld.z - uOrigin.z) / uSize);
  vec2 hs = texture2D(uHand,uv).rg;
  float depth = uStage*hs.g-hs.r;
  if(depth <= 0.0) discard;
  vec2 flow = texture2D(uFlow, uv).rg;
  float wall = texture2D(uWallFoam, uv).r;
  float texel = 1.0 / 1024.0;
  vec2 edge = vec2(texture2D(uWallFoam, uv + vec2(texel,0)).r - texture2D(uWallFoam, uv - vec2(texel,0)).r,
    texture2D(uWallFoam, uv + vec2(0,texel)).r - texture2D(uWallFoam, uv - vec2(0,texel)).r);
  // Slip around obstacles, with eddies where the stream meets a wall.
  flow = normalize(flow + vec2(edge.y, edge.x) * 1.6 + vec2(.0001));
  vec2 p = vWorld.xz;
  float height = surface(p, flow);
  float dx = surface(p + vec2(.12,0), flow) - height;
  float dz = surface(p + vec2(0,.12), flow) - height;
  float dist = length(cameraPosition - vWorld);
  float detail = 1.0 - smoothstep(180.0, 700.0, dist);
  vec3 n = normalize(vec3(-dx * 1.2 * detail, 1.0, -dz * 1.2 * detail));
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float fresnel = pow(1.0 - max(dot(n,viewDir),0.0), 4.0);
  float spec = pow(max(dot(reflect(-uSunDir,n),viewDir),0.0), 90.0);
  float depthK = 1.0 - exp(-depth / 1.7);
  vec3 col = mix(uShallow, uDeep, depthK) * (.96 + height * .065);
  col = mix(col, uSky * .82, fresnel * .46) + spec * .2;
  // Uneven ribbons of foam follow the current.
  float phase = fract(uTime*.17), phaseB = fract(uTime*.17+.5);
  float blend = abs(phase-.5)*2.0;
  float ribbons = mix(advectedNoise(p,flow,phase,vec2(.4,.08)),advectedNoise(p,flow,phaseB,vec2(.4,.08)),blend);
  float broken = surface(p*1.3,flow);
  float streak = smoothstep(.72,.9,ribbons) * smoothstep(.45,.8,broken);
  float shallow = 1.0 - smoothstep(.04,.35,depth);
  float contact = smoothstep(.08,.65,wall) * smoothstep(.04,.25,depth) * (1.0-smoothstep(2.5,3.5,depth));
  float pulse = .45 + .55 * sin(uTime * 4.5 + height * 8.0 + p.x * .7);
  float foam = streak * .13 + contact * smoothstep(.25,.75,broken + pulse * .22) * .65;
  foam += shallow * smoothstep(.35,.8,broken) * .34;
  col = mix(col, uFoam, clamp(foam,0.0,.72));
  // A wet, feathered leading edge. No solid vertical wall around the water square.
  float wetEdge = smoothstep(0.0,.09,depth);
  float fog = smoothstep(uFogNear,uFogFar,dist);
  float edgeDistance = max(abs((vWorld.x-uOrigin.x)/uSize),abs((vWorld.z-uOrigin.z)/uSize));
  float edgeFade = 1.0-smoothstep(.42,.5,edgeDistance);
  float alpha = (.38 + depthK * .42 + fresnel * .12 + foam * .15) * wetEdge * edgeFade;
  gl_FragColor = vec4(mix(col,uSky,fog), clamp(alpha,0.0,.9) * (1.0-fog));
}
`;

/** Top-down mask of house outlines (blurred) so foam can lap against walls. */
function wallFoamTexture(houses: House[]) {
  const px = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  const s = px / SIZE_M;
  g.filter = 'blur(3px)';
  g.strokeStyle = '#fff';
  g.lineWidth = 2.2 * s;
  for (const h of houses) {
    g.save();
    g.translate((h.x / SIZE_M + 0.5) * px, (h.z / SIZE_M + 0.5) * px);
    g.rotate(-h.angle);
    g.strokeRect((-h.w / 2) * s, (-h.d / 2) * s, h.w * s, h.d * s);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Ground heights (local m) over the water square, as a filterable half-float texture. */
function fieldTexture(f: (x: number, z: number) => [number, number]) {
  const N = 192;
  const data = new Uint16Array(N * N * 2);
  for (let j = 0; j < N; j++) {
    const z = (0.5 - (j + 0.5) / N) * SIZE_M;
    for (let i = 0; i < N; i++) {
      const [a, b] = f(((i + 0.5) / N - 0.5) * SIZE_M, z);
      data[(j * N + i) * 2] = THREE.DataUtils.toHalfFloat(a);
      data[(j * N + i) * 2 + 1] = THREE.DataUtils.toHalfFloat(b);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function groundTexture(groundY: (x: number, z: number) => number) {
  const N = 192;
  const data = new Uint16Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = (0.5 - (j + 0.5) / N) * SIZE_M;
    for (let i = 0; i < N; i++) data[j * N + i] = THREE.DataUtils.toHalfFloat(groundY(((i + 0.5) / N - 0.5) * SIZE_M, z));
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Hours per animation second. Preserve the model's depths, but give first inundation time to read. */
export function streetReplayRate(depthNow: number, depthAhead: number) {
  if (!Number.isFinite(depthNow) || !Number.isFinite(depthAhead) || depthNow < -.35 || depthNow > 3.8) return 6;
  const metresPerHour = Math.max(0, (depthAhead - depthNow) / .25);
  return Math.min(6, .14 / Math.max(.02, metresPerHour));
}

/** Local downhill/road-aligned direction for texture advection, not a hydrodynamic velocity estimate. */
export function streetFlow(ground: (x: number, z: number) => number, roads: { pts: { x: number; z: number }[] }[]) {
  const segments = roads.flatMap(r => r.pts.slice(1).map((b, i) => ({ a: r.pts[i], b }))).filter(({a,b}) => Math.hypot(b.x-a.x,b.z-a.z) > .1);
  return (x: number, z: number): [number,number] => {
    let dx = (ground(x-4,z)-ground(x+4,z)) * .3 + .25;
    let dz = (ground(x,z-4)-ground(x,z+4)) * .3 - .95;
    let nearest = 18 * 18;
    for (const {a,b} of segments) {
      if (x < Math.min(a.x,b.x)-18 || x > Math.max(a.x,b.x)+18 || z < Math.min(a.z,b.z)-18 || z > Math.max(a.z,b.z)+18) continue;
      const vx=b.x-a.x,vz=b.z-a.z, len=Math.hypot(vx,vz);
      const t=Math.max(0,Math.min(1,((x-a.x)*vx+(z-a.z)*vz)/(len*len)));
      const distance=(x-a.x-t*vx)**2+(z-a.z-t*vz)**2;
      if (distance >= nearest) continue;
      nearest=distance;
      const sign=vx*dx+vz*dz < 0 ? -1 : 1;
      const blend=(1-Math.sqrt(distance)/18)*.85;
      const norm=Math.hypot(dx,dz)||1;
      dx=dx/norm*(1-blend)+vx/len*sign*blend;
      dz=dz/norm*(1-blend)+vz/len*sign*blend;
    }
    const norm=Math.hypot(dx,dz)||1;
    return [dx/norm,dz/norm];
  };
}

/** Small GPU-driven droplets where the current contacts exposed building edges. */
function contactSpray(houses: WaterHouse[], ground: (x: number,z: number) => number, hand: (x: number,z: number) => [number,number], flow: (x: number,z: number) => [number,number], sky: THREE.Color) {
  const positions: number[] = [], data: number[] = [], directions: number[] = [];
  for (const h of houses.filter(h => Math.hypot(h.x,h.z)<260).sort((a,b) => Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z)).slice(0,140)) {
    const c=Math.cos(h.angle), s=Math.sin(h.angle), f=flow(h.x,h.z);
    const corners=[[-h.w/2,-h.d/2],[h.w/2,-h.d/2],[h.w/2,h.d/2],[-h.w/2,h.d/2]];
    for (let side=0;side<4;side++) {
      const a=corners[side],b=corners[(side+1)%4];
      for (let k=0;k<4;k++) {
        const t=(k+.5)/4, lx=a[0]+(b[0]-a[0])*t, lz=a[1]+(b[1]-a[1])*t;
        const mx=(a[0]+b[0])*.5,mz=(a[1]+b[1])*.5,mn=Math.hypot(mx,mz)||1;
        const nx=c*mx/mn+s*mz/mn,nz=-s*mx/mn+c*mz/mn;
        const x=h.x+c*lx+s*lz+nx*.22, z=h.z-s*lx+c*lz+nz*.22;
        const impact=Math.min(0,f[0]*nx+f[1]*nz);
        const vx=f[0]-1.3*impact*nx,vz=f[1]-1.3*impact*nz,vn=Math.hypot(vx,vz)||1;
        const [hh,share]=hand(x,z), seed=((positions.length+1)*.61803398875)%1;
        positions.push(x,ground(x,z),z); data.push(hh,share,seed,h.heightM ?? h.storeys*3.3); directions.push(vx/vn,vz/vn);
      }
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('aData',new THREE.Float32BufferAttribute(data,4));
  geometry.setAttribute('aFlow',new THREE.Float32BufferAttribute(directions,2));
  const material=new THREE.ShaderMaterial({
    transparent:true, depthWrite:false,
    uniforms:{uTime:{value:0},uStage:{value:0},uSky:{value:sky}},
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uStage;
      attribute vec4 aData; attribute vec2 aFlow;
      varying float vAlpha; varying float vDistance;
      void main(){
        float depth=uStage*aData.y-aData.x;
        float wet=smoothstep(.03,.3,depth)*(1.0-smoothstep(aData.w-.4,aData.w,depth));
        float age=fract(uTime*(.7+aData.z*.8)+aData.z*13.0);
        float flight=age/.55;
        float visible=1.0-step(.55,age);
        float strength=.22+.48*aData.z;
        vec3 p=position;
        p.xz+=aFlow*(flight*.65)+vec2(-aFlow.y,aFlow.x)*sin(aData.z*70.0)*flight*.32;
        p.y+=max(0.0,depth)+4.0*strength*flight*(1.0-flight);
        vec4 mv=modelViewMatrix*vec4(p,1.0);
        vDistance=length(mv.xyz);
        gl_PointSize=clamp(280.0/max(1.0,-mv.z),.9,5.0);
        vAlpha=wet*visible*(1.0-age/.55)*.55;
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSky; varying float vAlpha; varying float vDistance;
      void main(){
        float r=length((gl_PointCoord-.5)*vec2(1.0,.72));
        float alpha=(1.0-smoothstep(.12,.49,r))*vAlpha*(1.0-smoothstep(180.0,430.0,vDistance));
        if(alpha<.015) discard;
        gl_FragColor=vec4(mix(vec3(.88,.94,.97),uSky,.15),alpha);
      }`,
  });
  const points=new THREE.Points(geometry,material); points.frustumCulled=false; points.renderOrder=3;
  return {points,update(stage:number,time:number){material.uniforms.uStage.value=stage;material.uniforms.uTime.value=time;},dispose(){geometry.dispose();material.dispose();}};
}

/** Illustrative moving floodwater: model-driven depth, advected ripples, contact foam and spray. */
export function createStreetWater(
  houses: WaterHouse[],
  sky: THREE.Color,
  fog: { near: number; far: number },
  groundY: (x: number, z: number) => number,
  handScale: (x: number, z: number) => [number, number],
  roads: { pts: { x: number; z: number }[] }[] = [],
) {
  const geometry = new THREE.PlaneGeometry(SIZE_M, SIZE_M, SEGMENTS, SEGMENTS).rotateX(-Math.PI / 2);
  const foamTex = wallFoamTexture(houses);
  const groundTex = groundTexture(groundY);
  const handTex = fieldTexture(handScale);
  const flowAt = streetFlow(groundY, roads);
  const flowTex = fieldTexture(flowAt);
  const spray = contactSpray(houses, groundY, handScale, flowAt, sky);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uStage: { value: 0 },
      uGround: { value: groundTex },
      uHand: { value: handTex },
      uFlow: { value: flowTex },
      uDeep: { value: THEME.flood },
      uShallow: { value: THEME.floodLight },
      uSky: { value: sky },
      uFoam: { value: new THREE.Color(0xeaf4f8) },
      uSunDir: { value: new THREE.Vector3(-0.5, 0.8, 0.35).normalize() },
      uWallFoam: { value: foamTex },
      uSize: { value: SIZE_M },
      uOrigin: { value: new THREE.Vector3() },
      uFogNear: { value: fog.near },
      uFogFar: { value: fog.far },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  // The textures it samples are exposed so the underwater tint uses the very same water.
  mesh.add(spray.points);
  const textures = { ground: groundTex, hand: handTex };
  mesh.frustumCulled = false;

  return {
    mesh,
    textures,
    /** `stageM` stays the modelled main-river rise; motion uses the animation clock only. */
    update(stageM: number, timeS: number) {
      material.uniforms.uStage.value = stageM;
      material.uniforms.uTime.value = timeS;
      spray.update(stageM, timeS);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      foamTex.dispose();
      groundTex.dispose();
      handTex.dispose();
      flowTex.dispose();
      spray.dispose();
    },
  };
}
