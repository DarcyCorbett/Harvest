import React from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useTheme } from "@/contexts/ThemeContext";
import { Fonts, Shadows } from "@/constants/theme";
import type { Recipe } from "@/services/types";
import type { DraftSlot } from "@/services/connectedClient";
import { Caption, IconButton } from "./classic";
import FavouriteButton from './FavouriteButton';
export default function DraftRecipeCard({
  slot,
  recipe,
  onPreview,
  onOptions,
  starred,
  starPending,
  starDisabled,
  onStarToggle,
  sourceDate,
  children,
}: {
  slot: DraftSlot;
  recipe?: Recipe;
  onPreview: () => void;
  onOptions: () => void;
  starred: boolean;
  starPending?: boolean;
  starDisabled?: boolean;
  onStarToggle: () => void;
  sourceDate?: string;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 24,
        padding: 16,
        gap: 12,
        opacity: slot.removed ? 0.5 : 1,
        ...Shadows.sm,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View
          style={{
            backgroundColor: colors.primaryLight,
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 20,
          }}
        >
          <Text
            style={{
              color: colors.primary,
              fontSize: 12,
              fontFamily: Fonts.semibold,
            }}
          >
            {slot.mealType}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Caption>
            {new Date(slot.date + "T12:00:00").toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
            })}
          </Caption>
        </View>
        {recipe && <FavouriteButton title={recipe.title} starred={starred} pending={starPending} disabled={starDisabled} onPress={onStarToggle} />}
        <IconButton
          icon="options-outline"
          label={`Preferences for ${slot.date} ${slot.mealType}`}
          onPress={onOptions}
        />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={recipe?.title || "Recipe details"}
        disabled={!recipe}
        onPress={onPreview}
        style={{ flexDirection: "row", alignItems: "center", gap: 16 }}
      >
        <View style={{ flex: 1, gap: 6 }}>
          <Text
            style={{
              fontFamily: Fonts.semibold,
              fontSize: 18,
              lineHeight: 24,
              color: colors.text,
            }}
          >
            {recipe?.title || slot.message || "Finding a meal…"}
          </Text>
          <Caption>
            {slot.removed
              ? "Removed"
              : slot.sourceMealId
                ? `♻️ ${slot.servings} portions from ${sourceDate ?? 'source meal'}`
                : recipe
                  ? `◷ ${recipe.totalTime || `${recipe.prepTime} prep · ${recipe.cookTime} cook`}${slot.locked ? " · 🔒 Kept" : ""}`
                  : slot.status}
          </Caption>
        </View>
        {recipe?.imageUrl ? (
          <Image
            source={{ uri: recipe.imageUrl }}
            style={{ width: 80, height: 80, borderRadius: 20 }}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Text style={{ fontSize: 36 }}>🍽️</Text>
        )}
      </Pressable>
      {slot.status !== "ready" && recipe && (
        <Text
          style={{
            color: colors.error,
            fontFamily: Fonts.medium,
            fontSize: 13,
          }}
        >
          {slot.message || "This meal needs a retry"}
        </Text>
      )}
      {children}
    </View>
  );
}
