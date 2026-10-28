import { cn } from "../lib/cn";

export function ToggleSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return <button className={cn("toggle", on && "toggle-on")} onClick={() => onChange(!on)} />;
}
