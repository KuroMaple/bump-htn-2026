import { useMemo } from "react";
import { createTilePattern } from "../lib/tile";

interface MandalaIconProps {
  size?: number;
  seed?: string;
  loading?: boolean;
  label?: string;
}

export function MandalaIcon({
  size = 36,
  seed = "bump-brand-mandala",
  loading = false,
  label,
}: MandalaIconProps) {
  const pattern = useMemo(
    () => createTilePattern(seed),
    [seed],
  );

  const background = "#243C73";
  const motif = "#FF8FC7";

  return (
    <svg
      className={
        loading
          ? "mandala-icon mandala-icon--loading"
          : "mandala-icon"
      }
      width={size}
      height={size}
      viewBox="0 0 8 8"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <rect
        width="8"
        height="8"
        fill={background}
      />

      {pattern.cells.map((row, y) =>
        row.map((active, x) =>
          active ? (
            <circle
              key={`${x}-${y}`}
              cx={x + 0.5}
              cy={y + 0.5}
              r="0.46"
              fill={motif}
            />
          ) : null,
        ),
      )}
    </svg>
  );
}
