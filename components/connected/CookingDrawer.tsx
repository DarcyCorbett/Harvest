import { useIsFocused } from "expo-router/react-navigation";
import React, { useEffect, useRef, useState } from "react";
import { AppState, Image, Pressable, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { notifications as Notifications } from "@/services/notifications";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { cacheKey, type Meal } from "@/services/connectedClient";
import type { Recipe } from "@/services/types";
import {
  addCookingTimer,
  cookingTimerId,
  durationChoices,
  remainingSeconds,
  resetCookingTimer,
  type CookingSession,
} from "@/services/cookingSession";
import {
  ingredientOccurrences,
  ingredientsForStep,
} from "@/services/stepIngredients";
import { formatIngredientAmount } from "@/utils/ingredientFormat";
import { Fonts } from "@/constants/theme";
import { Sheet, Caption, IconButton } from "./classic";
import { Button } from "./ui";

export default function CookingDrawer({
  recipe,
  meal,
  servings,
  onClose,
  renderMedia,
}: {
  recipe: Recipe;
  meal?: Meal;
  servings: number;
  onClose: () => void;
  renderMedia?: (step: Recipe["instructions"][number]) => React.ReactNode;
}) {
  const { householdId, user } = useAuth();
  const focused = useIsFocused();
  const { colors } = useTheme();
  const id = recipe.id!;
  const rootId = meal?.recipeId ?? id;
  const key =
    householdId && user
      ? cacheKey(householdId, user.uid, `cook:${meal?.id ?? rootId}:${rootId}`)
      : "";
  const empty: CookingSession = {
    activeRecipeId: id,
    steps: {},
    checked: {},
    timers: [],
  };
  const [session, setSession] = useState(empty);
  const current = useRef(session);
  const saveChain = useRef(Promise.resolve());
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [now, setNow] = useState(Date.now);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const load = async () => {
      try {
        const raw = key ? await AsyncStorage.getItem(key) : null;
        const value = raw ? JSON.parse(raw) : {};
        const restored = {
          activeRecipeId: id,
          steps: value.steps ?? {},
          checked: value.checked ?? {},
          timers: Array.isArray(value.timers) ? value.timers : [],
        };
        if (active) {
          current.current = restored;
          setSession(restored);
          setLoaded(true);
        }
      } catch {
        if (active) {
          setStorageError(true);
          setLoaded(true);
        }
      }
    };
    load();
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [key, id]);
  // Enqueue synchronously with the action so closing immediately cannot lose a step.
  const update = (fn: (s: CookingSession) => CookingSession) => {
    const next = fn(current.current);
    if (next === current.current) return;
    current.current = next;
    if (mounted.current) setSession(next);
    if (key)
      saveChain.current = saveChain.current
        .then(() => AsyncStorage.setItem(key, JSON.stringify(next)))
        .catch(() => {
          if (mounted.current) setStorageError(true);
        });
  };
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const tag = `mealwizard-cook-${meal?.id ?? id}`;
    const apply = () => {
      if (AppState.currentState === "active" && loaded && focused)
        activateKeepAwakeAsync(tag).catch(() => {});
      else deactivateKeepAwake(tag).catch(() => {});
    };
    apply();
    const listener = AppState.addEventListener("change", apply);
    return () => {
      clearInterval(timer);
      listener.remove();
      deactivateKeepAwake(tag).catch(() => {});
    };
  }, [id, meal?.id, loaded, focused]);
  const steps = recipe.instructions.filter((s) => !s.isHeader);
  const step = Math.max(0, Math.min(session.steps[id] ?? 0, steps.length - 1));
  const instruction = steps[step];
  const foods = ingredientsForStep(
    instruction?.text ?? "",
    ingredientOccurrences(recipe, servings, meal),
  );
  const startTimer = async (
    label: string,
    seconds: number,
    durationIndex: number,
  ) => {
    const timerId = cookingTimerId(id, step, durationIndex);
    if (!loaded || current.current.timers.some((t) => t.id === timerId)) return;
    const timer = {
      id: timerId,
      recipeId: id,
      step,
      label,
      // eslint-disable-next-line react-hooks/purity -- runs from a button press, not during render
      endsAt: Date.now() + seconds * 1000,
    };
    update((s) => addCookingTimer(s, timer));
    try {
      if (!Notifications) return;
      const permission = await Notifications.getPermissionsAsync();
      const allowed =
        permission.granted ||
        (await Notifications.requestPermissionsAsync()).granted;
      if (
        !allowed ||
        !current.current.timers.some(
          (t) => t.id === timerId && t.endsAt === timer.endsAt,
        ) ||
        // eslint-disable-next-line react-hooks/purity -- runs from a button press, not during render
        timer.endsAt <= Date.now()
      )
        return;
      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: "Cooking timer",
          body: label,
          data: {
            navigateTo: "cook",
            householdId,
            mealId: meal?.id,
            recipeId: id,
          },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: new Date(timer.endsAt),
        },
      });
      if (
        current.current.timers.some(
          (t) => t.id === timerId && t.endsAt === timer.endsAt,
        )
      )
        update((s) => ({
          ...s,
          timers: s.timers.map((t) =>
            t.id === timerId ? { ...t, notificationId } : t,
          ),
        }));
      else await Notifications.cancelScheduledNotificationAsync(notificationId);
    } catch {
      /* Countdown remains usable without notification support. */
    }
  };
  return (
    <Sheet
      title={steps.length ? `Step ${step + 1} of ${steps.length}` : "Cooking"}
      onClose={onClose}
      footer={(close) => (
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Button
              label="Back"
              secondary
              disabled={!loaded || step === 0}
              onPress={() =>
                update((s) => ({ ...s, steps: { ...s.steps, [id]: step - 1 } }))
              }
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label={step >= steps.length - 1 ? "Done" : "Next"}
              disabled={!loaded}
              onPress={() => {
                if (step >= steps.length - 1) close();
                else
                  update((s) => ({
                    ...s,
                    steps: { ...s.steps, [id]: step + 1 },
                  }));
              }}
            />
          </View>
        </View>
      )}
    >
      {storageError && (
        <Caption>Progress could not be saved on this device.</Caption>
      )}
      {instruction?.title && (
        <Text
          style={{
            fontFamily: Fonts.semibold,
            fontSize: 19,
            color: colors.text,
          }}
        >
          {instruction.title}
        </Text>
      )}
      <Text
        style={{
          fontFamily: Fonts.regular,
          fontSize: 20,
          lineHeight: 30,
          color: colors.text,
        }}
      >
        {instruction?.text ?? "Instructions unavailable for this recipe."}
      </Text>
      {instruction &&
        (renderMedia ? (
          renderMedia(instruction)
        ) : instruction.imageUrl ? (
          <Image
            source={{ uri: instruction.imageUrl }}
            style={{ width: "100%", height: 180, borderRadius: 16 }}
          />
        ) : null)}
      {(durationChoices(instruction?.text ?? "").length > 0 ||
        session.timers.some((t) => !t.recipeId)) && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {durationChoices(instruction?.text ?? "").map((duration, n) => {
            const timerId = cookingTimerId(id, step, n);
            const timer = session.timers.find((t) => t.id === timerId);
            const seconds = timer ? remainingSeconds(timer, now) : 0;
            return (
              <View
                key={timerId}
                style={{ flexDirection: "row", alignItems: "center" }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    timer
                      ? `${duration.label}: ${seconds} seconds remaining`
                      : `Start ${duration.label} timer`
                  }
                  disabled={!loaded || !!timer}
                  onPress={() =>
                    startTimer(duration.label, duration.seconds, n)
                  }
                  style={{
                    minHeight: 44,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    paddingHorizontal: 12,
                    borderRadius: 22,
                    backgroundColor: colors.surface,
                  }}
                >
                  <Ionicons
                    name="timer-outline"
                    size={18}
                    color={colors.primary}
                  />
                  <Text
                    style={{ fontFamily: Fonts.medium, color: colors.text }}
                  >
                    {timer
                      ? seconds
                        ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
                        : "Time’s up"
                      : duration.label}
                  </Text>
                </Pressable>
                {timer && (
                  <IconButton
                    icon="refresh-outline"
                    label={`Reset ${duration.label} timer`}
                    onPress={() => {
                      update((s) => resetCookingTimer(s, timerId));
                      if (Notifications && timer.notificationId)
                        Notifications.cancelScheduledNotificationAsync(
                          timer.notificationId,
                        ).catch(() => {});
                    }}
                  />
                )}
              </View>
            );
          })}
          {session.timers
            .filter((t) => !t.recipeId)
            .map((timer) => (
              <View
                key={timer.id}
                style={{ flexDirection: "row", alignItems: "center" }}
              >
                <Text style={{ color: colors.text, fontFamily: Fonts.medium }}>
                  {timer.label} ·{" "}
                  {Math.floor(remainingSeconds(timer, now) / 60)}:
                  {String(remainingSeconds(timer, now) % 60).padStart(2, "0")}
                </Text>
                <IconButton
                  icon="refresh-outline"
                  label={`Reset ${timer.label} timer`}
                  onPress={() => {
                    update((s) => resetCookingTimer(s, timer.id));
                    if (Notifications && timer.notificationId)
                      Notifications.cancelScheduledNotificationAsync(
                        timer.notificationId,
                      ).catch(() => {});
                  }}
                />
              </View>
            ))}
        </View>
      )}
      {!!foods.length && (
        <View style={{ gap: 10 }}>
          <Caption>Recipe quantities</Caption>
          {[...new Set(foods.map((f) => f.groupIndex))].map((groupIndex) => (
            <View key={groupIndex} style={{ gap: 6 }}>
              {!!foods.find((f) => f.groupIndex === groupIndex)?.group && (
                <Text
                  style={{ color: colors.text, fontFamily: Fonts.semibold }}
                >
                  {foods.find((f) => f.groupIndex === groupIndex)!.group}
                </Text>
              )}
              {foods
                .filter((f) => f.groupIndex === groupIndex)
                .map((f, i) => (
                  <View key={`${f.index}:${i}`}>
                    <Text
                      style={{
                        color: colors.text,
                        fontFamily: Fonts.regular,
                        fontSize: 16,
                      }}
                    >
                      {formatIngredientAmount(
                        f.ingredient.quantity,
                        f.ingredient.unit,
                      )}{" "}
                      {f.ingredient.name}
                    </Text>
                    {f.ingredient.name !== f.original.name && (
                      <Caption>{f.ingredient.notes}</Caption>
                    )}
                  </View>
                ))}
            </View>
          ))}
        </View>
      )}
    </Sheet>
  );
}
