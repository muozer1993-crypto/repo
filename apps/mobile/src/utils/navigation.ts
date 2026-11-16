import { router } from 'expo-router';

/** The tabs a tap can send somebody to from anywhere in the app (the first is home). */
export type TabHref = '/(app)/(tabs)' | '/(app)/(tabs)/inbox' | '/(app)/(tabs)/friends';

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

/**
 * Leaves a screen on the root stack, outside the app (the invite link), for a
 * tab.
 *
 * A link opened while the app runs lands over it: the root holds the app (with
 * whatever çelınc was open) and the link. A replace from there put a second
 * app, with its own tab bar and home, in the link's place, and back went home,
 * then to that çelınc, then home again. Going down off the link first, and to
 * the tab bar on the next tick, leaves the one app: in the same tick the router
 * still answers for the link, and a navigate then stacked a tab bar over the
 * çelınc. On a cold start from the link nothing is under it, and a replace is
 * what builds the app.
 */
export function leaveForTab(href: TabHref): void {
  if (!router.canDismiss()) {
    router.replace(href);
    return;
  }
  router.dismissAll();
  setTimeout(() => goToTab(href), 0);
}
