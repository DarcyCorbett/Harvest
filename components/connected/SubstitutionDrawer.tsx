import React, { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useConnected } from "@/contexts/ConnectedContext";
import {
  getIngredientSubstitutions,
  type SubstitutionResult,
} from "@/services/substitutions";
import type { Meal } from "@/services/connectedClient";
import type { Recipe } from "@/services/types";
import type { IngredientOccurrence } from "@/services/stepIngredients";
import { formatIngredientAmount } from "@/utils/ingredientFormat";
import { Sheet, Caption, Pill } from "./classic";
import { Button, Field, Label, report } from "./ui";

export default function SubstitutionDrawer({
  occurrence,
  recipe,
  meal,
  servings,
  onClose,
}: {
  occurrence: IngredientOccurrence;
  recipe: Recipe;
  meal?: Meal;
  servings: number;
  onClose: () => void;
}) {
  const c = useConnected();
  const { householdId } = useAuth();
  const [suggestions, setSuggestions] = useState<SubstitutionResult[]>([]);
  const [chosen, setChosen] = useState<SubstitutionResult | null>(null);
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState(occurrence.ingredient.unit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    getIngredientSubstitutions(
      householdId ?? "",
      occurrence.ingredient.name,
      occurrence.ingredient.unit,
      recipe.title,
      recipe.ingredients.map((i) => i.name),
    )
      .then((value) => {
        if (live) setSuggestions(value);
      })
      .catch((e) => {
        if (live) setError(e.message || "Could not load substitutions.");
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [
    householdId,
    occurrence.ingredient.name,
    occurrence.ingredient.unit,
    recipe,
    attempt,
  ]);
  return (
    <Sheet title={`Instead of ${occurrence.ingredient.name}`} onClose={onClose}>
      {occurrence.group && <Caption>{occurrence.group}</Caption>}
      {busy && <Caption>Finding alternatives…</Caption>}
      {!!error && (
        <>
          <Label>{error}</Label>
          <Button
            label="Retry"
            secondary
            onPress={() => setAttempt((n) => n + 1)}
          />
        </>
      )}
      {!busy && !error && !suggestions.length && (
        <Caption>No alternatives found.</Caption>
      )}
      {suggestions.map((s) => (
        <Pill
          key={s.name}
          label={s.name}
          selected={chosen === s}
          onPress={() => {
            setChosen(s);
            setQuantity("");
            setUnit(occurrence.ingredient.unit);
          }}
        />
      ))}
      {chosen && (
        <>
          <Label>{chosen.reason}</Label>
          <Caption>{chosen.adjustment}</Caption>
          {meal && occurrence.index >= 0 && (
            <>
              <Caption>
                Enter the replacement amount for {servings} servings.
              </Caption>
              <Field
                label="Quantity"
                keyboardType="decimal-pad"
                value={quantity}
                onChangeText={setQuantity}
              />
              <Field label="Unit" value={unit} onChangeText={setUnit} />
              {!!quantity && (
                <Label>
                  {formatIngredientAmount(Number(quantity), unit)} {chosen.name}
                </Label>
              )}
              <Button
                label={busy ? "Applying…" : "Apply to this meal"}
                disabled={
                  busy ||
                  !c.online ||
                  !Number.isFinite(Number(quantity)) ||
                  Number(quantity) <= 0
                }
                onPress={async () => {
                  setBusy(true);
                  try {
                    await c.run({
                      operation: "mutate",
                      changes: [
                        {
                          meal: {
                            ...meal,
                            overrides: [
                              ...(meal.overrides ?? []).filter(
                                (o) =>
                                  !(
                                    o.recipeId === recipe.id &&
                                    o.ingredientIndex === occurrence.index
                                  ),
                              ),
                              {
                                recipeId: recipe.id!,
                                ingredientIndex: occurrence.index,
                                replacement: {
                                  name: chosen.name,
                                  quantity: Number(quantity),
                                  unit: unit.trim(),
                                },
                                adjustment: chosen.adjustment,
                                forServings: servings,
                              },
                            ],
                          },
                          expectedRevision: meal.revision,
                        },
                      ],
                    });
                    onClose();
                  } catch (e) {
                    report(e);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </>
          )}
        </>
      )}
    </Sheet>
  );
}
