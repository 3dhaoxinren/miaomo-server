"use client";

import { useEffect, useLayoutEffect, useState, useCallback, Suspense, useMemo, useRef } from "react";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { FramePanel } from "@/components/local/frame-panel";
import { RotationQueue } from "@/components/local/rotation-queue";
import { SettingsPanel } from "@/components/local/settings-panel";
import { TemplateLibrary } from "@/components/local/template-library";
import { DeviceHistory } from "@/components/local/device-history";
import { LocationPicker } from "@/components/config/location-picker";
import { ModeSelector } from "@/components/config/mode-selector";
import { ModeComposer, type ComposerPropMeta, type ComposerCatalog, type ComposerFragmentState, type ComposerState, withPropDefaults, findCatalogItem, randomComposerId } from "@/components/config/mode-composer";
import { EInkPreviewPanel } from "@/components/config/eink-preview-panel";
import { PhotoEditor } from "@/components/config/photo-editor";
import { exportedPhotoEdit, newPhotoEdit, readPhotoEdit, photoGeometryIdentity, samePhotoGeometry, type PhotoEdit } from "@/lib/photo-editor";
import { localPhotoSource } from "@/lib/local-photo-source";
import { mergePhotoDraft, photoPreviewIdentity, singlePhotoOverride } from "@/lib/photo-workspace";
import { browserPhotoColorIO, loadPhotoImage, PhotoColorError, previewPhotoFilter } from "@/lib/photo-color-profile";
import { CalendarReminders } from "@/components/config/calendar-reminders";
import { TimetableEditor, type TimetableData } from "@/components/config/timetable-editor";
import { RefreshStrategyEditor, TimeSlotRule } from "@/components/config/refresh-strategy-editor";
import { Field, StatCard } from "@/components/config/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  BarChart3,
  RefreshCw,
  Save,
  AlertCircle,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { authHeaders } from "@/lib/auth";
import { localeFromPathname, withLocalePath } from "@/lib/i18n";
import {
  buildLocationValue,
  cleanLocationValue,
  describeLocation,
  extractLocationValue,
  locationsEqual,
  type LocationValue,
} from "@/lib/locations";

interface UserDevice {
  mac: string;
  nickname: string;
  bound_at: string;
  last_seen: string | null;
  role?: string;
  status?: string;
}

type ModeCatalogItem = {
  mode_id: string;
  category: "core" | "more" | "custom" | string;
  source?: string;
  display_name?: string;
  description?: string;
  settings_schema?: ModeSettingSchemaItem[];
  i18n?: {
    zh?: { name?: string; tip?: string };
    en?: { name?: string; tip?: string };
  };
};

const STRATEGIES: Record<string, string> = {
  random: "从已启用的模式中随机选取",
  cycle: "按顺序循环切换已启用的模式",
  time_slot: "根据时间段显示不同内容模式",
  smart: "根据时间段自动匹配最佳模式",
};

const MODE_LANGUAGE_OPTIONS = [
  { value: "zh", label: "中文", labelEn: "Chinese" },
  { value: "en", label: "English", labelEn: "English" },
] as const;

const TONE_OPTIONS = [
  { value: "positive", label: "积极鼓励" },
  { value: "neutral", label: "中性克制" },
  { value: "deep", label: "深沉内省" },
  { value: "humor", label: "轻松幽默" },
] as const;
const PERSONA_PRESETS = ["鲁迅", "王小波", "JARVIS", "苏格拉底", "村上春树"] as const;

import { calculateBatteryPct, queueImmediateRefreshIfOnline } from "@/lib/device-utils";

function normalizeTone(v: unknown): string {
  if (typeof v !== "string") return "neutral";
  if (v === "positive" || v === "neutral" || v === "deep" || v === "humor") return v;
  const found = TONE_OPTIONS.find((x) => x.label === v);
  return found?.value || "neutral";
}


function normalizeModeIdFromName(name: string) {
  let modeId = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!modeId) modeId = `CUSTOM_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  if (!/^[A-Z]/.test(modeId)) modeId = `CUSTOM_${modeId}`;
  return modeId;
}

function fallbackValueForField(fieldName: string) {
  const cleaned = fieldName.trim();
  if (!cleaned) return "Sample";
  return cleaned
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function defaultComposerState(catalog: ComposerCatalog | null): ComposerState {
  const defaultPreset = catalog?.presets?.[0]?.name || "";
  const defaultPresetMeta = catalog?.presets?.[0];
  const defaultFragment = catalog?.fragments?.[0];
  const defaultFragmentStack = Object.fromEntries(
    (catalog?.fragment_stack?.props || []).flatMap((prop) => (prop.default !== undefined ? [[prop.name, prop.default]] : [])),
  );
  return {
    layoutKind: "preset",
    bodyPreset: defaultPreset,
    presetProps: withPropDefaults({}, defaultPresetMeta?.props),
    fragments: defaultFragment
      ? [
          {
            id: randomComposerId(),
            fragment: defaultFragment.name,
            props: withPropDefaults({}, defaultFragment.props),
          },
        ]
      : [],
    fragmentStack: defaultFragmentStack,
    prompt: "",
    cacheable: true,
  };
}

function collectComposerFieldNames(
  composer: ComposerState,
  catalog: ComposerCatalog | null,
) {
  const names = new Set<string>();
  const collect = (metas: ComposerPropMeta[] | undefined, props: Record<string, unknown>) => {
    for (const meta of metas || []) {
      if (meta.value_kind !== "field") continue;
      const value = props[meta.name];
      if (typeof value === "string" && value.trim()) names.add(value.trim());
    }
  };
  if (composer.layoutKind === "preset") {
    const preset = findCatalogItem(catalog?.presets, composer.bodyPreset);
    collect(preset?.props, composer.presetProps);
  } else {
    for (const fragment of composer.fragments) {
      const item = findCatalogItem(catalog?.fragments, fragment.fragment);
      collect(item?.props, fragment.props);
    }
  }
  if (names.size === 0) names.add("text");
  return Array.from(names);
}

const FIELD_HINT_ZH: Record<string, string> = {
  title: "标题（简短有力）",
  subtitle: "副标题",
  meta: "元信息（如分类、来源等简短标注）",
  body: "正文内容",
  text: "正文内容",
  quote: "一句引言或语录",
  author: "作者或来源署名",
  source: "来源出处",
  question: "一个引人思考的问题",
  answer: "问题的答案",
  hint: "提示或线索",
  note: "补充说明（简短）",
  word: "一个词语或短语",
  phonetic: "注音或音标",
  definition: "释义或解释",
  example: "一个例句或案例",
  greeting: "称呼语（如「亲爱的朋友：」）",
  closing: "落款（如「此致敬意」）",
  postscript: "附言（P.S.）",
  tip: "一条实用小建议",
  category: "分类标签",
  name: "名称",
  description: "简要描述",
  summary: "摘要",
  antidote: "应对建议或解决方法",
  message: "一段寄语",
};
const FIELD_HINT_EN: Record<string, string> = {
  title: "a short, punchy title",
  subtitle: "subtitle",
  meta: "brief meta info (category, source, etc.)",
  body: "main body text",
  text: "main body text",
  quote: "a quote or saying",
  author: "author or attribution",
  source: "source or origin",
  question: "a thought-provoking question",
  answer: "the answer",
  hint: "a hint or clue",
  note: "a brief supplementary note",
  word: "a word or short phrase",
  phonetic: "phonetic transcription",
  definition: "definition or explanation",
  example: "an example sentence or case",
  greeting: "greeting (e.g. 'Dear friend,')",
  closing: "closing (e.g. 'Best regards')",
  postscript: "postscript (P.S.)",
  tip: "a practical tip",
  category: "category label",
  name: "name",
  description: "brief description",
  summary: "summary",
  antidote: "advice or remedy",
  message: "a short message",
};

function buildComposerPrompt(prompt: string, fieldNames: string[], isEn: boolean) {
  const hints = isEn ? FIELD_HINT_EN : FIELD_HINT_ZH;
  const userPrompt = prompt.trim();
  const fieldDescs = fieldNames.map((f) => {
    const hint = hints[f];
    return hint ? `"${f}": ${hint}` : `"${f}": ...`;
  });
  const schema = `{ ${fieldNames.map((f) => `"${f}": "..."`).join(", ")} }`;

  if (isEn) {
    return [
      `You are a content creator for a small e-ink screen.`,
      userPrompt ? `Theme: ${userPrompt}` : `Generate concise, interesting content.`,
      `Return ONLY valid JSON with these fields:`,
      ...fieldDescs.map((d) => `  - ${d}`),
      `All values must be strings. Keep each field concise (suitable for a small screen).`,
      `Example format: ${schema}`,
      `You may use the following context for inspiration, but do NOT just describe it:`,
      `{context}`,
    ].join("\n");
  }
  return [
    `你是一个墨水屏内容创作者。`,
    userPrompt ? `主题：${userPrompt}` : `请生成简洁有趣的内容。`,
    `请只返回合法 JSON，包含以下字段：`,
    ...fieldDescs.map((d) => `  - ${d}`),
    `所有值必须是字符串。每个字段内容要简洁（适合小屏幕显示）。`,
    `格式示例：${schema}`,
    `以下环境信息仅供参考灵感，不要直接复述：`,
    `{context}`,
  ].join("\n");
}

function buildComposerModeDefinition(args: {
  composer: ComposerState;
  catalog: ComposerCatalog | null;
  modeName: string;
  modeDescription: string;
  isEn: boolean;
}) {
  const { composer, catalog, modeName, modeDescription, isEn } = args;
  const modeId = normalizeModeIdFromName(modeName || "Custom Mode");
  const displayName = modeName.trim() || modeId;
  const fieldNames = collectComposerFieldNames(composer, catalog);
  const outputSchema = Object.fromEntries(
    fieldNames.map((field) => [field, fallbackValueForField(field)]),
  );
  const fallback = Object.fromEntries(fieldNames.map((field) => [field, fallbackValueForField(field)]));
  const layout: Record<string, unknown> = {
    layout_engine: "component_tree",
    status_bar: { line_width: 1, dashed: false },
    footer: { label: modeId, attribution_template: "— InkSight" },
  };
  if (composer.layoutKind === "preset") {
    layout.body_preset = composer.bodyPreset;
    layout.preset_props = composer.presetProps;
  } else {
    layout.fragments = composer.fragments.map((fragment) => ({
      fragment: fragment.fragment,
      props: fragment.props,
    }));
    layout.fragment_stack = composer.fragmentStack;
  }
  return {
    mode_id: modeId,
    display_name: displayName,
    icon: "star",
    cacheable: composer.cacheable,
    description: modeDescription.trim() || composer.prompt.trim() || displayName,
    content: {
      type: "llm_json",
      prompt_template: buildComposerPrompt(composer.prompt, fieldNames, isEn),
      output_schema: outputSchema,
      temperature: 0.7,
      fallback,
    },
    layout,
  };
}

function parseComposerModeDefinition(
  raw: unknown,
  catalog: ComposerCatalog | null,
): { composer: ComposerState | null; error: string | null } {
  if (!raw || typeof raw !== "object") {
    return { composer: null, error: "Invalid mode definition" };
  }
  const modeDef = raw as Record<string, unknown>;
  const layout = (modeDef.layout && typeof modeDef.layout === "object") ? (modeDef.layout as Record<string, unknown>) : null;
  if (!layout || layout.layout_engine !== "component_tree") {
    return { composer: null, error: "Only component_tree preset/fragment layouts are supported in Composer." };
  }
  const content = (modeDef.content && typeof modeDef.content === "object") ? (modeDef.content as Record<string, unknown>) : null;
  const prompt = typeof content?.prompt_template === "string" ? content.prompt_template : "";
  const cacheable = modeDef.cacheable !== false;
  if (typeof layout.body_preset === "string" && layout.body_preset.trim()) {
    const presetName = layout.body_preset.trim();
    if (!findCatalogItem(catalog?.presets, presetName)) {
      return { composer: null, error: `Unsupported preset: ${presetName}` };
    }
    return {
      composer: {
        layoutKind: "preset",
        bodyPreset: presetName,
        presetProps: withPropDefaults(
          (layout.preset_props && typeof layout.preset_props === "object") ? (layout.preset_props as Record<string, unknown>) : {},
          findCatalogItem(catalog?.presets, presetName)?.props,
        ),
        fragments: [],
        fragmentStack: {},
        prompt,
        cacheable,
      },
      error: null,
    };
  }
  if (Array.isArray(layout.fragments)) {
    const fragments: ComposerFragmentState[] = [];
    for (const entry of layout.fragments) {
      if (!entry || typeof entry !== "object") {
        return { composer: null, error: "Unsupported fragment entry." };
      }
      const fragmentName = typeof (entry as Record<string, unknown>).fragment === "string"
        ? ((entry as Record<string, unknown>).fragment as string).trim()
        : "";
      const fragmentMeta = findCatalogItem(catalog?.fragments, fragmentName);
      if (!fragmentName || !fragmentMeta) {
        return { composer: null, error: `Unsupported fragment: ${fragmentName || "unknown"}` };
      }
      const props = "props" in (entry as Record<string, unknown>)
        ? (((entry as Record<string, unknown>).props && typeof (entry as Record<string, unknown>).props === "object")
            ? ((entry as Record<string, unknown>).props as Record<string, unknown>)
            : {})
        : Object.fromEntries(
            Object.entries(entry as Record<string, unknown>).filter(([key]) => key !== "fragment"),
          );
      fragments.push({
        id: randomComposerId(),
        fragment: fragmentName,
        props: withPropDefaults(props, fragmentMeta.props),
      });
    }
    return {
      composer: {
        layoutKind: "fragments",
        bodyPreset: catalog?.presets?.[0]?.name || "",
        presetProps: {},
        fragments,
        fragmentStack: withPropDefaults(
          (layout.fragment_stack && typeof layout.fragment_stack === "object") ? (layout.fragment_stack as Record<string, unknown>) : {},
          catalog?.fragment_stack?.props,
        ),
        prompt,
        cacheable,
      },
      error: null,
    };
  }
  return { composer: null, error: "Only body_preset or fragments layouts are supported in Composer." };
}

// Custom mode templates removed (AI-only creation)


interface DeviceConfig {
  timeSlotRules?: TimeSlotRule[];
  time_slot_rules?: TimeSlotRule[];
  mac?: string;
  screenSize?: string;
  screen_size?: string;
  modes?: string[];
  refreshStrategy?: string;
  refreshInterval?: number;
  refresh_strategy?: string;
  refresh_minutes?: number;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  admin1?: string;
  country?: string;
  language?: string;
  contentTone?: string;
  content_tone?: string;
  characterTones?: string[];
  character_tones?: string[];
  llmProvider?: string;
  llmModel?: string;
  llm_provider?: string;
  llm_model?: string;
  imageProvider?: string;
  imageModel?: string;
  image_provider?: string;
  image_model?: string;
  countdownEvents?: { name: string; date: string }[];
  countdown_events?: { name: string; date: string }[];
  memoText?: string;
  memo_text?: string;
  mode_overrides?: Record<string, ModeOverride>;
  modeOverrides?: Record<string, ModeOverride>;
  is_focus_listening?: boolean;
  focus_listening?: number;
  is_always_active?: boolean;
  always_active?: number | boolean;
}

interface ModeOverride {
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  admin1?: string;
  country?: string;
  llm_provider?: string;
  llm_model?: string;
  [key: string]: unknown;
}

type ParamModalType = "quote" | "weather" | "memo" | "countdown" | "habit" | "lifebar" | "calendar" | "timetable" | "vocab";
interface ParamModalState {
  type: ParamModalType;
  mode: string;
  action: "preview" | "apply";
}

interface ModeSettingSchemaItem {
  key: string;
  label: string;
  type?: "text" | "textarea" | "number" | "select" | "boolean";
  placeholder?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  description?: string;
  as_json?: boolean;
  options?: Array<{ value: string; label: string } | string>;
}

interface DeviceStats {
  total_renders?: number;
  cache_hit_rate?: number;
  last_battery_voltage?: number;
  last_rssi?: number;
  last_refresh?: string;
  error_count?: number;
  mode_frequency?: Record<string, number>;
}

type RuntimeMode = "active" | "interval" | "unknown";

function ConfigPageInner() {
  const pathname = usePathname();
  const locale = localeFromPathname(pathname || "/");
  const isEn = locale === "en";
  const tr = useCallback((zh: string, en: string) => (isEn ? en : zh), [isEn]);
  const searchParams = useSearchParams();
  const router = useRouter();
  const [selectedMac, setSelectedMac] = useState("");
  const mac = searchParams.get("mac") || selectedMac;
  const activeMacRef = useRef(mac);
  useEffect(() => { activeMacRef.current = mac; }, [mac]);
  const preferMac = searchParams.get("prefer_mac") || "";
  const section = ["frame", "rotation", "content", "devices", "settings"].includes(searchParams.get("section") || "") ? searchParams.get("section")! : "frame";
  const activeTab = section === "rotation" ? "preferences" : section === "devices" ? "stats" : "modes";
  const [userDevices, setUserDevices] = useState<UserDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState("");
  const [configError, setConfigError] = useState("");
  const [bindMacInput, setBindMacInput] = useState(preferMac);
  const [bindNicknameInput, setBindNicknameInput] = useState("");
  const [macAccessDenied, setMacAccessDenied] = useState(false);
  const [dirty, setDirtyState] = useState(false);
  const draftRevisionRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const setDirty = useCallback((value: boolean) => {
    if (value) draftRevisionRef.current += 1;
    setDirtyState(value);
  }, []);
  const finishSavedDraft = useCallback((revision: number) => {
    if (activeMacRef.current === mac && draftRevisionRef.current === revision) setDirty(false);
  }, [mac, setDirty]);
  const goSection = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("section", next);
    if (mac) params.set("mac", mac);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const chooseDevice = (value: string) => {
    if (dirty && !confirm(tr("有未保存的修改，切换设备会放弃这些修改。继续？", "Switching devices will discard unsaved changes. Continue?"))) return;
    activeMacRef.current = value;
    draftRevisionRef.current += 1;
    setDirty(false); setSelectedMac(value);
    const params = new URLSearchParams(searchParams); params.set("mac", value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    localStorage.setItem("inksight_local_device", value);
  };
  const loadUserDevices = useCallback(async () => {
    setDevicesLoading(true); setDevicesError("");
    try {
      const response = await fetch("/api/local/devices", { cache: "no-store" });
      if (!response.ok) throw new Error(tr("无法连接本地设备服务，请重试。", "Cannot load local devices. Please retry."));
      const data = await response.json();
      const devices = (data.devices || []) as UserDevice[];
      setUserDevices(devices);
      setSelectedMac((previous) => {
        const saved = previous || localStorage.getItem("inksight_local_device") || "";
        return devices.some((item) => item.mac === saved) ? saved : devices[0]?.mac || "";
      });
    } catch (error) { setDevicesError(error instanceof Error ? error.message : "Connection failed"); }
    finally { setDevicesLoading(false); }
  }, [tr]);
  useEffect(() => { void loadUserDevices(); }, [loadUserDevices]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const handleBindDevice = async () => {
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(bindMacInput.trim())) { showToast(tr("请输入完整的 MAC 地址", "Enter a complete MAC address"), "error"); return; }
    try {
      const response = await fetch("/api/local/devices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mac: bindMacInput.trim(), nickname: bindNicknameInput.trim() }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || data.detail || "Failed");
      await loadUserDevices(); setBindMacInput(""); setBindNicknameInput(""); showToast(tr("设备已添加", "Device added"), "success");
    } catch (error) { showToast(error instanceof Error ? error.message : "Failed", "error"); }
  };
  const renameDevice = async (device: UserDevice) => {
    const name = prompt(tr("设备名称", "Device name"), device.nickname || ""); if (name === null) return;
    try { const response = await fetch(`/api/local/devices/${encodeURIComponent(device.mac)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nickname: name.trim() }) }); if (!response.ok) throw new Error(); await loadUserDevices(); }
    catch { showToast(tr("名称保存失败", "Could not save name"), "error"); }
  };
  const handleUnbindDevice = async (deviceMac: string) => {
    if (!confirm(tr("从设备列表移除此设备？已有照片和配置会保留。", "Remove this device from the list? Photos and configuration are kept."))) return;
    try { const response = await fetch(`/api/local/devices/${encodeURIComponent(deviceMac)}`, { method: "DELETE" }); if (!response.ok) throw new Error(); await loadUserDevices(); if (mac === deviceMac) { const params = new URLSearchParams(searchParams); params.delete("mac"); router.replace(`${pathname}?${params.toString()}`); } }
    catch { showToast(tr("移除失败，请重试", "Removal failed. Please retry."), "error"); }
  };

  const [config, setConfig] = useState<DeviceConfig>({});
  const [selectedModes, setSelectedModes] = useState<Set<string>>(new Set(["STOIC", "ZEN", "DAILY"]));
  const [strategy, setStrategy] = useState("random");
  const [refreshMin, setRefreshMin] = useState(60);
  const [timeSlotRules, setTimeSlotRules] = useState<TimeSlotRule[]>([]);
  const [city, setCity] = useState("");
  const [locationMeta, setLocationMeta] = useState<LocationValue>({});
  const [modeLanguage, setModeLanguage] = useState("zh");
  const [contentTone, setContentTone] = useState("neutral");
  const [characterTones, setCharacterTones] = useState<string[]>([]);
  const [customPersonaTone, setCustomPersonaTone] = useState("");
  const [modeOverrides, setModeOverrides] = useState<Record<string, ModeOverride>>({});
  const [settingsMode, setSettingsMode] = useState<string | null>(null);
  const [settingsJsonDrafts, setSettingsJsonDrafts] = useState<Record<string, string>>({});
  const [settingsJsonErrors, setSettingsJsonErrors] = useState<Record<string, string>>({});
  const [memoText, setMemoText] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" | "info" } | null>(null);
  const [stats, setStats] = useState<DeviceStats | null>(null);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [previewIdentity, setPreviewIdentity] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewStatusText, setPreviewStatusText] = useState("");
  const [previewMode, setPreviewMode] = useState("");
  // This local deployment uses the Huawei 3.98-inch four-color panel.
  const [previewColors, setPreviewColors] = useState(4);
  const [previewWidth, setPreviewWidth] = useState(768);
  const [previewHeight, setPreviewHeight] = useState(552);
  const [previewNoCacheOnce, setPreviewNoCacheOnce] = useState(false);
  const [previewCacheHit, setPreviewCacheHit] = useState<boolean | null>(null);
  const [previewLlmStatus, setPreviewLlmStatus] = useState<string | null>(null);

  // 自适应图片（MY_ADAPTIVE）多图上传弹窗
  const adaptiveFileInputRef = useRef<HTMLInputElement | null>(null);
  const [adaptiveModal, setAdaptiveModal] = useState<{ action: "preview" | "apply" } | null>(null);
  const [adaptiveImageUrls, setAdaptiveImageUrls] = useState<string[]>([]);
  const [adaptivePhotoEdits, setAdaptivePhotoEdits] = useState<PhotoEdit[]>([]);
  const [adaptiveEditorIndex, setAdaptiveEditorIndex] = useState<number | null>(null);
  const [adaptiveSaving, setAdaptiveSaving] = useState(false);
  const adaptiveDragIndex = useRef<number | null>(null);
  const [adaptiveUploading2, setAdaptiveUploading2] = useState(false);
  const colorContextKey = JSON.stringify([mac, adaptiveEditorIndex, previewWidth, previewHeight, previewColors, adaptiveImageUrls, adaptivePhotoEdits]);
  const colorContext = useRef(colorContextKey);
  useLayoutEffect(() => { colorContext.current = colorContextKey; }, [colorContextKey]);
  const adaptiveEditorUrl = adaptiveImageUrls[adaptiveEditorIndex ?? -1];
  const filterRgbCache = useRef(new Map<string, string>());
  useLayoutEffect(() => { filterRgbCache.current = new Map(); }, [mac, previewWidth, previewHeight, adaptiveEditorIndex, adaptiveEditorUrl]);

  // 参数弹窗（与 /preview 页面保持一致）
  const [paramModal, setParamModal] = useState<ParamModalState | null>(null);
  const [quoteDraft, setQuoteDraft] = useState("");
  const [authorDraft, setAuthorDraft] = useState("");
  const [weatherDraftLocation, setWeatherDraftLocation] = useState<LocationValue>({});
  const [memoDraft, setMemoDraft] = useState<{ title1: string; text1: string; title2: string; text2: string; title3: string; text3: string }>({ title1: "", text1: "", title2: "", text2: "", title3: "", text3: "" });
  const [countdownName, setCountdownName] = useState(isEn ? "New Year" : "元旦");
  const [countdownDate, setCountdownDate] = useState("2027-01-01");
  const [habitItems, setHabitItems] = useState(
    isEn
      ? [{ name: "Wake up early", done: false }, { name: "Exercise", done: false }, { name: "Read", done: false }]
      : [{ name: "早起", done: false }, { name: "运动", done: false }, { name: "阅读", done: false }],
  );
  const [userAge, setUserAge] = useState(30);
  const [lifeExpectancy, setLifeExpectancy] = useState(80);
  const [vocabDeckId, setVocabDeckId] = useState("core_en");
  const [vocabDailyLimit, setVocabDailyLimit] = useState(30);
  const [timetableData, setTimetableData] = useState<TimetableData>({
    style: "weekly",
    periods: ["08:00-09:30", "10:00-11:30", "14:00-15:30", "16:00-17:30"],
    courses: isEn
      ? {
          "0-0": "Calculus/A201", "0-2": "Linear Algebra/A201",
          "1-1": "English/B305", "1-3": "PE/Gym",
          "2-0": "Data Struct/C102", "2-2": "Networks/C102",
          "3-1": "Probability/A201", "3-3": "Politics/D405",
          "4-0": "OS/C102",
        }
      : {
          "0-0": "高等数学/A201", "0-2": "线性代数/A201",
          "1-1": "大学英语/B305", "1-3": "体育/操场",
          "2-0": "数据结构/C102", "2-2": "计算机网络/C102",
          "3-1": "概率论/A201", "3-3": "毛概/D405",
          "4-0": "操作系统/C102",
        },
  });
  const [, setCurrentMode] = useState<string>("");
  const [applyToScreenLoading, setApplyToScreenLoading] = useState(false);
  const [, setFavoritedModes] = useState<Set<string>>(new Set());
  const favoritesLoadedMacRef = useRef<string>("");
  const memoSettingsInputRef = useRef<HTMLTextAreaElement | null>(null);
  const previewStreamRef = useRef<EventSource | null>(null);
  const previewRequestRef = useRef(0);
  const previewCancelRef = useRef<(() => void) | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("unknown");
  const [runtimeStatus, setRuntimeStatus] = useState<"loading" | "ready" | "error">("loading");
  const runtimeRequestRef = useRef(0);
  const runtimeAbortRef = useRef<AbortController | null>(null);
  const runtimeDeviceRef = useRef("");
  const [isOnline, setIsOnline] = useState(false);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [isFocusListening, setIsFocusListening] = useState(false);
  const [alwaysActive, setAlwaysActive] = useState(false);
  const [focusToggleLoading, setFocusToggleLoading] = useState(false);
  const [focusAlertToken, setFocusAlertToken] = useState<string>("");
  const [showFocusTokenModal, setShowFocusTokenModal] = useState(false);

  const [customDesc, setCustomDesc] = useState("");
  const [customModeName, setCustomModeName] = useState("");
  const [customModeDescription, setCustomModeDescription] = useState("");
  const [customJson, setCustomJson] = useState("");
  const [customGenerating, setCustomGenerating] = useState(false);
  const [customPreviewImg, setCustomPreviewImg] = useState<string | null>(null);
  const [, setCustomPreviewLoading] = useState(false);
  const [editingCustomMode, setEditingCustomMode] = useState(false);
  const [customEditorSource, setCustomEditorSource] = useState<"ai" | "composer" | "json" | null>(null);
  const [customEditorTab, setCustomEditorTab] = useState<"ai" | "composer">("ai");
  const [composerCatalog, setComposerCatalog] = useState<ComposerCatalog | null>(null);
  const [composerState, setComposerState] = useState<ComposerState>({ layoutKind: "preset", bodyPreset: "", presetProps: {}, fragments: [], fragmentStack: {}, prompt: "", cacheable: true });
  const [composerSyncError, setComposerSyncError] = useState<string | null>(null);
  const [, setCustomJsonError] = useState<string | null>(null);
  const [composerPreviewUrl, setComposerPreviewUrl] = useState<string | null>(null);
  const [composerPreviewLoading, setComposerPreviewLoading] = useState(false);
  const [previewModeLabelOverride, setPreviewModeLabelOverride] = useState<string | null>(null);
  const previewPanelRef = useRef<HTMLDivElement | null>(null);

  const [catalogItems, setCatalogItems] = useState<ModeCatalogItem[]>([]);

  const showToast = useCallback((msg: string, type: "success" | "error" | "info" = "info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const currentLocation = useMemo(
    () => buildLocationValue(city, locationMeta),
    [city, locationMeta],
  );
  const defaultWeatherLocation = useMemo(
    () => (currentLocation.city ? cleanLocationValue(currentLocation) : buildLocationValue("杭州")),
    [currentLocation],
  );

  const applyGlobalLocation = useCallback((next: Partial<LocationValue> | null | undefined) => {
    const cleaned = cleanLocationValue(next);
    setCity(cleaned.city || "");
    setLocationMeta(cleaned);
  }, []);

  const replacePreviewImg = useCallback((nextUrl: string | null) => {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = null;
    }
    if (nextUrl) previewObjectUrlRef.current = nextUrl;
    setPreviewImg(nextUrl);
  }, []);

  const invalidatePreview = useCallback(() => {
    previewRequestRef.current += 1;
    previewCancelRef.current?.();
    previewCancelRef.current = null;
    previewStreamRef.current?.close();
    previewStreamRef.current = null;
    setPreviewIdentity(null);
    setPreviewLoading(false);
  }, []);

  useEffect(() => { invalidatePreview(); }, [mac, previewWidth, previewHeight, previewColors, invalidatePreview]);

  const uploadLocalImage = useCallback(async (file: File): Promise<string> => {
    const fd = new FormData();
    fd.append("file", file);
    const up = await fetch("/api/uploads", { method: "POST", body: fd });
    if (!up.ok) {
      const err = await up.text().catch(() => "");
      throw new Error(err || `upload failed: ${up.status}`);
    }
    const data = (await up.json()) as { url?: string };
    if (!data.url) throw new Error("upload failed: missing url");
    return data.url;
  }, []);

  useEffect(() => {
    return () => {
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
    };
  }, []);

  const refreshCatalog = useCallback(async () => {
    const params = new URLSearchParams();
    if (mac) params.append("mac", mac);
    try {
      const res = await fetch(`/api/modes/catalog?${params.toString()}`, { headers: authHeaders() });
      if (!res.ok) {
        console.error("[CONFIG] Catalog request failed:", res.status, res.statusText);
        return;
      }
      const data = await res.json().catch((err) => {
        console.error("[CONFIG] Failed to parse catalog JSON:", err);
        return {};
      });
      if (data.items && Array.isArray(data.items)) {
        setCatalogItems(data.items);
        setComposerCatalog((data.custom_mode_composer && typeof data.custom_mode_composer === "object")
          ? (data.custom_mode_composer as ComposerCatalog)
          : null);
      } else {
        console.error("[CONFIG] Invalid catalog response:", data);
      }
    } catch (err) {
      console.error("[CONFIG] Failed to load catalog:", err);
    }
  }, [mac]);

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  useEffect(() => {
    if (!composerCatalog) return;
    setComposerState((prev) => {
      if (prev.bodyPreset || prev.fragments.length > 0) return prev;
      return defaultComposerState(composerCatalog);
    });
  }, [composerCatalog]);

  const syncComposerFromModeDef = useCallback((modeDef: unknown) => {
    const parsed = parseComposerModeDefinition(modeDef, composerCatalog);
    if (parsed.composer) {
      setComposerState(parsed.composer);
      setComposerSyncError(null);
      return true;
    }
    setComposerSyncError(parsed.error);
    return false;
  }, [composerCatalog]);

  const openCreateCustomMode = useCallback(() => {
    setCustomDesc("");
    setCustomModeName("");
    setCustomModeDescription("");
    setCustomJson("");
    setCustomJsonError(null);
    setCustomEditorSource(null);
    setComposerSyncError(null);
    setComposerState(defaultComposerState(composerCatalog));
    setCustomEditorTab("ai");
    setEditingCustomMode(true);
  }, [composerCatalog]);

  const handleComposerChange = useCallback((updater: (prev: ComposerState) => ComposerState) => {
    setCustomEditorSource("composer");
    setComposerState(updater);
    setComposerSyncError(null);
  }, []);

  const fetchComposerPreview = useCallback(async () => {
    if (!composerCatalog) return;
    const modeDef = buildComposerModeDefinition({
      composer: composerState,
      catalog: composerCatalog,
      modeName: customModeName || "Preview",
      modeDescription: customModeDescription,
      isEn,
    });
    setComposerPreviewLoading(true);
    try {
      const res = await fetch("/api/modes/custom/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode_def: modeDef, mac: mac || undefined, colors: previewColors, w: previewWidth, h: previewHeight, layout_only: true }),
      });
      if (!res.ok) {
        setComposerPreviewUrl(null);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setComposerPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
    } catch {
      setComposerPreviewUrl(null);
    } finally {
      setComposerPreviewLoading(false);
    }
  }, [composerCatalog, composerState, customModeName, customModeDescription, isEn, mac, previewColors, previewWidth, previewHeight]);

  useEffect(() => {
    if (!composerCatalog) return;
    if (customEditorSource !== "composer") return;
    const modeDef = buildComposerModeDefinition({
      composer: composerState,
      catalog: composerCatalog,
      modeName: customModeName,
      modeDescription: customModeDescription,
      isEn,
    });
    setCustomJson(JSON.stringify(modeDef, null, 2));
    setCustomEditorSource("composer");
    setCustomJsonError(null);
  }, [composerCatalog, composerState, customEditorSource, customModeDescription, customModeName, isEn]);

  useEffect(() => {
    setMacAccessDenied(false);
  }, [mac]);

  useEffect(() => {
    if (!mac) return;
    fetch(`/api/device/${encodeURIComponent(mac)}/state`, { headers: authHeaders() })
      .then((r) => {
        if (r.status === 401 || r.status === 403) {
          setMacAccessDenied(true);
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then(async (d) => {
        if (!d?.last_persona) return;
        setCurrentMode(d.last_persona);
        setPreviewMode(d.last_persona);
      })
      .catch(() => {});
  }, [mac]);

  useEffect(() => {
    if (!mac) return;
    const controller = new AbortController();
    setLoading(true); setConfigError(""); setAdaptiveImageUrls([]); setAdaptivePhotoEdits([]); setDirty(false);
    fetch(`/api/config/${encodeURIComponent(mac)}`, { headers: authHeaders(), signal: controller.signal })
      .then((r) => {
        if (r.status === 401 || r.status === 403) {
          setMacAccessDenied(true);
          throw new Error("Forbidden");
        }
        if (!r.ok) throw new Error("No config");
        return r.json();
      })
      .then((cfg: DeviceConfig) => {
        if (controller.signal.aborted) return;
        setConfig(cfg);
        setTimeSlotRules(cfg.timeSlotRules || cfg.time_slot_rules || []);
        const savedSize = /^(\d+)x(\d+)$/.exec(cfg.screenSize || cfg.screen_size || "");
        if (savedSize) {
          const width = Number(savedSize[1]);
          const height = Number(savedSize[2]);
          if (width >= 100 && width <= 1600 && height >= 100 && height <= 1200) {
            setPreviewWidth(width);
            setPreviewHeight(height);
            if (width === 768 && height === 552) setPreviewColors(4);
          }
        }
        setSelectedModes(new Set((cfg.modes || []).map((m) => m.toUpperCase())));
        if (cfg.refreshStrategy || cfg.refresh_strategy) setStrategy((cfg.refreshStrategy || cfg.refresh_strategy) as string);
        if (cfg.refreshInterval || cfg.refresh_minutes) setRefreshMin((cfg.refreshInterval || cfg.refresh_minutes) as number);
        applyGlobalLocation(extractLocationValue(cfg as Record<string, unknown>));
        setModeLanguage((cfg as Record<string, unknown>).modeLanguage as string || (cfg as Record<string, unknown>).mode_language as string || "zh");
        if (cfg.contentTone || cfg.content_tone) setContentTone(normalizeTone(cfg.contentTone || cfg.content_tone));
        if (cfg.characterTones || cfg.character_tones) setCharacterTones((cfg.characterTones || cfg.character_tones) as string[]);
        setModeOverrides(cfg.mode_overrides || cfg.modeOverrides || {});
        setIsFocusListening(Boolean(cfg.is_focus_listening ?? Number(cfg.focus_listening || 0) === 1));
        setAlwaysActive(Boolean(cfg.is_always_active ?? Number(cfg.always_active || 0) === 1));
        const loadedOverrides = ((cfg.mode_overrides || cfg.modeOverrides || {}) as Record<string, ModeOverride>);
        const adaptiveOv = loadedOverrides?.MY_ADAPTIVE;
        if (adaptiveOv) {
          const urls = adaptiveOv.image_urls;
          const savedEdits = Array.isArray(adaptiveOv.photo_edits) ? adaptiveOv.photo_edits : [];
          if (Array.isArray(urls) && urls.length > 0) {
            const validUrls = urls.filter((u: unknown) => typeof u === "string" && (u as string).trim()) as string[];
            setAdaptiveImageUrls(validUrls);
            setAdaptivePhotoEdits(validUrls.map((url, i) => readPhotoEdit(savedEdits[i], url)));
          } else if (typeof adaptiveOv.image_url === "string" && (adaptiveOv.image_url as string).trim()) {
            setAdaptiveImageUrls([adaptiveOv.image_url as string]);
            setAdaptivePhotoEdits([readPhotoEdit(savedEdits[0], adaptiveOv.image_url as string)]);
          }
        }
        const memoFromOverride = loadedOverrides?.MEMO?.memo_text;
        if (typeof memoFromOverride === "string" && memoFromOverride.trim()) {
          setMemoText(memoFromOverride);
        } else if (cfg.memoText || cfg.memo_text) {
          setMemoText((cfg.memoText || cfg.memo_text) as string);
        }
      })
      .catch(() => { if (!controller.signal.aborted) setConfigError(tr("无法读取设备配置。为保护已有照片，暂时不能保存修改。", "Cannot load configuration. Saving is unavailable until it loads.")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [applyGlobalLocation, mac, setDirty, tr]);

  const getModeOverride = useCallback((modeId: string) => {
    return modeOverrides[modeId] || {};
  }, [modeOverrides]);

  const sanitizeModeOverride = useCallback((input: ModeOverride) => {
    const cleaned: ModeOverride = {};
    for (const [k, raw] of Object.entries(input)) {
      if (
        k === "city" ||
        k === "timezone" ||
        k === "admin1" ||
        k === "country" ||
        k === "llm_provider" ||
        k === "llm_model"
      ) {
        if (typeof raw === "string" && raw.trim()) cleaned[k] = raw.trim();
        continue;
      }
      if (k === "latitude" || k === "longitude") {
        if (typeof raw === "number" && Number.isFinite(raw)) cleaned[k] = raw;
        continue;
      }
      if (typeof raw === "string") {
        if (raw.trim()) cleaned[k] = raw.trim();
        continue;
      }
      if (typeof raw === "number") {
        if (!Number.isNaN(raw)) cleaned[k] = raw;
        continue;
      }
      if (typeof raw === "boolean") {
        cleaned[k] = raw;
        continue;
      }
      if (Array.isArray(raw)) {
        if (raw.length > 0) cleaned[k] = raw;
        continue;
      }
      if (raw && typeof raw === "object") {
        if (Object.keys(raw).length > 0) cleaned[k] = raw as Record<string, unknown>;
      }
    }
    return cleaned;
  }, []);

  const buildCurrentModeOverrides = useCallback((overrides = modeOverrides) => {
    const normalized = Object.fromEntries(Object.entries(overrides)
      .map(([modeId, override]) => [modeId.toUpperCase(), sanitizeModeOverride(override)] as const)
      .filter(([, override]) => Object.keys(override).length > 0));
    return mergePhotoDraft(normalized, adaptiveImageUrls, adaptivePhotoEdits);
  }, [modeOverrides, adaptiveImageUrls, adaptivePhotoEdits, sanitizeModeOverride]);

  const updateModeOverride = useCallback((modeId: string, patch: Partial<ModeOverride>) => {
    setModeOverrides((prev) => {
      const next = { ...(prev[modeId] || {}), ...patch } as ModeOverride;
      const cleaned = sanitizeModeOverride(next);
      if (!Object.keys(cleaned).length) {
        const copied = { ...prev };
        delete copied[modeId];
        return copied;
      }
      return { ...prev, [modeId]: cleaned };
    });
  }, [sanitizeModeOverride]);

  const requiresParamModal = useCallback((modeId: string) => {
    const m = (modeId || "").toUpperCase();
    return m === "WEATHER" || m === "MEMO" || m === "MY_QUOTE" || m === "COUNTDOWN" || m === "HABIT" || m === "LIFEBAR" || m === "CALENDAR" || m === "TIMETABLE" || m === "VOCAB_REVIEW";
  }, []);

  const openParamModal = useCallback((modeId: string, action: "preview" | "apply") => {
    const m = (modeId || "").toUpperCase();
    if (m === "WEATHER") {
      setWeatherDraftLocation({});
      setParamModal({ type: "weather", mode: m, action });
      return;
    }
    if (m === "MEMO") {
      const savedMemo = (modeOverrides[m] || {}) as Record<string, unknown>;
      const ms = (
        savedMemo.mode_settings && typeof savedMemo.mode_settings === "object" && !Array.isArray(savedMemo.mode_settings)
          ? savedMemo.mode_settings
          : savedMemo
      ) as Record<string, string>;
      setMemoDraft({
        title1: ms.memo_title_1 || "",
        text1: ms.memo_text_1 || "",
        title2: ms.memo_title_2 || "",
        text2: ms.memo_text_2 || "",
        title3: ms.memo_title_3 || "",
        text3: ms.memo_text_3 || "",
      });
      setParamModal({ type: "memo", mode: m, action });
      return;
    }
    if (m === "MY_QUOTE") {
      const savedOv = (modeOverrides[m] || {}) as Record<string, unknown>;
      setQuoteDraft(typeof savedOv.quote === "string" ? savedOv.quote : "");
      setAuthorDraft(typeof savedOv.author === "string" ? savedOv.author : "");
      setParamModal({ type: "quote", mode: m, action });
      return;
    }
    if (m === "COUNTDOWN") {
      setParamModal({ type: "countdown", mode: m, action });
      return;
    }
    if (m === "HABIT") {
      const savedOv = modeOverrides["HABIT"] || {};
      const savedItems = Array.isArray(savedOv.habitItems) ? (savedOv.habitItems as Array<{ name: string; done?: boolean }>) : null;
      if (savedItems && savedItems.length > 0) {
        setHabitItems(savedItems.map((h) => ({ name: h.name, done: h.done ?? false })));
      }
      setParamModal({ type: "habit", mode: m, action });
      return;
    }
    if (m === "LIFEBAR") {
      const savedOv = (modeOverrides[m] || {}) as Record<string, unknown>;
      const savedAge = Number(savedOv.age);
      const savedExpect = Number(savedOv.life_expect);
      if (Number.isFinite(savedAge) && savedAge > 0) {
        setUserAge(savedAge);
      }
      if ([80, 90, 100, 120].includes(savedExpect)) {
        setLifeExpectancy(savedExpect);
      }
      setParamModal({ type: "lifebar", mode: m, action });
      return;
    }
    if (m === "CALENDAR") {
      setParamModal({ type: "calendar", mode: m, action });
      return;
    }
    if (m === "TIMETABLE") {
      const existing = (modeOverrides[m] || {}) as Record<string, unknown>;
      if (existing.periods && existing.courses) {
        setTimetableData({
          style: (existing.style as "daily" | "weekly") || "daily",
          weekdays: Array.isArray(existing.weekdays) ? existing.weekdays as string[] : undefined,
          periods: existing.periods as string[],
          courses: existing.courses as Record<string, string>,
        });
      }
      setParamModal({ type: "timetable", mode: m, action });
      return;
    }
    if (m === "VOCAB_REVIEW") {
      const ov = modeOverrides[m] || {};
      setVocabDeckId(String(ov.deck_id || "core_en"));
      setVocabDailyLimit(Number(ov.daily_limit || 30));
      setParamModal({ type: "vocab", mode: m, action });
      return;
    }
  }, [modeOverrides]);

  const clearModeOverride = useCallback((modeId: string) => {
    setModeOverrides((prev) => {
      const copied = { ...prev };
      delete copied[modeId];
      return copied;
    });
    setSettingsJsonDrafts((prev) => {
      const copied = { ...prev };
      Object.keys(copied).forEach((k) => {
        if (k.startsWith(`${modeId}:`)) delete copied[k];
      });
      return copied;
    });
    setSettingsJsonErrors((prev) => {
      const copied = { ...prev };
      Object.keys(copied).forEach((k) => {
        if (k.startsWith(`${modeId}:`)) delete copied[k];
      });
      return copied;
    });
    if (modeId === "COUNTDOWN") {
      setConfig((prev) => ({
        ...prev,
        countdownEvents: [],
        countdown_events: [],
      }));
    }
  }, []);

  const modeSchemaMap = useMemo(
    () => Object.fromEntries(catalogItems.map((m) => [m.mode_id.toUpperCase(), m.settings_schema || []])),
    [catalogItems]
  );

  const applySettingsDrafts = useCallback((modeId: string) => {
    const schema = modeSchemaMap[modeId] || [];
    for (const item of schema) {
      if (!item.as_json) continue;
      const key = `${modeId}:${item.key}`;
      if (!(key in settingsJsonDrafts)) continue;
      const text = settingsJsonDrafts[key] || "";
      if (!text.trim()) {
        updateModeOverride(modeId, { [item.key]: undefined });
        continue;
      }
      try {
        const parsed = JSON.parse(text);
        updateModeOverride(modeId, { [item.key]: parsed });
      } catch {
        setSettingsJsonErrors((prev) => ({ ...prev, [key]: tr("JSON 格式错误", "Invalid JSON") }));
        showToast(`${item.label} ${tr("JSON 格式错误", "Invalid JSON")}`, "error");
        return false;
      }
    }
    return true;
  }, [modeSchemaMap, settingsJsonDrafts, showToast, tr, updateModeOverride]);

  const handleSave = async () => {
    if (!mac) { showToast(tr("请先完成刷机和配网以获取设备 MAC", "Please flash and provision to get device MAC"), "error"); return; }
    if (macAccessDenied) { showToast(tr("你无权配置该设备", "No permission to configure this device"), "error"); return; }
    if (saveInFlightRef.current || adaptiveUploading2) return;
    const savedRevision = draftRevisionRef.current;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      const normalizedModeOverrides = buildCurrentModeOverrides();
      const body: Record<string, unknown> = {
        ...config,
        mac,
        modes: Array.from(selectedModes),
        refreshStrategy: strategy,
        refreshInterval: refreshMin,
        screenSize: config?.screenSize || config?.screen_size || `${previewWidth}x${previewHeight}`,
        ...currentLocation,
        modeLanguage,
        contentTone,
        characterTones: characterTones,
        modeOverrides: normalizedModeOverrides,
        mode_overrides: normalizedModeOverrides,
        memoText: memoText,
        is_focus_listening: isFocusListening,
        always_active: alwaysActive,
        timeSlotRules: timeSlotRules,
      };
      const res = await fetch("/api/config", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Save failed");
      if (activeMacRef.current !== mac) return;
      finishSavedDraft(savedRevision);
      setConfig((prev) => ({ ...prev, modes: Array.from(selectedModes), modeOverrides: normalizedModeOverrides, mode_overrides: normalizedModeOverrides }));
      let onlineNow = isOnline;
      let refreshQueued = false;
      const syncResult = await queueImmediateRefreshIfOnline(fetch, mac, authHeaders());
      onlineNow = syncResult.onlineNow ?? isOnline;
      refreshQueued = syncResult.refreshQueued;
      if (activeMacRef.current !== mac) return;
      void loadRuntimeMode();
      showToast(
        syncResult.onlineNow === null
          ? tr("配置已保存，暂时无法确认设备状态", "Settings saved, but device status is currently unavailable")
          : onlineNow
            ? (refreshQueued
                ? tr("配置已保存，已通知在线设备尽快同步", "Settings saved, online device notified to sync soon")
                : tr("配置已保存，设备在线，但同步通知失败", "Settings saved, device is online, but sync notification failed"))
            : tr("配置已保存，设备当前不在活跃同步状态，将在设备下次上线后生效", "Settings saved. Device is not actively syncing and will update when it comes online"),
        syncResult.onlineNow === null || !refreshQueued ? "info" : "success",
      );
      finishSavedDraft(savedRevision);
      setPreviewNoCacheOnce(true);
    } catch {
      showToast(tr("保存失败", "Save failed"), "error");
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const [savingPrefs, setSavingPrefs] = useState(false);
  const handleSavePreferences = async () => {
    if (!mac) { showToast(tr("请先完成刷机和配网以获取设备 MAC", "Please flash and provision to get device MAC"), "error"); return; }
    if (macAccessDenied) { showToast(tr("你无权配置该设备", "No permission"), "error"); return; }
    if (saveInFlightRef.current || adaptiveUploading2) return;
    const savedRevision = draftRevisionRef.current;
    saveInFlightRef.current = true;
    setSavingPrefs(true);
    try {
      const normalizedModeOverrides = buildCurrentModeOverrides();
      const body: Record<string, unknown> = {
        ...config,
        mac,
        modes: Array.from(selectedModes),
        refreshStrategy: strategy,
        refreshInterval: refreshMin,
        ...currentLocation,
        modeLanguage,
        contentTone,
        characterTones: characterTones,
        modeOverrides: normalizedModeOverrides,
        mode_overrides: normalizedModeOverrides,
        memoText: memoText,
        is_focus_listening: isFocusListening,
        always_active: alwaysActive,
        timeSlotRules: timeSlotRules,
      };
      const res = await fetch("/api/config", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Save failed");
      if (activeMacRef.current !== mac) return;
      finishSavedDraft(savedRevision);
      showToast(tr("配置已保存", "Settings saved"), "success");
      setPreviewNoCacheOnce(true);
    } catch {
      showToast(tr("保存失败", "Save failed"), "error");
    } finally {
      saveInFlightRef.current = false;
      setSavingPrefs(false);
    }
  };

  const handleToggleFocusListening = useCallback(async () => {
    if (!mac) return;
    const next = !isFocusListening;
    setFocusToggleLoading(true);
    try {
      const res = await fetch(
        `/api/config/${encodeURIComponent(mac)}/focus-listening?enabled=${next}`,
        { method: "PATCH", headers: authHeaders() },
      );
      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        console.error("[FOCUS] Toggle failed:", res.status, errorText);
        throw new Error("focus-toggle-failed");
      }
      const data = (await res.json().catch(() => ({}))) as { alert_token?: string | null };
      setIsFocusListening(next);
      if (next && data?.alert_token) {
        setFocusAlertToken(data.alert_token);
        setShowFocusTokenModal(true);
      }
      showToast(
        next
          ? tr("Focus 专注模式就绪，OpenCLAW 守护中", "Focus mode is ready, guarded by OpenCLAW")
          : tr("专注监听已关闭，设备将按原计划轮播内容", "Focus listening disabled. The device will resume normal rotation"),
        "success",
      );
    } catch (err) {
      console.error("[FOCUS] Toggle error:", err);
      showToast(tr("切换专注监听失败，请稍后重试", "Failed to toggle Focus Listening. Please try again"), "error");
    } finally {
      setFocusToggleLoading(false);
    }
  }, [isFocusListening, mac, showToast, tr]);

  const buildPreviewParams = useCallback((mode?: string, forceNoCache = false, forcedModeOverride?: ModeOverride, clearSavedOverride = false) => {
    const m = mode || previewMode;
    const consumeNoCacheOnce = previewNoCacheOnce;
    const forceFresh = forceNoCache || consumeNoCacheOnce;
    const params = new URLSearchParams({ persona: m });
    if (mac) params.set("mac", mac);
    if (clearSavedOverride && m === "COUNTDOWN") {
      params.set("mode_override", JSON.stringify({ countdownEvents: [] }));
      if (previewColors > 2) params.set("colors", String(previewColors));
      params.set("w", String(previewWidth));
      params.set("h", String(previewHeight));
      if (forceFresh) params.set("no_cache", "1");
      return { m, params, consumeNoCacheOnce };
    }
    const modeOverrideSource = sanitizeModeOverride(
      clearSavedOverride
        ? {
            ...(m === "COUNTDOWN" ? { countdownEvents: [] } : {}),
            ...(forcedModeOverride || {}),
          }
        : {
            ...(modeOverrides[m] || {}),
            ...(forcedModeOverride || {}),
          }
    );
    const savedOverrides = (config.mode_overrides || config.modeOverrides || {}) as Record<string, ModeOverride>;
    const effectiveLocation = cleanLocationValue(
      modeOverrideSource.city
        ? extractLocationValue(modeOverrideSource as Record<string, unknown>)
        : currentLocation,
    );
    const savedEffectiveLocation = cleanLocationValue(
      savedOverrides[m]?.city
        ? extractLocationValue(savedOverrides[m] as Record<string, unknown>)
        : extractLocationValue(config as Record<string, unknown>),
    );
    const locationChanged = Boolean(effectiveLocation.city) && !locationsEqual(effectiveLocation, savedEffectiveLocation);

    const activeModeOverride = sanitizeModeOverride({
      ...modeOverrideSource,
      ...(locationChanged ? effectiveLocation : {}),
    });
    if (!clearSavedOverride && m === "MEMO" && memoText.trim() && !("memo_text" in activeModeOverride)) {
      activeModeOverride.memo_text = memoText.trim();
    }
    const hasModeOverride = Object.keys(activeModeOverride).length > 0;
    if (hasModeOverride) {
      params.set("mode_override", JSON.stringify(activeModeOverride));
    }
    if (m === "MEMO") {
      const memoCandidate = (
        typeof forcedModeOverride?.memo_text === "string" && forcedModeOverride.memo_text.trim()
          ? forcedModeOverride.memo_text
          : typeof activeModeOverride.memo_text === "string" && activeModeOverride.memo_text.trim()
          ? activeModeOverride.memo_text
          : memoText
      ).trim();
      if (memoCandidate) {
        params.set("memo_text", memoCandidate);
      }
      // 传递 3 组标题+内容字段
      const ms = (forcedModeOverride?.mode_settings || activeModeOverride.mode_settings || {}) as Record<string, string>;
      for (const k of Object.keys(ms)) {
        if ((k.startsWith("memo_title_") || k.startsWith("memo_text_")) && ms[k]) {
          params.set(k, ms[k]);
        }
      }
    }
    if (locationChanged && effectiveLocation.city) params.set("city_override", effectiveLocation.city);
    if (previewColors > 2) params.set("colors", String(previewColors));
    params.set("w", String(previewWidth));
    params.set("h", String(previewHeight));
    if (forceFresh || locationChanged || hasModeOverride) params.set("no_cache", "1");
    return { m, params, consumeNoCacheOnce };
  }, [config, currentLocation, mac, memoText, modeOverrides, previewColors, previewWidth, previewHeight, previewMode, previewNoCacheOnce, sanitizeModeOverride]);

  const handlePreview = useCallback(async (mode?: string, forceNoCache = false, forcedModeOverride?: ModeOverride, _confirmed = false, clearSavedOverride = false, identity?: string) => {
    const { m, params, consumeNoCacheOnce } = buildPreviewParams(mode, forceNoCache, forcedModeOverride, clearSavedOverride);
    if (!m) return;
    invalidatePreview();
    const request = previewRequestRef.current;
    const isCurrent = () => request === previewRequestRef.current;
    setPreviewCacheHit(null);
    setPreviewLlmStatus(null);
    setPreviewLoading(true);
    setPreviewStatusText(tr("正在生成...", "Generating..."));
    try {
      const stream = new EventSource(`/api/preview/stream?${params.toString()}`);
      const imageController = new AbortController();
      previewStreamRef.current = stream;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let resultStarted = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          stream.close();
          if (isCurrent()) { previewStreamRef.current = null; previewCancelRef.current = null; }
          if (error) reject(error); else resolve();
        };
        previewCancelRef.current = () => {
          imageController.abort();
          finish(new Error("Preview cancelled"));
        };
        stream.addEventListener("status", (event) => {
          if (!isCurrent() || settled) return;
          try {
            const data = JSON.parse((event as MessageEvent<string>).data) as { message?: string };
            setPreviewStatusText(data.message || tr("正在生成...", "Generating..."));
          } catch { setPreviewStatusText(tr("正在生成...", "Generating...")); }
        });
        stream.addEventListener("error", (event) => {
          if (!isCurrent() || settled || resultStarted) return;
          let message = "Preview failed";
          try { message = JSON.parse((event as MessageEvent<string>).data).message || message; } catch {}
          finish(new Error(message));
        });
        stream.addEventListener("result", async (event) => {
          if (!isCurrent() || settled || resultStarted) return;
          resultStarted = true;
          stream.close();
          try {
            const data = JSON.parse((event as MessageEvent<string>).data) as {
              message?: string; image_url?: string; cache_hit?: boolean; preview_status?: string; llm_required?: boolean;
            };
            if (!data.image_url) throw new Error("Preview image missing");
            const imageResponse = await fetch(data.image_url, { cache: "no-store", signal: imageController.signal });
            if (!imageResponse.ok) throw new Error("Preview image unavailable");
            const imageBlob = await imageResponse.blob();
            if (!isCurrent() || settled) return;
            replacePreviewImg(URL.createObjectURL(imageBlob));
            setPreviewIdentity(identity || null);
            setPreviewCacheHit(typeof data.cache_hit === "boolean" ? data.cache_hit : null);
            setPreviewStatusText(data.message || tr("完成", "Done"));
            const status = (data.preview_status || "").toLowerCase();
            setPreviewLlmStatus(status === "no_llm_required" || data.llm_required === false ? null
              : status === "model_generated" ? tr("大模型调用成功", "Model call succeeded")
              : status === "fallback_used" ? tr("大模型调用失败，使用默认内容", "Model call failed, using fallback content") : null);
            finish();
          } catch (error) { finish(error instanceof Error ? error : new Error("Preview failed")); }
        });
      });
    } catch (error) {
      if (!isCurrent() || (error instanceof Error && error.message === "Preview cancelled")) return;
      const message = error instanceof Error ? error.message : "Preview failed";
      showToast(message === "Preview failed" ? tr("预览连接失败，请重试", "Preview connection failed. Please try again") : `${tr("预览失败", "Preview failed")}: ${message}`, "error");
      setPreviewCacheHit(null);
      setPreviewIdentity(null);
      setPreviewStatusText("");
    } finally {
      if (isCurrent()) {
        setPreviewLoading(false);
        if (consumeNoCacheOnce) setPreviewNoCacheOnce(false);
      }
    }
  }, [buildPreviewParams, invalidatePreview, replacePreviewImg, showToast, tr]);

  const loadStats = useCallback(async () => {
    if (!mac) return;
    try {
      const res = await fetch(`/api/stats/${encodeURIComponent(mac)}`, { headers: authHeaders() });
      if (res.ok) setStats(await res.json());
    } catch {}
  }, [mac]);

  const loadFavorites = useCallback(async (force = false) => {
    if (!mac) return;
    if (!force && favoritesLoadedMacRef.current === mac) return;
    try {
      const res = await fetch(`/api/device/${encodeURIComponent(mac)}/favorites?limit=100`, { headers: authHeaders() });
      if (res.status === 401 || res.status === 403) {
        setMacAccessDenied(true);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      const modes = new Set<string>(
        (data.favorites || [])
          .map((item: { mode_id?: string }) => (item.mode_id || "").toUpperCase())
          .filter((modeId: string) => modeId.length > 0),
      );
      setFavoritedModes(modes);
      favoritesLoadedMacRef.current = mac;
    } catch {}
  }, [mac]);

  const loadRuntimeMode = useCallback(async () => {
    if (!mac || activeMacRef.current !== mac) return;
    const request = ++runtimeRequestRef.current;
    runtimeAbortRef.current?.abort();
    const controller = new AbortController();
    runtimeAbortRef.current = controller;
    const isCurrent = () => !controller.signal.aborted && request === runtimeRequestRef.current && activeMacRef.current === mac;
    if (runtimeDeviceRef.current !== mac) {
      runtimeDeviceRef.current = mac;
      setIsOnline(false); setLastSeen(null); setRuntimeMode("unknown");
      setRuntimeStatus("loading");
    } else setRuntimeStatus((previous) => previous === "ready" ? previous : "loading");
    try {
      const res = await fetch(`/api/device/${encodeURIComponent(mac)}/state`, { cache: "no-store", headers: authHeaders(), signal: controller.signal });
      if (!isCurrent()) return;
      if (res.status === 401 || res.status === 403) setMacAccessDenied(true);
      if (!res.ok) throw new Error("Device status unavailable");
      const data = await res.json();
      if (!isCurrent()) return;
      if (typeof data?.is_online !== "boolean") throw new Error("Device status unavailable");
      setIsOnline(data.is_online);
      setLastSeen(typeof data.last_seen === "string" && data.last_seen ? data.last_seen : null);
      setRuntimeMode(data.runtime_mode === "active" || data.runtime_mode === "interval" ? data.runtime_mode : "unknown");
      setRuntimeStatus("ready");
    } catch {
      if (isCurrent()) setRuntimeStatus("error");
    }
  }, [mac]);

  useEffect(() => {
    if (activeTab === "stats" && mac) loadStats();
  }, [activeTab, mac, loadStats]);

  useEffect(() => {
    if (!mac) return;
    favoritesLoadedMacRef.current = "";
    loadFavorites();
  }, [mac, loadFavorites]);

  useEffect(() => {
    if (!mac) return;
    void loadRuntimeMode();
    const refreshVisible = () => { if (document.visibilityState === "visible") void loadRuntimeMode(); };
    const timer = window.setInterval(refreshVisible, 30000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
      runtimeRequestRef.current += 1;
      runtimeAbortRef.current?.abort();
    };
  }, [mac, loadRuntimeMode]);

  useEffect(() => {
    if (!mac) {
      setSettingsMode(null);
    }
  }, [mac]);

  useEffect(() => {
    return () => {
      previewRequestRef.current += 1;
      previewCancelRef.current?.();
      previewCancelRef.current = null;
      previewStreamRef.current?.close();
      previewStreamRef.current = null;
    };
  }, []);

  const handleGenerateMode = async () => {
    if (!customDesc.trim()) { showToast(tr("请输入模式描述", "Please enter a mode description"), "error"); return; }
    setCustomGenerating(true);
    try {
      const res = await fetch("/api/modes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          description: customDesc, 
          provider: "deepseek", 
          model: "deepseek-chat",
          mac: mac || undefined,
        }),
      });


      const data = await res.json();
      if (!data.ok) throw new Error(data.error || tr("生成失败", "Generation failed"));
      setCustomJson(JSON.stringify(data.mode_def, null, 2));
      setCustomJsonError(null);
      setCustomModeName((data.mode_def?.display_name || "").toString());
      setCustomModeDescription((data.mode_def?.description || "").toString());
      setCustomEditorSource("ai");
      setCustomEditorTab("composer");
      syncComposerFromModeDef(data.mode_def);
      showToast(tr("模式生成成功", "Mode generated successfully"), "success");

      // Close modal right after generation, then start preview on the right panel
      const finalName = (customModeName || data.mode_def?.display_name || "").toString().trim();
      setPreviewModeLabelOverride(finalName || null);
      setEditingCustomMode(false);
      requestAnimationFrame(() => {
        previewPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });

      // show "previewing" on the right panel while preview is being built
      setPreviewLoading(true);
      setPreviewStatusText(isEn ? "Generating preview..." : "模式预览中...");

      await handleCustomPreview(data.mode_def);
    } catch (e) {
      showToast(`${tr("生成失败", "Generation failed")}: ${e instanceof Error ? e.message : tr("未知错误", "Unknown error")}`, "error");
    } finally {
      setCustomGenerating(false);
    }
  };

  const handleCustomPreview = async (defOverride?: unknown) => {
    if (!defOverride && !customJson.trim()) return;
    setCustomPreviewLoading(true);
    setPreviewLoading(true);
    if (!previewStatusText) setPreviewStatusText(isEn ? "Generating preview..." : "模式预览中...");
    try {
      const def = defOverride ? (defOverride as Record<string, unknown>) : (JSON.parse(customJson) as Record<string, unknown>);
      if (customModeName.trim()) {
        (def as Record<string, unknown>).display_name = customModeName.trim();
      }
      if (customModeDescription.trim()) {
        (def as Record<string, unknown>).description = customModeDescription.trim();
      }
      const modeIdRaw = (def as Record<string, unknown>).mode_id;
      if (typeof modeIdRaw !== "string" || !modeIdRaw.trim()) {
        (def as Record<string, unknown>).mode_id = normalizeModeIdFromName(customModeName || "Custom Preview");
      }
      let modeHint = "CUSTOM_PREVIEW";
      try {
        if (customModeName.trim()) {
          modeHint = customModeName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
        } else {
          const modeIdRaw = (def as Record<string, unknown>)["mode_id"];
          if (typeof modeIdRaw === "string" && modeIdRaw.trim()) {
            modeHint = modeIdRaw.trim().toUpperCase();
          }
        }
      } catch {}
      const res = await fetch("/api/modes/custom/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode_def: def, mac: mac || undefined, colors: previewColors, w: previewWidth, h: previewHeight }),
      });


      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || tr("预览失败", "Preview failed"));
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      if (customPreviewImg) {
        try { URL.revokeObjectURL(customPreviewImg); } catch {}
      }
      setCustomPreviewImg(objectUrl);

      // show custom-mode preview in the right E-Ink panel
      setPreviewMode(modeHint);
      setPreviewCacheHit(null);
      const status = (res.headers.get("x-preview-status") || "").toLowerCase();
      const llmRequiredHeader = (res.headers.get("x-llm-required") || "").toLowerCase();
      if (status === "no_llm_required" || llmRequiredHeader === "0" || llmRequiredHeader === "false") {
        setPreviewLlmStatus(null);
      } else if (status === "model_generated") {
        setPreviewLlmStatus(isEn ? "Model call succeeded" : "大模型调用成功");
      } else if (status === "fallback_used") {
        setPreviewLlmStatus(isEn ? "Model call failed, using fallback content" : "大模型调用失败，使用默认内容");
      } else {
        setPreviewLlmStatus(null);
      }
      replacePreviewImg(objectUrl);
    } catch (e) {
      if (e instanceof SyntaxError) {
        setCustomJsonError(e.message);
      }
      showToast(`${tr("预览失败", "Preview failed")}: ${e instanceof Error ? e.message : ""}`, "error");
    } finally {
      setCustomPreviewLoading(false);
      setPreviewLoading(false);
    }
  };

  const handleSaveCustomMode = async () => {
    if (!customJson.trim()) return;
    if (!mac) {
      showToast(tr("请先选择设备", "Please select a device first"), "error");
      return;
    }
    try {
      const def = JSON.parse(customJson);
      
      // Ensure mode_id exists - generate from display_name if missing
      if (!def.mode_id || !def.mode_id.trim()) {
        if (customModeName.trim()) {
          def.mode_id = customModeName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
          // Ensure it starts with a letter
          if (!/^[A-Z]/.test(def.mode_id)) {
            def.mode_id = "CUSTOM_" + def.mode_id;
          }
        } else if (def.display_name) {
          def.mode_id = def.display_name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
          if (!/^[A-Z]/.test(def.mode_id)) {
            def.mode_id = "CUSTOM_" + def.mode_id;
          }
        } else {
          // Generate a random mode_id if no name is available
          def.mode_id = "CUSTOM_" + Math.random().toString(36).substring(2, 10).toUpperCase();
        }
      }
      
      if (customModeName.trim()) {
        def.display_name = customModeName.trim();
      }
      if (customModeDescription.trim()) {
        def.description = customModeDescription.trim();
      }
      
      // Add mac to the request body
      def.mac = mac;
      
      const res = await fetch("/api/modes/custom", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify(def),
      });
      
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `${tr("保存失败", "Save failed")}: ${res.status}`);
      }
      
      const data = await res.json();
      if (data.ok || data.status === "ok") {
        showToast(`${tr("模式", "Mode")} ${def.mode_id} ${tr("已保存", "saved")}`, "success");
        // Keep a reusable local template alongside the device-specific custom mode.
        const templateResponse = await fetch("/api/local/templates/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: def }) });
        if (!templateResponse.ok) showToast(tr("设备模式已保存，但本地模板保存失败，可重试导出", "Device mode saved; reusable template could not be saved"), "info");
        refreshCatalog();
        setEditingCustomMode(false);
        setCustomJson("");
        setCustomDesc("");
        setCustomModeName("");
        setCustomModeDescription("");
        if (customPreviewImg) {
          try { URL.revokeObjectURL(customPreviewImg); } catch {}
        }
        setCustomPreviewImg(null);
        setCustomEditorSource(null);
      } else {
        throw new Error(data.error || tr("保存失败", "Save failed"));
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        setCustomJsonError(e.message);
      }
      showToast(`${tr("保存失败", "Save failed")}: ${e instanceof Error ? e.message : ""}`, "error");
    }
  };

  const toggleMode = useCallback((modeId: string) => {
    setDirty(true);
    setSelectedModes((prev) => {
      const next = new Set(prev);
      if (next.has(modeId)) next.delete(modeId);
      else next.add(modeId);
      return next;
    });
  }, [setDirty]);

  const handleModePreview = (m: string) => {
    const modeId = (m || "").toUpperCase();
    setPreviewMode(modeId);
    if (modeId === "MY_ADAPTIVE") {
      setAdaptiveModal({ action: "preview" });
      return;
    }
    if (requiresParamModal(modeId)) {
      openParamModal(modeId, "preview");
      return;
    }
    // Config page preview should bypass cache so it:
    // - reflects latest overrides
    handlePreview(modeId, true);
  };

  const handleModeApply = async (m: string) => {
    const modeId = (m || "").toUpperCase();
    if (modeId === "MY_ADAPTIVE" && !selectedModes.has(modeId)) {
      setAdaptiveModal({ action: "apply" });
      return;
    }
    if (requiresParamModal(modeId) && !selectedModes.has(modeId)) {
      // only require params when adding to carousel
      openParamModal(modeId, "apply");
      return;
    }
    const wasSelected = selectedModes.has(modeId);
    toggleMode(modeId);
    showToast(
      wasSelected
        ? tr("已从轮播移除", "Removed from rotation")
        : tr("已加入轮播", "Added to rotation"),
      "success",
    );
  };

  const handleCustomModeDelete = async (m: string) => {
    const modeId = (m || "").toUpperCase();
    if (!mac) {
      showToast(tr("请先选择设备", "Please select a device first"), "error");
      return;
    }
    const confirmed = window.confirm(
      tr(`确定删除自定义模式 ${modeId} 吗？`, `Delete custom mode ${modeId}?`),
    );
    if (!confirmed) return;
    try {
      const res = await fetch(
        `/api/modes/custom/${encodeURIComponent(modeId)}?mac=${encodeURIComponent(mac)}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      );
      const data = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        throw new Error(data.error || tr("删除失败", "Delete failed"));
      }
      setSelectedModes((prev) => {
        const next = new Set(prev);
        next.delete(modeId);
        return next;
      });
      setModeOverrides((prev) => {
        const copied = { ...prev };
        delete copied[modeId];
        return copied;
      });
      if (previewMode === modeId) {
        setPreviewMode("");
      }
      if (settingsMode === modeId) {
        setSettingsMode(null);
      }
      refreshCatalog();
      showToast(tr("自定义模式已删除", "Custom mode deleted"), "success");
    } catch (e) {
      showToast(`${tr("删除失败", "Delete failed")}: ${e instanceof Error ? e.message : ""}`, "error");
    }
  };

  const commitModalAction = useCallback(async (modeId: string, action: "preview" | "apply", forcedOverride?: ModeOverride, clearSavedOverride = false) => {
    setParamModal(null);
    if (clearSavedOverride) {
      clearModeOverride(modeId);
    } else if (forcedOverride && Object.keys(forcedOverride).length > 0) {
      updateModeOverride(modeId, forcedOverride);
      if (modeId === "MEMO" && forcedOverride) {
        const ms = (forcedOverride.mode_settings || {}) as Record<string, string>;
        if (!ms.memo_title_1 && !ms.memo_text_1) {
          // 新格式字段直接在 override 顶层
          const newMs: Record<string, string> = {};
          for (const k of Object.keys(forcedOverride)) {
            if (k.startsWith("memo_title_") || k.startsWith("memo_text_")) {
              newMs[k] = String(forcedOverride[k]);
            }
          }
          if (Object.keys(newMs).length > 0) {
            forcedOverride.mode_settings = newMs;
          }
        }
      }
      if (modeId === "WEATHER" && typeof forcedOverride.city === "string") {
        // keep global city as-is; weather override is per-mode
      }
    }

    setPreviewMode(modeId);
    await handlePreview(modeId, true, forcedOverride, false, clearSavedOverride);

    if (action === "apply") {
      if (!selectedModes.has(modeId)) {
        toggleMode(modeId);
        showToast(tr("已加入轮播", "Added to rotation"), "success");
      }
    }
  }, [clearModeOverride, handlePreview, selectedModes, showToast, toggleMode, tr, updateModeOverride]);

  const previewAdaptiveFilter = useCallback(async (edit: PhotoEdit, original: HTMLImageElement | null, signal: AbortSignal): Promise<HTMLImageElement> => {
    const index = adaptiveEditorIndex;
    if (index === null) throw new PhotoColorError("stale");
    const snapshot = colorContextKey;
    const isCurrent = () => !signal.aborted && colorContext.current === snapshot && activeMacRef.current === mac;
    try {
      return await previewPhotoFilter(adaptiveImageUrls[index], readPhotoEdit(adaptivePhotoEdits[index], adaptiveImageUrls[index]), edit, original, {
        ...browserPhotoColorIO(uploadLocalImage, previewWidth, previewHeight),
        preview: async (url, candidate, previewSignal) => {
          const params = new URLSearchParams({ persona: "MY_ADAPTIVE", mac, w: String(previewWidth), h: String(previewHeight), colors: String(previewColors), no_cache: "1", mode_override: JSON.stringify(singlePhotoOverride({}, [url], [candidate], 0)) });
          const response = await fetch(`/api/preview?${params}`, { headers: authHeaders(), cache: "no-store", signal: previewSignal });
          if (!response.ok) throw new Error("Filter preview unavailable");
          const blob = await response.blob();
          if (!isCurrent()) throw new PhotoColorError("stale");
          const objectUrl = URL.createObjectURL(blob);
          try { return await loadPhotoImage(objectUrl, previewSignal); }
          finally { URL.revokeObjectURL(objectUrl); }
        },
      }, filterRgbCache.current, signal, isCurrent);
    } catch (error) {
      if (error instanceof PhotoColorError && error.code === "stale") throw error;
      if (error instanceof PhotoColorError && error.code === "source_required") throw new Error(tr("这张照片只保留了已处理的四色图片，无法恢复另一种配色。请重新添加原始照片。", "Only a processed four-color image remains. Add the original photo again to use both filters."));
      throw new Error(tr("滤镜预览失败，当前配色已保留。请检查图片和软路由连接后重试。", "Could not preview this filter. Your current choice is kept. Check the image and router connection, then retry."));
    }
  }, [adaptiveEditorIndex, adaptiveImageUrls, adaptivePhotoEdits, colorContextKey, mac, previewWidth, previewHeight, previewColors, filterRgbCache, uploadLocalImage, tr]);

  const moveAdaptivePhoto = (from: number, to: number) => {
    if (to < 0 || to >= adaptiveImageUrls.length || from === to) return;
    const urls = [...adaptiveImageUrls];
    const edits = adaptiveImageUrls.map((url, i) => adaptivePhotoEdits[i] || newPhotoEdit(url));
    urls.splice(to, 0, urls.splice(from, 1)[0]);
    edits.splice(to, 0, edits.splice(from, 1)[0]);
    setAdaptiveImageUrls(urls); setAdaptivePhotoEdits(edits);
  };

  const saveAdaptivePhotos = async () => {
    if (!mac) return;
    if (saveInFlightRef.current || adaptiveUploading2) return;
    const savedRevision = draftRevisionRef.current;
    const normalizedModeOverrides = buildCurrentModeOverrides();
    const override = normalizedModeOverrides.MY_ADAPTIVE;
    saveInFlightRef.current = true;
    setAdaptiveSaving(true);
    try {
      const currentRes = await fetch(`/api/config/${encodeURIComponent(mac)}`, { headers: authHeaders(), cache: "no-store" });
      if (!currentRes.ok) throw new Error(tr("读取设备配置失败", "Could not load device settings"));
      const current = await currentRes.json() as DeviceConfig & Record<string, unknown>;
      const modes = adaptiveImageUrls.length ? Array.from(new Set([...selectedModes, "MY_ADAPTIVE"])) : Array.from(selectedModes);
      const body = {
        ...current, mac, modes,
        timeSlotRules, refreshStrategy: strategy, refreshInterval: refreshMin,
        ...currentLocation, modeLanguage, contentTone, characterTones, memoText,
        modeOverrides: normalizedModeOverrides,
        mode_overrides: normalizedModeOverrides,
        is_focus_listening: isFocusListening, always_active: alwaysActive,
      };
      const response = await fetch("/api/config", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(body) });
      if (!response.ok) throw new Error(tr("保存相框失败", "Could not save photo frame"));
      if (activeMacRef.current !== mac) return;
      setConfig((prev) => ({ ...prev, modes, modeOverrides: normalizedModeOverrides, mode_overrides: normalizedModeOverrides }));
      if (draftRevisionRef.current === savedRevision) {
        if (adaptiveImageUrls.length) setSelectedModes((prev) => new Set([...prev, "MY_ADAPTIVE"]));
        updateModeOverride("MY_ADAPTIVE", override);
      }
      setAdaptiveModal(null);
      const sync = await queueImmediateRefreshIfOnline(fetch, mac, authHeaders());
      if (activeMacRef.current !== mac) return;
      finishSavedDraft(savedRevision);
      void loadRuntimeMode();
      showToast(sync.onlineNow === null ? tr("相框已保存，暂时无法确认设备状态", "Frame saved. Device status is currently unavailable")
        : sync.refreshQueued ? tr("相框已保存，已通知设备刷新", "Frame saved and display refresh requested")
        : sync.onlineNow ? tr("相框已保存，设备在线，但刷新通知失败", "Frame saved. Device is online, but the refresh notification failed")
        : tr("相框已保存，设备将在下次唤醒时更新", "Frame saved. Display updates on its next wake."), sync.refreshQueued ? "success" : "info");
      if (adaptiveImageUrls.length) {
        setPreviewMode("MY_ADAPTIVE");
        await handlePreview("MY_ADAPTIVE", true, override);
      } else invalidatePreview();
    } catch (error) {
      showToast(error instanceof Error ? error.message : tr("保存失败", "Save failed"), "error");
    } finally { saveInFlightRef.current = false; setAdaptiveSaving(false); }
  };

  const saveVocabReviewSettings = useCallback(async (modeId: string, override: ModeOverride) => {
    if (!mac) {
      showToast(tr("请先完成刷机和配网以获取设备 MAC", "Please flash and provision to get device MAC"), "error");
      return;
    }
    if (macAccessDenied) {
      showToast(tr("你无权配置该设备", "No permission to configure this device"), "error");
      return;
    }

    const normalizedModeId = modeId.toUpperCase();
    const nextModeOverrides = {
      ...modeOverrides,
      [normalizedModeId]: sanitizeModeOverride({
        ...(modeOverrides[normalizedModeId] || {}),
        ...override,
      }),
    };
    const normalizedModeOverrides = buildCurrentModeOverrides(nextModeOverrides);
    if (saveInFlightRef.current || adaptiveUploading2) return;
    const savedRevision = draftRevisionRef.current;
    saveInFlightRef.current = true;

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        ...config,
        mac,
        modes: Array.from(selectedModes),
        refreshStrategy: strategy,
        refreshInterval: refreshMin,
        ...currentLocation,
        modeLanguage,
        contentTone,
        characterTones,
        modeOverrides: normalizedModeOverrides,
        mode_overrides: normalizedModeOverrides,
        memoText,
        is_focus_listening: isFocusListening,
        always_active: alwaysActive,
        timeSlotRules,
      };
      const res = await fetch("/api/config", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Save failed");
      if (activeMacRef.current !== mac) return;
      finishSavedDraft(savedRevision);
      if (draftRevisionRef.current === savedRevision) setModeOverrides(normalizedModeOverrides);
      setParamModal(null);
      showToast(tr("背单词设置已保存", "Vocab review settings saved"), "success");
    } catch {
      showToast(tr("保存失败", "Save failed"), "error");
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }, [
    adaptiveUploading2, buildCurrentModeOverrides, finishSavedDraft,
    config,
    alwaysActive,
    characterTones,
    contentTone,
    currentLocation,
    isFocusListening,
    mac,
    macAccessDenied,
    memoText,
    modeLanguage,
    modeOverrides,
    refreshMin,
    sanitizeModeOverride,
    selectedModes,
    showToast,
    strategy,
    timeSlotRules,
    tr,
  ]);

  const handlePreviewFromSettings = (addToCarousel: boolean) => {
    if (!settingsMode) return;
    const modeId = settingsMode;
    if (!applySettingsDrafts(modeId)) return;
    let forcedOverride: ModeOverride | undefined;
    if (modeId === "MEMO") {
      const latestMemo = memoSettingsInputRef.current?.value ?? "";
      if (latestMemo.trim()) {
        forcedOverride = { memo_text: latestMemo };
        updateModeOverride(modeId, { memo_text: latestMemo });
        setMemoText(latestMemo);
      }
    }
    if (addToCarousel && !selectedModes.has(modeId)) {
      toggleMode(modeId);
    }
    setSettingsMode(null);
    setPreviewMode(modeId);
    setTimeout(() => {
      handlePreview(modeId, true, forcedOverride);
    }, 0);
    showToast(
      addToCarousel
        ? tr("已加入轮播并刷新预览", "Added to rotation and preview refreshed")
        : tr("已刷新预览", "Preview refreshed"),
      "success",
    );
  };

  const handleApplyPreviewToScreen = async () => {
    if (!mac || !previewMode || !previewImg) return;
    setApplyToScreenLoading(true);
    try {
      const stateRes = await fetch(`/api/device/${encodeURIComponent(mac)}/state`, { cache: "no-store", headers: authHeaders() });
      if (!stateRes.ok) {
        showToast(tr("无法确认设备状态，已阻止发送", "Unable to verify device status. Sending was blocked"), "error");
        return;
      }
      const stateData = await stateRes.json();
      const mode = stateData?.runtime_mode;
      if (mode === "active" || mode === "interval") {
        setRuntimeMode(mode);
      }
      if (mode !== "active") {
        showToast(tr("设备处于间歇状态，不可发送", "Device is in interval mode and cannot receive content"), "error");
        return;
      }

      const previewResponse = await fetch(previewImg);
      if (!previewResponse.ok) throw new Error("preview image unavailable");
      const previewBlob = await previewResponse.blob();

      const qs = new URLSearchParams();
      qs.set("mode", previewMode);
      const res = await fetch(`/api/device/${encodeURIComponent(mac)}/apply-preview?${qs.toString()}`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "image/png" }),
        body: previewBlob,
      });
      if (!res.ok) throw new Error("apply-preview failed");
      setCurrentMode(previewMode);
      await loadRuntimeMode();
      showToast(tr("已下发到墨水屏", "Sent to E-Ink"), "success");
    } catch {
      showToast(tr("下发失败", "Send failed"), "error");
    } finally {
      setApplyToScreenLoading(false);
    }
  };

  const handleAddCustomPersona = () => {
    const v = customPersonaTone.trim();
    if (!v) return;
    setCharacterTones((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setCustomPersonaTone("");
  };

  const modeMeta = useMemo(() => {
    const map: Record<string, { name: string; tip: string }> = {};
    for (const item of catalogItems) {
      const mid = (item.mode_id || "").toUpperCase();
      if (!mid) continue;
      const lang = isEn ? item.i18n?.en : item.i18n?.zh;
      const name = (lang?.name && String(lang.name)) || (item.display_name && String(item.display_name)) || mid;
      const tip = (lang?.tip && String(lang.tip)) || (item.description && String(item.description)) || "";
      map[mid] = { name, tip };
    }
    return map;
  }, [catalogItems, isEn]);

  const coreModes = useMemo(
    () => catalogItems.filter((m) => m.category === "core").map((m) => m.mode_id.toUpperCase()),
    [catalogItems],
  );
  const extraModes = useMemo(
    () => catalogItems.filter((m) => m.category === "more").map((m) => m.mode_id.toUpperCase()),
    [catalogItems],
  );
  const customModes = useMemo(
    () => catalogItems.filter((m) => m.category === "custom").map((m) => m.mode_id.toUpperCase()),
    [catalogItems],
  );
  const customModeMeta = useMemo(
    () =>
      Object.fromEntries(
        catalogItems
          .filter((m) => m.category === "custom")
          .map((m) => {
            const lang = isEn ? m.i18n?.en : m.i18n?.zh;
            return [
              m.mode_id.toUpperCase(),
              {
                name: (lang?.name && String(lang.name)) || m.display_name || m.mode_id,
                tip: (lang?.tip && String(lang.tip)) || m.description || "",
              },
            ];
          }),
      ),
    [catalogItems, isEn],
  );
  const activeModeSchema = settingsMode ? (modeSchemaMap[settingsMode] || []) : [];

  const batteryPct = calculateBatteryPct(stats?.last_battery_voltage);
  const statusLabel = runtimeStatus === "loading" ? tr("正在确认状态…", "Checking status…")
    : runtimeStatus === "error" ? tr("暂时无法确认", "Status unavailable")
    : !isOnline ? tr("离线", "Offline")
    : runtimeMode === "active" ? tr("活跃状态", "Active")
    : runtimeMode === "interval" ? tr("间歇状态", "Interval") : tr("在线", "Online");
  return (
    <div className="local-workspace" onChangeCapture={(event) => { if (!(event.target as HTMLElement).closest("[data-photo-editor]")) setDirty(true); }}>
      {/* Hidden file picker for MY_ADAPTIVE multi-image upload */}
      <input
        ref={adaptiveFileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0] || null;
          e.currentTarget.value = "";
          if (!f) return;
          setAdaptiveUploading2(true);
          try {
            const url = await uploadLocalImage(f);
            setAdaptiveImageUrls((prev) => {
              if (prev.length >= 6) return prev;
              return [...prev, url];
            });
            setAdaptivePhotoEdits((prev) => [...prev, newPhotoEdit(url)].slice(0, 6));
            setAdaptiveEditorIndex(adaptiveImageUrls.length); setDirty(true);
          } catch (err) {
            const msg = err instanceof Error ? err.message : tr("请选择一张本地图片", "Please choose a local image");
            showToast(msg, "error");
          } finally {
            setAdaptiveUploading2(false);
          }
        }}
      />
      <header className="workspace-heading">
        <div><h1>{section === "frame" ? tr("我的相框", "My frame") : section === "rotation" ? tr("轮播安排", "Rotation schedule") : section === "content" ? tr("内容库", "Content library") : section === "devices" ? tr("我的设备", "My devices") : tr("设置", "Settings")}</h1>
        <p>{section === "frame" ? tr("喜欢的照片，值得多看一眼。", "Give your favorite moments a little more time.") : section === "rotation" ? tr("安排播放内容、顺序和刷新时间。", "Choose what plays, in which order and when.") : section === "content" ? tr("从日历到灵感，把需要的内容放上屏幕。", "From your calendar to a little inspiration.") : section === "devices" ? tr("连接在这里，内容就在身边。", "Your displays, all in one place.") : tr("属于你的服务，按你的方式运行。", "Your service, running your way.")}</p></div>
        {userDevices.length > 0 && <div className="workspace-device"><label htmlFor="active-device">{tr("当前设备", "Current display")}</label><select id="active-device" value={mac} onChange={(event) => chooseDevice(event.target.value)}>{userDevices.map((device) => <option key={device.mac} value={device.mac}>{device.nickname || device.mac}</option>)}</select><small role="status" aria-live="polite">{loading ? tr("连接中…", "Connecting…") : statusLabel}</small></div>}
      </header>
      {devicesError && <div className="local-notice is-error" role="alert"><AlertCircle size={18} /><span>{devicesError}</span><Button variant="ghost" size="sm" onClick={() => void loadUserDevices()}>{tr("重试", "Retry")}</Button></div>}
      {configError && section !== "settings" && <div className="local-notice is-error" role="alert"><AlertCircle size={18} /><span>{configError}</span><Button variant="ghost" size="sm" onClick={() => window.location.reload()}>{tr("重试", "Retry")}</Button></div>}
      {section === "settings" && <SettingsPanel locale={locale} mac={mac} />}
      {(section === "devices" || (!mac && !devicesLoading && section !== "settings")) && <section className="local-section">
        <div className="local-device-list">{userDevices.map((device) => <div key={device.mac} className="local-device-row"><div><h3>{device.nickname || tr("墨水屏", "E-ink display")}</h3><p>{device.mac}</p><p>{device.last_seen ? `${tr("最近在线", "Last seen")} · ${new Date(device.last_seen).toLocaleString(isEn ? "en-US" : "zh-CN")}` : tr("尚无在线记录", "No connection recorded")}</p></div><div><Button variant="outline" size="sm" onClick={() => chooseDevice(device.mac)}>{device.mac === mac ? tr("当前设备", "Selected") : tr("选择", "Select")}</Button><Button variant="ghost" size="sm" onClick={() => void renameDevice(device)}>{tr("改名", "Rename")}</Button><Button variant="ghost" size="sm" aria-label={tr("移除设备", "Remove device")} onClick={() => void handleUnbindDevice(device.mac)}><Trash2 size={16} /></Button></div></div>)}</div>
        <details className="local-panel" open={!userDevices.length}><summary className="font-semibold cursor-pointer min-h-11 flex items-center gap-2"><Plus size={18} />{tr("添加设备", "Add a device")}</summary><p>{tr("完成设备配网后，输入屏幕或配网页上的 MAC 地址。", "After Wi-Fi setup, enter the MAC address shown on the display or setup page.")}</p><div className="local-form mt-4"><div className="local-form-pair"><label>{tr("MAC 地址", "MAC address")}<input value={bindMacInput} onChange={(e) => setBindMacInput(e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" /></label><label>{tr("设备名称", "Device name")}<input value={bindNicknameInput} onChange={(e) => setBindNicknameInput(e.target.value)} placeholder={tr("例如：客厅相框", "e.g. Living room")} /></label></div><Button onClick={() => void handleBindDevice()} disabled={!bindMacInput.trim()}>{tr("添加到本地", "Add locally")}</Button></div></details>
      </section>}
      {(devicesLoading || (mac && loading)) && section !== "settings" && <div className="local-panel flex items-center justify-center gap-3 py-20" role="status"><Loader2 size={22} className="animate-spin" />{tr("正在读取设备与照片…", "Loading your display and photos…")}</div>}
      {mac && !loading && !configError && !macAccessDenied && section !== "settings" && (
        <div className="space-y-6">
          {section === "frame" && <FramePanel mac={mac} colors={previewColors} previewIdentity={previewIdentity} onPreviewInvalidated={invalidatePreview} images={adaptiveImageUrls} edits={adaptivePhotoEdits} width={previewWidth} height={previewHeight} uploading={adaptiveUploading2} saving={saving || adaptiveSaving || savingPrefs} preview={previewMode === "MY_ADAPTIVE" ? previewImg : null} previewLoading={previewLoading} status={statusLabel} deviceName={userDevices.find((device) => device.mac === mac)?.nickname || tr("墨水屏", "E-ink display")} interval={refreshMin} onAdd={() => adaptiveFileInputRef.current?.click()} onEdit={setAdaptiveEditorIndex} onMove={(from, to) => { moveAdaptivePhoto(from, to); setDirty(true); }} onRemove={(index) => { setAdaptiveImageUrls((previous) => previous.filter((_, i) => i !== index)); setAdaptivePhotoEdits((previous) => previous.filter((_, i) => i !== index)); setDirty(true); }} onSave={() => void saveAdaptivePhotos()} onPreview={(index, identity) => { setPreviewMode("MY_ADAPTIVE"); void handlePreview("MY_ADAPTIVE", true, singlePhotoOverride(getModeOverride("MY_ADAPTIVE"), adaptiveImageUrls, adaptivePhotoEdits, index), false, false, identity); }} tr={tr} />}
          <div>
            {/* Content */}
            <div className="flex-1 min-w-0">
            {/* Modes Tab */}
            {section === "content" && (
              <div className="space-y-6">
                <TemplateLibrary key={catalogItems.length} mac={mac} onApplied={() => void refreshCatalog()} tr={tr} />
                <div className="grid grid-cols-1 lg:grid-cols-[520px_1fr] gap-6 items-start">
                  <ModeSelector
                    tr={tr}
                    selectedModes={selectedModes}
                    customModes={customModes}
                    customModeMeta={customModeMeta}
                    modeMeta={modeMeta}
                    coreModes={coreModes}
                    extraModes={extraModes}
                    handleModePreview={handleModePreview}
                    handleModeApply={handleModeApply}
                    handleCustomModeDelete={handleCustomModeDelete}
                    onCreateCustomMode={openCreateCustomMode}
                    previewColors={previewColors}
                    onColorsChange={setPreviewColors}
                    previewWidth={previewWidth}
                    previewHeight={previewHeight}
                    onScreenSizeChange={(w, h) => { setPreviewWidth(w); setPreviewHeight(h); }}
                  />

                  <div ref={previewPanelRef}>
                  <EInkPreviewPanel
                    screenW={previewWidth}
                    screenH={previewHeight}
                    tr={tr}
                    previewModeLabel={
                      previewModeLabelOverride ||
                      (previewMode
                        ? (modeMeta[previewMode]?.name || customModeMeta[previewMode]?.name || previewMode)
                        : tr("请选择模式", "Select a mode"))
                    }
                    previewLoading={previewLoading}
                    previewStatusText={previewStatusText}
                    previewImg={previewImg}
                    previewCacheHit={previewCacheHit}
                    previewLlmStatus={previewLlmStatus}
                    canApplyToScreen={Boolean(mac && previewMode && previewImg)}
                    applyToScreenLoading={applyToScreenLoading}
                    onRegenerate={() => handlePreview(previewMode, true)}
                    onApplyToScreen={handleApplyPreviewToScreen}
                    rightActions={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSaveCustomMode}
                        disabled={!Boolean(customJson.trim())}
                        className="bg-white text-ink border-ink/20 hover:bg-ink hover:text-white active:bg-ink active:text-white disabled:bg-white disabled:text-ink/50"
                      >
                        {tr("保存模式", "Save Mode")}
                      </Button>
                    }
                  />
                  </div>
                </div>

                <Dialog
                  open={editingCustomMode}
                  onClose={() => {
                    setEditingCustomMode(false);
                  }}
                >
                  <DialogContent className="max-w-5xl">
                    <DialogHeader
                      onClose={() => {
                        setEditingCustomMode(false);
                      }}
                    >
                      <div>
                        <DialogTitle>{tr("创建自定义模式", "Create Custom Mode")}</DialogTitle>
                        <DialogDescription>
                          {tr(
                            "用文字描述让 AI 帮你生成，或手动选择布局模板自由搭配。",
                            "Describe what you want and let AI generate it, or pick a layout template and customize it yourself.",
                          )}
                        </DialogDescription>
                      </div>
                    </DialogHeader>

                    <div className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="text-xs text-ink-light mb-1">{tr("模式名称", "Mode name")}</div>
                          <input
                            value={customModeName}
                            onChange={(e) => setCustomModeName(e.target.value)}
                            placeholder={tr("模式名称（例如：今日英语）", "Mode name (e.g. Daily English)")}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                            disabled={customGenerating}
                          />
                        </div>
                        <div>
                          <div className="text-xs text-ink-light mb-1">{tr("模式简介", "Mode description")}</div>
                          <input
                            value={customModeDescription}
                            onChange={(e) => setCustomModeDescription(e.target.value)}
                            placeholder={tr("用于模式列表展示", "Shown in the mode list")}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                            disabled={customGenerating}
                          />
                        </div>
                      </div>

                      <div className="flex gap-2 border-b border-ink/10">
                        <button
                          type="button"
                          onClick={() => setCustomEditorTab("ai")}
                          className={`px-3 py-2 text-sm border-b-2 ${customEditorTab === "ai" ? "border-ink text-ink font-medium" : "border-transparent text-ink-light"}`}
                        >
                          {tr("描述生成", "Describe")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setCustomEditorTab("composer");
                            if (!customJson.trim()) {
                              setCustomEditorSource("composer");
                            }
                          }}
                          className={`px-3 py-2 text-sm border-b-2 ${customEditorTab === "composer" ? "border-ink text-ink font-medium" : "border-transparent text-ink-light"}`}
                        >
                          {tr("模板搭建", "Template")}
                        </button>
                      </div>

                      {customEditorTab === "ai" ? (
                        <div className="space-y-3">
                          {customGenerating ? (
                            <div className="rounded-sm border border-ink/10 bg-paper px-3 py-3 text-sm text-ink-light flex items-center gap-2">
                              <Loader2 size={16} className="animate-spin" />
                              {tr("模式生成中...", "Generating mode...")}
                            </div>
                          ) : null}
                          <textarea
                            value={customDesc}
                            onChange={(e) => setCustomDesc(e.target.value)}
                            rows={4}
                            maxLength={2000}
                            placeholder={tr(
                              "描述你想要的模式，如：每天显示一个英语单词和释义，单词要大号字体居中",
                              "Describe your mode, e.g. show one English word and definition daily with a large centered font",
                            )}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm resize-y bg-white"
                            disabled={customGenerating}
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={() => {
                                void handleGenerateMode();
                              }}
                              disabled={customGenerating || !customDesc.trim()}
                            >
                              {tr("AI 生成预览", "AI Generate Preview")}
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      {customEditorTab === "composer" ? (
                        composerCatalog ? (
                          <ModeComposer
                            tr={tr}
                            isEn={isEn}
                            catalog={composerCatalog}
                            state={composerState}
                            onChange={handleComposerChange}
                            syncError={composerSyncError}
                            onPreview={async () => {
                              const modeDef = buildComposerModeDefinition({
                                composer: composerState,
                                catalog: composerCatalog,
                                modeName: customModeName,
                                modeDescription: customModeDescription,
                                isEn,
                              });
                              const json = JSON.stringify(modeDef, null, 2);
                              setCustomJson(json);
                              setCustomEditorSource("composer");
                              await handleCustomPreview(modeDef);
                              setEditingCustomMode(false);
                              requestAnimationFrame(() => {
                                previewPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                              });
                            }}
                            previewDisabled={!customJson.trim()}
                            previewImgUrl={composerPreviewUrl}
                            previewLoading={composerPreviewLoading}
                            onRequestPreview={fetchComposerPreview}
                          />
                        ) : (
                          <div className="text-sm text-ink-light">{tr("正在加载拼装器配置...", "Loading composer catalog...")}</div>
                        )
                      ) : null}

                    </div>
                  </DialogContent>
                </Dialog>

              </div>
            )}

            {/* Preferences Tab */}
            {section === "rotation" && (
              <div className="space-y-4">
                <RotationQueue modes={Array.from(selectedModes)} labels={{ ...modeMeta, ...customModeMeta }} onChange={(modes) => { setSelectedModes(new Set(modes)); setDirty(true); }} onSettings={(mode) => { if (mode === "MY_ADAPTIVE") setAdaptiveModal({ action: "apply" }); else if (requiresParamModal(mode)) openParamModal(mode, "apply"); else setSettingsMode(mode); }} onBrowse={() => goSection("content")} tr={tr} />
                <RefreshStrategyEditor
                  tr={tr}
                  locale={isEn ? "en" : "zh"}
                  location={currentLocation}
                  setLocation={applyGlobalLocation}
                  modeLanguage={modeLanguage}
                  setModeLanguage={(value) => { setModeLanguage(value); setDirty(true); }}
                  modeLanguageOptions={MODE_LANGUAGE_OPTIONS}
                  contentTone={contentTone}
                  setContentTone={(value) => { setContentTone(value); setDirty(true); }}
                  characterTones={characterTones}
                  setCharacterTones={(value) => { setCharacterTones(value); setDirty(true); }}
                  customPersonaTone={customPersonaTone}
                  setCustomPersonaTone={setCustomPersonaTone}
                  handleAddCustomPersona={handleAddCustomPersona}
                  strategy={strategy}
                  setStrategy={(value) => { setStrategy(value); setDirty(true); }}
                  refreshMin={refreshMin}
                  setRefreshMin={(value) => { setRefreshMin(value); setDirty(true); }}
                  toneOptions={TONE_OPTIONS}
                  personaPresets={PERSONA_PRESETS}
                  strategies={STRATEGIES}
                  timeSlotRules={timeSlotRules}
                  setTimeSlotRules={(value) => { setTimeSlotRules(value); setDirty(true); }}
                  availableModes={selectedModes ? Array.from(selectedModes) : []}
                  modeMeta={modeMeta}
                />
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{tr("设备活跃状态", "Device Active State")}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <label className="flex items-start gap-3 text-sm text-ink">
                      <input
                        type="checkbox"
                        checked={alwaysActive}
                        onChange={(e) => setAlwaysActive(e.target.checked)}
                        className="mt-1"
                      />
                      <div>
                        <div className="font-medium">{tr("始终保持活跃", "Keep device always active")}</div>
                        <div className="text-xs text-ink-light mt-1">
                          {tr(
                            "开启后，设备会持续保持活跃，不进入间歇状态或深度睡眠。设备在线时会立即生效；若设备在深睡，请先短按 BOOT 唤醒后再保存，或等待下次唤醒后生效。",
                            "When enabled, the device stays active continuously and will not enter interval mode or deep sleep. For immediate effect, wake the device with BOOT before saving; otherwise it applies on the next wake.",
                          )}
                        </div>
                      </div>
                    </label>
                  </CardContent>
                </Card>
                <Button
                  variant="outline"
                  onClick={handleSavePreferences}
                  disabled={!mac || savingPrefs}
                  className="w-full bg-white text-ink border-ink/20 hover:bg-ink hover:text-white active:bg-ink active:text-white disabled:bg-white disabled:text-ink/50"
                >
                  {savingPrefs ? <Loader2 size={14} className="animate-spin mr-1" /> : <Save size={14} className="mr-1" />}
                  {tr("保存", "Save")}
                </Button>
              </div>
            )}

            {/* Stats Tab */}
            {activeTab === "stats" && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 size={18} /> {tr("设备状态", "Device Status")}
                    {mac && <Button variant="ghost" size="sm" onClick={loadStats}><RefreshCw size={12} /></Button>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="mb-5 flex flex-wrap gap-3 items-center"><Button variant="outline" onClick={handleToggleFocusListening} disabled={focusToggleLoading}>{isFocusListening ? tr("关闭专注监听", "Disable focus listening") : tr("开启专注监听", "Enable focus listening")}</Button><p className="text-sm text-ink-light">{tr("开启后保持联网，接收设备紧急告警。", "Keep the display connected for urgent alerts.")}</p></div>
                  {!mac && <p className="text-sm text-ink-light">{tr("需要连接设备后才能查看状态", "Connect a device to view status")}</p>}
                  {mac && !stats && <p className="text-sm text-ink-light">{tr("暂无统计数据", "No stats yet")}</p>}
                  {stats && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                      <StatCard label={tr("总渲染次数", "Total Renders")} value={stats.total_renders ?? "-"} />
                      <StatCard label={tr("缓存命中率", "Cache Hit Rate")} value={stats.cache_hit_rate != null ? `${Math.round(stats.cache_hit_rate)}%` : "-"} />
                      <StatCard label={tr("电量", "Battery")} value={batteryPct != null ? `${batteryPct}%` : "-"} />
                      <StatCard label={tr("电压", "Voltage")} value={stats.last_battery_voltage ? `${stats.last_battery_voltage.toFixed(2)}V` : "-"} />
                      <StatCard label={tr("WiFi 信号", "WiFi RSSI")} value={stats.last_rssi ? `${stats.last_rssi} dBm` : "-"} />
                      <StatCard label={tr("错误次数", "Error Count")} value={stats.error_count ?? "-"} />
                      {stats.last_refresh && <StatCard label={tr("上次刷新", "Last Refresh")} value={new Date(stats.last_refresh).toLocaleString(isEn ? "en-US" : "zh-CN")} />}
                    </div>
                  )}
                  {stats?.mode_frequency && Object.keys(stats.mode_frequency).length > 0 && (
                    <div className="mt-6">
                      <h4 className="text-sm font-medium mb-3">{tr("模式使用频率", "Mode Frequency")}</h4>
                      <div className="space-y-2">
                        {Object.entries(stats.mode_frequency)
                          .sort(([, a], [, b]) => b - a)
                          .map(([mode, count]) => {
                            const max = Math.max(...Object.values(stats.mode_frequency!));
                            return (
                              <div key={mode} className="flex items-center gap-2 text-sm">
                                <span className="w-20 text-ink-light truncate">{modeMeta[mode]?.name || customModeMeta[mode]?.name || mode}</span>
                                <div className="flex-1 bg-paper-dark rounded-full h-4 overflow-hidden">
                                  <div className="bg-ink h-full rounded-full" style={{ width: `${(count / max) * 100}%` }} />
                                </div>
                                <span className="w-8 text-right text-ink-light text-xs">{count}</span>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          {mac && settingsMode && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/30" onClick={() => setSettingsMode(null)} />
              <Card className="relative z-10 w-full max-w-md">
                <CardHeader>
                  <CardTitle className="flex items-center justify-between text-base">
                    <span>
                      {tr("模式设置", "Mode Settings")}: {modeMeta[settingsMode]?.name || customModeMeta[settingsMode]?.name || settingsMode}
                    </span>
                    <button className="text-ink-light hover:text-ink" onClick={() => setSettingsMode(null)}>
                      <X size={16} />
                    </button>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Field label="城市（可选）">
                    <LocationPicker
                      value={extractLocationValue(getModeOverride(settingsMode) as Record<string, unknown>)}
                      onChange={(next) =>
                        updateModeOverride(settingsMode, {
                          city: next.city,
                          latitude: next.latitude,
                          longitude: next.longitude,
                          timezone: next.timezone,
                          admin1: next.admin1,
                          country: next.country,
                        })
                      }
                      locale={isEn ? "en" : "zh"}
                      placeholder={tr("搜索模式专属地点", "Search a mode-specific place")}
                      helperText={tr(
                        `留空则使用全局默认：${describeLocation(currentLocation) || "杭州"}`,
                        `Leave empty to use global default: ${describeLocation(currentLocation) || "Hangzhou"}`,
                      )}
                      className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm"
                    />
                  </Field>
                  {activeModeSchema.map((item) => {
                    const key = `${settingsMode}:${item.key}`;
                    const override = getModeOverride(settingsMode);
                    const rawValue = override[item.key] ?? item.default;
                    const valueType = item.type || "text";
                    const options = (item.options || []).map((opt) => typeof opt === "string"
                      ? { value: opt, label: opt }
                      : { value: opt.value, label: opt.label });

                    if (settingsMode === "COUNTDOWN" && item.key === "countdownEvents") {
                      const events = Array.isArray(rawValue)
                        ? rawValue.map((ev) => ({
                            name: typeof ev?.name === "string" ? ev.name : "",
                            date: typeof ev?.date === "string" ? ev.date : "",
                            type: ev?.type === "countup" ? "countup" : "countdown",
                          }))
                        : [];
                      return (
                        <Field key={key} label="倒计时事件">
                          {events.map((ev, i) => (
                            <div key={`${key}:${i}`} className="flex gap-2 mb-2">
                              <input
                                value={ev.name}
                                onChange={(e) => {
                                  const next = [...events];
                                  next[i] = { ...next[i], name: e.target.value };
                                  updateModeOverride(settingsMode, { [item.key]: next });
                                }}
                                placeholder="事件名"
                                className="flex-1 rounded-sm border border-ink/20 px-3 py-1.5 text-sm"
                              />
                              <input
                                type="date"
                                value={ev.date}
                                onChange={(e) => {
                                  const next = [...events];
                                  next[i] = { ...next[i], date: e.target.value };
                                  updateModeOverride(settingsMode, { [item.key]: next });
                                }}
                                className="rounded-sm border border-ink/20 px-3 py-1.5 text-sm"
                              />
                              <select
                                value={ev.type}
                                onChange={(e) => {
                                  const next = [...events];
                                  next[i] = { ...next[i], type: e.target.value === "countup" ? "countup" : "countdown" };
                                  updateModeOverride(settingsMode, { [item.key]: next });
                                }}
                                className="rounded-sm border border-ink/20 px-2 py-1.5 text-sm bg-white"
                              >
                                <option value="countdown">倒计时</option>
                                <option value="countup">正计时</option>
                              </select>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  const next = events.filter((_, j) => j !== i);
                                  updateModeOverride(settingsMode, { [item.key]: next });
                                }}
                              >
                                x
                              </Button>
                            </div>
                          ))}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const next = [...events, { name: "", date: "", type: "countdown" }];
                              updateModeOverride(settingsMode, { [item.key]: next });
                            }}
                          >
                            + 添加事件
                          </Button>
                        </Field>
                      );
                    }

                    if (item.as_json) {
                      const draft = settingsJsonDrafts[key] ?? (
                        rawValue === undefined ? "" : JSON.stringify(rawValue, null, 2)
                      );
                      return (
                        <Field key={key} label={item.label}>
                          <textarea
                            value={draft}
                            onChange={(e) => {
                              setSettingsJsonDrafts((prev) => ({ ...prev, [key]: e.target.value }));
                            }}
                            onBlur={() => {
                              const text = settingsJsonDrafts[key] ?? "";
                              if (!text.trim()) {
                                updateModeOverride(settingsMode, { [item.key]: undefined });
                                setSettingsJsonErrors((prev) => {
                                  const copied = { ...prev };
                                  delete copied[key];
                                  return copied;
                                });
                                return;
                              }
                              try {
                                const parsed = JSON.parse(text);
                                updateModeOverride(settingsMode, { [item.key]: parsed });
                                setSettingsJsonErrors((prev) => {
                                  const copied = { ...prev };
                                  delete copied[key];
                                  return copied;
                                });
                              } catch {
                                setSettingsJsonErrors((prev) => ({ ...prev, [key]: "JSON 格式错误" }));
                              }
                            }}
                            rows={4}
                            placeholder={item.placeholder}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm font-mono"
                          />
                          {settingsJsonErrors[key] ? (
                            <p className="mt-1 text-xs text-red-600">{settingsJsonErrors[key]}</p>
                          ) : null}
                        </Field>
                      );
                    }

                    if (valueType === "textarea") {
                      return (
                        <Field key={key} label={item.label}>
                          <textarea
                            ref={settingsMode === "MEMO" && item.key === "memo_text" ? memoSettingsInputRef : undefined}
                            value={typeof rawValue === "string" ? rawValue : ""}
                            onChange={(e) => {
                              const next = e.target.value;
                              updateModeOverride(settingsMode, { [item.key]: next });
                              if (settingsMode === "MEMO" && item.key === "memo_text") {
                                setMemoText(next);
                              }
                            }}
                            rows={3}
                            placeholder={item.placeholder}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm"
                          />
                        </Field>
                      );
                    }

                    if (valueType === "number") {
                      return (
                        <Field key={key} label={item.label}>
                          <input
                            type="number"
                            value={typeof rawValue === "number" ? rawValue : (item.default as number | undefined) ?? ""}
                            min={item.min}
                            max={item.max}
                            step={item.step}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (!v) {
                                updateModeOverride(settingsMode, { [item.key]: undefined });
                                return;
                              }
                              updateModeOverride(settingsMode, { [item.key]: Number(v) });
                            }}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm"
                          />
                        </Field>
                      );
                    }

                    if (valueType === "boolean") {
                      const checked = Boolean(rawValue);
                      return (
                        <Field key={key} label={item.label}>
                          <label className="inline-flex items-center gap-2 text-sm text-ink">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => updateModeOverride(settingsMode, { [item.key]: e.target.checked })}
                            />
                            启用
                          </label>
                        </Field>
                      );
                    }

                    if (valueType === "select" && options.length > 0) {
                      const current = typeof rawValue === "string" ? rawValue : options[0].value;
                      return (
                        <Field key={key} label={item.label}>
                          <select
                            value={current}
                            onChange={(e) => updateModeOverride(settingsMode, { [item.key]: e.target.value })}
                            className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                          >
                            {options.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </Field>
                      );
                    }

                    return (
                      <Field key={key} label={item.label}>
                        <input
                          value={typeof rawValue === "string" ? rawValue : ""}
                          onChange={(e) => updateModeOverride(settingsMode, { [item.key]: e.target.value })}
                          placeholder={item.placeholder}
                          className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm"
                        />
                      </Field>
                    );
                  })}
                  <div className="flex items-center justify-between">
                    <Button variant="outline" size="sm" onClick={() => clearModeOverride(settingsMode)}>
                      恢复默认
                    </Button>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handlePreviewFromSettings(false)}>
                        预览
                      </Button>
                      <Button
                        variant={settingsMode && selectedModes.has(settingsMode) ? "default" : "outline"}
                        size="sm"
                        className={
                          settingsMode && selectedModes.has(settingsMode)
                            ? "bg-ink text-white border-ink hover:bg-ink hover:text-white"
                            : "bg-white text-ink border-ink/20 hover:bg-ink hover:text-white active:bg-ink active:text-white"
                        }
                        onClick={() => handlePreviewFromSettings(true)}
                      >
                        预览并加入轮播
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
          </div>
        </div>
      )}

      <Dialog
        open={showFocusTokenModal}
        onClose={() => {
          setShowFocusTokenModal(false);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader
            onClose={() => {
              setShowFocusTokenModal(false);
            }}
          >
            <div>
              <DialogTitle>{tr("设备告警 Token 已生成", "Alert Token Generated")}</DialogTitle>
              <DialogDescription>
                {tr(
                  "将下面的 Token 配置到你的 OpenCLAW（或自建 Agent）里，用于向该设备发送紧急告警。",
                  "Copy this token into your OpenCLAW (or custom agent) to send urgent alerts to this device.",
                )}
              </DialogDescription>
              <div className="mt-2 text-[11px] text-ink-light">
                {tr(
                  "提示：开启专注监听后，设备端通常需要重启/重新进入启动流程，才会开始 10 秒轮询告警并在屏幕显示内容。",
                  "Tip: after enabling Focus Listening, the device usually needs a restart / re-enter startup flow before it starts 10s alert polling and displaying messages.",
                )}
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-sm border border-ink/20 bg-white px-3 py-2 text-xs font-mono break-all">
              {focusAlertToken || tr("（空）", "(empty)")}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(focusAlertToken);
                    showToast(tr("已复制 Token", "Token copied"), "success");
                  } catch {
                    showToast(tr("复制失败，请手动选中复制", "Copy failed, please copy manually"), "error");
                  }
                }}
                disabled={!focusAlertToken}
              >
                {tr("复制 Token", "Copy Token")}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setShowFocusTokenModal(false);
                }}
              >
                {tr("关闭", "Close")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {mac && section === "devices" && <DeviceHistory mac={mac} tr={tr} />}

      {mac && !loading && !configError && (section === "rotation" || section === "content" || dirty && section === "devices") && <div className="local-savebar"><div><strong>{dirty ? tr("有未保存的修改", "Unsaved changes") : tr("设备内容与播放设置", "Content & playback settings")}</strong><p>{tr("保存后，设备会在下一次同步时更新。", "Your display updates on its next sync.")}</p></div><Button onClick={handleSave} disabled={saving || adaptiveSaving || savingPrefs || adaptiveUploading2 || !selectedModes.size}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}{saving ? tr("保存中…", "Saving…") : tr("保存并刷新", "Save & refresh")}</Button></div>}

      {/* 相框多图管理弹窗 */}
      {adaptiveEditorIndex !== null && adaptiveImageUrls[adaptiveEditorIndex] && (
        <PhotoEditor key={photoPreviewIdentity(mac, previewWidth, previewHeight, previewColors, `${adaptiveEditorIndex}:${adaptiveImageUrls[adaptiveEditorIndex]}`, adaptivePhotoEdits[adaptiveEditorIndex])}
          initial={adaptivePhotoEdits[adaptiveEditorIndex] || newPhotoEdit(adaptiveImageUrls[adaptiveEditorIndex])}
          width={previewWidth} height={previewHeight} colors={previewColors} tr={tr}
          onCancel={() => setAdaptiveEditorIndex(null)}
          onFilterPreview={previewAdaptiveFilter}
          onSave={async (file, edit, variantUrl) => {
            const index = adaptiveEditorIndex;
            const snapshot = colorContextKey;
            const initial = readPhotoEdit(adaptivePhotoEdits[index], adaptiveImageUrls[index]);
            if (variantUrl && (!samePhotoGeometry(initial, edit) || edit.color_variants?.[edit.color_profile] !== variantUrl)) throw new Error("Invalid photo variant");
            const cached = filterRgbCache.current.get(photoGeometryIdentity(edit));
            const url = variantUrl || cached || (file ? await uploadLocalImage(file) : "");
            if (!url) throw new Error("Photo export unavailable");
            if (colorContext.current !== snapshot || activeMacRef.current !== mac) throw new Error(tr("照片已更改，请重新打开编辑。", "The photo changed. Reopen the editor."));
            setAdaptiveImageUrls((prev) => prev.map((old, i) => i === index ? url : old));
            setAdaptivePhotoEdits((prev) => adaptiveImageUrls.map((old, i) => i === index ? variantUrl ? readPhotoEdit(edit, url) : exportedPhotoEdit(edit) : prev[i] || newPhotoEdit(old)));
            setAdaptiveEditorIndex(null); setDirty(true);
          }} />
      )}
      {adaptiveModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setAdaptiveModal(null)} />
          <div className="relative w-[min(640px,calc(100vw-32px))] max-h-[92vh] overflow-y-auto rounded-sm border border-ink/15 bg-white shadow-xl">
            <div className="px-4 py-3 border-b border-ink/10 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink">
                {tr("相框图片管理", "Photo Frame Images")}
              </div>
              <button className="text-ink-light hover:text-ink" onClick={() => setAdaptiveModal(null)}>
                ✕
              </button>
            </div>
            <div className="px-4 py-4 space-y-3">
              <div className="text-xs text-ink-light">
                {tr(
                  "上传至多 6 张图片，按序号循环播放。拖动图片或点击前后箭头调整顺序。",
                  "Upload up to 6 photos, played in numbered order. Drag photos or use the arrows to reorder.",
                )}
              </div>
              <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {tr(
                  "点击“编辑”设置横竖屏、旋转和缩放。保存相框后，图片、编辑参数和播放顺序都会保留，重启也能继续播放。",
                  "Edit orientation, rotation and zoom. Saving the frame preserves originals, edits and order across restarts.",
                )}
              </div>
              <div className="grid grid-cols-3 gap-2">
                {adaptiveImageUrls.map((url, i) => (
                  <div key={`${url}-${i}`} draggable={!adaptiveSaving}
                    onDragStart={() => { adaptiveDragIndex.current = i; }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => { event.preventDefault(); if (adaptiveDragIndex.current !== null) moveAdaptivePhoto(adaptiveDragIndex.current, i); adaptiveDragIndex.current = null; }}
                    onDragEnd={() => { adaptiveDragIndex.current = null; }}
                    className="relative group rounded border border-ink/15 overflow-hidden bg-paper-dark">
                    <div className="relative aspect-[4/3]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={localPhotoSource(url)} alt={`photo ${i + 1}`} draggable={false} className="w-full h-full object-contain" />
                    <button
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => { setAdaptiveImageUrls((prev) => prev.filter((_, idx) => idx !== i)); setAdaptivePhotoEdits((prev) => prev.filter((_, idx) => idx !== i)); setDirty(true); }}
                      title={tr("移除", "Remove")}
                    >
                      ✕
                    </button>
                    <div className="absolute bottom-0 left-0 right-0 bg-black/40 text-white text-[10px] text-center py-0.5">
                      {i + 1}
                    </div>
                    </div>
                    <div className="flex items-center justify-between gap-1 bg-white px-2 py-2">
                      <button type="button" aria-label={tr(`将照片 ${i + 1} 前移`, `Move photo ${i + 1} earlier`)} disabled={i === 0 || adaptiveSaving} onClick={() => { moveAdaptivePhoto(i, i - 1); setDirty(true); }} className="px-2 py-1 text-sm border rounded disabled:opacity-30">←</button>
                      <button type="button" aria-label={tr(`编辑照片 ${i + 1}`, `Edit photo ${i + 1}`)} onClick={() => setAdaptiveEditorIndex(i)} className="px-2 py-1 text-xs border rounded hover:bg-ink/5">{tr("编辑", "Edit")}</button>
                      <button type="button" aria-label={tr(`将照片 ${i + 1} 后移`, `Move photo ${i + 1} later`)} disabled={i === adaptiveImageUrls.length - 1 || adaptiveSaving} onClick={() => { moveAdaptivePhoto(i, i + 1); setDirty(true); }} className="px-2 py-1 text-sm border rounded disabled:opacity-30">→</button>
                    </div>
                  </div>
                ))}
                {adaptiveImageUrls.length < 6 && (
                  <button
                    className="aspect-[4/3] rounded border-2 border-dashed border-ink/20 flex flex-col items-center justify-center text-ink-light hover:text-ink hover:border-ink/40 transition-colors"
                    onClick={() => adaptiveFileInputRef.current?.click()}
                    disabled={adaptiveUploading2}
                  >
                    {adaptiveUploading2 ? (
                      <Loader2 size={20} className="animate-spin" />
                    ) : (
                      <>
                        <span className="text-xl leading-none">+</span>
                        <span className="text-[10px] mt-0.5">{tr("添加图片", "Add")}</span>
                      </>
                    )}
                  </button>
                )}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => setAdaptiveModal(null)}
                >
                  {tr("取消", "Cancel")}
                </Button>
                <Button
                  variant="outline"
                  disabled={adaptiveImageUrls.length === 0 || previewLoading || adaptiveSaving || adaptiveUploading2}
                  onClick={saveAdaptivePhotos}
                >
                  {adaptiveSaving ? tr("正在保存…", "Saving…") : tr("保存相框并预览", "Save Frame & Preview")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 参数弹窗：与 /preview 页面一致（预览/加入轮播都会触发） */}
      {paramModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setParamModal(null)} />
          <div className="relative w-[min(520px,calc(100vw-32px))] rounded-sm border border-ink/15 bg-white shadow-xl">
            <div className="px-4 py-3 border-b border-ink/10 flex items-center justify-between">
              <div className="text-sm font-semibold text-ink">
                {paramModal.type === "quote"
                  ? tr("自定义语录", "Custom Quote")
                  : paramModal.type === "weather"
                  ? tr("天气设置", "Weather Settings")
                  : paramModal.type === "memo"
                  ? tr("便签内容", "Memo Content")
                  : paramModal.type === "countdown"
                  ? tr("倒计时设置", "Countdown Settings")
                  : paramModal.type === "habit"
                  ? tr("习惯打卡", "Habit Tracker")
                  : paramModal.type === "calendar"
                  ? tr("日历提醒", "Calendar Reminders")
                  : paramModal.type === "timetable"
                  ? tr("课程表设置", "Timetable Settings")
                  : paramModal.type === "vocab"
                  ? tr("背单词设置", "Vocab Review Settings")
                  : tr("人生进度条", "Life Progress")}
              </div>
              <button className="text-ink-light hover:text-ink" onClick={() => setParamModal(null)}>
                ✕
              </button>
            </div>
            <div className="px-4 py-4 space-y-3">
              {paramModal.type === "quote" ? (
                <>
                  <div className="text-xs text-ink-light">
                    {tr(
                      "随机生成一条有深度的语录，或粘贴你自己的文字。",
                      "Generate a deep quote randomly, or paste your own text.",
                    )}
                  </div>
                  <textarea
                    value={quoteDraft}
                    onChange={(e) => setQuoteDraft(e.target.value)}
                    placeholder={tr("输入语录内容...", "Type your quote...")}
                    className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm min-h-28 bg-white"
                  />
                  <input
                    value={authorDraft}
                    onChange={(e) => setAuthorDraft(e.target.value)}
                    placeholder={tr("作者（可选）", "Author (optional)")}
                    className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        commitModalAction(paramModal.mode, paramModal.action);
                      }}
                      disabled={previewLoading}
                    >
                      {tr("随机生成", "Random generate")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        const q = quoteDraft.trim();
                        const a = authorDraft.trim();
                        commitModalAction(
                          paramModal.mode,
                          paramModal.action,
                          q ? ({ quote: q, author: a } as ModeOverride) : undefined,
                        );
                      }}
                      disabled={previewLoading}
                    >
                      {tr("使用我的输入", "Use my input")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "weather" ? (
                <>
                  <div className="text-xs text-ink-light">
                    {tr(
                      "搜索并选择具体地点查看天气，避免重名城市误匹配。",
                      "Search and choose a specific place to avoid ambiguous city names.",
                    )}
                  </div>
                  <LocationPicker
                    value={weatherDraftLocation}
                    onChange={setWeatherDraftLocation}
                    locale={isEn ? "en" : "zh"}
                    placeholder={tr("输入地点名称（如：上海、巴黎、Singapore）", "Enter a place name (e.g. Shanghai, Paris, Singapore)")}
                    helperText={tr("建议从候选列表中点选具体地点。", "Pick a precise result from the suggestion list.")}
                    className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                    autoFocus
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2">
                    <Button
                      variant="outline"
                      onClick={() => setWeatherDraftLocation(defaultWeatherLocation)}
                      disabled={previewLoading}
                    >
                      {tr("使用默认城市", "Use default city")}
                    </Button>
                    <Button
                      onClick={() => {
                        const nextLocation = cleanLocationValue(weatherDraftLocation);
                        commitModalAction(
                          paramModal.mode,
                          paramModal.action,
                          nextLocation.city ? (nextLocation as ModeOverride) : undefined,
                        );
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("预览天气", "Preview weather")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "memo" ? (
                <>
                  <div className="text-xs text-ink-light mb-2">
                    {tr("设置便签标题和内容（最多3组，空的组不会显示）", "Set memo titles and content (up to 3 groups, empty groups are hidden)")}
                  </div>
                  {([1, 2, 3] as const).map((i) => {
                    const tKey = `title${i}` as keyof typeof memoDraft;
                    const cKey = `text${i}` as keyof typeof memoDraft;
                    return (
                      <div key={i} className="space-y-1">
                        <label className="text-xs font-medium text-ink-light">
                          {tr(`标题 ${i}`, `Title ${i}`)}
                          {i > 1 && <span className="text-ink-light/50 ml-1">({tr("可选", "optional")})</span>}
                        </label>
                        <input
                          type="text"
                          value={memoDraft[tKey]}
                          onChange={(e) => setMemoDraft(prev => ({ ...prev, [tKey]: e.target.value }))}
                          placeholder={i === 1
                            ? tr("输入标题，如：今日待办", "e.g. Today's TODO")
                            : tr("可选标题", "Optional title")}
                          className="w-full rounded-sm border border-ink/20 px-3 py-1.5 text-sm bg-white"
                          autoFocus={i === 1}
                        />
                        <textarea
                          value={memoDraft[cKey]}
                          onChange={(e) => setMemoDraft(prev => ({ ...prev, [cKey]: e.target.value }))}
                          placeholder={tr("输入便签内容...", "Enter memo content...")}
                          className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm min-h-16 bg-white"
                        />
                      </div>
                    );
                  })}
                  <div className="flex justify-end pt-2">
                    <Button
                      onClick={() => {
                        const settings: ModeOverride = {};
                        for (const i of [1, 2, 3]) {
                          const tKey = `title${i}` as keyof typeof memoDraft;
                          const cKey = `text${i}` as keyof typeof memoDraft;
                          settings[`memo_title_${i}`] = memoDraft[tKey].trim();
                          settings[`memo_text_${i}`] = memoDraft[cKey].trim();
                        }
                        commitModalAction(
                          paramModal.mode,
                          paramModal.action,
                          settings,
                        );
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("预览便签", "Preview memo")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "countdown" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr("设置倒计时事件名称和日期", "Set countdown event name and date")}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-ink mb-1.5">
                        {tr("事件名称", "Event Name")}
                      </label>
                      <input
                        value={countdownName}
                        onChange={(e) => setCountdownName(e.target.value)}
                        placeholder={tr("例如：元旦、生日", "e.g., New Year, Birthday")}
                        className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-ink mb-1.5">
                        {tr("目标日期", "Target Date")}
                      </label>
                      <input
                        type="date"
                        value={countdownDate}
                        onChange={(e) => setCountdownDate(e.target.value)}
                        className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() => commitModalAction(paramModal.mode, paramModal.action, undefined, true)}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("使用默认", "Use Default")}
                    </Button>
                    <Button
                      onClick={() => {
                        const today = new Date();
                        const target = new Date(countdownDate);
                        const days = Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
                        commitModalAction(paramModal.mode, paramModal.action, {
                          events: [
                            {
                              name: countdownName || (isEn ? "Countdown" : "倒计时"),
                              date: countdownDate,
                              type: "countdown",
                              days,
                            },
                          ],
                        } as ModeOverride);
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("预览倒计时", "Preview Countdown")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "habit" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr(
                      "管理你的习惯列表，勾选今日已完成的习惯。用 ✕ 移除不想追踪的习惯。",
                      "Manage your habit list. Check off completed habits today. Use ✕ to remove habits you don't want to track.",
                    )}
                  </div>
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {habitItems.map((item, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={(e) => {
                            const next = [...habitItems];
                            next[idx] = { ...next[idx], done: e.target.checked };
                            setHabitItems(next);
                          }}
                          className="w-4 h-4"
                        />
                        <input
                          value={item.name}
                          onChange={(e) => {
                            const next = [...habitItems];
                            next[idx] = { ...next[idx], name: e.target.value };
                            setHabitItems(next);
                          }}
                          className="flex-1 rounded-sm border border-ink/20 px-3 py-1.5 text-sm bg-white"
                        />
                        <button
                          onClick={() => setHabitItems(habitItems.filter((_, i) => i !== idx))}
                          className="text-ink-light hover:text-red-500 px-2"
                          title={tr("移除此习惯", "Remove this habit")}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => setHabitItems([...habitItems, { name: "", done: false }])}
                    className="w-full mt-2 px-3 py-2 rounded-sm border border-dashed border-ink/20 text-sm text-ink-light hover:text-ink hover:border-ink/40 transition-colors"
                  >
                    + {tr("添加习惯", "Add Habit")}
                  </button>
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() => commitModalAction(paramModal.mode, paramModal.action, undefined, true)}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("使用默认", "Use Default")}
                    </Button>
                    <Button
                      onClick={() => {
                        const tracked = habitItems.filter((h) => h.name.trim());
                        commitModalAction(paramModal.mode, paramModal.action, {
                          habitItems: tracked.map((h) => ({ name: h.name.trim(), done: h.done })),
                        } as ModeOverride);
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("预览打卡", "Preview Habits")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "lifebar" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr("设置你的年龄和预期寿命", "Set your age and life expectancy")}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-ink mb-1.5">
                        {tr("芳龄几何？", "Your Age")}
                      </label>
                      <input
                        type="number"
                        value={userAge}
                        onChange={(e) => setUserAge(parseInt(e.target.value) || 0)}
                        min="0"
                        max="120"
                        className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-ink mb-1.5">
                        {tr("退休金领到？", "Life Expectancy")}
                      </label>
                      <div className="grid grid-cols-4 gap-2">
                        {[80, 90, 100, 120].map((years) => (
                          <button
                            key={years}
                            onClick={() => setLifeExpectancy(years)}
                            className={`px-3 py-2 rounded-sm text-sm transition-colors ${
                              lifeExpectancy === years
                                ? "bg-ink text-white"
                                : "bg-paper-dark text-ink hover:bg-ink/10"
                            }`}
                          >
                            {years} {tr("岁", "years")}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() => commitModalAction(paramModal.mode, paramModal.action, undefined, true)}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("使用默认", "Use Default")}
                    </Button>
                    <Button
                      onClick={() => {
                        const lifePct = ((userAge / lifeExpectancy) * 100).toFixed(1);
                        commitModalAction(paramModal.mode, paramModal.action, {
                          age: userAge,
                          life_expect: lifeExpectancy,
                          life_pct: parseFloat(lifePct),
                          life_label: isEn ? "Life" : "人生",
                        } as ModeOverride);
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("预览进度", "Preview Progress")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "calendar" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr(
                      "为日历中的特定日期添加提醒事项，提醒会显示在日期下方。",
                      "Add reminders for specific dates. They appear below each date in the calendar.",
                    )}
                  </div>
                  <CalendarReminders
                    reminders={
                      (getModeOverride("CALENDAR") as Record<string, unknown>)?.reminders as Record<string, string> ?? {}
                    }
                    onChange={(r) => {
                      updateModeOverride("CALENDAR", {
                        reminders: Object.keys(r).length > 0 ? r : undefined,
                      } as Record<string, unknown>);
                    }}
                    tr={tr}
                  />
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() => commitModalAction(paramModal.mode, paramModal.action, undefined, true)}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("跳过预览", "Skip Preview")}
                    </Button>
                    <Button
                      onClick={() => {
                        const reminders = (getModeOverride("CALENDAR") as Record<string, unknown>)?.reminders as Record<string, string> | undefined;
                        commitModalAction(paramModal.mode, paramModal.action,
                          reminders && Object.keys(reminders).length > 0
                            ? { reminders } as ModeOverride
                            : undefined,
                        );
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("预览日历", "Preview Calendar")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "timetable" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr(
                      "选择课表类型并编辑课程安排，点击单元格即可修改。",
                      "Choose timetable type and edit courses. Click any cell to modify.",
                    )}
                  </div>
                  <TimetableEditor
                    data={timetableData}
                    onChange={setTimetableData}
                    tr={tr}
                  />
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() => commitModalAction(paramModal.mode, paramModal.action, undefined, true)}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("使用默认", "Use Default")}
                    </Button>
                    <Button
                      onClick={() => {
                        commitModalAction(paramModal.mode, paramModal.action, {
                          style: timetableData.style,
                          weekdays: timetableData.weekdays,
                          periods: timetableData.periods,
                          courses: timetableData.courses,
                        } as ModeOverride);
                      }}
                      disabled={previewLoading}
                      variant="outline"
                    >
                      {tr("预览课程表", "Preview Timetable")}
                    </Button>
                  </div>
                </>
              ) : paramModal.type === "vocab" ? (
                <>
                  <div className="text-xs text-ink-light mb-3">
                    {tr(
                      "选择词库并设置每日目标。保存后，下次进入背词模式会使用新的设置。",
                      "Choose a deck and set the daily goal. The next vocab review session will use the saved settings.",
                    )}
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-ink-light mb-1">{tr("词库", "Deck")}</label>
                      <select
                        value={vocabDeckId}
                        onChange={(e) => setVocabDeckId(e.target.value)}
                        className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                      >
                        <option value="primary_en">{tr("小学英语", "Primary English")}</option>
                        <option value="middle_school_en">{tr("初中英语", "Middle School English")}</option>
                        <option value="high_school_en">{tr("高中英语", "High School English")}</option>
                        <option value="cet4_en">{tr("四级词汇", "CET-4")}</option>
                        <option value="cet6_en">{tr("六级词汇", "CET-6")}</option>
                        <option value="ielts_en">{tr("雅思词汇", "IELTS")}</option>
                        <option value="toefl_en">{tr("托福词汇", "TOEFL")}</option>
                        <option value="core_en">{tr("核心英语", "Core English")}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-ink-light mb-1">{tr("每日目标", "Daily Goal")}</label>
                      <input
                        type="number"
                        min={1}
                        max={200}
                        value={vocabDailyLimit}
                        onChange={(e) => setVocabDailyLimit(Math.max(1, Math.min(200, Number(e.target.value) || 30)))}
                        className="w-full rounded-sm border border-ink/20 px-3 py-2 text-sm bg-white"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 pt-3">
                    <Button
                      onClick={() =>
                        saveVocabReviewSettings(paramModal.mode, {
                          deck_id: "core_en",
                          daily_limit: 30,
                          new_cards_per_day: 30,
                        } as ModeOverride)
                      }
                      disabled={saving}
                      variant="outline"
                    >
                      {tr("保存默认", "Save Default")}
                    </Button>
                    <Button
                      onClick={() =>
                        saveVocabReviewSettings(paramModal.mode, {
                          deck_id: vocabDeckId,
                          daily_limit: vocabDailyLimit,
                          new_cards_per_day: vocabDailyLimit,
                        } as ModeOverride)
                      }
                      disabled={saving}
                      variant="outline"
                    >
                      {saving ? tr("保存中...", "Saving...") : tr("保存设置", "Save Settings")}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* Toast */}
      {toast && (
        <div role="status" className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-sm text-sm font-medium shadow-lg animate-fade-in ${
          toast.type === "success" ? "bg-green-50 text-green-800 border border-green-200"
          : toast.type === "error" ? "bg-red-50 text-red-800 border border-red-200"
          : "bg-amber-50 text-amber-800 border border-amber-200"
        }`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

export default function ConfigPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen text-ink-light"><Loader2 size={24} className="animate-spin mr-2" /> 加载中...</div>}>
      <ConfigPageInner />
    </Suspense>
  );
}
