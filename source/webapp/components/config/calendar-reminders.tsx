"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";

interface CalendarRemindersProps {
  reminders: Record<string, string>;
  onChange: (reminders: Record<string, string>) => void;
  tr: (zh: string, en: string) => string;
}

const MONTH_NAMES_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function CalendarReminders({ reminders, onChange, tr }: CalendarRemindersProps) {
  const isEn = tr("zh", "en") === "en";
  const now = useMemo(() => new Date(), []);
  const [draftMonth, setDraftMonth] = useState(now.getMonth() + 1);
  const [draftDay, setDraftDay] = useState(now.getDate());
  const [draftText, setDraftText] = useState("");

  const maxDay = DAYS_IN_MONTH[draftMonth - 1] || 31;

  const handleAdd = useCallback(() => {
    if (!draftText.trim()) return;
    const day = Math.min(draftDay, maxDay);
    const key = `${draftMonth}-${day}`;
    onChange({ ...reminders, [key]: draftText.trim() });
    setDraftText("");
  }, [draftMonth, draftDay, maxDay, draftText, onChange, reminders]);

  const handleDelete = useCallback(
    (key: string) => {
      const next = { ...reminders };
      delete next[key];
      onChange(next);
    },
    [onChange, reminders],
  );

  const sorted = Object.entries(reminders).sort(([a], [b]) => {
    const [am, ad] = a.split("-").map(Number);
    const [bm, bd] = b.split("-").map(Number);
    return am !== bm ? am - bm : ad - bd;
  });

  const formatKey = (key: string) => {
    const [m, d] = key.split("-").map(Number);
    if (isEn) return `${MONTH_NAMES_EN[m - 1]} ${d}`;
    return `${m}月${d}日`;
  };

  return (
    <div className="min-w-0 w-full border border-ink/10 rounded-md p-3 space-y-3">
      <div className="text-xs font-medium text-ink/70">{tr("日历提醒", "Calendar Reminders")}</div>
      {sorted.length > 0 && (
        <div className="space-y-1">
          {sorted.map(([key, text]) => (
            <div key={key} className="flex items-center gap-2 text-xs">
              <span className="text-ink/60 min-w-[48px]">{formatKey(key)}</span>
              <span className="flex-1 min-w-0 break-words">{text}</span>
              <button
                type="button"
                onClick={() => handleDelete(key)}
                aria-label={tr(`删除 ${text}`, `Delete ${text}`)}
                className="text-ink-light hover:text-ink min-w-11 min-h-11 flex items-center justify-center"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 min-w-0">
        <select
          value={draftMonth}
          aria-label={tr("月份", "Month")}
          onChange={(e) => setDraftMonth(Number(e.target.value))}
          className="w-full min-w-0 border border-ink/20 rounded px-3 py-2 text-sm bg-white"
        >
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {isEn ? MONTH_NAMES_EN[i] : `${i + 1}月`}
            </option>
          ))}
        </select>
        <select
          value={Math.min(draftDay, maxDay)}
          aria-label={tr("日期", "Day")}
          onChange={(e) => setDraftDay(Number(e.target.value))}
          className="w-full min-w-0 border border-ink/20 rounded px-3 py-2 text-sm bg-white"
        >
          {Array.from({ length: maxDay }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {isEn ? `${i + 1}` : `${i + 1}日`}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          placeholder={tr("提醒内容", "Reminder")}
          aria-label={tr("提醒内容", "Reminder")}
          maxLength={20}
          className="col-span-2 min-w-0 w-full border border-ink/20 rounded px-3 py-2 text-sm bg-white"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={handleAdd}
          disabled={!draftText.trim()}
          className="col-span-2 w-full px-3 text-sm"
        >
          <Plus className="w-3 h-3 mr-1" />
          {tr("添加", "Add")}
        </Button>
      </div>
    </div>
  );
}
