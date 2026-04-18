import React from 'react';
import { Pressable, PressableProps, StyleProp, ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

const AnimatedPressableComponent = Animated.createAnimatedComponent(Pressable);

interface Props extends PressableProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  scaleTo?: number;
}

export default function AnimatedPressable({ 
  children, 
  style, 
  scaleTo = 0.95, 
  onPressIn, 
  onPressOut, 
  ...rest 
}: Props) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ scale: scale.value }],
    };
  });

  const handlePressIn = (e: any) => {
    // A bouncy, playful spring configuration
    scale.value = withSpring(scaleTo, { damping: 15, stiffness: 350, mass: 0.6 });
    if (onPressIn) onPressIn(e);
  };

  const handlePressOut = (e: any) => {
    scale.value = withSpring(1, { damping: 12, stiffness: 300, mass: 0.8 });
    if (onPressOut) onPressOut(e);
  };

  return (
    <AnimatedPressableComponent
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={(state) => {
        const passedStyle = typeof style === 'function' ? style(state) : style;
        return [passedStyle, animatedStyle];
      }}
      {...rest}
    >
      {children}
    </AnimatedPressableComponent>
  );
}
