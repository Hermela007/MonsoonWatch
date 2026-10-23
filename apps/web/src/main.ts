// Scaffold only: an empty 3D scene plus a live-event log. Workstream A replaces this.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STREAM_EVENT_NAMES } from "@monsoonwatch/shared";
import "./style.css";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(6, 5, 8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.GridHelper(10, 20, 0x2b3a4a, 0x1a242f));

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// Live events from GET /api/stream
const status = document.getElementById("status")!;
const stream = new EventSource("/api/stream");
stream.onopen = () => (status.textContent = "MonsoonWatch · live stream connected");
stream.onerror = () => (status.textContent = "MonsoonWatch · live stream disconnected (is the API running?)");
for (const name of STREAM_EVENT_NAMES) {
  stream.addEventListener(name, (e) => console.log(name, JSON.parse((e as MessageEvent<string>).data)));
}
