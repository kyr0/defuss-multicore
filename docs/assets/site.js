// The page's own glue: the dark-mode switch, the copy buttons, the Shiki
// highlighting of the code windows and the live benchmark demo. Every other
// behavior (sheet menu, tabs, diagram, parallax, scroll-to-top) comes from
// the defuss-shadcn components, wired by their data attributes in all.min.js.

// --- Dark mode ----------------------------------------------------------

const theme = document.getElementById("theme-toggle");

const setTheme = (dark) => {
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  theme.checked = dark;
  // Same key and shape as the defuss-shadcn Dark Mode guide, so the choice carries across defuss pages.
  try { localStorage.setItem("defuss-shadcn-theme", JSON.stringify(dark ? "dark" : "light")); } catch {}
};
theme.checked = document.documentElement.classList.contains("dark");
theme.addEventListener("change", () => setTheme(theme.checked));

// --- Copy buttons -------------------------------------------------------
// Each copy button names its window (data-copy). Terminals copy their
// command lines only (never output or comments); code windows copy every
// line. The Shiki spans keep textContent intact, so highlighting changes
// nothing for the clipboard.
for (const button of document.querySelectorAll("[data-copy]")) {
  const label = button.querySelector("span");
  const status = document.getElementById(`${button.dataset.copy}-status`);
  button.addEventListener("click", async () => {
    const win = document.getElementById(button.dataset.copy);
    const all = [...win.querySelectorAll("pre > code")];
    const commands = all.filter((code) => {
      const pre = code.parentElement;
      return pre.hasAttribute("data-prefix") && !pre.hasAttribute("data-tone");
    });
    const lines = (commands.length ? commands : all).map((code) => code.textContent.replace(/\s+$/g, ""));
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      status.textContent = "Copied";
    } catch {
      status.textContent = "Copy failed";
    }
    label.textContent = status.textContent;
    setTimeout(() => { label.textContent = "Copy"; }, 2000);
  });
}

// --- Shiki syntax highlighting ------------------------------------------
// Mirrors the defuss-shadcn docs runtime (esm.sh/shiki@3.0.0, github-dark):
// the mockup-code surface is dark in both color modes, so the windows take
// the dark theme alone. Tokens are painted per authored line, so prompts,
// cursors and the line layout survive. A failure (offline, CDN down) leaves
// the plain text untouched.
(async () => {
  const wins = document.querySelectorAll(".mockup-code[data-lang]");
  if (!wins.length) return;
  try {
    const { codeToTokens } = await import("https://esm.sh/shiki@3.0.0");
    await Promise.all([...wins].map(async (win) => {
      const lines = [...win.querySelectorAll(":scope > pre > code")];
      const raw = lines.map((code) => code.textContent).join("\n");
      const { tokens } = await codeToTokens(raw, { lang: win.dataset.lang, theme: "github-dark" });
      tokens.forEach((line, i) => {
        if (!lines[i]) return;
        lines[i].replaceChildren(...line.map((token) => {
          const span = document.createElement("span");
          span.textContent = token.content;
          if (token.color) span.style.color = token.color;
          return span;
        }));
      });
    }));
  } catch {}
})();

// --- Live demo ----------------------------------------------------------
// The README's benchmark workloads (src/bench.ts), runnable in the page.
// Every kernel is self-contained: multicore() serializes fn.toString() into
// the workers, so nothing may close over page state. Messages are hashed as
// they are generated (same LCG sequence as the bench), which keeps the
// multi-hundred-megabyte message buffers of the Node bench out of the page.
const DEMO_CDN = "https://cdn.jsdelivr.net/npm/defuss-multicore@0.1.0/dist/index.mjs";

const concatU32 = (a, b) => {
  const merged = new Uint32Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
};
const concatF64 = (a, b) => {
  const merged = new Float64Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
};

const DEMO_TASKS = {
  "key-stretch": {
    label: "Key stretching (PBKDF2-like)",
    size: "100K × 1000 rounds",
    threshold: 256,
    input: () => Uint32Array.from({ length: 100_000 }, (_, i) => i),
    fn: (chunk) => {
      const out = new Uint32Array(chunk.length);
      for (let idx = 0; idx < chunk.length; idx++) {
        let h = chunk[idx] >>> 0;
        for (let r = 0; r < 1000; r++) {
          h ^= h << 13;
          h = Math.imul(h, 0x01000193);
          h ^= h >>> 7;
          h = Math.imul(h, 0x5BD1E995);
          h ^= h >>> 15;
        }
        out[idx] = h >>> 0;
      }
      return out;
    },
    reduce: concatU32,
  },
  "crc32-4k": {
    label: "CRC32 (network packets)",
    size: "10K × 4KB",
    threshold: 256,
    input: () => Uint32Array.from({ length: 10_000 }, (_, i) => i),
    fn: (chunk) => {
      const table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
      }
      const results = new Uint32Array(chunk.length);
      for (let idx = 0; idx < chunk.length; idx++) {
        let s = (chunk[idx] * 2654435761) >>> 0;
        let crc = 0xFFFFFFFF;
        for (let j = 0; j < 4096; j++) {
          s = (s * 1664525 + 1013904223) | 0;
          crc = table[(crc ^ ((s >>> 24) & 0xFF)) & 0xFF] ^ (crc >>> 8);
        }
        results[idx] = (crc ^ 0xFFFFFFFF) >>> 0;
      }
      return results;
    },
    reduce: concatU32,
  },
  "crc32-64b": {
    label: "CRC32 (small messages)",
    size: "500K × 64B",
    threshold: 512,
    input: () => Uint32Array.from({ length: 500_000 }, (_, i) => i),
    fn: (chunk) => {
      const table = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
      }
      const results = new Uint32Array(chunk.length);
      for (let idx = 0; idx < chunk.length; idx++) {
        let s = (chunk[idx] * 2654435761) >>> 0;
        let crc = 0xFFFFFFFF;
        for (let j = 0; j < 64; j++) {
          s = (s * 1664525 + 1013904223) | 0;
          crc = table[(crc ^ ((s >>> 24) & 0xFF)) & 0xFF] ^ (crc >>> 8);
        }
        results[idx] = (crc ^ 0xFFFFFFFF) >>> 0;
      }
      return results;
    },
    reduce: concatU32,
  },
  "transform": {
    label: "Transform (sin+cos)",
    size: "20M items",
    threshold: 512,
    input: () => {
      const data = new Float64Array(20_000_000);
      for (let i = 0; i < data.length; i++) data[i] = i * 0.001;
      return data;
    },
    fn: (chunk) => {
      const out = new Float64Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) out[i] = Math.sin(chunk[i]) + Math.cos(chunk[i]);
      return out;
    },
    reduce: concatF64,
  },
  "fnv1a": {
    label: "FNV-1a hash",
    size: "1M × 128B",
    threshold: 512,
    input: () => Uint32Array.from({ length: 1_000_000 }, (_, i) => i),
    fn: (chunk) => {
      const results = new Uint32Array(chunk.length);
      for (let idx = 0; idx < chunk.length; idx++) {
        let s = (chunk[idx] * 2654435761) >>> 0;
        let h = 0x811C9DC5;
        for (let j = 0; j < 128; j++) {
          s = (s * 1664525 + 1013904223) | 0;
          h ^= (s >>> 24) & 0xFF;
          h = Math.imul(h, 0x01000193);
        }
        results[idx] = h >>> 0;
      }
      return results;
    },
    reduce: concatU32,
  },
  "filter": {
    label: "Filter elements",
    size: "8M items",
    threshold: 512,
    input: () => {
      const data = new Float64Array(8_000_000);
      for (let i = 0; i < data.length; i++) data[i] = i;
      return data;
    },
    fn: (chunk) => chunk.filter((x) => x % 7 === 0),
    reduce: concatF64,
  },
  "sum": {
    label: "Sum (accumulate)",
    size: "100M items",
    threshold: 512,
    input: () => {
      const data = new Float64Array(100_000_000);
      for (let i = 0; i < data.length; i++) data[i] = i + 1;
      return data;
    },
    fn: (chunk) => {
      let s = 0;
      for (let i = 0; i < chunk.length; i++) s += chunk[i];
      return s;
    },
    reduce: (a, b) => a + b,
  },
};

const demoForm = document.getElementById("demo-form");
if (demoForm) {
  const taskSel = document.getElementById("demo-task");
  const workerSel = document.getElementById("demo-workers");
  const runBtn = document.getElementById("demo-run");
  const bar = document.getElementById("demo-bar");
  const value = document.getElementById("demo-value");
  const label = document.getElementById("demo-label");
  const hint = document.getElementById("demo-hint");
  const result = document.getElementById("demo-result");
  const time = document.getElementById("demo-time");
  const meta = document.getElementById("demo-meta");
  const historyWrap = document.getElementById("demo-history-wrap");
  const history = document.getElementById("demo-history");
  const runsEl = document.getElementById("demo-runs");
  const RUNS = 5;

  // navigator.hardwareConcurrency can under-report (Safari and hardened
  // browsers cap it against fingerprinting) — so the pool is sized to honor
  // every explicit choice, and the note names what the browser told us.
  const reported = navigator.hardwareConcurrency || 4;
  const poolCap = Math.max(8, reported);
  const allOption = workerSel.querySelector('option[value="all"]');
  if (allOption) allOption.textContent = `All cores (auto: ${reported})`;
  const coreNote = document.getElementById("demo-core-note");
  if (coreNote) coreNote.textContent = `This browser reports ${reported} cores; some browsers under-report. Explicit counts always run exactly that many partitions.`;

  const demo = { lib: null, wrappers: {}, runs: [] };
  const setBar = (ratio) => {
    const pct = Math.round(Math.min(1, ratio) * 100);
    bar.value = pct;
    value.textContent = `${pct}%`;
  };
  const fmt = (ms) => `${ms < 100 ? ms.toFixed(1) : Math.round(ms).toLocaleString("en-US")} ms`;

  demoForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const task = DEMO_TASKS[taskSel.value];
    const workers = workerSel.value;
    const count = workers === "all" ? reported : Number(workers) || 0;
    const runLabel = workers === "main"
      ? "main thread"
      : `${count} worker${count === 1 ? "" : "s"}${workers === "all" ? " (auto)" : ""}`;

    runBtn.disabled = true;
    taskSel.disabled = true;
    workerSel.disabled = true;
    result.hidden = true;
    label.textContent = `${task.label} · ${runLabel}`;
    setBar(0);

    try {
      const times = [];
      if (workers === "main") {
        hint.textContent = `Running ${RUNS} back-to-back passes on the main thread — this page freezes until they are done. That is the point.`;
        // let the hint paint before the thread blocks
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const input = task.input();
        for (let run = 0; run < RUNS; run++) {
          const t0 = performance.now();
          task.fn(input);
          times.push(performance.now() - t0);
          // the bar only moves once the loop ends — the thread is blocked
          setBar((run + 1) / RUNS);
        }
      } else {
        hint.textContent = "Dispatching partitions — the bar steps once per finished worker…";
        demo.lib ??= await import(DEMO_CDN);
        const parallel = (demo.wrappers[taskSel.value] ??= demo.lib.multicore(task.fn, {
          threshold: task.threshold,
          reduce: task.reduce,
          // spawn enough workers to honor every explicit choice, even when
          // the browser under-reports the core count
          cores: poolCap,
        }));
        const input = task.input();
        // the pool cap covers every explicit count; "all cores" means the
        // library default: what the browser reports
        const expected = count;
        const totalSteps = RUNS * expected;
        let steps = 0;
        for (let run = 0; run < RUNS; run++) {
          hint.textContent = `Run ${run + 1} of ${RUNS}${run === 0 ? " — this one carries worker startup" : " — warm pool"}…`;
          const t0 = performance.now();
          for await (const _partial of parallel(input, { cores: expected })) {
            steps += 1;
            setBar(steps / totalSteps);
          }
          times.push(performance.now() - t0);
        }
        setBar(1);
      }

      const sorted = [...times].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const first = times[0];
      demo.runs.push({ task, workers, median, first });
      time.textContent = fmt(median);
      meta.textContent = `${task.label} (${task.size}) · ${runLabel} · median of ${RUNS} runs`;
      runsEl.textContent = `runs: ${times.map((t, i) => (i === 0 ? `${fmt(t)} (cold start)` : fmt(t))).join(" · ")}`;
      result.hidden = false;
      hint.textContent = workers === "main"
        ? "Done. No cold start here — the main thread pays full price on every pass. Now try workers."
        : `Done. Run 1 (${fmt(first)}) carried worker startup; the warm pool repeats at ~${fmt(median)}.`;

      const baseline = [...demo.runs].reverse().find((run) => run.task === task && run.workers === "main");
      const ratio = baseline && workers !== "main" ? baseline.median / median : null;
      const cells = [`${task.label} · ${task.size}`, runLabel, fmt(median),
        ratio ? `${ratio.toFixed(2)}×` : workers === "main" ? "baseline" : "—"];
      const tr = document.createElement("tr");
      tr.className = "table-row";
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        td.className = "table-cell";
        if (i >= 2) td.setAttribute("data-numeric", "");
        td.textContent = text;
        tr.append(td);
      });
      history.prepend(tr);
      historyWrap.hidden = false;
    } catch (err) {
      hint.textContent = `Run failed: ${err && err.message ? err.message : err}`;
    } finally {
      runBtn.disabled = false;
      taskSel.disabled = false;
      workerSel.disabled = false;
      label.textContent = "Ready";
    }
  });
}
