import { useCallback, useMemo, useRef } from "react";
import { Animated, PanResponder, type GestureResponderHandlers } from "react-native";
import { Gesture } from "react-native-gesture-handler";

type Options = {
  translateY: Animated.Value;
  backdropOpacity: Animated.Value;
  close: () => void;
};

/** Consistent drag-to-dismiss behavior for bottom drawers and their scroll content. */
export function useBottomDrawerGesture({ translateY, backdropOpacity, close }: Options): {
  headerGesture: ReturnType<typeof Gesture.Pan>;
  contentHandlers: GestureResponderHandlers;
  setScrollOffset: (offset: number) => void;
} {
  const closeRef = useRef(close);
  closeRef.current = close;
  const scrollOffset = useRef(0);
  const reset = useCallback(() => Animated.parallel([
    Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
    Animated.timing(backdropOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
  ]).start(), [backdropOpacity, translateY]);
  const responder = (content: boolean) => {
    const shouldStart = (_: unknown, gesture: { dx: number; dy: number }) =>
      (!content || scrollOffset.current <= 0) &&
      gesture.dy > 8 &&
      Math.abs(gesture.dy) > Math.abs(gesture.dx);
    return PanResponder.create({
    onMoveShouldSetPanResponder: shouldStart,
    onMoveShouldSetPanResponderCapture: content ? shouldStart : undefined,
    onPanResponderMove: (_, gesture) => {
      const distance = Math.max(0, gesture.dy);
      translateY.setValue(distance);
      backdropOpacity.setValue(Math.max(0, 1 - distance / 500));
    },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy > 110 || gesture.vy > 0.6) closeRef.current();
      else reset();
    },
    onPanResponderTerminate: reset,
  });
  };
  const content = useRef(responder(true)).current;
  const headerGesture = useMemo(
    () => Gesture.Pan()
      .activeOffsetY(8)
      .failOffsetX([-16, 16])
      .runOnJS(true)
      .onBegin(() => {
        translateY.stopAnimation();
        backdropOpacity.stopAnimation();
      })
      .onUpdate((gesture) => {
        const distance = Math.max(0, gesture.translationY);
        translateY.setValue(distance);
        backdropOpacity.setValue(Math.max(0, 1 - distance / 500));
      })
      .onEnd((gesture) => {
        if (gesture.translationY > 110 || gesture.velocityY > 600) closeRef.current();
        else reset();
      }),
    [backdropOpacity, reset, translateY],
  );
  return {
    headerGesture,
    contentHandlers: content.panHandlers,
    setScrollOffset: (offset) => { scrollOffset.current = offset; },
  };
}
