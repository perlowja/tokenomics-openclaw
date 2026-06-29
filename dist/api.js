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
export {
  buildFinOpsReport,
  cacheSavingsByModel,
  cheapestEquivalentAdvisor,
  forecastBurn,
  isInternalDiagnosticEventMetadata,
  realizedRateByModel,
  spendByDimension
};
