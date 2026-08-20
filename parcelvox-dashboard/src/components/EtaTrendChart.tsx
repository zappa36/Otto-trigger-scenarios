import { ETA_TREND } from '../data/analytics';

/** Plot area inside the 520×200 viewBox. */
const TOP = 20;
const BOTTOM = 170;
const LEFT = 36;
const RIGHT = 504;
/** Pixels per accuracy point — four points every fifty pixels. */
const PX_PER_POINT = 12.5;

const toY = (value: number) => TOP + (ETA_TREND.axis[0] - value) * PX_PER_POINT;

interface EtaTrendChartProps {
  className?: string;
  /** Draw the latest value beside the end of the line. */
  showLatestLabel?: boolean;
}

export function EtaTrendChart({ className, showLatestLabel = true }: EtaTrendChartProps) {
  const points = ETA_TREND.values.map((value, i) => [ETA_TREND.x[i], toY(value)] as const);
  const linePath = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
  const areaPath = `${linePath} L${RIGHT} ${BOTTOM} L${LEFT} ${BOTTOM} Z`;
  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg
      className={className}
      viewBox="0 0 520 200"
      role="img"
      aria-label={`ETA accuracy over eight weeks, rising from ${ETA_TREND.values[0]}% to ${ETA_TREND.latestLabel}`}
    >
      <path
        d={ETA_TREND.axis.map((value) => `M${LEFT} ${toY(value)} H${RIGHT}`).join(' ')}
        stroke="var(--pv-line-soft)"
        strokeWidth={1}
      />
      {ETA_TREND.axis.map((value) => (
        <text
          key={value}
          x={30}
          y={toY(value) + 4}
          textAnchor="end"
          fontSize={10.5}
          fill="var(--pv-muted-3)"
          fontFamily="Inter, sans-serif"
        >
          {value}
        </text>
      ))}

      <path d={areaPath} fill="var(--pv-mint)" />
      <path
        d={linePath}
        fill="none"
        stroke="var(--pv-green)"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r={4} fill="var(--pv-green)" stroke="#FFFFFF" strokeWidth={2} />

      {showLatestLabel && (
        <text
          x={500}
          y={28}
          textAnchor="end"
          fontSize={11.5}
          fontWeight={700}
          fill="var(--pv-green-dark)"
          fontFamily="Inter, sans-serif"
        >
          {ETA_TREND.latestLabel}
        </text>
      )}

      {ETA_TREND.weeks.map((week, i) =>
        ETA_TREND.labelledWeeks.includes(week) ? (
          <text
            key={week}
            x={ETA_TREND.x[i]}
            y={192}
            textAnchor="middle"
            fontSize={10.5}
            fill="var(--pv-muted-3)"
            fontFamily="Inter, sans-serif"
          >
            {week}
          </text>
        ) : null,
      )}
    </svg>
  );
}
