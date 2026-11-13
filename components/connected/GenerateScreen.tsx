import React, { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import GenerationForm, { type GenerationFormValue } from "./GenerationForm";
import DraftRecipeCard from "./DraftRecipeCard";
import { Sheet, Caption } from "./classic";
import { matchesWord } from "@/services/recipeScraperService";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useConnected } from "@/contexts/ConnectedContext";
import { createDraft, fillDraft } from "@/services/connectedGeneration";
import {
  isoDate,
  shiftDate,
  weekRange,
  requestId,
  type Meal,
  type Draft,
  type DraftSlot,
} from "@/services/connectedClient";
import RecipeDetailModal from "@/components/RecipeDetailModal";
import { Screen, Card, Label, Button, Row, assertDates, report } from "./ui";
import PlanReview from './PlanReview';
import { draftMeals, hasMeal, type MealChange } from '@/services/planning';
import { useFavourite } from '@/hooks/useFavourite';
const words = (s: string) => [
  ...new Set(
    s
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  ),
];
export default function GenerateScreen() {
  const c = useConnected();
  const { householdId } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{
    date?: string;
    mealType?: string;
    preset?: string;
    start?: string;
    end?: string;
  }>();
  const today = isoDate(new Date());
  const nextMonday = shiftDate(weekRange().start, 7);
  const [start, setStart] = useState(nextMonday);
  const [days, setDays] = useState(5);
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [minutes, setMinutes] = useState<30 | 45 | undefined>(30);
  const [styles, setStyles] = useState<string[]>([]);
  const [prefer, setPrefer] = useState("");
  const [exclude, setExclude] = useState("");
  const [must, setMust] = useState("");
  const [scope, setScope] = useState<"plan" | "recipe">("plan");
  const [favourites, setFavourites] = useState(0);
  const [leftovers, setLeftovers] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [gaps, setGaps] = useState(false);
  const [types, setTypes] = useState(["dinner"]);
  const favourite = useFavourite();
  const [reviewMeals, setReviewMeals] = useState<Meal[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const actionInFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const cancel = useRef(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [slotOptions, setSlotOptions] = useState<string | null>(null);
  const [summary, setSummary] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setAdults(c.settings.defaultAdults ?? 2);
    setChildren(c.settings.defaultChildren ?? 0);
  }, [c.settings.defaultAdults, c.settings.defaultChildren]);
  useEffect(() => {
    if (params.date) {
      setStart(params.date);
      setDays(1);
      setTypes([params.mealType ?? "dinner"]);
      setGaps(false);
      setSummary(true);
    } else if (params.preset === "gaps") {
      setStart(params.start && params.start > today ? params.start : today);
      const end = params.end ?? weekRange().end;
      setDays(
        Math.max(
          0,
          Math.round(
            (Date.parse(`${end}T12:00:00Z`) -
              Date.parse(
                `${params.start && params.start > today ? params.start : today}T12:00:00Z`,
              )) /
              86400000,
          ) + 1,
        ),
      );
      setTypes(["dinner"]);
      setGaps(true);
      setSummary(true);
    }
  }, [
    params.date,
    params.mealType,
    params.preset,
    params.start,
    params.end,
    today,
  ]);
  const persistent = c.drafts.find((d) => d.id === draft?.id);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(
    () => () => {
      cancel.current = true;
    },
    [],
  );
  useEffect(() => {
    if (
      persistent &&
      !busy &&
      persistent.revision > (draftRef.current?.revision ?? -1)
    ) {
      draftRef.current = persistent;
      setDraft(persistent);
    }
  }, [persistent, busy]);
  const saveDraft = async (next: Draft) => {
    const result = await c.run<{ draft: Draft }>({
      operation: "draft",
      draft: next,
    });
    draftRef.current = result.draft;
    setDraft(result.draft);
    return result.draft;
  };
  const generate = async (existing?: Draft, ids?: string[]) => {
    if (!householdId || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    cancel.current = false;
    try {
      let next = existing?.id === draftRef.current?.id ? draftRef.current : existing;
      if (!next) {
        assertDates(start);
        if (!Number.isInteger(days) || days < 1 || days > 14)
          throw new Error("Choose 1–14 days.");
        if (adults + children * 0.5 <= 0)
          throw new Error("Choose at least one serving.");
        const slots = Array.from({ length: days }, (_, i) =>
          shiftDate(start, i),
        )
          .flatMap((date) =>
            types.map((mealType) => ({ date, mealType, maxMinutes: minutes })),
          )
          .filter(
            (s) =>
              !gaps ||
              !hasMeal(c.meals, s.date, s.mealType),
          );
        if (!slots.length)
          throw new Error("Those meal slots are already planned.");
        next = createDraft(
          slots,
          {
            adults,
            children,
            styles,
            prefer: words(prefer),
            exclude: [
              ...new Set([
                ...words(exclude),
                ...(c.settings.excludedIngredients ?? []),
              ]),
            ],
            must: words(must),
            mustScope: scope,
            favouriteCount: favourites,
            leftovers,
          },
          c.meals,
        );
        next = await saveDraft(next);
      }
      await fillDraft(
        next,
        householdId,
        c.settings,
        c.cookbook,
        (saved) => { draftRef.current = saved; setDraft(saved); },
        ids,
        () => cancel.current,
        c.load,
      );
    } catch (e) {
      report(e);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  };
  const edit = async (slot: DraftSlot, patch: Partial<DraftSlot>) => {
    if (actionInFlight.current) return;
    const current = draftRef.current;
    if (current) {
      actionInFlight.current = true;
      setBusy(true);
      try {
        await saveDraft({
          ...current,
          slots: current.slots.map((s) =>
            s.id === slot.id ? { ...s, ...patch } : s,
          ),
        });
      } catch (e) {
        report(e);
      } finally {
        actionInFlight.current = false;
        setBusy(false);
      }
    }
  };
  const confirm = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const selected = draft.slots.filter((s) => !s.removed);
      if (!selected.length) throw new Error("Keep at least one meal.");
      if (
        selected.some(
          (s) =>
            s.sourceMealId &&
            !selected.some(
              (source) =>
                source.id === s.sourceMealId && source.recipeId === s.recipeId,
            ),
        )
      )
        throw new Error(
          "A leftover source changed or was removed. Restore its source or remove and reallocate those leftovers.",
        );
      if (selected.some((s) => s.status !== "ready"))
        throw new Error("Retry or remove unfinished slots before confirming.");
      const selectedRecipes = selected.map((s) => c.recipes[s.recipeId!]);
      if (selectedRecipes.some((r) => !r))
        throw new Error("Wait for recipe details to load before confirming.");
      const terms = selectedRecipes.flatMap((r) =>
        r.ingredients.map((i) => i.name),
      );
      if (
        draft.config.must.some(
          (term) => !terms.some((i) => matchesWord(i, term)),
        )
      )
        throw new Error(
          "A required ingredient was removed from this draft. Restore or swap a meal to include it.",
        );
      if (
        selectedRecipes.some((r) =>
          [
            ...draft.config.exclude,
            ...(c.settings.excludedIngredients ?? []),
          ].some((term) =>
            r.ingredients.some((i) => matchesWord(i.name, term)),
          ),
        )
      )
        throw new Error(
          "Household exclusions changed. Swap the affected meals before confirming.",
        );
      if (
        draft.config.mustScope === "recipe" &&
        selectedRecipes.some((r) =>
          draft.config.must.some(
            (term) => !r.ingredients.some((i) => matchesWord(i.name, term)),
          ),
        )
      )
        throw new Error(
          "Each selected recipe must include the ingredients required in every recipe.",
        );
      setReviewMeals(draftMeals(draft, requestId));
    } catch (e) {
      report(e);
    } finally {
      setSaving(false);
    }
  };
  const applyReviewed = async (changes: MealChange[], id: string) => {
    if (!draft) throw new Error('This draft is no longer available.');
    await c.run({operation:'mutate', changes, shoppingMealIds: changes.filter(c => c.meal.kind === 'recipe').map(c => c.meal.id), draftId:draft.id, draftRevision:draft.revision}, id);
    setReviewMeals(null); setDraft(null);
    router.push({pathname:'/', params:{weekStart:weekRange(changes.map(c => c.meal.date).sort()[0]).start}});
  };
  const swap = async (slot: DraftSlot) => {
    if (!draft || !householdId || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    cancel.current = false;
    try {
      let working = await saveDraft({
        ...draft,
        slots: draft.slots.map((s) =>
          s.id === slot.id ? { ...s, locked: false, alternatives: [] } : s,
        ),
      });
      const candidates: string[] = [];
      for (let i = 0; i < 3 && !cancel.current; i++) {
        working = await fillDraft(
          working,
          householdId,
          c.settings,
          c.cookbook,
          (saved) => { draftRef.current = saved; setDraft(saved); },
          [slot.id],
          () => cancel.current,
          c.load,
        );
        const result = working.slots.find((s) => s.id === slot.id)!;
        if (result.recipeId && !candidates.includes(result.recipeId))
          candidates.push(result.recipeId);
        else break;
      }
      const current = working.slots.find((s) => s.id === slot.id)!;
      await saveDraft({
        ...working,
        slots: working.slots.map((s) =>
          s.id === slot.id
            ? {
                ...slot,
                alternatives: candidates,
                message: !candidates.length ? current.message : undefined,
              }
            : s,
        ),
      });
    } catch (e) {
      report(e);
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  };
  const preset = (type: "tonight" | "five" | "gaps") => {
    setDraft(null);
    setTypes(["dinner"]);
    setMinutes(30);
    setStart(type === "five" ? nextMonday : today);
    setDays(
      type === "five"
        ? 5
        : type === "tonight"
          ? 1
          : Math.round(
              (Date.parse(weekRange().end) - Date.parse(today)) / 86400000,
            ) + 1,
    );
    setGaps(type === "gaps");
    setSummary(true);
  };
  return (
    <Screen title={draft ? "Your Meal Plan" : ""} floatingAction={!draft ? <Button label={busy ? 'Finding meals…' : 'Generate'} disabled={busy || !c.online || !types.length} onPress={() => generate()} /> : undefined}>
      {!draft ? (
        <GenerationForm
          value={{
            start,
            days,
            adults,
            children,
            minutes,
            styles,
            prefer,
            exclude,
            must,
            scope,
            favourites,
            leftovers,
            advanced,
            summary,
            gaps,
            types,
          }}
          preset={preset}
          resume={setDraft}
          busy={busy}
          today={today}
          nextMonday={nextMonday}
          onChange={(patch: Partial<GenerationFormValue>) => {
            if ("start" in patch) setStart(patch.start!);
            if ("days" in patch) setDays(patch.days!);
            if ("adults" in patch) setAdults(patch.adults!);
            if ("children" in patch) setChildren(patch.children!);
            if ("minutes" in patch) setMinutes(patch.minutes);
            if ("styles" in patch) setStyles(patch.styles!);
            if ("prefer" in patch) setPrefer(patch.prefer!);
            if ("exclude" in patch) setExclude(patch.exclude!);
            if ("must" in patch) setMust(patch.must!);
            if ("scope" in patch) setScope(patch.scope!);
            if ("favourites" in patch) setFavourites(patch.favourites!);
            if ("leftovers" in patch) setLeftovers(patch.leftovers!);
            if ("advanced" in patch) setAdvanced(patch.advanced!);
            if ("types" in patch) setTypes(patch.types!);
          }}
        />
      ) : (
        <>
          {draft.config.favouriteCount > 0 && (
            <Label>
              {
                draft.slots.filter(
                  (s) =>
                    !s.removed &&
                    !s.sourceMealId &&
                    c.cookbook.some(
                      (e) => e.recipeId === s.recipeId && e.starred,
                    ),
                ).length
              }{" "}
              of {draft.config.favouriteCount} requested favourites included.
              Eligibility and household exclusions still apply.
            </Label>
          )}

          {busy && (
            <Card>
              <Label>
                Finding meals — completed results are saved as we go.
              </Label>
              <Button
                label="Stop after current request"
                secondary
                onPress={() => {
                  cancel.current = true;
                }}
              />
            </Card>
          )}
          {draft.slots.map((slot, index) => (
            <DraftRecipeCard
              key={slot.id}
              slot={slot}
              sourceDate={draft.slots.find(s => s.id === slot.sourceMealId)?.date}
              starred={favourite.starred(slot.recipeId ?? '')}
              starPending={favourite.pending(slot.recipeId ?? '')}
              starDisabled={favourite.disabled || !slot.recipeId}
              onStarToggle={() => {if (slot.recipeId) favourite.toggle(slot.recipeId);}}
              recipe={c.recipes[slot.recipeId!]}
              onPreview={() => slot.recipeId && setPreview(slot.recipeId)}
              onOptions={() => setSlotOptions(slot.id)}
            >
              {slot.sourceMealId &&
                !draft.slots.some(
                  (s) =>
                    s.id === slot.sourceMealId &&
                    !s.removed &&
                    s.status === "ready" &&
                    s.recipeId === slot.recipeId,
                ) && (
                  <Label>
                    Source meal changed — remove these leftovers and allocate
                    again after choosing the source.
                  </Label>
                )}
              <Row>
                <Button
                  label={slot.locked ? "Kept ✓" : "Keep"}
                  secondary
                  selected={slot.locked}
                  disabled={busy || slot.status !== "ready"}
                  onPress={() => edit(slot, { locked: !slot.locked })}
                />
                <Button
                  label="Swap"
                  secondary
                  disabled={busy || !!slot.sourceMealId}
                  onPress={() => swap(slot)}
                />
                <Button
                  label={slot.removed ? "Restore" : "Remove"}
                  secondary
                  disabled={busy}
                  onPress={() => edit(slot, { removed: !slot.removed })}
                />
                {slot.status !== "ready" && !slot.removed && (
                  <Button
                    label="Retry"
                    secondary
                    disabled={busy || !c.online}
                    onPress={() => generate(draft, [slot.id])}
                  />
                )}
              </Row>
              {!!slot.alternatives?.length && (
                <>
                  <Label>Choose a replacement</Label>
                  {slot.alternatives.map((id) => (
                    <Button
                      key={id}
                      label={c.recipes[id]?.title ?? "Loading alternative…"}
                      secondary
                      disabled={busy}
                      onPress={() =>
                        edit(slot, {
                          recipeId: id,
                          status: "ready",
                          alternatives: [],
                          reasons: ["Alternative matching your preferences"],
                        })
                      }
                    />
                  ))}
                </>
              )}
              {slotOptions === slot.id && (
                <Sheet
                  title="Meal preferences"
                  onClose={() => setSlotOptions(null)}
                >
                  {slot.reasons?.map((reason) => (
                    <Caption key={reason}>{reason}</Caption>
                  ))}
                  {!slot.removed && !slot.sourceMealId && (
                    <>
                      <Row>
                        {([30, 45, undefined] as const).map((n) => (
                          <Button
                            key={String(n)}
                            label={n ? `${n} min` : "Any time"}
                            secondary
                            selected={slot.maxMinutes === n}
                            disabled={busy}
                            onPress={() =>
                              edit(slot, {
                                maxMinutes: n,
                                status: "failed",
                                locked: false,
                                message:
                                  "Time limit changed. Retry this meal to check eligibility.",
                              })
                            }
                          />
                        ))}
                      </Row>
                      {slot.status !== "ready" && (
                        <>
                          <Button
                            label={
                              slot.allowAnyCuisine
                                ? "Any cuisine allowed"
                                : "Allow any cuisine for this meal"
                            }
                            secondary
                            selected={slot.allowAnyCuisine}
                            disabled={busy}
                            onPress={() =>
                              edit(slot, {
                                allowAnyCuisine: !slot.allowAnyCuisine,
                                locked: false,
                              })
                            }
                          />
                          <Button
                            label="Retry this meal"
                            disabled={busy}
                            onPress={() => generate(draft, [slot.id])}
                          />
                        </>
                      )}
                    </>
                  )}
                  {draft.config.leftovers &&
                    index > 0 &&
                    !slot.sourceMealId && (
                      <Button
                        label={`Allocate ${slot.servings} leftover portions from ${
                          draft.slots
                            .slice(0, index)
                            .reverse()
                            .find(
                              (s) =>
                                s.status === "ready" &&
                                !s.removed &&
                                !s.sourceMealId &&
                                s.date < slot.date,
                            )?.date ?? "an earlier meal"
                        }`}
                        secondary
                        disabled={busy}
                        onPress={async () => {
                          try {
                            const source = draft.slots
                              .slice(0, index)
                              .reverse()
                              .find(
                                (s) =>
                                  s.status === "ready" &&
                                  !s.removed &&
                                  !s.sourceMealId &&
                                  s.date < slot.date,
                              );
                            if (!source)
                              throw new Error(
                                "Choose an earlier ready meal first.",
                              );
                            await saveDraft({
                              ...draft,
                              slots: draft.slots.map((s) =>
                                s.id === source.id
                                  ? {
                                      ...s,
                                      allocatedPortions:
                                        (s.allocatedPortions ?? 0) +
                                        slot.servings,
                                    }
                                  : s.id === slot.id
                                    ? {
                                        ...s,
                                        recipeId: source.recipeId,
                                        sourceMealId: source.id,
                                        status: "ready",
                                        locked: true,
                                      }
                                    : s,
                              ),
                            });
                          } catch (e) {
                            report(e);
                          }
                        }}
                      />
                    )}
                </Sheet>
              )}
            </DraftRecipeCard>
          ))}
          <Button
            label="Regenerate unlocked meals"
            secondary
            disabled={busy}
            onPress={() => generate(draft)}
          />
          <Button
            label={saving ? "Saving…" : "Add to Calendar"}
            disabled={busy || saving || !c.online}
            onPress={() => {
              const occupied = draft.slots.some(
                (s) => !s.removed && s.expectedRevision > 0,
              );
              if (occupied)
                Alert.alert(
                  "Replace existing meals?",
                  "This draft targets some existing meal slots. Confirming will replace those meals.",
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Confirm", onPress: confirm },
                  ],
                );
              else confirm();
            }}
          />
          <Button
            label="Back — keep draft"
            secondary
            disabled={busy}
            onPress={() => setDraft(null)}
          />
          <Button
            label="Discard draft"
            secondary
            disabled={busy}
            onPress={() =>
              Alert.alert(
                "Discard draft?",
                "Your saved plan will remain unchanged.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Discard",
                    style: "destructive",
                    onPress: () =>
                      c
                        .run({
                          operation: "discardDraft",
                          draftId: draft.id,
                          revision: draft.revision,
                        })
                        .then(() => setDraft(null))
                        .catch(report),
                  },
                ],
              )
            }
          />
        </>
      )}
      {reviewMeals && <PlanReview meals={reviewMeals} onClose={() => setReviewMeals(null)} onApply={applyReviewed} />}
      <RecipeDetailModal
        recipe={preview ? (c.recipes[preview] ?? null) : null}
        visible={!!preview}
        onClose={() => setPreview(null)}
      />
    </Screen>
  );
}
