/** Deterministic CPU workload. Same kernel in the main thread and both worker runtimes. */
export function createGenerator(seed) {
  const table = new Float64Array(256);
  let state = seed >>> 0;
  for (let i = 0; i < table.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    table[i] = state / 4294967296;
  }
  const sample = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const u = x - ix, v = y - iy;
    const a = u*u*(3-2*u), b = v*v*(3-2*v);
    const at = (x,y) => table[(Math.imul(x, 73) ^ Math.imul(y, 151)) & 255];
    return (at(ix,iy)*(1-a)+at(ix+1,iy)*a)*(1-b)+(at(ix,iy+1)*(1-a)+at(ix+1,iy+1)*a)*b;
  };
  return ({ cx, cy, size = 64, octaves = 12 }) => {
    if (!Number.isInteger(size) || size < 1 || size > 512 || !Number.isInteger(octaves) || octaves < 1 || octaves > 32) throw new RangeError('Invalid chunk dimensions');
    const heights = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let frequency = 0.015, amplitude = 1, height = 0, total = 0;
      for (let octave = 0; octave < octaves; octave++) {
        height += sample((cx*size+x)*frequency, (cy*size+y)*frequency)*amplitude;
        total += amplitude; frequency *= 1.93; amplitude *= 0.53;
      }
      heights[y*size+x] = height / total;
    }
    return heights;
  };
}
export function makeJobs(count = 64, seed = 42) {
  return Array.from({length:count}, (_,i) => ({cx:i%8, cy:Math.floor(i/8), seed, size:64, octaves:12}));
}
