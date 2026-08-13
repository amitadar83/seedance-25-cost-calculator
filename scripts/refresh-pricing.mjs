#!/usr/bin/env node

/**
 * Refresh the browser-readable pricing snapshot from first-party sources.
 *
 * Runtime: Node 20+, no dependencies.
 * Safety model:
 *   - every source retains its last accepted values;
 *   - missing/non-positive monitored values are rejected;
 *   - a monitored value moving by more than 25% is held for review;
 *   - fetch and parser failures publish source health while retaining data.
 */

import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(SCRIPT_DIR, "..");
const DATA_DIR = resolve(PROJECT_DIR, "data");
const JSON_PATH = resolve(DATA_DIR, "live-pricing.json");
const JS_PATH = resolve(DATA_DIR, "live-pricing.js");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const VALIDATE_ONLY = args.has("--validate-only");
const SELF_TEST = args.has("--self-test");
const RESET_BASELINE = args.has("--reset-baseline");
const TIMEOUT_MS = positiveNumber(process.env.PRICING_FETCH_TIMEOUT_MS, 20_000);
const MAX_SHIFT = positiveNumber(process.env.PRICING_MAX_SHIFT_PERCENT, 25) / 100;
const CURATED_BASELINE_AT = "2026-08-13T13:30:00.000Z";

const SOURCE_DEFINITIONS = [
  {
    id: "runway-plans",
    provider: "Runway",
    kind: "subscription",
    source: "https://runway.com/pricing?tool=runway",
    parser: "runway-plans-v1",
    parse: parseRunwayPlans,
    monitored: [
      "plans.standard.monthly_usd",
      "plans.standard.monthly_credits",
      "plans.pro.monthly_usd",
      "plans.pro.monthly_credits",
      "plans.max.monthly_usd",
      "plans.max.monthly_credits"
    ],
    baseline: {
      currency: "USD",
      plans: {
        standard: { name: "Standard", monthly_usd: 15, monthly_credits: 625 },
        pro: { name: "Pro", monthly_usd: 35, monthly_credits: 2250 },
        max: { name: "Max", monthly_usd: 95, monthly_credits: 9500 }
      },
      promotions: []
    }
  },
  {
    id: "runway-seedance-2-5",
    provider: "Runway",
    kind: "model-credit-rate",
    source: "https://academy.runwayml.com/models-pricing",
    parser: "runway-model-table-v1",
    parse: parseRunwaySeedance,
    monitored: [
      "rates.480p.credits_per_second",
      "rates.480p.credits_per_5s",
      "rates.720p.credits_per_second",
      "rates.720p.credits_per_5s"
    ],
    baseline: {
      model: "Seedance 2.5",
      availability: "live",
      rates: {
        "480p": { credits_per_second: 20, credits_per_5s: 100 },
        "720p": { credits_per_second: 30, credits_per_5s: 150 }
      },
      unit_note: "per output second; video input adds a separate surcharge"
    }
  },
  {
    id: "higgsfield-plans",
    provider: "Higgsfield",
    kind: "subscription",
    source: "https://fnf-api-gw.higgsfield.ai/fnf/subscriptions/v2/plans?plan_set_key=ps_a3&with_localization=true",
    parser: "higgsfield-plan-api-v1",
    parse: parseHiggsfieldPlans,
    monitored: [
      "plans.starter_270.monthly_list_usd",
      "plans.starter_270.credits",
      "plans.plus_1200.monthly_list_usd",
      "plans.plus_1200.credits",
      "plans.ultra_3000.monthly_list_usd",
      "plans.ultra_3000.credits",
      "plans.ultra_6000.monthly_list_usd",
      "plans.ultra_6000.credits",
      "plans.ultra_9000.monthly_list_usd",
      "plans.ultra_9000.credits"
    ],
    baseline: {
      currency: "USD",
      plans: {
        starter_270: planBaseline("Starter", "starter", 270, 19, 19, 19),
        plus_1200: planBaseline("Plus", "plus", 1200, 59, 59, 59),
        ultra_3000: planBaseline("Ultra", "ultra", 3000, 129, 129, 129),
        ultra_6000: planBaseline("Ultra", "ultra", 6000, 250, 220, 250, 12),
        ultra_9000: planBaseline("Ultra", "ultra", 9000, 375, 310, 375, 17)
      }
    }
  },
  {
    id: "ltx-studio-plans",
    provider: "LTX Studio",
    kind: "subscription",
    source: "https://website.ltx.studio/studio/pricing",
    parser: "ltx-webflow-plans-v1",
    parse: parseLtxPlans,
    monitored: [
      "plans.lite.monthly_usd",
      "plans.lite.monthly_credits",
      "plans.standard.monthly_usd",
      "plans.standard.monthly_credits",
      "plans.pro.monthly_usd",
      "plans.pro.monthly_credits"
    ],
    baseline: {
      currency: "USD",
      plans: {
        lite: { name: "Lite", monthly_usd: 15, monthly_credits: 8000 },
        standard: { name: "Standard", monthly_usd: 35, monthly_credits: 28000 },
        pro: { name: "Pro", monthly_usd: 125, monthly_credits: 110000 }
      }
    }
  },
  {
    id: "fal-seedance-2-5",
    provider: "fal",
    kind: "api",
    source: "https://fal.ai/models/bytedance/seedance-2.5/text-to-video",
    parser: "fal-endpoint-pricing-v1",
    parse: parseFalSeedance,
    monitored: apiRatePaths(true),
    baseline: apiBaseline(0.2205, 0.473, {
      billing_unit: "1000 tokens",
      usd_per_1000_tokens: 0.0214,
      pricing_basis: "approximate standard 16:9 output; native audio included"
    })
  },
  {
    id: "replicate-seedance-2-5",
    provider: "Replicate",
    kind: "api",
    source: "https://replicate.com/bytedance/seedance-2.5",
    parser: "replicate-model-tiers-v1",
    parse: parseReplicateSeedance,
    monitored: [
      ...apiRatePaths(true),
      "video_input_rates.480p.usd_per_second",
      "video_input_rates.720p.usd_per_second"
    ],
    baseline: apiBaseline(0.1028, 0.2312, {
      pricing_basis: "non-video input; per output second",
      video_input_rates: {
        "480p": { usd_per_second: 0.4304, usd_per_5s: 2.152 },
        "720p": { usd_per_second: 0.9676, usd_per_5s: 4.838 }
      }
    })
  },
  {
    id: "wavespeed-seedance-2-5",
    provider: "WaveSpeedAI",
    kind: "api",
    source: "https://wavespeed.ai/models/bytedance/seedance-2.5/text-to-video",
    parser: "wavespeed-model-table-v1",
    parse: parseWaveSpeedSeedance,
    monitored: apiRatePaths(true),
    baseline: apiBaseline(0.18, 0.36, {
      pricing_basis: "standard text-to-video; published five-second table"
    })
  },
  {
    id: "piapi-seedance-2-5",
    provider: "PiAPI",
    kind: "api",
    source: "https://app.piapi.ai/docs/seedance-api/seedance-25",
    parser: "piapi-live-docs-table-v2",
    parse: parsePiApiSeedance,
    monitored: apiRatePaths(true),
    baseline: apiBaseline(0.15, 0.35, {
      pricing_basis: "per output second; official live Seedance 2.5 docs"
    })
  },
  {
    id: "kie-seedance-2-5",
    provider: "Kie.ai",
    kind: "api",
    source: "https://kie.ai/seedance-2-5",
    parser: "kie-pricing-description-v1",
    parse: parseKieSeedance,
    monitored: [
      ...apiRatePaths(true),
      "with_video_rates.480p.usd_per_second",
      "with_video_rates.720p.usd_per_second"
    ],
    baseline: apiBaseline(0.14, 0.315, {
      pricing_basis: "no video input; public beta list price",
      credits_per_usd: 200,
      with_video_rates: {
        "480p": { credits_per_second: 17, usd_per_second: 0.085, usd_per_5s: 0.425 },
        "720p": { credits_per_second: 38, usd_per_second: 0.19, usd_per_5s: 0.95 }
      }
    })
  },
  {
    id: "runware-seedance-2-5",
    provider: "Runware",
    kind: "api",
    source: "https://runware.ai/pricing",
    parser: "runware-pricing-catalog-v1",
    parse: parseRunwareSeedance,
    monitored: apiRatePaths(true),
    baseline: apiBaseline(0.1025, 0.2304, {
      pricing_basis: "text/image-to-video; official one-second examples"
    })
  },
  {
    id: "atlas-seedance-2-5",
    provider: "Atlas Cloud",
    kind: "api",
    source: "https://www.atlascloud.ai/models/bytedance/seedance-2.5/text-to-video",
    supporting_sources: [
      "https://static.atlascloud.ai/model/schema/bytedance-seedance-2.5-text-to-video.json"
    ],
    parser: "atlas-model-default-v1",
    parse: parseAtlasSeedance,
    monitored: ["rates.720p.usd_per_5s", "default_run.usd"],
    baseline: {
      model: "Seedance 2.5",
      availability: "live",
      currency: "USD",
      rates: { "720p": { usd_per_5s: 0.134 } },
      default_run: { usd: 0.134, duration_seconds: 5, resolution: "720p" },
      pricing_basis: "official page price at the official schema's default 5s / 720p configuration"
    }
  }
];

const ALLOWED_SOURCE_HOSTS = new Set(SOURCE_DEFINITIONS.flatMap((definition) =>
  [definition.source, ...(definition.supporting_sources ?? [])].map((source) => new URL(source).hostname)
));
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 12_000_000;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function planBaseline(name, type, credits, list, checkout, renew, discountPercent = null) {
  return {
    name,
    type,
    credits,
    monthly_list_usd: list,
    current_checkout_usd: checkout,
    renewal_usd: renew,
    discount: discountPercent ? { percent_off: discountPercent, duration: "once" } : null
  };
}

function apiRatePaths(includePerFiveSeconds = true) {
  const paths = ["rates.480p.usd_per_second", "rates.720p.usd_per_second"];
  if (includePerFiveSeconds) {
    paths.push("rates.480p.usd_per_5s", "rates.720p.usd_per_5s");
  }
  return paths;
}

function apiBaseline(rate480, rate720, extra = {}) {
  return {
    model: "Seedance 2.5",
    availability: "live",
    currency: "USD",
    rates: {
      "480p": { usd_per_second: rate480, usd_per_5s: roundMoney(rate480 * 5) },
      "720p": { usd_per_second: rate720, usd_per_5s: roundMoney(rate720 * 5) }
    },
    ...extra
  };
}

function roundMoney(value) {
  return Number(value.toFixed(6));
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("\u00a0", " ");
}

function normalizeEmbedded(raw) {
  return decodeHtml(raw)
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u0026/gi, "&")
    .replace(/\\n/g, "\n")
    .replace(/\\\"/g, '"');
}

function stripTags(raw) {
  return decodeHtml(raw.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function requireMatch(value, label) {
  if (value === null || value === undefined || value === "" || Number.isNaN(value)) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function parseRunwayPlans(raw) {
  const text = normalizeEmbedded(raw);
  const planNames = ["Standard", "Pro", "Max", "Enterprise"];
  const plans = {};

  for (let index = 0; index < planNames.length - 1; index += 1) {
    const name = planNames[index];
    const start = text.indexOf(`"name":"${name}"`);
    const end = text.indexOf(`"name":"${planNames[index + 1]}"`, start + 1);
    if (start < 0 || end < 0) throw new Error(`Missing Runway ${name} plan block`);
    const block = text.slice(start, end);
    const monthly = Number(requireMatch(block.match(/"prices":\{"monthly":([\d.]+)/)?.[1], `${name} monthly price`));
    const credits = Number(requireMatch(block.match(/"creditHighlight":"([\d,]+) credits\/?mo/i)?.[1], `${name} monthly credits`).replaceAll(",", ""));
    plans[name.toLowerCase()] = { name, monthly_usd: monthly, monthly_credits: credits };
  }

  const promotionMatch = raw.match(/Get unlimited Seedance 2\.5 on new Max plans until ([^<.]+)\.?/i);
  const promotions = promotionMatch
    ? [{
        title: "Unlimited Seedance 2.5 on new Max plans",
        eligible_plan: "Max",
        ends_label: promotionMatch[1].trim(),
        terms_url: "https://runway.com/seedance-terms",
        temporary: true
      }]
    : [];

  return { currency: "USD", plans, promotions };
}

function parseRunwaySeedance(raw) {
  const text = normalizeEmbedded(raw);
  const start = text.indexOf('"name":"Seedance 2.5"');
  if (start < 0) throw new Error("Seedance 2.5 is absent from the Runway model table");
  const block = text.slice(start, start + 1_400);
  const rate720 = Number(requireMatch(block.match(/"label":"720p?","credits":([\d.]+)/i)?.[1], "Runway 720p credit rate"));
  const rate480 = Number(requireMatch(block.match(/"label":"480p?","credits":([\d.]+)/i)?.[1], "Runway 480p credit rate"));
  const unit = block.match(/"unit":"([^"]+)"/)?.[1] ?? "per output second";
  return {
    model: "Seedance 2.5",
    availability: "live",
    rates: {
      "480p": { credits_per_second: rate480, credits_per_5s: rate480 * 5 },
      "720p": { credits_per_second: rate720, credits_per_5s: rate720 * 5 }
    },
    unit_note: unit
  };
}

function parseHiggsfieldPlans(raw) {
  const payload = JSON.parse(raw);
  if (!Array.isArray(payload.plans)) throw new Error("Higgsfield response has no plans array");
  const plans = {};
  for (const plan of payload.plans.filter((item) => item.billing_period === "monthly")) {
    const key = `${String(plan.plan_type).toLowerCase()}_${Number(plan.credits)}`;
    plans[key] = {
      name: String(plan.name),
      type: String(plan.plan_type),
      credits: Number(plan.credits),
      monthly_list_usd: Number(plan.original_price) / 100,
      current_checkout_usd: Number(plan.final_price) / 100,
      renewal_usd: Number(plan.renew_price) / 100,
      discount: plan.discount
        ? {
            percent_off: Number(plan.discount.percent_off),
            duration: plan.discount.duration,
            duration_months: plan.discount.duration_months
          }
        : null
    };
  }
  if (Object.keys(plans).length < 3) throw new Error("Higgsfield monthly plan list is unexpectedly short");
  return { currency: String(payload.plans[0]?.currency ?? "usd").toUpperCase(), plans };
}

function parseLtxPlans(raw) {
  const definitions = [
    ["lite", "Lite"],
    ["standard", "Standard"],
    ["pro", "Pro"]
  ];
  const plans = {};
  for (const [slug, name] of definitions) {
    const marker = `data-offer-quote-id="ltxstudio-${slug}-monthly-v4"`;
    const start = raw.indexOf(marker);
    if (start < 0) throw new Error(`Missing LTX ${name} monthly quote`);
    const block = raw.slice(start, start + 4_000);
    const monthly = Number(requireMatch(block.match(/>\$([\d.]+)<\/div>/)?.[1], `LTX ${name} monthly price`));
    const credits = Number(requireMatch(block.match(/([\d,]+)\s+cr(?:e|E)dits\/month/i)?.[1], `LTX ${name} monthly credits`).replaceAll(",", ""));
    plans[slug] = { name, monthly_usd: monthly, monthly_credits: credits };
  }
  return { currency: "USD", plans };
}

function parseFalSeedance(raw) {
  const text = stripTags(raw);
  const rate720 = Number(requireMatch(text.match(/720p with audio\s*~?\$([\d.]+)\s*\/\s*second/i)?.[1], "fal 720p rate"));
  const rate480 = Number(requireMatch(text.match(/480p with audio\s*~?\$([\d.]+)\s*\/\s*second/i)?.[1], "fal 480p rate"));
  const tokenRate = Number(requireMatch(text.match(/\$([\d.]+)\s+per\s+1000 tokens/i)?.[1], "fal token rate"));
  return apiBaseline(rate480, rate720, {
    billing_unit: "1000 tokens",
    usd_per_1000_tokens: tokenRate,
    pricing_basis: "approximate standard 16:9 output; native audio included"
  });
}

function parseReplicateSeedance(raw) {
  const text = normalizeEmbedded(raw);
  const start = text.indexOf('"current_tiers"');
  const end = text.indexOf(']}, "price":', start + 1);
  if (start < 0 || end < 0) throw new Error("Replicate current pricing tiers are absent");
  const block = text.slice(start, end);
  const tiers = {};

  for (const match of block.matchAll(/"criteria":\s*\[(.*?)\]\s*,\s*"description":.*?"prices":\s*\[(.*?)\]/gs)) {
    const criteria = match[1];
    const prices = match[2];
    const variant = criteria.match(/"value":\s*"(non_video_in|video_in)"/)?.[1];
    const resolution = criteria.match(/"value":\s*"(480p|720p)"/)?.[1];
    const price = prices.match(/"price":\s*"\$([\d.]+)"/)?.[1];
    if (variant && resolution && price) tiers[`${variant}_${resolution}`] = Number(price);
  }

  const rate480 = Number(requireMatch(tiers.non_video_in_480p, "Replicate non-video 480p rate"));
  const rate720 = Number(requireMatch(tiers.non_video_in_720p, "Replicate non-video 720p rate"));
  const video480 = Number(requireMatch(tiers.video_in_480p, "Replicate video-input 480p rate"));
  const video720 = Number(requireMatch(tiers.video_in_720p, "Replicate video-input 720p rate"));

  return apiBaseline(rate480, rate720, {
    pricing_basis: "non-video input; per output second",
    video_input_rates: {
      "480p": { usd_per_second: video480, usd_per_5s: roundMoney(video480 * 5) },
      "720p": { usd_per_second: video720, usd_per_5s: roundMoney(video720 * 5) }
    }
  });
}

function parseWaveSpeedSeedance(raw) {
  const text = stripTags(raw);
  const tableStart = text.indexOf("Per 5s");
  if (tableStart < 0) throw new Error("WaveSpeed five-second price table is absent");
  const block = text.slice(tableStart, tableStart + 800);
  const row480 = block.match(/480p\s+\$([\d.]+)\s+\$([\d.]+)/i);
  const row720 = block.match(/720p\s+\$([\d.]+)\s+\$([\d.]+)/i);
  const per5_480 = Number(requireMatch(row480?.[1], "WaveSpeed 480p five-second rate"));
  const perSecond480 = Number(requireMatch(row480?.[2], "WaveSpeed 480p per-second rate"));
  const per5_720 = Number(requireMatch(row720?.[1], "WaveSpeed 720p five-second rate"));
  const perSecond720 = Number(requireMatch(row720?.[2], "WaveSpeed 720p per-second rate"));
  return {
    model: "Seedance 2.5",
    availability: "live",
    currency: "USD",
    rates: {
      "480p": { usd_per_second: perSecond480, usd_per_5s: per5_480 },
      "720p": { usd_per_second: perSecond720, usd_per_5s: per5_720 }
    },
    pricing_basis: "standard text-to-video; published five-second table"
  };
}

function parsePiApiSeedance(raw) {
  const text = normalizeEmbedded(raw);
  const match = raw.match(/<td>seedance-2\.5<\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td>/i)
    ?? text.match(/\|\s*seedance-2\.5\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/i);
  const rate480 = Number(requireMatch(match?.[1], "PiAPI 480p rate"));
  const rate720 = Number(requireMatch(match?.[2], "PiAPI 720p rate"));
  return apiBaseline(rate480, rate720, {
    pricing_basis: "per output second; official live Seedance 2.5 docs"
  });
}

function parseKieSeedance(raw) {
  const text = normalizeEmbedded(raw);
  const row480 = text.match(/480P:\s*(\d+(?:\.\d+)?) credits\/s \(\$([\d.]+)\/s, with video\)\s*\|\s*(\d+(?:\.\d+)?) credits\/s \(\$([\d.]+)\/s, no video\)/i);
  const row720 = text.match(/720P:\s*(\d+(?:\.\d+)?) credits\/s \(\$([\d.]+)\/s, with video\)\s*\|\s*(\d+(?:\.\d+)?) credits\/s \(\$([\d.]+)\/s, no video\)/i);
  const creditsPerUsd = Number(requireMatch(text.match(/1 USD = ([\d.]+) Credits/i)?.[1], "Kie credits per USD"));

  const with480Credits = Number(requireMatch(row480?.[1], "Kie with-video 480p credits"));
  const with480Usd = Number(requireMatch(row480?.[2], "Kie with-video 480p USD rate"));
  const noVideo480Credits = Number(requireMatch(row480?.[3], "Kie no-video 480p credits"));
  const noVideo480Usd = Number(requireMatch(row480?.[4], "Kie no-video 480p USD rate"));
  const with720Credits = Number(requireMatch(row720?.[1], "Kie with-video 720p credits"));
  const with720Usd = Number(requireMatch(row720?.[2], "Kie with-video 720p USD rate"));
  const noVideo720Credits = Number(requireMatch(row720?.[3], "Kie no-video 720p credits"));
  const noVideo720Usd = Number(requireMatch(row720?.[4], "Kie no-video 720p USD rate"));

  return {
    ...apiBaseline(noVideo480Usd, noVideo720Usd),
    pricing_basis: "no video input; public beta list price",
    credits_per_usd: creditsPerUsd,
    rates: {
      "480p": { credits_per_second: noVideo480Credits, usd_per_second: noVideo480Usd, usd_per_5s: roundMoney(noVideo480Usd * 5) },
      "720p": { credits_per_second: noVideo720Credits, usd_per_second: noVideo720Usd, usd_per_5s: roundMoney(noVideo720Usd * 5) }
    },
    with_video_rates: {
      "480p": { credits_per_second: with480Credits, usd_per_second: with480Usd, usd_per_5s: roundMoney(with480Usd * 5) },
      "720p": { credits_per_second: with720Credits, usd_per_second: with720Usd, usd_per_5s: roundMoney(with720Usd * 5) }
    }
  };
}

function findRunwareExample(block, resolution) {
  const config = `Text/Image to Video · ${resolution} · 1s`;
  const escaped = config.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forward = block.match(new RegExp(`"configuration":"${escaped}","price":"\\$+([\\d.]+)"`));
  const reverse = block.match(new RegExp(`"price":"\\$+([\\d.]+)","configuration":"${escaped}"`));
  return forward?.[1] ?? reverse?.[1];
}

function parseRunwareSeedance(raw) {
  const text = normalizeEmbedded(raw);
  const start = text.indexOf('"model":"bytedance-seedance-2-5"');
  const end = text.indexOf('"model":', start + 20);
  if (start < 0) throw new Error("Runware Seedance 2.5 catalog entry is absent");
  const block = text.slice(start, end > start ? end : start + 2_000);
  const rate480 = Number(requireMatch(findRunwareExample(block, "480p"), "Runware 480p example"));
  const rate720 = Number(requireMatch(findRunwareExample(block, "720p"), "Runware 720p example"));
  return apiBaseline(rate480, rate720, {
    pricing_basis: "text/image-to-video; official one-second examples"
  });
}

function parseAtlasSeedance(raw) {
  const [page, schemaText = ""] = raw.split("\n\n--- SOURCE BOUNDARY ---\n\n");
  const text = normalizeEmbedded(page);
  const price = Number(requireMatch(
    text.match(/Your request will cost\s*<strong>\$([\d.]+)<\/strong>\s*per run/i)?.[1]
      ?? text.match(/<meta name="pricing" content="([\d.]+)"/i)?.[1],
    "Atlas default-run price"
  ));
  const duration = Number(requireMatch(schemaText.match(/"duration"\s*:\s*\{[\s\S]{0,180}?"default"\s*:\s*(\d+)/)?.[1], "Atlas default duration"));
  const resolution = requireMatch(schemaText.match(/"resolution"\s*:\s*\{[\s\S]{0,180}?"default"\s*:\s*"([^"]+)"/)?.[1], "Atlas default resolution");
  if (duration !== 5 || resolution !== "720p") {
    throw new Error(`Atlas default changed to ${duration}s / ${resolution}; benchmark mapping requires review`);
  }
  return {
    model: "Seedance 2.5",
    availability: "live",
    currency: "USD",
    rates: { "720p": { usd_per_5s: price } },
    default_run: { usd: price, duration_seconds: duration, resolution },
    pricing_basis: "official page price at the official schema's default 5s / 720p configuration"
  };
}

function getPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function sha256(raw) {
  return `sha256-${createHash("sha256").update(raw).digest("hex")}`;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone(value) {
  return structuredClone(value);
}

function validateCandidate(definition, candidate, previousValues) {
  const issues = [];
  for (const path of definition.monitored) {
    const current = getPath(candidate, path);
    if (!Number.isFinite(current) || current <= 0) {
      issues.push({ type: "invalid_value", path, value: current ?? null, message: "Monitored prices and credits must be greater than zero." });
      continue;
    }
    const previous = getPath(previousValues, path);
    if (Number.isFinite(previous) && previous > 0) {
      const relativeShift = Math.abs(current - previous) / previous;
      if (relativeShift > MAX_SHIFT) {
        issues.push({
          type: "large_shift",
          path,
          previous,
          candidate: current,
          shift_percent: Number((relativeShift * 100).toFixed(2)),
          message: `Change exceeds the ${MAX_SHIFT * 100}% automatic-acceptance limit.`
        });
      }
    }
    const curatedBaseline = getPath(definition.baseline, path);
    if (Number.isFinite(curatedBaseline) && curatedBaseline > 0) {
      const cumulativeShift = Math.abs(current - curatedBaseline) / curatedBaseline;
      if (cumulativeShift > MAX_SHIFT) {
        issues.push({
          type: "large_cumulative_shift",
          path,
          curated_baseline: curatedBaseline,
          candidate: current,
          shift_percent: Number((cumulativeShift * 100).toFixed(2)),
          message: `Cumulative change exceeds the ${MAX_SHIFT * 100}% curated-baseline limit.`
        });
      }
    }
  }
  return issues;
}

async function readResponseText(response, sourceUrl, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel("response size limit exceeded");
        throw new Error(`Oversized response from ${sourceUrl}`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

async function fetchUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let current = validateSourceUrl(url);
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "text/html,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.8",
          "user-agent": "FrameFivePricingMonitor/1.0"
        }
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === MAX_REDIRECTS) throw new Error(`Unsafe or excessive redirect from ${current.href}`);
        current = validateSourceUrl(new URL(location, current).href);
        continue;
      }
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength > MAX_RESPONSE_BYTES) throw new Error(`Oversized response from ${current.href}`);
      const body = await readResponseText(response, current.href);
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${current.href}`);
      if (body.length < 40) throw new Error(`Unexpectedly short response from ${current.href}`);
      return { url: current.href, status: response.status, body };
    }
    throw new Error(`Redirect limit reached for ${url}`);
  } finally {
    clearTimeout(timer);
  }
}

function validateSourceUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !ALLOWED_SOURCE_HOSTS.has(parsed.hostname)) {
    throw new Error(`Source URL is outside the approved HTTPS host list: ${parsed.origin}`);
  }
  return parsed;
}

async function fetchDefinition(definition) {
  const urls = [definition.source, ...(definition.supporting_sources ?? [])];
  const responses = await Promise.all(urls.map(fetchUrl));
  return {
    raw: responses.map((item) => item.body).join("\n\n--- SOURCE BOUNDARY ---\n\n"),
    httpStatus: responses.length === 1
      ? responses[0].status
      : Object.fromEntries(responses.map((item) => [item.url, item.status]))
  };
}

function baselineRecord(definition) {
  const values = clone(definition.baseline);
  return {
    id: definition.id,
    provider: definition.provider,
    kind: definition.kind,
    source: definition.source,
    supporting_sources: definition.supporting_sources ?? [],
    parser: definition.parser,
    checked_at: CURATED_BASELINE_AT,
    fetched_at: CURATED_BASELINE_AT,
    status: "curated_baseline",
    http_status: null,
    raw_sha256: null,
    changed_at: CURATED_BASELINE_AT,
    values,
    last_good: { accepted_at: CURATED_BASELINE_AT, raw_sha256: null, values: clone(values) },
    candidate: null,
    issues: []
  };
}

async function refreshSource(definition, priorRecord, now) {
  const previous = priorRecord ?? baselineRecord(definition);
  const previousValues = previous.last_good?.values ?? previous.values ?? definition.baseline;
  let fetched;
  try {
    fetched = await fetchDefinition(definition);
  } catch (error) {
    return {
      ...previous,
      id: definition.id,
      provider: definition.provider,
      kind: definition.kind,
      source: definition.source,
      supporting_sources: definition.supporting_sources ?? [],
      parser: definition.parser,
      checked_at: now,
      status: "stale",
      values: clone(previousValues),
      candidate: null,
      issues: [{ type: "fetch_error", message: formatError(error) }]
    };
  }

  const rawHash = sha256(fetched.raw);
  let candidate;
  try {
    candidate = definition.parse(fetched.raw);
  } catch (error) {
    return {
      ...previous,
      id: definition.id,
      provider: definition.provider,
      kind: definition.kind,
      source: definition.source,
      supporting_sources: definition.supporting_sources ?? [],
      parser: definition.parser,
      checked_at: now,
      fetched_at: now,
      status: "stale",
      http_status: fetched.httpStatus,
      raw_sha256: rawHash,
      values: clone(previousValues),
      candidate: null,
      issues: [{ type: "parser_error", message: formatError(error) }]
    };
  }

  const issues = validateCandidate(definition, candidate, previousValues);
  if (issues.length) {
    return {
      ...previous,
      id: definition.id,
      provider: definition.provider,
      kind: definition.kind,
      source: definition.source,
      supporting_sources: definition.supporting_sources ?? [],
      parser: definition.parser,
      checked_at: now,
      fetched_at: now,
      status: "needs_review",
      http_status: fetched.httpStatus,
      raw_sha256: rawHash,
      values: clone(previousValues),
      candidate: { fetched_at: now, raw_sha256: rawHash, values: candidate },
      issues
    };
  }

  const changed = !deepEqual(candidate, previousValues);
  return {
    id: definition.id,
    provider: definition.provider,
    kind: definition.kind,
    source: definition.source,
    supporting_sources: definition.supporting_sources ?? [],
    parser: definition.parser,
    checked_at: now,
    fetched_at: now,
    status: "ok",
    http_status: fetched.httpStatus,
    raw_sha256: rawHash,
    changed_at: changed ? now : (previous.changed_at ?? previous.last_good?.accepted_at ?? now),
    values: candidate,
    last_good: { accepted_at: now, raw_sha256: rawHash, values: clone(candidate) },
    candidate: null,
    issues: []
  };
}

function formatError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(JSON_PATH, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Unable to read existing pricing snapshot: ${formatError(error)}`);
  }
}

function buildSummary(sources) {
  const counts = { ok: 0, needs_review: 0, stale: 0, curated_baseline: 0 };
  for (const source of Object.values(sources)) {
    counts[source.status] = (counts[source.status] ?? 0) + 1;
  }
  return {
    source_count: Object.keys(sources).length,
    ...counts,
    healthy: counts.needs_review === 0 && counts.stale === 0
  };
}

function buildChecks(sources) {
  return SOURCE_DEFINITIONS.map((definition) => {
    const source = sources[definition.id];
    const acceptedAt = source.last_good?.accepted_at ?? source.fetched_at;
    const defaultMessage = source.status === "ok"
      ? "Latest official-source values parsed, validated, and accepted."
      : source.status === "needs_review"
        ? "A candidate update was held because it exceeded the automatic validation threshold."
        : "The latest check retained the last accepted values.";
    return {
      id: source.id,
      name: source.provider,
      kind: source.kind,
      source: source.source,
      status: source.status,
      fetched_at: source.fetched_at,
      accepted_at: acceptedAt,
      parser: source.parser,
      hash: source.raw_sha256,
      message: source.issues?.[0]?.message ?? defaultMessage
    };
  });
}

function normalizeHiggsfieldPlans(plans) {
  return Object.fromEntries(Object.entries(plans).map(([id, plan]) => [id, {
    ...plan,
    monthly_usd: plan.monthly_list_usd,
    promotional_monthly_usd: plan.current_checkout_usd,
    renewal_monthly_usd: plan.renewal_usd
  }]));
}

function apiProviderUpdate(source) {
  const values = source.values;
  const ratesFiveSeconds = {};
  const ratesPerSecond = {};
  for (const [resolution, rate] of Object.entries(values.rates ?? {})) {
    if (Number.isFinite(rate.usd_per_5s)) ratesFiveSeconds[resolution] = rate.usd_per_5s;
    if (Number.isFinite(rate.usd_per_second)) ratesPerSecond[resolution] = rate.usd_per_second;
  }
  return {
    ...values,
    rates_5s: ratesFiveSeconds,
    rates_per_second: ratesPerSecond,
    source_status: source.status,
    accepted_at: source.last_good?.accepted_at ?? source.fetched_at
  };
}

function buildUiUpdates(sources) {
  const runwayPlans = sources["runway-plans"];
  const runwayRates = sources["runway-seedance-2-5"];
  const higgsfield = sources["higgsfield-plans"];
  const ltx = sources["ltx-studio-plans"];

  return {
    subscription_platforms: {
      runway: {
        plans: runwayPlans.values.plans,
        rates: runwayRates.values.rates,
        promotions: runwayPlans.values.promotions ?? [],
        accepted_at: [runwayPlans.last_good?.accepted_at, runwayRates.last_good?.accepted_at].filter(Boolean).sort().at(0) ?? null,
        source_status: runwayPlans.status === "ok" && runwayRates.status === "ok" ? "ok" : "last_known_good"
      },
      higgsfield: {
        plans: normalizeHiggsfieldPlans(higgsfield.values.plans),
        accepted_at: higgsfield.last_good?.accepted_at ?? higgsfield.fetched_at,
        source_status: higgsfield.status === "ok" ? "ok" : "last_known_good"
      },
      ltx: {
        plans: ltx.values.plans,
        accepted_at: ltx.last_good?.accepted_at ?? ltx.fetched_at,
        source_status: ltx.status === "ok" ? "ok" : "last_known_good"
      }
    },
    api_providers: {
      fal: apiProviderUpdate(sources["fal-seedance-2-5"]),
      replicate: apiProviderUpdate(sources["replicate-seedance-2-5"]),
      wavespeed: apiProviderUpdate(sources["wavespeed-seedance-2-5"]),
      piapi: apiProviderUpdate(sources["piapi-seedance-2-5"]),
      kie: apiProviderUpdate(sources["kie-seedance-2-5"]),
      runware: apiProviderUpdate(sources["runware-seedance-2-5"]),
      atlas: apiProviderUpdate(sources["atlas-seedance-2-5"])
    }
  };
}

function overallStatus(summary) {
  if (summary.needs_review > 0) return "attention";
  if (summary.stale > 0) return "degraded";
  return "ok";
}

function serializeJs(data) {
  return `/* Generated by scripts/refresh-pricing.mjs. Edit the curated baseline or updater instead. */\nwindow.LIVE_PRICING = ${JSON.stringify(data, null, 2)};\n`;
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

async function writeSnapshot(snapshot) {
  await mkdir(DATA_DIR, { recursive: true });
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  await atomicWrite(JSON_PATH, json);
  await atomicWrite(JS_PATH, serializeJs(snapshot));
}

function validateSnapshot(snapshot) {
  const errors = [];
  if (snapshot?.schema_version !== "2.0") errors.push("schema_version must be 2.0");
  if (!snapshot?.generated_at || Number.isNaN(Date.parse(snapshot.generated_at))) errors.push("generated_at must be an ISO date");
  if (!Number.isFinite(snapshot?.refresh_interval) || snapshot.refresh_interval <= 0) errors.push("refresh_interval must be greater than zero");
  if (!snapshot?.status) errors.push("status is required");
  if (!Array.isArray(snapshot?.checks)) errors.push("checks must be an array");
  if (!snapshot?.updates?.subscription_platforms || !snapshot?.updates?.api_providers) errors.push("updates must include subscription_platforms and api_providers");
  if (!snapshot?.sources || typeof snapshot.sources !== "object") errors.push("sources must be an object");

  for (const definition of SOURCE_DEFINITIONS) {
    const source = snapshot?.sources?.[definition.id];
    if (!source) {
      errors.push(`missing source ${definition.id}`);
      continue;
    }
    for (const field of ["fetched_at", "source", "parser", "status"]) {
      if (source[field] === undefined || source[field] === "") errors.push(`${definition.id}.${field} is required`);
    }
    if (!source.last_good?.values) errors.push(`${definition.id}.last_good.values is required`);
    if (!deepEqual(source.values, source.last_good?.values)) errors.push(`${definition.id}.values must equal its last accepted values`);
    const valueIssues = validateCandidate(definition, source.values, source.values).filter((issue) => issue.type === "invalid_value");
    errors.push(...valueIssues.map((issue) => `${definition.id}.${issue.path} must be greater than zero`));
    if (source.status === "needs_review" && !source.candidate) errors.push(`${definition.id}.candidate is required when review is needed`);
  }
  return errors;
}

async function validateFiles() {
  const jsonText = await readFile(JSON_PATH, "utf8");
  const snapshot = JSON.parse(jsonText);
  const errors = validateSnapshot(snapshot);
  const jsText = await readFile(JS_PATH, "utf8");
  if (jsText !== serializeJs(snapshot)) errors.push("live-pricing.js is not synchronized with live-pricing.json");
  if (errors.length) throw new Error(`Snapshot validation failed:\n- ${errors.join("\n- ")}`);
  console.log(`Validated ${snapshot.summary.source_count} pricing sources.`);
}

async function runSelfTest() {
  const definition = { monitored: ["value"], baseline: { value: 1 } };
  const invalid = validateCandidate(definition, { value: 0 }, { value: 1 });
  const boundary = validateCandidate(definition, { value: 1.25 }, { value: 1 });
  const outlier = validateCandidate(definition, { value: 1.251 }, { value: 1 });
  const cumulative = validateCandidate(definition, { value: 1.2 }, { value: 1.1 });
  const cumulativeOutlier = validateCandidate(definition, { value: 1.26 }, { value: 1.2 });
  const withinBody = await readResponseText(new Response("safe"), "https://example.invalid", 4);
  let oversizedBodyRejected = false;
  try {
    await readResponseText(new Response("unsafe"), "https://example.invalid", 4);
  } catch (error) {
    oversizedBodyRejected = /Oversized response/.test(formatError(error));
  }
  if (
    invalid[0]?.type !== "invalid_value" ||
    boundary.length !== 0 ||
    outlier[0]?.type !== "large_shift" ||
    cumulative.length !== 0 ||
    cumulativeOutlier.some((issue) => issue.type === "large_cumulative_shift") === false ||
    withinBody !== "safe" ||
    !oversizedBodyRejected
  ) {
    throw new Error("Validation guard self-test failed");
  }
  console.log("Validation and response-limit self-tests passed.");
}

async function main() {
  if (SELF_TEST) {
    await runSelfTest();
    return;
  }
  if (VALIDATE_ONLY) {
    await validateFiles();
    return;
  }

  const previous = RESET_BASELINE ? null : await readPrevious();
  const now = new Date().toISOString();
  const results = await Promise.all(
    SOURCE_DEFINITIONS.map((definition) => refreshSource(definition, previous?.sources?.[definition.id], now))
  );
  const sources = Object.fromEntries(results.map((source) => [source.id, source]));
  const summary = buildSummary(sources);
  const snapshot = {
    schema_version: "2.0",
    generated_at: now,
    refresh_interval: 60,
    status: overallStatus(summary),
    currency: "USD",
    benchmark: {
      model: "Seedance 2.5",
      duration_seconds: 5,
      default_resolution: "720p",
      input_mode: "text-or-image-to-video",
      promotion_policy: "Base comparisons use regular list pricing; promotions remain separately labeled."
    },
    refresh: {
      cadence_minutes: 60,
      strategy: "official-source polling with last-known-good fallback",
      max_automatic_shift_percent: MAX_SHIFT * 100,
      note: "Provider pages do not expose universal pricing webhooks. This snapshot is refreshed hourly and can also be refreshed manually."
    },
    source_order: SOURCE_DEFINITIONS.map((definition) => definition.id),
    summary,
    checks: buildChecks(sources),
    updates: buildUiUpdates(sources),
    sources
  };

  const validationErrors = validateSnapshot(snapshot);
  if (validationErrors.length) throw new Error(`Refusing to write invalid snapshot:\n- ${validationErrors.join("\n- ")}`);

  for (const source of results) {
    const issue = source.issues?.[0]?.message;
    console.log(`${source.status.padEnd(13)} ${source.id}${issue ? ` — ${issue}` : ""}`);
  }
  console.log(JSON.stringify(snapshot.summary));

  if (DRY_RUN) {
    console.log("Dry run complete; no files written.");
    return;
  }
  await writeSnapshot(snapshot);
  console.log(`Wrote ${JSON_PATH}`);
  console.log(`Wrote ${JS_PATH}`);
}

await main();
