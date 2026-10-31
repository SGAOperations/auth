"use client";

import { Button } from "@/components/ui/button";
import { useMotionPreference } from "@/hooks/use-motion-preference";

// WCAG 2.2.2: the backdrop moves continuously, so it gets a visible pause.
export function MotionToggle() {
  const { prefersReduced, paused, setPaused } = useMotionPreference();
  // The OS setting already stills everything.
  if (prefersReduced) return null;
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="min-h-11 text-muted-foreground"
      onClick={() => setPaused(!paused)}
    >
      {paused ? "Play motion" : "Pause motion"}
    </Button>
  );
}
