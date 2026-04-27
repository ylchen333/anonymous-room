/**
 * splatLoader.js
 *
 * Handles all SplatMesh construction and lifecycle:
 *
 *  1. loadScene(scene, library)
 *       → loads all anchor PLY files for an on_the_fly_nvs or single scene.
 *         On-the-fly NVS anchors all share the same world coordinate frame, so
 *         every SplatMesh is placed at the identity transform (no per-anchor
 *         offset). They are merged visually by SparkJS's Gaussian compositor.
 *
 *  2. prefetchSegments(scene, library, onSegmentReady)
 *       → background-loads segmented splats one at a time after the main scene
 *         is visible.  Calls onSegmentReady({ mesh, meta }) for each segment as
 *         it arrives.  Returns a cancel() function.
 *
 *  3. disposeSplatGroup(group)
 *       → tears down a loaded scene group cleanly (removes from parent, disposes
 *         GPU resources where SparkJS exposes them).
 */

import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';

// ── loadScene ─────────────────────────────────────────────────────────────────

/**
 * Load all anchors for a scene into a Three.js Group.
 *
 * On-the-fly NVS alignment note:
 *   anchor_x.ply files produced by the graphdeco-inria/on-the-fly-nvs training
 *   pipeline store all Gaussians in a shared world coordinate frame — there is
 *   no per-anchor local transform.  The metadata `position` field used during
 *   training is for camera-proximity blending only, not for repositioning PLY
 *   vertices.  Therefore all SplatMesh objects are added at identity
 *   (position 0,0,0, no rotation/scale) and SparkJS handles Gaussian compositing.
 *
 * @param {import('./assetLibrary.js').ManifestScene} scene
 * @param {import('./assetLibrary.js').AssetLibrary}  library
 * @param {{ onProgress?: (loaded: number, total: number) => void }} [opts]
 * @returns {Promise<LoadedScene>}
 */
export async function loadScene(scene, library, opts = {}) {
  const { onProgress } = opts;
  const urls = library.anchorUrls(scene);

  if (urls.length === 0) throw new Error(`Scene "${scene.id}" has no anchors.`);

  const group = new THREE.Group();
  group.name = `scene:${scene.id}`;

  const meshes = [];
  for (let i = 0; i < urls.length; i++) {
    const mesh = new SplatMesh({ url: urls[i] });
    await mesh.initialized;

    // 180° X-axis rotation: converts PLY coordinate convention (Y-down, Z-into-screen)
    // to Three.js convention (Y-up). Matches what sparkjs.dev/viewer/ applies after load.
    mesh.quaternion.set(1, 0, 0, 0);

    mesh.name = `anchor:${scene.id}:${i}`;
    group.add(mesh);
    meshes.push(mesh);

    onProgress?.(i + 1, urls.length);
  }

  return {
    scene,
    group,
    anchorMeshes: meshes,
    anchorPositions: scene.anchorPositions ?? null,  // [x,y,z][] from metadata, or null
    segmentMeshes: [],
  };
}

// ── prefetchSegments ──────────────────────────────────────────────────────────

/**
 * Progressively load segmented splats in the background.
 *
 * Segmented splats are also in the same world coordinate frame as the
 * main anchors (SAGA/HDBSCAN preserves world-space coordinates).
 * They are added to the scene invisible; gameMode.js makes them visible.
 *
 * @param {import('./assetLibrary.js').ManifestScene} scene
 * @param {import('./assetLibrary.js').AssetLibrary}  library
 * @param {THREE.Group}  parentGroup  The group returned by loadScene()
 * @param {(entry: SegmentEntry) => void} onSegmentReady
 * @returns {{ cancel: () => void, promise: Promise<void> }}
 */
export function prefetchSegments(scene, library, parentGroup, onSegmentReady) {
  let cancelled = false;

  const promise = (async () => {
    const entries = library.segmentEntries(scene);
    if (entries.length === 0) return;

    for (const { url, meta } of entries) {
      if (cancelled) break;

      const mesh = new SplatMesh({ url });
      await mesh.initialized;
      if (cancelled) { disposeMesh(mesh); break; }

      mesh.quaternion.set(1, 0, 0, 0);
      mesh.visible = false;
      mesh.name = `segment:${scene.id}:${meta.clusterId}`;
      parentGroup.add(mesh);

      onSegmentReady({ mesh, meta });
    }
  })();

  return {
    cancel() { cancelled = true; },
    promise,
  };
}

// ── disposeSplatGroup ─────────────────────────────────────────────────────────

/**
 * Remove all SplatMeshes from the Three.js scene and free GPU resources.
 * @param {LoadedScene} loaded
 */
export function disposeSplatGroup(loaded) {
  const { group } = loaded;
  group.parent?.remove(group);
  group.traverse(obj => disposeMesh(obj));
}

function disposeMesh(obj) {
  if (obj.isMesh || obj.constructor?.name === 'SplatMesh') {
    obj.geometry?.dispose();
    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
    else obj.material?.dispose();
  }
}

// ── Type declarations ─────────────────────────────────────────────────────────
/**
 * @typedef {Object} LoadedScene
 * @property {import('./assetLibrary.js').ManifestScene} scene
 * @property {THREE.Group}      group            Add this to your Three.js scene
 * @property {SplatMesh[]}      anchorMeshes
 * @property {number[][]|null}  anchorPositions  World-space [x,y,z] per anchor, or null
 * @property {SplatMesh[]}      segmentMeshes    Populated by prefetchSegments
 */

/**
 * @typedef {Object} SegmentEntry
 * @property {SplatMesh}                                    mesh
 * @property {import('./assetLibrary.js').ManifestSegment}  meta
 */
