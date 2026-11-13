import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

// The package barrel registers push-token listeners during import, which throws
// in Android Expo Go. Check the runtime before evaluating that module at all.
export const notifications: typeof import('expo-notifications') | null =
  Platform.OS === 'web' ||
  (Platform.OS === 'android' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient)
    ? null
    : require('expo-notifications');
