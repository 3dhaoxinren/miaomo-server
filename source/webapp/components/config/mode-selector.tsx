"use client";

import { useState } from "react";
import { ChevronDown, Eye, LayoutGrid, Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ColorSelect } from "@/components/ui/color-select";
import { ScreenSizeSelect } from "@/components/ui/screen-size-select";

type ModeMeta = Record<string, { name: string; tip: string }>;

type ModeSelectorProps = {
  tr: (zh: string, en: string) => string;
  selectedModes: Set<string>;
  customModes: string[];
  customModeMeta: ModeMeta;
  modeMeta: ModeMeta;
  coreModes: string[];
  extraModes: string[];
  handleModePreview: (mode: string) => void;
  handleModeApply: (mode: string) => void;
  handleCustomModeDelete: (mode: string) => void;
  onCreateCustomMode: () => void;
  previewColors?: number;
  onColorsChange?: (v: number) => void;
  previewWidth?: number;
  previewHeight?: number;
  onScreenSizeChange?: (w: number, h: number) => void;
};

export function ModeSelector({
  tr,
  selectedModes,
  customModes,
  customModeMeta,
  modeMeta,
  coreModes,
  extraModes,
  handleModePreview,
  handleModeApply,
  handleCustomModeDelete,
  onCreateCustomMode,
  previewColors,
  onColorsChange,
  previewWidth = 400,
  previewHeight = 300,
  onScreenSizeChange,
}: ModeSelectorProps) {
  const [query, setQuery] = useState("");
  const matches = (mode: string) => { const meta = modeMeta[mode] || customModeMeta[mode]; return `${mode} ${meta?.name || ""} ${meta?.tip || ""}`.toLowerCase().includes(query.toLowerCase().trim()); };
  const found = [...coreModes, ...extraModes, ...customModes].some(matches);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <LayoutGrid size={18} /> {tr("内容模式", "Content Modes")}
          </CardTitle>
          {onColorsChange && previewColors !== undefined && (
            <ColorSelect value={previewColors} onChange={onColorsChange} tr={tr} />
          )}
          {onScreenSizeChange && previewWidth !== undefined && previewHeight !== undefined && (
            <ScreenSizeSelect width={previewWidth} height={previewHeight} onChange={onScreenSizeChange} tr={tr} />
          )}
        </div>
      </CardHeader>
      <CardContent>
        <label className="block mb-5"><span className="sr-only">{tr("搜索内容", "Search content")}</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("搜索日历、天气、便签…", "Search calendar, weather, notes…")} className="w-full border border-ink/15 bg-paper px-4 py-3 text-sm rounded-xl" /></label>
        {!found && <p className="text-sm text-ink-light py-4">{tr("没有找到相关内容，试试其他关键词。", "No matching content. Try another keyword.")}</p>}
        <ModeGrid
          tr={tr}
          title={tr("日常内容", "Everyday content")}
          modes={coreModes.filter(matches)}
          selectedModes={selectedModes}
          onPreview={handleModePreview}
          onApply={handleModeApply}
          modeMeta={modeMeta}
        />
        <ModeGrid
          tr={tr}
          title={tr("更多灵感", "More to explore")}
          modes={extraModes.filter(matches)}
          selectedModes={selectedModes}
          onPreview={handleModePreview}
          onApply={handleModeApply}
          modeMeta={modeMeta}
        />
        <ModeGrid
          tr={tr}
          title={tr("自定义模式", "Custom Modes")}
          modes={customModes.filter(matches)}
          selectedModes={selectedModes}
          onPreview={handleModePreview}
          onApply={handleModeApply}
          onDelete={handleCustomModeDelete}
          modeMeta={{ ...modeMeta, ...customModeMeta }}
          tailItem={
            <button
              onClick={onCreateCustomMode}
              className="rounded-sm border border-dashed border-ink/20 bg-white px-3 py-2 min-h-[64px] flex flex-col items-center justify-center text-ink-light hover:border-ink/40 hover:bg-paper-dark transition-colors"
              title={tr("新建自定义模式", "Create custom mode")}
            >
              <Plus size={18} className="mb-1" />
              <div className="text-[11px]">{tr("新建", "New")}</div>
            </button>
          }
        />
      </CardContent>
    </Card>
  );
}

function ModeGrid({
  tr,
  title,
  modes,
  selectedModes,
  onPreview,
  onApply,
  onDelete,
  modeMeta,
  tailItem,
}: {
  tr: (zh: string, en: string) => string;
  title: string;
  modes: string[];
  selectedModes: Set<string>;
  onPreview: (mode: string) => void;
  onApply: (mode: string) => void;
  onDelete?: (mode: string) => void;
  modeMeta: ModeMeta;
  tailItem?: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (modes.length === 0 && !tailItem) return null;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between gap-2 mb-3 rounded-sm bg-paper-dark border border-ink/10 px-3 py-2">
        <h4 className="text-base font-semibold text-ink">{title}</h4>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-xs text-ink-light hover:text-ink flex items-center gap-1 transition-colors min-h-11"
        >
          {collapsed ? tr("展开", "Expand") : tr("收起", "Collapse")}
          <ChevronDown size={14} className={`transition-transform ${collapsed ? "" : "rotate-180"}`} />
        </button>
      </div>

      {collapsed ? null : (
        <div className="grid grid-cols-2 gap-3">
          {modes.map((mode) => {
            const meta = modeMeta[mode] || { name: mode, tip: "" };
            const isSelected = selectedModes.has(mode);

            return (
              <div key={mode} className="rounded-sm border border-ink/10 bg-white overflow-hidden">
                <button
                  onClick={() => onApply(mode)}
                  className={`w-full px-3 py-2 text-left transition-colors min-h-[64px] flex flex-col justify-center ${
                    isSelected ? "bg-ink text-white" : "hover:bg-paper-dark text-ink"
                  }`}
                  title={meta.tip}
                >
                  <div className="text-sm font-semibold">{meta.name}</div>
                  <div className={`text-[11px] mt-0.5 line-clamp-2 ${isSelected ? "text-white/80" : "text-ink-light"}`}>
                    {meta.tip}
                  </div>
                </button>

                <div className={`border-t border-ink/10 grid ${onDelete ? "grid-cols-5" : "grid-cols-4"}`}>
                  <button
                    onClick={() => onPreview(mode)}
                    className="col-span-2 min-h-11 px-2 text-[11px] sm:text-xs text-ink hover:bg-ink hover:text-white transition-colors flex items-center justify-center gap-1 whitespace-nowrap"
                    aria-label={tr(`预览${meta.name}`, `Preview ${meta.name}`)} title="预览"
                  >
                    <Eye size={14} />
                  </button>
                  <button
                    onClick={() => onApply(mode)}
                    className="col-span-2 min-h-11 px-2 text-[11px] sm:text-xs text-ink hover:bg-ink hover:text-white transition-colors flex items-center justify-center gap-1 whitespace-nowrap"
                    title={isSelected ? "移出轮播" : "加入轮播"}
                  >
                    {isSelected ? "-" : "+"}
                  </button>
                  {onDelete ? (
                    <button
                      onClick={() => onDelete(mode)}
                      className="min-h-11 px-2 text-[11px] sm:text-xs text-ink hover:bg-red-600 hover:text-white transition-colors flex items-center justify-center"
                      title={tr("删除模式", "Delete mode")}
                    >
                      <Trash2 size={14} />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
          {tailItem ? tailItem : null}
        </div>
      )}
    </div>
  );
}
