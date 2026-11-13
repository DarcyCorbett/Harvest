import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useConnected } from "@/contexts/ConnectedContext";
import { useTheme } from "@/contexts/ThemeContext";
import RecipeDetailModal from "@/components/RecipeDetailModal";
import { Sheet, Caption } from "@/components/connected/classic";
import { Button } from "@/components/connected/ui";

export default function CookScreen() {
  const { mealId, recipeId } = useLocalSearchParams<{
    mealId?: string;
    recipeId?: string;
  }>();
  const router = useRouter();
  const c = useConnected();
  const { colors } = useTheme();
  const meal = c.meals.find((m) => m.id === mealId);
  const id = recipeId ?? meal?.recipeId ?? "";
  const recipe = c.recipes[id];
  const [error, setError] = useState("");
  const load = c.load;
  useEffect(() => {
    if (id)
      load(id)
        .then((r) => {
          if (!r) setError("Recipe unavailable offline.");
        })
        .catch((e) => setError(e.message));
  }, [id, load]);
  const close = () =>
    router.canGoBack() ? router.back() : router.replace("/");
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {recipe ? (
        <RecipeDetailModal
          key={id}
          recipe={recipe}
          visible
          initiallyCooking
          onClose={close}
          mealPlanEntry={
            meal
              ? {
                  id: meal.id,
                  servings:
                    meal.sides?.find((s) => s.recipeId === id)?.servings ??
                    meal.servings,
                }
              : undefined
          }
        />
      ) : (
        <Sheet title="Cooking" onClose={close}>
          <Caption>{error || "Loading saved recipe…"}</Caption>
          {error && (
            <Button
              label="Retry"
              onPress={() => {
                setError("");
                if (id) load(id).catch((e) => setError(e.message));
              }}
            />
          )}
        </Sheet>
      )}
    </View>
  );
}
