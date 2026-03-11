import {
  APP_VERSION,
  CONFIG_KEY,
  DOSES_KEY,
  LEGACY_STATE_KEY,
  DB_NAME,
  DB_VERSION,
  STORE_NAME,
  createDefaultConfig,
  createDefaultMeta,
  normalizeConfig,
  normalizeState,
  validateBundle,
  migrateLegacyBundle
} from './shared.js';

function hasIndexedDb() {
  return typeof indexedDB !== 'undefined';
}

function openDatabase() {
  if (!hasIndexedDb()) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
  });
}

async function getDatabaseHandle(cache) {
  if (!cache.promise) {
    cache.promise = openDatabase().catch(error => {
      cache.promise = null;
      throw error;
    });
  }
  return cache.promise;
}

async function readStoreValue(cache, key) {
  const database = await getDatabaseHandle(cache);
  if (!database) return undefined;
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`Failed to read ${key}`));
  });
}

async function writeStoreValues(cache, entries) {
  const database = await getDatabaseHandle(cache);
  if (!database) return false;
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const [key, value] of entries) {
      store.put(value, key);
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('Failed to persist state'));
  });
}

function readLocalStorageJson(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    return null;
  }
}

function mirrorLegacyKeys(bundle) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(bundle.config));
    localStorage.setItem(DOSES_KEY, JSON.stringify(bundle.state));
  } catch (error) {
    return false;
  }
  return true;
}

function normalizeBundle(bundle, backend, reason) {
  const config = normalizeConfig(bundle?.config || createDefaultConfig());
  const state = normalizeState(bundle?.state || {});
  const meta = createDefaultMeta({
    ...bundle?.meta,
    backend,
    version: APP_VERSION,
    lastIntegrityCheckAt: new Date().toISOString(),
    lastWriteReason: reason
  });
  return { config, state, meta };
}

function createSnapshot(bundle) {
  return {
    capturedAt: new Date().toISOString(),
    config: bundle.config,
    state: bundle.state,
    meta: bundle.meta
  };
}

function loadLegacyBundle() {
  const config = readLocalStorageJson(CONFIG_KEY);
  const doses = readLocalStorageJson(DOSES_KEY);
  const legacyState = readLocalStorageJson(LEGACY_STATE_KEY);

  if (config || doses) {
    return migrateLegacyBundle(config || createDefaultConfig(), doses || legacyState || {});
  }

  if (legacyState) {
    return migrateLegacyBundle(createDefaultConfig(), legacyState);
  }

  return null;
}

function isBundleNewer(candidate, baseline) {
  const candidateState = normalizeState(candidate?.state || {});
  const baselineState = normalizeState(baseline?.state || {});
  if (candidateState.nextId !== baselineState.nextId) {
    return candidateState.nextId > baselineState.nextId;
  }
  if (candidateState.doses.length !== baselineState.doses.length) {
    return candidateState.doses.length > baselineState.doses.length;
  }
  return normalizeConfig(candidate?.config || {}).meds.length > normalizeConfig(baseline?.config || {}).meds.length;
}

export function createStorageManager({ onError } = {}) {
  const cache = { promise: null };

  async function persistBundle(bundle, reason = 'manual') {
    const backend = hasIndexedDb() ? 'indexeddb' : 'localStorage';
    const normalized = normalizeBundle(bundle, backend, reason);
    normalized.meta.lastSnapshotAt = new Date().toISOString();
    const snapshot = createSnapshot(normalized);
    mirrorLegacyKeys(normalized);

    try {
      await writeStoreValues(cache, [
        ['config', normalized.config],
        ['state', normalized.state],
        ['meta', normalized.meta],
        ['snapshot', snapshot]
      ]);
      normalized.meta.backend = 'indexeddb';
    } catch (error) {
      if (typeof onError === 'function') onError(error);
      normalized.meta.backend = 'localStorage';
    }
    return normalized;
  }

  async function loadBundle() {
    let indexedDbBundle = null;
    try {
      const [config, state, meta] = await Promise.all([
        readStoreValue(cache, 'config'),
        readStoreValue(cache, 'state'),
        readStoreValue(cache, 'meta')
      ]);
      const bundle = normalizeBundle({ config, state, meta }, 'indexeddb', 'load');
      if (validateBundle(bundle)) indexedDbBundle = bundle;
    } catch (error) {
      if (typeof onError === 'function') onError(error);
    }

    const legacyBundle = loadLegacyBundle();
    if (legacyBundle) {
      if (!indexedDbBundle || isBundleNewer(legacyBundle, indexedDbBundle)) {
        return persistBundle({
          config: legacyBundle.config,
          state: legacyBundle.state,
          meta: indexedDbBundle?.meta || legacyBundle.meta
        }, indexedDbBundle ? 'local-sync-recovery' : 'legacy-migration');
      }
      return indexedDbBundle;
    }

    if (indexedDbBundle) {
      return indexedDbBundle;
    }

    try {
      const snapshot = await readStoreValue(cache, 'snapshot');
      if (snapshot && snapshot.config && snapshot.state) {
        return persistBundle(snapshot, 'snapshot-recovery');
      }
    } catch (error) {
      if (typeof onError === 'function') onError(error);
    }

    return persistBundle({
      config: createDefaultConfig(),
      state: normalizeState({ doses: [], nextId: 1 }),
      meta: createDefaultMeta()
    }, 'fresh-start');
  }

  async function replaceFromBackup(bundle) {
    return persistBundle(bundle, 'backup-restore');
  }

  async function recoverSnapshot() {
    const snapshot = await readStoreValue(cache, 'snapshot');
    if (!snapshot) return null;
    return persistBundle(snapshot, 'snapshot-recovery');
  }

  async function clearDoses(config, meta) {
    return persistBundle({
      config,
      state: normalizeState({ doses: [], nextId: 1 }),
      meta: createDefaultMeta(meta || {})
    }, 'clear-doses');
  }

  async function requestPersistence(meta = {}) {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
      return createDefaultMeta({ ...meta, persistentStorageGranted: false });
    }
    const granted = await navigator.storage.persist();
    return createDefaultMeta({ ...meta, persistentStorageGranted: granted });
  }

  async function getHealth(meta = {}) {
    let usage = null;
    let quota = null;
    let persisted = false;

    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      try {
        const estimate = await navigator.storage.estimate();
        usage = estimate.usage ?? null;
        quota = estimate.quota ?? null;
      } catch (error) {
        if (typeof onError === 'function') onError(error);
      }
    }

    if (navigator.storage && typeof navigator.storage.persisted === 'function') {
      try {
        persisted = await navigator.storage.persisted();
      } catch (error) {
        if (typeof onError === 'function') onError(error);
      }
    }

    return {
      backend: hasIndexedDb() ? 'indexeddb' : 'localStorage',
      origin: location.origin,
      usage,
      quota,
      persisted,
      bestEffort: !persisted,
      lastSuccessfulBackupAt: meta.lastSuccessfulBackupAt || null,
      lastIntegrityCheckAt: meta.lastIntegrityCheckAt || null,
      lastSnapshotAt: meta.lastSnapshotAt || null
    };
  }

  return {
    clearDoses,
    getHealth,
    loadBundle,
    persistBundle,
    recoverSnapshot,
    replaceFromBackup,
    requestPersistence
  };
}
