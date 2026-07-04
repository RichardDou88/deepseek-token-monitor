const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const PROVIDERS_FILE = path.join(__dirname, "providers.json");
const USAGE_FILE = path.join(__dirname, "token_usage.json");
const DAILY_SNAPSHOTS_FILE = path.join(__dirname, "daily_snapshots.json");

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function loadJSON(fp, fb) {
  try { if (fs.existsSync(fp)) { let raw = fs.readFileSync(fp, "utf8"); if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); return JSON.parse(raw); } } catch (e) {}
  return fb;
}
function saveJSON(fp, d) { fs.writeFileSync(fp, JSON.stringify(d, null, 2), "utf8"); }
function maskKey(k) { if (!k || k.length < 8) return "***"; return k.slice(0, 6) + "..." + k.slice(-4); }
function extractToken(raw) {
  if (!raw) return null;
  try { const obj = JSON.parse(raw); if (obj && obj.value) return obj.value; } catch (e) {}
  return raw;
}

// ====== Platform Scraper ======
async function fetchDeepSeekPlatformUsage(platformToken) {
  const token = extractToken(platformToken);
  if (!token) return null;
  const now = new Date(), year = String(now.getFullYear()), month = String(now.getMonth() + 1);
  try {
    const [summaryResp, amtResp, costResp] = await Promise.all([
      fetch("https://platform.deepseek.com/api/v0/users/get_user_summary", {
        headers: { "Authorization": "Bearer " + token, "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000),
      }),
      fetch("https://platform.deepseek.com/api/v0/usage/amount?year=" + year + "&month=" + month, {
        headers: { "Authorization": "Bearer " + token, "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000),
      }),
      fetch("https://platform.deepseek.com/api/v0/usage/cost?year=" + year + "&month=" + month, {
        headers: { "Authorization": "Bearer " + token, "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000),
      }),
    ]);
    const [sData, aData, cData] = await Promise.all([
      summaryResp.ok ? summaryResp.json() : null, amtResp.ok ? amtResp.json() : null, costResp.ok ? costResp.json() : null,
    ]);
    let balance = null, toppedUp = null, bonus = null, monthlyUsageTokens = 0, monthlyCostTotal = 0;
    const wallets = [];
    if (!sData || sData.code !== 0) return null; // Token无效或API拒绝
    { // sData.code === 0 already validated
      const sd = sData.data.biz_data || sData.data || {};
      monthlyUsageTokens = Number(sd.monthly_usage || sd.monthly_token_usage) || 0;
      
      for (const w of (sd.normal_wallets || [])) {
        wallets.push({ type: "normal", currency: w.currency, balance: Number(w.balance) || 0 });
        if (w.currency === "CNY") toppedUp = (toppedUp || 0) + (Number(w.balance) || 0);
      }
      for (const w of (sd.bonus_wallets || [])) {
        wallets.push({ type: "bonus", currency: w.currency, balance: Number(w.balance) || 0 });
        if (w.currency === "CNY") bonus = (bonus || 0) + (Number(w.balance) || 0);
      }
      balance = (toppedUp || 0) + (bonus || 0);
      for (const mc of (sd.monthly_costs || [])) monthlyCostTotal += parseFloat(String(mc.amount || mc.cost || "0")) || 0;
    }
    let totalCacheHit = 0, totalCacheMiss = 0, totalResponse = 0, totalRequests = 0;
    const modelBreakdown = [];
    if (aData && aData.code === 0) {
      for (const m of ((aData.data.biz_data || aData.data || {}).total || [])) {
        let hit = 0, miss = 0, resp = 0, req = 0;
        for (const u of (m.usage || [])) {
          const amt = Number(u.amount) || 0;
          if (u.type === "PROMPT_CACHE_HIT_TOKEN") hit = amt;
          else if (u.type === "PROMPT_CACHE_MISS_TOKEN") miss = amt;
          else if (u.type === "RESPONSE_TOKEN") resp = amt;
          else if (u.type === "REQUEST") req = amt;
        }
        totalCacheHit += hit; totalCacheMiss += miss; totalResponse += resp; totalRequests += req;
        modelBreakdown.push({ model: m.model, cacheHit: hit, cacheMiss: miss, response: resp, requests: req });
      }
    }
    let platformCost = 0;
    const modelCosts = [];
    if (cData && cData.code === 0) {
      for (const entry of (Array.isArray(cData.data.biz_data) ? cData.data.biz_data : [])) {
        for (const ct of (entry.total || [])) {
          if (!ct.usage || !Array.isArray(ct.usage)) continue;
          let mc = 0;
          for (const u of ct.usage) mc += parseFloat(String(u.amount || "0")) || 0;
          platformCost += mc;
          modelCosts.push({ model: ct.model, cost: Math.round(mc * 1e5) / 1e5 });
        }
      }
    }
    const finalCost = monthlyCostTotal > 0 ? monthlyCostTotal : Math.round(platformCost * 1e5) / 1e5;
    // Accurate remaining token estimation based on actual usage ratio
    const actualTotalTokens = totalCacheHit + totalCacheMiss + totalResponse;
    let estimatedRemaining = null;
    if (actualTotalTokens > 0 && finalCost > 0 && balance > 0) {
      const avgCostPerToken = finalCost / actualTotalTokens;
      estimatedRemaining = Math.round(balance / avgCostPerToken);
    }
    
    return {
      source: "deepseek_platform", provider: "DeepSeek",
      estimatedRemainingTokens: estimatedRemaining,
      totalPrompt: totalCacheHit + totalCacheMiss, totalCompletion: totalResponse,
      totalTokens: totalCacheHit + totalCacheMiss + totalResponse,
      totalCacheHit, totalCacheMiss, totalRequests,
      cost: finalCost, currency: "CNY",
      balance, toppedUpBalance: toppedUp, bonusBalance: bonus,
      monthlyUsageTokens, 
      modelBreakdown, modelCosts, walletBreakdown: wallets,
      fetchedAt: new Date().toISOString(),
    };
  } catch (e) { console.error("[platform]", e.message); return null; }
}

async function queryProviderUsage(provider) {
  if (!provider) return null;
  if (provider.platformToken && provider.baseUrl && provider.baseUrl.includes("deepseek"))
    return await fetchDeepSeekPlatformUsage(provider.platformToken);
  if (provider.apiKey && provider.baseUrl) {
    try {
      const resp = await fetch(provider.baseUrl + "/v1/usage?date=" + new Date().toISOString().slice(0, 10), {
        headers: { "Authorization": "Bearer " + provider.apiKey }, signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.data && Array.isArray(data.data)) {
          let tp = 0, tc = 0;
          for (const item of data.data) { tp += item.prompt_tokens || 0; tc += item.completion_tokens || 0; }
          const tt = tp + tc;
          return { source: "provider_api", provider: provider.name, totalPrompt: tp, totalCompletion: tc, totalTokens: tt,
            cost: Math.round(((tp / 1e6) * (provider.inputPrice || 1) + (tc / 1e6) * (provider.outputPrice || 4)) * 1e5) / 1e5,
            currency: provider.currency || "CNY", fetchedAt: new Date().toISOString() };
        }
      }
    } catch (e) {}
  }
  return null;
}

const PROVIDER_USAGE_CACHE = {};
app.get("/api/provider-usage/:providerId", async (req, res) => {
  const providers = loadJSON(PROVIDERS_FILE, []);
  const provider = providers.find(p => p.id === req.params.providerId) || providers[0];
  if (!provider) return res.json(null);
  const cacheKey = provider.id, now = Date.now();
  if (req.query.force !== "true" && PROVIDER_USAGE_CACHE[cacheKey] && now - PROVIDER_USAGE_CACHE[cacheKey].ts < 300000)
    return res.json(PROVIDER_USAGE_CACHE[cacheKey].data);
  const result = await queryProviderUsage(provider);
  PROVIDER_USAGE_CACHE[cacheKey] = { ts: now, data: result };
  res.json(result);
});

app.post("/api/provider-usage/sync", (req, res) => {
  const d = { source: "manual_sync", providerId: req.body.providerId || "default",
    totalPrompt: Number(req.body.totalPrompt) || 0, totalCompletion: Number(req.body.totalCompletion) || 0,
    totalTokens: Number(req.body.totalTokens) || 0, totalCost: Number(req.body.totalCost) || 0,
    currency: "CNY", syncedAt: new Date().toISOString() };
  PROVIDER_USAGE_CACHE[req.body.providerId || "default"] = { ts: Date.now(), data: d };
  res.json({ success: true, data: d });
});

// ====== Price Scraper ======
const PRICING_CACHE = {};
async function fetchDeepSeekPricing() {
  try {
    const resp = await fetch("https://api-docs.deepseek.com/zh-cn/quick_start/pricing", {
      headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000),
    });
    const html = await resp.text();
    const tables = html.match(/<table[\s\S]*?<\/table>/g);
    if (!tables) return null;
    const pricingTable = tables.find(t => t.includes("\u767e\u4e07tokens") || t.includes("\u7f13\u5b58"));
    if (!pricingTable) return null;
    const rows = pricingTable.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    const prices = { flash: {}, pro: {} };
    for (const row of rows) {
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
      let label = "", fVal = NaN, pVal = NaN;
      if (tds.length === 4) { label = tds[1]; fVal = parseFloat(tds[2].replace(/[^\d.]/g, "")); pVal = parseFloat(tds[3].replace(/[^\d.]/g, "")); }
      else if (tds.length === 3) { label = tds[0]; fVal = parseFloat(tds[1].replace(/[^\d.]/g, "")); pVal = parseFloat(tds[2].replace(/[^\d.]/g, "")); }
      else continue;
      if (isNaN(fVal) || isNaN(pVal)) continue;
      if (label.includes("\u7f13\u5b58\u547d\u4e2d")) { prices.flash.cacheHit = fVal; prices.pro.cacheHit = pVal; }
      else if (label.includes("\u7f13\u5b58\u672a\u547d\u4e2d") || label.includes("\u8f93\u5165")) { prices.flash.input = fVal; prices.pro.input = pVal; }
      else if (label.includes("\u8f93\u51fa")) { prices.flash.output = fVal; prices.pro.output = pVal; }
    }
    if (prices.pro.input) {
      return [{
        source: "deepseek_auto", model: "deepseek-v4-pro",
        inputPrice: prices.pro.input, outputPrice: prices.pro.output, cacheHitPrice: prices.pro.cacheHit || 0,
        currency: "CNY", updatedAt: new Date().toISOString(),
      }, {
        source: "deepseek_auto", model: "deepseek-v4-flash",
        inputPrice: prices.flash.input, outputPrice: prices.flash.output, cacheHitPrice: prices.flash.cacheHit || 0,
        currency: "CNY", updatedAt: new Date().toISOString(),
      }];
    }
    return null;
  } catch (e) { return null; }
}

app.get("/api/pricing/fetch", async (req, res) => {
  const now = Date.now(); const results = [];
  if (!PRICING_CACHE.deepseek || now - PRICING_CACHE.deepseek.ts > 3600000) {
    const p = await fetchDeepSeekPricing();
    if (p) { PRICING_CACHE.deepseek = { ts: now, data: p }; results.push(...p); }
    else if (PRICING_CACHE.deepseek) results.push(...PRICING_CACHE.deepseek.data);
  } else if (PRICING_CACHE.deepseek) results.push(...PRICING_CACHE.deepseek.data);
  res.json({ results, cached: results.length > 0 });
});

// ====== Smart Auto-Config ======
const KNOWN_PROVIDERS = {
  "api.deepseek.com": { name: "DeepSeek", models: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat"], currency: "CNY", pricingSource: "deepseek_auto" },
  "api.openai.com": { name: "OpenAI", models: ["gpt-4o", "gpt-4o-mini"], currency: "USD", pricingSource: "manual" },
};

app.get("/api/auto-config", async (req, res) => {
  const url = (req.query.url || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  let matched = KNOWN_PROVIDERS[url];
  if (!matched) for (const [k, v] of Object.entries(KNOWN_PROVIDERS)) { if (url.includes(k)) { matched = v; break; } }
  const result = { detected: !!matched, ...(matched || {}), pricing: null };
  if (matched && matched.pricingSource === "deepseek_auto") {
    const now = Date.now();
    if (!PRICING_CACHE.deepseek || now - PRICING_CACHE.deepseek.ts > 3600000) {
      const p = await fetchDeepSeekPricing();
      if (p) PRICING_CACHE.deepseek = { ts: now, data: p };
    }
    if (PRICING_CACHE.deepseek) {
      const pro = PRICING_CACHE.deepseek.data.find(x => x.model.includes("pro"));
      result.pricing = {
        models: PRICING_CACHE.deepseek.data.map(x => ({ model: x.model, inputPrice: x.inputPrice, outputPrice: x.outputPrice, cacheHitPrice: x.cacheHitPrice })),
        recommended: pro || PRICING_CACHE.deepseek.data[0],
      };
    }
  }
  res.json(result);
});


// ====== 一键获取 Platform Token (书签推送) ======
app.post("/api/platform-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: false, error: "token required" });
  const providers = loadJSON(PROVIDERS_FILE, []);
  if (providers.length === 0) {
    // 自动创建一个 DeepSeek 服务商
    providers.push({
      id: crypto.randomUUID(), name: "DeepSeek",
      baseUrl: "https://api.deepseek.com", apiKey: "",
      platformToken: token, model: "deepseek-v4-pro",
      models: ["deepseek-v4-pro"], currency: "CNY",
      inputPrice: 3, outputPrice: 6, cacheHitPrice: 0.025,
      peakMultiplier: 1, offPeakMultiplier: 1, peakStart: 9, peakEnd: 22,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  } else {
    providers[0].platformToken = token;
    providers[0].updatedAt = new Date().toISOString();
  }
  saveJSON(PROVIDERS_FILE, providers);
  // 清除缓存，下次请求会重新拉取
  if (providers[0]) delete PROVIDER_USAGE_CACHE[providers[0].id];
  res.json({ success: true, provider: providers[0].name });
});
// ====== Providers CRUD ======
app.get("/api/providers", (req, res) => {
  res.json(loadJSON(PROVIDERS_FILE, []).map(x => ({ ...x, apiKey: maskKey(x.apiKey), hasKey: !!x.apiKey,
    platformToken: x.platformToken ? maskKey(x.platformToken) : "", hasPlatformToken: !!x.platformToken })));
});

app.post("/api/providers", (req, res) => {
  const { id, name, baseUrl, apiKey, platformToken, model, models, inputPrice, outputPrice, cacheHitPrice,
    peakMultiplier, offPeakMultiplier, peakStart, peakEnd, currency } = req.body;
  if (!name || !baseUrl) return res.status(400).json({ error: "name and baseUrl required" });
  const providers = loadJSON(PROVIDERS_FILE, []);
  const providerId = id || crypto.randomUUID(), existing = providers.find(p => p.id === providerId);
  const finalKey = apiKey !== undefined ? (apiKey || (existing ? existing.apiKey : "")) : (existing ? existing.apiKey : "");
  const finalPT = platformToken !== undefined ? (platformToken || (existing ? existing.platformToken : "")) : (existing ? existing.platformToken : "");
  const now = new Date().toISOString();
  const provider = {
    id: providerId, name, currency: currency || "CNY", baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: finalKey, platformToken: finalPT,
    model: model || "default", models: models || [model || "default"],
    inputPrice: inputPrice !== undefined ? Number(inputPrice) : (existing ? existing.inputPrice : 2),
    outputPrice: outputPrice !== undefined ? Number(outputPrice) : (existing ? existing.outputPrice : 8),
    cacheHitPrice: cacheHitPrice !== undefined ? Number(cacheHitPrice) : (existing ? existing.cacheHitPrice : 0.5),
    peakMultiplier: peakMultiplier !== undefined ? Number(peakMultiplier) : (existing ? existing.peakMultiplier : 1),
    offPeakMultiplier: offPeakMultiplier !== undefined ? Number(offPeakMultiplier) : (existing ? existing.offPeakMultiplier : 1),
    peakStart: peakStart !== undefined ? Number(peakStart) : (existing ? existing.peakStart : 9),
    peakEnd: peakEnd !== undefined ? Number(peakEnd) : (existing ? existing.peakEnd : 22),
    createdAt: existing ? existing.createdAt : now, updatedAt: now,
  };
  if (existing) Object.assign(existing, provider); else providers.push(provider);
  saveJSON(PROVIDERS_FILE, providers);
  res.json({ ...provider, apiKey: maskKey(finalKey), hasKey: !!finalKey, platformToken: maskKey(finalPT), hasPlatformToken: !!finalPT });
});

app.delete("/api/providers/:id", (req, res) => {
  saveJSON(PROVIDERS_FILE, loadJSON(PROVIDERS_FILE, []).filter(x => x.id !== req.params.id));
  res.json({ success: true });
});


// ====== Daily Usage (from platform daily API) ======
function sumDayTokens(dayData) {
  if (!dayData || !Array.isArray(dayData)) return 0;
  let sum = 0;
  for (const model of dayData) {
    if (!model.usage || !Array.isArray(model.usage)) continue;
    for (const u of model.usage) {
      const amt = Number(u.amount) || 0;
      const type = u.type || "";
      if (type.includes("TOKEN") && type !== "REQUEST") sum += amt;
    }
  }
  return sum;
}
function sumDayCost(dayData) {
  if (!dayData || !Array.isArray(dayData)) return 0;
  let sum = 0;
  for (const model of dayData) {
    if (!model.usage || !Array.isArray(model.usage)) continue;
    for (const u of model.usage) sum += Number(u.amount) || 0;
  }
  return sum;
}
function sumDayByType(dayData, typeMatch) {
  if (!dayData || !Array.isArray(dayData)) return 0;
  let sum = 0;
  for (const model of dayData) {
    if (!model.usage || !Array.isArray(model.usage)) continue;
    for (const u of model.usage) {
      if ((u.type || "").includes(typeMatch)) sum += Number(u.amount) || 0;
    }
  }
  return sum;
}

app.get("/api/daily-usage/:providerId", async (req, res) => {
  const providers = loadJSON(PROVIDERS_FILE, []);
  const provider = providers.find(p => p.id === req.params.providerId);
  if (!provider || !provider.platformToken) return res.json({ dailyTokens: 0, dailyCost: 0, prevDailyTokens: null, prevDailyCost: null, comparison: null, firstDay: false, source: "none" });

  const token = extractToken(provider.platformToken);
  if (!token) return res.json({ dailyTokens: 0, dailyCost: 0, prevDailyTokens: null, prevDailyCost: null, comparison: null, firstDay: false, source: "none" });

  const today = new Date();
  const todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.getFullYear() + "-" + String(yesterday.getMonth() + 1).padStart(2, "0") + "-" + String(yesterday.getDate()).padStart(2, "0");
  const isFirstDay = today.getDate() === 1;
  const year = String(today.getFullYear()), month = String(today.getMonth() + 1);

  try {
    const headers = { "Authorization": "Bearer " + token, "User-Agent": "Mozilla/5.0" };
    const [amtResp, costResp] = await Promise.all([
      fetch("https://platform.deepseek.com/api/v0/usage/amount?year=" + year + "&month=" + month, { headers, signal: AbortSignal.timeout(10000) }),
      fetch("https://platform.deepseek.com/api/v0/usage/cost?year=" + year + "&month=" + month, { headers, signal: AbortSignal.timeout(10000) }),
    ]);
    const [aData, cData] = await Promise.all([
      amtResp.ok ? amtResp.json() : null, costResp.ok ? costResp.json() : null,
    ]);

    let todayTokens = 0, todayCost = 0, yesterdayTokens = 0, yesterdayCost = 0;
    let todayCacheHit = 0, todayCacheMiss = 0, yesterdayCacheHit = 0, yesterdayCacheMiss = 0;

    // Parse amount days data
    if (aData && aData.code === 0) {
      const days = ((aData.data.biz_data || aData.data || {}).days) || [];
      for (const day of days) {
        if (day.date === todayStr) { todayTokens = sumDayTokens(day.data); todayCacheHit = sumDayByType(day.data, 'CACHE_HIT'); todayCacheMiss = sumDayByType(day.data, 'CACHE_MISS'); }
        else if (day.date === yesterdayStr) { yesterdayTokens = sumDayTokens(day.data); yesterdayCacheHit = sumDayByType(day.data, 'CACHE_HIT'); yesterdayCacheMiss = sumDayByType(day.data, 'CACHE_MISS'); }
      }
    }

    // Parse cost days data
    if (cData && cData.code === 0) {
      const bizData = Array.isArray(cData.data.biz_data) ? cData.data.biz_data : [];
      for (const entry of bizData) {
        const days = entry.days || [];
        if (!Array.isArray(days)) continue;
        for (const day of days) {
          if (day.date === todayStr) todayCost = sumDayCost(day.data);
          else if (day.date === yesterdayStr) yesterdayCost = sumDayCost(day.data);
        }
      }
    }

    let todayHitRateRaw = (todayCacheHit + todayCacheMiss) > 0 ? (todayCacheHit / (todayCacheHit + todayCacheMiss) * 100) : 0;
    let yesterdayHitRateRaw = (yesterdayCacheHit + yesterdayCacheMiss) > 0 ? (yesterdayCacheHit / (yesterdayCacheHit + yesterdayCacheMiss) * 100) : 0;
    let todayHitRate = todayHitRateRaw;
    let yesterdayHitRate = yesterdayHitRateRaw;
    let hitRateChange = yesterdayHitRateRaw > 0 ? (todayHitRateRaw - yesterdayHitRateRaw) : 0;
    
    // Warning rules: < 90% or sudden drop > 10%
    let warning = null;
    if (todayHitRate > 0) {
      if (todayHitRate < 90) warning = "缓存命中率低于90%";
      else if (hitRateChange < -10) warning = "缓存命中率骤降";
      else if (todayHitRate >= 95) warning = "recovered";
    }
    
    let comparison = null;
    if (!isFirstDay && yesterdayTokens > 0) {
      comparison = {
        tokensChange: ((todayTokens - yesterdayTokens) / yesterdayTokens * 100),
        costChange: yesterdayCost > 0 ? ((todayCost - yesterdayCost) / yesterdayCost * 100) : (todayCost > 0 ? 100 : 0),
      };
    }

    res.json({
      today: todayStr,
      dailyTokens: Math.round(todayTokens),
      dailyCost: Math.round(todayCost * 100) / 100,
      prevDailyTokens: yesterdayTokens > 0 ? Math.round(yesterdayTokens) : null,
      prevDailyCost: yesterdayCost > 0 ? Math.round(yesterdayCost * 100) / 100 : null,
      comparison: comparison ? {
        tokensChange: Math.round(comparison.tokensChange * 10) / 10,
        costChange: Math.round(comparison.costChange * 10) / 10,
      } : null,
      firstDay: isFirstDay,
      source: "platform_daily",
      cacheHitRate: Math.round(todayHitRate * 10) / 10,
      yesterdayHitRate: Math.round(yesterdayHitRate * 10) / 10,
      hitRateChange: Math.round(hitRateChange * 100) / 100,
      warning: warning,
      todayCacheHit: Math.round(todayCacheHit),
      todayCacheMiss: Math.round(todayCacheMiss)
    });
  } catch (e) {
    res.json({ dailyTokens: 0, dailyCost: 0, prevDailyTokens: null, prevDailyCost: null, comparison: null, firstDay: false, source: "error", error: e.message });
  }
});
// ====== Usage ======
function emptyUsage() { return { records: [], calls: 0, totalPrompt: 0, totalCompletion: 0, totalTokens: 0, totalCacheHit: 0, totalCacheMiss: 0, totalCost: 0 }; }
app.get("/api/usage", (req, res) => {
  const data = loadJSON(USAGE_FILE, emptyUsage());
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const monthRecords = data.records.filter(r => r.timestamp >= monthStart);
  const monthly = { calls: 0, totalPrompt: 0, totalCompletion: 0, totalTokens: 0, totalCacheHit: 0, totalCacheMiss: 0, totalCost: 0 };
  for (const r of monthRecords) { monthly.calls++; monthly.totalPrompt += r.promptTokens; monthly.totalCompletion += r.completionTokens; monthly.totalTokens += r.totalTokens; monthly.totalCacheHit += r.cacheHitTokens || 0; monthly.totalCacheMiss += r.cacheMissTokens || 0; monthly.totalCost += r.cost || 0; }
  res.json({ ...data, monthly });
});
app.delete("/api/usage", (req, res) => { saveJSON(USAGE_FILE, emptyUsage()); res.json({ success: true }); });

function getTimeMultiplier(provider) {
  if (!provider.peakMultiplier && !provider.offPeakMultiplier) return 1;
  const hour = new Date().getHours(), peak = provider.peakStart || 9, end = provider.peakEnd || 22;
  return hour >= peak && hour < end ? (provider.peakMultiplier || 1) : (provider.offPeakMultiplier || 1);
}

app.post("/api/chat", async (req, res) => {
  const { providerId, messages, model, ...rest } = req.body;
  const providers = loadJSON(PROVIDERS_FILE, []), provider = providerId ? providers.find(p => p.id === providerId) : providers[0];
  if (!provider) return res.status(400).json({ error: "No provider" });
  if (!provider.apiKey) return res.status(400).json({ error: "No API key" });
  try {
    const start = Date.now();
    const resp = await fetch(provider.baseUrl + "/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + provider.apiKey },
      body: JSON.stringify({ model: model || provider.model, messages, ...rest }),
    });
    const data = await resp.json();
    if (data.usage) {
      const usage = loadJSON(USAGE_FILE, emptyUsage());
      const cacheHit = data.usage.prompt_cache_hit_tokens || 0, hasCache = data.usage.prompt_cache_hit_tokens !== undefined;
      const actualMiss = hasCache ? (data.usage.prompt_cache_miss_tokens || 0) : data.usage.prompt_tokens;
      const tm = getTimeMultiplier(provider);
      const callCost = (actualMiss / 1e6) * (provider.inputPrice || 1) * tm + (cacheHit / 1e6) * (provider.cacheHitPrice || 0.25) * tm + (data.usage.completion_tokens / 1e6) * (provider.outputPrice || 4) * tm;
      usage.records.push({ timestamp: new Date().toISOString(), provider: provider.name, model: model || provider.model, latency_ms: Date.now() - start,
        promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens, totalTokens: data.usage.total_tokens,
        cacheHitTokens: cacheHit, cacheMissTokens: actualMiss, cost: Math.round(callCost * 1e5) / 1e5, currency: "CNY", timeMultiplier: tm });
      usage.totalPrompt += data.usage.prompt_tokens; usage.totalCompletion += data.usage.completion_tokens;
      usage.totalTokens += data.usage.total_tokens; usage.totalCacheHit += cacheHit;
      usage.totalCacheMiss += actualMiss; usage.totalCost += callCost; usage.calls += 1;
      saveJSON(USAGE_FILE, usage);
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/wallpaper", (req, res) => res.sendFile(path.join(__dirname, "public", "wallpaper.html")));

// ====== Auto-Login (Playwright) ======
const { spawn } = require("child_process");
let autoLoginRunning = false;
app.post("/api/auto-login", (req, res) => {
  if (autoLoginRunning) return res.json({ success: false, error: "已有自动登录任务在运行" });
  autoLoginRunning = true;
  const child = spawn("node", [path.join(__dirname, "auto-login.js")], {
    detached: true, stdio: "ignore", windowsHide: false
  });
  child.unref();
  child.on("exit", () => { autoLoginRunning = false; });
  res.json({ success: true, message: "浏览器已启动，请在打开的窗口中登录 DeepSeek 平台，登录成功后 Token 将自动保存" });
});



async function getDailyComparison(providerId) {
  const providers = loadJSON(PROVIDERS_FILE, []);
  const provider = providers.find(p => p.id === providerId) || providers[0];
  if (!provider || !provider.platformToken) return null;
  const token = extractToken(provider.platformToken);
  if (!token) return null;
  const now = new Date();
  const todayStr = now.toISOString().slice(0,10);
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
  const yesterdayStr = yesterday.toISOString().slice(0,10);
  const year = String(now.getFullYear()), month = String(now.getMonth() + 1);
  try {
    const headers = { "Authorization": "Bearer " + token, "User-Agent": "Mozilla/5.0" };
    const amtResp = await fetch("https://platform.deepseek.com/api/v0/usage/amount?year=" + year + "&month=" + month, { headers, signal: AbortSignal.timeout(10000) });
    if (!amtResp.ok) return null;
    const aData = await amtResp.json();
    if (!aData || aData.code !== 0) return null;
    const days = ((aData.data.biz_data || aData.data || {}).days) || [];
    let todayTokens = 0, yesterdayTokens = 0;
    let todayHit = 0, todayMiss = 0, yesterdayHit = 0, yesterdayMiss = 0;
    for (const day of days) {
      if (day.date === todayStr) {
        todayTokens = sumDayTokens(day.data);
        todayHit = sumDayByType(day.data, 'CACHE_HIT');
        todayMiss = sumDayByType(day.data, 'CACHE_MISS');
      } else if (day.date === yesterdayStr) {
        yesterdayTokens = sumDayTokens(day.data);
        yesterdayHit = sumDayByType(day.data, 'CACHE_HIT');
        yesterdayMiss = sumDayByType(day.data, 'CACHE_MISS');
      }
    }
    // Calculate costs based on provider pricing
    const inPrice = provider.inputPrice || 3;
    const hitPrice = provider.cacheHitPrice || 0.025;
    const todayCost = Math.round(((todayMiss / 1e6) * inPrice + (todayHit / 1e6) * hitPrice) * 100) / 100;
    const yesterdayCost = Math.round(((yesterdayMiss / 1e6) * inPrice + (yesterdayHit / 1e6) * hitPrice) * 100) / 100;
    const todayHitRate = (todayHit + todayMiss) > 0 ? Math.round((todayHit / (todayHit + todayMiss) * 100) * 10) / 10 : 0;
    const yesterdayHitRate = (yesterdayHit + yesterdayMiss) > 0 ? Math.round((yesterdayHit / (yesterdayHit + yesterdayMiss) * 100) * 10) / 10 : 0;
    const firstDay = yesterdayTokens === 0;
    const comparison = !firstDay ? {
      tokensChange: Math.round(((todayTokens - yesterdayTokens) / yesterdayTokens * 100) * 10) / 10,
      costChange: yesterdayCost > 0 ? Math.round(((todayCost - yesterdayCost) / yesterdayCost * 100) * 10) / 10 : 0
    } : null;
    const hitRateChange = !firstDay && yesterdayHitRate > 0 ? Math.round((todayHitRate - yesterdayHitRate) * 10) / 10 : null;
    let warning = "normal";
    if (todayHitRate < 90 && (todayHit + todayMiss) > 1000) warning = "warning";
    return {
      source: "platform_daily", dailyTokens: todayTokens, dailyCost: todayCost,
      comparison, firstDay,
      cacheHitRate: todayHitRate,
      yesterdayHitRate: yesterdayHitRate,
      hitRateChange,
      warning
    };
  } catch(e) { return null; }
}

// ====== Rainmeter ======
function fmtNum(n) {
  if (n >= 1e10) return { val: Math.round(n / 1e10 * 10) / 10, unit: "百亿" };
  if (n >= 1e8) return { val: Math.round(n / 1e8 * 10) / 10, unit: "亿" };
  if (n >= 1e6) return { val: Math.round(n / 1e6 * 10) / 10, unit: "百万" };
  if (n >= 1e4) return { val: Math.round(n / 1e4 * 10) / 10, unit: "万" };
  return { val: Math.round(n), unit: "" };
}
app.get("/api/rainmeter", async (req, res) => {
  const providers = loadJSON(PROVIDERS_FILE, []);
  if (!providers.length) { res.set("Content-Type","text/plain"); return res.send("status=未配置\n"); }
  const p = providers[0];
  if (!p.platformToken) { res.set("Content-Type","text/plain"); return res.send("status=无Token\n"); }
  try {
    const d = await queryProviderUsage(p);
    if (!d || !d.source) { res.set("Content-Type","text/plain"); return res.send("status=获取失败\n"); }
    const fv = fmtNum(d.totalTokens || 0);
    const ch = fmtNum(d.totalCacheHit || 0);
    const cm = fmtNum(d.totalCacheMiss || 0);
    const tp = fmtNum(d.totalPrompt || 0);
    const tc = fmtNum(d.totalCompletion || 0);
    const er = fmtNum(d.estimatedRemainingTokens || 0);
    const cacheRate = Math.round(((d.totalCacheHit||0) / ((d.totalCacheHit||0)+(d.totalCacheMiss||0)||1) * 100)*10)/10;
    const lines = [
      "status=在线",
      "provider=" + (d.provider || p.name || "DeepSeek"),
      "model=" + (p.model || "deepseek-v4-pro"),
      "totalTokens=" + fv.val + " " + fv.unit,
      "balance=" + Number(d.balance||0).toFixed(2),
      "cost=" + Number(d.cost||d.totalCost||0).toFixed(2),
      "estimated=" + (er.val ? er.val + " " + er.unit : "--"),
      "input=" + tp.val + " " + tp.unit,
      "output=" + tc.val + " " + tc.unit,
      "calls=" + (d.totalRequests||0),
      "cacheHit=" + ch.val + " " + ch.unit,
      "cacheMiss=" + cm.val + " " + cm.unit,
      "cacheRate=" + cacheRate + "%",
    ];
    // Daily comparison
    try {
      const dd = await getDailyComparison(p.id);
      if (dd && dd.source && dd.source !== "none") {
        const dt = fmtNum(dd.dailyTokens || 0);
        lines.push("dailyTokens=" + dt.val + " " + dt.unit);
        lines.push("dailyCost=" + Number(dd.dailyCost||0).toFixed(2));
        if (dd.comparison && !dd.firstDay) {
          const tc = dd.comparison.tokensChange || 0;
          const cc = dd.comparison.costChange || 0;
          lines.push("dailyTokensCmp=" + (tc >= 0 ? "+" : "") + Math.round(tc*10)/10 + "%");
          lines.push("dailyCostCmp=" + (cc >= 0 ? "+" : "") + Math.round(cc*10)/10 + "%");
        } else {
          lines.push("dailyTokensCmp=本月第一天");
          lines.push("dailyCostCmp=本月第一天");
        }
        lines.push("dailyHitRate=" + Math.round((dd.cacheHitRate||0)*10)/10 + "%");
        if (dd.hitRateChange !== undefined && dd.hitRateChange !== null) {
          const hrc = dd.hitRateChange || 0;
          lines.push("dailyHitRateCmp=" + (hrc >= 0 ? "+" : "") + Math.round(hrc*10)/10 + "%");
        } else {
          lines.push("dailyHitRateCmp=");
        }
        lines.push("hitStatus=" + (dd.warning || "normal"));
      } else {
        lines.push("dailyTokens=--");
        lines.push("dailyCost=--");
        lines.push("dailyTokensCmp=");
        lines.push("dailyCostCmp=");
        lines.push("dailyHitRate=--");
        lines.push("dailyHitRateCmp=");
        lines.push("hitStatus=");
      }
    } catch(e) {
      lines.push("dailyTokens=--");
      lines.push("dailyCost=--");
      lines.push("dailyTokensCmp=");
      lines.push("dailyCostCmp=");
      lines.push("dailyHitRate=--");
      lines.push("dailyHitRateCmp=");
      lines.push("hitStatus=");
    }
    if (d.fetchedAt) { const t = new Date(d.fetchedAt); lines.push("updated=" + (t.getMonth()+1) + "/" + t.getDate() + " " + String(t.getHours()).padStart(2,"0")+":"+String(t.getMinutes()).padStart(2,"0")); }
    res.set("Content-Type","text/plain");
    res.send(lines.join("\n"));
  } catch(e) { res.set("Content-Type","text/plain"); res.send("status=错误\n"); }
});

app.listen(PORT, () => console.log("Server: http://localhost:" + PORT));
