(() => {
  "use strict";

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compactMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const timeFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const routes = new Set(["overview", "plans", "apis", "sentiment", "deals", "method"]);

  const state = {
    catalog: null,
    live: null,
    resolution: "720p",
    planMode: "entry",
    target: 20,
    promos: false,
    selections: {},
    apiResolution: "720p",
    apiVolume: 100,
    sentimentFilter: "all",
    dealFilter: "all"
  };

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const safe = value => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function safeHref(value, fallback = "#method") {
    const raw = String(value ?? "").trim();
    if (/^#[a-z0-9_-]+$/i.test(raw)) return raw;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return safe(parsed.href);
    } catch {
      // Invalid or relative external links fall through to the local method page.
    }
    return fallback;
  }

  function safeColor(value, fallback) {
    const color = String(value ?? "").trim();
    return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color) ? color : fallback;
  }

  function getList(keys, fallback = []) {
    for (const key of keys) {
      const value = state.catalog?.[key];
      if (Array.isArray(value)) return value;
    }
    return fallback;
  }

  function platforms() {
    return getList(["subscription_platforms", "platforms"]);
  }

  function apis() {
    return getList(["api_providers", "api_endpoints", "apis"]);
  }

  function promotions() {
    return getList(["promotions", "deals"]);
  }

  function sentiments() {
    return getList(["sentiments", "sentiment"]);
  }

  function slug(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function humanize(value) {
    return String(value || "").replaceAll("_", " ").replaceAll("-", " ");
  }

  function valueAt(obj, ...paths) {
    for (const path of paths) {
      const bits = path.split(".");
      let current = obj;
      for (const bit of bits) current = current?.[bit];
      if (current !== undefined && current !== null) return current;
    }
    return undefined;
  }

  function planPrice(plan) {
    return Number(valueAt(plan, "monthly_usd", "monthly_list_usd", "price_monthly_usd", "price") || 0);
  }

  function planCredits(plan) {
    return Number(valueAt(plan, "monthly_credits", "included_monthly_credits", "credits", "included_credits") || 0);
  }

  function rateFor(platform, resolution = state.resolution) {
    const rate = platform?.rates?.[resolution] || platform?.rates_5s?.[resolution] || platform?.seedance_2_5?.rates?.[resolution] || null;
    if (!rate && platform?.rates?.[`${resolution}_5s`] != null) return { normalized_credits_5s: Number(platform.rates[`${resolution}_5s`]), billable_credits: Number(platform.rates[`${resolution}_5s`]), billable_seconds: 5 };
    if (typeof rate === "number") return { normalized_credits_5s: rate, billable_credits: rate, billable_seconds: 5 };
    return rate;
  }

  function normalizedCredits(rate) {
    return Number(valueAt(rate, "normalized_credits_5s", "credits_per_5s", "credits_5s", "credits") || 0);
  }

  function billedCredits(rate) {
    return Number(valueAt(rate, "billable_credits", "credits_per_5s", "credits_5s", "credits", "normalized_credits_5s") || 0);
  }

  function billedSeconds(rate) {
    return Number(valueAt(rate, "billable_seconds", "seconds") || 5);
  }

  function costFor(platform, plan, resolution = state.resolution, applyPromo = state.promos) {
    const rate = rateFor(platform, resolution);
    const price = planPrice(plan);
    const credits = planCredits(plan);
    if (!rate || !price || !credits || !normalizedCredits(rate)) return null;
    const base = price / credits * normalizedCredits(rate);
    const billed = price / credits * billedCredits(rate);
    const overlay = applyPromo ? exactPromoFor(platform.id, plan.id, resolution) : null;
    if (overlay?.type === "credit_rate_multiplier") {
      return { base, comparable: base * overlay.multiplier, billed: billed * overlay.multiplier, overlay };
    }
    if (overlay?.type === "plan_price_multiplier") {
      return { base, comparable: base * overlay.multiplier, billed: billed * overlay.multiplier, overlay };
    }
    if (overlay?.type === "unlimited") {
      return { base, comparable: 0, billed: 0, overlay };
    }
    return { base, comparable: base, billed, overlay: null };
  }

  function exactPromoFor(platformId, planId, resolution) {
    const active = promotions().filter(deal => deal.platform_id === platformId && normalizeDealStatus(deal) !== "expired");
    for (const deal of active) {
      const overlay = deal.exact_overlay || deal.calculator_overlay;
      if (!overlay) continue;
      if (overlay.plan_ids?.length && !overlay.plan_ids.includes(planId)) continue;
      if (overlay.resolutions?.length && !overlay.resolutions.includes(resolution)) continue;
      return overlay;
    }
    return null;
  }

  function eligibleSeedance(platform) {
    const access = valueAt(platform, "seedance_25_access", "seedance_access", "supports_seedance_25", "seedance_2_5.availability");
    if (access === true || /^(available|live|early)/.test(String(access))) return true;
    return Boolean(rateFor(platform, "720p") || rateFor(platform, "480p"));
  }

  function defaultPlan(platform) {
    const plans = platform.plans || [];
    const defaultId = platform.default_plan || platform.default_plan_id;
    return plans.find(plan => plan.id === defaultId) || plans.find(plan => planPrice(plan) > 0 && planCredits(plan) > 0) || plans[0];
  }

  function bestPlan(platform, resolution = state.resolution) {
    const choices = (platform.plans || []).filter(plan => costFor(platform, plan, resolution, false));
    return choices.sort((a, b) => costFor(platform, a, resolution, false).base - costFor(platform, b, resolution, false).base)[0] || defaultPlan(platform);
  }

  function selectedPlan(platform) {
    const plans = platform.plans || [];
    if (!state.selections[platform.id]) {
      const chosen = state.planMode === "value" ? bestPlan(platform) : defaultPlan(platform);
      state.selections[platform.id] = chosen?.id;
    }
    return plans.find(plan => plan.id === state.selections[platform.id]) || defaultPlan(platform);
  }

  function seedancePlatforms() {
    return platforms().filter(platform => eligibleSeedance(platform) && rateFor(platform, state.resolution) && (platform.plans || []).some(plan => planPrice(plan) && planCredits(plan)));
  }

  function apiRate(api, resolution = state.apiResolution) {
    const raw = valueAt(api, `rates_5s.${resolution}`, `rates.${resolution}.cost_5s_usd`, `rates.${resolution}.usd_per_5s`, `rates.${resolution}.usd_5s`, `rates.${resolution}`, `${resolution}_5s_usd`);
    if (raw && typeof raw === "object") return Number(valueAt(raw, "usd_5s", "cost_5s_usd", "price", "value") || 0) || null;
    return Number(raw) || null;
  }

  function sourceArray(item) {
    const sources = item?.sources || (item?.source ? [item.source] : []);
    return sources.map((source, index) => typeof source === "string" ? { label: `Source ${index + 1}`, url: source } : source).filter(source => source?.url);
  }

  function firstSource(item) {
    return sourceArray(item)[0]?.url || "#method";
  }

  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  function route() {
    const name = location.hash.replace(/^#/, "") || "overview";
    return routes.has(name) ? name : "overview";
  }

  function renderRoute() {
    const active = route();
    $$("[data-route]").forEach(view => {
      const visible = view.dataset.route === active;
      view.hidden = !visible;
      view.classList.toggle("route-enter", visible);
    });
    $$("[data-route-link]").forEach(link => {
      if (link.dataset.routeLink === active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    document.title = `${active === "overview" ? "Frame / Five" : active[0].toUpperCase() + active.slice(1) + " — Frame / Five"}`;
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  function renderOverview() {
    const eligible = seedancePlatforms();
    const rows = eligible.map(platform => {
      const plan = selectedPlan(platform);
      const cost = costFor(platform, plan);
      const rate = rateFor(platform);
      const capacity = Math.floor(planCredits(plan) / billedCredits(rate));
      return { platform, plan, cost, rate, capacity };
    }).filter(row => row.cost).sort((a, b) => a.cost.comparable - b.cost.comparable);

    const values = rows.map(row => row.cost.comparable).sort((a, b) => a - b);
    const median = values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2 : 0;
    const winner = rows[0];
    const coverage = rows.filter(row => row.capacity >= state.target).length;
    const maxCost = Math.max(...values, 1);

    $("#scoreboard").innerHTML = `
      <div class="score-item"><span>Lowest comparable cost</span><strong>${winner ? money.format(winner.cost.comparable) : "—"}</strong><small>${winner ? safe(winner.platform.name) + " · " + safe(winner.plan.name) : "No comparable data"}</small></div>
      <div class="score-item"><span>Median / 5s</span><strong>${values.length ? money.format(median) : "—"}</strong><small>${safe(state.resolution)} · ${state.promos ? "deal overlay" : "list price"}</small></div>
      <div class="score-item"><span>Target coverage</span><strong>${coverage} / ${rows.length}</strong><small>plans reaching ${integer.format(state.target)} clips</small></div>`;

    $("#subscriptionComparison").innerHTML = rows.map((row, index) => {
      const { platform, plan, cost, rate, capacity } = row;
      const billedDuration = billedSeconds(rate);
      const billedLabel = billedDuration !== 5 ? `${money.format(cost.billed)} / ${billedDuration}s billed` : `${number.format(billedCredits(rate))} credits / 5s`;
      const pricing = cost.overlay ? `<span class="base-struck">${money.format(cost.base)}</span><span class="deal-price">${cost.overlay.type === "unlimited" ? "$0 eligible" : money.format(cost.comparable)}</span>` : money.format(cost.comparable);
      const options = (platform.plans || []).filter(p => planPrice(p) && planCredits(p)).map(p => `<option value="${safe(p.id)}" ${p.id === plan.id ? "selected" : ""}>${safe(p.name)} · ${money.format(planPrice(p))} / ${integer.format(planCredits(p))}</option>`).join("");
      const note = platform.rate_note || platform.access_note || "Official monthly allocation and model rate.";
      return `<article class="provider-row" data-platform="${safe(platform.id)}" style="--provider:${safeColor(platform.accent, "#2d5fff")}">
        <div class="provider-identity"><span class="rank-number">${String(index + 1).padStart(2, "0")}</span><div><strong class="provider-name">${safe(platform.name)}</strong><span class="provider-type">${safe(humanize(platform.category || "model aggregator"))}</span></div></div>
        <div class="provider-plan"><label for="plan-${safe(platform.id)}">Monthly plan</label><select id="plan-${safe(platform.id)}" data-plan-select="${safe(platform.id)}">${options}</select></div>
        <div class="cost-visual"><div class="cost-header"><strong>${pricing}</strong><span>comparable / 5s</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(3, cost.comparable / maxCost * 100)}%"></div></div><div class="cost-subline"><span>${billedLabel}</span><span>${number.format(normalizedCredits(rate))} normalized credits</span></div></div>
        <div class="coverage-cell"><strong class="${capacity < state.target ? "shortfall" : ""}">${integer.format(capacity)}</strong><span>whole runs / month</span></div>
        <div class="row-note"><span class="confidence">${safe(platform.confidence || "verified")}</span><span>${safe(note)}</span></div>
      </article>`;
    }).join("");

    $$('[data-plan-select]').forEach(select => select.addEventListener("change", event => {
      state.selections[event.currentTarget.dataset.planSelect] = event.currentTarget.value;
      state.planMode = "manual";
      $("#entryMode").checked = false;
      $("#valueMode").checked = false;
      renderOverview();
    }));

    $("#targetOutput").textContent = integer.format(state.target);
    $("#baselineNote").textContent = state.promos
      ? "Verified deal math is layered onto eligible rows. Offers without exact comparable math remain on the Deals page."
      : "Monthly sticker prices are active. Annual billing and promotions remain outside the base ranking.";
    renderNative();
  }

  function renderNative() {
    const nativeCards = [];
    const kling = platforms().find(p => p.id === "kling" || /kling/i.test(p.name));
    if (kling) {
      const plan = state.planMode === "value" ? bestNativePlan(kling) : defaultPlan(kling);
      const native = kling.native_benchmark || {};
      const credits = Number(valueAt(native, "credits_5s", "720p.credits_5s") || 45);
      const cost = plan && planCredits(plan) ? planPrice(plan) / planCredits(plan) * credits : null;
      nativeCards.push({ label: "Native model vendor", name: kling.name, model: native.model || "Kling Video 3.0", cost, plan: plan?.name, note: native.note || "720p with native audio. Kling does not offer Seedance 2.5.", source: firstSource(kling), featured: true });
    }
    const ltx = platforms().find(p => p.id === "ltx" || p.id === "ltx-studio" || /ltx/i.test(p.name));
    if (ltx) nativeCards.push({ label: "Workflow studio", name: ltx.name, model: valueAt(ltx, "native_benchmark.model") || "LTX-2.5", cost: null, plan: "Debit unavailable", note: valueAt(ltx, "native_benchmark.note") || "Studio plan credits are public; the hosted five-second generation debit is not.", source: firstSource(ltx) });
    const runway = platforms().find(p => p.id === "runway");
    if (runway) {
      const plan = state.planMode === "value" ? bestPlan(runway) : defaultPlan(runway);
      const native = runway.native_benchmark || { model: "Gen-4.5", credits_5s: 60 };
      const credits = Number(valueAt(native, "credits_5s", "720p.credits_5s") || 60);
      const cost = plan ? planPrice(plan) / planCredits(plan) * credits : null;
      nativeCards.push({ label: "Same subscription", name: runway.name, model: native.model || "Gen-4.5", cost, plan: plan?.name, note: native.note || "Runway's own native video model, shown outside the Seedance ranking.", source: firstSource(runway) });
    }
    $("#nativeComparison").innerHTML = nativeCards.map((card, index) => `<article class="native-card ${card.featured ? "featured" : ""}"><span class="card-index">N${index + 1}</span><span class="label">${safe(card.label)}</span><h3>${safe(card.name)}<br><small>${safe(card.model)}</small></h3><strong class="native-cost">${card.cost != null ? money.format(card.cost) : "Unlisted"}</strong><span>${card.cost != null ? `/ 5s · ${safe(card.plan)}` : safe(card.plan)}</span><p>${safe(card.note)}</p><a href="${safeHref(card.source)}" target="_blank" rel="noopener noreferrer">Official source ↗</a></article>`).join("");
  }

  function bestNativePlan(platform) {
    const benchmark = platform.native_benchmark || {};
    const credits = Number(valueAt(benchmark, "credits_5s", "720p.credits_5s") || 45);
    return (platform.plans || []).filter(plan => planCredits(plan) && planPrice(plan)).sort((a, b) => planPrice(a) / planCredits(a) * credits - planPrice(b) / planCredits(b) * credits)[0] || defaultPlan(platform);
  }

  function renderPlans() {
    const query = ($("#planSearch")?.value || "").trim().toLowerCase();
    const category = $("#planCategory")?.value || "all";
    const seedanceOnly = $("#seedanceFilter")?.checked || false;
    let visible = 0;
    const markup = platforms().map((platform, index) => {
      const haystack = [platform.name, platform.category, ...(platform.plans || []).map(p => p.name)].join(" ").toLowerCase();
      const matches = (!query || haystack.includes(query)) && (category === "all" || categoryMatch(platform.category, category)) && (!seedanceOnly || eligibleSeedance(platform));
      if (matches) visible++;
      const access = eligibleSeedance(platform) ? "yes" : /gated|region/i.test(platform.access_note || "") ? "pending" : "";
      const plans = platform.plans || [];
      const tableRows = plans.length ? plans.map(plan => `<tr><td>${safe(plan.name)}</td><td class="number">${planPrice(plan) ? money.format(planPrice(plan)) : plan.monthly_list_usd === 0 || plan.monthly_usd === 0 ? "$0" : "Sign-in required"}</td><td class="number">${planCredits(plan) ? integer.format(planCredits(plan)) : "—"}</td><td>${safe(plan.rollover_note || detailText(plan.rollover || platform.rollover || "See provider terms"))}</td><td>${safe(plan.commercial_rights_note || detailText(plan.commercial_rights || platform.commercial_rights || "See provider terms"))}</td><td>${safe(Array.isArray(plan.features) ? plan.features.join(" · ") : plan.features || plan.access || "—")}</td></tr>`).join("") : `<tr><td colspan="6">Official plan names are public; regional price and allowance require sign-in.</td></tr>`;
      return `<details class="platform-group" data-plan-platform="${safe(platform.id)}" ${matches ? "" : "hidden"} ${index < 2 && !query ? "open" : ""}><summary class="platform-summary"><h2>${safe(platform.name)}<small>${safe(platform.category || "AI video platform")}</small></h2><p>${safe(platform.access_note || platform.rate_note || "Current official monthly plan surface.")}</p><div class="platform-meta"><span class="meta-chip ${access}">${eligibleSeedance(platform) ? "Seedance 2.5 live" : "Native / other models"}</span><span class="meta-chip">${plans.length} plan${plans.length === 1 ? "" : "s"}</span><span class="meta-chip">${safe(platform.confidence || "verified")}</span></div><span class="expand-icon" aria-hidden="true">+</span></summary><div class="platform-content"><div class="plan-table-wrap"><table class="plan-table"><thead><tr><th>Plan</th><th>Monthly list</th><th>Credits</th><th>Rollover</th><th>Commercial use</th><th>Notable access</th></tr></thead><tbody>${tableRows}</tbody></table></div><div class="plan-note"><span>${safe(platform.rate_note || "Plan features and model availability can change during a billing cycle.")}</span><span class="source-links">${sourceArray(platform).map(source => `<a href="${safeHref(source.url)}" target="_blank" rel="noopener noreferrer">${safe(source.label || "Source")} ↗</a>`).join("")}</span></div></div></details>`;
    }).join("");
    $("#plansDirectory").innerHTML = markup + (visible ? "" : `<div class="empty-state">No plans match these filters.</div>`);
  }

  function categoryMatch(value = "", filter) {
    const text = value.toLowerCase();
    if (filter === "aggregator") return text.includes("aggregate") || text.includes("multi-model");
    if (filter === "native") return text.includes("native") || text.includes("model vendor");
    if (filter === "workflow") return text.includes("workflow") || text.includes("studio") || text.includes("canvas");
    return true;
  }

  function detailText(value) {
    if (typeof value === "string") return value;
    if (!value) return "See provider terms";
    return value.detail || value.status || JSON.stringify(value);
  }

  function renderApis() {
    const rows = apis().map(api => {
      const rate = apiRate(api);
      const unresolvedRate = Number(valueAt(api, "rates_5s.unresolved", "rates.unspecified_native_resolution.usd_per_5s") || 0) || null;
      return { api, rate: rate || unresolvedRate, unresolved: !rate && Boolean(unresolvedRate) };
    }).filter(row => row.rate).sort((a, b) => Number(a.unresolved) - Number(b.unresolved) || a.rate - b.rate);
    const rankedRows = rows.filter(row => !row.unresolved);
    const max = Math.max(...rankedRows.map(row => row.rate), 1);
    $("#apiLowestHero").textContent = rankedRows.length ? money.format(rankedRows[0].rate) : "—";
    $("#apiBoard").innerHTML = rows.map((row, index) => {
      const status = String(row.api.status || "live").toLowerCase();
      const exact = row.unresolved ? "resolution unspecified" : valueAt(row.api, `rate_confidence.${state.apiResolution}`, "confidence") || "exact";
      const rank = row.unresolved ? "—" : String(index + 1).padStart(2, "0");
      const priceLabel = row.unresolved ? `${money.format(row.rate)} from` : money.format(row.rate);
      const spend = row.unresolved ? "Unranked" : compactMoney.format(row.rate * state.apiVolume);
      const note = row.unresolved ? "Published base rate; the public page does not split 480p and 720p. It remains outside the resolution ranking." : row.api.rate_note || "Official current list rate for the common benchmark.";
      return `<article class="api-row" style="--api:${safeColor(row.api.accent, "#2d5fff")}"><div class="api-provider"><span class="rank-number">${rank}</span><div><strong>${safe(row.api.name)}</strong><small>${safe(row.api.billing || "PAYG · successful output")}</small><span class="api-status ${exact === "exact" ? "" : "approx"}">${safe(status)} · ${safe(exact)}</span></div></div><div class="api-bar"><div class="bar-track"><div class="bar-fill" style="width:${row.unresolved ? 0 : Math.max(3, row.rate / max * 100)}%"></div></div><small>${safe(note)}</small></div><div class="api-price"><strong>${priceLabel}</strong><span>/ 5 seconds</span></div><div class="api-spend"><strong>${spend}</strong><span>${row.unresolved ? "needs resolution rate" : `${integer.format(state.apiVolume)} videos / month`}</span></div><a class="source-arrow" href="${safeHref(firstSource(row.api))}" target="_blank" rel="noopener noreferrer" aria-label="Open ${safe(row.api.name)} pricing source">↗</a></article>`;
    }).join("");
  }

  function normalizeCoverage(value = "") {
    const text = String(value).toLowerCase();
    if (text.includes("robust") || text.includes("high")) return "robust";
    if (text.includes("thin") || text.includes("low") || text.includes("insufficient")) return "thin";
    return "moderate";
  }

  function sentimentTone(value = "") {
    const text = String(value).toLowerCase();
    if (/positive|strong|praised|high ceiling|useful/.test(text) && !/mixed|polar/.test(text)) return "positive";
    if (/negative|friction|weak|poor|complaint/.test(text) && !/mixed|polar/.test(text)) return "negative";
    if (/unknown|insufficient|thin/.test(text)) return "unknown";
    return "mixed";
  }

  function labelValue(sentiment, key) {
    return valueAt(sentiment, `labels.${key}`, `${key}_sentiment`, key) || (key === "billing" ? "Mixed / friction" : "Mixed");
  }

  function renderSentiment() {
    const themeDefaults = [
      { title: "Usable-output cost", summary: "Retries, prompt misses, moderation, and continuity failures dominate perceived value." },
      { title: "Credit governance", summary: "Expiry, rollover, failure refunds, and plan-change behavior are major trust variables." },
      { title: "Convenience premium", summary: "One account, current models, reusable workflows, and shared assets justify a premium for some users." },
      { title: "Platform ≠ model", summary: "Users can praise an underlying model while criticizing queues, billing, support, or asset management." }
    ];
    const themes = getList(["cross_platform_themes", "sentiment_themes"], themeDefaults).slice(0, 4);
    $("#crossThemes").innerHTML = themes.map((theme, index) => `<article class="theme-card"><span>Signal ${String(index + 1).padStart(2, "0")}</span><strong>${safe(theme.title)}</strong><p>${safe(theme.summary || theme.description)}</p></article>`).join("");

    const entries = sentiments();
    $("#sentimentGrid").innerHTML = entries.map(entry => {
      const coverage = normalizeCoverage(entry.coverage || entry.confidence);
      const visible = state.sentimentFilter === "all" || coverage === state.sentimentFilter;
      const labels = ["output", "workflow", "billing"].map(key => {
        const val = labelValue(entry, key);
        return `<span class="sentiment-chip ${sentimentTone(val)}">${key === "billing" ? "Billing / support" : key}: ${safe(val)}</span>`;
      }).join("");
      const praise = entry.praise || entry.recurring_praise || [];
      const friction = entry.friction || entry.recurring_friction || [];
      const evidence = entry.evidence || entry.evidence_summary || entry.coverage_summary || "Directional public review evidence.";
      return `<details class="sentiment-card" data-coverage="${coverage}" ${visible ? "" : "hidden"}><summary><div><h2>${safe(entry.name || entry.platform_name || entry.platform_id)}</h2><span class="coverage-label ${coverage}">Coverage: ${coverage}</span></div><div class="sentiment-chips">${labels}</div><span class="expand-icon" aria-hidden="true">+</span></summary><div class="sentiment-detail"><div class="sentiment-column"><h3>Recurring praise</h3><ul>${praise.map(item => `<li>${safe(item)}</li>`).join("") || "<li>Limited recurring positive evidence.</li>"}</ul></div><div class="sentiment-column"><h3>Recurring friction</h3><ul>${friction.map(item => `<li>${safe(item)}</li>`).join("") || "<li>Limited recurring friction evidence.</li>"}</ul></div><div class="evidence-box"><p><strong>Evidence:</strong> ${safe(evidence)} ${safe(entry.caveat || "")}</p><div class="evidence-links">${sourceArray(entry).map(source => `<a href="${safeHref(source.url)}" target="_blank" rel="noopener noreferrer">${safe(source.label || source.code || "Evidence")} ↗</a>`).join("")}</div></div></div></details>`;
    }).join("");

    const legendDefaults = [
      { code: "TP", name: "Trustpilot", bias: "Strong billing/support signal; self-selection and review-invitation effects." },
      { code: "R", name: "Reddit", bias: "Detailed firsthand discussion; anecdotal and promotion-sensitive." },
      { code: "PH", name: "Product Hunt", bias: "Launch-community feedback with enthusiast and founder skew." },
      { code: "G2", name: "G2", bias: "Business reviews; some collection can be invited or incentivized." },
      { code: "APP", name: "App stores", bias: "Product-specific ratings with region and platform effects." }
    ];
    const legend = getList(["source_legend", "sentiment_source_legend"], legendDefaults);
    $("#sourceLegend").innerHTML = legend.map(item => `<div class="legend-item"><strong>${safe(item.code)} · ${safe(item.name)}</strong><span>${safe(item.bias || item.caveat || item.description)}</span></div>`).join("");
  }

  function normalizeDealStatus(deal) {
    const explicit = String(deal.status || "").toLowerCase().replaceAll("_", "-");
    if (explicit === "expired" || explicit === "archived") return "expired";
    if (explicit.includes("unknown") || explicit.includes("unverified") || explicit.includes("no-date")) return "unverified";
    if (explicit === "ending") return "ending";
    const end = deal.ends_at ? new Date(deal.ends_at) : null;
    const now = new Date();
    if (end && !Number.isNaN(end.valueOf())) {
      if (end < now) return "expired";
      if (end - now < 4 * 86400000) return "ending";
      return "active";
    }
    if (!deal.ends_at) return explicit === "active" ? "unverified" : "unverified";
    return "active";
  }

  function renderDeals() {
    const entries = promotions();
    const statuses = entries.map(normalizeDealStatus);
    const counts = { active: statuses.filter(s => s === "active").length, ending: statuses.filter(s => s === "ending").length, unverified: statuses.filter(s => s === "unverified").length, expired: statuses.filter(s => s === "expired").length };
    $("#dealStats").innerHTML = `<div class="deal-stat"><strong>${counts.active}</strong><span>active with dates</span></div><div class="deal-stat"><strong>${counts.ending}</strong><span>ending soon</span></div><div class="deal-stat"><strong>${counts.unverified}</strong><span>end date unknown</span></div><div class="deal-stat"><strong>${counts.expired}</strong><span>archived</span></div>`;
    $("#dealsGrid").innerHTML = entries.map(deal => {
      const status = normalizeDealStatus(deal);
      const visible = state.dealFilter === "all" || status === state.dealFilter;
      const provider = platforms().find(p => p.id === deal.platform_id)?.name || deal.provider || deal.platform || deal.platform_id;
      const termsUrl = typeof deal.source === "string" ? deal.source : valueAt(deal, "source.url", "source_url") || sourceArray(deal)[0]?.url || "#method";
      return `<article class="deal-card ${status}" data-deal-status="${status}" ${visible ? "" : "hidden"}><div class="deal-header"><span class="deal-provider">${safe(provider)}</span><span class="deal-status">${status === "unverified" ? "dates unknown" : status}</span></div><h2>${safe(deal.title)}</h2><strong class="deal-value">${safe(dealValue(deal))}</strong><p>${safe(deal.eligibility || deal.terms || deal.description || "See official terms for eligibility.")}</p><div class="deal-dates"><div><span>Starts</span><strong>${formatDate(deal.starts_at)}</strong></div><div><span>Ends</span><strong>${formatDate(deal.ends_at)}</strong></div></div><a href="${safeHref(termsUrl)}" target="_blank" rel="noopener noreferrer">Official terms ↗</a></article>`;
    }).join("");
  }

  function formatDate(value) {
    if (!value) return "Not published";
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? safe(value) : dateFmt.format(parsed);
  }

  function dealValue(deal) {
    const value = deal.value ?? deal.discount ?? deal.offer;
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (!value) return "See terms";
    if (value.percent_off) return `${value.percent_off}% off`;
    if (value.percent_off_up_to) return `Up to ${value.percent_off_up_to}% off`;
    if (value.percent_fewer_credits) return `${value.percent_fewer_credits}% fewer credits`;
    if (value.percent_bonus) return `${value.percent_bonus}% bonus`;
    if (value.unlimited) return "Unlimited";
    if (value.additional_computing_seconds_per_month) return `${integer.format(value.additional_computing_seconds_per_month)} extra / month`;
    const prices = Object.values(value).filter(item => typeof item === "number");
    if (prices.length) return prices.map(item => money.format(item)).join(" · ");
    return "See terms";
  }

  function checks() {
    return state.live?.checks || state.live?.sources || [];
  }

  function renderLive() {
    const entries = checks();
    const generated = state.live?.generated_at || state.live?.fetched_at || state.catalog?.checked_at;
    const fresh = entries.filter(check => ["fresh", "ok", "accepted", "live"].includes(String(check.status).toLowerCase())).length;
    const review = entries.filter(check => String(check.status).toLowerCase().includes("review")).length;
    const stale = entries.filter(check => String(check.status).toLowerCase() === "stale").length;
    const error = entries.filter(check => ["error", "failed"].includes(String(check.status).toLowerCase())).length;
    const interval = state.live?.refresh_interval || state.live?.refresh_interval_minutes ? `${state.live.refresh_interval_minutes || state.live.refresh_interval}` : "Hourly";
    $("#liveSummary").innerHTML = `<div class="live-summary-item"><strong>${fresh}</strong><span>fresh / accepted</span></div><div class="live-summary-item"><strong>${review}</strong><span>held for review</span></div><div class="live-summary-item"><strong>${stale + error}</strong><span>stale / source errors</span></div><div class="live-summary-item"><strong>${safe(interval)}</strong><span>scheduled refresh</span></div>`;
    $("#sourceHealth").innerHTML = entries.length ? entries.map(check => {
      const status = String(check.status || "fresh").toLowerCase();
      return `<div class="health-row"><strong class="health-name">${safe(check.name || check.id)}</strong><span class="health-status ${safe(status)}">${safe(status.replaceAll("_", " "))}</span><span class="health-time">${safe(formatTime(check.fetched_at || generated))}</span><a href="${safeHref(check.source || check.source_url)}" target="_blank" rel="noopener noreferrer" aria-label="Open official source">↗</a></div>`;
    }).join("") : `<div class="empty-state">The curated snapshot is active. Automated source checks will appear after the first scheduled run.</div>`;
    updateLiveButton(generated, stale + error + review > 0);
  }

  function formatTime(value) {
    if (!value) return "Awaiting first run";
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? value : timeFmt.format(parsed);
  }

  function updateLiveButton(value, hasErrors = false) {
    const button = $("#refreshButton");
    button.classList.toggle("error", hasErrors);
    $("#liveButtonLabel").textContent = hasErrors ? "Snapshot + warnings" : "Live refreshed";
    $("#liveButtonHint").textContent = value ? `Checked ${formatTime(value)}` : "Curated baseline";
  }

  function mergeLive() {
    const updates = state.live?.updates;
    if (!updates || !state.catalog) return;
    const platformUpdates = updates.subscription_platforms || updates.platforms || {};
    platforms().forEach(platform => {
      const platformKey = platform.id === "ltx-studio" ? "ltx" : platform.id;
      const patch = platformUpdates[platformKey];
      if (!patch || patch.status === "needs_review") return;
      if (patch.plans) {
        const incoming = Array.isArray(patch.plans) ? patch.plans : Object.entries(patch.plans).map(([id, plan]) => ({ id, ...plan }));
        platform.plans = (platform.plans || []).map(plan => {
          const match = incoming.find(candidate => candidate.id === plan.id)
            || incoming.find(candidate => Number(candidate.monthly_credits || candidate.credits) === planCredits(plan) && String(candidate.name).toLowerCase() === String(plan.name).split(" · ")[0].toLowerCase());
          if (!match) return plan;
          const monthlyUsd = Number(match.monthly_usd ?? match.monthly_list_usd ?? planPrice(plan));
          const monthlyCredits = Number(match.monthly_credits ?? match.credits ?? planCredits(plan));
          return { ...plan, monthly_usd: monthlyUsd, monthly_list_usd: monthlyUsd, monthly_credits: monthlyCredits, included_monthly_credits: monthlyCredits };
        });
      }
      if (patch.rates) platform.rates = { ...platform.rates, ...patch.rates };
    });
    const apiUpdates = updates.api_providers || updates.apis || {};
    apis().forEach(api => {
      if (api.id === "atlas-cloud") return;
      const apiKey = ({ "wavespeed-ai": "wavespeed", "kie-ai": "kie", "atlas-cloud": "atlas" })[api.id] || api.id;
      const patch = apiUpdates[apiKey];
      if (!patch || patch.status === "needs_review") return;
      if (patch.rates_5s) api.rates_5s = { ...api.rates_5s, ...patch.rates_5s };
      if (patch.pricing_basis) api.rate_note = patch.pricing_basis;
      if (patch.availability) api.status = patch.availability;
    });
  }

  async function refreshSnapshot() {
    const buttons = [$("#refreshButton"), $("#refreshButtonSecondary")].filter(Boolean);
    buttons.forEach(button => { button.disabled = true; button.classList.add("loading"); });
    try {
      const url = `data/live-pricing.json?refresh=${Date.now()}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.live = await response.json();
      mergeLive();
      renderAll();
      showToast("Latest published source snapshot loaded");
    } catch (error) {
      showToast("Curated snapshot remains active");
      updateLiveButton(state.live?.generated_at || state.catalog?.checked_at, true);
    } finally {
      buttons.forEach(button => { button.disabled = false; button.classList.remove("loading"); });
    }
  }

  function snapshotText() {
    const rows = seedancePlatforms().map(platform => {
      const plan = selectedPlan(platform);
      const cost = costFor(platform, plan);
      return cost ? `${platform.name} — ${plan.name}: ${money.format(cost.comparable)} per 5s at ${state.resolution}` : null;
    }).filter(Boolean).sort();
    return `Frame / Five — Seedance 2.5 snapshot\n${rows.join("\n")}\nBenchmark: 5s, ${state.resolution}, native audio, no video reference, ${state.promos ? "verified deal overlay" : "monthly list price"}.`;
  }

  async function copySnapshot() {
    try {
      await navigator.clipboard.writeText(snapshotText());
      showToast("Snapshot copied");
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = snapshotText();
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      showToast("Snapshot copied");
    }
  }

  function downloadCsv() {
    const header = ["Platform", "Plan", "Resolution", "Monthly USD", "Monthly credits", "Credits per normalized 5s", "Comparable USD per 5s", "Billable seconds", "Whole runs", "Deal overlay"];
    const body = seedancePlatforms().map(platform => {
      const plan = selectedPlan(platform);
      const rate = rateFor(platform);
      const cost = costFor(platform, plan);
      return [platform.name, plan.name, state.resolution, planPrice(plan), planCredits(plan), normalizedCredits(rate), cost?.comparable, billedSeconds(rate), Math.floor(planCredits(plan) / billedCredits(rate)), cost?.overlay ? "yes" : "no"];
    });
    const csv = [header, ...body].map(row => row.map(cell => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `frame-five-${state.resolution}-${state.catalog.checked_at || "snapshot"}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast("CSV ready");
  }

  function bindEvents() {
    window.addEventListener("hashchange", renderRoute);
    $$('input[name="resolution"]').forEach(input => input.addEventListener("change", event => { state.resolution = event.target.value; renderOverview(); }));
    $$('input[name="planMode"]').forEach(input => input.addEventListener("change", event => { state.planMode = event.target.value; state.selections = {}; renderOverview(); }));
    $("#targetInput").addEventListener("input", event => { state.target = Number(event.target.value); renderOverview(); });
    $("#promoToggle").addEventListener("change", event => { state.promos = event.target.checked; renderOverview(); });
    $("#copySnapshot").addEventListener("click", copySnapshot);
    $("#downloadCsv").addEventListener("click", downloadCsv);
    $("#planSearch").addEventListener("input", renderPlans);
    $("#planCategory").addEventListener("change", renderPlans);
    $("#seedanceFilter").addEventListener("change", renderPlans);
    $$('input[name="apiResolution"]').forEach(input => input.addEventListener("change", event => { state.apiResolution = event.target.value; renderApis(); }));
    $("#apiVolume").addEventListener("input", event => { state.apiVolume = Math.max(1, Number(event.target.value) || 1); renderApis(); });
    $$('[data-sentiment-filter]').forEach(button => button.addEventListener("click", event => {
      state.sentimentFilter = event.currentTarget.dataset.sentimentFilter;
      $$('[data-sentiment-filter]').forEach(item => item.setAttribute("aria-pressed", String(item === event.currentTarget)));
      renderSentiment();
    }));
    $("#expandSentiment").addEventListener("click", event => {
      const cards = $$(".sentiment-card:not([hidden])");
      const open = cards.some(card => !card.open);
      cards.forEach(card => { card.open = open; });
      event.currentTarget.textContent = open ? "Collapse all evidence" : "Expand all evidence";
    });
    $$('[data-deal-filter]').forEach(button => button.addEventListener("click", event => {
      state.dealFilter = event.currentTarget.dataset.dealFilter;
      $$('[data-deal-filter]').forEach(item => item.setAttribute("aria-pressed", String(item === event.currentTarget)));
      renderDeals();
    }));
    $("#enableDealsLink").addEventListener("click", () => { state.promos = true; $("#promoToggle").checked = true; });
    $("#refreshButton").addEventListener("click", refreshSnapshot);
    $("#refreshButtonSecondary").addEventListener("click", refreshSnapshot);
  }

  function renderAll() {
    $("#heroPlatformCount").textContent = platforms().length;
    $("#heroApiCount").textContent = apis().length;
    $("#researchCutoff").textContent = formatDate(state.catalog.checked_at || state.catalog.researched_at);
    renderOverview();
    renderPlans();
    renderApis();
    renderSentiment();
    renderDeals();
    renderLive();
    renderRoute();
  }

  async function boot() {
    try {
      state.catalog = window.CATALOG || await window.CATALOG_READY || await fetch("data/catalog.json").then(response => response.json());
      state.live = window.LIVE_PRICING || null;
      mergeLive();
      bindEvents();
      renderAll();
    } catch (error) {
      console.error(error);
      $("#content").innerHTML = `<div class="page-width empty-state load-error"><strong>Pricing data could not be loaded.</strong><p>Serve this folder over HTTP, then reload the page.</p></div>`;
      updateLiveButton(null, true);
    }
  }

  boot();
})();
