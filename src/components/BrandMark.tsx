export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden>
      <rect width="36" height="36" rx="11" fill="#153C32" />
      <path
        d="M9 21.5c2.8-6.7 7.4-10 13.7-9.8 2.1.1 3.7.7 4.8 1.8-4.3.2-7.5 1.5-9.6 3.8-2.1 2.2-3.2 5.2-3.4 8.9-2.6-.4-4.5-2-5.5-4.7Z"
        fill="#D7F169"
      />
      <circle cx="25" cy="12.2" r="1.4" fill="#153C32" />
      <path d="M17.5 25.5c2.9-.1 5.7-1.2 8.4-3.1" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

