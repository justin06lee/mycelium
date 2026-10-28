import { Card } from "@/components";
import { SettingsDialog } from "@/settings/SettingsDialog";

export default function Home() {
  return (
    <Card title="Settings">
      <SettingsDialog />
    </Card>
  );
}
