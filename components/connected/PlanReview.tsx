import React, { useRef, useState } from "react";
import { useConnected } from "@/contexts/ConnectedContext";
import { requestId, type Meal } from "@/services/connectedClient";
import {
  reviewedChanges,
  mealLabel,
  type MealChange,
  type Replacement,
} from "@/services/planning";
import { Sheet, Caption } from "./classic";
import { Button, Card, Label, Row } from "./ui";

export type ShoppingMode = "keep" | "replace";

export default function PlanReview({
  meals,
  onClose,
  onApply,
}: {
  meals: Meal[];
  onClose: () => void;
  onApply: (changes: MealChange[], request: string, shoppingMode: ShoppingMode) => Promise<void>;
}) {
  const c = useConnected();
  const [replacements, setReplacements] = useState<Record<string, Replacement>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  // Only offered when there is a list to keep; replacing also clears manual and purchased items.
  const listHasItems = !!c.period?.items.length;
  const [shoppingMode, setShoppingMode] = useState<ShoppingMode>("keep");
  const [error, setError] = useState("");
  const receipt = useRef<{
    key: string;
    id: string;
    changes: MealChange[];
  } | null>(null);
  const flight = useRef(false);
  const apply = async () => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const mode: ShoppingMode = listHasItems ? shoppingMode : "keep";
      const key = JSON.stringify({ meals, replacements, mode });
      // Reuse the exact submitted command after an uncertain response.
      if (receipt.current?.key !== key)
        receipt.current = {
          key,
          id: requestId(),
          changes: reviewedChanges(meals, replacements, c.meals),
        };
      await onApply(receipt.current.changes, receipt.current.id, mode);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not save. Retry or review your choices.",
      );
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Review meals"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Caption>
        New meals are added alongside your plan. Choose a specific meal below to
        replace it.
      </Caption>
      {meals.map((meal) => (
        <Card key={meal.id}>
          <Label>
            {meal.date} · {meal.mealType} ·{" "}
            {mealLabel(meal, c.recipes[meal.recipeId]?.title)}
          </Label>
          <Row>
            <Button
              label="Add"
              secondary
              selected={!replacements[meal.id]}
              disabled={busy}
              onPress={() => {
                setReplacements((p) => {
                  const next = { ...p };
                  delete next[meal.id];
                  return next;
                });
                receipt.current = null;
              }}
            />
          </Row>
          {c.meals
            .filter(
              (m) =>
                m.status === "planned" &&
                m.date === meal.date &&
                m.mealType === meal.mealType,
            )
            .map((target) => (
              <Button
                key={target.id}
                label={`Replace ${mealLabel(target, c.recipes[target.recipeId]?.title)}`}
                secondary
                selected={replacements[meal.id]?.id === target.id}
                disabled={
                  busy ||
                  Object.entries(replacements).some(
                    ([id, r]) => id !== meal.id && r.id === target.id,
                  )
                }
                onPress={() => {
                  setReplacements((p) => ({
                    ...p,
                    [meal.id]: { id: target.id, revision: target.revision },
                  }));
                  receipt.current = null;
                }}
              />
            ))}
        </Card>
      ))}
      {listHasItems && (
        <Card>
          <Label>Shopping list</Label>
          <Row>
            <Button
              label="Add to existing"
              secondary
              selected={shoppingMode === "keep"}
              disabled={busy}
              onPress={() => setShoppingMode("keep")}
            />
            <Button
              label="Replace list"
              secondary
              selected={shoppingMode === "replace"}
              disabled={busy}
              onPress={() => setShoppingMode("replace")}
            />
          </Row>
          {shoppingMode === "replace" && (
            <Caption>
              Replacing starts a new list from these meals and clears manual and
              purchased items.
            </Caption>
          )}
        </Card>
      )}
      {!!error && <Label>{error}</Label>}
      <Button
        label={
          busy ? "Saving…" : error ? "Retry reviewed changes" : "Confirm meals"
        }
        disabled={busy || !c.online || !meals.length}
        onPress={apply}
      />
      <Button label="Cancel" secondary disabled={busy} onPress={onClose} />
    </Sheet>
  );
}
