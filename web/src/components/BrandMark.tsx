import { MandalaIcon } from "./MandalaIcon";

interface BrandMarkProps {
  size?: number;
}

export function BrandMark({
  size = 50,
}: BrandMarkProps) {
  return (
    <div className="brand-mark">
      <MandalaIcon
        size={size}
        seed="bump-brand-logo"
        label="Bump"
      />

      <span className="brand-mark__name">
        Bump
      </span>
    </div>
  );
}
