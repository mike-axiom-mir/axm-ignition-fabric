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

function streamStableValue(value, emit, traversal) {
  traversal.nodesVisited += 1;

  if (value === null || typeof value !== "object") {
    if (typeof value === "string") traversal.stringsVisited += 1;
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return false;
    emit(serialized);
    return true;
  }

  if (Array.isArray(value)) {
    traversal.arraysVisited += 1;
    emit("[");
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) emit(",");
      if (i in value) streamStableValue(value[i], emit, traversal);
    }
    emit("]");
    return true;
  }

  traversal.objectsVisited += 1;
  emit("{");
  const keys = Object.keys(value).sort();
  traversal.objectKeysVisited += keys.length;
  for (let i = 0; i < keys.length; i += 1) {
    if (i > 0) emit(",");
    const key = keys[i];
    traversal.stringsVisited += 1;
    emit(JSON.stringify(key));
    emit(":");
    if (!streamStableValue(value[key], emit, traversal)) emit("undefined");
  }
  emit("}");
  return true;
}

function createTraversalMetrics() {
  return {
    traversalPasses: 1,
    nodesVisited: 0,
    arraysVisited: 0,
    objectsVisited: 0,
    objectKeysVisited: 0,
    stringsVisited: 0,
  };
}

export function forEachStableStringChunkWithMetrics(value, emit) {
  if (typeof emit !== "function") throw new Error("emit must be a function");
  const traversal = createTraversalMetrics();
  const emitted = streamStableValue(value, emit, traversal);
  if (!emitted) throw new TypeError("top-level value has no stable string representation");
  return Object.freeze({ ...traversal });
}

export function forEachStableStringChunk(value, emit) {
  forEachStableStringChunkWithMetrics(value, emit);
}

export function hashValueStreamingWithMetrics(value) {
  const accumulator = new Fnv1a32Accumulator();
  const traversal = forEachStableStringChunkWithMetrics(value, (chunk) => accumulator.update(chunk));
  return {
    hash: accumulator.digest(),
    metrics: Object.freeze({
      ...accumulator.metrics(),
      ...traversal,
    }),
  };
}

export function hashValueStreaming(value) {
  return hashValueStreamingWithMetrics(value).hash;
}
