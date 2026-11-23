"use client";

import { generatePerformanceCsv } from "@/lib/export-csv";
import { AgentTradeResult } from "@/lib/agents/performance";

export function CsvDownloadButton({ results, filename }: { results: AgentTradeResult[], filename: string }) {
  const download = () => {
    const csv = generatePerformanceCsv(results);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  return (
    <button 
        onClick={download} 
        className="border border-pv-ink/[0.14] px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-pv-text transition-colors hover:border-pv-emerald/45 hover:text-pv-emerald"
    >
      Download Performance CSV
    </button>
  );
}
