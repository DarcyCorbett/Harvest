import React, { useState } from "react";
import { Pressable, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import PastelCard from "@/components/PastelCard";
import { Colors, Fonts, Shadows } from "@/constants/theme";
import { useTheme } from "@/contexts/ThemeContext";
import { useConnected } from "@/contexts/ConnectedContext";
import { useRouter } from "expo-router";
import { shiftDate, type Draft } from "@/services/connectedClient";
import { Button, DateField, Row } from "./ui";
import { Caption, Counter, IconButton, Pill, Sheet } from "./classic";
export type GenerationFormValue = {
  start: string;
  days: number;
  adults: number;
  children: number;
  minutes: 30 | 45 | undefined;
  styles: string[];
  prefer: string;
  exclude: string;
  must: string;
  scope: "plan" | "recipe";
  favourites: number;
  leftovers: boolean;
  advanced: boolean;
  summary: boolean;
  gaps: boolean;
  types: string[];
};
type Props = {
  value: GenerationFormValue;
  onChange: (patch: Partial<GenerationFormValue>) => void;
  preset: (name: "tonight" | "five" | "gaps") => void;
  resume: (draft: Draft) => void;
  busy: boolean;
  today: string;
  nextMonday: string;
};
const modifiers = [
  ["Healthy", "🥑", "proteinBadge"],
  ["Vegetarian", "🥗", "proteinBadge"],
  ["Kid Friendly", "👧", "fatBadge"],
  ["Salad", "🥬", "carbsBadge"],
] as const;
const cuisines = [
  ["Any cuisine", "🌍", "carbsBadge"],
  ["Asian", "🍜", "carbsBadge"],
  ["Mexican", "🌮", "caloriesBadge"],
  ["Mediterranean", "🫒", "proteinBadge"],
  ["Italian", "🍝", "caloriesBadge"],
  ["Indian", "🍛", "fatBadge"],
] as const;
const ingredients = [
  ["Chicken", "🍗"],
  ["Meat", "🥩"],
  ["Fish", "🐟"],
  ["Egg", "🥚"],
  ["Broccoli", "🥦"],
  ["Tomato", "🍅"],
  ["Pasta", "🍝"],
  ["Rice", "🍚"],
] as const;
const dayOptions = [1, 2, 3, 4, 5, 6, 7, 10, 14] as const;
export default function GenerationForm({
  value: v,
  onChange: set,
  preset,
  resume,
  busy,
  today,
  nextMonday,
}: Props) {
  const { colors } = useTheme();
  const c = useConnected();
  const router = useRouter();
  const { width, fontScale } = useWindowDimensions();
  const [contentWidth, setContentWidth] = useState(Math.min(width, 880) - 48);
  const columns = fontScale > 1.3 || width < 390 ? 2 : 3;
  const group = (title: string) => (
    <Text
      style={{
        fontFamily: Fonts.semibold,
        fontSize: 12,
        letterSpacing: 1.2,
        color: colors.textSecondary,
        marginTop: 12,
        marginBottom: 12,
      }}
    >
      {title}
    </Text>
  );
  const tiles = (
    options: readonly (readonly [string, string, keyof typeof Colors.light])[],
    count = columns,
  ) => (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
      {options.map(([style, emoji, bg]) => (
        <PastelCard
          key={style}
          title={style}
          emoji={emoji}
          cardMinHeight={fontScale > 1.3 ? 120 : 96}
          cardWidth={(contentWidth - 16 * (count - 1) - 1) / count}
          selected={
            style === "Any cuisine"
              ? !cuisines.some(([name]) => v.styles.includes(name))
              : v.styles.includes(style)
          }
          selectedColorHex={colors[bg]}
          onPress={() =>
            set({
              styles:
                style === "Any cuisine"
                  ? v.styles.filter(
                      (x) => !cuisines.some(([name]) => name === x),
                    )
                  : v.styles.includes(style)
                    ? v.styles.filter((x) => x !== style)
                    : [...v.styles, style],
            })
          }
        />
      ))}
    </View>
  );
  return (
    <View
      onLayout={(e) => setContentWidth(e.nativeEvent.layout.width)}
      style={{ gap: 16 }}
    >
      <View style={{ paddingTop: 12, paddingBottom: 16 }}>
        <View style={{ position: "absolute", right: 0, top: 0, zIndex: 2 }}>
          <IconButton
            icon="settings-outline"
            label="Household settings"
            onPress={() => router.push("/profile")}
          />
        </View>
        <Text
          style={{
            fontFamily: Fonts.medium,
            fontSize: 14,
            color: colors.textSecondary,
            marginBottom: 8,
          }}
        >
          Let’s Start…
        </Text>
        <Text
          accessibilityRole="header"
          style={{
            fontSize: 36,
            fontFamily: Fonts.bold,
            lineHeight: 43,
            color: colors.text,
          }}
        >
          What style of{"\n"}meal do you want?
        </Text>
      </View>
      {c.drafts
        .filter((d) => !d.submitted)
        .map((d) => (
          <Pressable
            key={d.id}
            accessibilityRole="button"
            onPress={() => resume(d)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              padding: 16,
              borderRadius: 24,
              backgroundColor: colors.proteinBadge,
            }}
          >
            <Text style={{ fontSize: 24 }}>📋</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: Fonts.semibold, color: colors.text }}>
                Continue your meal plan
              </Text>
              <Caption>
                {d.slots.filter((s) => s.status === "ready").length} of{" "}
                {d.slots.length} meals ready
              </Caption>
            </View>
            <Text style={{ color: colors.text }}>›</Text>
          </Pressable>
        ))}
      <View>
        {group("EFFORT")}
        <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
          {(
            [
              [30, "⚡", "30 min"],
              [45, "🍳", "45 min"],
              [undefined, "🕐", "Any time"],
            ] as const
          ).map(([minutes, emoji, label]) => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={`Up to ${label}`}
              accessibilityState={{ selected: v.minutes === minutes }}
              onPress={() => set({ minutes })}
              style={{
                flex: 1,
                minWidth: 80,
                paddingVertical: 12,
                paddingHorizontal: 8,
                minHeight: 44,
                borderRadius: 999,
                borderWidth: 1.5,
                borderColor: colors.border,
                flexDirection: "row",
                justifyContent: "center",
                alignItems: "center",
                gap: 6,
                backgroundColor:
                  v.minutes === minutes ? colors.primary : colors.surface,
                ...Shadows.sm,
              }}
            >
              <Text style={{ fontSize: 14 }}>{emoji}</Text>
              <Text
                style={{
                  fontFamily: Fonts.semibold,
                  fontSize: 12,
                  color:
                    v.minutes === minutes ? colors.textInverse : colors.text,
                }}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View>
        {group("MODIFIERS")}
        {tiles(modifiers, 2)}
        {group("CUISINES")}
        {tiles(cuisines)}
      </View>
      <View
        style={{
          height: 1,
          backgroundColor: colors.border,
          marginVertical: 16,
        }}
      />
      <Text
        style={{ fontFamily: Fonts.semibold, fontSize: 22, color: colors.text }}
      >
        Plan Details
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(
          [
            ["tonight", "🌙", "Tonight"],
            ["five", "⚡", "5 dinners"],
            ["gaps", "🧩", "Fill gaps"],
          ] as const
        ).map(([key, emoji, label]) => {
          const selected =
            v.summary &&
            (key === "gaps"
              ? v.gaps
              : key === "tonight"
                ? !v.gaps && v.days === 1
                : !v.gaps && v.days === 5);
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={`${emoji} ${label}`}
              accessibilityState={{ selected }}
              onPress={() => preset(key)}
              style={{
                flex: 1,
                minHeight: 64,
                paddingVertical: 8,
                paddingHorizontal: 4,
                borderRadius: 22,
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                backgroundColor: selected ? colors.primary : colors.surface,
              }}
            >
              <Text style={{ fontSize: 18 }}>{emoji}</Text>
              <Text
                style={{
                  fontFamily: Fonts.medium,
                  fontSize: 12,
                  textAlign: "center",
                  color: selected ? colors.textInverse : colors.textSecondary,
                }}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {v.summary && (
        <Caption>
          {v.gaps ? "Empty slots only · " : ""}
          {v.days} days · {v.adults + v.children * 0.5} servings ·{" "}
          {v.minutes ? `${v.minutes} min` : "Any time"}
        </Caption>
      )}
      <View>
        {group("START DATE")}
        <DateField
          label="Start date"
          value={v.start}
          onChange={(start) => set({ start })}
        />
        <View style={{ marginTop: 8 }}>
          <Row>
            {[
              ["Today", today],
              ["Tomorrow", shiftDate(today, 1)],
              ["Next week", nextMonday],
            ].map(([label, start]) => (
              <Pill
                key={label}
                label={label}
                selected={v.start === start}
                onPress={() => set({ start })}
              />
            ))}
          </Row>
        </View>
      </View>
      <View>
        {group("HOW MANY DAYS?")}
        <Row>
          {((dayOptions as readonly number[]).includes(v.days) ||
          v.days < 1 ||
          v.days > 14
            ? dayOptions
            : [...dayOptions, v.days].sort((a, b) => a - b)
          ).map((days) => (
            <Pill
              key={days}
              label={`${days}`}
              selected={v.days === days}
              onPress={() => set({ days })}
            />
          ))}
        </Row>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        <Counter
          label="Adults"
          value={v.adults}
          onChange={(adults) => set({ adults })}
        />
        <Counter
          label="Children"
          value={v.children}
          onChange={(children) => set({ children })}
        />
      </View>
      <View>
        {group("MEALS")}
        <Row>
          {[
            ["breakfast", "☀️"],
            ["lunch", "🥪"],
            ["dinner", "🌙"],
            ["side", "🥦"],
            ["snack", "🍎"],
            ["dessert", "🍰"],
            ["component", "🫙"],
          ].map(([type, emoji]) => (
            <Pill
              key={type}
              label={`${emoji} ${type === "component" ? "Sauces & more" : type[0].toUpperCase() + type.slice(1)}`}
              selected={v.types.includes(type)}
              onPress={() =>
                set({
                  types: v.types.includes(type)
                    ? v.types.filter((x) => x !== type)
                    : [...v.types, type],
                })
              }
            />
          ))}
        </Row>
      </View>
      <Pill
        icon="options-outline"
        label="Adjust preferences"
        onPress={() => set({ advanced: true })}
      />
      {v.advanced && (
        <Sheet title="Preferences" onClose={() => set({ advanced: false })}>
          {group("INGREDIENTS TO FAVOUR")}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {ingredients.map(([name, emoji]) => {
              const values = v.prefer
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
              return (
                <Pill
                  key={name}
                  label={`${emoji} ${name}`}
                  selected={values.includes(name)}
                  onPress={() =>
                    set({
                      prefer: (values.includes(name)
                        ? values.filter((x) => x !== name)
                        : [...values, name]
                      ).join(", "),
                    })
                  }
                />
              );
            })}
          </View>
          <TermsField
            label="Other ingredients to favour"
            placeholder="e.g. salmon"
            value={v.prefer}
            onChange={(prefer) => set({ prefer })}
          />
          <TermsField
            label="Required ingredients"
            placeholder="e.g. sausages"
            value={v.must}
            onChange={(must) => set({ must })}
          />
          <Row>
            <Pill
              label="Somewhere in the plan"
              selected={v.scope === "plan"}
              onPress={() => set({ scope: "plan" })}
            />
            <Pill
              label="Every recipe"
              selected={v.scope === "recipe"}
              onPress={() => set({ scope: "recipe" })}
            />
          </Row>
          <Caption>
            Household exclusions:{" "}
            {c.settings.excludedIngredients?.join(", ") || "None"}
          </Caption>
          <Pill
            icon="settings-outline"
            label="Edit household exclusions"
            onPress={() => {
              set({ advanced: false });
              router.push({ pathname: "/profile", params: { section: "preferences" } });
            }}
          />
          <TermsField
            label="Extra exclusions for this plan"
            placeholder="e.g. mushrooms"
            value={v.exclude}
            onChange={(exclude) => set({ exclude })}
          />
          <Counter
            label="Favourites"
            value={v.favourites}
            max={v.days * v.types.length}
            onChange={(favourites) => set({ favourites })}
          />
          <Pill
            label="♻️ Plan leftovers"
            selected={v.leftovers}
            onPress={() => set({ leftovers: !v.leftovers })}
          />
          <Button label="Done" onPress={() => set({ advanced: false })} />
        </Sheet>
      )}
    </View>
  );
}

const MAX_TERMS = 20; // matches the server's limit per list
const splitTerms = (value: string) => value.split(",").map((t) => t.trim()).filter(Boolean);

/**
 * Several ingredients, one at a time: type and press + (or Return, or a comma) to add a pill;
 * tap a pill's x to remove it. The value stays the comma-separated string the generator reads.
 */
export function TermsField({ label, placeholder, value, onChange }: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const terms = splitTerms(value);
  const add = (raw: string) => {
    const next = [...terms];
    for (const term of splitTerms(raw)) {
      if (next.length >= MAX_TERMS) break;
      if (!next.some((t) => t.toLowerCase() === term.toLowerCase())) next.push(term.slice(0, 120));
    }
    onChange(next.join(", "));
    setText("");
  };
  const full = terms.length >= MAX_TERMS;
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.text, fontSize: 14, fontFamily: Fonts.regular }}>{label}</Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput
          accessibilityLabel={label}
          value={text}
          editable={!full}
          placeholder={full ? `Up to ${MAX_TERMS} ingredients` : placeholder}
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          returnKeyType="done"
          blurOnSubmit={false}
          onChangeText={(next) => (next.includes(",") ? add(next) : setText(next))}
          onSubmitEditing={() => text.trim() && add(text)}
          style={{ flex: 1, minWidth: 0, minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, color: colors.text, backgroundColor: colors.surface, fontSize: 16 }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add to ${label.toLowerCase()}`}
          accessibilityState={{ disabled: !text.trim() || full }}
          disabled={!text.trim() || full}
          onPress={() => add(text)}
          style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: colors.primaryLight, opacity: !text.trim() || full ? 0.45 : pressed ? 0.7 : 1 })}
        >
          <Ionicons name="add" size={22} color={colors.primaryText} />
        </Pressable>
      </View>
      {terms.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {terms.map((term) => (
            <Pressable
              key={term.toLowerCase()}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${term}`}
              onPress={() => onChange(terms.filter((t) => t !== term).join(", "))}
              hitSlop={{ top: 4, bottom: 4 }}
              style={({ pressed }) => ({ minHeight: 36, flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 12, paddingRight: 8, borderRadius: 18, backgroundColor: colors.primaryLight, opacity: pressed ? 0.7 : 1 })}
            >
              <Text style={{ color: colors.primaryText, fontFamily: Fonts.medium, fontSize: 14 }}>{term}</Text>
              <Ionicons name="close" size={16} color={colors.primaryText} />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
