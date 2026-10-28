import { cn } from "@/lib/cn";

export function Card({ title, children }: { title: string; children?: unknown }) {
  return (
    <section className={cn("card")}>
      <h2>{title}</h2>
      {children as never}
    </section>
  );
}
