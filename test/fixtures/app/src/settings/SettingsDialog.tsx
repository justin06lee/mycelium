import styles from "./SettingsDialog.module.css";
import badge from "./badge.module.css";
import { useSettings } from "./useSettings";
import { ToggleSwitch } from "@/components";
import { cn } from "@/lib/cn";

function Row({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={styles.row}>
      <span>{label}</span>
      <ToggleSwitch on={on} onChange={onChange} />
    </div>
  );
}

export function SettingsDialog() {
  const { values, set } = useSettings();
  return (
    <div className={cn(styles.dialog)}>
      <Row label="Sound" on={values.sound} onChange={(on) => set("sound", on)} />
      <Row label="Motion" on={values.motion} onChange={(on) => set("motion", on)} />
    </div>
  );
}

export function SettingsBadge({ count }: { count: number }) {
  return <span className={badge.badge}>{count}</span>;
}
