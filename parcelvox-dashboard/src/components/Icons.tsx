/** Icon set from the design file. All 20×20, stroked with currentColor unless noted. */

interface IconProps {
  size?: number;
}

const base = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false as const,
};

export function LogoMark({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden focusable={false}>
      <path
        d="M10 17.5s-5.5-4.6-5.5-8.7A5.5 5.5 0 0 1 15.5 8.8C15.5 12.9 10 17.5 10 17.5Z"
        stroke="#FFFFFF"
        strokeWidth={1.7}
        strokeLinejoin="round"
      />
      <path
        d="M8 8.8h.01M10 8.8h.01M12 8.8h.01"
        stroke="#FFFFFF"
        strokeWidth={2.1}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MapIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} {...base} strokeWidth={1.6}>
      <path d="M10 17.5s-5.5-4.6-5.5-8.7A5.5 5.5 0 0 1 15.5 8.8C15.5 12.9 10 17.5 10 17.5Z" />
      <circle cx="10" cy="8.8" r="1.9" />
    </svg>
  );
}

export function RoutesIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} {...base} strokeWidth={1.6}>
      <circle cx="4.5" cy="15.5" r="1.9" />
      <circle cx="15.5" cy="4.5" r="1.9" />
      <path d="M6.3 14.6c3.4-1 6.4-4 7.4-7.4" />
    </svg>
  );
}

export function QueueIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} {...base} strokeWidth={1.6}>
      <rect x="3" y="3.5" width="14" height="13" rx="2.5" />
      <path d="M3 11h3.4l1.4 2h4.4l1.4-2H17" />
    </svg>
  );
}

export function DriversIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} {...base} strokeWidth={1.6}>
      <circle cx="7.4" cy="7" r="2.5" />
      <path d="M3 16.2c.3-2.6 2.1-4.1 4.4-4.1s4.1 1.5 4.4 4.1" />
      <circle cx="14.2" cy="7.6" r="2" />
      <path d="M14 12.3c1.9.2 3.2 1.6 3.4 3.7" />
    </svg>
  );
}

export function AnalyticsIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} {...base} strokeWidth={1.8}>
      <path d="M4 16.5V10M10 16.5V3.5M16 16.5V7.5" />
    </svg>
  );
}

export function AskIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} {...base} strokeWidth={1.6}>
      <path d="M3.5 6.5a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H9.2l-3.7 3v-3h-.5a3 3 0 0 1-3-3Z" />
    </svg>
  );
}

/** The depot operator — a headset person, in green. */
export function OperatorIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden focusable={false}>
      <g stroke="#0E8A5C" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="8.2" r="2.6" />
        <path d="M5 16c1-2.2 2.9-3.4 5-3.4s4 1.2 5 3.4" />
        <path d="M5.2 8.2a4.8 4.8 0 0 1 9.6 0" />
      </g>
      <rect x="3.9" y="7.4" width="1.9" height="3.1" rx="0.95" fill="#0E8A5C" />
      <rect x="14.2" y="7.4" width="1.9" height="3.1" rx="0.95" fill="#0E8A5C" />
    </svg>
  );
}

export function KeyboardIcon({ size = 17 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden focusable={false}>
      <g stroke="#5B6660" strokeWidth={1.5} strokeLinecap="round">
        <rect x="2.5" y="5" width="15" height="10" rx="2" />
        <path d="M5.5 8h.01M8.5 8h.01M11.5 8h.01M14.5 8h.01M6.5 12h7" />
      </g>
    </svg>
  );
}

export function CloseIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden focusable={false}>
      <path d="M5 5l10 10M15 5L5 15" stroke="#5B6660" strokeWidth={1.7} strokeLinecap="round" />
    </svg>
  );
}

export function MicIcon({ size = 17 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden focusable={false}>
      <g stroke="#0E8A5C" strokeWidth={1.7} strokeLinecap="round">
        <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
        <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
      </g>
    </svg>
  );
}

export function SendIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="#FFFFFF" aria-hidden focusable={false}>
      <path d="M3 10 L17 3.5 L13 16.5 L10.2 11.6 L3 10 Z" />
    </svg>
  );
}
