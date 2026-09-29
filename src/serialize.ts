/**
 * Serializes a pure function into a self-contained worker script string.
 * The generated script installs an `onmessage` handler that:
 * 1. Receives `{ type: "execute", id, args }` messages
 * 2. Calls the deserialized function with the args
 * 3. Posts back `{ type: "result", id, value }` (with Transferable for typed arrays)
 * 4. On error, posts back `{ type: "error", id, error, stack }`
 * 5. On `{ type: "abort" }`, does nothing (caller terminates the worker)
 */

/** Best-effort closure detection: look for free variables not declared in function body */
export const warnIfClosure = (fn: Function): void => {
  const src = fn.toString();

  // Arrow functions and regular functions both captured
  // Look for variable references that suggest closure capture.
  // This is heuristic - not guaranteed to catch everything.
  const bodyMatch = src.match(/\{([\s\S]*)\}$/);
  if (!bodyMatch) return; // single-expression arrow, likely safe

  const body = bodyMatch[1];

  // Common signs of closure: referencing `this` (in arrow fn context),
  // or top-level variables that aren't params/locals
  if (/\bthis\b/.test(body) && src.startsWith("(")) {
    console.warn(
      "[defuss-multicore] Warning: function references `this` which will be undefined in a worker context.",
    );
  }
};

/**
 * Generates a worker script string from a function.
 * The script is fully self-contained and can be executed in a
 * Web Worker (via Blob URL) or worker_threads (via eval).
 */
export const serializeFunction = (fn: Function): string => {
  warnIfClosure(fn);

  const fnString = fn.toString();

  // The worker script:
  //  - Defines the function
  //  - Listens for messages
  //  - Calls the function and posts results back
  //  - Detects typed arrays in results for Transferable
  return `
'use strict';

const __fn = ${fnString};
let __nodeParentPort = null;

const __isTypedArray = (v) =>
  ArrayBuffer.isView(v) && !(v instanceof DataView);

const __getTransferables = (value) => {
  const buffers = new Set(), seen = new Set();
  const visit = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v instanceof ArrayBuffer) { buffers.add(v); return; }
    if (ArrayBuffer.isView(v)) { if (v.buffer instanceof ArrayBuffer) buffers.add(v.buffer); return; }
    if (v instanceof Map) { for (const [k, item] of v) { visit(k); visit(item); } return; }
    if (v instanceof Set) { for (const item of v) visit(item); return; }
    for (const key of Object.keys(v)) visit(v[key]);
  };
  visit(value);
  return [...buffers];
};

const __dispatch = (msg, transfer) => {
  if (typeof postMessage === 'function') {
    postMessage(msg, transfer ?? []);
    return;
  }

  if (__nodeParentPort) {
    __nodeParentPort.postMessage(msg, transfer ?? []);
    return;
  }

  throw new Error('Node worker parentPort is not ready.');
};

const __handleMessage = async (data) => {
  if (data.type === 'execute') {
    try {
      const result = await __fn(...data.args);
      const transfer = __getTransferables(result);
      const msg = { type: 'result', id: data.id, value: result };
      __dispatch(msg, transfer);
    } catch (err) {
      const msg = {
        type: 'error',
        id: data.id,
        error: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : "Error",
        stack: err instanceof Error ? err.stack : undefined,
      };
      __dispatch(msg);
    }
  }
  // 'abort' type is a no-op; the caller terminates the worker externally
};

// Browser Web Worker
if (typeof self !== 'undefined' && typeof self.onmessage !== 'undefined') {
  self.onmessage = (e) => __handleMessage(e.data);
}

// Node.js worker_threads
if (typeof postMessage !== 'function') {
  import('node:worker_threads')
    .then(({ parentPort }) => {
      __nodeParentPort = parentPort ?? null;
      if (__nodeParentPort) {
        __nodeParentPort.on('message', __handleMessage);
      }
    })
    .catch(() => {
      // Not in worker_threads context - ignore
    });
}
`.trim();
};

