import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How Mimir Works",
  description: "Learn how Mimir creates, evaluates, and settles prediction challenges.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}