"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => undefined;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  return (
    <ToggleGroup
      type="single"
      className="theme-toggle"
      onValueChange={(value) => value && setTheme(value)}
      value={mounted ? (theme ?? "") : ""}
      aria-label="Appearance"
    >
      <ToggleGroupItem value="light" aria-label="Use light appearance">Light</ToggleGroupItem>
      <ToggleGroupItem value="dark" aria-label="Use dark appearance">Dark</ToggleGroupItem>
      <ToggleGroupItem value="system" aria-label="Follow system appearance">System</ToggleGroupItem>
    </ToggleGroup>
  );
}
