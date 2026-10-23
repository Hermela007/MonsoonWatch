import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Renderer, camera, controls, optional bloom and the CSS2D label layer. */
export function createStage(container: HTMLElement, opts: { bloom: boolean; maxPixelRatio: number }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.maxPixelRatio));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.domElement.className = 'label-layer';
  container.appendChild(labels.domElement);

  const fogColor = new THREE.Color(0xebe8e2);
  const scene = new THREE.Scene();
  scene.background = fogColor;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2000);
  camera.position.set(0, 420, 260);

  const controls = new OrbitControls(camera, labels.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.minDistance = 1.5;
  controls.maxDistance = 420;
  controls.screenSpacePanning = false;
  controls.autoRotateSpeed = 0.35;

  // Multisampled target: without it the composer silently drops the canvas antialiasing.
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }));
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const bloom = opts.bloom ? new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.5, 0.85) : null;
  if (bloom) composer.addPass(bloom);
  let active: THREE.Scene = scene;
  composer.addPass(new OutputPass());

  // Shift the rendered scene so the subject isn't hidden behind the card (in CSS px).
  const shift = { x: 0, y: 0 };
  const applyShift = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (shift.x || shift.y) camera.setViewOffset(w, h, -shift.x, shift.y, w, h);
    else camera.clearViewOffset();
  };

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    composer.setSize(w, h);
    camera.aspect = w / h;
    applyShift();
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  return {
    renderer,
    scene,
    camera,
    controls,
    fogColor,
    pointerTarget: labels.domElement,
    /** Positive x moves the scene right; positive y moves it up. */
    setShift(x: number, y: number) {
      shift.x = x;
      shift.y = y;
      applyShift();
      camera.updateProjectionMatrix();
    },
    /** Swap which scene is drawn (valley ↔ street). Bloom is only for the night-time valley. */
    setScene(next: THREE.Scene) {
      if (next === active) return;
      // CSS2DRenderer leaves labels of scenes it no longer renders on screen; hide them.
      active.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.style.display = 'none';
      });
      active = next;
      renderPass.scene = next;
      if (bloom) bloom.enabled = next === scene;
    },
    render() {
      composer.render();
      labels.render(active, camera);
    },
  };
}
