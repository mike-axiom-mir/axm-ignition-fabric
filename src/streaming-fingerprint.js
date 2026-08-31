export class Fnv1a32Accumulator {
  constructor() {
    this.hash = 0x811c9dc5;
    this.characterCount = 0;
    this.chunkCount = 0;
    this.maxChunkCharacters = 0;
  }

  update(text) {
    const value = String(text);
    this.chunkCount += 1;
    this.characterCount += value.length;
    this.maxChunkCharacters = Math.max(this.maxChunkCharacters, value.length);
    for (let i = 0; i < value.length; i += 1) {
      this.hash ^= value.charCodeAt(i);
      this.hash = Math.imul(this.hash, 0x01000193) >>> 0;
    }
    return this;
  }

  digest() {
    return this.hash.toString(16).padStart(8, "0");
  }

  metrics() {
    return Object.freeze({
      characterCount: this.characterCount,
      chunkCount: this.chunkCount,
      maxChunkCharacters: this.maxChunkCharacters,
    });
  }
}

function streamStableValue(value, emit) {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return false;
    emit(serialized);
    return true;
  }

  if (Array.isArray(value)) {
    emit("[");
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) emit(",");
      if (i in value) streamStableValue(value[i], emit);
    }
    emit("]");
    return true;
  }

  emit("{");
  const keys = Object.keys(value).sort();
  for (let i = 0; i < keys.length; i += 1) {
    if (i > 0) emit(",");
    const key = keys[i];
    emit(JSON.stringify(key));
    emit(":");
    if (!streamStableValue(value[key], emit)) emit("undefined");
  }
  emit("}");
  return true;
}

export function forEachStableStringChunk(value, emit) {
  if (typeof emit !== "function") throw new Error("emit must be a function");
  const emitted = streamStableValue(value, emit);
  if (!emitted) throw new TypeError("top-level value has no stable string representation");
}

export function hashValueStreamingWithMetrics(value) {
  const accumulator = new Fnv1a32Accumulator();
  forEachStableStringChunk(value, (chunk) => accumulator.update(chunk));
  return {
    hash: accumulator.digest(),
    metrics: accumulator.metrics(),
  };
}

export function hashValueStreaming(value) {
  return hashValueStreamingWithMetrics(value).hash;
}
