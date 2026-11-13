import React from "react";
import { ActivityIndicator, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/contexts/ThemeContext";

export default function FavouriteButton({
  title,
  starred,
  pending,
  disabled,
  onPress,
}: {
  title: string;
  starred: boolean;
  pending?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${starred ? "Unfavourite" : "Favourite"} ${title}`}
      accessibilityState={{
        selected: starred,
        busy: !!pending,
        disabled: !!disabled || !!pending,
      }}
      disabled={disabled || pending}
      onPress={(e) => {
        e.stopPropagation();
        onPress();
      }}
      style={{
        minWidth: 44,
        minHeight: 44,
        justifyContent: "center",
        alignItems: "center",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {pending ? (
        <ActivityIndicator color={colors.primary} />
      ) : (
        <Ionicons
          name={starred ? "star" : "star-outline"}
          size={24}
          color={starred ? colors.warning : colors.textTertiary}
        />
      )}
    </Pressable>
  );
}
