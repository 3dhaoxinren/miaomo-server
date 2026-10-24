import type { Metadata } from "next";
import { Suspense } from "react";
import { Navbar } from "@/components/navbar";
import { localeForRequest } from "@/lib/locale-server";
import "./globals.css";

const baseMetadata: Metadata = {
  title: "InkSight · 本地相框",
  description: "在你的网络里管理相框、轮播、日历和墨水屏设备。",
  keywords: ["InkSight", "墨鱼AI墨水屏", "墨鱼", "电子墨水屏", "E-Ink", "ESP32", "LLM", "桌面摆件"],
  manifest: "/manifest.json",
  other: {
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
    "mobile-web-app-capable": "yes",
  },
};

export async function generateMetadata(): Promise<Metadata> {
  const locale = await localeForRequest();
  return {
    ...baseMetadata,
    title: locale === "en" ? "InkSight · Local Frame" : "InkSight · 本地相框",
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await localeForRequest();
  const lang = locale === "en" ? "en-US" : "zh-CN";

  return (
    <html lang={lang}>
      <body className="antialiased">
        <Suspense fallback={null}>
          <Navbar />
        </Suspense>
        <main id="workspace" className="local-main">{children}</main>
      </body>
    </html>
  );
}
