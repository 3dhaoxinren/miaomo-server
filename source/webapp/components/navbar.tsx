"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Image as ImageIcon, ListVideo, LayoutGrid, Monitor, SlidersHorizontal, BookOpen } from "lucide-react";
import { localeFromPathname, withLocalePath } from "@/lib/i18n";
const sections = [
  { id: "frame", name: "相框", en: "Frame", icon: ImageIcon },
  { id: "rotation", name: "轮播", en: "Rotation", icon: ListVideo },
  { id: "content", name: "内容", en: "Library", icon: LayoutGrid },
  { id: "devices", name: "设备", en: "Devices", icon: Monitor },
  { id: "settings", name: "设置", en: "Settings", icon: SlidersHorizontal },
] as const;
export function Navbar() {
  const pathname = usePathname();
  const params = useSearchParams();
  const locale = localeFromPathname(pathname || "/");
  const isEn = locale === "en";
  const isWorkspace = /^\/(?:zh|en)?\/?(?:config)?$/.test(pathname || "/");
  const active = isWorkspace ? params.get("section") || "frame" : "settings";
  if (pathname?.endsWith("/widget")) return null;
  const href = (section: string) => {
    const next = new URLSearchParams(params);
    next.set("section", section);
    return `${isWorkspace ? pathname : withLocalePath(locale, "/")}?${next.toString()}`;
  };
  return <>
    <a href="#workspace" className="skip-link">{isEn ? "Skip to content" : "跳到内容"}</a>
    <aside className="local-sidebar">
      <Link href={withLocalePath(locale, "/")} className="local-brand" aria-label="InkSight 首页">
        <ImageIcon size={27} strokeWidth={1.7} /><span><strong>InkSight</strong><small>{isEn ? "A little space for life" : "把日常，留在画面里"}</small></span>
      </Link>
      <nav aria-label={isEn ? "Main navigation" : "主导航"} className="local-nav">
        {sections.map(({ id, name, en, icon: Icon }) => <Link key={id} href={href(id)} scroll={false} aria-current={active === id ? "page" : undefined}><Icon size={21} strokeWidth={1.7} /><span>{isEn ? en : name}</span></Link>)}
      </nav>
      <div className="sidebar-bottom"><Link href={withLocalePath(locale, "/docs")}><BookOpen size={17} />{isEn ? "Help & guide" : "使用指南"}</Link><p>{isEn ? "Local edition" : "本地版"}<span>InkSight</span></p></div>
    </aside>
    <header className="local-mobile-header"><Link href={withLocalePath(locale, "/")}><ImageIcon size={22} /><strong>InkSight</strong></Link><span>{isEn ? "Local edition" : "本地版"}</span></header>
  </>;
}
