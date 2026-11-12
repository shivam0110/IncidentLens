import type { ComponentProps } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section data-slot="card" className={twMerge(clsx("rounded-xl border border-slate-200 bg-white p-6 shadow-sm", className))} {...props} />;
}
export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={twMerge(clsx("text-base font-semibold tracking-tight", className))} {...props} />;
}
