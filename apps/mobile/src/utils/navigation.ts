import { router } from 'expo-router';

/** The tabs a tap can send somebody to from anywhere in the app. */
export type TabHref = '/(app)/(tabs)/inbox' | '/(app)/(tabs)/friends';

/**
 * Opens a tab from wherever the user is.
 *
 * From a screen stacked over the tab bar (a çelınc, its results, the wizard) a
 * push or a navigate to a tab route does not switch tabs: it stacks a second
 * tab bar, with its own copy of every tab, on top of the çelınc, and back
 * lands on the çelınc again. Going down to the tab bar first keeps one; from
 * the tab bar itself `navigate` only switches tabs. `dismissTo` alone does
 * not switch tabs when the user is already on the tab bar.
 */
export function goToTab(href: TabHref): void {
  if (router.canDismiss()) router.dismissAll();
  router.navigate(href);
}
