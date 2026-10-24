import * as THREE from 'three';

/** One palette for the whole app: neutral off-white everywhere; colour only means risk. */
export const THEME = {
  paper: new THREE.Color(0xf4f2ee),
  paperDark: new THREE.Color(0xe6e3dd),
  line: new THREE.Color(0xcfcac2),
  lineStrong: new THREE.Color(0xa9a39a),
  ink: new THREE.Color(0x1d1d1b),
  flood: new THREE.Color(0x2f8ccc),
  floodLight: new THREE.Color(0xa9d8f0),
  slide: new THREE.Color(0xd4542b),
  slideLight: new THREE.Color(0xf0b49d),
};

/** Shared fog density uniform: scaled with camera distance so the opening zoom from Malaysia stays clear. */
export const FOG = { value: 0.0022 };
