# Japan Token Pricing Foundation

> Status: implementation foundation, launch-draft prices. Public checkout copy
> still needs finance/legal review before the price book is marked `live`.

## Goal

Japan GTM needs a pricing surface that can be reused by the website, desktop
settings, sales demos, and internal calculators without hard-coding provider
costs into copy. The foundation is an internal `CallingClaw token` (`CCT`) price
book for Japan.

This deliberately separates three layers:

| Layer | Owner | Purpose |
| --- | --- | --- |
| Provider cost | Engineering | OpenAI/Gemini/Grok/Anthropic costs and model switches |
| CCT metering | Product/Engineering | Stable usage unit for meetings, prep, summaries, vision, and actions |
| Japan price book | GTM/Product | JPY packages, launch trial, overage anchors, tax display |

## Implemented

Code:

- `callingclaw-backend/src/pricing/japan-token-pricing.ts`
- `callingclaw-backend/test/pricing/japan-token-pricing.test.ts`

API:

| Endpoint | Method | Use |
| --- | --- | --- |
| `/api/pricing/jp` | `GET` | Returns the Japan JPY token catalog |
| `/api/pricing/japan` | `GET` | Readable alias |
| `/api/pricing/jp/estimate` | `POST` | Estimates monthly CCT usage and recommends a plan |
| `/api/pricing/japan/estimate` | `POST` | Readable alias |

Environment flags:

| Variable | Default | Notes |
| --- | --- | --- |
| `CALLINGCLAW_JP_PRICING_STATUS` | `draft` | `draft`, `private_beta`, or `live` |
| `CALLINGCLAW_JP_CONSUMPTION_TAX_RATE` | `0.1` | Used for estimate output; copy should keep tax separate until launch review |

## Draft Price Book

| Plan | Monthly JPY | Included CCT | Seats | Overage |
| --- | ---: | ---: | ---: | --- |
| Launch Trial | 0 | 60,000 | 1 | none |
| Solo | 1,980 | 250,000 | 1 | 100,000 CCT / 1,200 JPY |
| Growth | 5,800 | 900,000 | 3 | 250,000 CCT / 2,400 JPY |
| Team | 18,000 | 3,000,000 | 10 | 1,000,000 CCT / 7,500 JPY |

These are positioning anchors, not final public billing terms.

## Estimator Shape

Example request:

```json
{
  "meetingsPerMonth": 12,
  "averageMeetingMinutes": 45,
  "aiSpeakingRatio": 0.12,
  "visionEnabled": true,
  "prepBriefsPerMeeting": 1,
  "summariesPerMeeting": 1,
  "computerActionsPerMeeting": 2
}
```

The response includes:

- normalized input
- per-meeting CCT
- monthly CCT
- line-item breakdown
- recommended plan
- base, overage, tax, and total JPY estimate

## Guardrails

- Do not present CCT as raw OpenAI/Gemini/Anthropic tokens.
- Do not expose provider costs on Japan-facing pages.
- Keep retry credits, failed meeting refunds, and support adjustments manual
  until billing events exist.
- Review tax-inclusive display and checkout language before switching
  `CALLINGCLAW_JP_PRICING_STATUS=live`.

## Next Hooks

1. Website pricing block can call `GET /api/pricing/jp` or import the same
   catalog during static build if the backend is not deployed.
2. Sales/GTM calculator can call `POST /api/pricing/jp/estimate`.
3. Future billing work should emit usage events in CCT dimensions first, then
   map them to Stripe/payment-provider line items.
