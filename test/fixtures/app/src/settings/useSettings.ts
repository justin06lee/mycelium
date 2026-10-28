import { defaults } from "./defaults";

export function useSettings() {
  return { values: defaults, set: (_key: string, _on: boolean) => {} };
}
