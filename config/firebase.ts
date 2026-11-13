import { initializeApp, getApps } from 'firebase/app';
// @ts-ignore - TS doesn't see this export due to web-focused type definitions, but it exists at runtime via Metro
import { initializeAuth, getReactNativePersistence, browserLocalPersistence, connectAuthEmulator } from 'firebase/auth';
import { Platform } from 'react-native';
import { getFirestore, initializeFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import AsyncStorage from '@react-native-async-storage/async-storage';

const useEmulators = __DEV__ && process.env.EXPO_PUBLIC_USE_EMULATORS === 'true';
const firebaseConfig = useEmulators ? {apiKey:'demo-key',projectId:'demo-meal-wizard-rules',authDomain:'localhost'} : {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

// Initialize Firebase (prevent re-initialization)
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

// Initialize Auth with AsyncStorage for session persistence
const auth = initializeAuth(app, {
  persistence: Platform.OS === 'web' ? browserLocalPersistence : getReactNativePersistence(AsyncStorage),
});

const functions = getFunctions(app, 'europe-west1');

// Initialize Firestore.
// `initializeFirestore` is used (instead of getFirestore) so we can set
// ignoreUndefinedProperties — without it, any document write containing an
// `undefined` field value throws synchronously, which is fragile when new
// optional fields get added to typed entities (e.g. Recipe.needsDefrost).
// If init has already happened in this JS context, fall back to the existing
// instance to avoid the "Firestore has already been started" error.
let db: Firestore;
try {
  db = initializeFirestore(app, { ignoreUndefinedProperties: true });
} catch {
  db = getFirestore(app);
}

if (useEmulators) {
  const host = process.env.EXPO_PUBLIC_EMULATOR_HOST ?? '127.0.0.1';
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectFunctionsEmulator(functions, host, 5001);
}

export { app, auth, db, functions };
