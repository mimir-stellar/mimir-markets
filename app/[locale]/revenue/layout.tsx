import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Agent Revenue",
  description: "Track payments, earnings, and usage across Mimir's paid agent endpoints.",
};

export default function RevenueLayout({ children }: { children: React.ReactNode }) {
  return children;
}