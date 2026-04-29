/**
 * sceneManager.js
 *
 * Owns the Three.js renderer, camera, and animation loop.
 * Manages the active loaded scene and handles:
 *   - Scene switching (dispose old, load new)
 *   - First-person camera controls (WASD + mouse look + scroll)
 *   - Pointer lock UI state
 *   - Window resize
 *
 * Usage:
 *   const mgr = new SceneManager(canvas);
 *   await mgr.switchScene(sceneId, library);
 */

import * as THREE from 'three';
import { loadScene, prefetchSegments, disposeSplatGroup } from './splatLoader.js';

const MOVE_SPEED        = 2.0;
const FAST_MULTIPLIER   = 3.0;
const MOUSE_SENSITIVITY = 0.002;
const DAMPING           = 8.0;
const SCROLL_SPEED      = 0.5;

// On-the-fly NVS anchor blending — matches graphdeco-inria paper (anchor_overlap = 0.3)
const ANCHOR_OVERLAP = 0.3;

export class SceneManager {
  /**
   * @param {HTMLCanvasElement|null} canvas  Pass null to let SceneManager create the canvas
   * @param {object} [opts]
   * @param {(event: SceneEvent) => void} [opts.onEvent]  Scene lifecycle callbacks
   */
  constructor(canvas = null, opts = {}) {
    this.onEvent = opts.onEvent ?? (() => {});

    // Three.js core
    this.scene    = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111111);

    this.camera   = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
    // Start near keyframe[0] of pine_knob (default scene), in Three.js space
    // (PLY world pos flipped: y→-y, z→-z due to 180° X rotation on SplatMesh)
    this.camera.position.set(0.1, -0.1, 0.0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, canvas: canvas ?? undefined });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    if (!canvas) document.body.appendChild(this.renderer.domElement);

    // First-person controls state
    this._euler    = new THREE.Euler(0, 0, 0, 'YXZ');
    this._velocity = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._keys     = {};
    this._isLocked = false;

    // Active scene bookkeeping
    /** @type {import('./splatLoader.js').LoadedScene | null} */
    this._loaded   = null;
    this._prefetchHandle = null;
    this._segments = [];  // { mesh, meta }[]

    this._bindEvents();
    this._startLoop();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Load a new scene by id.  Tears down the current scene first.
   * @param {import('./assetLibrary.js').ManifestScene} sceneConfig
   * @param {import('./assetLibrary.js').AssetLibrary}  library
   */
  async switchScene(sceneConfig, library) {
    // Cancel any in-flight prefetch
    this._prefetchHandle?.cancel();
    this._prefetchHandle = null;
    this._segments = [];

    // Dispose previous
    if (this._loaded) {
      disposeSplatGroup(this._loaded);
      this._loaded = null;
    }

    this.onEvent({ type: 'loadStart', scene: sceneConfig });

    const loaded = await loadScene(sceneConfig, library, {
      onProgress: (n, total) => this.onEvent({ type: 'loadProgress', n, total, scene: sceneConfig }),
    });

    this._loaded = loaded;
    this.scene.add(loaded.group);
    this._resetCameraForScene(loaded);
    this.onEvent({ type: 'loadDone', scene: sceneConfig, loaded });

    // Begin prefetching segments in background if available
    if (library.hasSegments(sceneConfig)) {
      this._prefetchHandle = prefetchSegments(
        sceneConfig, library, loaded.group,
        entry => {
          this._segments.push(entry);
          loaded.segmentMeshes.push(entry.mesh);
          this.onEvent({ type: 'segmentReady', entry, totalExpected: sceneConfig.segments.length });
          if (this._segments.length === sceneConfig.segments.length) {
            this.onEvent({ type: 'allSegmentsReady', segments: this._segments });
          }
        }
      );
    }
  }

  /** Show only segmented splats; hide anchor meshes. */
  enterSegmentMode() {
    if (!this._loaded) return;
    for (const m of this._loaded.anchorMeshes) m.visible = false;
    for (const s of this._segments) s.mesh.visible = true;
  }

  /** Keep every segment visible and hide the original anchor splats. */
  showAllSegments() {
    if (!this._loaded) return;
    for (const m of this._loaded.anchorMeshes) m.visible = false;
    for (const s of this._segments) s.mesh.visible = true;
  }

  /** Show only a specific segment by clusterId; hide all others. */
  isolateSegment(clusterId) {
    for (const s of this._segments) {
      s.mesh.visible = (s.meta.clusterId === clusterId);
    }
    for (const m of this._loaded?.anchorMeshes ?? []) m.visible = false;
  }

  /** Move the camera toward a segment centroid and look at it. */
  focusSegment(clusterId) {
    const entry = this._segments.find(s => s.meta.clusterId === clusterId);
    const centroid = entry?.meta?.centroid;
    if (!Array.isArray(centroid) || centroid.length !== 3) return;

    const target = new THREE.Vector3(centroid[0], -centroid[1], -centroid[2]);
    const fromCamera = target.clone().sub(this.camera.position);
    if (fromCamera.lengthSq() < 1e-6) {
      fromCamera.set(0, 0, -1);
    }
    fromCamera.normalize();

    const standOff = 0.18;
    this.camera.position.copy(target.clone().sub(fromCamera.multiplyScalar(standOff)));
    this.camera.lookAt(target);
    this._euler.setFromQuaternion(this.camera.quaternion);
    this._velocity.set(0, 0, 0);
  }

  /** Restore anchors; hide all segment meshes. */
  exitSegmentMode() {
    if (!this._loaded) return;
    for (const m of this._loaded.anchorMeshes) m.visible = true;
    for (const s of this._segments) s.mesh.visible = false;
  }

  get segments() { return this._segments; }
  get canvas()   { return this.renderer.domElement; }
  get cameraRef() { return this.camera; }

  findSegmentByClusterId(clusterId) {
    return this._segments.find(s => s.meta.clusterId === clusterId) ?? null;
  }

  findFirstAnnotatedSegment(predicate = defaultAnnotationPredicate) {
    return this._segments.find(({ meta }) => predicate(meta)) ?? null;
  }

  pickSegmentFromScreenPoint(clientX, clientY, predicate = () => true) {
    if (this._segments.length === 0) return null;

    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    let best = null;
    let bestDistance = Infinity;

    for (const entry of this._segments) {
      if (!predicate(entry.meta)) continue;

      const centroid = entry.meta?.centroid;
      if (!Array.isArray(centroid) || centroid.length !== 3) continue;

      const worldPoint = new THREE.Vector3(centroid[0], -centroid[1], -centroid[2]);
      const screenPoint = worldPoint.clone().project(this.camera);

      if (screenPoint.z < -1 || screenPoint.z > 1) continue;

      const screenX = rect.left + ((screenPoint.x + 1) * 0.5 * rect.width);
      const screenY = rect.top + (((1 - screenPoint.y) * 0.5) * rect.height);
      const distance = Math.hypot(screenX - clientX, screenY - clientY);

      if (distance < bestDistance) {
        bestDistance = distance;
        best = entry;
      }
    }

    return bestDistance <= 56 ? best : null;
  }

  /** Request pointer lock so WASD/mouse controls activate. */
  requestPointerLock() {
    this.renderer.domElement.requestPointerLock();
  }

  setKeyState(code, pressed) {
    this._keys[code] = pressed;
  }

  // ── Events & animation loop ──────────────────────────────────────────────────

  _bindEvents() {
    document.addEventListener('pointerlockchange', () => {
      this._isLocked = document.pointerLockElement === this.renderer.domElement;
      this.onEvent({ type: this._isLocked ? 'locked' : 'unlocked' });
    });

    document.addEventListener('mousemove', e => {
      if (!this._isLocked) return;
      this._euler.setFromQuaternion(this.camera.quaternion);
      this._euler.y -= e.movementX * MOUSE_SENSITIVITY;
      this._euler.x -= e.movementY * MOUSE_SENSITIVITY;
      this._euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this._euler.x));
      this.camera.quaternion.setFromEuler(this._euler);
    });

    document.addEventListener('wheel', e => {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.camera.position.addScaledVector(fwd, -e.deltaY * 0.005 * SCROLL_SPEED);
    });

    document.addEventListener('keydown', e => { this._keys[e.code] = true;  });
    document.addEventListener('keyup',   e => { this._keys[e.code] = false; });

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  _startLoop() {
    const clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => {
      const delta = clock.getDelta();
      this._tick(delta);
      this.renderer.render(this.scene, this.camera);
    });
  }

  _tick(delta) {
    this._blendAnchors();
    if (!this._isLocked) return;

    const speed = (this._keys['ShiftLeft'] || this._keys['ShiftRight'])
      ? MOVE_SPEED * FAST_MULTIPLIER
      : MOVE_SPEED;

    this._direction.set(0, 0, 0);
    const fwd   = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);

    if (this._keys['KeyW'])  this._direction.add(fwd);
    if (this._keys['KeyS'])  this._direction.sub(fwd);
    if (this._keys['KeyD'])  this._direction.add(right);
    if (this._keys['KeyA'])  this._direction.sub(right);
    if (this._keys['KeyE'])  this._direction.y += 1;
    if (this._keys['KeyQ'])  this._direction.y -= 1;

    if (this._direction.lengthSq() > 0) {
      this._direction.normalize();
      this._velocity.lerp(
        this._direction.multiplyScalar(speed),
        1 - Math.exp(-DAMPING * delta)
      );
    } else {
      this._velocity.lerp(new THREE.Vector3(), 1 - Math.exp(-DAMPING * delta));
    }

    this.camera.position.addScaledVector(this._velocity, delta);
  }

  /**
   * Place the camera at a guaranteed-good viewpoint for the loaded scene.
   * For on-the-fly NVS scenes, uses the first anchor's position (centroid of the
   * first camera cluster) converted to Three.js space (flip y, z).
   * For single scenes, resets to a neutral position in front of the origin.
   */
  _resetCameraForScene(loaded) {
    this.camera.quaternion.set(0, 0, 0, 1); // look forward (-Z)
    const pos = loaded.anchorPositions?.[0];
    if (pos) {
      // Anchor position is in PLY space; apply same 180° X flip as the SplatMesh
      this.camera.position.set(pos[0], -pos[1], -pos[2]);
    } else {
      this.camera.position.set(0, 0, 3);
    }
    this._velocity.set(0, 0, 0);
  }

  /**
   * Per-frame anchor opacity blending for on-the-fly NVS scenes.
   *
   * Replicates Equation 5 from the on-the-fly NVS paper:
   *   - ratio = dist_to_closest / dist_to_2nd_closest
   *   - if ratio < (1 - ANCHOR_OVERLAP): show only closest anchor (weight = 1)
   *   - otherwise: blend two closest by proximity, scale their opacities only
   */
  _blendAnchors() {
    const loaded = this._loaded;
    if (!loaded?.anchorPositions || loaded.anchorPositions.length < 2) return;

    const cam = this.camera.position;
    const positions = loaded.anchorPositions;
    const meshes    = loaded.anchorMeshes;

    // Anchor positions from metadata.json are in PLY/COLMAP space.
    // Our SplatMesh has quaternion (1,0,0,0) = 180° around X, so the effective
    // Three.js positions of anchors are (x, -y, -z). Apply same flip before
    // comparing against the Three.js camera position.
    const dists = positions.map(p =>
      Math.sqrt((cam.x - p[0]) ** 2 + (cam.y - (-p[1])) ** 2 + (cam.z - (-p[2])) ** 2)
    );

    // Sort indices by distance (closest first)
    const sorted = dists.map((d, i) => ({ d, i })).sort((a, b) => a.d - b.d);
    const ratio = sorted[0].d / (sorted[1].d || 1e-6);

    const weights = new Array(meshes.length).fill(0);

    if (ratio < (1 - ANCHOR_OVERLAP)) {
      // Clear winner — only the closest anchor is visible
      weights[sorted[0].i] = 1;
    } else {
      // Blend zone — fade between the two closest
      const w = 1 - (ratio - (1 - ANCHOR_OVERLAP)) * (0.5 / ANCHOR_OVERLAP);
      weights[sorted[0].i] = Math.max(0, Math.min(1, w));
      weights[sorted[1].i] = Math.max(0, Math.min(1, 1 - w));
    }

    for (let i = 0; i < meshes.length; i++) {
      meshes[i].visible = weights[i] > 0;
      if (meshes[i].visible) meshes[i].opacity = weights[i];
    }
  }
}

function defaultAnnotationPredicate(meta) {
  const text = meta?.text?.trim();
  return Boolean(text && text.toLowerCase() !== 'null');
}

/**
 * @typedef {Object} SceneEvent
 * @property {'loadStart'|'loadProgress'|'loadDone'|'segmentReady'|'allSegmentsReady'|'locked'|'unlocked'} type
 * @property {*} [scene]
 * @property {*} [loaded]
 * @property {*} [entry]
 * @property {*} [segments]
 * @property {number} [n]
 * @property {number} [total]
 * @property {number} [totalExpected]
 */
