// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// src/service.ts
import { join } from "node:path";

// api.ts
import { isInternalDiagnosticEventMetadata } from "openclaw/plugin-sdk/diagnostic-runtime";

// src/time.ts
var DAY_MS = 24 * 60 * 60 * 1e3;
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}
function dayKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function monthKey(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}
function yearKey(d) {
  return String(d.getUTCFullYear());
}
function hourKey(d) {
  return `${dayKey(d)} ${pad2(d.getUTCHours())}:00`;
}
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return { year: isoYear, week };
}
function weekKey(d) {
  const { year, week } = isoWeek(d);
  return `${year}-W${pad2(week)}`;
}

// src/finops.ts
function spendByDimension(ledger, dim, opts) {
  const acc = /* @__PURE__ */ new Map();
  for (const row of ledger.entries()) {
    if (opts?.since && new Date(row.ts_utc) < opts.since) {
      continue;
    }
    if (opts?.until && new Date(row.ts_utc) > opts.until) {
      continue;
    }
    const raw = row[dim];
    const key = raw == null || raw === "" ? "__untagged__" : String(raw);
    const g = acc.get(key) ?? { key, cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 };
    g.cost_usd += row.cost_usd;
    g.tokens_in += row.tokens_in;
    g.tokens_out += row.tokens_out;
    g.calls += 1;
    acc.set(key, g);
  }
  return [...acc.values()].toSorted((a, b) => b.cost_usd - a.cost_usd);
}
function realizedRateByModel(ledger, opts) {
  const acc = /* @__PURE__ */ new Map();
  for (const row of ledger.entries()) {
    if (opts?.since && new Date(row.ts_utc) < opts.since) {
      continue;
    }
    if (opts?.until && new Date(row.ts_utc) > opts.until) {
      continue;
    }
    const tot = row.tokens_in + row.tokens_out;
    const r = acc.get(row.model) ?? {
      model: row.model,
      cost_usd: 0,
      tokens: 0,
      tokens_in: 0,
      tokens_out: 0,
      calls: 0,
      realized_usd_per_mtok: Number.NaN
    };
    r.cost_usd += row.cost_usd;
    r.tokens_in += row.tokens_in;
    r.tokens_out += row.tokens_out;
    r.tokens += tot;
    r.calls += 1;
    acc.set(row.model, r);
  }
  for (const r of acc.values()) {
    r.realized_usd_per_mtok = r.tokens > 0 ? r.cost_usd / r.tokens * 1e6 : Number.NaN;
  }
  return [...acc.values()].toSorted((a, b) => b.cost_usd - a.cost_usd);
}
function cacheSavingsByModel(ledger, pricing, opts) {
  const rows = /* @__PURE__ */ new Map();
  for (const e of ledger.entries()) {
    if (opts?.since && new Date(e.ts_utc) < opts.since) {
      continue;
    }
    if (opts?.until && new Date(e.ts_utc) > opts.until) {
      continue;
    }
    const hit = e.cache_hit_ratio ?? 0;
    if (hit <= 0) {
      continue;
    }
    const p = pricing.models.get(e.model);
    if (!p) {
      continue;
    }
    const cacheRate = p.cache_read_usd_per_mtok ?? 0;
    const inputRate = p.input_usd_per_mtok ?? p.usd_per_mtok ?? 0;
    if (inputRate <= 0 || cacheRate >= inputRate) {
      continue;
    }
    const cachedTokens = e.tokens_in * hit;
    const savings = (inputRate - cacheRate) * cachedTokens / 1e6;
    const r = rows.get(e.model) ?? {
      model: e.model,
      calls: 0,
      tokens_in: 0,
      est_cached_tokens: 0,
      est_savings_usd: 0,
      input_usd_per_mtok: inputRate,
      cache_read_usd_per_mtok: cacheRate
    };
    r.calls += 1;
    r.tokens_in += e.tokens_in;
    r.est_cached_tokens += cachedTokens;
    r.est_savings_usd += savings;
    rows.set(e.model, r);
  }
  return [...rows.values()].toSorted((a, b) => b.est_savings_usd - a.est_savings_usd);
}
function effectiveRate(p) {
  if (p.input_usd_per_mtok || p.output_usd_per_mtok) {
    const i = p.input_usd_per_mtok ?? 0;
    const o = p.output_usd_per_mtok ?? 0;
    return 0.7 * i + 0.3 * o;
  }
  return p.usd_per_mtok ?? 0;
}
function cheapestEquivalentAdvisor(ledger, pricing, opts) {
  const paid = /* @__PURE__ */ new Map();
  for (const row of ledger.entries()) {
    if (opts?.since && new Date(row.ts_utc) < opts.since) {
      continue;
    }
    if (opts?.until && new Date(row.ts_utc) > opts.until) {
      continue;
    }
    if (row.cost_usd <= 0) {
      continue;
    }
    const r = paid.get(row.model) ?? { cost: 0, calls: 0, tokens: 0 };
    r.cost += row.cost_usd;
    r.calls += 1;
    r.tokens += row.tokens_in + row.tokens_out;
    paid.set(row.model, r);
  }
  if (paid.size === 0) {
    return [];
  }
  const rates = [];
  for (const [modelId, p] of pricing.models.entries()) {
    const r = effectiveRate(p);
    if (r > 0) {
      rates.push({ model: modelId, rate: r });
    }
  }
  rates.sort((a, b) => a.rate - b.rate);
  const out = [];
  for (const [model, r] of paid) {
    const alt = rates.find((x) => x.model !== model) ?? null;
    if (!alt) {
      out.push({
        paid_model: model,
        paid_cost_usd: r.cost,
        calls: r.calls,
        tokens: r.tokens,
        cheapest_alt_model: "(none \u2014 paid model is cheapest in catalog)",
        cheapest_alt_usd_per_mtok: 0,
        cheapest_alt_estimated_cost_usd: 0,
        potential_savings_usd: 0,
        potential_savings_ratio: 0
      });
      continue;
    }
    const altCost = alt.rate * r.tokens / 1e6;
    const savings = Math.max(0, r.cost - altCost);
    out.push({
      paid_model: model,
      paid_cost_usd: r.cost,
      calls: r.calls,
      tokens: r.tokens,
      cheapest_alt_model: alt.model,
      cheapest_alt_usd_per_mtok: alt.rate,
      cheapest_alt_estimated_cost_usd: altCost,
      potential_savings_usd: savings,
      potential_savings_ratio: r.cost > 0 ? savings / r.cost : 0
    });
  }
  return out.toSorted((a, b) => b.potential_savings_usd - a.potential_savings_usd);
}
function linearSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) {
    return 0;
  }
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
function median(nums) {
  if (nums.length === 0) {
    return 0;
  }
  const s = [...nums].toSorted((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function forecastBurn(ledger, opts) {
  const windowDays = opts?.windowDays ?? 30;
  const until = opts?.until ?? /* @__PURE__ */ new Date();
  const since = new Date(until.getTime() - windowDays * 864e5);
  const daily = /* @__PURE__ */ new Map();
  for (const row of ledger.entries()) {
    const d = new Date(row.ts_utc);
    if (d < since || d > until) {
      continue;
    }
    const k = dayKey(d);
    daily.set(k, (daily.get(k) ?? 0) + row.cost_usd);
  }
  const keys = [...daily.keys()].toSorted();
  const ys = keys.map((k) => daily.get(k) ?? 0);
  const xs = keys.map((_, i) => i);
  const slope = linearSlope(xs, ys);
  const meanY = ys.length === 0 ? 0 : ys.reduce((a, b) => a + b, 0) / ys.length;
  const lastX = xs.length === 0 ? 0 : xs[xs.length - 1];
  const project = (n) => Math.max(0, meanY + slope * (lastX + n));
  return {
    window_days: windowDays,
    avg_daily_cost_usd: meanY,
    median_daily_cost_usd: median(ys),
    trend_usd_per_day: slope,
    forecast_7d_usd: project(7),
    forecast_30d_usd: project(30),
    sample_days: ys.length
  };
}
function buildFinOpsReport(ledger, pricing, opts) {
  const totals = { cost: 0, tokens: 0, calls: 0 };
  for (const r of ledger.entries()) {
    if (new Date(r.ts_utc) < opts.since || new Date(r.ts_utc) > opts.until) {
      continue;
    }
    totals.cost += r.cost_usd;
    totals.tokens += r.tokens_in + r.tokens_out;
    totals.calls += 1;
  }
  return {
    generated: (/* @__PURE__ */ new Date()).toISOString(),
    since: opts.since.toISOString(),
    until: opts.until.toISOString(),
    total_cost_usd: totals.cost,
    total_tokens: totals.tokens,
    total_calls: totals.calls,
    by_caller: spendByDimension(ledger, "caller", opts),
    by_task: spendByDimension(ledger, "task", opts),
    by_model_realized: realizedRateByModel(ledger, opts),
    cache_savings: cacheSavingsByModel(ledger, pricing, opts),
    advisor: cheapestEquivalentAdvisor(ledger, pricing, opts),
    forecast: forecastBurn(ledger, {
      windowDays: opts.windowDays ?? 30,
      until: opts.until
    })
  };
}

// src/ledger.ts
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
var PERIOD_KEYS = {
  day: dayKey,
  week: weekKey,
  month: monthKey,
  year: yearKey
};
function periodBucket(period, ts) {
  return PERIOD_KEYS[period](ts);
}
function emptyRollup() {
  return { cost_usd: 0, tokens_in: 0, tokens_out: 0, calls: 0 };
}
var Ledger = class {
  constructor(path, opts) {
    this.path = path;
    this.onMalformed = opts?.onMalformed;
    this.onError = opts?.onError;
  }
  path;
  onMalformed;
  onError;
  dirCreated = false;
  /** Append one record as a single line (atomic under O_APPEND). */
  record(e) {
    try {
      if (!this.dirCreated) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.dirCreated = true;
      }
      appendFileSync(this.path, `${JSON.stringify(e)}
`, { flag: "a" });
    } catch (err) {
      this.onError?.(err);
    }
  }
  /**
   * All records. Per-line tolerant: a single mangled/half-written line (e.g.
   * from an interrupted append) is skipped rather than aborting the rollup.
   */
  entries() {
    let raw;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out = [];
    let malformed = 0;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t === "") {
        continue;
      }
      try {
        const e = JSON.parse(t);
        if (e && typeof e.ts_utc === "string" && typeof e.model === "string" && typeof e.tokens_in === "number" && Number.isFinite(e.tokens_in) && typeof e.tokens_out === "number" && Number.isFinite(e.tokens_out) && typeof e.cost_usd === "number" && Number.isFinite(e.cost_usd)) {
          out.push(e);
        } else {
          malformed += 1;
        }
      } catch {
        malformed += 1;
      }
    }
    if (malformed > 0) {
      this.onMalformed?.(malformed);
    }
    return out;
  }
  /** Records within an optional `[since, until]` window (inclusive). */
  entriesIn(since, until) {
    const lo = since?.getTime();
    const hi = until?.getTime();
    return this.entries().filter((e) => {
      const t = Date.parse(e.ts_utc);
      if (Number.isNaN(t)) {
        return false;
      }
      if (lo !== void 0 && t < lo) {
        return false;
      }
      if (hi !== void 0 && t > hi) {
        return false;
      }
      return true;
    });
  }
  /** Spend rolled up by period bucket within an optional window (sorted key). */
  rollup(period, since, until) {
    const out = /* @__PURE__ */ new Map();
    for (const e of this.entriesIn(since, until)) {
      const key = periodBucket(period, new Date(e.ts_utc));
      const r = out.get(key) ?? emptyRollup();
      r.cost_usd += e.cost_usd;
      r.tokens_in += e.tokens_in;
      r.tokens_out += e.tokens_out;
      r.calls += 1;
      out.set(key, r);
    }
    return new Map([...out.entries()].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  /** Spend grouped by model within an optional window. */
  byModel(since, until) {
    const out = /* @__PURE__ */ new Map();
    for (const e of this.entriesIn(since, until)) {
      const r = out.get(e.model) ?? emptyRollup();
      r.cost_usd += e.cost_usd;
      r.tokens_in += e.tokens_in;
      r.tokens_out += e.tokens_out;
      r.calls += 1;
      out.set(e.model, r);
    }
    return new Map([...out.entries()].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
};

// src/host-adapter.ts
function resolveCost(event, opts = {}) {
  if (typeof event.costUsd === "number" && Number.isFinite(event.costUsd)) {
    return event.costUsd;
  }
  const free = event.free ?? opts.isFree?.(event.model, event.provider) ?? false;
  if (free) {
    return 0;
  }
  return opts.pricing ? opts.pricing.cost(event.model, event.tokensIn, event.tokensOut) : 0;
}
function toLedgerEntry(event, opts = {}) {
  const now = opts.now ?? (() => /* @__PURE__ */ new Date());
  const entry = {
    ts_utc: event.tsUtc ?? now().toISOString(),
    provider: event.provider,
    model: event.model,
    tokens_in: event.tokensIn,
    tokens_out: event.tokensOut,
    cost_usd: resolveCost(event, opts)
  };
  if (event.violation) {
    entry.violation = event.violation;
  }
  if (event.host) {
    entry.host = event.host;
  }
  return entry;
}
function ingest(ledger, event, opts = {}) {
  const entry = toLedgerEntry(event, opts);
  ledger.record(entry);
  return entry;
}
var HostAdapter = class {
  constructor(ledgerPath, host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.ledger = new Ledger(ledgerPath);
  }
  host;
  opts;
  ledger;
  track(event) {
    return ingest(this.ledger, { ...event, host: this.host }, this.opts);
  }
};

// src/pricing.ts
import {
  closeSync,
  fstatSync,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync as readFileSync2,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname as dirname2 } from "node:path";
function priceIsPriced(p) {
  return (p.usd_per_mtok ?? 0) > 0 || (p.input_usd_per_mtok ?? 0) > 0 || (p.output_usd_per_mtok ?? 0) > 0;
}
function validateModelPrice(modelId, raw) {
  const warnings = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, warnings: [`model "${modelId}": value is not an object, skipping`] };
  }
  const p = raw;
  const numericFields = [
    "usd_per_mtok",
    "input_usd_per_mtok",
    "output_usd_per_mtok",
    "cache_read_usd_per_mtok",
    "cache_write_usd_per_mtok",
    "reasoning_usd_per_mtok"
  ];
  for (const f of numericFields) {
    const v = p[f];
    if (v === void 0) {
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      continue;
    }
    if (typeof v === "number" && Number.isFinite(v)) {
      delete p[f];
      continue;
    }
    warnings.push(
      `model "${modelId}": ${f}=${JSON.stringify(v)} is not a finite number, skipping field`
    );
    delete p[f];
  }
  if (p.source !== void 0 && typeof p.source !== "string") {
    warnings.push(`model "${modelId}": source is not a string, skipping field`);
    delete p.source;
  }
  const hasRate = numericFields.some((f) => typeof p[f] === "number");
  if (!hasRate) {
    warnings.push(`model "${modelId}": no valid rate fields remain, skipping model`);
    return { valid: false, warnings };
  }
  return { valid: true, warnings };
}
function priceCostIo(p, tokensIn, tokensOut) {
  const inRate = p.input_usd_per_mtok ?? 0;
  const outRate = p.output_usd_per_mtok ?? 0;
  if (inRate > 0 || outRate > 0) {
    return (tokensIn * inRate + tokensOut * outRate) / 1e6;
  }
  return (p.usd_per_mtok ?? 0) * (tokensIn + tokensOut) / 1e6;
}
function isPosixPlatform() {
  return process.platform !== "win32";
}
var PricingCatalog = class _PricingCatalog {
  generated = "";
  window = "";
  models = /* @__PURE__ */ new Map();
  baselineUsdPerMtok = 0;
  baselineModel = "";
  /**
   * Load, or an empty catalog if absent/corrupt/insecure/oversized (never
   * fatal).
   *
   * File size is checked *before* opening a descriptor: oversized files are
   * rejected with a warning and no fd is ever created, preventing descriptor
   * leaks under repeated oversized-file loads.
   *
   * For files that pass the size gate, the method opens a file descriptor,
   * validates permissions via `fstatSync` on that descriptor, and reads from
   * the same descriptor — eliminating the TOCTOU race between check and read.
   *
   * Pass `{ posix: false }` to skip POSIX mode/uid checks (Windows).
   * Pass `{ logger }` to route warnings through the host's logging
   * infrastructure instead of raw `process.stderr` writes.
   */
  static load(path, opts) {
    const cat = new _PricingCatalog();
    const posix = opts?.posix ?? isPosixPlatform();
    const warn = opts?.logger ?? ((msg) => {
      process.stderr.write(msg);
    });
    const MAX_PRICE_BYTES = 2097152;
    try {
      const sizeStat = statSync(path);
      if (!sizeStat.isFile()) {
        warn(
          `tokenomics: warning: pricing catalog ${path} rejected \u2014 not a regular file; using empty
`
        );
        return cat;
      }
      if (sizeStat.size > MAX_PRICE_BYTES) {
        warn(
          `tokenomics: warning: pricing catalog ${path} rejected \u2014 ${sizeStat.size} bytes exceeds ${MAX_PRICE_BYTES} limit; using empty
`
        );
        return cat;
      }
    } catch (err) {
      warn(
        `tokenomics: warning: pricing catalog ${path} rejected \u2014 cannot stat: ${String(err)}; using empty
`
      );
      return cat;
    }
    let fd;
    try {
      fd = openSync(path, "r");
      const stat = fstatSync(fd);
      if (posix) {
        const badMode = 16 | 2;
        if (stat.mode & badMode) {
          const modeStr = (stat.mode & 511).toString(8).padStart(3, "0");
          warn(
            `tokenomics: warning: pricing catalog ${path} rejected \u2014 insecure mode 0o${modeStr} (must not be group- or world-writable); using empty
`
          );
          return cat;
        }
        try {
          if (typeof process.getuid === "function") {
            const procUid = process.getuid();
            if (procUid !== void 0 && stat.uid !== procUid) {
              warn(
                `tokenomics: warning: pricing catalog ${path} rejected \u2014 owned by uid ${stat.uid}, process is uid ${procUid}; using empty
`
              );
              return cat;
            }
          }
        } catch {
        }
      }
      let raw;
      try {
        raw = readFileSync2(fd, { encoding: "utf8" });
      } catch {
        return cat;
      }
      try {
        const j = JSON.parse(raw);
        cat.generated = typeof j.generated === "string" ? j.generated : "";
        cat.window = typeof j.window === "string" ? j.window : "";
        cat.baselineUsdPerMtok = typeof j.baseline_usd_per_mtok === "number" && Number.isFinite(j.baseline_usd_per_mtok) ? j.baseline_usd_per_mtok : 0;
        cat.baselineModel = typeof j.baseline_model === "string" ? j.baseline_model : "";
        const models = j.models;
        if (models && typeof models === "object" && !Array.isArray(models)) {
          let skipped = 0;
          for (const [k, v] of Object.entries(models)) {
            const { valid, warnings } = validateModelPrice(k, v);
            if (valid) {
              cat.models.set(k, v);
            } else {
              skipped += 1;
            }
            for (const w of warnings) {
              warn(`tokenomics: warning: ${w}
`);
            }
          }
          if (skipped > 0) {
            warn(
              `tokenomics: warning: skipped ${skipped} malformed model entr${skipped === 1 ? "y" : "ies"} in ${path}
`
            );
          }
        }
      } catch (e) {
        warn(
          `tokenomics: warning: pricing catalog ${path} unreadable (${String(e)}); using empty
`
        );
      }
    } finally {
      if (fd !== void 0) {
        closeSync(fd);
      }
    }
    return cat;
  }
  toJSON() {
    return {
      generated: this.generated,
      window: this.window,
      models: Object.fromEntries(this.models),
      baseline_usd_per_mtok: this.baselineUsdPerMtok,
      baseline_model: this.baselineModel
    };
  }
  /** Atomic write (temp + rename). */
  save(path) {
    mkdirSync2(dirname2(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.toJSON(), null, 2)}
`);
    renameSync(tmp, path);
  }
  /**
   * Look up a model price, tolerating id vs display-name drift: exact, then
   * case-insensitive, then leaf/suffix match (`host/leaf` -> `leaf`).
   */
  lookup(model) {
    const exact = this.models.get(model);
    if (exact) {
      return exact;
    }
    const ml = model.toLowerCase();
    const leaf = ml.includes("/") ? ml.slice(ml.lastIndexOf("/") + 1) : ml;
    for (const [k, v] of this.models) {
      const kl = k.toLowerCase();
      if (kl === ml || kl === leaf || ml.endsWith(kl) || kl.endsWith(leaf)) {
        return v;
      }
    }
    return void 0;
  }
  /** Chargeback for a call. Unknown/unpriced model → $0 (never invent cost). */
  cost(model, tokensIn, tokensOut) {
    const p = this.lookup(model);
    return p ? priceCostIo(p, tokensIn, tokensOut) : 0;
  }
  /** True when the model has a non-zero rate (a paid cloud model). */
  isBilled(model) {
    const p = this.lookup(model);
    return p ? priceIsPriced(p) : false;
  }
  /** Avoided spend: `tokens` priced at the frontier baseline. */
  avoided(tokens) {
    return this.baselineUsdPerMtok * tokens / 1e6;
  }
};

// src/render.ts
var useColor = !process.env.NO_COLOR && process.stdout.isTTY;
var c = {
  dim: (s) => paint(s, "\x1B[2m"),
  bold: (s) => paint(s, "\x1B[1m"),
  green: (s) => paint(s, "\x1B[32m"),
  cyan: (s) => paint(s, "\x1B[36m"),
  yellow: (s) => paint(s, "\x1B[33m")
};
function paint(s, code) {
  return useColor ? `${code}${s}\x1B[0m` : s;
}
function usd(n) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function tok(n) {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(2)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}k`;
  }
  return String(n);
}
function shareBar(freeTokens, totalTokens, width = 24) {
  if (totalTokens <= 0) {
    return `${"\xB7".repeat(width)} 0% free`;
  }
  const frac = Math.max(0, Math.min(1, freeTokens / totalTokens));
  const filled = Math.round(frac * width);
  const bar = c.green("\u2588".repeat(filled)) + c.dim("\u2591".repeat(width - filled));
  return `${bar} ${(frac * 100).toFixed(0)}% free`;
}
function padEnd(s, n) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padStart(s, n) {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}
function renderByModel(rows, limit = 12) {
  const top = rows.slice(0, limit);
  const nameW = Math.max(5, ...top.map((r) => r.model.length));
  const head = c.dim(padEnd("model", nameW)) + "  " + c.dim(padStart("calls", 7)) + "  " + c.dim(padStart("tokens", 9)) + "  " + c.dim(padStart("cost", 10)) + "  " + c.dim("tag");
  const lines = top.map((r) => {
    const tag = r.billed ? c.yellow("paid") : c.green("free");
    return padEnd(r.model, nameW) + "  " + padStart(String(r.calls), 7) + "  " + padStart(tok(r.tokens), 9) + "  " + padStart(usd(r.cost_usd), 10) + "  " + tag;
  });
  return [head, ...lines].join("\n");
}
function renderReport(rep) {
  const window = rep.period ? `${rep.period} (${rep.since} \u2192 ${rep.until}, ${rep.days}d)` : `${rep.since} \u2192 ${rep.until} (${rep.days}d)`;
  const headline = [
    c.bold("Tokenomics"),
    c.dim(window),
    "",
    `${c.dim("spent")}        ${c.bold(usd(rep.total_cost_usd))}  ${c.dim(`(${rep.total_calls} calls, ${tok(rep.total_tokens)} tok)`)}`,
    `${c.dim("avoided")}      ${c.green(usd(rep.avoided_usd))}  ${c.dim("free tokens valued at baseline")}`,
    `${c.dim("counterfactual")} ${c.cyan(usd(rep.counterfactual_usd))}  ${c.dim(`all tokens @ ${rep.baseline_model || "baseline"} (${usd(rep.baseline_usd_per_mtok)}/Mtok)`)}`,
    "",
    `${c.dim("free share")}   ${shareBar(rep.free_tokens, rep.total_tokens)}`
  ].join("\n");
  return `${headline}

${renderByModel(rep.by_model)}`;
}

// src/report.ts
function parseGran(s) {
  switch (s.toLowerCase()) {
    case "hour":
    case "hourly":
      return "hour";
    case "week":
    case "weekly":
      return "week";
    case "month":
    case "monthly":
      return "month";
    default:
      return "day";
  }
}
var GRAN_KEYS = {
  hour: hourKey,
  day: dayKey,
  week: weekKey,
  month: monthKey
};
function granKey(gran, ts) {
  return GRAN_KEYS[gran](ts);
}
function buildReport(opts) {
  const { ledger, pricing, since, until } = opts;
  const gran = opts.gran ?? "day";
  const entries = ledger.entriesIn(since, until);
  const buckets = /* @__PURE__ */ new Map();
  const models = /* @__PURE__ */ new Map();
  const rep = {
    period: opts.period ?? "",
    since: dayKey(since),
    until: dayKey(until),
    days: Math.max(1, Math.ceil((until.getTime() - since.getTime()) / 864e5)),
    bucket_gran: gran,
    buckets: [],
    by_model: [],
    total_cost_usd: 0,
    total_tokens: 0,
    total_calls: 0,
    free_tokens: 0,
    billed_tokens: 0,
    avoided_usd: 0,
    counterfactual_usd: 0,
    baseline_model: pricing.baselineModel,
    baseline_usd_per_mtok: pricing.baselineUsdPerMtok
  };
  for (const e of entries) {
    const cost = e.cost_usd;
    const billed = e.cost_usd > 0;
    const tok2 = e.tokens_in + e.tokens_out;
    const ts = new Date(e.ts_utc);
    const key = granKey(gran, ts);
    const b = buckets.get(key) ?? {
      key,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      calls: 0
    };
    b.cost_usd += cost;
    b.tokens_in += e.tokens_in;
    b.tokens_out += e.tokens_out;
    b.calls += 1;
    buckets.set(key, b);
    const m = models.get(e.model) ?? {
      model: e.model,
      cost_usd: 0,
      tokens: 0,
      tokens_in: 0,
      tokens_out: 0,
      calls: 0,
      billed: false,
      input_usd_per_mtok: 0,
      output_usd_per_mtok: 0
    };
    m.cost_usd += cost;
    m.tokens += tok2;
    m.tokens_in += e.tokens_in;
    m.tokens_out += e.tokens_out;
    m.calls += 1;
    m.billed ||= billed;
    models.set(e.model, m);
    rep.total_cost_usd += cost;
    rep.total_tokens += tok2;
    rep.total_calls += 1;
    if (billed) {
      rep.billed_tokens += tok2;
    } else {
      rep.free_tokens += tok2;
    }
  }
  let baselinePerMtok = pricing.baselineUsdPerMtok;
  let baselineModel = pricing.baselineModel;
  if (baselinePerMtok <= 0) {
    let bestRate = 0;
    let bestModel = "";
    for (const row of models.values()) {
      if (row.billed && row.tokens > 0) {
        const rate = row.cost_usd / row.tokens * 1e6;
        if (rate > bestRate) {
          bestRate = rate;
          bestModel = row.model;
        }
      }
    }
    baselinePerMtok = bestRate;
    baselineModel = bestModel;
  }
  rep.baseline_usd_per_mtok = baselinePerMtok;
  rep.baseline_model = baselineModel;
  rep.avoided_usd = rep.free_tokens / 1e6 * baselinePerMtok;
  rep.counterfactual_usd = rep.total_tokens / 1e6 * baselinePerMtok;
  rep.buckets = [...buckets.values()].toSorted(
    (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  );
  for (const row of models.values()) {
    if (row.billed) {
      const price = pricing.lookup(row.model);
      if (price) {
        row.input_usd_per_mtok = price.input_usd_per_mtok ?? 0;
        row.output_usd_per_mtok = price.output_usd_per_mtok ?? 0;
      }
    }
  }
  rep.by_model = [...models.values()].toSorted(
    (a, b) => b.cost_usd - a.cost_usd || b.tokens - a.tokens
  );
  return rep;
}

// src/service.ts
var SUBDIR = "tokenomics";
var LEDGER_FILE = "ledger.jsonl";
var PRICING_FILE = "pricing.json";
var DAY_MS2 = 864e5;
var DEFAULT_WINDOW_DAYS = 30;
function numericValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function toUsageEvent(evt) {
  const usage = evt.usage ?? {};
  const tokensIn = numericValue(usage.promptTokens) ?? numericValue(usage.input) ?? 0;
  const tokensOut = numericValue(usage.output) ?? 0;
  const event = {
    provider: evt.provider ?? "unknown",
    model: evt.model ?? "unknown",
    tokensIn,
    tokensOut
  };
  const cost = numericValue(evt.costUsd);
  if (cost !== void 0) {
    event.costUsd = cost;
  }
  return event;
}
function shouldRecord(metadata) {
  return metadata.trusted || isInternalDiagnosticEventMetadata(metadata);
}
var DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function parseBound(raw, bound) {
  if (!raw) {
    return void 0;
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    return void 0;
  }
  if (bound === "until" && DATE_ONLY.test(raw.trim())) {
    return new Date(t + DAY_MS2 - 1);
  }
  return new Date(t);
}
function safeErrorMessage(err) {
  return (err instanceof Error ? err.message ?? err.name : String(err)).slice(0, 500);
}
function resolveWindow(params) {
  const rawUntil = params.get("until");
  const rawSince = params.get("since");
  const until = parseBound(rawUntil, "until");
  if (rawUntil !== null && rawUntil.trim() !== "" && until === void 0) {
    return { error: "invalid 'until' timestamp" };
  }
  const since = parseBound(rawSince, "since");
  if (rawSince !== null && rawSince.trim() !== "" && since === void 0) {
    return { error: "invalid 'since' timestamp" };
  }
  const resolvedUntil = until ?? /* @__PURE__ */ new Date();
  const resolvedSince = since ?? new Date(resolvedUntil.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS2);
  if (resolvedSince.getTime() > resolvedUntil.getTime()) {
    return { error: "'since' must be on or before 'until'" };
  }
  return { since: resolvedSince, until: resolvedUntil };
}
function createTokenomicsService() {
  let ledgerPath;
  let pricingPath;
  let adapter;
  let unsubscribe;
  let warn;
  let incompleteUsageEvents = 0;
  function recordUsage(evt) {
    if (!adapter) {
      return;
    }
    const usageEvent = toUsageEvent(evt);
    if (usageEvent.tokensIn === 0 && usageEvent.tokensOut === 0 && usageEvent.costUsd === void 0) {
      incompleteUsageEvents += 1;
      if (incompleteUsageEvents === 1 || incompleteUsageEvents % 50 === 0) {
        warn?.(
          `tokenomics: ${incompleteUsageEvents} model.usage event(s) for ${usageEvent.provider}/${usageEvent.model} carried no token usage or cost and were not recorded \u2014 the provider may not report streaming usage (for OpenAI-compatible providers set the provider's compat.supportsUsageInStreaming=true)`
        );
      }
      return;
    }
    adapter.track(usageEvent);
  }
  function openLedger() {
    return new Ledger(ledgerPath ?? "", {
      onMalformed: (count) => warn?.(`tokenomics: skipped ${count} malformed ledger line(s) while reading`),
      onError: (err) => warn?.(`tokenomics: failed to write ledger entry: ${safeErrorMessage(err)}`)
    });
  }
  function reportFor(window, params) {
    const granRaw = params.get("gran");
    const gran = granRaw ? parseGran(granRaw) : "day";
    const period = params.get("period") ?? void 0;
    const pricing = pricingPath ? PricingCatalog.load(pricingPath, { logger: warn }) : new PricingCatalog();
    return buildReport({
      ledger: openLedger(),
      pricing,
      since: window.since,
      until: window.until,
      gran,
      period
    });
  }
  function finOpsReportFor(window) {
    const pricing = pricingPath ? PricingCatalog.load(pricingPath, { logger: warn }) : new PricingCatalog();
    return buildFinOpsReport(openLedger(), pricing, {
      since: window.since,
      until: window.until
    });
  }
  function currentReport(params) {
    const resolved = resolveWindow(params);
    const window = "error" in resolved ? { since: new Date(Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS2), until: /* @__PURE__ */ new Date() } : resolved;
    return reportFor(window, params);
  }
  const handler = (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end("Method Not Allowed");
      return true;
    }
    if (!ledgerPath) {
      res.statusCode = 503;
      res.end("tokenomics service not started");
      return true;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const window = resolveWindow(url.searchParams);
    if ("error" in window) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(window.error);
      return true;
    }
    if (url.searchParams.get("view") === "finops") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "HEAD") {
        res.end();
        return true;
      }
      res.end(JSON.stringify(finOpsReportFor(window)));
      return true;
    }
    const format = url.searchParams.get("format") ?? "json";
    const report = reportFor(window, url.searchParams);
    if (format === "text") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      if (req.method === "HEAD") {
        res.end();
        return true;
      }
      res.end(renderReport(report));
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    res.end(JSON.stringify(report));
    return true;
  };
  const service = {
    id: "tokenomics",
    start(ctx) {
      const dir = join(ctx.stateDir, SUBDIR);
      ledgerPath = join(dir, LEDGER_FILE);
      pricingPath = join(dir, PRICING_FILE);
      warn = (msg) => ctx.logger.warn(msg);
      const pricing = PricingCatalog.load(pricingPath, { logger: warn });
      adapter = new HostAdapter(ledgerPath, "openclaw", { pricing });
      const modelUsage = ctx.modelUsage;
      if (modelUsage) {
        unsubscribe = modelUsage.onEvent((event) => {
          try {
            recordUsage(event);
          } catch (err) {
            ctx.logger.error(`tokenomics: failed to record usage event: ${safeErrorMessage(err)}`);
          }
        });
        ctx.logger.info(`tokenomics: recording model spend to ${ledgerPath} (modelUsage stream)`);
        return;
      }
      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.error(
          "tokenomics: no model-usage capability (ctx.modelUsage or internalDiagnostics) available; spend will not be recorded"
        );
        return;
      }
      unsubscribe = subscribe((event, metadata) => {
        if (event.type !== "model.usage" || !shouldRecord(metadata)) {
          return;
        }
        try {
          recordUsage(event);
        } catch (err) {
          ctx.logger.error(`tokenomics: failed to record usage event: ${safeErrorMessage(err)}`);
        }
      });
      ctx.logger.info(`tokenomics: recording model spend to ${ledgerPath} (diagnostics fallback)`);
    },
    stop() {
      unsubscribe?.();
      unsubscribe = void 0;
      adapter = void 0;
    }
  };
  return { service, handler, report: currentReport };
}

// index.ts
var tokenomics = createTokenomicsService();
var index_default = definePluginEntry({
  id: "tokenomics",
  name: "Tokenomics",
  description: "Local-first LLM spend ledger and report built on OpenClaw's per-call cost data",
  register(api) {
    api.registerService(tokenomics.service);
    api.registerHttpRoute({
      path: "/api/diagnostics/tokenomics",
      auth: "gateway",
      match: "exact",
      gatewayRuntimeScopeSurface: "trusted-operator",
      handler: tokenomics.handler
    });
  }
});
export {
  index_default as default
};
