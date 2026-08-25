import { afterEach, describe, expect, test } from "bun:test";
import {
  estimateJapanPlanCost,
  estimateJapanTokenUsage,
  getJapanTokenPricingCatalog,
  handleJapanPricingApi,
  recommendJapanPlan,
} from "../../src/pricing/japan-token-pricing";

describe("Japan token pricing catalog", () => {
  test("returns a draft JPY catalog with ascending token plans", () => {
    const catalog = getJapanTokenPricingCatalog();

    expect(catalog.market).toBe("JP");
    expect(catalog.currency).toBe("JPY");
    expect(catalog.tokenUnit.code).toBe("CCT");
    expect(catalog.plans.length).toBeGreaterThanOrEqual(4);

    const includedTokens = catalog.plans.map((plan) => plan.includedTokens);
    expect(includedTokens).toEqual([...includedTokens].sort((a, b) => a - b));
  });

  test("recommends the smallest plan that covers estimated usage", () => {
    const catalog = getJapanTokenPricingCatalog();

    expect(recommendJapanPlan(50000, catalog).id).toBe("jp_launch_trial");
    expect(recommendJapanPlan(250001, catalog).id).toBe("jp_growth");
    expect(recommendJapanPlan(3000001, catalog).id).toBe("jp_team");
  });
});

describe("Japan token pricing estimator", () => {
  test("estimates a typical pilot and recommends a paid plan", () => {
    const estimate = estimateJapanTokenUsage({
      meetingsPerMonth: 12,
      averageMeetingMinutes: 45,
      aiSpeakingRatio: 0.12,
      visionEnabled: true,
      computerActionsPerMeeting: 2,
    });

    expect(estimate.perMeetingTokens).toBeGreaterThan(40000);
    expect(estimate.monthlyTokens).toBe(estimate.breakdown.reduce((sum, item) => sum + item.monthlyTokens, 0));
    expect(["jp_solo", "jp_growth"]).toContain(estimate.recommendedPlan.id);
    expect(estimate.planCost.totalJpy).toBeGreaterThan(0);
  });

  test("disables vision costs when requested", () => {
    const withVision = estimateJapanTokenUsage({ meetingsPerMonth: 1, visionEnabled: true });
    const withoutVision = estimateJapanTokenUsage({ meetingsPerMonth: 1, visionEnabled: false });

    expect(withVision.monthlyTokens).toBeGreaterThan(withoutVision.monthlyTokens);
    expect(withoutVision.breakdown.find((item) => item.key === "visionMinute")?.monthlyTokens).toBe(0);
  });

  test("calculates overage packages when usage exceeds included tokens", () => {
    const catalog = getJapanTokenPricingCatalog();
    const solo = catalog.plans.find((plan) => plan.id === "jp_solo")!;
    const cost = estimateJapanPlanCost(solo.includedTokens + 1, solo, catalog);

    expect(cost.overageTokens).toBe(1);
    expect(cost.overageUnits).toBe(1);
    expect(cost.overageJpy).toBe(solo.overagePackage!.priceJpy);
    expect(cost.totalJpy).toBeGreaterThan(cost.subtotalJpy);
  });
});

describe("Japan token pricing estimator — input normalization + null-overage edge", () => {
  test("clamps and defaults invalid inputs (negative counts, out-of-range ratio, string boolean, NaN)", () => {
    const estimate = estimateJapanTokenUsage({
      meetingsPerMonth: -3 as any,       // negative → default 20
      averageMeetingMinutes: NaN as any, // NaN → default 45
      aiSpeakingRatio: 5 as any,         // >1 → clamped to 1
      visionEnabled: "false" as any,     // string "false" → false
    });

    expect(estimate.input.meetingsPerMonth).toBe(20);
    expect(estimate.input.averageMeetingMinutes).toBe(45);
    expect(estimate.input.aiSpeakingRatio).toBe(1);
    expect(estimate.input.visionEnabled).toBe(false);
    // vision disabled by the coerced boolean → zero vision tokens
    expect(estimate.breakdown.find((item) => item.key === "visionMinute")?.monthlyTokens).toBe(0);
  });

  test("plan with no overage package (Launch Trial) never bills overage even over budget", () => {
    const catalog = getJapanTokenPricingCatalog();
    const trial = catalog.plans.find((plan) => plan.id === "jp_launch_trial")!;
    expect(trial.overagePackage).toBeNull();

    const cost = estimateJapanPlanCost(trial.includedTokens + 5000, trial, catalog);
    expect(cost.overageTokens).toBe(5000); // tokens over the wallet are still reported
    expect(cost.overageUnits).toBe(0);     // ...but no package to bill them against
    expect(cost.overageJpy).toBe(0);
    expect(cost.subtotalJpy).toBe(0);
    expect(cost.totalJpy).toBe(0);
  });
});

describe("Japan token pricing catalog — env overrides", () => {
  const prevRate = process.env.CALLINGCLAW_JP_CONSUMPTION_TAX_RATE;
  const prevStatus = process.env.CALLINGCLAW_JP_PRICING_STATUS;
  afterEach(() => {
    if (prevRate === undefined) delete process.env.CALLINGCLAW_JP_CONSUMPTION_TAX_RATE;
    else process.env.CALLINGCLAW_JP_CONSUMPTION_TAX_RATE = prevRate;
    if (prevStatus === undefined) delete process.env.CALLINGCLAW_JP_PRICING_STATUS;
    else process.env.CALLINGCLAW_JP_PRICING_STATUS = prevStatus;
  });

  test("valid env values override, out-of-range / unknown values fall back", () => {
    // Valid overrides applied
    process.env.CALLINGCLAW_JP_CONSUMPTION_TAX_RATE = "0.08";
    process.env.CALLINGCLAW_JP_PRICING_STATUS = "live";
    let catalog = getJapanTokenPricingCatalog();
    expect(catalog.tax.consumptionTaxRate).toBe(0.08);
    expect(catalog.status).toBe("live");

    // Out-of-range rate (>1) + unknown status fall back to defaults
    process.env.CALLINGCLAW_JP_CONSUMPTION_TAX_RATE = "2";
    process.env.CALLINGCLAW_JP_PRICING_STATUS = "garbage";
    catalog = getJapanTokenPricingCatalog();
    expect(catalog.tax.consumptionTaxRate).toBe(0.1);
    expect(catalog.status).toBe("draft");
  });
});

describe("Japan token pricing API handler", () => {
  test("returns null for unmatched routes so the server can fall through", async () => {
    // wrong method on catalog path
    const u1 = new URL("http://localhost/api/pricing/jp");
    expect(await handleJapanPricingApi(new Request(u1.toString(), { method: "POST" }), u1, {})).toBeNull();
    // wrong method on estimate path
    const u2 = new URL("http://localhost/api/pricing/jp/estimate");
    expect(await handleJapanPricingApi(new Request(u2.toString(), { method: "GET" }), u2, {})).toBeNull();
    // unrelated path
    const u3 = new URL("http://localhost/api/other");
    expect(await handleJapanPricingApi(new Request(u3.toString()), u3, {})).toBeNull();
  });

  test("estimate endpoint tolerates a malformed JSON body (falls back to defaults)", async () => {
    const url = new URL("http://localhost/api/pricing/jp/estimate");
    const res = await handleJapanPricingApi(
      new Request(url.toString(), { method: "POST", body: "not json{" }),
      url,
      { "Content-Type": "application/json" }
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.monthlyTokens).toBeGreaterThan(0); // computed from all-default inputs
  });

  test("serves the catalog endpoint", async () => {
    const url = new URL("http://localhost/api/pricing/jp");
    const res = await handleJapanPricingApi(new Request(url.toString()), url, { "Content-Type": "application/json" });
    const body = (await res!.json()) as any;

    expect(res?.status).toBe(200);
    expect(body.market).toBe("JP");
    expect(body.plans.some((plan: any) => plan.id === "jp_growth")).toBe(true);
  });

  test("serves the estimate endpoint", async () => {
    const url = new URL("http://localhost/api/pricing/jp/estimate");
    const res = await handleJapanPricingApi(
      new Request(url.toString(), {
        method: "POST",
        body: JSON.stringify({ meetingsPerMonth: 4, averageMeetingMinutes: 30 }),
      }),
      url,
      { "Content-Type": "application/json" }
    );
    const body = (await res!.json()) as any;

    expect(res?.status).toBe(200);
    expect(body.monthlyTokens).toBeGreaterThan(0);
    expect(body.recommendedPlan.id).toBeTruthy();
  });
});
