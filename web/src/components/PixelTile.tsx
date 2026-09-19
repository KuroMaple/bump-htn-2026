import { useMemo } from "react";
import { createTilePattern } from "../lib/tile";

interface PixelTileProps {
  seed: string;
  size?: number;
  label?: string;
}

export function PixelTile({
  seed,
  size = 72,
  label,
}: PixelTileProps) {
  const pattern = useMemo(
    () => createTilePattern(seed),
    [seed],
  );

  const [background, motif] = pattern.palette;

  const dots = pattern.cells.flatMap((row, y) =>
    row.flatMap((value, x) =>
      value === 0
        ? []
        : [
            <circle
              key={`${x}-${y}`}
              cx={x + 0.5}
              cy={y + 0.5}
              r={0.46}
              fill={motif}
            />,
          ],
    ),
  );

  return (
    <svg
      className="pixel-tile"
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

      {dots}
    </svg>
  );
}