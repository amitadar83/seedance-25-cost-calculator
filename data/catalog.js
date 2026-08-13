(function loadCatalog() {
  "use strict";

  const scriptUrl = document.currentScript && document.currentScript.src
    ? document.currentScript.src
    : window.location.href;
  const catalogUrl = new URL("catalog.json", scriptUrl);

  const platformAccents = {
    weave: "#6b5cff",
    runway: "#ee6043",
    higgsfield: "#0c9d8f",
    openart: "#e54882",
    imagineart: "#d98817",
    astorie: "#3d78c5",
    dreamina: "#00a88f",
    kling: "#ff4f72",
    "ltx-studio": "#8a63e6"
  };

  const apiAccents = {
    runware: "#5f70ff",
    replicate: "#111111",
    "atlas-cloud": "#3d78c5",
    "kie-ai": "#e4732b",
    piapi: "#7756d8",
    "wavespeed-ai": "#07a79a",
    fal: "#e54882"
  };

  function nativeBenchmark(platform) {
    const rows = platform.native_model_rates || [];
    if (!rows.length) return null;

    const preferred = rows.find((row) => row.resolution === "720p" && row.native_audio === true)
      || rows.find((row) => row.channel === "LTX Studio hosted")
      || rows[0];

    return {
      model: preferred.model,
      resolution: preferred.resolution || preferred.channel || "Provider default",
      credits_5s: preferred.credits_per_5s == null ? null : preferred.credits_per_5s,
      usd_5s: preferred.usd_per_5s == null ? null : preferred.usd_per_5s,
      note: preferred.caveat || (preferred.native_audio ? "Native audio included." : "See provider settings and source.")
    };
  }

  function normalizePlatform(platform) {
    const seedance = platform.seedance_2_5 || {};
    return {
      ...platform,
      short_name: platform.aliases && platform.aliases.length ? platform.aliases[0] : platform.name,
      accent: platformAccents[platform.id] || "#65758b",
      seedance_25_access: seedance.availability || "unknown",
      rates: seedance.rates || {},
      native_benchmark: nativeBenchmark(platform),
      access_note: seedance.caveat || "",
      rate_note: seedance.caveat || "",
      plans: (platform.plans || []).map((plan) => ({
        ...plan,
        monthly_usd: plan.monthly_list_usd,
        monthly_credits: plan.included_monthly_credits,
        commercial_rights: plan.commercial_rights ? plan.commercial_rights.status : "not_publicly_specified",
        commercial_rights_note: plan.commercial_rights ? plan.commercial_rights.detail : "",
        rollover: plan.rollover ? plan.rollover.status : "not_publicly_specified",
        rollover_note: plan.rollover ? plan.rollover.detail : ""
      }))
    };
  }

  function fiveSecondRate(provider, resolution) {
    const row = provider.rates && provider.rates[resolution];
    return row && typeof row.usd_per_5s === "number" ? row.usd_per_5s : null;
  }

  function normalizeApiProvider(provider) {
    const unresolved = provider.rates && provider.rates.unspecified_native_resolution;
    return {
      ...provider,
      accent: apiAccents[provider.id] || "#65758b",
      status: provider.availability,
      rates_5s: {
        "480p": fiveSecondRate(provider, "480p"),
        "720p": fiveSecondRate(provider, "720p"),
        unresolved: unresolved && typeof unresolved.usd_per_5s === "number" ? unresolved.usd_per_5s : null
      },
      rate_note: [
        provider.formula || "",
        unresolved && unresolved.caveat ? unresolved.caveat : "",
        provider.reference_video && provider.reference_video.billing_note
          ? provider.reference_video.billing_note
          : ""
      ].filter(Boolean).join(" ")
    };
  }

  function promotionOverlay(promotion) {
    const value = promotion.value || {};
    if (promotion.kind === "model_credit_discount" && typeof value.percent_off === "number") {
      return {
        type: "credit_rate_multiplier",
        multiplier: 1 - value.percent_off / 100,
        label: `${value.percent_off}% model-credit discount`
      };
    }
    return null;
  }

  function normalizePromotion(promotion) {
    return {
      ...promotion,
      platform: promotion.platform_id,
      terms: [promotion.eligibility, promotion.caveat].filter(Boolean).join(" "),
      exact_overlay: promotionOverlay(promotion)
    };
  }

  function normalizeSentiment(sentiment) {
    return {
      ...sentiment,
      overall: sentiment.overall || sentiment.label,
      evidence: sentiment.evidence || sentiment.evidence_summary,
      caveat: sentiment.caveat || (sentiment.caveats || []).join(" ")
    };
  }

  function normalizeCatalog(raw) {
    const catalog = {
      ...raw,
      subscription_platforms: (raw.subscription_platforms || []).map(normalizePlatform),
      api_providers: (raw.api_providers || []).map(normalizeApiProvider),
      promotions: (raw.promotions || []).map(normalizePromotion),
      sentiments: (raw.sentiments || raw.sentiment || []).map(normalizeSentiment)
    };
    delete catalog.sentiment;
    return catalog;
  }

  window.CATALOG = null;
  window.CATALOG_ERROR = null;
  window.CATALOG_READY = fetch(catalogUrl, { cache: "no-cache" })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Catalog request failed with HTTP ${response.status}`);
      }
      return response.json();
    })
    .then((raw) => {
      window.CATALOG = normalizeCatalog(raw);
      return window.CATALOG;
    })
    .catch((error) => {
      window.CATALOG_ERROR = error;
      throw error;
    });
}());
