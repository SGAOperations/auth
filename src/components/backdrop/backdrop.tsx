import { DustField } from "@/components/backdrop/dust-field";
import { LightRays } from "@/components/backdrop/light-rays";

// Decorative only. body's bg-background propagates to the canvas, so this
// negative-z layer paints above the page colour and below the content.
export function Backdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden forced-colors:hidden print:hidden"
    >
      <LightRays />
      <DustField />
    </div>
  );
}
