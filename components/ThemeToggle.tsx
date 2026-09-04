"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Monitor, Moon, Sun } from "lucide-react";
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
      <ToggleGroupItem value="light" aria-label="Use light appearance" title="Light appearance"><Sun /></ToggleGroupItem>
      <ToggleGroupItem value="dark" aria-label="Use dark appearance" title="Dark appearance"><Moon /></ToggleGroupItem>
      <ToggleGroupItem value="system" aria-label="Follow system appearance" title="Follow system appearance"><Monitor /></ToggleGroupItem>
    </ToggleGroup>
  );
}
