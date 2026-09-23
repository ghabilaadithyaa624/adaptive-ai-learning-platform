import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "AdaptiQ · Adaptive AI learning platform",
  description:
    "Adaptive AI learning platform with knowledge tracing, knowledge-gap detection, difficulty prediction, learning-path generation and performance forecasting.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f6f7fb] font-sans text-slate-900 antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
