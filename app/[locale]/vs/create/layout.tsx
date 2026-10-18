import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create a Challenge",
  description: "Set the terms, stake, and resolution source for a new Mimir prediction challenge.",
};

export default function CreateLayout({ children }: { children: React.ReactNode }) {
  return children;
}