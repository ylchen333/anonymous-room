/**
 * assetLibrary.js
 *
 * Loads and exposes the asset manifest.  Provides helpers for:
 *   - Fetching the manifest JSON
 *   - Looking up scenes by id
 *   - Detecting the "type" of a scene (single / on_the_fly_nvs)
 *   - Resolving asset URLs relative to the manifest base
 *
 * No build step — this module is loaded directly by index.html via importmap.
 */

export const SceneType = Object.freeze({
  SINGLE:        'single',
  ON_THE_FLY_NVS: 'on_the_fly_nvs',
});

export const SplatFormat = Object.freeze({
  PLY:    'ply',
  SPZ:    'spz',
  SPLAT:  'splat',
  KSPLAT: 'ksplat',
  SOG:    'sog',
});

// ── AssetLibrary ──────────────────────────────────────────────────────────────

export class AssetLibrary {
  /**
   * @param {string} manifestUrl  URL of assets/manifest.json (relative to page)
   * @param {string} assetsBase   Base URL prepended to all asset paths in manifest
   */
  constructor(manifestUrl = './assets/manifest.json', assetsBase = './assets/') {
    this.manifestUrl = manifestUrl;
    this.assetsBase  = assetsBase;
    /** @type {ManifestScene[]} */
    this.scenes = [];
    this._loaded = false;
  }

  /** Fetch and parse the manifest.  Call once at startup. */
  async load() {
    const res = await fetch(this.manifestUrl);
    if (!res.ok) throw new Error(`Failed to load manifest: ${res.status} ${this.manifestUrl}`);
    const data = await res.json();
    this.scenes = data.scenes ?? [];
    this._loaded = true;
  }

  /** All scenes. */
  getAll() {
    this._assertLoaded();
    return this.scenes;
  }

  /** Find a scene by id.  Returns undefined if not found. */
  getById(id) {
    this._assertLoaded();
    return this.scenes.find(s => s.id === id);
  }

  /** All scenes of a given type. */
  getByType(type) {
    this._assertLoaded();
    return this.scenes.filter(s => s.type === type);
  }

  /**
   * Returns all scenes that have at least one anchor.
   * on_the_fly_nvs scenes are listed first, then singles.
   */
  getBrowsable() {
    this._assertLoaded();
    return [...this.scenes]
      .filter(s => s.anchors.length > 0)
      .sort((a, b) => {
        if (a.type === b.type) return a.displayName.localeCompare(b.displayName);
        return a.type === SceneType.ON_THE_FLY_NVS ? -1 : 1;
      });
  }

  /**
   * Resolve the full URL for a file path stored in the manifest.
   * @param {string} relPath  e.g. "other_splats/along_schenley_0.ply"
   * @returns {string}
   */
  resolveUrl(relPath) {
    return this.assetsBase + relPath;
  }

  /**
   * Resolve all anchor URLs for a scene (in anchor-index order).
   * @param {ManifestScene} scene
   * @returns {string[]}
   */
  anchorUrls(scene) {
    return scene.anchors.map(a => this.resolveUrl(a));
  }

  /**
   * Resolve all segment URLs for a scene, in clusterId order.
   * @param {ManifestScene} scene
   * @returns {{ url: string, meta: ManifestSegment }[]}
   */
  segmentEntries(scene) {
    return [...scene.segments]
      .sort((a, b) => a.clusterId - b.clusterId)
      .map(seg => ({ url: this.resolveUrl(seg.file), meta: seg }));
  }

  /** True if this scene has fully-loaded segmented splats ready. */
  hasSegments(scene) {
    return scene.segments.length > 0;
  }

  _assertLoaded() {
    if (!this._loaded) throw new Error('AssetLibrary not loaded — call await library.load() first');
  }
}

// ── Type declarations (JSDoc-only, no TypeScript) ─────────────────────────────
/**
 * @typedef {Object} ManifestScene
 * @property {string}           id
 * @property {string}           displayName
 * @property {SceneType}        type
 * @property {string[]}         anchors      Paths relative to assets/
 * @property {ManifestSegment[]} segments
 */

/**
 * @typedef {Object} ManifestSegment
 * @property {string}      id
 * @property {string}      label
 * @property {number}      clusterId
 * @property {string}      file         Path relative to assets/
 * @property {number|null} gaussianCount
 * @property {string|null} colorHint
 */
