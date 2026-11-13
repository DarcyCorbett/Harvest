import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/contexts/ThemeContext";
import { Fonts } from "@/constants/theme";
import { useBottomDrawerGesture } from "@/hooks/useBottomDrawerGesture";

export default function Drawer({
  title,
  children,
  onClose,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode | ((close: () => void) => React.ReactNode);
}) {
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const y = useState(() => new Animated.Value(height))[0];
  const opacity = useState(() => new Animated.Value(0))[0];
  const [reduced, setReduced] = useState(false);
  const closing = useRef(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (!live) return;
      setReduced(value);
      if (value) {
        y.setValue(0);
        opacity.setValue(1);
      } else
        Animated.parallel([
          Animated.spring(y, {
            toValue: 0,
            tension: 62,
            friction: 11,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 1,
            duration: 220,
            useNativeDriver: true,
          }),
        ]).start();
    });
    const sub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );
    return () => {
      live = false;
      sub.remove();
      y.stopAnimation();
      opacity.stopAnimation();
    };
  }, [y, opacity]);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    Animated.parallel([
      Animated.timing(y, {
        toValue: height,
        duration: reduced ? 0 : 260,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: reduced ? 0 : 200,
        useNativeDriver: true,
      }),
    ]).start(() => onClose());
  }, [height, reduced, y, opacity, onClose]);
  const drag = useBottomDrawerGesture({ translateY: y, backdropOpacity: opacity, close });
  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={close}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, justifyContent: "flex-end" }}
      >
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: colors.overlay, opacity },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Close ${title}`}
            onPress={close}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <Animated.View
          style={{
            maxHeight: height * 0.9,
            width: "100%",
            maxWidth: 720,
            alignSelf: "center",
            backgroundColor: colors.background,
            borderTopLeftRadius: 32,
            borderTopRightRadius: 32,
            overflow: "hidden",
            transform: [{ translateY: y }],
          }}
        >
          <SafeAreaView
            edges={["bottom", "left", "right"]}
            style={{ flexShrink: 1 }}
          >
            <GestureDetector gesture={drag.headerGesture}>
            <View>
              <View style={{ alignItems: "center", paddingTop: 12 }}>
                <View
                  style={{
                    width: 36,
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: colors.placeholder,
                  }}
                />
              </View>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 24,
                  paddingTop: 8,
                }}
              >
                <Text
                  accessibilityRole="header"
                  style={{
                    flex: 1,
                    fontSize: 22,
                    fontFamily: Fonts.semibold,
                    color: colors.text,
                  }}
                >
                  {title}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Close ${title}`}
                  onPress={close}
                  style={{
                    width: 44,
                    height: 44,
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                >
                  <Ionicons
                    name="close"
                    size={22}
                    color={colors.textSecondary}
                  />
                </Pressable>
              </View>
            </View>
            </GestureDetector>
            <ScrollView
              {...drag.contentHandlers}
              onScroll={(event) => drag.setScrollOffset(event.nativeEvent.contentOffset.y)}
              scrollEventThrottle={16}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                padding: 24,
                gap: 16,
                paddingBottom: 24,
              }}
            >
              {children}
            </ScrollView>
            {footer && (
              <View
                style={{
                  paddingHorizontal: 24,
                  paddingBottom: 16,
                  paddingTop: 8,
                }}
              >
                {/* eslint-disable-next-line react-hooks/refs -- close is handed over as a callback and only reads its ref when pressed */}
                {typeof footer === "function" ? footer(close) : footer}
              </View>
            )}
          </SafeAreaView>
        </Animated.View>
      </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}
