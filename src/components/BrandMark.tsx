export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }}>
      <img src="/RatLogo_white.png" width={size} height={size} alt="" aria-hidden="true" />
    </span>
  );
}

