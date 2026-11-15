import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Fonts } from "@/constants/theme";
import { validDate } from "../../functions/src/connected/model";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useConnected } from "@/contexts/ConnectedContext";
import { useTheme } from "@/contexts/ThemeContext";
import RecipeDetailModal from "@/components/RecipeDetailModal";
import {
  getPlanTemplates,
  savePlanTemplate,
  type PlanTemplate,
} from "@/services/firestoreService";
import {
  isoDate,
  weekRange,
  shiftDate,
  normaliseMeal,
  requestId,
  type Meal,
} from "@/services/connectedClient";
import PlanReview from './PlanReview';
import RecipePickerModal from './RecipePickerModal';
import { withServings, mealLabel, templateMeals } from '@/services/planning';
import ClassicCalendar from "./ClassicCalendar";
import { Sheet, Pill, Caption, IconButton } from "./classic";
import {
  Heading,
  Label,
  Button,
  Row,
  Field,
  DateField,
  assertDates,
  report,
} from "./ui";

export function MealEditor({
  meal,
  onClose,
  onSaved,
}: {
  meal: Meal;
  onClose: () => void;
  onSaved?: (meal: Meal) => void;
}) {
  const c = useConnected();
  const [value, setValue] = useState(meal);
  // Keep what was typed: converting on every keystroke drops "2." before "2.5".
  const [servingsText, setServingsText] = useState(String(meal.servings));
  const [extraText, setExtraText] = useState(String(meal.allocatedPortions ?? 0));
  const amount = (text: string) => Number(text.trim().replace(',', '.'));
  const [picker, setPicker] = useState<"main" | "side" | null>(null);
  const receipt = useRef<{key: string; id: string; changes: {meal: Meal; expectedRevision: number}[]} | null>(null);
  const flight = useRef(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (flight.current) return; flight.current = true;
    setBusy(true);
    try {
      assertDates(value.date);
      const servings = amount(servingsText);
      const allocatedPortions = extraText.trim() ? amount(extraText) : 0;
      if (servings <= 0 || !Number.isFinite(servings))
        throw new Error("Choose positive servings.");
      if (value.kind === "recipe" && (allocatedPortions < 0 || !Number.isFinite(allocatedPortions)))
        throw new Error("Enter extra portions as a number, or leave it empty.");
      const current = { ...withServings(value, servings), ...(value.kind === "recipe" ? { allocatedPortions } : {}) };
      if (current.kind === "recipe" && !current.recipeId)
        throw new Error("Choose a recipe.");
      const next = {
        ...current,
        id: meal.id,
        customLabel: current.customLabel?.trim(),
        ...(current.kind === "eating-out"
          ? {
              recipeId: "",
              sides: [],
              overrides: [],
              sourceMealId: undefined,
              allocatedPortions: 0,
            }
          : {}),
      };
      const key = JSON.stringify({id: meal.id, revision: meal.revision, current});
      const retry = receipt.current?.key === key ? receipt.current : null;
      const changes: { meal: Meal; expectedRevision: number }[] = retry?.changes ?? [
        {
          meal: next,
          expectedRevision: meal.revision,
        },
      ];
      if (current.kind === "leftover" && !retry) {
        const source = c.meals.find((m) => m.id === current.sourceMealId);
        if (!source) throw new Error("Choose the source cooking occasion.");
        const other = c.meals
          .filter(
            (m) =>
              m.kind === "leftover" &&
              m.sourceMealId === source.id &&
              m.id !== meal.id &&
              !["removed", "skipped"].includes(m.status),
          )
          .reduce((s, m) => s + m.servings, 0);
        changes.push({
          meal: {
            ...source,
            allocatedPortions: Math.max(
              source.allocatedPortions ?? 0,
              other + current.servings,
            ),
          },
          expectedRevision: source.revision,
        });
      }
      const command = { operation: 'mutate', changes };
      if (receipt.current?.key !== key) receipt.current = {key, id: requestId(), changes};
      await c.run(command, receipt.current.id);
      onSaved?.(next);
      onClose();
    } catch (e) {
      report(e);
    } finally {
      flight.current = false; setBusy(false);
    }
  };
  const isNew = !meal.revision;
  // A new meal is a three-step walkthrough; editing opens on the same steps, all reachable at once.
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(isNew ? 0 : 2);
  const [leftoverQuery, setLeftoverQuery] = useState("");
  const servingsValid = amount(servingsText) > 0 && Number.isFinite(amount(servingsText));
  const stepValid = [
    validDate(value.date) && !!value.mealType,
    servingsValid,
    value.kind === "recipe" ? !!value.recipeId
      : value.kind === "leftover" ? !!value.sourceMealId
        : true,
  ];
  const stepTitles = ["When", "Meal type", value.kind === "leftover" ? "Leftovers" : value.kind === "eating-out" ? "Details" : "Recipe"];
  const goTo = (next: number) => {
    setStep(next);
    setFurthest((f) => Math.max(f, next));
  };
  const dayLabel = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const cooked = c.meals
    .filter((m) => m.kind === "recipe" && m.date < value.date && !["removed", "skipped"].includes(m.status))
    .sort((x, y) => y.date.localeCompare(x.date));
  const query = leftoverQuery.trim().toLowerCase();
  const leftoverChoices = (query
    ? cooked.filter((m) => `${mealLabel(m, c.recipes[m.recipeId]?.title)} ${m.mealType} ${dayLabel(m.date)}`.toLowerCase().includes(query))
    : cooked
  ).slice(0, 30);
  const last = step === 2;
  const saveButton = (
    <View style={{ flex: 1 }}>
      <Button label={busy ? "Saving…" : isNew ? "Add to plan" : "Save changes"} disabled={busy || !c.online || (isNew && !stepValid.every(Boolean))} onPress={save} />
    </View>
  );
  const footer = (
    <Row>
      {step > 0 && <Button label="Back" secondary disabled={busy} onPress={() => setStep(step - 1)} />}
      {!last && (isNew
        ? <View style={{ flex: 1 }}><Button label="Next" disabled={!stepValid[step]} onPress={() => goTo(step + 1)} /></View>
        : <Button label="Next" secondary disabled={!stepValid[step]} onPress={() => goTo(step + 1)} />)}
      {(last || !isNew) && saveButton}
    </Row>
  );
  return (
    <Sheet title={isNew ? "Add meal" : "Edit meal"} onClose={() => {if (!busy) onClose();}} footer={footer}>
      <StepHeader titles={stepTitles} step={step} reachable={(i) => i <= furthest && stepValid.slice(0, i).every(Boolean)} onSelect={setStep} />

      {step === 0 && (
        <>
          <Heading>When is this meal?</Heading>
          <DateField label="Date" value={value.date} onChange={(date) => setValue((v) => ({ ...v, date }))} />
          <Label muted>Meal</Label>
          <Row>
            {["breakfast", "lunch", "dinner", "snack", "dessert"].map((mealType) => (
              <Pill key={mealType} label={mealType[0].toUpperCase() + mealType.slice(1)} selected={value.mealType === mealType}
                onPress={() => setValue((v) => ({ ...v, mealType }))} />
            ))}
          </Row>
        </>
      )}

      {step === 1 && (
        <>
          <Heading>What are you having?</Heading>
          {(["recipe", "leftover", "eating-out"] as const).map((kind) => (
            <ChoiceCard
              key={kind}
              icon={kind === "recipe" ? "restaurant-outline" : kind === "leftover" ? "file-tray-stacked-outline" : "storefront-outline"}
              title={kind === "recipe" ? "Cook a recipe" : kind === "leftover" ? "Leftovers" : "Eating out"}
              detail={kind === "recipe" ? "Pick from your cookbook; ingredients go on the shopping list."
                : kind === "leftover" ? "Eat portions saved from an earlier meal. Nothing extra to buy."
                  : "Takeaway or a meal out. Nothing goes on the shopping list."}
              selected={value.kind === kind}
              onPress={() => setValue((v) => ({ ...v, kind }))}
            />
          ))}
          <Field label={value.kind === "leftover" ? "Portions" : "Servings"} keyboardType="decimal-pad" value={servingsText} onChangeText={setServingsText} />
        </>
      )}

      {step === 2 && value.kind === "recipe" && (
        <>
          <Heading>Which recipe?</Heading>
          {value.recipeId ? (
            <ChoiceCard icon="restaurant" title={c.recipes[value.recipeId]?.title ?? "Saved recipe"} detail="Tap to choose a different recipe." selected onPress={() => setPicker("main")} />
          ) : (
            <Button label="Browse recipes" onPress={() => setPicker("main")} />
          )}
          {!!value.sides?.length && <Label muted>Sides</Label>}
          {value.sides?.map((s) => (
            <View key={s.recipeId} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1, minWidth: 0 }}><Label>{c.recipes[s.recipeId]?.title ?? s.recipeId}</Label></View>
              <IconButton icon="close" label={`Remove side ${c.recipes[s.recipeId]?.title ?? ""}`}
                onPress={() => setValue((v) => ({ ...v, sides: v.sides?.filter((x) => x.recipeId !== s.recipeId) }))} />
            </View>
          ))}
          {!!value.recipeId && <Button label="Add a side dish" secondary disabled={(value.sides?.length ?? 0) >= 8} onPress={() => setPicker("side")} />}
          <Field label="Extra portions to save for later (optional)" keyboardType="decimal-pad" value={extraText} onChangeText={setExtraText} />
          <Caption>Cooking a bigger batch? Reserve portions here, then add them later as Leftovers.</Caption>
          <Field label="Meal label (optional)" value={value.customLabel ?? ""} maxLength={200} onChangeText={customLabel => setValue(v => ({...v,customLabel}))} />
        </>
      )}

      {step === 2 && value.kind === "leftover" && (
        <>
          <Heading>Leftovers from which meal?</Heading>
          <Caption>Saving reserves these portions on the original meal, so groceries are only counted once.</Caption>
          {cooked.length > 0 && (
            <Field label="Search cooked meals" placeholder="Recipe name, day or meal" value={leftoverQuery} onChangeText={setLeftoverQuery}
              autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing" />
          )}
          {cooked.length === 0 ? (
            <Label muted>No cooked meals before {dayLabel(value.date)}. Go back and pick a later date, or cook a recipe first.</Label>
          ) : leftoverChoices.length === 0 ? (
            <Label muted>No cooked meals match “{leftoverQuery.trim()}”.</Label>
          ) : leftoverChoices.map((m) => (
            <ChoiceCard
              key={m.id}
              title={mealLabel(m, c.recipes[m.recipeId]?.title)}
              detail={`${dayLabel(m.date)} · ${m.mealType} · ${m.servings} servings`}
              selected={value.sourceMealId === m.id}
              onPress={() => setValue((v) => ({ ...v, sourceMealId: m.id, recipeId: m.recipeId }))}
            />
          ))}
          <Field label="Meal label (optional)" value={value.customLabel ?? ""} maxLength={200} onChangeText={customLabel => setValue(v => ({...v,customLabel}))} />
        </>
      )}

      {step === 2 && value.kind === "eating-out" && (
        <>
          <Heading>Where are you eating?</Heading>
          <Field label="Restaurant or takeaway (optional)" placeholder="e.g. Pizza night" value={value.customLabel ?? ""} maxLength={200}
            onChangeText={customLabel => setValue(v => ({...v,customLabel}))} />
          <Caption>Nothing is added to the shopping list for this meal.</Caption>
        </>
      )}

      {picker && <RecipePickerModal mealType={picker === 'side' ? 'side' : value.mealType} date={value.date}
        onClose={() => setPicker(null)} onSelect={recipe => {
          setValue(v => picker === 'side' ? {...v, sides:[...(v.sides ?? []).filter(s => s.recipeId !== recipe.id), {recipeId:recipe.id!,servings:amount(servingsText) > 0 ? amount(servingsText) : v.servings}]} : {...v, recipeId:recipe.id!, overrides:[], sourceMealId:undefined});
          setPicker(null);
        }} />}
    </Sheet>
  );
}

/** Numbered progress for the add-meal walkthrough; earlier (and, when editing, all) steps can be tapped. */
function StepHeader({ titles, step, reachable, onSelect }: {
  titles: string[];
  step: number;
  reachable: (index: number) => boolean;
  onSelect: (index: number) => void;
}) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 6 }}>
      {titles.map((title, i) => {
        const active = i === step, done = i < step, enabled = reachable(i) && !active;
        return (
          <Pressable key={i} accessibilityRole="tab" accessibilityLabel={`Step ${i + 1} of ${titles.length}: ${title}`}
            accessibilityState={{ selected: active, disabled: !enabled && !active }} disabled={!enabled} onPress={() => onSelect(i)}
            style={{ flex: 1, minHeight: 44, gap: 6, justifyContent: "flex-end" }}>
            <Text numberOfLines={1} style={{ fontFamily: active ? Fonts.semibold : Fonts.medium, fontSize: 12, color: active ? colors.text : colors.textSecondary }}>
              {i + 1}. {title}
            </Text>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: active || done ? colors.primary : colors.border }} />
          </Pressable>
        );
      })}
    </View>
  );
}

/** A large, single-choice option: icon, title and one line of explanation. */
function ChoiceCard({ icon, title, detail, selected, onPress }: {
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="radio" accessibilityLabel={detail ? `${title}. ${detail}` : title} accessibilityState={{ checked: selected }} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 18,
        borderWidth: selected ? 2 : 1, borderColor: selected ? colors.primary : colors.border,
        backgroundColor: selected ? colors.primaryLight : colors.surface, opacity: pressed ? 0.75 : 1 })}>
      {icon && <Ionicons name={icon} size={22} color={selected ? colors.primaryText : colors.textSecondary} />}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ fontFamily: Fonts.semibold, fontSize: 16, color: colors.text }}>{title}</Text>
        {!!detail && <Caption>{detail}</Caption>}
      </View>
      <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.primaryText : colors.textTertiary} />
    </Pressable>
  );
}

export default function PlanScreen() {
  const c = useConnected();
  const { colors } = useTheme();
  const { householdId } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{
    weekStart?: string;
    recipeId?: string;
    date?: string;
    mealId?: string;
  }>();
  const [start, setStart] = useState(weekRange().start);
  const [selectedDate, setSelectedDate] = useState(isoDate(new Date()));
  const [view, setView] = useState<"week" | "month">("week");
  const [editor, setEditor] = useState<Meal | null>(null);
  const [preview, setPreview] = useState<Meal | null>(null);
  const [undo, setUndo] = useState<Meal | null>(null);
  const [menuMeal, setMenuMeal] = useState<Meal | null>(null);
  const [swapMeal, setSwapMeal] = useState<Meal | null>(null);
  const [reviewMeals, setReviewMeals] = useState<Meal[] | null>(null);
  const [templates, setTemplates] = useState<PlanTemplate[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateDate, setTemplateDate] = useState(weekRange().start);
  const [showTemplates, setShowTemplates] = useState(false);
  const today = isoDate(new Date());
  const alive = c.meals.filter((m) => m.status !== "removed");
  useEffect(() => {
    if (params.weekStart) {
      try {
        assertDates(params.weekStart);
        setStart(weekRange(params.weekStart).start);
        setSelectedDate(params.weekStart);
        setView("week");
      } catch (e) {
        report(e);
      }
      router.setParams({ weekStart: undefined });
    }
  }, [params.weekStart, router]);
  useEffect(() => {
    if (params.recipeId) {
      const date = params.date ?? today;
      setEditor(
        normaliseMeal(requestId(), {
          recipeId: params.recipeId,
          date,
          mealType: "dinner",
          servings:
            (c.settings.defaultAdults ?? 2) +
            (c.settings.defaultChildren ?? 0) * 0.5,
          // Keep the split so recipes scale children as half servings.
          adults: c.settings.defaultAdults ?? 2,
          children: c.settings.defaultChildren ?? 0,
        }),
      );
      router.setParams({ recipeId: undefined, date: undefined });
    } else if (params.mealId) {
      const m = c.meals.find((m) => m.id === params.mealId);
      if (m) {
        // Reminder notifications link here; show the meal's week behind the preview.
        setStart(weekRange(m.date).start);
        setSelectedDate(m.date);
        setPreview(m);
        router.setParams({ mealId: undefined });
      }
    }
  }, [
    params.recipeId,
    params.date,
    params.mealId,
    c.meals,
    c.settings.defaultAdults,
    c.settings.defaultChildren,
    router,
    today,
  ]);
  const add = (date: string, type = "dinner") => {
    setEditor(
      normaliseMeal(requestId(), {
          date,
          mealType: type,
          servings:
            (c.settings.defaultAdults ?? 2) +
            (c.settings.defaultChildren ?? 0) * 0.5,
          // Keep the split so recipes scale children as half servings.
          adults: c.settings.defaultAdults ?? 2,
          children: c.settings.defaultChildren ?? 0,
        }),
    );
  };
  const change = async (meal: Meal, status: Meal["status"]) => {
    try {
      await c.run({
        operation: "mutate",
        changes: [
          { meal: { ...meal, status }, expectedRevision: meal.revision },
        ],
      });
      setUndo(meal);
    } catch (e) {
      report(e);
    }
  };
  const title = (m: Meal) => mealLabel(m, c.recipes[m.recipeId]?.title);
  return (
    <ClassicCalendar
      start={start}
      selectedDate={selectedDate}
      view={view}
      setStart={setStart}
      setSelectedDate={setSelectedDate}
      setView={setView}
      onAdd={add}
      onMove={async (meal,date) => {await c.run({operation:'mutate',changes:[{meal:{...meal,date},expectedRevision:meal.revision}]}, requestId());}}
      onPreview={setPreview}
      onOptions={setMenuMeal}
      onTemplates={() => {
        setShowTemplates(true);
        if (householdId)
          getPlanTemplates(householdId).then(setTemplates).catch(report);
      }}
    >
      {undo && (
        <View
          style={{
            position: "absolute",
            bottom: 16,
            left: 24,
            right: 24,
            padding: 12,
            borderRadius: 24,
            backgroundColor: colors.surface,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Caption>Meal updated</Caption>
          <Button
            label="Undo"
            secondary
            onPress={async () => {
              try {
                await c.run({
                  operation: "mutate",
                  changes: [
                    { meal: undo, expectedRevision: undo.revision + 1 },
                  ],
                });
                setUndo(null);
              } catch (e) {
                report(e);
              }
            }}
          />
        </View>
      )}
      {showTemplates && (
        <Sheet title="Calendar options" onClose={() => setShowTemplates(false)}>
          <Row>
            <Pill
              label="Today"
              icon="today-outline"
              onPress={() => {
                setSelectedDate(today);
                setStart(weekRange(today).start);
                setView("week");
                setShowTemplates(false);
              }}
            />

          </Row>
          <Heading>Week templates</Heading>
          <Field
            label="Template name"
            value={templateName}
            onChangeText={setTemplateName}
          />
          <Button
            label="Save displayed week"
            onPress={async () => {
              try {
                if (!householdId || !templateName.trim())
                  throw new Error("Name the template.");
                const t = {
                  id: requestId(),
                  name: templateName.trim(),
                  start,
                  meals: alive.filter(
                    (m) => m.date >= start && m.date <= shiftDate(start, 6),
                  ),
                };
                await savePlanTemplate(householdId, t);
                setTemplates((v) => [...v, t]);
              } catch (e) {
                report(e);
              }
            }}
          />
          <DateField
            label="Start reused week"
            value={templateDate}
            onChange={setTemplateDate}
          />
          {templates.map((t) => (
            <Button
              key={t.id}
              label={`Reuse ${t.name}`}
              secondary
              onPress={() => {
                try {
                  assertDates(templateDate);
                  const proposed = templateMeals(t.meals, t.start, templateDate, requestId);
                  setShowTemplates(false); setReviewMeals(proposed);
                } catch (e) {
                  report(e);
                }
              }}
            />
          ))}
        </Sheet>
      )}
      {swapMeal && (
        <Sheet title="Swap meal" onClose={() => setSwapMeal(null)}>
          {alive
            .filter((m) => m.id !== swapMeal.id && m.status === "planned" && m.date >= shiftDate(today, -7))
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((m) => (
              <Button
                key={m.id}
                label={`${m.date} · ${m.mealType} · ${title(m)}`}
                secondary
                onPress={async () => {
                  try {
                    await c.run({
                      operation: "mutate",
                      changes: [
                        {
                          meal: {
                            ...swapMeal,
                            date: m.date,
                            mealType: m.mealType,
                          },
                          expectedRevision: swapMeal.revision,
                        },
                        {
                          meal: {
                            ...m,
                            date: swapMeal.date,
                            mealType: swapMeal.mealType,
                          },
                          expectedRevision: m.revision,
                        },
                      ],
                    });
                    setSwapMeal(null);
                  } catch (e) {
                    report(e);
                  }
                }}
              />
            ))}
          <Button
            label="Cancel swap"
            secondary
            onPress={() => setSwapMeal(null)}
          />
        </Sheet>
      )}
      {menuMeal && (
        <Sheet title={title(menuMeal)} onClose={() => setMenuMeal(null)}>
          <Caption>
            {menuMeal.mealType} · {menuMeal.servings} servings
            {menuMeal.allocatedPortions
              ? " · " + menuMeal.allocatedPortions + " extra portions reserved"
              : ""}
          </Caption>
          {menuMeal.kind !== "eating-out" && (
            <Button
              label={
                menuMeal.kind === "leftover"
                  ? "Serve leftovers"
                  : menuMeal.status === "cooked"
                    ? "Cook again"
                    : "Start cooking"
              }
              onPress={() => {
                router.push({
                  pathname: "/cook",
                  params: { mealId: menuMeal.id },
                });
                setMenuMeal(null);
              }}
            />
          )}
          <Row>
            <Pill
              icon="create-outline"
              label="Edit / Move to date"
              onPress={() => {
                setEditor(menuMeal);
                setMenuMeal(null);
              }}
            />
            <Pill
              icon="swap-horizontal-outline"
              label="Swap"
              onPress={() => {
                setSwapMeal(menuMeal);
                setMenuMeal(null);
              }}
            />
            <Pill
              icon="copy-outline"
              label="Copy"
              onPress={() => {
                setEditor({
                  ...menuMeal,
                  id: requestId(),
                  date: shiftDate(menuMeal.date, 1),
                  revision: 0,
                  status: "planned",
                  allocatedPortions: 0,
                });
                setMenuMeal(null);
              }}
            />
            {menuMeal.status === "skipped" && (
              <Pill
                icon="refresh-outline"
                label="Restore meal"
                onPress={() => {
                  change(menuMeal, "planned");
                  setMenuMeal(null);
                }}
              />
            )}
            <Pill
              icon="trash-outline"
              label="Remove"
              onPress={() => {
                change(menuMeal, "removed");
                setMenuMeal(null);
              }}
            />
          </Row>
        </Sheet>
      )}
      {reviewMeals && <PlanReview meals={reviewMeals} onClose={() => setReviewMeals(null)} onApply={async (changes, id, shoppingMode) => {
        await c.run({operation:'mutate', changes, shoppingMode, shoppingMealIds: changes.filter(c => c.meal.kind === 'recipe').map(c => c.meal.id)}, id); setReviewMeals(null);
      }} />}
      {editor && (
        <MealEditor
          key={editor.id}
          meal={editor}
          onClose={() => setEditor(null)}
          onSaved={(meal) => {
            if (meal.date < start || meal.date > shiftDate(start, 6)) {
              setStart(weekRange(meal.date).start);
              setView("week");
            }
          }}
        />
      )}
      <RecipeDetailModal
        recipe={preview ? (c.recipes[preview.recipeId] ?? null) : null}
        visible={!!preview}
        onClose={() => setPreview(null)}
        defaultServings={preview?.servings}
        mealPlanEntry={preview ? { ...preview } : undefined}
      />
    </ClassicCalendar>
  );
}
