import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import { useConnected } from "@/contexts/ConnectedContext";
import { Ionicons } from "@expo/vector-icons";
import { StatusNotice, IconButton } from "./classic";
import { validDate } from "../../functions/src/connected/model";
export const report = (e: unknown) => {
  if (e instanceof Error && e.name === 'ShoppingCancelled') return;
  Alert.alert("Please review", e instanceof Error ? e.message : String(e));
};
export function Label({
  children,
  muted = false,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Text
      style={{
        color: muted ? colors.textSecondary : colors.text,
        fontSize: 14,
        lineHeight: 20,
        fontFamily: "Outfit_400Regular",
      }}
    >
      {children}
    </Text>
  );
}
export function Heading({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        color: colors.text,
        fontSize: 22,
        lineHeight: 30,
        fontFamily: "Outfit_600SemiBold",
      }}
    >
      {children}
    </Text>
  );
}
export function Button({
  label,
  onPress,
  secondary = false,
  disabled = false,
  selected = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  selected?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 46,
        maxWidth: "100%",
        justifyContent: "center",
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 999,
        borderWidth: 0,
        backgroundColor:
          secondary && !selected ? colors.surface : colors.primary,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          color:
            secondary && !selected ? colors.textSecondary : colors.textInverse,
          fontSize: 14,
          fontFamily: "Outfit_600SemiBold",
          textAlign: "center",
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function Row({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
      }}
    >
      {children}
    </View>
  );
}
export function Card({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        padding: 16,
        borderRadius: 24,
        gap: 12,
      }}
    >
      {children}
    </View>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string; ref?: React.Ref<TextInput> }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Label>{label}</Label>
      <TextInput
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={colors.textSecondary}
        style={[
          {
            minHeight: 48,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 12,
            padding: 12,
            color: colors.text,
            backgroundColor: colors.surface,
            fontSize: 16,
          },
          props.style,
        ]}
      />
    </View>
  );
}
export function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(new Date());
  const year = month.getFullYear(),
    number = month.getMonth();
  const leading = (new Date(year, number, 1).getDay() + 6) % 7;
  const count = new Date(year, number + 1, 0).getDate();
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label + " " + value}
        onPress={() => {
          setMonth(
            validDate(value) ? new Date(value + "T12:00:00") : new Date(),
          );
          setOpen(true);
        }}
        style={{
          minHeight: 48,
          padding: 14,
          borderRadius: 24,
          backgroundColor: colors.surface,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Ionicons name="calendar-outline" size={20} color={colors.primary} />
        <Text
          style={{
            flex: 1,
            fontFamily: "Outfit_500Medium",
            fontSize: 16,
            color: colors.text,
          }}
        >
          {validDate(value)
            ? new Date(value + "T12:00:00").toLocaleDateString(undefined, {
                weekday: "short",
                day: "numeric",
                month: "short",
                year: "numeric",
              })
            : "Choose date"}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            backgroundColor: "#0008",
            padding: 8,
          }}
        >
          <Card>
            <Heading>
              {month.toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
              })}
            </Heading>
            <Row>
              <Button
                label="Previous month"
                secondary
                onPress={() => setMonth(new Date(year, number - 1, 1))}
              />
              <Button
                label="Next month"
                secondary
                onPress={() => setMonth(new Date(year, number + 1, 1))}
              />
            </Row>
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {["M", "T", "W", "T", "F", "S", "S"].map((day, i) => (
                <Text
                  key={`h${i}`}
                  style={{
                    width: "14.28%",
                    textAlign: "center",
                    paddingVertical: 8,
                    color: colors.text,
                  }}
                >
                  {day}
                </Text>
              ))}
              {Array.from({ length: leading + count }, (_, i) => {
                const day = i - leading + 1;
                const date = `${year}-${String(number + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                return day < 1 ? (
                  <View key={i} style={{ width: "14.28%", minHeight: 46 }} />
                ) : (
                  <Pressable
                    key={i}
                    accessibilityRole="button"
                    accessibilityLabel={date}
                    accessibilityState={{ selected: date === value }}
                    onPress={() => {
                      onChange(date);
                      setOpen(false);
                    }}
                    style={{
                      width: "14.28%",
                      minHeight: 46,
                      justifyContent: "center",
                      backgroundColor:
                        date === value ? colors.primary : colors.surface,
                      borderRadius: 8,
                    }}
                  >
                    <Text
                      style={{
                        textAlign: "center",
                        fontSize: 16,
                        color:
                          date === value ? colors.textInverse : colors.text,
                      }}
                    >
                      {day}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Button
              label="Close calendar"
              secondary
              onPress={() => setOpen(false)}
            />
          </Card>
        </View>
      </Modal>
    </View>
  );
}
export function assertDates(start: string, end = start) {
  if (!validDate(start) || !validDate(end) || end < start)
    throw new Error(
      "Enter valid dates in YYYY-MM-DD format. End must follow start.",
    );
}
export function Screen({
  title,
  children,
  floatingAction,
}: {
  title: string;
  children: React.ReactNode;
  floatingAction?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  const c = useConnected();
  const [actionHeight, setActionHeight] = useState(64);
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={["top", "left", "right"]}
    >
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{
          padding: 24,
          paddingBottom: floatingAction ? actionHeight + 40 : 36,
          gap: 16,
          width: "100%",
          maxWidth: 880,
          alignSelf: "center",
        }}
        keyboardShouldPersistTaps="handled"
      >
        {!!title && (
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <View style={{ flex: 1 }}>
              <Heading>{title}</Heading>
            </View>
            <IconButton
              icon="settings-outline"
              label="Settings"
              onPress={() => router.push("/profile")}
            />
          </View>
        )}
        <StatusNotice style={{ paddingHorizontal: 0 }} />
        {c.loading ? (
          <ActivityIndicator
            color={colors.primary}
            accessibilityLabel="Loading household"
          />
        ) : (
          children
        )}
      </ScrollView>
      {!!floatingAction && !c.loading && <View onLayout={e => setActionHeight(e.nativeEvent.layout.height)} style={{ position: 'absolute', bottom: 16, width: '100%', maxWidth: 880, paddingHorizontal: 24, alignSelf: 'center' }}>{floatingAction}</View>}
    </SafeAreaView>
  );
}
