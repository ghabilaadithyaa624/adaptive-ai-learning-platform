import { cn, pct } from "@/lib/utils";

export function Sparkline({
  values,
  tone = "#6366f1",
  height = 40,
  className,
}: {
  values: number[];
  tone?: string;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) {
    return <div className={cn("h-10 rounded bg-slate-50", className)} />;
  }
  const width = 160;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const range = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${height} ${points.join(" ")} ${width},${height}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={cn("w-full", className)} style={{ height }} preserveAspectRatio="none">
      <polygon points={area} fill={tone} opacity={0.12} />
      <polyline points={points.join(" ")} fill="none" stroke={tone} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

export function BarList({
  items,
  max,
  formatter = (value: number) => pct(value),
}: {
  items: { label: string; value: number; color?: string; hint?: string }[];
  max?: number;
  formatter?: (value: number) => string;
}) {
  const ceiling = max ?? Math.max(1, ...items.map((item) => item.value));
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label}>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-medium text-slate-700">{item.label}</span>
            <span className="shrink-0 text-slate-500">{formatter(item.value)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${Math.max(3, (item.value / ceiling) * 100)}%`, background: item.color ?? "#6366f1" }}
            />
          </div>
          {item.hint ? <p className="mt-0.5 text-[11px] text-slate-400">{item.hint}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function ForecastChart({
  history,
  projection,
  height = 190,
  goal = 0.85,
}: {
  history: { label: string; value: number }[];
  projection: { label: string; value: number; low: number; high: number }[];
  height?: number;
  goal?: number;
}) {
  const width = 520;
  const padX = 26;
  const padY = 18;
  const all = [...history.map((point) => point.value), ...projection.map((point) => point.high)];
  const min = Math.max(0, Math.min(...all, 0.2) - 0.08);
  const max = Math.min(1, Math.max(...all, goal) + 0.06);
  const total = history.length + projection.length || 1;
  const x = (index: number) => padX + (index / Math.max(1, total - 1)) * (width - padX * 2);
  const y = (value: number) => padY + (1 - (value - min) / (max - min || 1)) * (height - padY * 2);

  const historyPoints = history.map((point, index) => ({ ...point, x: x(index), y: y(point.value) }));
  const projectionPoints = projection.map((point, index) => ({
    ...point,
    x: x(history.length + index),
    y: y(point.value),
  }));
  const line = historyPoints.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const projectionLine = [historyPoints.at(-1), ...projectionPoints]
    .filter(Boolean)
    .map((point) => `${point!.x.toFixed(1)},${point!.y.toFixed(1)}`)
    .join(" ");
  const band = [
    ...projectionPoints.map((point) => `${point.x.toFixed(1)},${y(point.high).toFixed(1)}`),
    ...[...projectionPoints].reverse().map((point) => `${point.x.toFixed(1)},${y(point.low).toFixed(1)}`),
  ].join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      <line x1={padX} y1={y(goal)} x2={width - padX} y2={y(goal)} stroke="#a5b4fc" strokeDasharray="4 4" strokeWidth={1} />
      <text x={width - padX} y={y(goal) - 5} textAnchor="end" fontSize="9" fill="#6366f1">
        mastery target {(goal * 100).toFixed(0)}%
      </text>
      {band ? <polygon points={band} fill="#6366f1" opacity={0.14} /> : null}
      <polyline points={line} fill="none" stroke="#4f46e5" strokeWidth={2.4} strokeLinecap="round" />
      {projectionPoints.length ? (
        <polyline points={projectionLine} fill="none" stroke="#0ea5e9" strokeWidth={2.2} strokeDasharray="5 4" />
      ) : null}
      {historyPoints.map((point) => (
        <circle key={`h-${point.label}`} cx={point.x} cy={point.y} r={3} fill="#4f46e5" />
      ))}
      {projectionPoints.map((point) => (
        <circle key={`p-${point.label}`} cx={point.x} cy={point.y} r={3} fill="#0ea5e9" />
      ))}
      {historyPoints.map((point, index) =>
        index % Math.ceil(historyPoints.length / 6 || 1) === 0 ? (
          <text key={`l-${point.label}`} x={point.x} y={height - 4} textAnchor="middle" fontSize="9" fill="#94a3b8">
            {point.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export function RadialGauge({
  value,
  label,
  sublabel,
  tone = "#4f46e5",
  size = 128,
}: {
  value: number;
  label: string;
  sublabel?: string;
  tone?: string;
  size?: number;
}) {
  const radius = size / 2 - 10;
  const circumference = 2 * Math.PI * radius;
  const dash = Math.max(0, Math.min(1, value)) * circumference;
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={9} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone}
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="47%" textAnchor="middle" fontSize="20" fontWeight="600" fill="#0f172a">
          {(value * 100).toFixed(0)}%
        </text>
        <text x="50%" y="62%" textAnchor="middle" fontSize="9" fill="#64748b">
          {label}
        </text>
      </svg>
      {sublabel ? <p className="mt-1 text-center text-[11px] text-slate-500">{sublabel}</p> : null}
    </div>
  );
}

export function MasteryGrid({
  items,
}: {
  items: { label: string; value: number; secondary?: string }[];
}) {
  const tone = (value: number) => {
    if (value >= 0.85) return "#059669";
    if (value >= 0.65) return "#0284c7";
    if (value >= 0.4) return "#d97706";
    return "#e11d48";
  };
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-lg border border-slate-200 bg-white p-2.5"
          style={{ borderLeft: `3px solid ${tone(item.value)}` }}
        >
          <p className="truncate text-[11px] font-medium text-slate-600" title={item.label}>
            {item.label}
          </p>
          <p className="mt-1 text-sm font-semibold" style={{ color: tone(item.value) }}>
            {(item.value * 100).toFixed(0)}%
          </p>
          {item.secondary ? <p className="text-[10px] text-slate-400">{item.secondary}</p> : null}
        </div>
      ))}
    </div>
  );
}
