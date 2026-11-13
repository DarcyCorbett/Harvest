import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
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
import { mealLabel, templateMeals } from '@/services/planning';
import ClassicCalendar from "./ClassicCalendar";
import { Sheet, Pill, Caption } from "./classic";
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
      const current = { ...value, servings, ...(value.kind === "recipe" ? { allocatedPortions } : {}) };
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
  return (
    <Sheet title={meal.revision ? "Edit meal" : "Add meal"} onClose={() => {if (!busy) onClose();}}>
      <Field label="Meal label (optional)" value={value.customLabel ?? ""} maxLength={200} onChangeText={customLabel => setValue(v => ({...v,customLabel}))} />
      <DateField
        label="Date"
        value={value.date}
        onChange={(date) => setValue((v) => ({ ...v, date }))}
      />
      <Row>
        {["breakfast", "lunch", "dinner", "snack", "dessert"].map(
          (mealType) => (
            <Button
              key={mealType}
              label={mealType}
              secondary
              selected={value.mealType === mealType}
              onPress={() => setValue((v) => ({ ...v, mealType }))}
            />
          ),
        )}
      </Row>
      <Row>
        {(["recipe", "leftover", "eating-out"] as const).map((kind) => (
          <Button
            key={kind}
            label={
              kind === "recipe"
                ? "Choose recipe"
                : kind === "leftover"
                  ? "Leftovers"
                  : "Eating out"
            }
            secondary
            selected={value.kind === kind}
            onPress={() => setValue((v) => ({ ...v, kind }))}
          />
        ))}
      </Row>
      <Field
        label="Servings"
        keyboardType="decimal-pad"
        value={servingsText}
        onChangeText={setServingsText}
      />
      {value.kind === "recipe" && (
        <>
          <Label>
            {c.recipes[value.recipeId]?.title ?? "Choose a saved recipe."}
          </Label>
          <Row><Button label="Choose recipe" onPress={() => setPicker('main')} />
          <Button label="Attach a side" secondary disabled={(value.sides?.length ?? 0) >= 8} onPress={() => setPicker('side')} /></Row>
          {value.sides?.map((s) => (
            <Row key={s.recipeId}>
              <Label>Side: {c.recipes[s.recipeId]?.title ?? s.recipeId}</Label>
              <Button
                label="Remove side"
                secondary
                onPress={() =>
                  setValue((v) => ({
                    ...v,
                    sides: v.sides?.filter((x) => x.recipeId !== s.recipeId),
                  }))
                }
              />
            </Row>
          ))}
          <Field
            label="Extra portions reserved for later meals"
            keyboardType="decimal-pad"
            value={extraText}
            onChangeText={setExtraText}
          />
        </>
      )}
      {value.kind === "leftover" && (
        <>
          <Label>
            Choose an earlier cooking occasion. Saving reserves these extra
            portions there; groceries are counted once.
          </Label>
          {c.meals
            .filter(
              (m) =>
                m.kind === "recipe" &&
                m.date < value.date &&
                !["removed", "skipped"].includes(m.status),
            )
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, 20)
            .map((m) => (
              <Button
                key={m.id}
                label={`${m.date} · ${mealLabel(m, c.recipes[m.recipeId]?.title)}`}
                secondary
                selected={value.sourceMealId === m.id}
                onPress={() =>
                  setValue((v) => ({
                    ...v,
                    sourceMealId: m.id,
                    recipeId: m.recipeId,
                  }))
                }
              />
            ))}
        </>
      )}
      <Button
        label={busy ? "Saving…" : "Save meal"}
        disabled={busy || !c.online}
        onPress={save}
      />
      <Button label="Cancel" secondary disabled={busy} onPress={onClose} />
      {picker && <RecipePickerModal mealType={picker === 'side' ? 'side' : value.mealType} date={value.date}
        onClose={() => setPicker(null)} onSelect={recipe => {
          setValue(v => picker === 'side' ? {...v, sides:[...(v.sides ?? []).filter(s => s.recipeId !== recipe.id), {recipeId:recipe.id!,servings:amount(servingsText) > 0 ? amount(servingsText) : v.servings}]} : {...v, recipeId:recipe.id!, overrides:[], sourceMealId:undefined});
          setPicker(null);
        }} />}
    </Sheet>
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
        }),
      );
      router.setParams({ recipeId: undefined, date: undefined });
    } else if (params.mealId) {
      const m = c.meals.find((m) => m.id === params.mealId);
      if (m) {
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
            <Pill
              label="Settings"
              icon="settings-outline"
              onPress={() => {
                setShowTemplates(false);
                router.push("/profile");
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
            .filter((m) => m.id !== swapMeal.id && m.status === "planned")
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
      {reviewMeals && <PlanReview meals={reviewMeals} onClose={() => setReviewMeals(null)} onApply={async (changes, id) => {
        await c.run({operation:'mutate', changes, shoppingMealIds: changes.filter(c => c.meal.kind === 'recipe').map(c => c.meal.id)}, id); setReviewMeals(null);
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
