/**
 * The element of the tab with this key. Compares `data-tab-key` instead of building a CSS selector
 * from the key: a key carries an id that omp chose (a `task` name is any string), and a quote or a
 * bracket in a selector makes `querySelector` throw, which would blank the window.
 */
export function findTabElement<T extends { readonly dataset: { readonly tabKey?: string } }>(
  elements: Iterable<T>,
  key: string,
): T | undefined {
  for (const element of elements) if (element.dataset.tabKey === key) return element;
  return undefined;
}
