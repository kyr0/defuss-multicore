# 0.1.0

## Correctness

- Cache the pool creation promise, eliminating cold-start/eager races.
- Track each active job on its worker; crash rejection no longer affects active peers.
- Abort queued work immediately; clean up listeners/timers, retire running workers and resume queued work.
- Catch synchronous dispatch/clone failures, reclaim slots, monitor Node exits and browser message errors.
- Await asynchronous serialized handlers and fallback results; recursively discover/deduplicate legacy result buffers.
- Reject already-aborted fallback calls; validate cores, thresholds, queue limits, priorities and timeouts.
- Empty array reduction returns its initial value; cap actual partitions to nonempty input work.
- Correct map/filter/reduced/async result types; add compile-time negative tests.
- Compact TypedArray partitions avoid whole-parent-buffer cloning per worker and avoid detaching caller input.
- Legacy required options-shaped payloads are no longer consumed; `withOptions` handles ambiguous default/rest signatures explicitly.
- Browser Blob URLs are revoked per terminated worker, including idle eviction and cancellation.

## New capabilities

- Public typed `createPool`, module-worker `expose`, result `transfer` wrapper.
- One pool for multiple imported task handlers; persistent per-worker modules and async initialization.
- Explicit payload/options separation and bidirectional transferable ownership.
- Bounded queue, stable priority, per-task timeouts, graceful close and immediate terminate.
- Bounded batched submission and indexed completion-order streaming with backpressure and cancellation on abandonment.
- Pool statistics and task latency callback; synchronous and asynchronous handler inference.
- Existing array helpers reuse callback/core pools; explicit `releaseArrayWorkers` cleanup.
- Browser/Node procedural examples, production-bundle smoke test, reproducible task benchmark and lockfile.

## Preserved

All original math source files and their tests, API tests, microbenchmarks, README (inside the upstream snapshot), MIT license, and dual ESM/CJS packaging. The only upstream test assertion changed is partition buffer identity: independent owned chunks are intentional and tested. Test fixture labels elsewhere can still mention the old subarray design; the assertions and new README define the new behavior.

## Deliberate limits

No automatic retries, affinity, cross-worker state synchronization, shared-memory protocol, distributed execution, or automatic tuning. Legacy serialization cannot capture imported functions. Legacy map/filter callbacks remain synchronous. `close` may wait indefinitely for non-terminating tasks without timeouts; use `terminate` to stop them. High-level math functions remain separate synchronous kernels. App-level stale-result checks and authoritative state commits remain caller responsibilities.
