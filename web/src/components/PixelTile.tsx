import { useMemo } from "react";
import { createTilePattern } from "../lib/tile";

interface PixelTileProps {
  seed: string;
  size?: number;
  label?: string;
}

export function PixelTile({ seed, size = 72, label }: PixelTileProps) {
  const pattern = useMemo(() => createTilePattern(seed), [seed]);
  const pixels = pattern.cells.flatMap((row, y) =>
    row.flatMap((value, x) =>
      value === 0
        ? []
        : [
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width="1"
              height="1"
              fill={pattern.palette[value - 1]}
            />,
          ],
    ),
  );

  return (
    <svg
      className="pixel-tile"
      width={size}
      height={size}
      viewBox="0 0 10 10"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      shapeRendering="crispEdges"
    >
      <rect width="10" height="10" fill="#151129" />
      {pixels}
    </svg>
  );
}
