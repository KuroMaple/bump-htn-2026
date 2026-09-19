import { MandalaIcon } from "./MandalaIcon";

interface LoadingMandalaProps {
  size?: number;
  text?: string;
}

export function LoadingMandala({
  size = 42,
  text = "Loading",
}: LoadingMandalaProps) {
  return (
    <div
      className="loading-mandala"
      role="status"
      aria-live="polite"
    >
      <MandalaIcon
        size={size}
        seed="bump-loading-mandala"
        loading
      />

      <span className="loading-mandala__text">
        {text}
      </span>
    </div>
  );
}