// Bounded result cache; concurrent identical requests share one query.
function createBandCache(ttlMs, maxEntries = 128) {
  const entries = new Map();
  return async function cached(key, load) {
    const hit = entries.get(key);
    if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.value;
    if (entries.size >= maxEntries) {
      for (const [k, entry] of entries) {
        if (!entry.pending) { entries.delete(k); break; }
      }
    }
    // Do not evict an in-flight query or grow without bound.
    if (!entries.has(key) && entries.size >= maxEntries) return load();
    const entry = { at: 0, pending: true };
    entry.value = Promise.resolve().then(load).then(value => {
      entry.pending = false;
      entry.at = Date.now();
      entry.value = value;
      return value;
    }).catch(error => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    entries.set(key, entry);
    return entry.value;
  };
}

module.exports = { createBandCache };
