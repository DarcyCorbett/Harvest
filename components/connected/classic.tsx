import React from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/contexts/ThemeContext";
import { useConnected } from "@/contexts/ConnectedContext";
import { Fonts, Radius } from "@/constants/theme";
import { router } from "expo-router";
import { activeShoppingChanges, failedShoppingChanges } from "@/services/shoppingCheckSync";
const report = (error: unknown) =>
  Alert.alert(
    "Please review",
    error instanceof Error ? error.message : String(error),
  );

export function IconButton({
  icon,
  label,
  onPress,
  disabled = false,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: 44,
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 22,
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={22} color={colors.textSecondary} />
    </Pressable>
  );
}
export function Caption({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text
      style={{
        fontFamily: Fonts.regular,
        fontSize: 12,
        lineHeight: 17,
        color: colors.textSecondary,
      }}
    >
      {children}
    </Text>
  );
}
export function Pill({
  label,
  selected,
  onPress,
  icon,
  disabled,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: Radius.pill,
        backgroundColor: selected ? colors.primary : colors.surface,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        opacity: disabled ? 0.4 : pressed ? 0.65 : 1,
      })}
    >
      {icon && (
        <Ionicons
          name={icon}
          size={16}
          color={selected ? colors.textInverse : colors.textSecondary}
        />
      )}
      <Text
        style={{
          color: selected ? colors.textInverse : colors.textSecondary,
          fontFamily: Fonts.medium,
          fontSize: 14,
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function Counter({
  label,
  value,
  onChange,
  min = 0,
  max = 20,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        minWidth: 130,
        padding: 16,
        backgroundColor: colors.surface,
        borderRadius: 24,
        gap: 8,
      }}
    >
      <Text
        style={{ color: colors.text, fontFamily: Fonts.medium, fontSize: 14 }}
      >
        {label}
      </Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <IconButton
          icon="remove"
          label={`Fewer ${label.toLowerCase()}`}
          disabled={value <= min}
          onPress={() => onChange(Math.max(min, value - 1))}
        />
        <Text
          accessibilityLabel={`${label}: ${value}`}
          style={{
            fontSize: 24,
            fontFamily: Fonts.semibold,
            color: colors.text,
          }}
        >
          {value}
        </Text>
        <IconButton
          icon="add"
          label={`More ${label.toLowerCase()}`}
          disabled={value >= max}
          onPress={() => onChange(Math.min(max, value + 1))}
        />
      </View>
    </View>
  );
}
export { default as Sheet } from "./Drawer";
export function StatusNotice({ style, hideShoppingProgress = false, hidePendingProgress = false }: { style?: StyleProp<ViewStyle>; hideShoppingProgress?: boolean; hidePendingProgress?: boolean }) {
  const c = useConnected();
  const { colors } = useTheme();
  const failed = failedShoppingChanges(c.pending).length;
  const syncing = activeShoppingChanges(c.pending).length;
  // Failed shopping changes are shown in full on the Shopping tab; elsewhere, point there.
  const failedNotice = failed > 0 && !hidePendingProgress;
  const message =
    c.error ||
    (c.state?.status === "error"
      ? "Shopping needs retry"
      : failedNotice
        ? `${failed} shopping ${failed === 1 ? "change" : "changes"} failed · Review in Shopping`
        : c.shoppingUpdating && !hideShoppingProgress
          ? "Plan saved · shopping updating"
          : !c.online
            ? "Offline · changes saved on this device"
            : syncing && !hidePendingProgress
              ? `${syncing} changes syncing`
              : "");
  const actionable = !!c.error || c.state?.status === "error" || failedNotice;
  if (c.loading)
    return (
      <ActivityIndicator
        accessibilityLabel="Loading household"
        color={colors.primaryText}
        style={{ padding: 12 }}
      />
    );
  if (!message) return null;
  return (
    <Pressable
      accessibilityRole={actionable ? "button" : undefined}
      accessibilityLabel={message}
      onPress={() => {
        if (c.error) c.retry();
        else if (c.state?.status === "error")
          c.run({ operation: "retry" }).catch(report);
        else if (failedNotice) router.push("/shopping");
      }}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 24,
          paddingVertical: 8,
        },
        style,
      ]}
    >
      <Ionicons
        name={
          actionable
            ? "alert-circle-outline"
            : !c.online
              ? "cloud-offline-outline"
              : "sync-outline"
        }
        size={16}
        color={colors.textSecondary}
      />
      <Caption>{message}</Caption>
    </Pressable>
  );
}
