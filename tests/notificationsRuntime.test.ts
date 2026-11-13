import { afterEach, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

it('routes all app notification imports through the runtime boundary', () => {
  const violations: string[] = [];
  function inspect(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { inspect(path); continue; }
      if (!/\.tsx?$/.test(path) || path === join('services', 'notifications.ts')) continue;
      const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text.startsWith('expo-notifications') && !node.importClause?.isTypeOnly) violations.push(path);
        if (ts.isCallExpression(node) && node.arguments.some(arg => ts.isStringLiteral(arg) && arg.text.startsWith('expo-notifications'))) violations.push(path);
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
  }
  for (const dir of ['app', 'components', 'contexts', 'hooks', 'services']) inspect(dir);
  expect(violations).toEqual([]);
});

afterEach(() => { vi.resetModules(); vi.doUnmock('expo-constants'); vi.doUnmock('react-native'); });

it.each(['android', 'web'])('does not evaluate native notifications in %s Expo Go', async (platform) => {
  vi.resetModules();
  vi.doMock('expo-constants', () => ({ default: { executionEnvironment: 'storeClient' }, ExecutionEnvironment: { StoreClient: 'storeClient' } }));
  vi.doMock('react-native', () => ({ Platform: { OS: platform } }));
  // Evaluating the real notifications package in this Node environment would
  // fail; importing our boundary must succeed without loading native code.
  const { notifications } = await import('../services/notifications');
  expect(notifications).toBeNull();
});
