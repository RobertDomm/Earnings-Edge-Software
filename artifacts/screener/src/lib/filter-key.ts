/**
 * Stable identity for a filter: the "Filter N" prefix. Full display names can
 * change between deployments while old names persist in stored scan results,
 * so counts and definitions are matched on this prefix instead.
 */
export function filterKey(name: string): string {
  const match = name.match(/^Filter \d+/);
  return match ? match[0] : name;
}
