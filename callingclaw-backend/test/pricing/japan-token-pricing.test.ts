import { describe, expect, test } from "bun:test";
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

describe("Japan token pricing API handler", () => {
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
