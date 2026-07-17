// CallingClaw Japan token pricing foundation.
//
// This file intentionally models "CallingClaw tokens" as an internal usage
// unit, not raw provider tokens. It gives GTM and landing pages a stable
// pricing surface while voice/model providers keep changing underneath.

export type JapanPricingStatus = "draft" | "private_beta" | "live";

export interface JapanTokenPricingPlan {
  id: string;
  name: string;
  audience: string;
  monthlyPriceJpy: number;
  includedTokens: number;
  seatsIncluded: number;
  overagePackage: {
    tokens: number;
    priceJpy: number;
  } | null;
  highlights: string[];
}

export interface JapanUsageWeights {
  meetingListeningMinute: number;
  aiSpeakingMinute: number;
  visionMinute: number;
  computerAction: number;
  prepBrief: number;
  postMeetingSummary: number;
  llmInput1kTokens: number;
  llmOutput1kTokens: number;
}

export interface JapanTokenPricingCatalog {
  market: "JP";
  currency: "JPY";
  priceBookVersion: string;
  status: JapanPricingStatus;
  tax: {
    consumptionTaxRate: number;
    display: "exclusive";
    note: string;
  };
  tokenUnit: {
    name: "CallingClaw token";
    code: "CCT";
    note: string;
  };
  usageWeights: JapanUsageWeights;
  plans: JapanTokenPricingPlan[];
  guardrails: string[];
}

export interface JapanUsageEstimateInput {
  meetingsPerMonth?: number;
  averageMeetingMinutes?: number;
  aiSpeakingRatio?: number;
  visionEnabled?: boolean;
  prepBriefsPerMeeting?: number;
  summariesPerMeeting?: number;
  computerActionsPerMeeting?: number;
  extraLlmInputTokensPerMeeting?: number;
  extraLlmOutputTokensPerMeeting?: number;
}

export interface JapanUsageEstimate {
  input: Required<JapanUsageEstimateInput>;
  perMeetingTokens: number;
  monthlyTokens: number;
  recommendedPlan: JapanTokenPricingPlan;
  planCost: {
    planId: string;
    baseJpy: number;
    overageTokens: number;
    overageUnits: number;
    overageJpy: number;
    subtotalJpy: number;
    taxJpy: number;
    totalJpy: number;
  };
  breakdown: Array<{
    key: string;
    label: string;
    unitCount: number;
    weight: number;
    perMeetingTokens: number;
    monthlyTokens: number;
  }>;
}

const PRICE_BOOK_VERSION = "jp-token-pricing-draft-2026-07-06";

const DEFAULT_STATUS: JapanPricingStatus = "draft";

const DEFAULT_USAGE_WEIGHTS: JapanUsageWeights = {
  meetingListeningMinute: 800,
  aiSpeakingMinute: 1200,
  visionMinute: 160,
  computerAction: 100,
  prepBrief: 4500,
  postMeetingSummary: 3500,
  llmInput1kTokens: 8,
  llmOutput1kTokens: 40,
};

const JP_PLANS: JapanTokenPricingPlan[] = [
  {
    id: "jp_launch_trial",
    name: "Launch Trial",
    audience: "Early Japan market demos and founder-led pilots",
    monthlyPriceJpy: 0,
    includedTokens: 60000,
    seatsIncluded: 1,
    overagePackage: null,
    highlights: [
      "Limited pilot wallet",
      "No overage billing",
      "Good for one or two short demo meetings",
    ],
  },
  {
    id: "jp_solo",
    name: "Solo",
    audience: "Individual operators and sales founders",
    monthlyPriceJpy: 1980,
    includedTokens: 250000,
    seatsIncluded: 1,
    overagePackage: { tokens: 100000, priceJpy: 1200 },
    highlights: [
      "Designed for weekly customer calls",
      "Meeting prep and summary included in the same wallet",
      "Low-friction entry price for Japan launch campaigns",
    ],
  },
  {
    id: "jp_growth",
    name: "Growth",
    audience: "Small teams running recurring sales, hiring, or research calls",
    monthlyPriceJpy: 5800,
    includedTokens: 900000,
    seatsIncluded: 3,
    overagePackage: { tokens: 250000, priceJpy: 2400 },
    highlights: [
      "Shared team wallet",
      "Enough budget for several meetings per week",
      "Best default recommendation for paid pilots",
    ],
  },
  {
    id: "jp_team",
    name: "Team",
    audience: "Teams standardizing CallingClaw across GTM workflows",
    monthlyPriceJpy: 18000,
    includedTokens: 3000000,
    seatsIncluded: 10,
    overagePackage: { tokens: 1000000, priceJpy: 7500 },
    highlights: [
      "Team rollout wallet",
      "Lower overage price per token",
      "Procurement-friendly monthly anchor",
    ],
  },
];

function parseStatus(value: string | undefined): JapanPricingStatus {
  if (value === "private_beta" || value === "live" || value === "draft") return value;
  return DEFAULT_STATUS;
}

function parseRate(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

function asNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function asRatio(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function roundTokens(value: number): number {
  return Math.ceil(value);
}

function normalizeEstimateInput(input: JapanUsageEstimateInput = {}): Required<JapanUsageEstimateInput> {
  return {
    meetingsPerMonth: asNonNegativeNumber(input.meetingsPerMonth, 20),
    averageMeetingMinutes: asNonNegativeNumber(input.averageMeetingMinutes, 45),
    aiSpeakingRatio: asRatio(input.aiSpeakingRatio, 0.12),
    visionEnabled: asBoolean(input.visionEnabled, true),
    prepBriefsPerMeeting: asNonNegativeNumber(input.prepBriefsPerMeeting, 1),
    summariesPerMeeting: asNonNegativeNumber(input.summariesPerMeeting, 1),
    computerActionsPerMeeting: asNonNegativeNumber(input.computerActionsPerMeeting, 2),
    extraLlmInputTokensPerMeeting: asNonNegativeNumber(input.extraLlmInputTokensPerMeeting, 0),
    extraLlmOutputTokensPerMeeting: asNonNegativeNumber(input.extraLlmOutputTokensPerMeeting, 0),
  };
}

export function getJapanTokenPricingCatalog(): JapanTokenPricingCatalog {
  return {
    market: "JP",
    currency: "JPY",
    priceBookVersion: PRICE_BOOK_VERSION,
    status: parseStatus(process.env.CALLINGCLAW_JP_PRICING_STATUS),
    tax: {
      consumptionTaxRate: parseRate(process.env.CALLINGCLAW_JP_CONSUMPTION_TAX_RATE, 0.1),
      display: "exclusive",
      note: "Draft display keeps consumption tax separate until finance/legal review.",
    },
    tokenUnit: {
      name: "CallingClaw token",
      code: "CCT",
      note: "Internal metering unit for live meeting audio, vision, prep, summaries, and agent actions.",
    },
    usageWeights: { ...DEFAULT_USAGE_WEIGHTS },
    plans: JP_PLANS.map((plan) => ({
      ...plan,
      overagePackage: plan.overagePackage ? { ...plan.overagePackage } : null,
      highlights: [...plan.highlights],
    })),
    guardrails: [
      "Prices are launch-draft anchors, not a billing contract.",
      "Do not expose raw provider cost or provider tokens in Japan-facing copy.",
      "Keep failure retries and support credits as manual adjustments until billing events exist.",
      "Review tax-inclusive display requirements before public checkout.",
    ],
  };
}

export function recommendJapanPlan(monthlyTokens: number, catalog = getJapanTokenPricingCatalog()) {
  const sorted = [...catalog.plans].sort((a, b) => a.includedTokens - b.includedTokens);
  return sorted.find((plan) => monthlyTokens <= plan.includedTokens) || sorted[sorted.length - 1]!;
}

export function estimateJapanPlanCost(
  monthlyTokens: number,
  plan: JapanTokenPricingPlan,
  catalog = getJapanTokenPricingCatalog()
): JapanUsageEstimate["planCost"] {
  const overageTokens = Math.max(0, roundTokens(monthlyTokens - plan.includedTokens));
  const overageUnits = plan.overagePackage ? Math.ceil(overageTokens / plan.overagePackage.tokens) : 0;
  const overageJpy = plan.overagePackage ? overageUnits * plan.overagePackage.priceJpy : 0;
  const subtotalJpy = plan.monthlyPriceJpy + overageJpy;
  const taxJpy = Math.round(subtotalJpy * catalog.tax.consumptionTaxRate);
  return {
    planId: plan.id,
    baseJpy: plan.monthlyPriceJpy,
    overageTokens,
    overageUnits,
    overageJpy,
    subtotalJpy,
    taxJpy,
    totalJpy: subtotalJpy + taxJpy,
  };
}

export function estimateJapanTokenUsage(input: JapanUsageEstimateInput = {}): JapanUsageEstimate {
  const normalized = normalizeEstimateInput(input);
  const catalog = getJapanTokenPricingCatalog();
  const weights = catalog.usageWeights;
  const speakingMinutes = normalized.averageMeetingMinutes * normalized.aiSpeakingRatio;
  const visionMinutes = normalized.visionEnabled ? normalized.averageMeetingMinutes : 0;

  const breakdown = [
    {
      key: "meetingListeningMinute",
      label: "Live meeting listening",
      unitCount: normalized.averageMeetingMinutes,
      weight: weights.meetingListeningMinute,
    },
    {
      key: "aiSpeakingMinute",
      label: "AI speaking time",
      unitCount: speakingMinutes,
      weight: weights.aiSpeakingMinute,
    },
    {
      key: "visionMinute",
      label: "Screen vision",
      unitCount: visionMinutes,
      weight: weights.visionMinute,
    },
    {
      key: "prepBrief",
      label: "Meeting prep brief",
      unitCount: normalized.prepBriefsPerMeeting,
      weight: weights.prepBrief,
    },
    {
      key: "postMeetingSummary",
      label: "Post-meeting summary",
      unitCount: normalized.summariesPerMeeting,
      weight: weights.postMeetingSummary,
    },
    {
      key: "computerAction",
      label: "Computer-use actions",
      unitCount: normalized.computerActionsPerMeeting,
      weight: weights.computerAction,
    },
    {
      key: "llmInput1kTokens",
      label: "Extra LLM input tokens",
      unitCount: normalized.extraLlmInputTokensPerMeeting / 1000,
      weight: weights.llmInput1kTokens,
    },
    {
      key: "llmOutput1kTokens",
      label: "Extra LLM output tokens",
      unitCount: normalized.extraLlmOutputTokensPerMeeting / 1000,
      weight: weights.llmOutput1kTokens,
    },
  ].map((item) => {
    const perMeetingTokens = roundTokens(item.unitCount * item.weight);
    return {
      ...item,
      unitCount: Number(item.unitCount.toFixed(4)),
      perMeetingTokens,
      monthlyTokens: roundTokens(perMeetingTokens * normalized.meetingsPerMonth),
    };
  });

  const perMeetingTokens = breakdown.reduce((sum, item) => sum + item.perMeetingTokens, 0);
  const monthlyTokens = breakdown.reduce((sum, item) => sum + item.monthlyTokens, 0);
  const recommendedPlan = recommendJapanPlan(monthlyTokens, catalog);

  return {
    input: normalized,
    perMeetingTokens,
    monthlyTokens,
    recommendedPlan,
    planCost: estimateJapanPlanCost(monthlyTokens, recommendedPlan, catalog),
    breakdown,
  };
}

export async function handleJapanPricingApi(
  req: Request,
  url: URL,
  headers: Record<string, string>
): Promise<Response | null> {
  const isCatalogPath = url.pathname === "/api/pricing/jp" || url.pathname === "/api/pricing/japan";
  if (isCatalogPath && req.method === "GET") {
    return Response.json(getJapanTokenPricingCatalog(), { headers });
  }

  const isEstimatePath =
    url.pathname === "/api/pricing/jp/estimate" ||
    url.pathname === "/api/pricing/japan/estimate";
  if (isEstimatePath && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as JapanUsageEstimateInput;
    return Response.json(estimateJapanTokenUsage(body), { headers });
  }

  return null;
}
