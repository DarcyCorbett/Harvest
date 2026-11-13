import React, { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useConnected } from "@/contexts/ConnectedContext";
import {
  addToCookbook,
  updateCookbookDetails,
} from "@/services/firestoreService";
import type { Meal } from "@/services/connectedClient";
import { Sheet, Caption, Pill } from "./classic";
import { Button, Row, report } from "./ui";

export default function RecipeActionsDrawer({
  recipeId,
  meal,
  onClose,
}: {
  recipeId: string;
  meal?: Meal;
  onClose: () => void;
}) {
  const c = useConnected();
  const { householdId } = useAuth();
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(meal?.status === "cooked");
  const [effort, setEffort] = useState(
    c.cookbook.find((e) => e.recipeId === recipeId)?.effort,
  );
  const saveFeedback = async (details: {
    effort?: string;
  }) => {
    if (!householdId) return;
    try {
      await addToCookbook(householdId, recipeId);
      await updateCookbookDetails(householdId, recipeId, details);
      if (details.effort !== undefined) setEffort(details.effort);
    } catch (e) {
      report(e);
    }
  };
  return (
    <Sheet title="Cooking history" onClose={onClose}>
      {!complete ? (
        <Button
          label={busy ? "Saving…" : "Mark cooked"}
          disabled={busy || !c.online || !householdId}
          onPress={async () => {
            if (!householdId) return;
            setBusy(true);
            try {
              if (meal)
                await c.run({
                  operation: "mutate",
                  changes: [
                    {
                      meal: { ...meal, status: "cooked" },
                      expectedRevision: meal.revision,
                    },
                  ],
                });
              await addToCookbook(householdId, recipeId);
              await updateCookbookDetails(householdId, recipeId, {
                lastCookedAt: new Date().toISOString(),
              });
              setComplete(true);
            } catch (e) {
              report(e);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : (
        <Caption>Marked cooked ✓</Caption>
      )}
      <Caption>How was the effort?</Caption>
      <Row>
        {["easy", "about right", "too much"].map((value) => (
          <Pill
            key={value}
            label={value}
            selected={effort === value}
            disabled={!c.online}
            onPress={() => saveFeedback({ effort: value })}
          />
        ))}
      </Row>
    </Sheet>
  );
}
