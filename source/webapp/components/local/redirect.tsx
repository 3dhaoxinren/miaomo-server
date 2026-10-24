"use client";
import { Suspense, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { localeFromPathname, withLocalePath } from "@/lib/i18n";
function Redirect({ section }: { section: string }) {
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();
  const locale = localeFromPathname(pathname || "/");
  useEffect(() => { const next = new URLSearchParams(params); next.set("section", section); next.delete("next"); router.replace(`${withLocalePath(locale, "/")}?${next.toString()}`); }, [locale, params, router, section]);
  return <div className="local-workspace" role="status">{locale === "en" ? "Opening local workspace…" : "正在打开本地工作区…"}</div>;
}
export function LocalRedirect({ section }: { section: string }) { return <Suspense><Redirect section={section} /></Suspense>; }
