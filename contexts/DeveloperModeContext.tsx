import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export interface DevLog {
  id: string;
  timestamp: Date;
  type: 'log' | 'warn' | 'error';
  text: string;
}

const STORAGE_KEY = 'developerMode';

interface DeveloperModeContextValue {
  developerMode: boolean;
  setDeveloperMode: (value: boolean) => void;
  logs: DevLog[];
  clearLogs: () => void;
}

const DeveloperModeContext = createContext<DeveloperModeContextValue | null>(null);

export function DeveloperModeProvider({ children }: { children: React.ReactNode }) {
  const [developerMode, setDeveloperModeState] = useState<boolean>(false);
  const [logs, setLogs] = useState<DevLog[]>([]);
  const logQueueRef = useRef<DevLog[]>([]);
  const flushTimeoutRef = useRef<any>(null);
  const developerModeRef = useRef<boolean>(false);

  // Synchronize the developerMode state with developerModeRef.
  useEffect(() => {
    developerModeRef.current = developerMode;
  }, [developerMode]);

  // Load from storage on mount
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (stored !== null) {
          setDeveloperModeState(stored === 'true');
        }
      })
      .catch((err) => {
        console.warn('[DeveloperModeContext] Failed to load developerMode:', err);
      });
  }, []);

  const setDeveloperMode = useCallback((val: boolean) => {
    setDeveloperModeState(val);
    AsyncStorage.setItem(STORAGE_KEY, val ? 'true' : 'false').catch((err) => {
      console.warn('[DeveloperModeContext] Failed to persist developerMode:', err);
    });
  }, []);

  const addLog = useCallback((type: 'log' | 'warn' | 'error', args: any[]) => {
    const text = args
      .map((arg) => {
        if (arg === undefined) return 'undefined';
        if (arg === null) return 'null';
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg);
          } catch (e) {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(' ');

    const newLog: DevLog = {
      id: Math.random().toString(36).substring(2, 9) + Date.now(),
      timestamp: new Date(),
      type,
      text,
    };

    logQueueRef.current.push(newLog);

    // Keep logs within buffer size limit
    if (logQueueRef.current.length > 800) {
      logQueueRef.current.shift();
    }

    // Throttle React state update to maintain 60fps UI performance
    if (!flushTimeoutRef.current) {
      flushTimeoutRef.current = setTimeout(() => {
        setLogs([...logQueueRef.current]);
        flushTimeoutRef.current = null;
      }, 100);
    }
  }, []);

  const clearLogs = useCallback(() => {
    logQueueRef.current = [];
    setLogs([]);
    if (flushTimeoutRef.current) {
      clearTimeout(flushTimeoutRef.current);
      flushTimeoutRef.current = null;
    }
  }, []);

  // Globally patch console logs
  useEffect(() => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args: any[]) => {
      originalLog(...args);
      if (developerModeRef.current) {
        addLog('log', args);
      }
    };

    console.warn = (...args: any[]) => {
      originalWarn(...args);
      if (developerModeRef.current) {
        addLog('warn', args);
      }
    };

    console.error = (...args: any[]) => {
      originalError(...args);
      if (developerModeRef.current) {
        addLog('error', args);
      }
    };

    return () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      if (flushTimeoutRef.current) {
        clearTimeout(flushTimeoutRef.current);
      }
    };
  }, [addLog]);

  return (
    <DeveloperModeContext.Provider value={{ developerMode, setDeveloperMode, logs, clearLogs }}>
      {children}
    </DeveloperModeContext.Provider>
  );
}

export function useDeveloperMode() {
  const ctx = useContext(DeveloperModeContext);
  if (!ctx) {
    // Fallback in case root route imports/calls hook before Provider compiles
    return {
      developerMode: false,
      setDeveloperMode: () => {},
      logs: [],
      clearLogs: () => {},
    };
  }
  return ctx;
}
