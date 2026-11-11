// Add only product-approved, fixed app actions. The stable id is stored in a
// task; platform targets never come from user input or synced task payloads.
export const NATIVE_APP_ACTIONS = Object.freeze({});

export function isConfiguredNativeAppAction(id) {
  return typeof id === 'string' && Object.hasOwn(NATIVE_APP_ACTIONS, id);
}

export function nativeAppActionCatalog() {
  return Object.entries(NATIVE_APP_ACTIONS).map(([id, value]) => ({ id, label: value.label,
    platforms: ['android', 'ios'].filter((name) => Boolean(value[name])) }));
}
