/** Linear-regression performance forecasting + risk classification. */
import { clamp, round } from "@/lib/utils";

export type ForecastPoint = { label: string; value: number };

export type Forecast = {
  slope: number;
  intercept: number;
  r2: number;
  residualStd: number;
  history: ForecastPoint[];
  projection: { label: string; value: number; low: number; high: number; horizon: number }[];
  trendLabel: "improving" | "steady" | "declining" | "insufficient-data";
  riskLabel: "on-track" | "watch" | "at-risk" | "unknown";
  confidence: number;
  nextValue: number;
  goalEta: number | null;
};

export function forecastPerformance(points: ForecastPoint[], goal = 0.85, horizon = 4): Forecast {
  if (points.length < 3) {
    return {
      slope: 0,
      intercept: points[0]?.value ?? 0,
      r2: 0,
      residualStd: 0,
      history: points,
      projection: [],
      trendLabel: "insufficient-data",
      riskLabel: "unknown",
      confidence: 0,
      nextValue: points.at(-1)?.value ?? 0,
      goalEta: null,
    };
  }

  const xs = points.map((_, index) => index);
  const ys = points.map((point) => point.value);
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i += 1) {
    const pred = intercept + slope * xs[i];
    ssTot += (ys[i] - meanY) ** 2;
    ssRes += (ys[i] - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : clamp(1 - ssRes / ssTot, 0, 1);
  const residualStd = Math.sqrt(ssRes / Math.max(1, n - 2));

  const projection = Array.from({ length: horizon }, (_, index) => {
    const step = index + 1;
    const value = clamp(intercept + slope * (n - 1 + step), 0.05, 0.99);
    const spread = 1.96 * residualStd * Math.sqrt(1 + step / n);
    return {
      label: `+${step}`,
      value,
      low: clamp(value - spread, 0, 1),
      high: clamp(value + spread, 0, 1),
      horizon: step,
    };
  });

  const nextValue = projection[0]?.value ?? ys.at(-1) ?? 0;
  const goalEta = slope > 0.005 ? Math.max(0, Math.ceil((goal - (intercept + slope * (n - 1))) / slope)) : null;
  const trendLabel = slope > 0.012 ? "improving" : slope < -0.012 ? "declining" : "steady";
  const riskLabel = slope < -0.008 && nextValue < 0.7 ? "at-risk" : nextValue < 0.62 || r2 < 0.15 ? "watch" : "on-track";

  return {
    slope,
    intercept,
    r2,
    residualStd,
    history: points,
    projection,
    trendLabel,
    riskLabel,
    confidence: round(clamp(r2, 0, 1) * 0.7 + clamp(n / 12, 0, 1) * 0.3),
    nextValue,
    goalEta,
  };
}
