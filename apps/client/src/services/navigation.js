/** Capacitor iOS uses an opaque custom scheme whose URL.origin is "null".
 * Compare address components, not origin, so Web and native routing both work.
 */
export function internalPath(input, baseHref) {
  const base = new URL(baseHref);
  const target = new URL(input, base);
  if (target.protocol !== base.protocol || target.hostname !== base.hostname || target.port !== base.port || target.username || target.password) {
    throw new Error('仅支持日记本内的页面');
  }
  return `${target.pathname}${target.search}`;
}
